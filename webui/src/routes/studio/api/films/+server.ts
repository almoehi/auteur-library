/** The list of assembled films, and the note that one was made.
 *
 *  Read by the sidebar's shelf and by the all-media grid; written by Export.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readFilms, recordFilm } from '../../films.server';

export const GET: RequestHandler = async () => json({ ok: true, films: readFilms() });

export const POST: RequestHandler = async ({ request }) => {
	let body: {
		workspace?: unknown;
		artifact?: unknown;
		file?: unknown;
		parts?: unknown;
		seconds?: unknown;
		shots?: unknown;
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : '';
	const artifact = typeof body.artifact === 'string' ? body.artifact.trim() : '';
	const file = typeof body.file === 'string' ? body.file.trim() : '';
	// All three or nothing: a row that cannot address its own file is worse than
	// no row, because it looks like a film and answers with a 404.
	if (!workspace || !artifact || !file) throw error(400, 'workspace, artifact and file are required');

	recordFilm({
		workspace,
		artifact,
		file,
		parts: Number.isFinite(Number(body.parts)) ? Math.floor(Number(body.parts)) : 0,
		seconds: Number.isFinite(Number(body.seconds)) ? Number(body.seconds) : 0,
		at: Date.now(),
		...(Array.isArray(body.shots)
			? { shots: body.shots.filter((s): s is string => typeof s === 'string').slice(0, 64) }
			: {})
	});
	return json({ ok: true, films: readFilms() });
};
