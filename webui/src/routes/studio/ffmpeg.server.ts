/** The one ffmpeg this app uses, and the two things it is used for.
 *
 *  There is no system ffmpeg on this machine and the harness's copy lives in a
 *  container, so the binary the repo already installs is the one taken. Looked
 *  up rather than hard-coded because the studio runs from a worktree whose
 *  node_modules is not always its own.
 */
import { error } from '@sveltejs/kit';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function ffmpegPath(): string {
	const candidates = [
		join(process.cwd(), 'node_modules', 'ffmpeg-static', 'ffmpeg'),
		join(process.cwd(), '..', 'node_modules', 'ffmpeg-static', 'ffmpeg'),
		join(
			process.cwd(),
			'..',
			'node_modules',
			'.pnpm',
			'ffmpeg-static@5.3.0',
			'node_modules',
			'ffmpeg-static',
			'ffmpeg'
		),
		'/Users/szabodezso/ratemyd/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg'
	];
	for (const p of candidates) if (existsSync(p)) return p;
	throw error(500, 'ffmpeg is not installed — this needs it');
}

export async function ffmpeg(args: string[]): Promise<{ stdout: string; stderr: string }> {
	return await run(ffmpegPath(), args);
}

/** The final frame of a clip, as PNG bytes.
 *
 *  This is what makes a continuation join without a visible step: the workflow
 *  is given the whole prior clip as a reference video, which carries the motion
 *  but leaves the exact picture at the seam to the model's judgement. Handing it
 *  the actual last frame as well pins the picture too.
 *
 *  `-sseof -0.5` seeks to half a second before the end and `-update 1` writes
 *  every decoded frame over the same file, so what survives is the last one.
 *  Seeking to the exact end returns nothing — there is no frame at the duration
 *  mark — which is the trap this avoids.
 */
export async function lastFrame(clipPath: string): Promise<Uint8Array> {
	const dir = mkdtempSync(join(tmpdir(), 'auteur-frame-'));
	try {
		const out = join(dir, 'last.png');
		// No frame count: with -update every decoded frame overwrites the file, so
		// limiting the count would keep the FIRST of the tail rather than the last.
		await ffmpeg(['-y', '-v', 'error', '-sseof', '-0.5', '-i', clipPath, '-update', '1', out]);
		if (!existsSync(out)) {
			throw error(422, 'the last frame of that clip could not be read');
		}
		const bytes = new Uint8Array(readFileSync(out));
		// A PNG that is not a PNG means ffmpeg wrote something unexpected, and a
		// reference the GPU cannot decode fails minutes later rather than here.
		if (!(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50)) {
			throw error(422, 'the extracted frame is not a readable image');
		}
		return bytes;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
