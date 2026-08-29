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
import { checkDescription, checkRequest } from '../../minors.server';
import { xaiPost } from '../../xai.server';

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
	let payload: { request?: unknown; kind?: unknown; previous?: unknown; photo?: unknown };
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
	// Whether a photograph of this person exists. It changes what the writer is
	// for: with no picture the description IS the character and a gap in it gets
	// invented at random, so filling the gap is the writer's whole job. With a
	// picture the description is a correction to it, and filling a gap
	// manufactures a claim that then beats the photograph.
	const photo = payload.photo === true && kind === 'character';

	// Before the writer, not after: there is no point spending a model call on
	// something that will be refused, and the operator gets the reason in the
	// words they typed rather than in the writer's paraphrase of them.
	const gate = checkRequest(`${want}\n${previous}`);
	if (gate.refuse) return json({ ok: false, error: gate.refuse });

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
	const user = photo
		? `${subject}

The operator has ALREADY SUPPLIED A PHOTOGRAPH of this person. Your sentence will
be read beside it, and it OVERRIDES the photograph wherever the two disagree.

So put into English exactly what they said, and ADD NOTHING ELSE. No hair, no
build, no features, no clothing, nothing they left out. The photograph answers
all of that, and anything you invent here overrules a real person with a guess.
Filling gaps is right when there is no picture; here it is the failure.

The age rule still applies — that is a floor, not a description.

Do not use the "A photography of full body of" opener here: the sentence is read
as a note about the person, not as a caption for a render.

Return "why" as exactly "Nothing added." unless you had to supply the age.

---

${want}`
		: previous
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
		res = await xaiPost({
				model,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: writer },
					{ role: 'user', content: user }
				]
			}, key, TIMEOUT_MS);
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

	// And after the writer, because a rule in a prompt is guidance and this needs
	// to be a control. The writer is told to state an adult age; this is what
	// makes it true.
	const out = checkDescription(description, kind === 'location' ? 'place' : 'person');
	if (out.refuse) {
		return json({
			ok: false,
			error: `The description was refused — ${out.refuse}. Say how old they are and try again.`
		});
	}

	// Characters only. A location that came back with a voice is the writer
	// answering a question nobody asked, and storing it would put a speaking room
	// in the picker.
	const voice =
		kind === 'character' && typeof o.voice === 'string' ? o.voice.trim().slice(0, 240) : '';

	return json({
		ok: true,
		sheet: {
			kind,
			description: description.slice(0, DESCRIPTION_MAX),
			...(voice ? { voice } : {}),
			why: typeof o.why === 'string' ? o.why.trim() : ''
		}
	});
};
