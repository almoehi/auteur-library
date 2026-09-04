/** Glue a chain of clips into one scene.
 *
 *  The continuation workflow renders only the new stretch — there is no join
 *  inside the graph — so a long scene is several clips that have to be put back
 *  together at the end. This is that step, and it is free: every clip in a chain
 *  is rendered at the same size, rate and codec on purpose, so the pieces are
 *  copied rather than re-encoded. No quality is lost and nothing waits on a GPU.
 *
 *  That "on purpose" is load-bearing, which is why the parts are checked before
 *  they are copied. `-c copy` does not verify that the streams it concatenates
 *  agree: hand it a 24 fps piece and a 48 fps piece and it writes a file that
 *  plays at the wrong speed instead of failing. A silently wrong scene is worse
 *  than a refused one, so a mismatch is refused with the numbers that differ.
 */
import { error, json } from '@sveltejs/kit';
// The shared lookup, not a private copy.
//
// This route had its own, and its list was repo-local paths plus one absolute
// path into another developer's home — no PATH search at all. So Export died
// with "ffmpeg is not installed" on a machine that has had it in
// /opt/homebrew/bin the whole time. The shared one already learned this lesson
// and carries the comment about it; two copies of the same question is how one
// of them stays wrong.
import { ffmpegPath } from '../../ffmpeg.server';
import type { RequestHandler } from './$types';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cached, store } from '../../../clips.server';

const run = promisify(execFile);

/** EBU R128, the broadcast target — and the number that took a pair measured 10
 *  dB apart down to 3. */
const TARGET_LUFS = -16;
/** True peak ceiling. Gain is refused past this rather than clipped. */
const PEAK_CEILING = -1.5;

interface Shape {
	width: number;
	height: number;
	fps: string;
	seconds: number;
}

/** Read a clip's shape out of ffmpeg's own report.
 *
 *  ffmpeg with no output writes the stream summary to stderr and exits non-zero;
 *  that is the expected path here, not a failure. ffprobe would be tidier and is
 *  not installed. */
async function shapeOf(bin: string, path: string): Promise<Shape> {
	let text = '';
	try {
		const r = await run(bin, ['-hide_banner', '-i', path]);
		text = r.stderr;
	} catch (e) {
		text = (e as { stderr?: string }).stderr ?? '';
	}
	const size = /,\s(\d{2,5})x(\d{2,5})[\s,]/.exec(text);
	const fps = /,\s([\d.]+)\sfps/.exec(text);
	const dur = /Duration:\s(\d+):(\d\d):(\d\d\.\d+)/.exec(text);
	if (!size || !dur) throw error(422, `could not read ${path.split('/').pop()} — it may not be a video`);
	return {
		width: Number(size[1]),
		height: Number(size[2]),
		fps: fps ? fps[1] : '?',
		seconds: Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
	};
}

export const POST: RequestHandler = async ({ request }) => {
	let body: { parts?: { workspace?: string; artifact?: string; file?: string }[] };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const parts = Array.isArray(body.parts) ? body.parts : [];
	if (parts.length < 2) {
		return json({ ok: false, error: 'a scene needs at least two clips' }, { status: 200 });
	}
	if (parts.length > 24) {
		return json({ ok: false, error: 'that is more clips than a scene should have' }, { status: 200 });
	}

	// Every piece has to be on this disk. A chain whose middle is missing would
	// otherwise be joined into a scene that skips, which is the kind of wrong that
	// is only noticed on playback.
	const paths: string[] = [];
	for (const p of parts) {
		const hit = cached(p.workspace ?? '', p.artifact ?? '', p.file ?? '');
		if (!hit) {
			return json(
				{ ok: false, error: 'one of the clips is not in the library any more — the scene would skip' },
				{ status: 200 }
			);
		}
		paths.push(hit);
	}

	const bin = ffmpegPath();
	const shapes: Shape[] = [];
	for (const p of paths) shapes.push(await shapeOf(bin, p));
	const first = shapes[0];
	for (let i = 1; i < shapes.length; i++) {
		const s = shapes[i];
		if (s.width !== first.width || s.height !== first.height || s.fps !== first.fps) {
			return json(
				{
					ok: false,
					error:
						`clip ${i + 1} is ${s.width}x${s.height} at ${s.fps} fps and clip 1 is ` +
						`${first.width}x${first.height} at ${first.fps} fps — they cannot be joined without re-rendering one of them`
				},
				{ status: 200 }
			);
		}
	}

	const dir = mkdtempSync(join(tmpdir(), 'auteur-scene-'));
	try {
		// Level the clips, but measure them one at a time and re-encode once.
		//
		// The model does not control how loud a clip comes out. Measured across ten
		// of them: 21 dB between the quietest and the loudest, and 10 dB between two
		// takes of ONE brief that differed only in the camera sentence. Cut those
		// together and the volume jumps at every seam, which is the most audible
		// thing wrong with a finished film.
		//
		// The obvious build — normalise each clip to its own file, then concatenate
		// those — is the one to avoid, and it was written first. Every AAC encode
		// adds priming samples at the head of its stream, and stream-copying N of
		// them together buries N of those inside the track. Measured on this pair:
		// video 9.61s against audio 9.70s where the untouched join is 9.55s against
		// 9.55s. Ninety milliseconds over two clips, accumulating — a second of lip
		// sync gone by the far end of a twenty-clip film.
		//
		// So: analysis only per clip, the concatenation stays a stream copy, and the
		// audio is encoded exactly once over the finished scene with a gain per
		// segment. One priming offset, at the very start, where the container's edit
		// list accounts for it.
		const gains: number[] = [];
		for (const p of paths) {
			let text = '';
			try {
				const r = await run(bin, ['-hide_banner', '-i', p, '-af', 'loudnorm=print_format=json', '-f', 'null', '-']);
				text = r.stderr;
			} catch (e) {
				text = (e as { stderr?: string }).stderr ?? '';
			}
			// input_i is the integrated loudness in LUFS, input_tp the true peak.
			const i = Number(/"input_i"\s*:\s*"(-?[\d.]+)"/.exec(text)?.[1]);
			const tp = Number(/"input_tp"\s*:\s*"(-?[\d.]+)"/.exec(text)?.[1]);
			// A silent or absent track measures -inf and must not be amplified into
			// a hiss; leave anything unreadable exactly as it is.
			if (!Number.isFinite(i) || i < -70) {
				gains.push(0);
				continue;
			}
			// Held under the ceiling rather than pushed to the target regardless: a
			// clip whose peaks are already near full scale cannot take the gain its
			// average asks for without clipping, and a clipped moan is worse than a
			// quiet one.
			const wanted = TARGET_LUFS - i;
			const headroom = Number.isFinite(tp) ? PEAK_CEILING - tp : wanted;
			gains.push(Math.round(Math.max(-24, Math.min(wanted, headroom, 24)) * 10) / 10);
		}

		// Absolute paths and `-safe 0`: the list is written by us and points into
		// the library, which the concat demuxer refuses to trust by default.
		const list = join(dir, 'parts.txt');
		writeFileSync(list, paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n', 'utf8');
		const cut = join(dir, 'cut.mp4');
		await run(bin, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', cut]);

		// One gain per stretch of the finished scene, applied in a single pass.
		// `enable` switches a filter on for a span of the timeline, so a chain of
		// them is one gain envelope with a step at every seam. The picture is
		// copied — nothing here is a picture problem.
		//
		// Skipped entirely when every clip already sits where it should: the scene
		// is then exactly what it was before this existed, stream copy and all.
		let out = cut;
		if (gains.some((g) => Math.abs(g) >= 0.5)) {
			const steps: string[] = [];
			let at = 0;
			for (const [i, sh] of shapes.entries()) {
				const to = at + sh.seconds;
				if (Math.abs(gains[i]) >= 0.1) {
					steps.push(`volume=${gains[i]}dB:enable='between(t,${at.toFixed(3)},${to.toFixed(3)})'`);
				}
				at = to;
			}
			// A limiter after the steps, not instead of them: the per-clip ceiling
			// already keeps each stretch under the true peak, and this only catches
			// what a seam or a rounding leaves over.
			steps.push('alimiter=limit=0.95');
			const levelled = join(dir, 'scene.mp4');
			await run(bin, [
				'-y', '-v', 'error', '-i', cut,
				'-c:v', 'copy',
				'-af', steps.join(','),
				'-c:a', 'aac', '-b:a', '160k', '-ar', '32000', '-ac', '2',
				levelled
			]);
			out = levelled;
		}

		const bytes = new Uint8Array(readFileSync(out));
		const joined = await shapeOf(bin, out);
		const expected = shapes.reduce((a, s) => a + s.seconds, 0);
		// A tenth of a second of slack per part: container timestamps round, and a
		// join that lost a whole clip is what this is looking for.
		if (Math.abs(joined.seconds - expected) > 0.1 * parts.length + 0.2) {
			return json(
				{
					ok: false,
					error: `the joined scene is ${joined.seconds.toFixed(2)}s but the parts add up to ${expected.toFixed(2)}s`
				},
				{ status: 200 }
			);
		}

		// Filed under the last clip's identity: a scene belongs to the end of its
		// chain, which is where it is asked for and where the button that made it
		// lives.
		const last = parts[parts.length - 1];
		const name = 'scene.mp4';
		store(last.workspace ?? '', last.artifact ?? '', name, bytes);

		return json({
			ok: true,
			url: `/api/file?workspace=${encodeURIComponent(last.workspace ?? '')}&artifact=${encodeURIComponent(
				last.artifact ?? ''
			)}&file=${encodeURIComponent(name)}`,
			parts: parts.length,
			seconds: Number(joined.seconds.toFixed(2)),
			width: joined.width,
			height: joined.height,
			bytes: bytes.byteLength
		});
	} catch (e) {
		return json({ ok: false, error: `the scene could not be assembled — ${e}` }, { status: 200 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};
