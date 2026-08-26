/** The six-view sheet for a character you uploaded a photograph of.
 *
 *  A drawn character gets its turnaround from krea2_character_sheet. An uploaded
 *  one cannot: both sheet workflows are text-to-image with no image input at
 *  all, so they can draw a person from a description and have no way to redraw
 *  one from a photograph.
 *
 *  The video model can. Given the photograph as a reference and asked for a slow
 *  full turn on a plain backdrop, what comes back IS a turnaround — and the six
 *  views are then simply cut out of it and tiled. Measured on the first: identity
 *  held across all six, same face, hair, clothing and build.
 *
 *  Started by the upload itself and never mentioned. Nothing waits for it and
 *  nothing announces it: you attach a picture, the character exists immediately,
 *  and the sheet appears beside it later or does not. A progress line for work
 *  nobody asked for is noise.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS } from '$lib/harness';
import { sheetGrid } from '../../ffmpeg.server';
import { attachSheetImage, getSheet, setSheetRender } from '../../sheets.server';

const DEADLINE_MS = 25 * 60 * 1000;
const POLL_MS = 6_000;

/** Six seconds of turn, upright, in portrait.
 *
 *  Portrait because a sheet wants the whole body; six seconds because the turn
 *  has to be slow enough that no view is motion-blurred past use. The quarter
 *  marks are named with end states for the same reason every clip brief names
 *  them: without them the model decides its own pacing and lands two of the six
 *  frames on the same angle.
 */
const TURN_SECONDS = 6;
const TURN_W = 576;
const TURN_H = 1024;

/** Deliberately says "person", not "woman".
 *
 *  This prompt is generated for every upload, sight unseen — the only thing we
 *  know about the picture is that somebody chose it as a character. Naming a sex
 *  here would tell the model something we do not know, against a photograph that
 *  already shows it. */
function turnPrompt(look = ''): string {
	// What the operator typed, if anything.
	//
	// A photograph shows one angle, and everything outside it — the build, the
	// height, what the clothing does from behind — the model invents. Two turns
	// from the same picture tonight came back in different outfits, which is that
	// invention working exactly as it must with nothing to go on. A line of
	// description is the only thing that narrows it.
	const said = look.trim().slice(0, 400);
	return `subject_definitions:
<Subject 1> is the adult person shown in <Picture 1>. Their face, hair, skin tone, body type and identity come only from that picture. They are the sole subject.${
		said ? `\nThe operator describes them as: ${said}. Where the picture and this description agree, follow both; where the picture cannot show something — build, height, what the clothing does from behind — follow the description.` : ''
	}

summary:
reference generation. A character turnaround: <Subject 1> stands still on a plain studio backdrop and rotates slowly and continuously through one full turn, so the same person is seen from the front, both sides and the back in a single unbroken take.

retention_analysis:
<Picture 1> / <Subject 1>: fully_preserved for face, hair, skin tone, body type, clothing and identity. The background of <Picture 1> is not retained. The pose of <Picture 1> is not retained.

detailed_description:
Photoreal live-action video, real recorded footage of a real person, colour flat and ungraded. Matte skin with visible pores and fine down, even skin tone, natural facial asymmetry, individual strands of hair out of place. Even, soft, shadowless studio lighting from the front and both sides, no coloured light, no rim light. Plain mid-grey seamless backdrop, empty, nothing else in frame. Fine sensor noise in the shadows.

[Shot 1] Photoreal live-action, portrait frame. Locked-off camera at chest height, full body in frame with headroom, no push, no pan, no tilt, no cut. <Subject 1> stands upright in the centre of a plain mid-grey seamless backdrop, arms relaxed at their sides, feet together, expression neutral, eyes level. Preserve their identity from <Picture 1> exactly, including their clothing. From the first frame they are already turning: they rotate slowly and evenly on the spot, anticlockwise, at a constant speed, one continuous full turn across the whole clip. The posture does not change, the arms stay down, the head stays level and follows the body rather than turning separately. End state: front view, facing the camera.
At 00:01.200 a quarter of the turn is complete, left three-quarter profile, still rotating at the same speed. End state: left side coming into view.
At 00:02.400 the turn is halfway, full back view, the back of the head and shoulders to camera. End state: back view.
At 00:03.600 three quarters are complete, right three-quarter profile. End state: right side in view.
At 00:04.800 the turn is nearly complete, coming back around toward the front. End state: front three-quarter.
At 00:06.000 the turn completes facing the camera again, arms still down, expression unchanged. End state: front view, the same stance as the opening.

overall_soundscape:
Quiet studio room tone, faint air handling, soft footfall on the turn. Nothing else.

non_diegetic_music:
N/A`;
}

async function poll(workspace: string): Promise<{ artifact: string; file: string } | null> {
	const deadline = Date.now() + DEADLINE_MS;
	for (;;) {
		if (Date.now() > deadline) return null;
		await new Promise((r) => setTimeout(r, POLL_MS));
		try {
			const res = await fetch(`${HARNESS}/workspaces/${workspace}/api/poll-state`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ req: {} }),
				signal: AbortSignal.timeout(30_000)
			});
			const text = await res.text();
			let d: unknown = text;
			try {
				const once: unknown = JSON.parse(text);
				d = typeof once === 'string' ? JSON.parse(once) : once;
			} catch {
				continue;
			}
			const state = d as {
				artifacts?: { id: string; status?: string; files?: string[] }[];
				tasks?: { status?: string }[];
			};
			const art = (state.artifacts ?? []).find(
				(a) => a.status === 'approved' && (a.files ?? []).length
			);
			if (art) return { artifact: art.id, file: String((art.files ?? [])[0]) };
			if ((state.tasks ?? []).some((t) => t.status === 'permanently-failed')) return null;
		} catch {
			// A workspace agent can go quiet mid-render and come back. Keep waiting
			// for the deadline rather than treating a dropped poll as a failure.
			continue;
		}
	}
}

/** Render the turn, cut it up, file it. Every exit writes a state, so nothing is
 *  left saying "rendering" for ever. */
async function build(id: string, look: string, fetchFn: typeof globalThis.fetch): Promise<void> {
	const sheet = getSheet(id);
	if (!sheet) return;

	setSheetRender(id, { state: 'rendering', startedAt: new Date().toISOString(), attempt: 1 });

	let workspace = '';
	try {
		const res = await fetchFn('/studio/api/launch', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				stage: 'direct',
				direct: {
					slug: `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
					title: `${sheet.name} — turnaround`,
					prompts: [turnPrompt(look)],
					seconds: TURN_SECONDS,
					width: TURN_W,
					height: TURN_H,
					seed: Math.floor(Math.random() * 1_000_000_000),
					// No shot adapters. A turnaround is not a scene, and an action
					// adapter here would push the pose away from the one thing wanted:
					// standing still and rotating.
					loras: [],
					baseLoras: {},
					wroteLoras: [],
					request: 'turnaround from an uploaded photograph',
					characterId: id
				}
			})
		});
		const r = (await res.json()) as { ok?: boolean; workspaceId?: string; error?: string };
		if (!r.ok || !r.workspaceId) {
			setSheetRender(id, { state: 'failed', error: r.error || 'the turnaround did not start' });
			return;
		}
		workspace = r.workspaceId;
	} catch (e) {
		setSheetRender(id, { state: 'failed', error: String(e) });
		return;
	}

	const got = await poll(workspace);
	if (!got) {
		setSheetRender(id, { state: 'failed', error: 'the turnaround did not finish', workspace });
		return;
	}

	const dir = mkdtempSync(join(tmpdir(), 'auteur-turn-'));
	try {
		const res = await fetch(
			`${HARNESS}/workspaces/${workspace}/artifacts/${encodeURIComponent(got.artifact)}/${encodeURIComponent(got.file)}`
		);
		if (!res.ok) {
			setSheetRender(id, { state: 'failed', error: `the turnaround could not be fetched — ${res.status}`, workspace });
			return;
		}
		const clip = join(dir, 'turn.mp4');
		writeFileSync(clip, new Uint8Array(await res.arrayBuffer()));
		attachSheetImage(id, await sheetGrid(clip, TURN_SECONDS), workspace);
	} catch (e) {
		setSheetRender(id, { state: 'failed', error: `the six views could not be built — ${e}`, workspace });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export const POST: RequestHandler = async ({ request, fetch }) => {
	let body: { id?: unknown; look?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const id = typeof body.id === 'string' ? body.id : '';
	const sheet = getSheet(id);
	if (!sheet) return json({ ok: false, error: 'no such character' });
	if (sheet.sheet?.state === 'rendering') return json({ ok: true, already: true });

	// Detached: the answer is that it started, not that it finished.
	void build(id, typeof body.look === 'string' ? body.look : '', fetch);
	return json({ ok: true });
};
