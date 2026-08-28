/** Read and replace the film.
 *
 *  One GET and one POST, and the POST carries the whole list rather than an add
 *  or a remove. That is deliberate: the reel is ordered, and order is the thing
 *  most likely to be edited — expressing a drag as a sequence of add/remove
 *  calls invents a protocol whose failure mode is a film in an order nobody
 *  chose. The page owns the list; this endpoint owns the file.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFilm, writeFilm, type FilmClip } from '../../film.server';

export const GET: RequestHandler = async () => json({ ok: true, clips: readFilm() });

export const POST: RequestHandler = async ({ request }) => {
	let body: { clips?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ ok: false, error: 'Body must be JSON' }, { status: 200 });
	}
	if (!Array.isArray(body.clips)) {
		return json({ ok: false, error: 'clips must be an array' }, { status: 200 });
	}
	try {
		const clips = writeFilm(body.clips as FilmClip[]);
		return json({ ok: true, clips });
	} catch (e) {
		return json({ ok: false, error: `the film could not be saved: ${e}` }, { status: 200 });
	}
};
