/** Where the harness answers — and, now that there are two of them, which.
 *
 *  Local: one process at a fixed address. The golem router matches routes on
 *  the request's Host header, and the harness registers its API under this
 *  exact domain — calling 127.0.0.1 or localhost returns DOMAIN_NOT_REGISTERED
 *  even though the port is the same. run.sh adds the /etc/hosts entry that maps
 *  the name back to 127.0.0.1. Override with AUTEUR_HARNESS_URL.
 *
 *  Hosted (Hannes's Modal deployment, on when AUTEUR_MODAL_KEY/SECRET/WORKSPACE
 *  are set): every workspace lives in its own sandbox behind a pass-through
 *  proxy, so the base differs per workspace and carries auth. It also does not
 *  exist until the sandbox has started, and stops existing when the run ends.
 *
 *  Both speak the same path grammar past the base — `/workspaces/{id}/api/{op}`
 *  and `/workspaces/{id}/artifacts/{artifact}/{file}` — which is why callers
 *  ask `harnessTarget()` for a base and headers and change nothing else.
 */
import { env } from '$env/dynamic/private';
import { hostedHarness, modalHeaders, presignedFor, proxyBase, sandboxFor } from '$lib/modal.server';

export const HARNESS = env.AUTEUR_HARNESS_URL || 'http://host.docker.internal:19006';

export interface HarnessTarget {
	base: string;
	headers: Record<string, string>;
}

/** The base url and headers for one workspace, or null when the hosted sandbox
 *  is not there yet (or never was — a workspace this studio did not submit).
 *  Local mode never returns null. */
export async function harnessTarget(workspaceId: string): Promise<HarnessTarget | null> {
	if (!hostedHarness()) return { base: HARNESS, headers: {} };
	const sandboxId = await sandboxFor(workspaceId);
	if (!sandboxId) return null;
	return { base: proxyBase(sandboxId), headers: modalHeaders() };
}

/** What a caller gets when the sandbox is not up: a Response, so the existing
 *  `!res.ok` branches keep working, saying so in the one place a log would
 *  look. 503 rather than 502 because nothing is down — it is not started. */
export function notReady(workspaceId: string): Response {
	return new Response(JSON.stringify({ error: `sandbox for ${workspaceId} is not up yet` }), {
		status: 503,
		headers: { 'content-type': 'application/json' }
	});
}

/** POST one workspace op with a JSON body. */
export async function harnessPost(
	workspaceId: string,
	op: string,
	body: unknown,
	init: { signal?: AbortSignal } = {}
): Promise<Response> {
	const t = await harnessTarget(workspaceId);
	if (!t) return notReady(workspaceId);
	return fetch(`${t.base}/workspaces/${workspaceId}/api/${op}`, {
		method: 'POST',
		headers: { ...t.headers, 'content-type': 'application/json' },
		body: JSON.stringify(body),
		signal: init.signal
	});
}

/** GET one artifact file's bytes.
 *
 *  Hosted, the sandbox is gone once the run has ended, and with it this url —
 *  but the run's result names every file by a presigned url, so a miss on the
 *  proxy falls through to that. Local, the harness keeps serving after the run
 *  and there is nothing to fall through to. */
export async function harnessArtifact(
	workspaceId: string,
	artifactId: string,
	fileKey: string,
	init: { headers?: Record<string, string> } = {}
): Promise<Response> {
	const path = `/workspaces/${workspaceId}/artifacts/${encodeURIComponent(artifactId)}/${encodeURIComponent(fileKey)}`;
	const t = await harnessTarget(workspaceId);
	if (t) {
		try {
			const res = await fetch(`${t.base}${path}`, { headers: { ...t.headers, ...(init.headers ?? {}) } });
			if (res.ok || !hostedHarness()) return res;
		} catch (e) {
			if (!hostedHarness()) throw e;
		}
	}
	if (!hostedHarness()) return notReady(workspaceId);
	const signed = presignedFor(workspaceId, artifactId, fileKey);
	if (!signed) return notReady(workspaceId);
	return fetch(signed, { headers: init.headers ?? {} });
}
