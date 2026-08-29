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

/** How long a clip runs, in seconds.
 *
 *  Read out of ffmpeg's own banner rather than ffprobe, which is not installed
 *  on this machine. Zero when the line cannot be found, and every caller treats
 *  that as "no idea" and falls back — computing an offset from a wrong duration
 *  is worse than not computing one.
 */
export async function durationOf(clipPath: string): Promise<number> {
	let text = '';
	try {
		text = (await ffmpeg(['-hide_banner', '-i', clipPath])).stderr;
	} catch (e) {
		text = (e as { stderr?: string }).stderr ?? '';
	}
	const d = /Duration:\s(\d+):(\d\d):(\d\d\.\d+)/.exec(text);
	return d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
}

/** One frame from inside a clip, as PNG bytes.
 *
 *  For continuing a clip that was shot without a kept character or a kept
 *  location. The continuation workflow declares `character_sheet` and
 *  `environment_plate` as required inputs, so a clip made with neither could not
 *  be extended at all — the button sat greyed out on a finished render, which is
 *  a wall placed exactly where somebody wants to carry on.
 *
 *  The person is in the clip and so is the room. A frame of it satisfies the
 *  port and, for a continuation specifically, may serve better than a sheet
 *  would: a character sheet is somebody standing on a grey backdrop, while this
 *  is that person, in that room, in that light, moments before the new clip
 *  starts.
 *
 *  `at` is a fraction of the way through, not a timestamp, because the caller
 *  knows the shape of the clip and not its duration. Fractions rather than fixed
 *  seconds so a 5-second clip and a 15-second one are both sampled sensibly.
 */
export async function frameAt(clipPath: string, at: number): Promise<Uint8Array> {
	const dir = mkdtempSync(join(tmpdir(), 'auteur-frame-'));
	try {
		const out = join(dir, 'frame.png');
		// Duration from ffmpeg's own report — ffprobe is not installed here.
		const seconds = await durationOf(clipPath);
		// Held off both ends: the first frames of a generated clip are often the
		// model settling, and the last one belongs to the seam.
		const t = seconds > 0 ? Math.max(0.1, Math.min(seconds - 0.2, seconds * at)) : 0.5;
		await ffmpeg(['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', clipPath, '-frames:v', '1', out]);
		if (!existsSync(out)) throw error(422, 'a frame of that clip could not be read');
		const bytes = new Uint8Array(readFileSync(out));
		if (!(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50)) {
			throw error(422, 'the extracted frame is not a readable image');
		}
		return bytes;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Six views of the same person, cut out of a turnaround clip and tiled.
 *
 *  This is how an uploaded photograph gets a character sheet. The sheet
 *  workflows cannot help — both are text-to-image with no image input, so they
 *  can draw a person from a description and cannot redraw one from a photo. The
 *  video model can: give it the photograph as a reference and ask for a slow
 *  full turn, and the clip that comes back IS the turnaround. The frames are
 *  simply taken out of it.
 *
 *  Measured on the first one: identity held across all six — same face, hair,
 *  clothing and build, on the plain backdrop the prompt asks for.
 *
 *  Three across and two down because the frames are portrait; six in a row would
 *  be a strip nothing can display and two across would be a tower.
 */
export async function sheetGrid(clipPath: string, seconds: number): Promise<Uint8Array> {
	const dir = mkdtempSync(join(tmpdir(), 'auteur-sheet-'));
	try {
		// Inset at both ends: the first frames can carry the model settling into the
		// pose and the last can catch the turn overshooting past the front.
		const first = 0.25;
		const last = Math.max(first + 0.5, seconds - 0.35);
		const frames: string[] = [];
		for (let i = 0; i < 6; i++) {
			const t = first + (i * (last - first)) / 5;
			const f = join(dir, `f${i}.png`);
			await ffmpeg(['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', clipPath, '-frames:v', '1', f]);
			if (!existsSync(f)) throw error(422, `the turnaround has no frame at ${t.toFixed(2)}s`);
			frames.push(f);
		}
		const out = join(dir, 'sheet.png');
		await ffmpeg([
			'-y',
			'-v',
			'error',
			...frames.flatMap((f) => ['-i', f]),
			'-filter_complex',
			'[0][1][2]hstack=3[t];[3][4][5]hstack=3[b];[t][b]vstack=2,scale=1440:-2',
			'-frames:v',
			'1',
			out
		]);
		if (!existsSync(out)) throw error(422, 'the six views could not be tiled');
		const bytes = new Uint8Array(readFileSync(out));
		if (!(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50)) {
			throw error(422, 'the tiled sheet is not a readable image');
		}
		return bytes;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
