/** Everything this studio has actually made, as a list.
 *
 *  The clip cache is the only complete record of the work. The render log knows
 *  what was asked for and the film log knows what was assembled, but neither
 *  addresses the files: a clip is cached under a one-way hash of its workspace,
 *  artifact and file key, and only three of a hundred and eighty-eight render
 *  rows carry the artifact id that would let you rebuild it. So the cache is
 *  read directly, by the name it is stored under, which is the one handle that
 *  always exists.
 *
 *  Duration comes out of the file rather than a database, because there is no
 *  database — the same reason everything else here is a JSONL beside it. It is
 *  the one fact a tile needs that the filename does not carry: it separates the
 *  films from the shots, and a grid of unlabelled rectangles is a folder rather
 *  than a shelf.
 *
 *  Indexed on disk, because the answer is expensive and never changes. An mp4
 *  written by this pipeline puts its moov atom at the END, so the duration is
 *  two megabytes into the tail of every file — a hundred and eighty-eight of
 *  those on every page load is a third of a gigabyte of reads for a number that
 *  was true the first time. Keyed by size and mtime, so a file that is replaced
 *  is measured again and one that is not never is.
 */
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	statSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { CLIPS_PATH } from '../clips.server';

const INDEX = join(CLIPS_PATH, '..', 'media-index.json');

export interface MediaItem {
	/** The cache filename without its extension — how the browser asks for it. */
	id: string;
	seconds: number;
	bytes: number;
	/** Last written, which for a cache entry is when the clip arrived. */
	at: number;
}

type Index = Record<string, { seconds: number; bytes: number; mtime: number }>;

function loadIndex(): Index {
	try {
		return JSON.parse(readFileSync(INDEX, 'utf8')) as Index;
	} catch {
		return {};
	}
}

/** How long this video runs, read out of its own header.
 *
 *  `mvhd` carries the movie timescale and duration. It lives inside `moov`,
 *  which this pipeline writes at the end of the file rather than the front, so
 *  both ends are searched — the head first because a file that was remuxed for
 *  streaming has it there and the head is cheap.
 */
function durationOf(path: string, size: number): number {
	// Positional reads on one descriptor. The obvious version of this helper
	// reads the whole file and slices it, which is the opposite of the point:
	// the tail is two megabytes of a file that can be twenty.
	const fd = openSync(path, 'r');
	const read = (from: number, len: number): Buffer => {
		const want = Math.min(len, Math.max(0, size - from));
		if (!want) return Buffer.alloc(0);
		const buf = Buffer.alloc(want);
		readSync(fd, buf, 0, want, from);
		return buf;
	};
	let head: Buffer;
	let tail: Buffer;
	try {
		head = read(0, 300_000);
		tail = read(Math.max(0, size - 2_000_000), 2_000_000);
	} finally {
		closeSync(fd);
	}
	for (const buf of [head, tail]) {
		const i = buf.indexOf('mvhd');
		if (i < 0) continue;
		try {
			const version = buf[i + 4];
			const scale = version === 0 ? buf.readUInt32BE(i + 16) : buf.readUInt32BE(i + 24);
			const units = version === 0 ? buf.readUInt32BE(i + 20) : Number(buf.readBigUInt64BE(i + 28));
			const secs = scale ? units / scale : 0;
			// An hour is not a clip. A bad parse lands on a wild number far more
			// often than on a plausible one, and a wrong badge is worse than none.
			if (secs > 0 && secs < 3600) return secs;
		} catch {
			/* try the other end */
		}
	}
	return 0;
}

/** The cache, newest first, with a duration on every row. */
export function listMedia(): MediaItem[] {
	if (!existsSync(CLIPS_PATH)) return [];
	const index = loadIndex();
	let dirty = false;
	const items: MediaItem[] = [];

	for (const name of readdirSync(CLIPS_PATH)) {
		if (!name.toLowerCase().endsWith('.mp4')) continue;
		const path = join(CLIPS_PATH, name);
		let stat;
		try {
			stat = statSync(path);
		} catch {
			continue;
		}
		const id = name.replace(/\.mp4$/i, '');
		const known = index[id];
		let seconds = known?.seconds ?? 0;
		if (!known || known.bytes !== stat.size || known.mtime !== stat.mtimeMs) {
			seconds = durationOf(path, stat.size);
			index[id] = { seconds, bytes: stat.size, mtime: stat.mtimeMs };
			dirty = true;
		}
		items.push({ id, seconds, bytes: stat.size, at: stat.mtimeMs });
	}

	if (dirty) {
		try {
			writeFileSync(INDEX, JSON.stringify(index), 'utf8');
		} catch {
			/* the index is a cache of a cache; failing to write it costs a re-read */
		}
	}
	return items.sort((a, b) => b.at - a.at);
}

/** Where one item is on disk, or null if the id is not one of ours.
 *
 *  The id goes into a path, so it is checked against the shape the cache writes
 *  rather than merely escaped: thirty-two hex characters and nothing else. */
export function mediaPath(id: string): string | null {
	if (!/^[0-9a-f]{32}$/i.test(id)) return null;
	const path = join(CLIPS_PATH, `${id}.mp4`);
	return existsSync(path) ? path : null;
}
