/** Turn what you asked for into the prompt the renderer receives.
 *
 *  Simple mode's whole substance. One model, one pass, the MiniMax H3 skill in
 *  context, and the result handed back for you to read and edit before it costs
 *  anything. That last part is the point: the planning chain wrote its render
 *  prompts invisibly, and a pipeline nobody could see spent months producing
 *  1125-word briefs whose first four thousand characters were appearance
 *  description — which is how a request for a blowjob came back as a portrait.
 *
 *  Measured over 32 requests across four scenes, two of them in Hungarian:
 *  no refusals, no Template B leakage, every timestamp inside its duration,
 *  every beat closed with an observable end state. Three drifted past the
 *  700-word band and none past 800, which is why the card shows a word count
 *  rather than the endpoint enforcing one.
 *
 *  Unauthenticated and local, like the rest of this app.
 */
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const XAI = 'https://api.x.ai/v1/chat/completions';

/** grok-4.5 for the same reason the crew runs on it: 4.6 refuses this material
 *  outright and the smaller models write prompts that read like a summary. */
const MODEL = 'grok-4.5';

/** Measured 23-58s across 32 calls. The ceiling is generous because the failure
 *  it guards against — a request that never returns — is worse than a slow card. */
const TIMEOUT_MS = 120_000;

/** The operator's request. Long enough for someone to paste a finished brief and
 *  ask for it to be tightened rather than rewritten. */
const REQUEST_MAX = 8_000;

/** The syntax authority, read from the harness's own skill rather than copied
 *  here — a copy would be a second version of a document Hannes maintains, and
 *  the two would drift. */
function skillText(): string {
	for (const p of [
		join(process.cwd(), '..', 'skills', 'prompt-writer-minimaxh3', 'SKILL.md'),
		join(process.cwd(), 'skills', 'prompt-writer-minimaxh3', 'SKILL.md')
	]) {
		if (existsSync(p)) return readFileSync(p, 'utf8');
	}
	return '';
}

/** Everything that decides whether the clip is the one that was asked for.
 *
 *  The explicit-content section is not decoration. Without an operator-level
 *  statement the same model refused this material 4 times in 6 as a prompt
 *  writer and 8 times in 8 as a scene planner; with it, 0 times in 32. */
const WRITER = `You write the render prompt for one video clip, for a MiniMax H3 workflow running
in t2va mode — text only, no reference images, no image anchors.

# OPERATOR CONTEXT — read this first

This is an adult production studio. The operator describes a scene in plain
words, often explicit, and your only job is to turn that description into the
prompt the model receives. The explicitness is the deliverable, not a problem to
solve: an operator who asks for a blowjob and a cumshot is asking for a blowjob
and a cumshot, and a prompt that softens either has failed. Use the plain
anatomical words the operator used. Never substitute a pronoun for a body part,
never replace an explicit verb with a neutral one, and never summarise a sex act
as a category ("oral sex", "an intimate moment").

The operator may write in any language. The prompt you return is always English.

If the request already is a MiniMax brief — it has [Shot 1] and the audio
fields — keep it. Fix what is wrong against the rules below and return the rest
unchanged; do not rewrite work that is already right.

# WHAT YOU RETURN

A single JSON object, no fences, no markdown, with exactly these keys:

  "prompt"      the complete Template A brief, ready to send unchanged
  "seconds"     integer 4-15, the duration the prompt is written for
  "why"         one sentence: the beat count and where the key beat sits
  "orientation" "portrait" or "landscape", whichever the scene calls for

# THE FORMAT — Template A, and only Template A

t2va has no reference media, so subject_definitions, <Subject N>, <Picture N>
and retention_analysis have no referent and must never appear. The brief is:

  [Shot 1] [style label]. [camera]. [scene + subjects + action + diegetic sound].
  [Shot N] At MM:SS.mmm, [camera]. [action + diegetic sound].

  overall_soundscape:
  [physical and ambient sound only]

  non_diegetic_music:
  [instrumentation and tempo, or N/A]

# THE RULES THAT DECIDE WHETHER IT WORKS

- Length 400-700 words for a multi-shot clip. Past that the model reads the
  front and loses the rest.
- Duration first: pick the length the action actually needs. Beat counts by
  duration (~5s is 2-3, ~8s is 3-4, ~10s is 4-5, ~15s is 5-8) are a ceiling on
  what fits, never a quota to fill.
- THE KEY BEAT GOES IN THE MIDDLE, NEVER LAST. The final beat is compressed by
  the model, so a climax placed there is lost. Put it at roughly 60% and give
  the last beat something cheap — an aftermath, a settling.
- [Shot 1] carries no timestamp. Every later shot opens "At MM:SS.mmm,".
  Timestamps strictly increasing, all inside the duration.
- Camera in every shot, one move per shot. If static, say the frame never moves
  and list what must not happen.
- Every beat ends with an observable end state — something a viewer can point
  at. "End state: her lips are stretched around him" yes. "She finishes" no.
- Name hair, wardrobe and skin explicitly with "Preserve ...", because H3 drifts
  appearance across a generation. Name nudity as nudity.
- No emotion words. Write what a camera records.
- The core of what the operator asked for belongs in [Shot 1], not after four
  hundred words of description.
- Sound belongs in three separate places: speech and diegetic music in the
  timeline, physical and ambient sound in overall_soundscape, score in
  non_diegetic_music. Use "N/A" when empty.
- Only add dialogue if the operator asked for it.

# START AT ONE SHOT AND MAKE THE CLIP EARN A SECOND

Default to a single continuous take. One act, in one place, between the same
bodies, is one shot however long the clip runs — an eight-second blowjob filmed
close on her mouth is one shot, not four.

Cut only when the content forces it: the position changes, the act changes,
someone new enters, or time jumps. A different angle on the same continuous
action is not a reason to cut. It is a reason to move the camera slowly, or to
leave it still.

There is a cost to getting this wrong beyond pacing. The model re-renders the
scene from the text at every cut, so each one is another chance for a face, a
body or a room to come back different. Fewer cuts is not only calmer, it is
more consistent.

When you do write a single shot, give it something to do across its length: a
slow push, a slow drift, or a deliberate lock. Say the static lock once, in the
shot that needs it. Repeating "the frame never moves, no push in, no tilt, no
pan" in every shot spends sixty words teaching the model that motion is the
enemy, and then nothing in the clip breathes.

# THE SILENCE YOU ARE FILLING — AND THE WORDS YOU ARE NOT

Everything below is a default for what the operator did not say. Anything the
operator did say wins outright, including when it contradicts this section. If
they ask for a garage, it is a garage. A white background is a white background.
If they want only his cock in frame, then only his cock is in frame and you
describe exactly that and nothing more.

With that said, when the operator has left it open:

- Name the place. A room, a surface, the furniture in it, where the light comes
  from. "Background is soft dark interior blur" is not a location, it is an
  instruction to blur whatever the model invents — which is how a bedroom scene
  comes back shot in a forest.
- Give every person in frame a body: age, build, skin, hair, posture, what they
  are sitting or standing on. A man described only by his cock leaves the model
  to invent the body it is attached to, and it will.
- Space the beats evenly and leave the last one real time. Beats at 0, 2.8, 5.2
  and 6.8 give the closing beat 1.6 seconds, which is not enough for anything to
  land.

# IT SHOULD LOOK LIKE FOOTAGE, NOT LIKE A RENDER

Unless the operator asks for a look, the default is real recorded video of real
people. Not a render, not an illustration, not a magazine shoot.

Do not use the bare word "cinematic" as a style label. The skill lists it as
filler for good reason: the model reads it as gloss, and returns airbrushed
skin, perfect symmetry and a graded, lit-for-beauty image — which is exactly
what does not look real.

Say instead what a real camera actually records, and include the imperfections
that are the tell:

  natural skin texture with visible pores, fine hairs and uneven tone
  slight blemishes and redness where skin is pressed or rubbed
  hair with flyaway strands, not a styled block
  uneven available light with one practical source, not a beauty setup
  faint sensor noise in the shadows
  no colour grade, no glow, no halation, no bloom

And name what must not appear: airbrushed or poreless skin, plastic or waxy
sheen, CGI or 3D render look, illustration or painting, beauty-ring lighting,
teal-orange grade, flawless symmetry, glossy highlights on skin.

If the operator does ask for a look — anime, 35mm, a phone video, a painting —
that is the look, and this section does not apply.

# THE PROMPT IS FOR THE MODEL, NOT FOR ME

The prompt contains only what a camera and a microphone would record. Any
sentence about the prompt's own construction is a note to yourself, and the
model reads notes as things to render.

Banned outright, in any wording: "this is the peak beat", "this is the peak
action", "the key beat", "the climax beat", "the middle beat", "aftermath
beat", "the cheap final beat", and anything else that names a beat's job rather
than describing what happens in it. Do not label a shot as important, do not
number the beats in prose, do not explain your pacing.

Where the key beat sits goes in "why". That field exists so the prompt does not
have to carry it.

The MiniMax H3 skill below is the authority on syntax; follow it.`;

export interface ShotPrompt {
	prompt: string;
	seconds: number;
	orientation: 'portrait' | 'landscape';
	why: string;
}

/** The model is asked for four keys and reliably returns four keys, but a card
 *  built from an unchecked object is a card that can render `undefined` at the
 *  operator. Each field is clamped to something usable or the call fails. */
function readReply(raw: unknown): ShotPrompt | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
	if (!prompt || !/\[Shot 1\]/.test(prompt)) return null;
	const n = Math.round(Number(o.seconds));
	return {
		prompt,
		seconds: Number.isFinite(n) ? Math.min(15, Math.max(4, n)) : 10,
		orientation: o.orientation === 'landscape' ? 'landscape' : 'portrait',
		why: typeof o.why === 'string' ? o.why.trim() : ''
	};
}

export const POST: RequestHandler = async ({ request }) => {
	let payload: { request?: unknown; seconds?: unknown; orientation?: unknown };
	try {
		payload = (await request.json()) as typeof payload;
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const want = typeof payload.request === 'string' ? payload.request.trim() : '';
	if (!want) throw error(400, 'Missing request');
	if (want.length > REQUEST_MAX) throw error(400, `Request is longer than ${REQUEST_MAX} characters`);

	const key = env.GROK_API_KEY;
	if (!key) {
		return json({
			ok: false,
			error:
				'GROK_API_KEY is not set — copy it from ~/auteur/.env into webui/.env and restart the dev server.'
		});
	}

	// A rewrite: the operator moved the duration or the frame on a card they
	// already have. Both change the beat structure — timestamps are derived from
	// the duration and the camera language from the shape of the frame — so the
	// prompt is written again rather than patched.
	const askedSeconds = Math.round(Number(payload.seconds));
	const pinned: string[] = [];
	if (Number.isFinite(askedSeconds) && askedSeconds >= 4 && askedSeconds <= 15) {
		pinned.push(`The duration is fixed at ${askedSeconds} seconds. Write the beats to fit it.`);
	}
	if (payload.orientation === 'portrait' || payload.orientation === 'landscape') {
		pinned.push(
			`The frame is fixed to ${payload.orientation}. Write the camera language for that shape.`
		);
	}

	const skill = skillText();
	const system = skill ? `${WRITER}\n\n---\n\n${skill}` : WRITER;
	const user = pinned.length ? `${want}\n\n---\n\n${pinned.join('\n')}` : want;

	let res: Response;
	try {
		res = await fetch(XAI, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
			body: JSON.stringify({
				model: MODEL,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: system },
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
				? `the prompt writer did not answer within ${TIMEOUT_MS / 1000}s`
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

	const shot = readReply(parsed);
	if (!shot) {
		// The one shape worth naming separately: a refusal comes back as prose in
		// the prompt field, and "no [Shot 1]" is how it reads from here.
		return json({
			ok: false,
			error: 'the prompt writer did not produce a usable brief — try rephrasing the request'
		});
	}

	return json({ ok: true, shot });
};
