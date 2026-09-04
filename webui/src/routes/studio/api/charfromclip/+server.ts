/** Make a character out of the clip you are about to continue.
 *
 *  A continuation with no kept character does not fail — the launch cuts a frame
 *  out of the prior clip and sends that as the plate. It works, and it degrades:
 *  the plate is one frame of the previous generation's output, so whatever that
 *  render got wrong becomes the next one's truth. Measured in this project, a
 *  chain drifts to 44.5% where the sheet itself holds 29.6%.
 *
 *  The fix is a character that outlives the chain, and the material for one is
 *  already on disk: the clip has a few hundred frames of the person. This picks
 *  the frame they read most clearly in and keeps it as a character, so every
 *  later generation is measured against the same face rather than against
 *  whatever the last render drifted to.
 *
 *  It is offered rather than imposed. The continuation panel recommends it and
 *  sends without it if you would rather get on with the shot.
 */
import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';
import { cached } from '../../../clips.server';
import { frameAt } from '../../ffmpeg.server';
import { addSheet, listSheets, nameFromDescription } from '../../sheets.server';
import { checkRequest } from '../../minors.server';
import { xaiPost } from '../../xai.server';

/** Same shape api/sheet checks: a name and a version, nothing that could walk
 *  out of the library directory. */
const WORKSPACE_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

/** Where in the clip to look.
 *
 *  Not the ends: the first frames are the model settling and the last belongs to
 *  the seam, which is the same reason the launch's own plate cut holds off both.
 *  Five is enough to find a clear look at somebody in an eight-second clip and
 *  few enough that the whole set fits one vision call. */
const AT = [0.2, 0.35, 0.5, 0.65, 0.8];

/** The one the launch would have taken anyway, so a vision call that fails or
 *  answers nonsense costs the choice and not the character. */
const FALLBACK = 2;

const MODEL = 'grok-4.5';
const TIMEOUT_MS = 90_000;

const SYSTEM = `You look at frames from an adult film and pick the one that shows the performer most clearly, so it can be kept as their reference portrait.

Pick for legibility of the PERSON, not for the action:
  - face unobstructed, eyes and features readable, not blurred by motion
  - as much of the body in frame as the shot allows
  - not a close-up of a body part, not an extreme angle, not mid-blink
  - if a frame is dark, smeared or the face is turned away, prefer another

Then write one line describing that person's fixed physical facts as a casting note would: apparent adult age band, build, hair, skin, and anything permanent like freckles or tattoos. Describe only what a picture can show. Do not describe the act, the room, the clothing state or the mood. Every person here is an adult.

Answer as JSON and nothing else:
{"frame": <0-based index of the frame you picked>, "description": "<one line>"}`;

export const POST: RequestHandler = async ({ request, fetch }) => {
	let body: { workspace?: unknown; artifact?: unknown; file?: unknown; sessionSlug?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const workspace = typeof body.workspace === 'string' ? body.workspace : '';
	const artifact = typeof body.artifact === 'string' ? body.artifact : '';
	const file = typeof body.file === 'string' ? body.file : '';
	if (!WORKSPACE_RE.test(workspace)) throw error(400, 'Bad workspace id');
	if (!artifact || !file) throw error(400, 'Missing artifact or file');

	// The local copy, for the same reason the launch reads it there: that
	// workspace may be spent and its agent gone, and the bytes are here already.
	const clipPath = cached(workspace, artifact, file);
	if (!clipPath) {
		return json(
			{ ok: false, error: 'that clip is not in the library any more — it cannot be read' },
			{ status: 200 }
		);
	}

	let frames: Uint8Array[];
	try {
		frames = await Promise.all(AT.map((at) => frameAt(clipPath, at)));
	} catch (e) {
		return json({ ok: false, error: `the clip could not be read — ${e}` }, { status: 200 });
	}

	// Best-effort, both halves of it. A character cut from the middle of the clip
	// with no description is still better than the plate the launch would have
	// cut, so nothing here is allowed to be the reason there is no character.
	let pick = FALLBACK;
	let described = '';
	const key = env.GROK_API_KEY;
	if (key) {
		try {
			const res = await xaiPost(
				{
					model: MODEL,
					messages: [
						{ role: 'system', content: SYSTEM },
						{
							role: 'user',
							content: [
								{ type: 'text', text: `${frames.length} frames, in order, index 0 first.` },
								...frames.map((b) => ({
									type: 'image_url',
									image_url: { url: `data:image/png;base64,${Buffer.from(b).toString('base64')}` }
								}))
							]
						}
					]
				},
				key,
				TIMEOUT_MS
			);
			const d = (await res.json()) as { choices?: { message?: { content?: string } }[] };
			const said = d?.choices?.[0]?.message?.content ?? '';
			const cut = said.slice(said.indexOf('{'), said.lastIndexOf('}') + 1);
			const parsed = JSON.parse(cut) as { frame?: unknown; description?: unknown };
			const n = Math.floor(Number(parsed.frame));
			if (Number.isFinite(n) && n >= 0 && n < frames.length) pick = n;
			if (typeof parsed.description === 'string') described = parsed.description.trim().slice(0, 400);
		} catch {
			// The middle frame and no description. Said nowhere, because nobody
			// asked for a description — they asked for a character.
		}
	}

	// The same gate every written description passes. A line that trips it is
	// dropped rather than refused: the picture is what the render uses, and the
	// description is the part we generated.
	if (described && checkRequest(described).refuse) described = '';

	const sheet = addSheet({
		kind: 'character',
		name: nameFromDescription(described, 'character'),
		description: described,
		bytes: frames[pick],
		ext: '.png',
		// Not rendered by us and not a sheet: a frame of a clip, which is exactly
		// what the upload path means by this flag.
		uploaded: true,
		...(typeof body.sessionSlug === 'string' && body.sessionSlug.trim()
			? { sessionSlug: body.sessionSlug.trim() }
			: {})
	});

	// The six views, in the background and unwaited, exactly as an upload gets
	// them. Renders read the picture rather than the turnaround, so the character
	// is usable the moment this returns — the sheet is for the operator's eyes.
	void fetch('/studio/api/turnaround', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ id: sheet.id, look: described })
	}).catch(() => {});

	return json({ ok: true, sheet, sheets: listSheets(), pickedFrame: pick });
};
