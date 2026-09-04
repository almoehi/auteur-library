/** Proxy to a locally running auteur harness.
 *
 *  The harness is a Docker container on the developer's own machine (see
 *  ~/auteur). This route exists to give the browser a same-origin endpoint: the
 *  harness sends no CORS headers, so a page cannot call it directly, and its URL
 *  has no business being in a client bundle.
 *
 *  Unauthenticated: this app is a local operator tool. See the README.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** The golem router matches routes on the request's Host header, and the
 *  harness registers its API under this exact domain — calling 127.0.0.1 or
 *  localhost returns DOMAIN_NOT_REGISTERED even though the port is the same.
 *  /etc/hosts maps the name to 127.0.0.1 (run.sh adds the entry). */
import { HARNESS } from '$lib/harness';

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
 *  on, so the wrong instruction is never shown. */
async function diagnose(
	fetch: typeof globalThis.fetch,
	cause: unknown
): Promise<{ offline?: true; wedged?: true; error: string }> {
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

	let res: Response;
	try {
		res = await fetch(`${HARNESS}/workspaces/${workspace}/api/${op}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
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
