/** A subject from a description, drawn rather than rendered.
 *
 *  One call and about thirty seconds: four views, tiled, kept. It replaces two
 *  round trips that between them took the better part of ten minutes — the
 *  preview (a GPU render of one picture) and then the six views (a GPU render
 *  of an orbit, cut into frames) — and it replaces them with the same result in
 *  the same shape. The subject's own picture is the first view; the tiled four
 *  land on `sheet` exactly as the turnaround's grid did.
 *
 *  Held open rather than detached. The caller has nothing yet — no card, no
 *  picture, no id — so there is nothing for it to poll, and thirty seconds is a
 *  wait a person will sit through when the alternative is a spinner over a job
 *  they cannot see.
 *
 *  Carried over from ratemyd, where this route is wrapped in `withStudioUser`
 *  and the storage calls are async because they are database writes. Here there
 *  is one operator, no session and no anonymous mode to guard against — the app
 *  is loopback-bound and unauthenticated by design, see the README — and the
 *  sheet store is the same synchronous file layer it has always been. So the
 *  wrapper is gone and the awaits with it; nothing else about the flow moved.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { why as whyOf } from '../../why';
import { drawSubject } from '../../grokviews.server';
import { checkDescription } from '../../minors.server';
import { addSheet, attachSheetImage, listSheets } from '../../sheets.server';

const MAX_DESCRIPTION = 2000;

function isKind(v: unknown): v is 'character' | 'location' {
	return v === 'character' || v === 'location';
}

/** The first words of the description, as a name to start from. Same rule the
 *  rest of the app names subjects by, so a drawn one and an uploaded one arrive
 *  looking alike. */
function nameFrom(description: string, kind: 'character' | 'location'): string {
	const words = description.replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
	return words || (kind === 'character' ? 'Character' : 'Location');
}

export const POST: RequestHandler = async (event) => {
	let body: {
		kind?: unknown;
		description?: unknown;
		name?: unknown;
		voice?: unknown;
		seed?: unknown;
		sessionSlug?: unknown;
	};
	try {
		body = await event.request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const { kind } = body;
	if (!isKind(kind)) throw error(400, "kind must be 'character' or 'location'");
	const description = (typeof body.description === 'string' ? body.description : '').trim();
	if (!description) throw error(400, 'a subject needs a description');
	if (description.length > MAX_DESCRIPTION) throw error(400, 'that description is too long');

	// The same gate the render paths run, on the same input, for the same
	// reason: a description with no age in it has produced a child before, and
	// this route reaches a picture without passing any of the others.
	const gate = checkDescription(description, kind === 'location' ? 'place' : 'person');
	if (gate.refuse) return json({ ok: false, error: gate.refuse });

	let drawn;
	try {
		drawn = await drawSubject(kind, description);
	} catch (e) {
		const why = whyOf(e, 'the subject could not be drawn');
		return json({ ok: false, error: why });
	}

	const voice = typeof body.voice === 'string' ? body.voice : '';
	const seedNum = Number(body.seed);
	const sheet = addSheet({
		kind,
		name: (typeof body.name === 'string' && body.name.trim()) || nameFrom(description, kind),
		description,
		// The first view alone, at full size: this is the subject's face, and a
		// quarter of a grid is a worse picture of it than the picture itself.
		bytes: drawn.first,
		ext: '.jpg',
		...(voice ? { voice } : {}),
		...(Number.isFinite(seedNum) ? { seed: Math.floor(seedNum) } : {}),
		...(typeof body.sessionSlug === 'string' && body.sessionSlug.trim()
			? { sessionSlug: body.sessionSlug.trim() }
			: {})
	});

	// And the four together, where the turnaround's grid used to go — so the
	// "Six views" control opens this without knowing anything changed.
	attachSheetImage(sheet.id, drawn.sheet);

	return json({
		ok: true,
		sheet,
		sheets: listSheets(),
		elapsedSec: drawn.elapsedSec
	});
};
