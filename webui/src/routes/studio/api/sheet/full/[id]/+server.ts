/** A character's six-view turnaround, once it has arrived.
 *
 *  Separate from the profile picture route next door because they are two
 *  different images of the same person: the small one you picked them by, and
 *  the sheet a render uses. A character can have the first without the second.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSheet, readSheetImage } from '../../../../sheets.server';

export const GET: RequestHandler = async ({ params }) => {
	const id = params.id ?? '';
	const sheet = getSheet(id);
	if (!sheet) throw error(404, 'no such character');
	const bytes = readSheetImage(id);
	if (!bytes) {
		throw error(404, sheet.sheet?.state === 'rendering' ? 'the turnaround is still rendering' : 'this character has no turnaround');
	}
	return new Response(new Uint8Array(bytes), {
		headers: {
			'content-type': 'image/png',
			'content-length': String(bytes.length),
			'cache-control': 'public, max-age=31536000, immutable'
		}
	});
};
