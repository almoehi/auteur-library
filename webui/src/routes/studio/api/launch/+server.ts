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
import { listRefs } from '../../refs.server';
import { recordProduction } from '../../history.server';
import {
	briefToWorkspaceId,
	renderWorkspaceId,
	composePlanningWorkspace,
	composeRenderWorkspace,
	composeDirectWorkspace,
	directWorkspaceId,
	type ApprovedDocs,
	type DirectSpec
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
		library = await loadLibraryInto(workspaceId);
		refs = await importStagedRefs(workspaceId);
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

	let payload: { brief?: Brief; stage?: unknown; approved?: unknown; direct?: unknown };
	try {
		payload = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const stage = payload.stage;
	if (stage !== 'planning' && stage !== 'render' && stage !== 'direct') {
		throw error(400, "stage must be 'planning', 'render' or 'direct'");
	}

	// Direct mode carries a spec instead of a brief: there is no plan to open,
	// only prompts to render. It leaves before the brief checks below, which ask
	// for a story and a scene count that this stage does not have.
	if (stage === 'direct') {
		const spec = payload.direct as DirectSpec | undefined;
		if (!spec || typeof spec !== 'object') throw error(400, 'Missing direct spec');
		if (!spec.slug || !SLUG_RE.test(spec.slug)) throw error(400, 'Bad slug');
		// Set here rather than taken from the payload. The harness fetches a
		// workflow graph from this address and runs it, so the browser does not
		// get a say in where that address points.
		spec.studioOrigin = env.AUTEUR_STUDIO_URL || 'http://host.docker.internal:5290';
		let directYaml: string;
		try {
			directYaml = composeDirectWorkspace(spec, grokKey);
		} catch (e) {
			return json({ ok: false, error: `compose failed: ${e}` }, { status: 200 });
		}
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
