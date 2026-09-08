/** The clip cache, listed and served.
 *
 *  `api/file` addresses a clip the way the harness does — workspace, artifact,
 *  file — and that is right for a clip the page is holding, because those are
 *  the three things it has. It is no use to a shelf of everything ever made:
 *  the cache is keyed by a hash of those three, the hash does not go backwards,
 *  and only three of a hundred and eighty-eight render rows carry the artifact
 *  id that would rebuild it. So the shelf asks by the cache's own name.
 *
 *  GET             the films, newest first — assembled work only, never shots
 *  GET ?id=<hash>  the bytes, honouring Range
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { serve, typeFor } from '../../../clips.server';
import { listFilms, mediaPath } from '../../media.server';

export const GET: RequestHandler = async ({ url, request }) => {
	const id = url.searchParams.get('id');
	if (!id) return json({ ok: true, items: listFilms() });

	const path = mediaPath(id);
	if (!path) throw error(404, 'no such clip');

	// Ranges are not optional: iOS Safari fetches video exclusively by range and
	// treats a 200 answer to a ranged request as a broken server.
	const slice = serve(path, request.headers.get('range'), typeFor('clip.mp4'));
	return new Response(slice.body, { status: slice.status, headers: slice.headers });
};
