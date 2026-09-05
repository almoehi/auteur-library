/** Model files the hosted harness cannot fetch from where they live.
 *
 *  Civitai wants a token and the hosted sandbox has none, so the LoRAs that
 *  come from there are downloaded once, checked against the sha256 the bundle
 *  already declares, and served from here — the file, and beside it
 *  `<file>.sha256`, the text sidecar that harness verifies against. The bundle
 *  points at this route when AUTEUR_MODEL_MIRROR names it (bundle.server.ts,
 *  mirrorCivitai). A bucket would do the same job with less of the studio's
 *  bandwidth; this exists so the first hosted render did not have to wait for
 *  one.
 *
 *  Read-only, names restricted to one path segment of safe characters, and
 *  Range honoured, because a downloader that resumes is a downloader that
 *  finishes.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const DIR = join(homedir(), 'auteur', 'studio-library', 'models');
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export const GET: RequestHandler = async ({ params, request }) => {
	const name = params.file ?? '';
	if (!NAME.test(name) || name.includes('..')) throw error(404, 'no such model file');
	const path = join(DIR, name);
	if (!existsSync(path)) throw error(404, 'no such model file');
	const size = statSync(path).size;
	const type = name.endsWith('.sha256') ? 'text/plain; charset=utf-8' : 'application/octet-stream';

	const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
	let start = 0;
	let end = size - 1;
	let status = 200;
	if (range && (range[1] || range[2])) {
		start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
		end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : end;
		if (!(start <= end && start < size)) {
			return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
		}
		status = 206;
	}
	const headers: Record<string, string> = {
		'content-type': type,
		'content-length': String(end - start + 1),
		'accept-ranges': 'bytes',
		'cache-control': 'public, max-age=31536000, immutable'
	};
	if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`;
	const stream = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
	return new Response(stream, { status, headers });
};
