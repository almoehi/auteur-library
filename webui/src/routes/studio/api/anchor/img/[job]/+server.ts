/** A finished preview's bytes.
 *
 *  The picture is served from our own copy rather than from the presigned S3 URL
 *  it arrived on: that URL carries a credentialled signature, expires, and has no
 *  business in a browser. This one is a plain path that keeps working for as long
 *  as the file is on disk.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readPreview } from '../../../../anchorjobs.server';

export const GET: RequestHandler = async ({ params }) => {
	const bytes = readPreview(params.job ?? '');
	if (!bytes) throw error(404, 'no such preview');
	return new Response(new Uint8Array(bytes), {
		headers: {
			'content-type': 'image/png',
			'content-length': String(bytes.length),
			// The bytes for one job id never change; only the id does.
			'cache-control': 'public, max-age=86400, immutable'
		}
	});
};
