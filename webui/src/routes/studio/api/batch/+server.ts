/** Several takes of one beat, rendered at once.
 *
 *  The single-clip path runs entirely through the browser: it launches, it polls,
 *  and the clip only reaches the library when the page asks for the file. That is
 *  correct for one render you are watching and wrong for four you are not — close
 *  the tab and the GPU keeps working for nobody.
 *
 *  So this borrows the shape api/turnaround already proved: the server launches,
 *  the server polls, the server stores. The page's only job is to show what has
 *  arrived. Nothing about the render itself changes — each take is an ordinary
 *  direct render in its own workspace, so the render log, the chain and the clip
 *  cache stay keyed exactly as they were, and a take can be continued or rated
 *  like any other clip.
 *
 *  Parallel because the harness allows it (RENDER_PARALLELISM=4) and because the
 *  gaps are what cost the time: four sequential takes with a person thinking in
 *  between are four cold starts, while four at once share one. Measured on the
 *  h100: 208s cold, 165s warm.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HARNESS } from '$lib/harness';
import { store } from '../../../clips.server';
import { addRuns, listRuns, updateRun, type BatchRun } from '../../batches.server';

/** Four, because that is what the harness will run at once — a fifth would queue
 *  behind the others and look like a hang rather than a wait. */
const MAX_TAKES = 4;
const POLL_MS = 6_000;
const DEADLINE_MS = 40 * 60 * 1000;

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
			// for the deadline rather than treating one dropped poll as a failure.
			continue;
		}
	}
}

/** Follow one take to its end and file it. Every exit writes a state, so no row
 *  is left claiming to render after its process has stopped caring. */
async function follow(run: BatchRun): Promise<void> {
	const got = await poll(run.workspace);
	if (!got) {
		updateRun(run.slug, { state: 'failed', error: 'the render did not finish' });
		return;
	}
	try {
		const res = await fetch(
			`${HARNESS}/workspaces/${run.workspace}/artifacts/${encodeURIComponent(got.artifact)}/${encodeURIComponent(got.file)}`
		);
		if (!res.ok) {
			updateRun(run.slug, { state: 'failed', error: `the clip could not be fetched — ${res.status}` });
			return;
		}
		const bytes = new Uint8Array(await res.arrayBuffer());
		// Stored here rather than by the page, which is the whole point: the clip
		// belongs to the library the moment it exists, not the moment somebody
		// looks at it.
		store(run.workspace, got.artifact, got.file, bytes);
		updateRun(run.slug, {
			state: 'ready',
			clip: { workspace: run.workspace, artifact: got.artifact, file: got.file }
		});
	} catch (e) {
		updateRun(run.slug, { state: 'failed', error: String(e) });
	}
}

export const GET: RequestHandler = async () => {
	return json({ ok: true, runs: listRuns() });
};

export const POST: RequestHandler = async ({ request, fetch }) => {
	let body: { direct?: Record<string, unknown>; takes?: unknown; variants?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const spec = body.direct;
	if (!spec || typeof spec !== 'object') throw error(400, 'Missing direct spec');
	const asked = Math.round(Number(body.takes));
	const takes = Number.isFinite(asked) ? Math.min(MAX_TAKES, Math.max(1, asked)) : 2;

	/** One prompt per camera angle, or none — in which case every run shoots the
	 *  prompt already in the spec and the only thing separating them is the seed.
	 *  The two multiply: three angles at two versions each is six clips, and the
	 *  caller is responsible for not asking for more than the harness runs at
	 *  once. */
	const variants = (Array.isArray(body.variants) ? body.variants : [])
		.filter((v): v is string => typeof v === 'string' && !!v.trim());
	const angles: (string | null)[] = variants.length ? variants : [null];
	const total = angles.length * takes;
	if (total > MAX_TAKES) {
		return json(
			{ ok: false, error: `that is ${total} clips at once, and ${MAX_TAKES} is the most that render together` },
			{ status: 200 }
		);
	}

	const batch = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	const runs: BatchRun[] = [];
	const started: BatchRun[] = [];

	for (let i = 0; i < total; i++) {
		// Angle-major, so takes 1 and 2 are two versions of the first angle rather
		// than one of each — the strip then reads as groups, in the order the
		// angles were written.
		const angle = angles[Math.floor(i / takes)];
		// A slug and a seed per take. The seed is what makes them different takes
		// rather than the same clip four times; the slug is what keeps each one a
		// separate workspace, and so a separate row everywhere else.
		const slug = `${batch}-t${i + 1}`;
		const seed = Math.floor(Math.random() * 1_000_000_000);
		let workspaceId = '';
		try {
			const res = await fetch('/studio/api/launch', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					stage: 'direct',
					direct: { ...spec, slug, seed, ...(angle ? { prompts: [angle] } : {}) }
				})
			});
			const r = (await res.json()) as { ok?: boolean; workspaceId?: string; error?: string };
			if (!r.ok || !r.workspaceId) {
				runs.push({
					batch, slug, workspace: '', seed, index: i + 1,
					at: new Date().toISOString(), state: 'failed',
					error: r.error || 'the render did not start'
				});
				continue;
			}
			workspaceId = r.workspaceId;
		} catch (e) {
			runs.push({
				batch, slug, workspace: '', seed, index: i + 1,
				at: new Date().toISOString(), state: 'failed', error: String(e)
			});
			continue;
		}
		const run: BatchRun = {
			batch, slug, workspace: workspaceId, seed, index: i + 1,
			at: new Date().toISOString(), state: 'rendering'
		};
		runs.push(run);
		started.push(run);
	}

	addRuns(runs);
	// Detached on purpose: the answer is that the takes started, not that they
	// finished. Each one files itself when it lands.
	for (const run of started) void follow(run);

	return json({ ok: true, batch, runs });
};
