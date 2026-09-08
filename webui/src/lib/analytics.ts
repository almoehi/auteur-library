/** PostHog, and the least of it that answers a question.
 *
 *  The studio is a second SvelteKit app behind the same host as the consumer
 *  site: a path rewrite hands it `/studio`, next to the app that owns `/`.
 *  Nothing is shared but the domain — different bundle, different layout,
 *  different boot — so the main app's posthog-js has never run here. That is
 *  why /studio appears in no traffic figure the project has, and why no survey
 *  has ever been able to reach the people using it.
 *
 *  What loads is deliberately thin, and every option below is written out
 *  rather than left to a `defaults` preset, because the presets move and the
 *  reason for each of these is specific to this app:
 *
 *    autocapture         sends the text near every click, and the text here is
 *                        the production — the brief, the scene, the sheet.
 *    heatmaps            same, plus click coordinates over the transcript.
 *    session recording   sends the frames, which is the production again.
 *    exceptions          the studio reports its own failures in place, in
 *                        words; a second channel for them buys nothing.
 *
 *  What is left is a pageview and the survey channel, which is the reason this
 *  file exists.
 *
 *  With PUBLIC_POSTHOG_KEY unset nothing loads at all. That is the normal state
 *  of a local run and it is not an error. */
import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import type { PostHog } from 'posthog-js';

/** The single in-flight load. Resolves to null when there is no key, when the
 *  chunk fetch fails, or on the server — every caller below tolerates null, so
 *  a blocked SDK degrades to silence rather than to an error in the console of
 *  someone trying to shoot a film. */
let loader: Promise<PostHog | null> | null = null;

export function initPostHog(): Promise<PostHog | null> {
	if (!browser) return Promise.resolve(null);
	if (loader) return loader;

	const key = env.PUBLIC_POSTHOG_KEY?.trim();
	const host = env.PUBLIC_POSTHOG_HOST?.trim();
	if (!key || !host) return (loader = Promise.resolve(null));

	loader = import('posthog-js')
		.then(({ default: posthog }) => {
			posthog.init(key, {
				api_host: host,
				person_profiles: 'identified_only',
				capture_pageview: 'history_change',
				autocapture: false,
				capture_heatmaps: false,
				capture_exceptions: false,
				disable_session_recording: true
			});
			// `history_change` covers a later navigation and not the load that
			// started the session — the consumer app pairs the same setting with a
			// first capture of its own for exactly this reason. Measured here
			// before it was: a studio session produced a distinct id, a remote
			// config fetch, and no event at all.
			posthog.capture('$pageview');
			return posthog;
		})
		.catch(() => null);

	return loader;
}

/** Load on the first sign of a human, or after ten seconds, whichever comes
 *  first.
 *
 *  The studio's own boot is chatty — the transcript restores, the workspace
 *  poll starts, artifacts begin arriving — and 190 KB of SDK does not belong in
 *  that queue. Deferring it costs nothing that matters here: a survey timed in
 *  minutes does not care that its clock started on the first keystroke instead
 *  of on load.
 *
 *  Returns its own teardown, so a layout can hand it straight back out of
 *  `onMount`. */
export function armPostHog(): () => void {
	if (!browser) return () => {};

	let fired = false;
	const start = () => {
		if (fired) return;
		fired = true;
		void initPostHog();
	};

	const signals = ['pointerdown', 'keydown', 'scroll', 'touchstart'] as const;
	for (const s of signals) window.addEventListener(s, start, { once: true, passive: true });
	const fallback = setTimeout(start, 10_000);

	return () => {
		for (const s of signals) window.removeEventListener(s, start);
		clearTimeout(fallback);
	};
}

/** A clip came back and is about to appear in the transcript.
 *
 *  The one event worth having beyond the pageview: it is the moment the studio
 *  delivered the thing it exists to deliver, so it is the honest place to ask
 *  someone what they think of it. Client-side on purpose — a server-side
 *  capture cannot trigger a PostHog survey, which is a trap this project has
 *  already walked into twice with `duel_complete` and `analysis_complete`. */
export function trackClipReady(): void {
	void initPostHog().then((p) => p?.capture('studio_clip_ready'));
}
