/** Same-origin passthrough for artifact file bytes.
 *
 *  GET /api/file?workspace=<id>&artifact=<artifactId>&file=<fileKey>
 *  streams GET {harness}/workspaces/{id}/artifacts/{artifactId}/{fileKey}
 *  back to the browser unchanged.
 *
 *  This exists because the harness sends NO CORS headers. That splits the
 *  browser's abilities in half: a cross-origin <video src> plays fine, but a
 *  cross-origin fetch() of a text artifact (the screenplay the chat has to
 *  show inline) is blocked outright. Rather than live with that asymmetry —
 *  video direct, text proxied — everything comes through this same-origin
 *  route, so the page has exactly one way to read an artifact file.
 *
 *  Unauthenticated, like the rest of this app. See the README.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Same host as the proxy uses: the golem router matches on the Host header and
 *  only answers to this name (127.0.0.1 returns DOMAIN_NOT_REGISTERED). */
import { harnessArtifact } from '$lib/harness';
import { cached, serve, store, typeFor } from '../../../clips.server';

/** Identical to the grammar the /api/harness proxy enforces: a bare name
 *  plus the version the workspace was opened at, e.g. `smoke-test@1.1`. */
const WORKSPACE_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

/** Response headers worth carrying through. Content type and length are what
 *  the task asked to preserve; the range pair matters because iOS Safari asks
 *  for video in byte ranges and treats a server that answers a Range request
 *  with a plain 200 as broken — if the harness speaks ranges, pass them on. */
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

/** Artifact ids and file keys are simple names, never paths. Reject anything
 *  that could walk the harness's URL space (`..`, separators) or is empty —
 *  a caller bug, not a request to forward. */
function isPlainName(s: string): boolean {
	return s.length > 0 && !s.includes('/') && !s.includes('\\') && !s.includes('..');
}

export const GET: RequestHandler = async ({ url, request, fetch }) => {

	const workspace = url.searchParams.get('workspace') ?? '';
	const artifact = url.searchParams.get('artifact') ?? '';
	const file = url.searchParams.get('file') ?? '';

	if (!WORKSPACE_RE.test(workspace)) throw error(400, 'Bad workspace id');
	if (!isPlainName(artifact)) throw error(400, 'Bad artifact id');
	if (!isPlainName(file)) throw error(400, 'Bad file key');

	// harnessArtifact encodes artifact and file so a space or '#' in a filename
	// (clip names are not uniform) cannot truncate the harness path, and — on the
	// hosted harness — falls through to the finished run's presigned url once the
	// sandbox that served the file is gone.

	const range = request.headers.get('range');

	// Cache first, and deliberately before asking whether the harness is alive.
	// A finished clip must not become unreachable because a later step killed the
	// workspace agent — which is exactly what happens at assembly.
	const hit = cached(workspace, artifact, file);
	if (hit) {
		const s = serve(hit, range, typeFor(file));
		return new Response(new Uint8Array(s.body), { status: s.status, headers: s.headers });
	}

	// `warm=1` is the studio saying "this clip just landed, take a copy now" —
	// it fetches the whole file rather than a range, stores it, and answers with
	// nothing. Without it the cache would only fill from playback, and playback
	// is ranged, so it would never hold a complete file.
	const warming = url.searchParams.get('warm') === '1';

	// Forward the Range header when the browser sends one — that is how
	// <video> seeks, and how iOS Safari fetches video at all.
	const headers: Record<string, string> = {};
	if (range && !warming) headers.range = range;

	let res: Response;
	try {
		res = await harnessArtifact(workspace, artifact, file, { headers });
	} catch (e) {
		// Nobody started the container. 502 with a short body, per contract:
		// the caller can tell "harness down" from "file missing" (a passed-
		// through 404) without parsing prose.
		return json({ ok: false, offline: true, error: String(e) }, { status: 502 });
	}

	// On a warm request the whole point is to hold the bytes, so this one path
	// buffers. It runs once per clip, off the playback path.
	if (warming) {
		if (!res.ok) return json({ ok: false, status: res.status }, { status: 200 });
		const buf = new Uint8Array(await res.arrayBuffer());

		// The harness answers "artifact not found" with HTTP 200 and a JSON body,
		// so a failed lookup arrives looking exactly like a successful one. Caching
		// that envelope would be worse than not caching at all: a 58-byte file that
		// exists is served forever in place of the clip. Anything whose bytes are
		// not the kind of file that was asked for is refused.
		const asked = typeFor(file);
		const got = (res.headers.get('content-type') ?? '').toLowerCase();
		const looksJson = got.includes('json') || (buf[0] === 0x7b && buf.length < 4096);
		if (looksJson && !asked.includes('json')) {
			return json({ ok: false, refused: 'the harness returned a message, not the file' });
		}

		store(workspace, artifact, file, buf);
		return json({ ok: true, bytes: buf.byteLength });
	}

	const out = new Headers();
	for (const name of PASS_HEADERS) {
		const value = res.headers.get(name);
		if (value) out.set(name, value);
	}

	// Stream, don't buffer: clips run to tens of megabytes and the body is
	// already a stream — re-reading it into memory would only add latency.
	return new Response(res.body, { status: res.status, headers: out });
};
