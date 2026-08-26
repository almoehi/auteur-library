/** The one way this app talks to the model, and the one place that knows the
 *  model can be full.
 *
 *  Four routes ask xAI to write something — a shot brief, a sheet subject, a
 *  plan, a diagnosis — and all four made the same call and gave up on the same
 *  answer. The provider returns 429 `resource-exhausted` when it is at capacity,
 *  with "please try again in a few minutes" in the body, and a request that
 *  reads that and reports failure has thrown away the instruction it was given.
 *
 *  It reached an operator mid-scene: they typed the next beat, waited, and got
 *  a wall of provider JSON instead of a prompt. Nothing was wrong with what they
 *  asked for and nothing about asking again would have been different, which is
 *  the definition of a retry that should not have been anyone's job to do by
 *  hand.
 *
 *  Bounded on purpose. Two extra attempts, widening, and then the error is
 *  reported as it always was: a provider that is still full after twenty seconds
 *  is having an outage, not a spike, and a page that keeps trying silently is
 *  worse than one that says so.
 *
 *  Statuses only, deliberately. Under load the provider sometimes hangs instead
 *  of answering, and the per-attempt timeout turns that into a thrown error
 *  rather than a code — which this does not catch. Retrying it would mean a
 *  caller with a 150s budget waiting past six minutes with nothing on screen,
 *  and a wait nobody can see is the failure mode this app has spent the most
 *  time removing. A timeout is reported at once, in the caller's own words.
 */
const XAI = 'https://api.x.ai/v1/chat/completions';

/** How long to wait before each further attempt. Length is the retry count. */
const WAITS_MS = [4_000, 12_000];

/** Full, not broken. 429 is the documented capacity code; 502/503/504 are the
 *  gateway's version of the same thing. Every other status — including a bad
 *  request or a rejected key — is an answer, and asking again will not change
 *  it. */
function worthRetrying(status: number): boolean {
	return status === 429 || status === 502 || status === 503 || status === 504;
}

export async function xaiPost(body: unknown, key: string, timeoutMs: number): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const res = await fetch(XAI, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
			body: JSON.stringify(body),
			// Fresh per attempt: a timeout signal is spent once it has fired, and
			// reusing one would abort the retry before it left.
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (!worthRetrying(res.status) || attempt >= WAITS_MS.length) return res;
		// Nothing will read this one. Released rather than left for the collector,
		// because a held response body keeps its connection with it.
		await res.body?.cancel().catch(() => {});
		await new Promise((r) => setTimeout(r, WAITS_MS[attempt]));
	}
}
