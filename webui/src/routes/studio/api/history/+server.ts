/** The list of past productions, and removing one from it. */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { forgetProduction, listProductions, recordProduction } from '../../history.server';
import { SLUG_RE } from '../../types';

export const GET: RequestHandler = async () => json({ productions: listProductions() });

export const DELETE: RequestHandler = async ({ url }) => {
	const slug = (url.searchParams.get('slug') ?? '').trim();
	if (!slug) throw error(400, 'slug is required');
	return json({ ok: forgetProduction(slug), productions: listProductions() });
};

/** Open a session in the list before anything has been rendered.
 *
 *  The sidebar used to fill in only when a render launched, which made the first
 *  minute of a session invisible — you typed, you attached a photograph, and
 *  nothing anywhere said a session existed. It also meant every render opened its
 *  own row, because each one arrived with its own slug and nothing tied them
 *  together.
 *
 *  A session is the unit now. It is created here the moment work starts, and
 *  every render that follows records against the same slug, so one afternoon of
 *  character, location and clip is one row rather than five.
 */
export const POST: RequestHandler = async ({ request }) => {
	let body: { slug?: unknown; title?: unknown; pitch?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
	if (!slug || !SLUG_RE.test(slug)) throw error(400, 'Bad slug');
	const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
	const pitch = typeof body.pitch === 'string' ? body.pitch.trim().slice(0, 200) : undefined;
	recordProduction({ slug, ...(title ? { title } : {}), ...(pitch ? { pitch } : {}) });
	return json({ ok: true, productions: listProductions() });
};
