/** The same shot, from somewhere else.
 *
 *  Given a finished shot prompt, return N of them that differ in the camera and
 *  in nothing else. It re-frames the prompt the card is already holding rather
 *  than rewriting the request, and that distinction is the whole feature: by the
 *  time this runs you have read that prompt, possibly edited it, and approved
 *  it. Sending the request back to the writer would produce three different
 *  scenes; sending it the prompt produces three views of one.
 *
 *  Everything else must survive word for word — the subjects, the wardrobe, the
 *  action, the beat timings, the location, the light. The clips are meant to be
 *  interchangeable, so anything that changes length or content makes them a
 *  comparison of different things rather than a choice between angles.
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { xaiPost } from '../../xai.server';
import { checkRequest } from '../../minors.server';
import { MODEL_API_NAME, modelFor, type Overrides } from '../../tunables';

/** The writer's own model, for the writer's own reason: 4.6 refuses this
 *  material outright and the smaller models flatten a prompt into a summary. */
const MODEL_FALLBACK = 'grok-4.5';

/** Shorter than the writer's 120s: this is an edit of an existing text, not a
 *  composition from a sentence. */
const TIMEOUT_MS = 90_000;

const PROMPT_MAX = 12_000;
/** Four is what the harness renders at once, so nothing here can ask for a
 *  batch that would queue behind itself. */
const MAX_ANGLES = 4;

const SYSTEM = `You re-frame one shot.

You are given a finished, approved shot prompt. Return several versions of it
that differ ONLY in where the camera is and how the shot is framed.

Keep identical, word for word wherever the sentence does not describe the
camera:
- the subject definitions, their bodies, hair, wardrobe and identity references
- every action and every beat, including the timestamps and what happens at each
- the location, the props, the lighting and the soundscape
- the duration and the structure of the prompt

Change only:
- the camera position, height and distance
- the framing (wide / medium / close, and what fills the frame)
- which part of the same action the frame is centred on
- any sentence that describes what the camera does

Rules:
- Every version must describe the SAME moment of the SAME action. They are
  angles on one event, not different events.
- Do not add or remove beats. Do not change any timestamp.
- Do not introduce a person, an object or a location that is not already there.
- Keep any trigger words and adapter tokens exactly as written.
- Each version must be a complete prompt in the same format as the input,
  usable on its own.

Reply as JSON: {"angles": ["<full prompt>", "<full prompt>", ...]}`;

export const POST: RequestHandler = async ({ request }) => {
	let payload: { prompt?: string; count?: number; overrides?: Overrides };
	try {
		payload = (await request.json()) as typeof payload;
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const prompt = (payload.prompt ?? '').trim();
	if (!prompt) throw error(400, 'Missing prompt');
	if (prompt.length > PROMPT_MAX) throw error(400, `Prompt is longer than ${PROMPT_MAX} characters`);

	const asked = Math.round(Number(payload.count));
	const count = Number.isFinite(asked) ? Math.min(MAX_ANGLES, Math.max(2, asked)) : 2;

	// The prompt arriving here has already passed the writer's gate. It passes it
	// again because what comes back is a rewrite, and a rewrite is new text.
	const gate = checkRequest(prompt);
	if (gate.refuse) return json({ ok: false, error: gate.refuse });

	const key = env.GROK_API_KEY;
	if (!key) return json({ ok: false, error: 'GROK_API_KEY is not set on the server' });

	const model = MODEL_API_NAME[modelFor('shot_writer', payload.overrides)] ?? MODEL_FALLBACK;

	let res: Response;
	try {
		res = await xaiPost(
			{
				model,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: SYSTEM },
					{
						role: 'user',
						content: `Give me ${count} camera angles on this shot.\n\n---\n\n${prompt}`
					}
				]
			},
			key,
			TIMEOUT_MS
		);
	} catch (e) {
		const timedOut = e instanceof Error && e.name === 'TimeoutError';
		return json({
			ok: false,
			error: timedOut
				? `the angles did not come back within ${TIMEOUT_MS / 1000}s`
				: `could not reach the prompt writer — ${e}`
		});
	}

	const text = await res.text();
	if (!res.ok) {
		return json({ ok: false, error: `the prompt writer returned ${res.status}: ${text.slice(0, 300)}` });
	}

	let content = '';
	try {
		content = (JSON.parse(text) as { choices?: { message?: { content?: string } }[] }).choices?.[0]
			?.message?.content ?? '';
	} catch {
		return json({ ok: false, error: 'the prompt writer sent something that was not JSON' });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return json({ ok: false, error: 'the prompt writer sent a reply that was not JSON' });
	}

	const raw = (parsed as { angles?: unknown })?.angles;
	const angles = (Array.isArray(raw) ? raw : [])
		.filter((a): a is string => typeof a === 'string')
		.map((a) => a.trim())
		.filter(Boolean);

	if (angles.length < 2) {
		return json({
			ok: false,
			error: 'the prompt writer did not return usable angles — try again, or render versions instead'
		});
	}

	// One refusal refuses the batch. Dropping the offending version and shooting
	// the rest would render most of what was asked for and say nothing about the
	// part that was not.
	for (const a of angles) {
		const g = checkRequest(a);
		if (g.refuse) return json({ ok: false, error: g.refuse });
	}

	return json({ ok: true, angles: angles.slice(0, count) });
};
