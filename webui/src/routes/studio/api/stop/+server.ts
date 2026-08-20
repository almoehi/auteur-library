/** Stop a production.
 *
 *  Until this existed the only way out of a bad run was `docker stop harness`,
 *  which takes every workspace with it — and the run people most want to stop is
 *  the one that is failing in a loop, where the harness will keep retrying and
 *  every retry of a render is a GPU call that is billed. One afternoon of that
 *  cost real money before anyone thought to look.
 *
 *  Two calls, in this order, because they answer different halves of "stop":
 *
 *    teardown-all-workflows  releases the compute. This is the half that costs
 *                            money, so it goes first and runs even if the second
 *                            half fails.
 *    remove-task             removes what is queued, so nothing dispatches again.
 *                            Without it the harness re-runs the work the moment
 *                            a worker frees up.
 *
 *  Both workspaces are addressed, planning and render. A production that has
 *  reached the shoot has two live ids, and stopping only the one the page is
 *  currently polling leaves the other running.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HARNESS } from '$lib/harness';
import { SLUG_RE } from '../../types';

interface StopReport {
	workspace: string;
	torndown: boolean;
	tasksRemoved: number;
	notes: string[];
}

async function post(workspaceId: string, op: string, body: unknown): Promise<Response | null> {
	try {
		return await fetch(`${HARNESS}/workspaces/${workspaceId}/api/${op}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
	} catch {
		// The harness being unreachable is itself a kind of stopped.
		return null;
	}
}

async function stopOne(workspaceId: string): Promise<StopReport> {
	const report: StopReport = { workspace: workspaceId, torndown: false, tasksRemoved: 0, notes: [] };

	// Compute first — it is the part that is charged by the second.
	const td = await post(workspaceId, 'teardown-all-workflows', {});
	report.torndown = !!td?.ok;
	if (td && !td.ok) report.notes.push(`teardown returned ${td.status}`);
	if (!td) report.notes.push('the harness did not answer the teardown');

	// Then the queue. Anything not already finished would otherwise be picked up
	// again the moment a worker is free.
	let state: unknown;
	try {
		const res = await fetch(`${HARNESS}/workspaces/${workspaceId}/api/poll-state`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({})
		});
		if (res.ok) state = JSON.parse(await res.text());
	} catch {
		report.notes.push('could not read the task list');
	}

	const d = state as { tasks?: { id?: string; status?: string }[] } | undefined;
	const live = (d?.tasks ?? []).filter(
		(t) => t.id && (t.status === 'running' || t.status === 'pending')
	);
	for (const t of live) {
		// cascade so a task's dependents go with it — removing a parent and
		// leaving its children queued is not a stop, it is a smaller run.
		const r = await post(workspaceId, 'remove-task', { req: { taskId: t.id, cascade: true } });
		if (r?.ok) report.tasksRemoved += 1;
	}

	return report;
}

export const POST: RequestHandler = async ({ request }) => {
	let body: { slug?: string; workspaces?: string[] };
	try {
		body = (await request.json()) as { slug?: string; workspaces?: string[] };
	} catch {
		throw error(400, 'Body must be JSON');
	}

	// Explicit ids win; the slug is the convenience path for a page that knows
	// only which production it is showing.
	let ids = (body.workspaces ?? []).filter((w) => typeof w === 'string' && w.trim());
	if (!ids.length) {
		const slug = (body.slug ?? '').trim();
		if (!slug || !SLUG_RE.test(slug)) throw error(400, 'Need a slug or explicit workspace ids');
		ids = [`${slug}@1.0`, `${slug}-shoot@1.0`];
	}

	const reports: StopReport[] = [];
	for (const id of ids) reports.push(await stopOne(id));

	const removed = reports.reduce((n, r) => n + r.tasksRemoved, 0);
	const torndown = reports.some((r) => r.torndown);
	return json({ ok: torndown || removed > 0, removed, torndown, reports });
};
