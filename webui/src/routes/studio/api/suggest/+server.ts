/** One clause, fitted to what was actually typed.
 *
 *  The "add anything?" chips used to write the same two phrases every time —
 *  "slow at first, then faster", "close and handheld". True for any clip, which
 *  is exactly what is wrong with them: on a shot about one thing filling the
 *  frame, a generic turn is filler the operator has to delete before it hurts
 *  the brief.
 *
 *  So the clause is written for the line it is being added to. Small, fast and
 *  cheap — eight words at most, on the quick model, one sentence of system
 *  prompt — because it lands in a text box under the cursor and anything slower
 *  than a tap is worse than the fixed phrase it replaces.
 *
 *  It never invents a person, a place or an act. Those are the operator's, and
 *  guessing them is the mistake the whole ask-first mechanism exists to stop —
 *  this fills in the SHAPE: what moves, or how it is seen.
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { xaiPost } from '../../xai.server';

const MODEL = 'grok-4.3';
const TIMEOUT_MS = 12_000;

const SYSTEM = `You add one short clause to a video prompt somebody is writing.

Answer with the clause only: no quotes, no full stop, no preamble, at most
eight words, in the same language as their line.

action: what physically happens and how it changes — a shot needs one turn, not
a list. "she slows, then takes him deeper", "it swells, then jumps at the end".

camera: where the camera is and how it moves. "close, handheld, low", "slow push
in on her face".

Never add a person, a place, or an act they did not ask for. You are describing
the shape of what they already wrote.`;

export const POST: RequestHandler = async ({ request }) => {
	const key = env.GROK_API_KEY;
	if (!key) throw error(503, 'no model key');

	let body: { request?: unknown; kind?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const said = typeof body.request === 'string' ? body.request.trim().slice(0, 600) : '';
	const kind = body.kind === 'camera' ? 'camera' : 'action';
	if (!said) throw error(400, 'nothing to add to');

	const res = await xaiPost(
		{
			model: MODEL,
			temperature: 0.6,
			max_tokens: 40,
			messages: [
				{ role: 'system', content: SYSTEM },
				{ role: 'user', content: `their line: ${said}\n\nadd: ${kind}` }
			]
		},
		key,
		TIMEOUT_MS
	);
	if (!res.ok) throw error(502, `model ${res.status}`);

	const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	// Trimmed hard: the model is asked for a bare clause and mostly gives one,
	// but a stray quote or full stop would be pasted straight into the box.
	const clause = (data.choices?.[0]?.message?.content ?? '')
		.trim()
		.replace(/^["'`]|["'`.]$/g, '')
		.replace(/\s+/g, ' ')
		.slice(0, 90);
	return json({ ok: true, clause });
};
