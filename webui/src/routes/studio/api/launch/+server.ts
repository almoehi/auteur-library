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
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SLUG_RE, type Brief } from '../../types';
import { readOverrides } from '../../overrides.server';
import {
	briefToWorkspaceId,
	renderWorkspaceId,
	composePlanningWorkspace,
	composeRenderWorkspace,
	type ApprovedDocs
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

export const POST: RequestHandler = async ({ request, fetch }) => {

	// Tuned prompts and model choices from the admin panel, if any. Read per
	// launch so an edit between two productions takes effect on the next one
	// without restarting the dev server.
	const overrides = readOverrides();

	let payload: { brief?: Brief; stage?: unknown; approved?: unknown };
	try {
		payload = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const brief = payload.brief;
	if (!brief || typeof brief !== 'object') throw error(400, 'Missing brief');
	if (!brief.slug || !SLUG_RE.test(brief.slug)) throw error(400, 'Bad slug');

	const stage = payload.stage;
	if (stage !== 'planning' && stage !== 'render') {
		throw error(400, "stage must be 'planning' or 'render'");
	}

	let workspaceId: string;
	let yaml: string;
	try {
		if (stage === 'planning') {
			workspaceId = briefToWorkspaceId(brief);
			yaml = composePlanningWorkspace(brief, overrides);
		} else {
			// The render workspace's planner prompt carries the approved planning
			// documents inline — the two workspaces share nothing on the harness
			// side, so the text itself is the only bridge. No docs, no shoot.
			const approved = payload.approved;
			if (!approved || typeof approved !== 'object') {
				throw error(400, 'Missing approved docs for render stage');
			}
			workspaceId = renderWorkspaceId(brief);
			yaml = composeRenderWorkspace(brief, approved as ApprovedDocs, overrides);
		}
	} catch (e) {
		// Let our own 400s through; anything else is a compose bug — a bug in
		// our code, not a harness failure — so say that plainly instead of
		// letting it read as "the container is down".
		if (e && typeof e === 'object' && 'status' in e) throw e;
		return json({ ok: false, error: `compose failed: ${e}` }, { status: 200 });
	}

	// Printed before the open, on purpose. A malformed compose is otherwise
	// invisible: the harness rejects it with a one-line message that says
	// nothing about which line produced it, and the slug is burned either way —
	// reopening it is a no-op, so there is no retry that would let us inspect
	// what was actually sent. The console is the only copy.
	console.log(`\n=== auteur: opening ${workspaceId} ===\n${yaml}\n=== end ${workspaceId} ===\n`);

	let res: Response;
	try {
		res = await fetch(`${HARNESS}/workspaces/${workspaceId}/api/open-workspace`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ req: { yaml, owner: 'studio' } })
		});
	} catch (e) {
		// Nobody started the container: a normal state, not an exception. The
		// caller renders this as a banner.
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

	return json({ ok: true, workspaceId }, { status: 200 });
};
