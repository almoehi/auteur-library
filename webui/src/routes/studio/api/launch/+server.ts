/** Launch endpoint: turns a Brief into a workspace and opens it.
 *
 *  Two stages, two workspaces. Workspaces are immutable and unpausable — once
 *  opened, tasks auto-dispatch as their dependencies complete, and there is no
 *  way to hold a running workspace for a human's approval. So the approval gate
 *  lives in our app, and the production is split:
 *
 *  - stage 'planning' opens `<slug>@1.0` — LLM-only tasks (screenplay, cast,
 *    scenes, art direction, visual bible). Minutes and cents, no GPU.
 *  - stage 'render' opens `<slug>-shoot@1.0` — ONLY after the user approved
 *    the planning output in the chat. Its planner prompt carries the approved
 *    artifact contents inline, and its shoot tasks burn real GPU time.
 *
 *  This is the one place in the app that ever holds a workspace YAML. The
 *  read-only proxy at /api/harness deliberately does not accept
 *  `open-workspace`, so a bad or hand-crafted YAML cannot be posted through the
 *  generic pipe — everything that gets opened is composed here, from a Brief.
 *
 *  Like that proxy, this exists because the browser cannot reach the harness
 *  itself: it sends no CORS headers, and its URL has no business in a client
 *  bundle.
 */
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SLUG_RE, type Brief } from '../../types';
import { readOverrides } from '../../overrides.server';
import { loadLibraryInto, type LoadReport } from '../../harness.server';
import { importStagedRefs, type RefImportResult } from '../../refs-import.server';
import { listRefs, readRef } from '../../refs.server';
import { getSheet, readSheet } from '../../sheets.server';
import { pruneStashes, readStashed, stashRefs } from '../../refstash.server';
import { cached } from '../../../clips.server';
import { lastFrame } from '../../ffmpeg.server';
import { readFileSync } from 'node:fs';
import { putObject, s3FromEnv } from '../../s3presign.server';
import { recordRender } from '../../renders.server';
import { recordProduction } from '../../history.server';
import {
	briefToWorkspaceId,
	renderWorkspaceId,
	composePlanningWorkspace,
	composeRenderWorkspace,
	composeDirectWorkspace,
	directWorkspaceId,
	composeSheetWorkspace,
	sheetWorkspaceId,
	composeContinuationWorkspace,
	continuationWorkspaceId,
	type ContinuationSpec,
	CONT_STEPS,
	CONT_FPS,
	type SheetSpec,
	type ApprovedDocs,
	type DirectSpec,
	DIRECT_STEPS,
	DIRECT_FPS
} from '../../compose';

/** Same host as the proxy uses: the golem router matches on the Host header and
 *  only answers to this name (127.0.0.1 returns DOMAIN_NOT_REGISTERED). */
import { HARNESS } from '$lib/harness';

/*  Workspaces are immutable once opened — reopening an id is a silent no-op, it
 *  does not re-run anything. So every launch gets a fresh slug and the version
 *  stays pinned; the slug is what makes the id unique, not the version. The
 *  render stage rides the same slug with a `-shoot` suffix, so one approved
 *  plan maps to exactly one render workspace.
 *
 *  Both ids and the slug grammar come from the modules that own them
 *  (`briefToWorkspaceId` / `renderWorkspaceId` in compose.ts, SLUG_RE in
 *  types.ts). They used to be re-declared here; two literals that must agree is
 *  the one thing this file cannot afford to get wrong, because a mismatch opens
 *  an id nothing polls. */

/** Everything after composing: log the YAML, prefetch, open, bookmark, and push
 *  the local library in. Shared because direct mode needs all of it and none of
 *  the brief handling around it — and because the one thing this file cannot
 *  afford is two copies of the open sequence drifting apart. */
async function openWorkspace(
	workspaceId: string,
	yaml: string,
	grokKey: string,
	fetch: typeof globalThis.fetch,
	record: { slug: string; title: string; sceneCount: number; pitch?: string; prompt?: string },
	opts: { planning?: boolean; withLibrary?: boolean } = {}
): Promise<Response> {
	const openedAt = Date.now();
	const planning = opts.planning ?? false;
	const withLibrary = opts.withLibrary ?? false;

	// Printed before the open, on purpose. A malformed compose is otherwise
	// invisible: the harness rejects it with a one-line message that says
	// nothing about which line produced it, and the slug is burned either way —
	// reopening it is a no-op, so there is no retry that would let us inspect
	// what was actually sent. The console is the only copy.
	// The composed YAML now carries the API key on every model, and this log is
	// the one place it would otherwise be printed in full.
	const printable = yaml.replaceAll(grokKey, '«GROK_API_KEY»');
	console.log(`\n=== auteur: opening ${workspaceId} ===\n${printable}\n=== end ${workspaceId} ===\n`);

	// Opening is two calls since the 2026-08-19 release. Prefetch resolves the
	// skills and workflows the YAML names — fetching them from their branches —
	// and answers with everything it could not resolve. That list is the only
	// chance to see a bad reference before the slug is spent: an id can be
	// opened once, so a workspace that opens against a missing workflow is not
	// retryable, it is another run thrown away.
	let pre: Response;
	try {
		pre = await fetch(`${HARNESS}/workspaces/${workspaceId}/api/prefetch-workspace`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ req: { yaml } })
		});
	} catch (e) {
		// Nobody started the container: a normal state, not an exception. The
		// caller renders this as a banner.
		return json({ ok: false, offline: true, error: String(e) }, { status: 200 });
	}

	const preText = await pre.text();
	if (!pre.ok) {
		return json(
			{ ok: false, error: `prefetch failed (${pre.status}): ${preText.slice(0, 300)}` },
			{ status: 200 }
		);
	}

	// Same double-wrapping as everywhere else on this API.
	let preData: unknown = preText;
	try {
		const once: unknown = JSON.parse(preText);
		preData = typeof once === 'string' ? JSON.parse(once) : once;
	} catch {
		/* leave as text */
	}
	const pd = preData as { error?: string; errors?: string[] } | undefined;
	const preErrors = [
		...(pd?.error ? [pd.error] : []),
		...(Array.isArray(pd?.errors) ? pd.errors : [])
	].filter((x) => typeof x === 'string' && x.trim());

	if (preErrors.length) {
		console.error(`=== auteur: prefetch rejected ${workspaceId} ===\n${preErrors.join('\n')}`);
		return json(
			{ ok: false, error: `the workspace references something that could not be loaded:\n${preErrors.join('\n')}` },
			{ status: 200 }
		);
	}

	let res: Response;
	try {
		res = await fetch(`${HARNESS}/workspaces/${workspaceId}/api/open-workspace`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ req: { yaml, owner: 'studio' } })
		});
	} catch (e) {
		return json({ ok: false, offline: true, error: String(e) }, { status: 200 });
	}

	const text = await res.text();

	// The harness answers with an object, but sometimes JSON-encoded inside a
	// string (the same double-wrapping the read proxy unwraps). Step back one
	// level at a time so a plain-prose error survives readable.
	let data: unknown = text;
	try {
		const once = JSON.parse(text);
		data = once;
		if (typeof once === 'string') {
			try {
				data = JSON.parse(once);
			} catch {
				data = once;
			}
		}
	} catch {
		/* not JSON at all — surface verbatim */
	}

	// Two independent ways to fail: a non-2xx (a dead workspace agent answers 500
	// with INTERNAL_AGENT_EXECUTION_FAILED on every endpoint), or a 200 carrying a
	// non-empty `error` field. Treating the second as success is how you end up
	// polling a workspace that was never opened.
	const d = data as { error?: string; code?: string } | string | undefined;
	const harnessError = typeof d === 'string' ? '' : (d?.error ?? '').trim();

	if (!res.ok) {
		const detail =
			typeof d === 'string'
				? d
				: `${d?.code ?? res.status} — ${harnessError || text.slice(0, 300)}`;
		return json({ ok: false, error: detail }, { status: 200 });
	}
	if (harnessError) return json({ ok: false, error: harnessError }, { status: 200 });

	// Bookmark it. Until this existed a run lived only in the tab that started
	// it: close the tab and the film was still on the harness but unreachable,
	// because nothing remembered its id.
	recordProduction({ ...record, ...(planning ? { planningWs: workspaceId } : { renderWs: workspaceId }) });

	// The workspace is live from here on. Everything below adds to it and can
	// only fail partially: the production is already running, so a workflow that
	// would not load is a missing capability to report, not a reason to pretend
	// the launch failed.
	//
	// Render stage only. The planning workspace writes documents — it never
	// touches a GPU and never reads a reference file, so loading either into it
	// would be work nothing consumes.
	let library: LoadReport | undefined;
	let refs: RefImportResult | undefined;
	if (withLibrary) {
		const t1 = Date.now();
		library = await loadLibraryInto(workspaceId);
		const t2 = Date.now();
		refs = await importStagedRefs(workspaceId);
		const t3 = Date.now();
		// Temporary: 61% of the wait for a clip happens before the GPU starts and
		// nobody has ever seen inside it. Remove once the breakdown is known.
		console.log(
			`[phase] ${workspaceId} open=${t1 - openedAt}ms library=${t2 - t1}ms refs=${t3 - t2}ms`
		);
	}

	return json({ ok: true, workspaceId, library, refs }, { status: 200 });
}

export const POST: RequestHandler = async ({ request, fetch }) => {

	// Tuned prompts and model choices from the admin panel, if any. Read per
	// launch so an edit between two productions takes effect on the next one
	// without restarting the dev server.
	const overrides = readOverrides();

	// The worker agents only ever see a key that travels on the model itself, so
	// a missing one is not a degraded run — it is a workspace that opens and then
	// fails every task with 401. Cheaper to refuse here than to spend the slug.
	const grokKey = (env.GROK_API_KEY ?? '').trim();
	if (!grokKey) {
		return json({
			ok: false,
			error:
				'GROK_API_KEY is not set — copy it from ~/auteur/.env into webui/.env and restart the dev server.'
		});
	}

	let payload: {
		brief?: Brief;
		stage?: unknown;
		approved?: unknown;
		direct?: unknown;
		sheet?: unknown;
		continuation?: unknown;
	};
	try {
		payload = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const stage = payload.stage;
	if (
		stage !== 'planning' &&
		stage !== 'render' &&
		stage !== 'direct' &&
		stage !== 'sheet' &&
		stage !== 'continue'
	) {
		throw error(400, "stage must be 'planning', 'render', 'direct', 'sheet' or 'continue'");
	}

	// A sheet is its own workspace and its own shape: one description, one
	// registry workflow, one image out. It shares nothing with a clip run but the
	// opening machinery, so it leaves here before any of the clip handling — no
	// staged references (a sheet is what you make references FROM), no adapter
	// stack, and no render row, since renders.jsonl is a log of clips and a sheet
	// in it would skew every reading of it.
	if (stage === 'sheet') {
		const spec = payload.sheet as SheetSpec | undefined;
		if (!spec || typeof spec !== 'object') throw error(400, 'Missing sheet spec');
		if (!spec.slug || !SLUG_RE.test(spec.slug)) throw error(400, 'Bad slug');
		// Set here rather than taken from the payload, exactly as for a clip: the
		// harness fetches a workflow bundle from this address, so the browser does
		// not get a say in where that address points.
		spec.studioOrigin = env.AUTEUR_STUDIO_URL || 'http://host.docker.internal:5290';
		let sheetYaml: string;
		try {
			sheetYaml = composeSheetWorkspace(spec, grokKey);
		} catch (e) {
			return json({ ok: false, error: `compose failed: ${e}` }, { status: 200 });
		}
		return await openWorkspace(
			sheetWorkspaceId(spec),
			sheetYaml,
			grokKey,
			fetch,
			{
				slug: spec.slug,
				title: `${spec.kind === 'character' ? 'Character' : 'Location'} sheet`,
				sceneCount: 0,
				pitch: spec.description.slice(0, 200)
			},
			// No library push: the sheet workflows come from the registry, and the
			// three serial round-trips loadLibraryInto costs are pure latency here.
			{ withLibrary: false }
		);
	}

	// Direct mode carries a spec instead of a brief: there is no plan to open,
	// only prompts to render. It leaves before the brief checks below, which ask
	// for a story and a scene count that this stage does not have.
	// ── continue an existing clip ────────────────────────────────────────────
	if (stage === 'continue') {
		const spec = payload.continuation as ContinuationSpec | undefined;
		if (!spec || typeof spec !== 'object') throw error(400, 'Missing continuation spec');
		if (!spec.slug || !SLUG_RE.test(spec.slug)) throw error(400, 'Bad slug');
		spec.studioOrigin = env.AUTEUR_STUDIO_URL || 'http://host.docker.internal:5290';

		// Cleared before anything reads them: the spec arrives from the browser and
		// these end up in the agent's prompt as links to fetch.
		spec.priorClipUrl = undefined;
		spec.characterUrl = undefined;
		spec.locationUrl = undefined;
		spec.lastFrameUrl = undefined;
		spec.characterName = undefined;
		spec.locationName = undefined;

		// The clip itself, read from the local cache by the three ids the card
		// carries. Not fetched from the harness: that workspace is spent, its agent
		// may be gone, and the bytes are already here because the page kept them
		// the moment the clip arrived.
		const clipPath = cached(spec.priorWorkspace ?? '', spec.priorArtifact ?? '', spec.priorFile ?? '');
		if (!clipPath) {
			return json(
				{ ok: false, error: 'that clip is not in the library any more — it cannot be continued' },
				{ status: 200 }
			);
		}

		const character = spec.characterId ? getSheet(spec.characterId) : null;
		const location = spec.locationId ? getSheet(spec.locationId) : null;
		const characterBytes = character ? readSheet(character.id) : null;
		const locationBytes = location ? readSheet(location.id) : null;
		if (!character || !characterBytes || !location || !locationBytes) {
			// Both are required inputs. Rendering without one would either refuse at
			// the tool or, worse, produce a stranger in the wrong room.
			return json(
				{
					ok: false,
					error: 'a continuation needs both the character and the location it was shot with — one of them is gone'
				},
				{ status: 200 }
			);
		}
		spec.characterName = character.name;
		spec.locationName = location.name;

		const s3 = s3FromEnv();
		if (!s3) {
			return json(
				{ ok: false, error: 'S3 is not configured in ~/auteur/.env — the GPU has nowhere to read from' },
				{ status: 200 }
			);
		}
		try {
			// The extension matters: the harness names the staged file
			// `<port>.<ext-from-url>`, and the loader nodes expect a video for the
			// clip and images for the two plates.
			spec.priorClipUrl = await putObject(
				s3,
				`studio-cont/${spec.slug}/prior_clip.mp4`,
				new Uint8Array(readFileSync(clipPath)),
				fetch
			);
			spec.characterUrl = await putObject(
				s3,
				`studio-cont/${spec.slug}/character_sheet.png`,
				new Uint8Array(characterBytes),
				fetch
			);
			spec.locationUrl = await putObject(
				s3,
				`studio-cont/${spec.slug}/environment_plate.png`,
				new Uint8Array(locationBytes),
				fetch
			);
			// The seam-pinning frame, and required rather than best-effort.
			//
			// The brief is written before the launch and always names <Picture 3> as
			// the final frame, so a run without it would describe a reference the
			// model was never given. Making it optional would trade a loud failure
			// here for a quiet mismatch on the GPU — and a clip whose last frame
			// will not decode is not one the workflow could read as a video either.
			spec.lastFrameUrl = await putObject(
				s3,
				`studio-cont/${spec.slug}/ref_picture_3.png`,
				await lastFrame(clipPath),
				fetch
			);
		} catch (e) {
			return json({ ok: false, error: `the references could not be uploaded — ${e}` }, { status: 200 });
		}

		let contYaml: string;
		try {
			contYaml = composeContinuationWorkspace(spec, grokKey);
		} catch (e) {
			return json({ ok: false, error: `compose failed: ${e}` }, { status: 200 });
		}

		recordRender({
			workspace: continuationWorkspaceId(spec),
			slug: spec.slug,
			at: Date.now(),
			request: spec.request ?? '',
			prompt: spec.prompt ?? '',
			wrote: spec.loras ?? [],
			launched: spec.loras ?? [],
			steps: CONT_STEPS,
			width: spec.width,
			height: spec.height,
			seconds: spec.seconds,
			fps: CONT_FPS,
			seed: spec.seed,
			characterId: spec.characterId,
			characterName: spec.characterName,
			locationId: spec.locationId,
			locationName: spec.locationName,
			// What this one continues. A chain is walked backwards along this field.
			continuesWorkspace: spec.priorWorkspace
		});

		return await openWorkspace(
			continuationWorkspaceId(spec),
			contYaml,
			grokKey,
			fetch,
			{
				slug: spec.slug,
				title: spec.title || 'Continuation',
				sceneCount: 1,
				prompt: spec.prompt
			},
			{ withLibrary: true }
		);
	}

	if (stage === 'direct') {
		const spec = payload.direct as DirectSpec | undefined;
		if (!spec || typeof spec !== 'object') throw error(400, 'Missing direct spec');
		if (!spec.slug || !SLUG_RE.test(spec.slug)) throw error(400, 'Bad slug');
		// Set here rather than taken from the payload. The harness fetches a
		// workflow graph from this address and runs it, so the browser does not
		// get a say in where that address points.
		spec.studioOrigin = env.AUTEUR_STUDIO_URL || 'http://host.docker.internal:5290';
		// Copied here, before openWorkspace imports them — the import clears the
		// staging area, and the bundle generator needs these files minutes later
		// when the harness asks for the graph. Server-side for the same reason as
		// the origin: it decides what gets rendered.
		const staged = listRefs();
		const bytes = staged
			.map((r) => ({ bytes: readRef(r.stored), name: r.name }))
			.filter((f): f is { bytes: Buffer; name: string } => !!f.bytes);

		// The chosen character goes FIRST, and the order is the whole contract:
		// the bundle generator names them ref_0, ref_1 … in this order and the
		// prompt addresses them as <Picture 1>, <Picture 2> …, so the character
		// has to be the one the writer was told to call <Picture 1>.
		spec.characterName = undefined;
		spec.locationName = undefined;
		// Built in front of whatever the operator staged by hand, character first
		// then location, because that order becomes <Picture 1>, <Picture 2> … and
		// the brief was written against those numbers.
		const chosen: { bytes: Buffer; name: string }[] = [];
		for (const [id, set] of [
			[spec.characterId, (n: string) => (spec.characterName = n)],
			[spec.locationId, (n: string) => (spec.locationName = n)]
		] as [string | undefined, (n: string) => void][]) {
			if (!id) continue;
			const row = getSheet(id);
			const rowBytes = row ? readSheet(id) : null;
			if (!row || !rowBytes) {
				// Named something that is not there any more. Rendering without it
				// would quietly produce a stranger or the wrong room, which is worse
				// than not starting.
				return json(
					{ ok: false, error: 'one of the picks is gone — choose again, or none' },
					{ status: 200 }
				);
			}
			chosen.push({ bytes: rowBytes, name: `${row.name}.png` });
			set(row.name);
		}
		bytes.unshift(...chosen);
		const stashedNames = stashRefs(spec.slug, bytes);
		spec.refImages = stashedNames.length;
		spec.refNames = stashedNames;

		// Cleared before anything can read it, for the same reason studioOrigin and
		// the two names above are set here rather than taken from the payload: this
		// object arrives from the browser, and these urls end up in the render
		// agent's prompt as links to fetch. Assigning inside the branch below would
		// leave a caller-supplied value standing whenever a clip has no references
		// — which is most of them.
		spec.refUrls = [];

		// Up to the bucket, because that is the only address the render can read
		// from. The GPU runs on Modal; this server answers on host.docker.internal,
		// which the harness refuses by name along with every private range. The
		// staged copies stay on disk regardless — they are how we see afterwards
		// what a clip was actually given.
		if (stashedNames.length) {
			const s3 = s3FromEnv();
			if (!s3) {
				return json(
					{
						ok: false,
						error:
							'S3 is not configured in ~/auteur/.env — reference images have nowhere to go that the GPU can read'
					},
					{ status: 200 }
				);
			}
			try {
				for (const name of stashedNames) {
					const local = readStashed(spec.slug, name);
					if (!local) throw new Error(`${name} vanished from the staging area`);
					spec.refUrls.push(
						await putObject(s3, `studio-refs/${spec.slug}/${name}`, new Uint8Array(local), fetch)
					);
				}
			} catch (e) {
				// Refusing to start is the point. A clip that renders without its
				// references produces a convincing video of the wrong person, and
				// that is the failure that wastes an afternoon rather than a minute.
				return json(
					{ ok: false, error: `the reference images could not be uploaded — ${e}` },
					{ status: 200 }
				);
			}
		}
		pruneStashes();
		let directYaml: string;
		try {
			directYaml = composeDirectWorkspace(spec, grokKey);
		} catch (e) {
			return json({ ok: false, error: `compose failed: ${e}` }, { status: 200 });
		}
		// Written before the workspace opens rather than after, so a launch that
		// dies on the way still leaves a record of what was attempted — those are
		// the interesting ones to go back to, and a row that only appears on
		// success is a log of the good days.
		recordRender({
			workspace: directWorkspaceId(spec),
			slug: spec.slug,
			at: Date.now(),
			request: spec.request ?? '',
			prompt: spec.prompts?.[0] ?? '',
			wrote: spec.wroteLoras ?? spec.loras ?? [],
			launched: spec.loras ?? [],
			steps: DIRECT_STEPS,
			width: spec.width,
			height: spec.height,
			seconds: spec.seconds,
			fps: DIRECT_FPS,
			seed: spec.seed,
			// Who and where. Set above from the picks, after the sheets were read —
			// so a name here means the render really got that picture, not merely
			// that the browser asked for it.
			...(spec.characterId ? { characterId: spec.characterId } : {}),
			...(spec.characterName ? { characterName: spec.characterName } : {}),
			...(spec.locationId ? { locationId: spec.locationId } : {}),
			...(spec.locationName ? { locationName: spec.locationName } : {})
		});

		return await openWorkspace(
			directWorkspaceId(spec),
			directYaml,
			grokKey,
			fetch,
			{
				slug: spec.slug,
				title: spec.title || 'Direct render',
				sceneCount: spec.prompts?.length ?? 0,
				pitch: spec.prompts?.[0]?.slice(0, 200),
				prompt: spec.prompts?.[0]
			},
			{ withLibrary: true }
		);
	}

	const brief = payload.brief;
	if (!brief || typeof brief !== 'object') throw error(400, 'Missing brief');
	if (!brief.slug || !SLUG_RE.test(brief.slug)) throw error(400, 'Bad slug');

	let workspaceId: string;
	let yaml: string;
	try {
		if (stage === 'planning') {
			workspaceId = briefToWorkspaceId(brief);
			yaml = composePlanningWorkspace(brief, overrides, grokKey);
		} else {
			// The render workspace's planner prompt carries the approved planning
			// documents inline — the two workspaces share nothing on the harness
			// side, so the text itself is the only bridge. No docs, no shoot.
			const approved = payload.approved;
			if (!approved || typeof approved !== 'object') {
				throw error(400, 'Missing approved docs for render stage');
			}
			workspaceId = renderWorkspaceId(brief);
			// Staged now, imported once the workspace is open — but the planner's
			// prompt is written here, so it has to be told in advance.
			yaml = composeRenderWorkspace(
				brief,
				approved as ApprovedDocs,
				overrides,
				grokKey,
				listRefs().length > 0
			);
		}
	} catch (e) {
		// Let our own 400s through; anything else is a compose bug — a bug in
		// our code, not a harness failure — so say that plainly instead of
		// letting it read as "the container is down".
		if (e && typeof e === 'object' && 'status' in e) throw e;
		return json({ ok: false, error: `compose failed: ${e}` }, { status: 200 });
	}

	return await openWorkspace(workspaceId, yaml, grokKey, fetch, {
		slug: brief.slug,
		title: brief.title,
		sceneCount: brief.sceneCount,
		pitch: typeof brief.story === 'string' ? brief.story.slice(0, 200) : undefined
	}, { planning: stage === 'planning', withLibrary: stage === 'render' });
};
