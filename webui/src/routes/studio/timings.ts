/** How long things usually take here, learned from this machine's own runs.
 *
 *  A waiting line that counts up is honest but half a sentence: `4m 59s` means
 *  nothing on its own, because the reader cannot tell whether the answer is due
 *  at five minutes or at twenty. That is the difference between waiting and
 *  wondering whether it has hung.
 *
 *  The harness cannot supply the other half — no step count reaches the studio,
 *  and the sampler's `steps` is a setting sent *into* the workflow, not a
 *  readout coming back. But the user's own finished runs can, and they are the
 *  better sample anyway: the GPU, the queue and the cold 40GB model load are
 *  all theirs, and a median of their last few runs predicts their next one far
 *  better than any number we could write down here.
 *
 *  Median rather than mean: one run that sat behind a cold start is normal, and
 *  it would drag an average somewhere useless for every run after it.
 *
 *  Pure and local. No fetching, no server, nothing shared between machines.
 */

const KEY = 'auteur-studio-timings';

/** The two waits worth measuring. `prompt` is the model round trip that writes
 *  the shot; `clip` is a single direct render. Full productions are deliberately
 *  not recorded: they are a different order of magnitude and a couple of them
 *  would make the clip estimate useless. */
export type WaitKind = 'prompt' | 'clip' | 'confirm';

/** Enough to be a median rather than an anecdote, few enough that a change in
 *  the machine or the model shows up within a session's worth of runs. */
const KEEP = 24;
const MIN_SAMPLES = 3;

/** A run interrupted by a reload, or a clock that moved, produces a duration
 *  that is not a duration. Both ends are well outside anything real. */
const FLOOR_MS = 1_000;
const CEIL_MS = 2 * 60 * 60 * 1_000;

/** What a single clip can plausibly take, measured rather than guessed: the
 *  harness's own log for the last dozen renders reads 246, 254, 285, 305, 395,
 *  426, 426, 436, 458, 686 seconds, with one 3402 outlier. Twenty minutes is
 *  well clear of every real one, including a cold 40GB model load.
 *
 *  Enforced on READ as well as write, which is the part that matters. The
 *  samples already on disk are the poisoned ones — 6746, 2557, 5428, 5486
 *  seconds, a median of ninety minutes — and they were not going to age out on
 *  their own for another twenty runs. A rule about what is shown has to hold
 *  for what is already stored, or the fix only helps people who have never
 *  used the app. */
const PLAUSIBLE_MS: Partial<Record<WaitKind, number>> = {
	clip: 20 * 60 * 1_000,
	prompt: 5 * 60 * 1_000,
	confirm: 30 * 1_000
};

type Store = Partial<Record<WaitKind, number[]>>;

function read(): Store {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== 'object') return {};
		return parsed as Store;
	} catch {
		return {};
	}
}

/** Remember one completed wait. Called on the success path only — a failed run
 *  tells you how long the failure took, which is not what the line promises. */
export function recordWait(kind: WaitKind, ms: number): void {
	if (!Number.isFinite(ms) || ms < FLOOR_MS || ms > (PLAUSIBLE_MS[kind] ?? CEIL_MS)) return;
	try {
		const store = read();
		const list = [...(store[kind] ?? []), Math.round(ms)].slice(-KEEP);
		localStorage.setItem(KEY, JSON.stringify({ ...store, [kind]: list }));
	} catch {
		/* private mode, a full quota — the estimate is a courtesy, not a feature */
	}
}

/** What ships before this machine has said anything.
 *
 *  The original argument for showing nothing was that a wrong estimate on run
 *  two teaches the reader to distrust the right one on run ten. That held when
 *  there was no measured basis for a number. There is one now: 35 real renders
 *  in the harness log over the last week, 246 to 1194 seconds, and the last
 *  day's three at 246, 305 and 426. So the first two runs get four minutes,
 *  which is the fast end of a real distribution rather than a guess — and the
 *  reader's own median takes over the moment there are three of them.
 *
 *  Nothing for the other two kinds. The prompt writer and the read-back are
 *  fast enough that a number beside them is noise, and they have their own
 *  wording for being slower than usual. */
const SHIPPED_MS: Partial<Record<WaitKind, number>> = {
	clip: 4 * 60 * 1_000
};

/** The median of what has been seen, falling back to what shipped. */
export function typicalWait(kind: WaitKind): number | null {
	const cap = PLAUSIBLE_MS[kind] ?? CEIL_MS;
	const list = read()[kind]?.filter((ms) => ms <= cap);
	if (!list || list.length < MIN_SAMPLES) return SHIPPED_MS[kind] ?? null;
	const sorted = [...list].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Deliberately rounder than the elapsed clock beside it. The elapsed number is
 *  precise because it is a measurement; this one is an expectation, and writing
 *  it as `4m 47s` would claim a precision it does not have — and would make the
 *  two numbers look like they were meant to be compared digit by digit. */
export function typicalLabel(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 20) return `about ${Math.max(5, Math.round(s / 5) * 5)}s`;
	if (s < 90) return `about ${Math.round(s / 10) * 10}s`;
	const m = Math.round(s / 60);
	return `about ${m}m`;
}
