/** The age check, with nothing else attached.
 *
 *  A character description used to go through a writer that translated it,
 *  tidied it and — the part that matters — guaranteed it named an adult. The
 *  writer is gone from that path: it cost five seconds on the one flow where the
 *  whole point is speed, and its main job was Hungarian, which stops being the
 *  job once the audience is English.
 *
 *  The guarantee does not go with it. This is the same rule, made deterministic
 *  and answered in microseconds instead of seconds. What it cannot do is repair:
 *  the writer could supply an adult age when you left one out, and a regex
 *  cannot write English. So it refuses and says what to add — which for the one
 *  case where guessing is unacceptable is the better behaviour anyway.
 *
 *  There is no model call here at all. It exists as a route rather than a
 *  client-side check for one reason: a guard that runs in the browser is a guard
 *  anyone can skip.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkDescription } from '../../minors.server';

const MAX = 2_000;

export const POST: RequestHandler = async ({ request }) => {
	let body: { description?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const description = typeof body.description === 'string' ? body.description.trim() : '';
	if (!description) throw error(400, 'Missing description');
	if (description.length > MAX) throw error(400, `Description is longer than ${MAX} characters`);

	const gate = checkDescription(description);
	if (gate.refuse) return json({ ok: false, error: gate.refuse });
	return json({ ok: true });
};
