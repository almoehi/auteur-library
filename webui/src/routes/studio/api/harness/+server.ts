/** Proxy to the harness — local or hosted — for the page's read-mostly calls.
 *
 *  This route exists to give the browser a same-origin endpoint: the local
 *  harness sends no CORS headers, the hosted one wants auth headers that have
 *  no business being in a client bundle, and either way its address is not the
 *  page's concern.
 *
 *  Unauthenticated: this app is a local operator tool. See the README.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HARNESS, harnessTarget } from '$lib/harness';
import { hostedHarness, jobFor, refreshJob, type RunResult } from '$lib/modal.server';
import type { PollState } from '../../types';

/** Workspace API methods the dashboard is allowed to reach. The harness exposes
 *  more (task removal, workflow teardown); those stay out until a surface
 *  actually needs them.
 *
 *  `open-workspace` is deliberately absent, and stays absent. Opening is the one
 *  irreversible call here — a workspace id can only be opened once, reopening it
 *  is a silent no-op, and a run costs real GPU time — so it does not belong
 *  behind a generic op forwarder that will relay any body it is handed. It lives
 *  at /studio/api/launch instead, which composes the YAML from a
 *  Brief and is therefore the only route that ever holds one. */
const OPS = new Set([
	'poll-state',
	'is-open',
	'get-event-log',
	'chat',
	'get-worker-status',
	'get-artifact-url',
	'reset-task'
]);

/** Workspace ids look like `smoke-test@1.1` — a bare name plus the version the
 *  workspace was opened at. Anything else is a caller bug, not a request to
 *  forward. */
const WORKSPACE_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

/** How long a workspace call may take before it is treated as wedged. Generous:
 *  poll-state normally answers in well under a second, and the only thing this
 *  guards against is a request that will never return. */
const WORKSPACE_TIMEOUT_MS = 20_000;

/** Which of the two silences this is. Returns the flag the dashboard branches
 *  on, so the wrong instruction is never shown. Hosted there is no container to
 *  restart, so the answer is always "this one workspace", never "offline". */
async function diagnose(
	fetch: typeof globalThis.fetch,
	cause: unknown
): Promise<{ offline?: true; wedged?: true; error: string }> {
	if (hostedHarness()) return { wedged: true, error: String(cause) };
	try {
		const probe = await fetch(`${HARNESS}/openapi.yaml`, {
			signal: AbortSignal.timeout(5_000)
		});
		// The harness answered, so it is up and it is this one workspace that has
		// stopped talking. Its render may still be running on the GPU.
		if (probe.ok) return { wedged: true, error: String(cause) };
	} catch {
		/* the probe failed too — genuinely offline, fall through */
	}
	return { offline: true, error: String(cause) };
}

/** A poll-state the page can read when there is no agent to ask.
 *
 *  Two moments in a hosted run have no sandbox: before it starts, and after the
 *  run has ended and Modal has torn it down. Before, the honest answer is an
 *  open-less workspace with nothing in it — the page shows "starting". After,
 *  the run's result carries every task's final status and every artifact's
 *  files, which is exactly the part of a poll-state the page acts on (a task
 *  going `success` and an artifact naming a clip), so it is rebuilt from that.
 *  Fields the result does not have are filled with what the page treats as
 *  neutral. */
function synthesize(workspaceId: string, result: RunResult | null): PollState {
	const [name, version] = workspaceId.split('@');
	if (!result) {
		return { workspace: { name, version, is_open: false }, tasks: [], artifacts: [], workflows: [], worker_statuses: [], recent_messages: [] };
	}
	return {
		workspace: { name, version, is_open: false },
		tasks: result.tasks.map((t) => ({
			id: t.key,
			key: t.key,
			title: t.key,
			status: t.status,
			origin: null,
			agent: null,
			...(t.failure_reason ? { failure_reason: t.failure_reason } : {})
		})) as PollState['tasks'],
		artifacts: result.artifacts.map((a) => ({
			id: a.artifactId,
			key: a.artifactId,
			name: a.artifactId,
			description: '',
			files: a.files.map((f) => f.fileKey),
			status: 'ready'
		})) as PollState['artifacts'],
		workflows: [],
		worker_statuses: [],
		recent_messages: []
	};
}

export const POST: RequestHandler = async ({ request, fetch }) => {

	let payload: { workspace?: string; op?: string; body?: unknown };
	try {
		payload = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const { workspace, op, body } = payload;
	if (!workspace || !WORKSPACE_RE.test(workspace)) throw error(400, 'Bad workspace id');
	if (!op || !OPS.has(op)) throw error(400, `Unsupported op: ${op}`);

	// Hosted: a workspace whose sandbox is not up answers from the job book
	// rather than from a proxy that has nothing behind it.
	let target = await harnessTarget(workspace);
	if (!target && hostedHarness()) {
		const job = await refreshJob(workspace).catch(() => jobFor(workspace));
		if (!job) return json({ ok: false, error: `${workspace} was not submitted from this studio` }, { status: 200 });
		if (op === 'poll-state') return json({ ok: true, status: 200, data: synthesize(workspace, job.done ? job.result : null), synthesized: true });
		return json({ ok: false, status: 503, error: 'sandbox not up yet' }, { status: 200 });
	}
	if (!target) target = { base: HARNESS, headers: {} };

	let res: Response;
	try {
		res = await fetch(`${target.base}/workspaces/${workspace}/api/${op}`, {
			method: 'POST',
			headers: { ...target.headers, 'content-type': 'application/json' },
			body: JSON.stringify(body ?? {}),
			// A workspace call that has not answered in this long is not slow, it is
			// stuck. Without a deadline the request hangs until the platform's own
			// timeout, and the poll loop stops moving with it.
			signal: AbortSignal.timeout(WORKSPACE_TIMEOUT_MS)
		});
	} catch (e) {
		// Two very different failures used to arrive here as one.
		//
		// The harness being down is the normal case when nobody started it. But a
		// single workspace agent can also wedge — stop answering every call for its
		// own id while the harness itself is perfectly healthy and every other
		// workspace answers in milliseconds. That happened during the first
		// character-sheet render, and the banner told the operator to restart the
		// container: advice that would have killed a render that was still running
		// on the GPU.
		//
		// So the harness is asked directly before either is claimed. It is one
		// cheap request against a route with no workspace behind it.
		return json(
			{ ok: false, ...(await diagnose(fetch, e)) },
			{ status: 200 }
		);
	}

	// Hosted, a proxy that no longer has a sandbox behind it (the run ended) is
	// the third moment with no agent. The job book has the ending.
	if (!res.ok && hostedHarness() && op === 'poll-state') {
		const job = await refreshJob(workspace, true).catch(() => jobFor(workspace));
		if (job?.done) return json({ ok: true, status: 200, data: synthesize(workspace, job.result), synthesized: true });
	}

	const text = await res.text();

	// Answers come in three shapes: a plain object (poll-state), a JSON-encoded
	// string wrapping more JSON (get-worker-status), or a JSON-encoded string
	// wrapping prose (chat). Unwrap greedily but step back one level at a time —
	// falling all the way back to `text` on the second parse would hand the
	// caller an escaped, quote-wrapped blob instead of the sentence inside it.
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
		/* not JSON at all — surface verbatim so harness errors stay readable */
	}

	return json({ ok: res.ok, status: res.status, data }, { status: 200 });
};
