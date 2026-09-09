/** What went wrong, in words a person can read.
 *
 *  Everything in here throws two different kinds of failure and they unwrap
 *  differently. A plain `Error` carries its sentence on `.message`. SvelteKit's
 *  `error(status, message)` throws an `HttpError`, which is NOT an instance of
 *  `Error` — so the usual `e instanceof Error ? e.message : String(e)` falls to
 *  `String(e)`, and an HttpError stringifies to its JSON body.
 *
 *  That is how a refusal reached the stage as
 *  `{"message":"Generated image rejected by content moderation."}` — braces,
 *  quotes and all, in the middle of a surface that otherwise speaks English.
 *  The sentence was right there; nothing had taken it out of its envelope.
 */
export function why(e: unknown, fallback = 'something went wrong'): string {
	if (typeof e === 'string') return e.trim() || fallback;
	if (e && typeof e === 'object') {
		// SvelteKit's HttpError: the sentence lives on `body.message`.
		const body = (e as { body?: { message?: unknown } }).body;
		if (body && typeof body.message === 'string' && body.message.trim()) {
			return body.message.trim();
		}
		const m = (e as { message?: unknown }).message;
		if (typeof m === 'string' && m.trim()) return m.trim();
	}
	const s = String(e).trim();
	// Never hand back an object's default stringification or a JSON envelope.
	if (!s || s === '[object Object]' || s.startsWith('{')) return fallback;
	return s;
}
