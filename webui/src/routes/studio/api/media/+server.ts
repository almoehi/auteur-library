/** The shelf, and everything it could hold.
 *
 *  `api/file` addresses a clip the way the harness does — workspace, artifact,
 *  file — and that is right for a clip the page is holding. It is no use to a
 *  shelf: the cache is keyed by a hash of those three, the hash does not go
 *  backwards, and only three of a hundred and eighty-eight render rows carry the
 *  artifact id that would rebuild it. So this asks by the cache's own name.
 *
 *  GET              what is pinned, in the order it was pinned
 *  GET ?all=1       everything in the cache, newest first — the picker
 *  GET ?id=<hash>   the bytes, honouring Range
 *  POST {id,pinned} put one on the shelf or take it off
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { serve, typeFor } from '../../../clips.server';
import { listMedia, listPinned, mediaPath, readPins, setPin } from '../../media.server';

export const GET: RequestHandler = async ({ url, request }) => {
	const id = url.searchParams.get('id');
	if (id) {
		const path = mediaPath(id);
		if (!path) throw error(404, 'no such clip');
		// Ranges are not optional: iOS Safari fetches video exclusively by range and
		// treats a 200 answer to a ranged request as a broken server.
		const slice = serve(path, request.headers.get('range'), typeFor('clip.mp4'));
		// Wrapped the way api/file wraps the same Slice: a Node Buffer is a
		// Uint8Array at runtime but not a BodyInit to the type checker, so the
		// route type-checked everywhere it was copied from and not here.
		return new Response(new Uint8Array(slice.body), {
			status: slice.status,
			headers: slice.headers
		});
	}
	if (url.searchParams.get('all') === '1') {
		return json({ ok: true, items: listMedia(), pins: readPins() });
	}
	return json({ ok: true, items: listPinned() });
};

export const POST: RequestHandler = async ({ request }) => {
	let body: { id?: unknown; pinned?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const id = typeof body.id === 'string' ? body.id : '';
	if (!mediaPath(id)) throw error(404, 'no such clip');
	return json({ ok: true, pins: setPin(id, body.pinned !== false) });
};
