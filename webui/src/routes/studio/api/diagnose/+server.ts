/** Look at a clip that did not work, and write the next attempt.
 *
 *  A verdict tells you a clip missed. It does not tell you whether the anatomy
 *  came apart, the motion stalled, or the model simply rendered something else —
 *  and the person who can most cheaply tell those apart is a model that can see
 *  the frames. That was the open question and it was worth checking before
 *  building on it: handed a frame from this afternoon's broken six-adapter clip,
 *  with no hint about where to look, the reply came back "the genitals and
 *  junction area show some surface sheen and soft-edge blending that looks
 *  slightly malformed or anatomically imprecise" — the exact defect, found
 *  unprompted. Explicit frames are accepted; the vision path is real.
 *
 *  The frames arrive already extracted, drawn off the <video> element the clip
 *  is playing in. That is not a shortcut around a missing tool so much as the
 *  cheaper path: the host has no ffmpeg, the harness's copy is behind a docker
 *  exec this app has no business making, and the browser has the decoded frames
 *  on screen already.
 *
 *  What comes back is a whole new shot — prompt and adapters both — because a
 *  diagnosis you have to act on by hand is a diagnosis most people will read and
 *  close. It lands on a card like any other, and nothing is spent until you send
 *  it.
 */
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readRenders } from '../../renders.server';
import { catalogueForWriter, loraFor, MAX_PICKS, type Pick } from '../../loras';
import { MODEL_API_NAME, modelFor, textFor } from '../../tunables';
import { readOverrides } from '../../overrides.server';
import { xaiPost } from '../../xai.server';


/** Vision and explicit material both, which is the pair that rules most models
 *  out. 4.6 refuses the text alone, and the smaller models do not see. */
const MODEL_FALLBACK = 'grok-4.5';

/** Longer than the writer's, because this call carries images. Measured at 41s
 *  on three frames; the ceiling is generous because a diagnosis that never
 *  returns is worse than one that takes a minute. */
const TIMEOUT_MS = 180_000;

/** Three frames: the opening, the middle where the key beat sits, and the close.
 *  More would cost tokens for very little — consecutive frames of an 8-second
 *  clip mostly repeat each other — and fewer misses defects that only appear
 *  once the motion has started. */
const MAX_FRAMES = 3;

const FRAME_MAX_BYTES = 4_000_000;

function askFor(prompt: string, picks: Pick[], note: string): string {
	const stack = picks.length
		? picks.map((p) => `${p.key} at ${p.strength}`).join(', ')
		: 'none beyond the two every clip loads';

	return `A clip was rendered from the brief below and it did not come out right.
The frames attached are from that clip, in order: near the start, the middle,
and near the end.

WHAT IT WAS RENDERED WITH

Adapters: ${stack}

The brief it was given:
---
${prompt}
---

${note ? `What the operator said was wrong with it:\n${note}\n` : 'The operator did not say what was wrong.\n'}
WHAT TO DO

First look at the frames and say what you actually see wrong — a body part that
does not resolve, a limb in an impossible place, two things blending into each
other, a shot that simply is not what the brief asked for. Name the region of
the frame. If the frames look fine and the fault must be in the motion or the
audio, say that instead of inventing something visible.

${note ? 'The operator told you what bothered them. Check it against the frames rather than repeating it back — if you cannot see what they describe, say so, and say what you can see.' : ''}

Then write the next attempt:

  - a complete replacement brief, in the same Template A format, that keeps
    everything that worked and changes what caused the fault. Do not rewrite it
    from scratch; a brief that fixed the hands and lost the room is not progress.
  - the adapters it should run with. An adapter that was drawing the region that
    failed is the first suspect: two adapters drawing the same part of the frame
    is what a malformed region usually is, and dropping one is a real fix.
    Lowering a strength inside its published range is the smaller move.

Return a single JSON object, no fences, with exactly these keys:

  "why"         one or two sentences: what you see wrong, and what you changed
  "prompt"      the complete replacement brief
  "seconds"     integer 4-15
  "orientation" "portrait" or "landscape"
  "loras"       the adapters for the next attempt, same shape as always`;
}

/** Same clamping as the writer's own reply goes through — this endpoint returns
 *  a card that can be launched, so it has to be as trustworthy as one. */
function readLoras(raw: unknown): Pick[] {
	if (!Array.isArray(raw)) return [];
	const out: Pick[] = [];
	let act = false;
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const { key, strength } = item as { key?: unknown; strength?: unknown };
		if (typeof key !== 'string') continue;
		const lora = loraFor(key);
		if (!lora || lora.kind === 'base' || out.some((p) => p.key === key)) continue;
		if (lora.kind === 'act') {
			if (act) continue;
			act = true;
		}
		const n = Number(strength);
		let value = lora.strength;
		if (lora.band && Number.isFinite(n)) value = Math.min(lora.band[1], Math.max(lora.band[0], n));
		out.push({ key, strength: Math.round(value * 100) / 100 });
		if (out.length >= MAX_PICKS) break;
	}
	return out;
}

export const POST: RequestHandler = async ({ request }) => {
	let payload: { workspace?: unknown; note?: unknown; frames?: unknown };
	try {
		payload = (await request.json()) as typeof payload;
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const workspace = typeof payload.workspace === 'string' ? payload.workspace.trim() : '';
	if (!workspace) throw error(400, 'workspace is required');

	const frames = (Array.isArray(payload.frames) ? payload.frames : [])
		.filter((f): f is string => typeof f === 'string' && f.startsWith('data:image/'))
		.slice(0, MAX_FRAMES);
	if (!frames.length) throw error(400, 'no frames to look at');
	if (frames.reduce((n, f) => n + f.length, 0) > FRAME_MAX_BYTES) {
		throw error(413, 'the frames are too large — send fewer or smaller ones');
	}

	// The settings come from the log rather than the caller. The page has them on
	// screen and could send them, but then a diagnosis would describe whatever
	// the page believed rather than what actually ran.
	const row = readRenders().find((r) => r.workspace === workspace);
	if (!row) {
		return json({
			ok: false,
			error:
				'this clip is not in the render log — it was made before the log existed, so there is nothing to diagnose against'
		});
	}

	const key = env.GROK_API_KEY;
	if (!key) return json({ ok: false, error: 'GROK_API_KEY is not set' });

	const note = typeof payload.note === 'string' ? payload.note.trim().slice(0, 2000) : '';
	const overrides = readOverrides();
	const model = MODEL_API_NAME[modelFor('shot_writer', overrides)] ?? MODEL_FALLBACK;

	// The writer's own instructions are the system prompt here too. A revision
	// written under different rules than the original is how a fix for the hands
	// arrives with the shot structure quietly rebuilt.
	const system = [textFor('shot_writer', overrides), catalogueForWriter()].filter(Boolean).join('\n\n---\n\n');

	let res: Response;
	try {
		res = await xaiPost({
				model,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: system },
					{
						role: 'user',
						content: [
							{ type: 'text', text: askFor(row.prompt, row.launched ?? [], note) },
							...frames.map((url) => ({ type: 'image_url', image_url: { url } }))
						]
					}
				]
			}, key, TIMEOUT_MS);
	} catch (e) {
		const timedOut = e instanceof Error && e.name === 'TimeoutError';
		return json({
			ok: false,
			error: timedOut
				? `nothing came back within ${TIMEOUT_MS / 1000}s`
				: `could not reach the model — ${e}`
		});
	}

	const text = await res.text();
	if (!res.ok) return json({ ok: false, error: `the model returned ${res.status}: ${text.slice(0, 300)}` });

	let content = '';
	try {
		content =
			(JSON.parse(text) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message
				?.content ?? '';
	} catch {
		return json({ ok: false, error: 'the model sent something that was not JSON' });
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(content) as Record<string, unknown>;
	} catch {
		return json({ ok: false, error: 'the model sent a reply that was not JSON' });
	}

	const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
	if (!prompt || !/\[Shot 1\]/.test(prompt)) {
		return json({ ok: false, error: 'the model did not produce a usable replacement brief' });
	}
	const n = Math.round(Number(parsed.seconds));

	return json({
		ok: true,
		shot: {
			prompt,
			seconds: Number.isFinite(n) ? Math.min(15, Math.max(4, n)) : row.seconds,
			orientation:
				parsed.orientation === 'landscape' || parsed.orientation === 'portrait'
					? parsed.orientation
					: row.width >= row.height
						? 'landscape'
						: 'portrait',
			why: typeof parsed.why === 'string' ? parsed.why.trim() : '',
			loras: readLoras(parsed.loras)
		}
	});
};
