/** A local copy of every clip the harness produces.
 *
 *  The clips are the product, and until now they were only reachable through a
 *  live workspace agent: /api/file proxies to the harness, and the harness
 *  resolves the artifact. When the agent dies — which it does, reproducibly, at
 *  the assembly step — every finished clip becomes unfetchable along with it.
 *  Rendered, approved, paid for on a GPU, and unplayable because an unrelated
 *  step crashed afterwards.
 *
 *  So each clip is copied here the moment it lands, and served from here
 *  afterwards. The harness is then only needed to *discover* a clip, never to
 *  replay one.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), 'auteur', 'studio-library', 'clips');

function ensure(): void {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

/** Hashed rather than composed from the three ids: artifact ids are uuids and
 *  file keys are free-form (`scene_1.mp4`, `Scene 2 clip v2.mp4`), so building a
 *  filename out of them means sanitising two things that can collide after
 *  sanitising. A hash cannot. The extension is kept so the file is openable by
 *  hand from Finder, which is half the point of caching to disk. */
function cachePath(workspace: string, artifact: string, file: string): string {
	const h = createHash('sha256').update(`${workspace} ${artifact} ${file}`).digest('hex');
	const ext = /\.([A-Za-z0-9]{1,5})$/.exec(file)?.[1] ?? 'bin';
	return join(DIR, `${h.slice(0, 32)}.${ext}`);
}

export function cached(workspace: string, artifact: string, file: string): string | null {
	const p = cachePath(workspace, artifact, file);
	try {
		return existsSync(p) && statSync(p).size > 0 ? p : null;
	} catch {
		return null;
	}
}

export function store(workspace: string, artifact: string, file: string, bytes: Uint8Array): void {
	ensure();
	// Write beside, then rename: rename is atomic within a directory, so a
	// reader either finds no file or finds the whole file. Writing in place
	// would let a playback request hit a half-written clip and cache a truncated
	// video for the rest of the session.
	const p = cachePath(workspace, artifact, file);
	const tmp = `${p}.part`;
	writeFileSync(tmp, bytes);
	renameSync(tmp, p);
}

export interface Slice {
	body: Buffer;
	status: 200 | 206;
	headers: Record<string, string>;
}

/** Serve a cached file, honouring a Range request.
 *
 *  Ranges are not optional here: iOS Safari fetches video exclusively by range
 *  and treats a 200 answer to a ranged request as a broken server, so a cache
 *  that ignored Range would play on the desktop and silently fail on a phone. */
export function serve(path: string, range: string | null, type: string): Slice {
	const size = statSync(path).size;
	const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;

	if (!m) {
		return {
			body: readFileSync(path),
			status: 200,
			headers: {
				'content-type': type,
				'content-length': String(size),
				'accept-ranges': 'bytes'
			}
		};
	}

	// An open-ended range ("bytes=0-") is the common one; a suffix range
	// ("bytes=-500") asks for the last N bytes.
	let start = m[1] ? Number(m[1]) : 0;
	let end = m[2] ? Number(m[2]) : size - 1;
	if (!m[1] && m[2]) {
		start = Math.max(0, size - Number(m[2]));
		end = size - 1;
	}
	start = Math.max(0, Math.min(start, size - 1));
	end = Math.max(start, Math.min(end, size - 1));

	const fd = readFileSync(path);
	return {
		body: fd.subarray(start, end + 1),
		status: 206,
		headers: {
			'content-type': type,
			'content-length': String(end - start + 1),
			'content-range': `bytes ${start}-${end}/${size}`,
			'accept-ranges': 'bytes'
		}
	};
}

/** Content type from the extension. The harness sends one, but a cache hit
 *  never talks to the harness, so the type has to be derivable locally. */
export function typeFor(file: string): string {
	const ext = (/\.([A-Za-z0-9]{1,5})$/.exec(file)?.[1] ?? '').toLowerCase();
	if (ext === 'mp4' || ext === 'm4v') return 'video/mp4';
	if (ext === 'webm') return 'video/webm';
	if (ext === 'png') return 'image/png';
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
	if (ext === 'json') return 'application/json';
	if (ext === 'md' || ext === 'txt') return 'text/plain; charset=utf-8';
	return 'application/octet-stream';
}

export const CLIPS_PATH = DIR;
