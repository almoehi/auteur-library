/** A stored sheet's bytes.
 *
 *  Two audiences, and they arrive by different roads. The browser asks for this
 *  to show you the sheet in a card or a picker. The harness asks for it when a
 *  render uses the sheet as an input — which is why the URL is a plain, stable,
 *  unauthenticated link rather than anything session-bound: the thing fetching
 *  it is a Docker container, not your tab.
 *
 *  Immutable by construction — a sheet's bytes never change, only its name does
 *  — so it is safe to let both audiences cache it hard.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { contentTypeFor, getSheet, readSheet } from '../../../../sheets.server';

export const GET: RequestHandler = async ({ params }) => {
	const id = params.id ?? '';
	const sheet = getSheet(id);
	if (!sheet) throw error(404, 'no such sheet');
	const bytes = readSheet(id);
	if (!bytes) throw error(404, 'that sheet has lost its file');
	return new Response(new Uint8Array(bytes), {
		headers: {
			'content-type': contentTypeFor(sheet.file),
			'content-length': String(bytes.length),
			'cache-control': 'public, max-age=31536000, immutable'
		}
	});
};
