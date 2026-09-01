/** What is about to be shot, read back in one or two sentences, streamed.
 *
 *  This sits in front of the prompt writer, and it exists because of a user
 *  test. A creator took their references out to a general chat, iterated on a
 *  short description there until they liked it, and only then came back to
 *  render — because our own answer to "she rides him hard" was six hundred
 *  words of technical brief that took the best part of a minute to arrive.
 *  Nobody reads six hundred words. So the brief was never the thing they were
 *  approving; it was a wall they clicked past, and the first real look at the
 *  order was the finished clip, four minutes and a GPU later.
 *
 *  So: a cheap sentence first. It is not a summary of the brief — it is written
 *  BEFORE the brief and is what the brief gets made from, which is the only
 *  arrangement where approving it means anything. A summary of a decision
 *  already taken is a receipt, not a say.
 *
 *  Everything the slow writer carries is deliberately absent here: no SKILL.md,
 *  no LoRA catalogue, no motion doctrine. Those exist to make a good clip; this
 *  call exists to answer "did you understand me", and it has to answer while
 *  the operator's hands are still on the keyboard. One system block, a handful
 *  of facts, the non-reasoning model.
 */
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readOverrides } from '../../overrides.server';
import { MODEL_API_NAME, modelFor, textFor } from '../../tunables';
import { checkRequest } from '../../minors.server';
import { xaiPost } from '../../xai.server';

/** Only if the id is missing from the registry — which would itself be a bug,
 *  but a bug that should still answer fast rather than fall back to the model
 *  the operator is waiting to escape. */
const MODEL_FALLBACK = 'grok-4.20-0309-non-reasoning';

/** Two sentences off a non-reasoning model. Measured at 1.3s end to end against
 *  the live endpoint. If nothing has arrived in twenty seconds the provider is
 *  wedged, not thinking — and the whole point of this call is that waiting for
 *  it is not a thing a person should have to do. */
const TIMEOUT_MS = 20_000;

const REQUEST_MAX = 4_000;
/** Enough to carry a refinement conversation, short enough to stay sub-second.
 *  Rounds beyond this are dropped from the oldest, which is the right end: the
 *  newest message is the change being made. */
const HISTORY_MAX = 12;

interface Ctx {
	request?: unknown;
	seconds?: unknown;
	res?: unknown;
	aspect?: unknown;
	makes?: unknown;
	character?: unknown;
	location?: unknown;
	refs?: unknown;
	history?: unknown;
	/** A setting the operator changed instead of typing — "length 5 -> 15
	 *  seconds". Stands in for the request on that round. */
	changed?: unknown;
}

function str(v: unknown, max = 400): string {
	return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** The facts, as lines the model reads rather than JSON it has to parse.
 *
 *  Only what is actually set. An empty field written out as "location: none"
 *  invites the model to fill it — the failure this whole endpoint is trying to
 *  avoid — whereas an absent line is simply nothing to say. */
function facts(c: Ctx, said: string): string {
	const out: string[] = [];
	const seconds = typeof c.seconds === 'number' && c.seconds > 0 ? Math.round(c.seconds) : 0;
	if (seconds) out.push(`seconds: ${seconds}`);

	// The name only. What they look like is pinned by id and the operator picked
	// them from a picture — reading their appearance back adds words without
	// adding a decision, and the writer gets the real description server-side.
	const who = str(c.character, 120);
	if (who) out.push(`character: ${who}`);

	const where = str(c.location, 200);
	if (where) out.push(`location: ${where}`);

	const makes = str(c.makes, 60);
	if (makes && makes !== 'one clip') out.push(`making: ${makes}`);

	const refs = Array.isArray(c.refs)
		? c.refs.map((r) => str(r, 120)).filter(Boolean).slice(0, 6)
		: [];
	for (const r of refs) out.push(`attached reference: ${r}`);

	// The rounds so far, oldest first, so a refinement adds to what was agreed
	// instead of replacing it.
	const history = Array.isArray(c.history)
		? c.history.map((h) => str(h, 600)).filter(Boolean).slice(-HISTORY_MAX)
		: [];
	if (history.length) {
		out.push('', 'agreed so far:', ...history.map((h) => `  ${h}`));
	}

	const changed = str(c.changed, 200);
	if (said) {
		out.push('', `the operator now says: ${said}`);
		// Last line, after their words, because that is where it holds.
		//
		// The rule is in the system prompt too and the system prompt lost: every
		// label here is English and so are the character and location names, so
		// the model read the room and answered in English to a Hungarian operator.
		// What language to answer in is decided by one line in the whole payload,
		// and it works when it sits directly under that line.
		out.push('', 'Answer in the same language as that last line, whatever it is.');
	} else {
		// A setting moved and nobody typed. There is no last line to take the
		// language from, so it comes from what was agreed — which is the only
		// text on this round that a person wrote, or approved.
		out.push('', `the operator changed a setting instead of writing: ${changed}`);
		out.push('', 'Answer in the language of the "agreed so far" text above.');
	}
	return out.join('\n');
}

/** xAI's SSE frames in, plain text out.
 *
 *  Plain text rather than an envelope of our own: the payload is one or two
 *  sentences of prose with no side channel, so there is nothing an envelope
 *  would carry. It also means the client is `while (read()) line += chunk` and
 *  nothing else — no parser to get wrong, on either end.
 *
 *  Partial frames are the normal case, not an error: a chunk boundary can land
 *  mid-JSON. So the buffer keeps whatever has no terminator yet, and a frame
 *  that will not parse is dropped rather than killing the stream — losing a
 *  word beats losing the sentence.
 */
function toText(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buf = '';

	return upstream.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buf += decoder.decode(chunk, { stream: true });
				let cut = buf.indexOf('\n\n');
				while (cut !== -1) {
					const frame = buf.slice(0, cut).trim();
					buf = buf.slice(cut + 2);
					cut = buf.indexOf('\n\n');
					if (!frame.startsWith('data:')) continue;
					const payload = frame.slice(5).trim();
					if (!payload || payload === '[DONE]') continue;
					try {
						const parsed = JSON.parse(payload) as {
							choices?: { delta?: { content?: string } }[];
						};
						const piece = parsed.choices?.[0]?.delta?.content;
						if (piece) controller.enqueue(encoder.encode(piece));
					} catch {
						// A frame we cannot read is a frame we skip.
					}
				}
			}
		})
	);
}

export const POST: RequestHandler = async ({ request }) => {
	let body: Ctx;
	try {
		body = (await request.json()) as Ctx;
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const said = str(body.request, REQUEST_MAX + 1);
	const changed = str(body.changed, 200);
	// One or the other: words, or a setting that moved. A round with neither has
	// nothing to answer.
	if (!said && !changed) throw error(400, 'Missing request');
	if (said.length > REQUEST_MAX) {
		throw error(400, `That is longer than ${REQUEST_MAX} characters`);
	}
	// A setting change has to be answering something that was said. Without a
	// prior round there is nothing to re-shape.
	if (!said && !(Array.isArray(body.history) && body.history.length)) {
		throw error(400, 'Nothing to re-shape');
	}

	// The same gate as the writer, in front of the same words. It has to be here
	// too and not only downstream: this endpoint would otherwise stream a
	// readable restatement of something the writer is about to refuse.
	if (said) {
		const gate = checkRequest(said);
		if (gate.refuse) return json({ ok: false, error: gate.refuse });
	}

	const key = env.GROK_API_KEY;
	if (!key) {
		return json({
			ok: false,
			error:
				'GROK_API_KEY is not set — copy it from ~/auteur/.env into webui/.env and restart the dev server.'
		});
	}

	const overrides = readOverrides();
	const system = textFor('confirm_writer', overrides);
	const model = MODEL_API_NAME[modelFor('confirm_writer', overrides)] ?? MODEL_FALLBACK;

	let upstream: Response;
	try {
		upstream = await xaiPost(
			{
				model,
				stream: true,
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: facts(body, said) }
				]
			},
			key,
			TIMEOUT_MS
		);
	} catch (e) {
		const timedOut = e instanceof Error && e.name === 'TimeoutError';
		return json({
			ok: false,
			error: timedOut ? `no answer within ${TIMEOUT_MS / 1000}s` : `could not reach the model — ${e}`
		});
	}

	if (!upstream.ok || !upstream.body) {
		const detail = (await upstream.text().catch(() => '')).slice(0, 300);
		return json({ ok: false, error: `the model returned ${upstream.status}: ${detail}` });
	}

	// A stream and a JSON error are told apart by content-type on the client, so
	// both shapes can live on one endpoint without a status code that lies.
	return new Response(toText(upstream.body), {
		headers: {
			'content-type': 'text/plain; charset=utf-8',
			'cache-control': 'no-store',
			// Nothing proxies this today — adapter-node, no hooks, no compression —
			// but a buffering proxy is exactly the thing that would turn a streamed
			// sentence back into a wait, silently.
			'x-accel-buffering': 'no'
		}
	});
};
