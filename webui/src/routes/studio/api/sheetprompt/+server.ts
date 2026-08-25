/** Turn what you typed into the description the sheet workflow receives.
 *
 *  This exists for a reason worth writing down, because the first version of the
 *  sheet flow deliberately did not have it. Both sheet workflows take a plain
 *  description rather than a structured prompt — their own port notes say so —
 *  so putting a writer in the middle looked like pure loss: every paraphrase is
 *  a chance to drop the detail you actually cared about.
 *
 *  What that reasoning missed is that the operator writes Hungarian and KREA-2
 *  reads English. Removing the writer removed the translation with it, and the
 *  first sheet ever rendered went to the model as `szőke nő kis mellekkel`.
 *
 *  So there is a writer, and its instructions are built around the original
 *  worry rather than against it: translate, fix the typos, add nothing. A sheet
 *  is rendered once and every later clip is shot against it, which makes an
 *  invented detail unusually expensive — it is not a bad sentence, it is a face
 *  nobody asked for, carried through a whole production.
 */
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readOverrides } from '../../overrides.server';
import { MODEL_API_NAME, modelFor, textFor } from '../../tunables';

const XAI = 'https://api.x.ai/v1/chat/completions';
const MODEL_FALLBACK = 'grok-4.5';

/** Shorter than the shot writer's, because the work is smaller: a sentence in,
 *  a sentence out. A minute is already generous. */
const TIMEOUT_MS = 60_000;
const REQUEST_MAX = 4_000;
/** A sheet describes a subject, not a scene. Anything past this is the writer
 *  having written a prompt, and the workflow reads it worse than the short
 *  version. */
const DESCRIPTION_MAX = 900;

export const POST: RequestHandler = async ({ request }) => {
	let payload: { request?: unknown; kind?: unknown; previous?: unknown };
	try {
		payload = (await request.json()) as typeof payload;
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const want = typeof payload.request === 'string' ? payload.request.trim() : '';
	if (!want) throw error(400, 'Missing request');
	if (want.length > REQUEST_MAX) throw error(400, `Request is longer than ${REQUEST_MAX} characters`);
	const kind = payload.kind === 'location' ? 'location' : 'character';
	// A refinement rather than a fresh subject: the operator is looking at a
	// picture and asking for one thing about it to change. Without the previous
	// description the writer would start over from three words and lose every
	// attribute that was already right.
	const previous = typeof payload.previous === 'string' ? payload.previous.trim() : '';

	const key = env.GROK_API_KEY;
	if (!key) {
		return json({
			ok: false,
			error:
				'GROK_API_KEY is not set — copy it from ~/auteur/.env into webui/.env and restart the dev server.'
		});
	}

	const overrides = readOverrides();
	const writer = textFor('sheet_writer', overrides);
	const model = MODEL_API_NAME[modelFor('sheet_writer', overrides)] ?? MODEL_FALLBACK;

	const subject =
		kind === 'character'
			? 'This is a CHARACTER sheet. Describe the person only.'
			: 'This is a LOCATION sheet. Describe the place only, with no people in it.';
	const user = previous
		? `${subject}

This is a REFINEMENT. Below is the description currently in use, followed by what
the operator wants changed about it. Return the same description with that change
applied and nothing else touched — every attribute they did not mention stays
exactly as it is, in the same words.

--- CURRENT DESCRIPTION ---
${previous}

--- WHAT TO CHANGE ---
${want}`
		: `${subject}\n\n---\n\n${want}`;

	let res: Response;
	try {
		res = await fetch(XAI, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
			body: JSON.stringify({
				model,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: writer },
					{ role: 'user', content: user }
				]
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (e) {
		const timedOut = e instanceof Error && e.name === 'TimeoutError';
		return json({
			ok: false,
			error: timedOut
				? `the sheet writer did not answer within ${TIMEOUT_MS / 1000}s`
				: `could not reach the sheet writer — ${e}`
		});
	}

	const text = await res.text();
	if (!res.ok) {
		return json({ ok: false, error: `the sheet writer returned ${res.status}: ${text.slice(0, 300)}` });
	}

	let content = '';
	try {
		content =
			(JSON.parse(text) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message
				?.content ?? '';
	} catch {
		return json({ ok: false, error: 'the sheet writer sent something that was not JSON' });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return json({ ok: false, error: 'the sheet writer sent a reply that was not JSON' });
	}

	const o = (parsed ?? {}) as Record<string, unknown>;
	const description = typeof o.description === 'string' ? o.description.trim() : '';
	if (!description) {
		return json({ ok: false, error: 'the sheet writer produced nothing usable — try rephrasing' });
	}

	return json({
		ok: true,
		sheet: {
			kind,
			description: description.slice(0, DESCRIPTION_MAX),
			why: typeof o.why === 'string' ? o.why.trim() : ''
		}
	});
};
