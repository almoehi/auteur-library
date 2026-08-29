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
import { readOverrides } from '../../overrides.server';
import { MODEL_API_NAME, modelFor, textFor } from '../../tunables';
import { MAX_PICKS, catalogueForWriter, loraFor, type Pick } from '../../loras';
import { checkRequest } from '../../minors.server';
import { xaiPost } from '../../xai.server';


/** grok-4.5 for the same reason the crew runs on it: 4.6 refuses this material
 *  outright and the smaller models write prompts that read like a summary. The
 *  panel can override it. */
const MODEL_FALLBACK = 'grok-4.5';

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

/** The writer's instructions now live in the tunables registry, next to every
 *  other prompt in this app and editable from the admin panel. It was the one
 *  prompt a person could not reach, and the only one that decides what a
 *  simple-mode clip looks like — an odd thing to have kept in the source. */

export interface ShotPrompt {
	prompt: string;
	seconds: number;
	orientation: 'portrait' | 'landscape';
	why: string;
	/** The adapters this shot asked for, on top of the pair every clip loads. */
	loras: Pick[];
}

/** Keep only what the catalogue actually contains, and only as much of it as a
 *  render should carry.
 *
 *  A model choosing from a list will occasionally name something that is not on
 *  it, and an adapter that does not exist is a bundle the harness cannot build
 *  — so unknown keys are dropped here rather than at the far end of a launch.
 *  The same goes for the act rule: the list says choose one, and if two come
 *  back the first is kept rather than the request being failed, because a clip
 *  rendered with one act is a clip and an error is not.
 */
function readLoras(raw: unknown): Pick[] {
	if (!Array.isArray(raw)) return [];
	const out: Pick[] = [];
	let act = false;
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const { key, strength } = item as { key?: unknown; strength?: unknown };
		if (typeof key !== 'string') continue;
		const lora = loraFor(key);
		if (!lora || lora.kind === 'base') continue;
		if (out.some((p) => p.key === key)) continue;
		if (lora.kind === 'act') {
			if (act) continue;
			act = true;
		}
		// Clamped to the author's published range, or pinned to their number where
		// they published none. The writer is allowed to place a strength; it is not
		// allowed to leave the ground the author actually stood on.
		const n = Number(strength);
		let value = lora.strength;
		if (lora.band && Number.isFinite(n)) {
			value = Math.min(lora.band[1], Math.max(lora.band[0], n));
		}
		out.push({ key, strength: Math.round(value * 100) / 100 });
		if (out.length >= MAX_PICKS) break;
	}
	return out;
}

/** The model is asked for four keys and reliably returns four keys, but a card
 *  built from an unchecked object is a card that can render `undefined` at the
 *  operator. Each field is clamped to something usable or the call fails. */
function readReply(raw: unknown): ShotPrompt | null {
	if (!raw || typeof raw !== 'object') return null;
	const o = raw as Record<string, unknown>;
	const prompt = typeof o.prompt === 'string' ? o.prompt.trim() : '';
	// [Shot 1] appears in both templates — in Template B it opens the
	// detailed_description rather than the whole brief — so this stays the test
	// for "the writer produced a brief rather than a refusal".
	if (!prompt || !/\[Shot 1\]/.test(prompt)) return null;
	const n = Math.round(Number(o.seconds));
	return {
		prompt,
		seconds: Number.isFinite(n) ? Math.min(15, Math.max(4, n)) : 10,
		orientation: o.orientation === 'landscape' ? 'landscape' : 'portrait',
		why: typeof o.why === 'string' ? o.why.trim() : '',
		loras: readLoras(o.loras)
	};
}

export const POST: RequestHandler = async ({ request }) => {
	let payload: {
		request?: unknown;
		seconds?: unknown;
		orientation?: unknown;
		character?: unknown;
		voice?: unknown;
		location?: unknown;
		/** Set when this clip continues another one. Carries what the prior clip
		 *  was rendered from, so the seam inherits rather than restarts. */
		continues?: unknown;
	};
	try {
		payload = (await request.json()) as typeof payload;
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const want = typeof payload.request === 'string' ? payload.request.trim() : '';
	if (!want) throw error(400, 'Missing request');
	if (want.length > REQUEST_MAX) throw error(400, `Request is longer than ${REQUEST_MAX} characters`);

	// The same gate the sheet writer has. A clip prompt is not checked on the way
	// out the way a sheet description is — it is a scene rather than a subject and
	// carries no single age to test — but nothing that names a minor gets as far
	// as the writer.
	const gate = checkRequest(want);
	if (gate.refuse) return json({ ok: false, error: gate.refuse });

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
	// The one thing that changes which template the writer uses. Named rather than
	// flagged, because the brief reads better when it can say who <Picture 1> is.
	// The numbering is computed here rather than assumed, because it depends on
	// what is attached: a clip with a location but no character has the location
	// at <Picture 1>. compose.ts stages them in this same order and names them the
	// same way in the task, so the brief and the graph agree.
	const character = typeof payload.character === 'string' ? payload.character.trim() : '';
	const location = typeof payload.location === 'string' ? payload.location.trim() : '';
	// The kept character's voice, when they have one. Pinned rather than left to
	// the writer's own invention: the writer is told to name a voice on every
	// clip, and this is the sentence it must name when the person is somebody the
	// operator has already heard. Verbatim, because a paraphrase is a different
	// woman — the model reads the words, not a recording.
	const voice = typeof payload.voice === 'string' ? payload.voice.trim().slice(0, 240) : '';
	if (voice) {
		pinned.push(
			`The voice is already decided for this person and is not yours to change. ` +
				`Put this sentence in the soundscape, word for word: "${voice.replace(/"/g, "'")}"`
		);
	}
	const attached: string[] = [];
	if (character) attached.push(`the character ${character}`);
	if (location) attached.push(`the location ${location}`);
	if (attached.length) {
		const list = attached.map((a, i) => `<Picture ${i + 1}> is ${a}`).join(', and ');
		pinned.push(
			`${list}. Use Template B and treat what those pictures show as settled — ` +
				`see WHEN A REFERENCE IS ATTACHED.`
		);
	}

	// A continuation is a different brief with a different shape, so it gets a
	// different writer — but the same gate, the same catalogue and the same
	// plumbing, because everything except the instructions is identical.
	const cont = (payload.continues ?? null) as
		| { priorPrompt?: string; priorLoras?: Pick[]; pinned?: boolean; platesFromClip?: boolean }
		| null;
	const writerId = cont ? 'continuation_writer' : 'shot_writer';
	if (cont) {
		// The two pictures are fixed by the workflow's own wiring here, unlike a
		// clip where the numbering depends on what was attached: the continuation
		// graph binds the character to ref_image_0 and the location to ref_image_1
		// whatever else is passed.
		pinned.length = 0;
		// Re-pinned after the reset above, which exists to drop the clip-shaped
		// picture numbering. The voice is not picture numbering: a continuation is
		// the one place where a changed voice is most audible, because the two
		// clips are meant to play as one unbroken stretch.
		if (voice) {
			pinned.push(
				`The voice is already decided for this person and is not yours to change. ` +
					`Put this sentence in the soundscape, word for word: "${voice.replace(/"/g, "'")}"`
			);
		}
		if (Number.isFinite(askedSeconds) && askedSeconds >= 4 && askedSeconds <= 15) {
			pinned.push(`The target duration is ${askedSeconds} seconds.`);
		}
		// What the two plates actually are. Without this the writer assumes a
		// character sheet — a person on a grey backdrop — and writes the retention
		// rule that goes with one: identity kept, backdrop discarded. Handed a
		// frame of the scene instead, that instruction throws away the room the
		// continuation is supposed to stay in.
		const platePreamble = cont.platesFromClip
			? ` <Picture 1> and <Picture 2> are FRAMES TAKEN FROM <Video 1> itself, not reference sheets:` +
				` <Picture 1> shows the person mid-clip and <Picture 2> shows the setting.` +
				` Retain both fully — the person's identity AND the room, the materials, the light.` +
				` There is no backdrop to discard, because these are the scene.`
			: '';
		pinned.push(
			`<Video 1> is the clip being continued.` +
				platePreamble +
				(character ? ` <Picture 1> is the character ${character}.` : '') +
				(location ? ` <Picture 2> is the location ${location}.` : '') +
				(cont.pinned === false
					? ` There is NO <Picture 3> — do not mention one. The seam is carried by <Video 1> alone,` +
						` so inherit the camera, the light and the person from it, but the action may start` +
						` somewhere other than exactly where the last frame left it.` +
						// The template above this is written for a pinned seam and mandates the
						// sentence "resumes from its final frame at the 0.00-second mark with no
						// cut", plus "the motion already underway". Left standing, those beat the
						// permission just granted — which is how an operator who asked for a
						// change of position got the previous position continued instead, on a
						// free start. The replacement is given literally, because a format rule
						// is only overridden by another format rule.
						` OVERRIDE THE OPENING LINE OF THE TEMPLATE: instead of saying the target` +
						` resumes from the final frame with no cut, write that <Video 1> supplies the` +
						` scene, the people and the light immediately before the target, and that the` +
						` target begins a NEW configuration in the same scene. Do NOT write that the` +
						` motion is already underway, and do NOT write that there is no cut. The` +
						` operator asked for a free start precisely because what they want next is` +
						` not a continuation of the pose on screen.`
					: ` <Picture 3> is the exact final frame of <Video 1> — the frame the new clip starts from.`)
		);
		if (typeof cont.priorPrompt === 'string' && cont.priorPrompt.trim()) {
			pinned.push(
				`The brief the prior clip was rendered from follows. Continue from where it ` +
					`ends; do not restate it.\n\n${cont.priorPrompt.trim().slice(0, 6000)}`
			);
		}
		if (Array.isArray(cont.priorLoras) && cont.priorLoras.length) {
			pinned.push(
				`The prior clip ran with these adapters: ` +
					cont.priorLoras.map((p) => `${p.key} ${p.strength}`).join(', ') +
					`. Keep them unless the action has changed.`
			);
		}
	}

	// Read per call, so an edit in the admin panel takes effect on the next
	// message rather than on the next dev-server restart.
	const overrides = readOverrides();
	const writer = textFor(writerId, overrides);
	const model = MODEL_API_NAME[modelFor(writerId, overrides)] ?? MODEL_FALLBACK;

	const skill = skillText();
	// The catalogue goes in last, after the syntax guide, because it is the part
	// that changes: adapters are added and dropped as they are found, and the
	// block is generated from the list rather than written into the tunable so
	// the two can never disagree about what exists.
	const parts = [writer, skill, catalogueForWriter()].filter(Boolean);
	const system = parts.join('\n\n---\n\n');
	const user = pinned.length ? `${want}\n\n---\n\n${pinned.join('\n')}` : want;

	let res: Response;
	try {
		res = await xaiPost({
				model,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: system },
					{ role: 'user', content: user }
				]
			}, key, TIMEOUT_MS);
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

	// The pins are settings, not suggestions.
	//
	// They are given to the writer as sentences, and a sentence is guidance: the
	// duration that comes back is whatever number the model put in its JSON, and
	// when it puts none the parser falls back to ten. So a card pinned to five
	// seconds could still return ten, and did — a continuation nobody had asked
	// to be twice as long, discovered after a sixteen-minute render.
	//
	// The writer still needs the sentence, because the beats have to be written
	// to fit the duration. But what the render is launched with is decided here.
	if (Number.isFinite(askedSeconds) && askedSeconds >= 4 && askedSeconds <= 15) {
		shot.seconds = askedSeconds;
	}
	if (payload.orientation === 'portrait' || payload.orientation === 'landscape') {
		shot.orientation = payload.orientation;
	}

	return json({ ok: true, shot });
};
