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
 *  REQUIRES `XAI_API_KEY` in this app's own environment. The harness reads it
 *  from ~/auteur/.env, but that file is the container's, not ours, and we never
 *  read it from disk at runtime. Copy the value into webui/.env (or export it
 *  before `pnpm dev`); without it this route answers with a plain error telling
 *  you so.
 */
import { env } from '$env/dynamic/private';
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SCENE_COUNT_MAX, SCENE_COUNT_MIN, type Brief } from '../../types';

/** xAI, through its OpenAI-compatible endpoint — the same provider the
 *  workspace's own model registry points at (see spec.models in the composed
 *  workspace), so if a production can run at all, this key works. */
const XAI = 'https://api.x.ai/v1/chat/completions';

/** Fastest of the four models the harness registers, and the only one that
 *  reliably fits the timeout below: measured 2.8s here against 7.2s for
 *  grok-4.5 and 70s for grok-4.6. Planning is a two-paragraph job; it does not
 *  need the reasoning model the planner uses. */
const MODEL = 'grok-4.20-0309-non-reasoning';

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
/** A healthy plan comes back in 5-7 seconds. Ninety was chosen for headroom,
 *  but it buys the wrong thing: when a model stalls — because it is refusing,
 *  looping, or the provider is degraded — the user sits in front of a page that
 *  says nothing for a minute and a half, twice over with the retry. Twenty-five
 *  is still four times a healthy call, and it turns a dead wait into a fast,
 *  legible failure. */
const TIMEOUT_MS = 25_000;

/** A synopsis and a story parse identically — both are a JSON string. The only
 *  cheap way to tell them apart is length, and a screenwriter agent handed four
 *  bullet points produces four scenes of nothing. The contract asks for
 *  200-500 words; this floor is well under that, so it rejects "a raccoon
 *  looks for a princess and finds her" without being precious about a model
 *  that came in a little short. */
const MIN_STORY_WORDS = 120;

/** The JSON contract, shared verbatim by the fresh and the revise prompts so
 *  the two paths can never drift apart on what a valid answer looks like. */
const JSON_CONTRACT = `Answer with a single JSON object and nothing else. No prose before or after it, no markdown code fences. The object has exactly these keys:

"title": 2-5 words. The name of the film.

"story": 200-500 words of PROSE. An actual short story, not a synopsis and not bullet points: it has a beginning, a turn, and an ending, and it is written in full sentences and paragraphs. Name your characters and describe how they look, because an artist has only your words to draw from. Move the story through 3 to 6 distinct physical places and describe each one. Write it as a story someone would read aloud.

"style": ONE sentence. It must name a concrete visual medium as a noun, and then say how that medium is handled. Good: "2D digital comic book illustration with bold ink outlines and flat cel-shading". "Hand-painted watercolour storybook art with soft bleeding edges". "Stop-motion felt puppetry shot on a miniature set". The words "cinematic", "beautiful", "stunning", "high quality", "4k", "masterpiece" and every other empty praise word are FORBIDDEN — they describe nothing. Every single image in this film inherits this sentence verbatim, so it must describe a medium a person could actually work in.`;

/** The register matters as much as the format. This studio feeds an adult
 *  creator platform, so the default a general model reaches for — a whimsical
 *  children's fable — is wrong every single time, and the user then has to
 *  fight the brief back toward their actual audience. Naming the register up
 *  front costs nothing and saves a revision round on every production. The
 *  content bar stays where the platform's own does: sensual and suggestive,
 *  never explicit, and every character an adult. */
const REGISTER = `This brief is for an adult creator platform. Write for grown-ups: the register is sensual, flirtatious, charged, confident. Tension, longing, power play and seduction are the material you work with.

Hard rules you never break:
- Every character is an unmistakably adult. Never write a character who is, looks, or is described as a minor, and never place characters in school or childhood settings.
- Suggestive, not explicit. You write the charge and the anticipation — the glance, the pause, the line that lands. You do not write graphic sexual acts or anatomical description.
- No violence or coercion as titillation. Desire here is mutual and wanted.
- Do not default to a whimsical fable, a children's story, or talking animals unless the pitch explicitly asks for it.`;

const SYSTEM = `You are a development executive. You turn a one-line pitch into a production brief for a short film.

${REGISTER}

${JSON_CONTRACT}`;

/** The revise path's system prompt: same contract, but the model is holding an
 *  existing brief and one message of feedback. The instruction that matters is
 *  the conservative one — change only what the feedback asks for. A model told
 *  merely to "revise" will happily rewrite the whole story, and the user who
 *  asked to rename one character then has to re-read four paragraphs to find
 *  out what else moved. */
const SYSTEM_REVISE = `You are a development executive revising an existing production brief for a short film.

${REGISTER}

You are given the current brief (title, story, style) and the client's feedback on it. Apply the feedback and nothing else: change only what the feedback asks to change, and keep every part the feedback does not mention as close to the current brief as the requested change allows — same title unless asked, same character names unless asked, same style sentence unless asked.

${JSON_CONTRACT}`;

/** The retry's system prompt. Models that talk their way past a long
 *  instruction block will usually obey a short one, and what fails here is
 *  almost always the wrapper (a code fence, a "Here's your brief:" preamble),
 *  not the content — so the second attempt trades the detailed brief for
 *  format compliance rather than giving up and making the user retype their
 *  pitch. One retry only: past that it is a provider problem, and a third call
 *  just makes the user wait longer for the same error. */
const SYSTEM_TERSE = `Output one JSON object. No other text. No code fences.
{"title": "2-5 words", "story": "a 300-word short story in prose paragraphs, with named characters whose appearance is described and 3-6 described locations", "style": "one sentence naming a visual medium as a noun and how it is handled, e.g. 2D digital comic book illustration with bold ink outlines; never the words cinematic or high quality"}`;

/** Terse retry for the revise path — same format hammer, plus the one rule the
 *  revision cannot lose: only change what the feedback asks. */
const SYSTEM_TERSE_REVISE = `Output one JSON object. No other text. No code fences. Revise the given brief according to the feedback; change ONLY what the feedback asks and keep everything else as it is.
{"title": "2-5 words", "story": "a 300-word short story in prose paragraphs, with named characters whose appearance is described and 3-6 described locations", "style": "one sentence naming a visual medium as a noun and how it is handled; never the words cinematic or high quality"}`;

type Draft = { title: string; story: string; style: string };

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
	const story = typeof d.story === 'string' ? d.story.trim() : '';
	const style = typeof d.style === 'string' ? d.style.trim() : '';
	if (!title || !story || !style) return null;
	if (story.split(/\s+/).length < MIN_STORY_WORDS) return null;

	return { title, story, style };
}

async function ask(key: string, system: string, user: string): Promise<string> {
	const res = await fetch(XAI, {
		method: 'POST',
		headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: 'system', content: system },
				{ role: 'user', content: user }
			],
			// The provider guarantees parseable JSON, which the system prompts
			// ask for anyway. extractJson and the terse retry below stay as the
			// belt to this braces — they cost nothing when the first call works.
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
	if (!res.ok) throw new Error(`xai ${res.status}: ${text.slice(0, 200)}`);

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

	const key = env.XAI_API_KEY;
	if (!key) {
		// Not an exception: it is the state of a machine where nobody has set
		// the variable yet, and the fix is one line. Say the line.
		return json({
			ok: false,
			error:
				'XAI_API_KEY is not set — copy it from ~/auteur/.env into webui/.env and restart the dev server.'
		});
	}

	// On revision the prior's own scene count is the natural default — the user
	// asked for a darker story, not a shorter film.
	const sceneCount = clampScenes(
		payload.sceneCount,
		revising ? clampScenes(prior?.sceneCount, DEFAULT_SCENES) : DEFAULT_SCENES
	);

	const system = revising ? SYSTEM_REVISE : SYSTEM;
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
		draft = extractJson(await ask(key, system, message));
		if (!draft) draft = extractJson(await ask(key, systemTerse, message));
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
		story: draft.story,
		style: draft.style,
		sceneCount,
		seed: seedFrom(slug)
	};

	return json({ ok: true, brief });
};
