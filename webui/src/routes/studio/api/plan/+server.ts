/** Planning endpoint: one sentence in, a full Brief out — and, since
 *  the studio went chat-first, one round of feedback in, a revised Brief out.
 *
 *  The studio's landing is a chat. The first message ("a raccoon detective
 *  loses the princess") becomes a fresh Brief; every later "make it darker" /
 *  "rename the raccoon" message sends the prior Brief back here with the
 *  feedback, and the model revises it in place. A production needs rather more
 *  than a one-liner: prose long enough for a screenwriter agent to adapt, and
 *  a style anchor every render prompt downstream inherits. This route is the
 *  step between the two — it calls a model and hands back a Brief the user can
 *  read (and keep talking about) before anything is launched.
 *
 *  Nothing here touches the harness. Planning is cheap and repeatable; opening
 *  a workspace is neither (an id can only be opened once), so the two are
 *  separate routes on purpose — you can re-plan and revise as many times as
 *  you like without burning a slug. For the same reason EVERY response — fresh
 *  or revised — carries a freshly suffixed slug: a revised plan will open a
 *  new workspace, and reopening an already-used id is a silent no-op that
 *  re-runs nothing.
 *
 *  Like every route here it is unauthenticated — this app is a local operator
 *  tool. See the README: bind it to localhost, never expose it.
 *
 *  REQUIRES `GROK_API_KEY` in this app's own environment. The harness reads it
 *  from ~/auteur/.env, but that file is the container's, not ours, and we never
 *  read it from disk at runtime. Copy the value into webui/.env (or export it
 *  before `pnpm dev`); without it this route answers with a plain error telling
 *  you so.
 */
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SCENE_COUNT_MAX, SCENE_COUNT_MIN, type Brief } from '../../types';
import { MODEL_API_NAME, modelFor, textFor } from '../../tunables';
import { readOverrides } from '../../overrides.server';

/** Ollama Cloud — the same provider the workspace's own model registry points
 *  at (see spec.models in the composed workspace), so if a production can run
 *  at all, this key works. */
const XAI = 'https://api.x.ai/v1/chat/completions';

/** Cheapest of the four cloud models the harness registers, and verified
 *  working on this account. Planning is a two-paragraph job; it does not need
 *  the reasoning models the screenwriter uses. */
/** Resolved per request from the tuning panel, like the workspace agents are.
 *  The panel speaks in registry ids; xAI needs its own name for the model. */
function modelName(o: ReturnType<typeof readOverrides>): string {
	const id = modelFor('brief_writer', o);
	return MODEL_API_NAME[id] ?? 'grok-4.5';
}

/** A chat message is the point of this surface. Anything past this is someone
 *  pasting a document into the wrong box — cut it off rather than paying to
 *  send it. Applied to the pitch and to feedback alike. */
const MAX_INPUT = 2000;

/** Renders are batched 4 at a time and each batch is ~10 minutes, so the scene
 *  count is the single biggest lever on how long a run takes. The bounds are
 *  imported rather than restated: compose.ts rejects a Brief outside them, so a
 *  local copy that drifted would hand the user a plan that cannot be launched. */
const DEFAULT_SCENES = 4;

/** Generation is slow-ish but not minutes-slow; a hang here means the provider
 *  is wedged, and the user is sitting in front of a silent chat waiting. */
/** Measured twice on the real prompt: 40s and 72s for the same kind of request.
 *  That spread is the provider's, not ours, and it is the number that matters —
 *  a limit set near the fast case fires on the slow one, and the user loses a
 *  working brief to a stopwatch.
 *
 *  150s is therefore generous on purpose. It is not a guess at how long this
 *  takes; it is the point past which the provider is wedged rather than busy,
 *  and waiting has stopped being useful. */
const TIMEOUT_MS = 150_000;

/** A synopsis and a story parse identically — both are a JSON string. The only
 *  cheap way to tell them apart is length, and a screenwriter agent handed four
 *  bullet points produces four scenes of nothing. The contract asks for
 *  200-500 words; this floor is well under that, so it rejects "a raccoon
 *  looks for a princess and finds her" without being precious about a model
 *  that came in a little short. */
const MIN_STORY_WORDS = 120;

/** The JSON contract, shared verbatim by the fresh and the revise prompts so
 *  the two paths can never drift apart on what a valid answer looks like. */
/** The shape of the answer, and the craft rules that make the answer usable.
 *
 *  Not editable in the panel: this is the wire format plus the constraints the
 *  rest of the pipeline physically imposes — a clip is 5-15 seconds whatever the
 *  prompt says, and the render generates audio whether or not anyone wrote any.
 *  Taste lives in the register; this is what the machine needs to be true.
 *
 *  Takes the scene count because the story has to survive being cut into exactly
 *  that many pieces. Told to write "3 to 6 places" while the user asked for two
 *  scenes, the model wrote six locations and the scheduler then threw four away.
 */
function jsonContract(sceneCount: number): string {
	return `Answer with a single JSON object and nothing else. No prose before or after it, no markdown code fences. The object has exactly these keys:

"title": 2-5 words. The name of the film.

"register": 3-5 words naming the register you chose for this film, the ones you actually wrote in. Not a description of the plot and not praise — the voice. "cold, transactional, unspoken". "warm, teasing, unhurried". "hostile, precise, breathless". Whoever reads this should recognise the story from it.

"summary": 2-3 sentences, plain and concrete. What happens, to whom, where. This is the only part most people will read before deciding whether the plan is right, so it says what the film IS — not what it is about, not what it explores. No adjectives you would not use out loud.

"story": 200-500 words of PROSE. An actual short story, not a synopsis and not bullet points: a beginning, a turn, an ending, in full sentences and paragraphs.

  It will be filmed as exactly ${sceneCount} ${sceneCount === 1 ? 'scene' : 'scenes'}, and each scene becomes ONE clip of five to fifteen seconds. So write ${sceneCount} ${sceneCount === 1 ? 'moment' : 'moments'} that each fit in that much screen time — a held look, a crossing of a room, one exchange — and nothing that would need a minute to play. Everything that happens must be visible: a decision shows as an action, not as a thought.

  Name every character and describe how they look — face, build, hair, what they are wearing. Whoever draws them has only your words. Keep two or three named people at most; each one costs description in every shot they appear in.

  Their appearance must not change between scenes. No costume change, no different hair, no "later that night" wardrobe. The film is cut from separate renders, and anything that changes will look like a different person.

  Use as many places as the story actually needs, and no more. One room is a perfectly good film. Do not move people between locations to add variety — a story that stays in one place and lets something happen there is easier to shoot and easier to believe.

  Write what is heard as well as what is seen: the room's own sound, what the voices sound like, what is silent. The render produces audio, and if the story is quiet about it the sound is invented shot by shot with nothing to keep it consistent.

"style": ONE sentence. It must name a concrete visual medium as a noun, and then say how that medium is handled. Good: "2D digital comic book illustration with bold ink outlines and flat cel-shading". "Hand-painted watercolour storybook art with soft bleeding edges". "Stop-motion felt puppetry shot on a miniature set". The words "cinematic", "beautiful", "stunning", "high quality", "4k", "masterpiece" and every other empty praise word are FORBIDDEN — they describe nothing. Every single image in this film inherits this sentence verbatim, so it must describe a medium a person could actually work in.

ONE RULE ABOVE ALL OF THESE: the pitch wins. Everything above describes a good default, not a requirement to override what was actually asked for. If the pitch names a place, stay there. If it names a look, a length, a mood, a character — that is the instruction, and these notes bend around it. Never add locations, characters or events the pitch did not ask for merely because the guidance above mentions them.`;
}

/** The register matters as much as the format. This studio feeds an adult
 *  creator platform, so the default a general model reaches for — a whimsical
 *  children's fable — is wrong every single time, and the user then has to
 *  fight the brief back toward their actual audience. Naming the register up
 *  front costs nothing and saves a revision round on every production. The
 *  content bar stays where the platform's own does: sensual and suggestive,
 *  never explicit, and every character an adult. */
/** The register and the two role prompts moved to the tuning registry, where
 *  they can be edited without a deploy — a copy kept here could only ever drift
 *  from the one actually used. */
/** The retry's system prompt. Models that talk their way past a long
 *  instruction block will usually obey a short one, and what fails here is
 *  almost always the wrapper (a code fence, a "Here's your brief:" preamble),
 *  not the content — so the second attempt trades the detailed brief for
 *  format compliance rather than giving up and making the user retype their
 *  pitch. One retry only: past that it is a provider problem, and a third call
 *  just makes the user wait longer for the same error. */
const SYSTEM_TERSE = `Output one JSON object. No other text. No code fences.
{"title": "2-5 words", "register": "3-5 words naming the voice", "summary": "2-3 plain sentences: what happens, to whom, where", "story": "a 300-word short story in prose paragraphs, with named characters whose appearance is described and 3-6 described locations", "style": "one sentence naming a visual medium as a noun and how it is handled, e.g. 2D digital comic book illustration with bold ink outlines; never the words cinematic or high quality"}`;

/** Terse retry for the revise path — same format hammer, plus the one rule the
 *  revision cannot lose: only change what the feedback asks. */
const SYSTEM_TERSE_REVISE = `Output one JSON object. No other text. No code fences. Revise the given brief according to the feedback; change ONLY what the feedback asks and keep everything else as it is.
{"title": "2-5 words", "register": "3-5 words naming the voice", "summary": "2-3 plain sentences: what happens, to whom, where", "story": "a 300-word short story in prose paragraphs, with named characters whose appearance is described and 3-6 described locations", "style": "one sentence naming a visual medium as a noun and how it is handled; never the words cinematic or high quality"}`;

type Draft = { title: string; register: string; summary: string; story: string; style: string };

/** Models like to wrap. Strip fences, then take everything between the first
 *  `{` and the last `}` — that survives both a preamble and a trailing
 *  "Let me know if you'd like changes!". */
function extractJson(raw: string): Draft | null {
	const text = raw.replace(/```[a-z]*\n?/gi, '').trim();
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start === -1 || end <= start) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}

	const d = parsed as Partial<Draft> | null;
	if (!d || typeof d !== 'object') return null;
	const title = typeof d.title === 'string' ? d.title.trim() : '';
	const register = typeof d.register === 'string' ? d.register.trim() : '';
	const summary = typeof d.summary === 'string' ? d.summary.trim() : '';
	const story = typeof d.story === 'string' ? d.story.trim() : '';
	const style = typeof d.style === 'string' ? d.style.trim() : '';
	if (!title || !story || !style) return null;
	if (story.split(/\s+/).length < MIN_STORY_WORDS) return null;

	// A missing summary is not worth rejecting a good brief over — the card
	// falls back to the story's own opening, which is the same sentences anyway.
	return { title, register, summary, story, style };
}

async function ask(key: string, model: string, system: string, user: string): Promise<string> {
	const res = await fetch(XAI, {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			model,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user }
			],
			response_format: { type: 'json_object' },
			stream: false
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});

	const text = await res.text();
	// Never echo the request back on failure — the Authorization header is not
	// in the body, but a helpful error that dumps "what we sent" is exactly how
	// keys end up in a terminal scrollback. Status and the provider's own words
	// are enough to tell a 401 from a rate limit.
	if (!res.ok) throw new Error(`grok ${res.status}: ${text.slice(0, 200)}`);

	const body = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
	return body.choices?.[0]?.message?.content ?? '';
}

/** kebab-case, ASCII only: the slug becomes `<slug>@1.0` in a URL path, and the
 *  harness's id grammar is narrower than a title is. Accents are folded rather
 *  than dropped so "Éjszakai Őrjárat" stays readable as `ejszakai-orjarat`. */
function slugify(title: string): string {
	const base = title
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32)
		.replace(/-+$/, '');
	// A title in a script that folds to nothing (Cyrillic, CJK) would otherwise
	// leave the id as a bare suffix. Give it a word to hang on.
	return base || 'film';
}

/** Opening a workspace id that already exists is a silent no-op — it does not
 *  re-run anything — so two productions must never collide. Time gives
 *  ordering, randomness covers the same-millisecond case. This is also why a
 *  REVISED plan gets a fresh suffix rather than keeping the prior slug: the
 *  revised production has to open under an id nothing has opened before. */
function uniqueSuffix(): string {
	const stamp = Date.now().toString(36).slice(-5);
	const salt = Math.random().toString(36).slice(2, 6);
	return `${stamp}${salt}`;
}

/** The seed is pinned per production so every render in it shares a look.
 *  Deriving it from the slug (FNV-1a, 32-bit) instead of taking a random number
 *  means the id and the look travel together: re-opening the same slug — or
 *  reading it back out of a YAML — gives the same seed, which is what you want
 *  when a run has to be reproduced. */
function seedFrom(slug: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < slug.length; i++) {
		h ^= slug.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	// Comfy wants a non-negative int; keep it inside 31 bits.
	return (h >>> 0) % 2_147_483_647;
}

function clampScenes(n: unknown, fallback: number): number {
	if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
	return Math.min(SCENE_COUNT_MAX, Math.max(SCENE_COUNT_MIN, Math.round(n)));
}

/** Loose shape check on the prior Brief. The page sends back what this route
 *  produced, so a failure here is a caller bug — but a caller bug that reached
 *  the model would come back as a mangled revision, which is worse to debug
 *  than a 400. Slug and seed are not needed for revision (both are re-derived),
 *  so only the prose fields are demanded. */
function asPrior(v: unknown): Pick<Brief, 'title' | 'story' | 'style'> & { sceneCount?: number } | null {
	if (!v || typeof v !== 'object') return null;
	const p = v as Partial<Brief>;
	if (typeof p.title !== 'string' || !p.title.trim()) return null;
	if (typeof p.story !== 'string' || !p.story.trim()) return null;
	if (typeof p.style !== 'string' || !p.style.trim()) return null;
	return {
		title: p.title.trim(),
		story: p.story.trim(),
		style: p.style.trim(),
		sceneCount: typeof p.sceneCount === 'number' ? p.sceneCount : undefined
	};
}

export const POST: RequestHandler = async ({ request }) => {

	let payload: { prompt?: unknown; sceneCount?: unknown; prior?: unknown; feedback?: unknown };
	try {
		payload = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const pitch = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
	const feedback = typeof payload.feedback === 'string' ? payload.feedback.trim() : '';
	const prior = asPrior(payload.prior);

	// Two valid calls: a fresh plan (prompt, no prior) and a revision
	// (prior + feedback, prompt optional as context). Anything else is the page
	// holding the contract wrong.
	const revising = prior !== null && feedback !== '';
	if (!revising && !pitch) throw error(400, 'Missing prompt');
	if (prior !== null && !feedback) throw error(400, 'Missing feedback for revision');

	const overrides = readOverrides();

	const key = env.GROK_API_KEY;
	if (!key) {
		// Not an exception: it is the state of a machine where nobody has set
		// the variable yet, and the fix is one line. Say the line.
		return json({
			ok: false,
			error:
				'GROK_API_KEY is not set — copy it from ~/auteur/.env into webui/.env and restart the dev server.'
		});
	}

	// On revision the prior's own scene count is the natural default — the user
	// asked for a darker story, not a shorter film.
	const sceneCount = clampScenes(
		payload.sceneCount,
		revising ? clampScenes(prior?.sceneCount, DEFAULT_SCENES) : DEFAULT_SCENES
	);

	// Composed here rather than at module load: the register and the two role
	// prompts are editable in the tuning panel, and a brief written before an
	// edit and one written after should differ. The JSON contract is not
	// editable — it is the wire format, not a matter of taste.
	const register = textFor('brief_register', overrides);
	const role = textFor(revising ? 'brief_reviser' : 'brief_writer', overrides);
	const system = `${role}\n\n${register}\n\n${jsonContract(sceneCount)}`;
	const systemTerse = revising ? SYSTEM_TERSE_REVISE : SYSTEM_TERSE;
	const message = revising
		? [
				pitch ? `Original pitch: ${pitch.slice(0, MAX_INPUT)}` : '',
				`Current title: ${prior!.title}`,
				`Current style: ${prior!.style}`,
				`Current story:\n${prior!.story}`,
				'',
				`Feedback to apply:\n${feedback.slice(0, MAX_INPUT)}`
			]
				.filter(Boolean)
				.join('\n')
		: pitch.slice(0, MAX_INPUT);

	let draft: Draft | null;
	try {
		const model = modelName(overrides);
		draft = extractJson(await ask(key, model, system, message));
		if (!draft) draft = extractJson(await ask(key, model, systemTerse, message));
	} catch (e) {
		const detail = e instanceof Error ? e.message : String(e);
		return json({ ok: false, error: `planning failed — ${detail}` });
	}

	if (!draft) {
		return json({
			ok: false,
			error: 'The model did not return a usable brief (twice). Try rephrasing the pitch.'
		});
	}

	// Always a fresh slug — even when the title did not change. A revised plan
	// opens a NEW workspace, and reopening an old id is a silent no-op that
	// would leave the user watching a run that never starts.
	const slug = `${slugify(draft.title)}-${uniqueSuffix()}`;
	const brief: Brief = {
		slug,
		title: draft.title,
		register: draft.register || undefined,
		summary: draft.summary || undefined,
		story: draft.story,
		style: draft.style,
		sceneCount,
		seed: seedFrom(slug)
	};

	return json({ ok: true, brief });
};
