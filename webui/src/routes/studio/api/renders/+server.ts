/** Read the render log, and add to a row what was not known when it was written.
 *
 *  A launch records everything it can, which is everything except how it went.
 *  That arrives minutes later — the run reaches success or dies — and this is
 *  where it gets attached, keyed by the workspace the row was written under.
 *
 *  GET is here because a log you cannot read is a log nobody checks. It answers
 *  the question that started all of this: what was that good clip rendered with.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readRenders, updateRender, corrections } from '../../renders.server';

export const GET: RequestHandler = async ({ url }) => {
	if (url.searchParams.get('corrections') === '1') {
		return json({ rows: corrections(40) });
	}
	const rows = readRenders();
	const limit = Number(url.searchParams.get('limit'));
	return json({ rows: Number.isFinite(limit) && limit > 0 ? rows.slice(-limit) : rows });
};

/** The fields a caller may attach after the fact.
 *
 *  Deliberately short. Everything else about a render was decided before it ran
 *  and was written down then; anything arriving later that is not one of these
 *  is a caller confused about which row it is looking at, and silently accepting
 *  it would corrupt the one record we have. */
export const POST: RequestHandler = async ({ request }) => {
	let body: { workspace?: unknown; finished?: unknown; outcome?: unknown; note?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw error(400, 'Body must be JSON');
	}
	const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : '';
	if (!workspace) throw error(400, 'workspace is required');

	const patch: {
		wallSeconds?: number;
		outcome?: 'kept' | 'rejected' | 'failed';
		note?: string;
	} = {};
	// The elapsed time is worked out here from the launch already on the row,
	// rather than sent by the caller. The page would have to keep a clock across
	// reloads to send it, and a clock that survives a reload is a thing to get
	// wrong for a number nobody would notice being wrong.
	if (body.finished === true) {
		const row = readRenders().find((r) => r.workspace === workspace);
		if (row?.at) patch.wallSeconds = Math.round((Date.now() - row.at) / 1000);
	}
	if (body.outcome === 'kept' || body.outcome === 'rejected' || body.outcome === 'failed') {
		patch.outcome = body.outcome;
	}
	// Capped rather than rejected when long: someone typing what went wrong is
	// doing the app a favour, and losing the whole note to a length rule they
	// were never shown is a good way to stop them doing it again.
	if (typeof body.note === 'string') patch.note = body.note.trim().slice(0, 2000);
	if (!Object.keys(patch).length) throw error(400, 'nothing to update');

	// A miss means the row was never written — an older run, or a launch from
	// before this log existed. Not an error, and not worth inventing a row for:
	// a row without its settings would answer the question wrongly rather than
	// not at all.
	return json({ ok: updateRender(workspace, patch) });
};
