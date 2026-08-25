/** The six-view turnaround for a character you have already saved.
 *
 *  Saving a character keeps the picture you approved and returns immediately.
 *  This is what happens next, behind you: the same description and the same seed
 *  go to the full sheet workflow, and three minutes later the character has a
 *  turnaround as well as a face. Nothing waits for it — the character was usable
 *  the moment it was saved, and the sheet is an improvement to it rather than a
 *  precondition.
 *
 *  Detached on purpose, and polled server-side rather than from the page: this
 *  outlives the tab. Closing the browser mid-render used to mean the render
 *  finished into nothing.
 *
 *  Goes through the harness rather than straight to Modal, unlike the preview.
 *  The preview earns the bypass by having nothing to decide; the sheet loads nine
 *  models across two families and is exactly the case the harness's provisioning
 *  is for.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HARNESS } from '$lib/harness';
import { attachSheetImage, getSheet, setSheetRender } from '../../sheets.server';

/** Long enough for a cold container and nine models, short enough that a wedged
 *  workspace eventually says so instead of spinning for ever. */
const DEADLINE_MS = 20 * 60 * 1000;
const POLL_MS = 5_000;

async function harnessCall(
	fetchFn: typeof globalThis.fetch,
	workspace: string,
	op: string,
	body: unknown = {}
): Promise<unknown> {
	const res = await fetch(`${HARNESS}/workspaces/${workspace}/api/${op}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ req: body }),
		signal: AbortSignal.timeout(30_000)
	});
	const text = await res.text();
	try {
		const once: unknown = JSON.parse(text);
		return typeof once === 'string' ? JSON.parse(once) : once;
	} catch {
		return text;
	}
}

/** Watch one sheet workspace to its end and file the result against the
 *  character. Every exit path writes a state, so nothing is left saying
 *  "rendering" for ever. */
async function follow(
	id: string,
	workspace: string,
	fetchFn: typeof globalThis.fetch
): Promise<void> {
	const deadline = Date.now() + DEADLINE_MS;
	for (;;) {
		if (Date.now() > deadline) {
			setSheetRender(id, { state: 'failed', error: 'the sheet did not finish in twenty minutes' });
			return;
		}
		await new Promise((r) => setTimeout(r, POLL_MS));
		let state: { artifacts?: { id: string; status?: string; files?: unknown[] }[]; tasks?: { status?: string }[] };
		try {
			state = (await harnessCall(fetchFn, workspace, 'poll-state')) as typeof state;
		} catch {
			// A workspace agent can stop answering for minutes mid-render and then
			// recover; that is not a failed sheet, so keep waiting for the deadline.
			continue;
		}
		const art = (state.artifacts ?? []).find((a) => a.status === 'approved' && (a.files ?? []).length);
		if (art) {
			const name = String((art.files ?? [])[0] ?? 'character_sheet.png');
			try {
				const res = await fetch(
					`${HARNESS}/workspaces/${workspace}/artifacts/${encodeURIComponent(art.id)}/${encodeURIComponent(name)}`
				);
				if (!res.ok) {
					setSheetRender(id, { state: 'failed', error: `the sheet could not be fetched — ${res.status}` });
					return;
				}
				attachSheetImage(id, new Uint8Array(await res.arrayBuffer()), workspace);
			} catch (e) {
				setSheetRender(id, { state: 'failed', error: `the sheet could not be fetched — ${e}` });
			}
			return;
		}
		const dead = (state.tasks ?? []).some((t) => t.status === 'permanently-failed');
		if (dead) {
			setSheetRender(id, { state: 'failed', error: 'the sheet render failed on the GPU' });
			return;
		}
	}
}

export const POST: RequestHandler = async ({ request, fetch }) => {
	let body: { id?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const id = typeof body.id === 'string' ? body.id : '';
	const character = getSheet(id);
	if (!character) return json({ ok: false, error: 'no such character' });
	if (character.kind !== 'character') return json({ ok: false, error: 'only a character has a turnaround' });
	if (character.sheet?.state === 'rendering') return json({ ok: true, already: true });

	// Marked before the launch, so a page that reloads in the next second still
	// sees work in progress rather than a character that looks untouched.
	setSheetRender(id, { state: 'rendering', startedAt: new Date().toISOString(), error: undefined });

	const slug = `sheet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
	let workspaceId = '';
	try {
		const res = await fetch('/studio/api/launch', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				stage: 'sheet',
				sheet: {
					slug,
					kind: 'character',
					stage: 'sheet',
					description: character.description,
					// The face you approved, not a new one.
					seed: character.seed ?? Math.floor(Math.random() * 1_000_000_000)
				}
			})
		});
		const r = (await res.json()) as { ok?: boolean; workspaceId?: string; error?: string };
		if (!r.ok || !r.workspaceId) {
			setSheetRender(id, { state: 'failed', error: r.error || 'the sheet render did not start' });
			return json({ ok: false, error: r.error || 'the sheet render did not start' });
		}
		workspaceId = r.workspaceId;
	} catch (e) {
		setSheetRender(id, { state: 'failed', error: String(e) });
		return json({ ok: false, error: String(e) });
	}

	void follow(id, workspaceId, fetch).catch((e) =>
		setSheetRender(id, { state: 'failed', error: String(e) })
	);

	return json({ ok: true, workspace: workspaceId });
};
