/** A subject's views, drawn by Grok instead of rendered on a GPU.
 *
 *  What a sheet is FOR is identity: the clip workflow gets one picture of the
 *  person or the place and holds them to it. Nothing about that requires the
 *  picture to come from the same model that makes the clip — the reference
 *  travels as a plain URL, and an uploaded photograph has always gone down the
 *  same road. Four characters were made from photographs today and their clips
 *  kept the face.
 *
 *  So the sheet is drawn by whatever draws quickest. Measured against the
 *  MiniMax path on Hannes's fleet:
 *
 *    six views, Krea2 through the harness    444s
 *    four views, Grok                         ~30s
 *
 *  Almost none of that 444 was drawing. Of the sheet's own ~170s, twelve
 *  seconds was sampling and the rest was ComfyUI starting and forty-five
 *  gigabytes of weights being read; a hosted image API pays none of it.
 *
 *  ── Why four and not six ──────────────────────────────────────────────────
 *
 *  The tiled sheet is scaled to a fixed 1440px wide whatever it holds, so the
 *  view count divides the resolution. Six across two rows gives each view 480px
 *  and a face about 130; four in a 2x2 gives 720 and a face about 200. The grid
 *  SHAPE is what matters, not the count — three in a row is also 480 — and 2x2
 *  is the only arrangement that buys anything.
 *
 *  The two that go are the two that were carrying least: the turnaround's back
 *  view holds no face at all, and its final frame catches the rotation
 *  overshooting, which is why the frame picker already trimmed 0.35s off the
 *  end. Four useful views beat four useful ones and two of noise.
 *
 *  ── Consistency comes from the reference, not the seed ────────────────────
 *
 *  Measured: the same prompt with the same `seed` twice returns two different
 *  images. The API accepts the field and ignores it, the way it accepts any
 *  field it does not know. What DOES hold a subject together is
 *  `/v1/images/edits`, which takes `image: { url }` and redraws from it. So the
 *  first view is generated and every later one is an edit of that first view.
 *  Break that chain and you get four different people.
 *
 *  ── Moderation ────────────────────────────────────────────────────────────
 *
 *  xAI refuses nude and explicit images outright — measured, without exception.
 *  It does not matter here: a sheet's job is identity, not the act, and the
 *  clip that uses it is rendered by MiniMax, which has no such limit. Every
 *  character made today was a clothed photograph and the clips were explicit.
 *
 *  What does matter is that the refusal is of the GENERATED image rather than
 *  the prompt, so it is stochastic: thirteen clothed, body-describing prompts
 *  produced twelve pictures and one refusal. Hence the retry.
 */
import { error } from '@sveltejs/kit';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from '$env/dynamic/private';
import { ffmpeg } from './ffmpeg.server';
import { putObject, s3FromEnv } from './s3presign.server';

const GEN = 'https://api.x.ai/v1/images/generations';
const EDIT = 'https://api.x.ai/v1/images/edits';
const TEXT = 'https://api.x.ai/v1/chat/completions';
const MODEL = 'grok-imagine-image';
/** Small and fast: this rewrites one sentence and nothing depends on its
 *  judgement — a failure falls back to the operator's own words. */
const TEXT_MODEL = 'grok-4.3';

/** One call runs about seven seconds; this is the ceiling for a wedged one. */
const CALL_TIMEOUT_MS = 90_000;
/** Moderation refuses roughly one clothed prompt in thirteen, and refuses the
 *  drawing rather than the asking — so the same prompt again usually passes. */
const MODERATION_TRIES = 3;

export type SubjectKind = 'character' | 'location';

/** The four views, in the order they are tiled: top-left, top-right, then the
 *  bottom pair.
 *
 *  A character's four all show the face, because the face is the thing the
 *  chain loses first. A place has no face, and its identity lives in materials
 *  and light rather than in composition — hence a surface close-up in the
 *  fourth slot rather than a fourth wide shot.
 *
 *  Interiors and exteriors are described differently for the reason the old
 *  location graph already knew: asked for walls, a farmyard gave back one angle
 *  six times. */
const VIEWS: Record<'character' | 'interior' | 'exterior', string[]> = {
	character: [
		'full-body front view, standing straight, facing the lens',
		'three-quarter view from their left, standing',
		'full profile side view, standing',
		'head and shoulders close-up, facing the lens'
	],
	interior: [
		'wide view of the main wall of the room, straight on',
		'wide view of the opposite wall, straight on',
		'wide view along one side wall, showing the depth of the room',
		'close-up of the floor and lower wall, showing the materials and their wear'
	],
	exterior: [
		'wide view of the front of the place, straight on',
		'three-quarter view from one side',
		'wider view from further back, showing the surroundings',
		'close-up of the ground and the nearest surface, showing the materials'
	]
};

/** Outdoors, by the description's own words.
 *
 *  Carried over from the sheet workflow's own list rather than asking a model:
 *  it is inspectable, it costs nothing, and when it guesses wrong the fix is to
 *  edit the description, which the operator can already do. Interior is the
 *  default, so a place that says nothing behaves as a room. */
const OUTDOOR =
	/\b(outdoor|outside|exterior|street|road|yard|farm|field|garden|beach|forest|wood|park|rooftop|roof|alley|car park|parking|courtyard|terrace|balcony|pool|lake|river|mountain|desert|barn|stable|driveway)\b/i;

function viewsFor(kind: SubjectKind, description: string): string[] {
	if (kind === 'character') return VIEWS.character;
	return OUTDOOR.test(description) ? VIEWS.exterior : VIEWS.interior;
}

/** The half of the prompt that is the same in every view. Grok draws people who
 *  look like stock photography unless told otherwise, and a stock portrait is a
 *  poor reference for a clip that has to look recorded. */
/** The operator's notes, rewritten as a casting sheet's line.
 *
 *  A sheet is a portrait of a person, so a clip can put them in a scene. The
 *  scene is where the explicit part lives and it renders on our own GPU, where
 *  nobody else has a say. The drawing service is a third party with its own
 *  policy, and asking it for a picture it will not make is not a filter to
 *  argue with — it is the wrong request, and the operator did not ask for that
 *  picture anyway: they were describing a character.
 *
 *  A word list was tried first and thrown away. Hungarian assimilates its
 *  suffixes — the stem `fasz` becomes `fasszal` — so a stem-plus-suffix pattern
 *  misses the very words it exists for, and a blocklist that half works is
 *  worse than none: it reads as protection and is not. A model that reads the
 *  sentence handles any language and any inflection.
 *
 *  Nothing is lost downstream. The description is stored whole and the clip
 *  receives every word of it; only the line handed to the drawing service is
 *  this one. And if the rewrite fails, the raw notes go through as before —
 *  the framing below is what does most of the work either way. */
async function castingLine(description: string, key: string): Promise<string> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), 20_000);
	try {
		const res = await fetch(TEXT, {
			method: 'POST',
			signal: ctl.signal,
			headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
			body: JSON.stringify({
				model: TEXT_MODEL,
				temperature: 0,
				messages: [
					{
						role: 'system',
						content:
							'You turn casting notes into one line for a CLOTHED casting portrait of an adult. ' +
							'Keep everything that identifies the person: apparent age, build, height, chest and ' +
							'waist, hair, face, skin, ethnicity, and what they are wearing. Drop anything that ' +
							'could only be shown nude, and any sexual act, position or fluid — those belong to ' +
							'the scene, not the portrait. If no clothing is mentioned, dress them in ordinary ' +
							'everyday clothes. Answer in English with the description only: no preamble, no ' +
							'quotes, one sentence, under 60 words.'
					},
					{ role: 'user', content: description }
				]
			})
		});
		if (!res.ok) return description;
		const data = (await res.json().catch(() => ({}))) as {
			choices?: { message?: { content?: string } }[];
		};
		const line = data.choices?.[0]?.message?.content?.trim();
		return line && line.length > 2 ? line : description;
	} catch {
		return description;
	} finally {
		clearTimeout(timer);
	}
}

function frame(kind: SubjectKind, description: string): string {
	// FULLY CLOTHED, said first and said plainly.
	//
	// The refusal is on the picture that comes back, not on the words going in,
	// so the thing that decides it is what the image would show. Without this
	// line a description that merely mentions a body — a build, a chest, a
	// waist — was read as an instruction to draw that body bare, and came back
	// refused. Said outright, the same description produces a dressed person,
	// which is what a casting sheet was always meant to be.
	return kind === 'character'
		? `Photoreal casting portrait photograph of ${description}. Fully clothed in ordinary everyday clothes, modest neckline, nothing revealing. Plain light grey studio backdrop, soft even lighting, neutral expression, sharp focus, natural skin texture with visible pores and freckles. No nudity. No text, no watermark, no border.`
		: `Photoreal photograph of ${description}. Natural light, no people in frame, sharp focus, realistic materials and wear. No text, no watermark, no border.`;
}

interface Drawn {
	url: string;
	bytes: Uint8Array;
}

async function xai(
	url: string,
	body: unknown,
	key: string
): Promise<{ url?: string; err?: string }> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), CALL_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: 'POST',
			signal: ctl.signal,
			headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
			body: JSON.stringify(body)
		});
		const data = (await res.json().catch(() => ({}))) as {
			data?: { url?: string }[];
			error?: string | { message?: string };
		};
		if (!res.ok) {
			const e = data.error;
			return {
				err: (typeof e === 'string' ? e : e?.message) || `the image API answered ${res.status}`
			};
		}
		const first = data.data?.[0]?.url;
		return first ? { url: first } : { err: 'the image API returned no picture' };
	} catch (e) {
		return {
			err:
				e instanceof Error && e.name === 'AbortError' ? 'the image API did not answer' : String(e)
		};
	} finally {
		clearTimeout(timer);
	}
}

/** Draw one view, retrying a moderation refusal.
 *
 *  Only a refusal is retried. Everything else — a bad key, a rate limit, a
 *  timeout — is answered the first time it is said, because trying again is
 *  three more minutes to hear it twice more. */
async function draw(body: unknown, url: string, key: string): Promise<Drawn> {
	let last = 'the picture could not be drawn';
	for (let i = 0; i < MODERATION_TRIES; i++) {
		const r = await xai(url, body, key);
		if (r.url) {
			const res = await fetch(r.url);
			if (!res.ok) throw error(502, 'the drawn picture could not be fetched back');
			return { url: r.url, bytes: new Uint8Array(await res.arrayBuffer()) };
		}
		last = r.err ?? last;
		if (!/moderation/i.test(last)) break;
	}
	// Said in this surface's own words, and said usefully.
	//
	// The provider's sentence — "Generated image rejected by content moderation"
	// — is true and useless: it does not say which of the two refusals this is.
	// A description that merely mentions a body is refused some of the time and
	// goes through on another attempt, which is what the loop above is for. One
	// that asks for an explicit picture is refused every time, and no number of
	// attempts changes it. The way past the second is a photograph: an uploaded
	// reference is kept as-is and never goes to the drawing endpoint at all.
	if (/moderation/i.test(last)) {
		throw error(
			502,
			'the picture service refused to draw this. Explicit descriptions are always refused — ' +
				'attach a photograph instead and describe only what it cannot show. Anything milder is ' +
				'worth sending again.'
		);
	}
	throw error(502, last);
}

/** Four pictures into one 1440-wide sheet, 2x2.
 *
 *  Same width and the same tiler the turnaround's grid used, so everything
 *  downstream — the picker, the clip's reference port, the stored bytes — sees
 *  exactly the shape it saw before. Only the number of tiles changed. */
async function tile(views: Uint8Array[]): Promise<Uint8Array> {
	const dir = mkdtempSync(join(tmpdir(), 'auteur-grok-'));
	try {
		const files = views.map((b, i) => {
			const f = join(dir, `v${i}.jpg`);
			writeFileSync(f, b);
			return f;
		});
		const out = join(dir, 'sheet.png');
		await ffmpeg([
			'-y',
			'-v',
			'error',
			...files.flatMap((f) => ['-i', f]),
			'-filter_complex',
			// Every view scaled to one tile size first: the edits come back at
			// whatever aspect the model chose, and hstack refuses inputs whose
			// heights differ rather than letterboxing them.
			'[0]scale=720:960:force_original_aspect_ratio=increase,crop=720:960[a];' +
				'[1]scale=720:960:force_original_aspect_ratio=increase,crop=720:960[b];' +
				'[2]scale=720:960:force_original_aspect_ratio=increase,crop=720:960[c];' +
				'[3]scale=720:960:force_original_aspect_ratio=increase,crop=720:960[d];' +
				'[a][b]hstack=2[t];[c][d]hstack=2[u];[t][u]vstack=2,scale=1440:-2',
			'-frames:v',
			'1',
			out
		]);
		const bytes = new Uint8Array(readFileSync(out));
		if (!(bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50)) {
			throw error(422, 'the tiled sheet is not a readable image');
		}
		return bytes;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export interface SubjectViews {
	/** The 2x2 sheet, ready to be stored as the subject's picture. */
	sheet: Uint8Array;
	/** The first view on its own — the same picture at full size, which is what
	 *  a preview should show rather than a quarter of a grid. */
	first: Uint8Array;
	elapsedSec: number;
}

/** Put a photograph somewhere the image API can fetch it.
 *
 *  `image: { url }` is fetched by xAI's servers, so a reference has to be
 *  reachable from the internet — our own bytes are not enough. It goes into the
 *  images bucket under a path of its own and comes back as a signed link, which
 *  is the same mechanism the GPU already reads references through.
 *
 *  Signed AFTER the upload, never before: the object store signs an object
 *  rather than a path, and asking it to sign an empty one answers "Object not
 *  found" — which is exactly how every preview failed this morning. */
async function publish(bytes: Uint8Array, ext: string): Promise<string> {
	// The one host-specific line in this file. ratemyd puts these in a Supabase
	// bucket scoped to the signed-in operator; here there is one operator and no
	// session, and the bucket is the same S3 one the GPU already reads reference
	// images out of — so the reachability argument is settled the same way, by
	// the same presigner. putObject uploads and hands back the readable URL in
	// one call, which is why nothing signs a path before it exists.
	const cfg = s3FromEnv();
	if (!cfg) {
		throw error(
			500,
			'S3 is not configured — xAI fetches the reference itself, so it has to be somewhere public'
		);
	}
	const key = `studio/subject-ref/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
	return await putObject(cfg, key, bytes);
}

/** Draw a subject's four views, 2x2.
 *
 *  With a photograph, that photograph IS the first view and the other three are
 *  edits of it — so the identity is anchored to something real and the angles
 *  are derived from it, rather than a likeness being described and redrawn.
 *  Without one, the first view is generated and serves the same purpose.
 *
 *  Either way the chain is what holds the subject together: every later view is
 *  an edit of view one. See the note above about the seed being ignored. */
export async function drawSubject(
	kind: SubjectKind,
	description: string,
	/** An uploaded photograph, kept as the first view. */
	photo?: { bytes: Uint8Array; ext: string }
): Promise<SubjectViews> {
	const key = (env.GROK_API_KEY ?? env.XAI_API_KEY ?? '').trim();
	if (!key) throw error(500, 'the image key is not configured');
	const desc = description.trim();
	if (!desc && !photo) throw error(400, 'a subject needs a description or a photograph');

	const started = Date.now();
	const angles = viewsFor(kind, desc);
	// The angles are chosen from the operator's own words — an outdoor location
	// reads as outdoor in the language it was typed in — so they are picked
	// before the line is rewritten, not after.
	//
	// Only a character is rewritten. A place has no clothes and nothing about a
	// room is refused, so putting a model in front of it would cost a second and
	// change nothing.
	const line = kind === 'character' && desc ? await castingLine(desc, key) : desc;
	const base = frame(kind, line || 'the subject in the reference image');

	// The first view: the operator's photograph where there is one, otherwise
	// drawn. Consistency lives entirely in this chain, so if this one fails there
	// is nothing to continue from.
	const first: Drawn = photo
		? { url: await publish(photo.bytes, photo.ext), bytes: photo.bytes }
		: await draw({ model: MODEL, prompt: `${base} ${angles[0]}.`, n: 1 }, GEN, key);

	const rest: Uint8Array[] = [];
	for (const angle of angles.slice(1)) {
		const d = await draw(
			{
				model: MODEL,
				prompt: `${angle} of the SAME ${kind === 'character' ? 'person' : 'place'} shown in the reference image — identical in every detail. ${base}`,
				image: { url: first.url },
				n: 1
			},
			EDIT,
			key
		);
		rest.push(d.bytes);
	}

	return {
		sheet: await tile([first.bytes, ...rest]),
		first: first.bytes,
		elapsedSec: Math.round((Date.now() - started) / 1000)
	};
}
