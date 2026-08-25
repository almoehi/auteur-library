/** The character and location sheets a production keeps.
 *
 *  Rendering one goes through /studio/api/launch like every other render. This
 *  route is the store around it: list what exists, keep a finished render, name
 *  it, throw it away.
 *
 *  Keeping is done here rather than in the browser because the bytes have to
 *  come from the harness, and only the server can reach it. The browser has the
 *  three ids that identify the file and nothing else; it hands them over and
 *  this fetches, checks and writes.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { HARNESS } from '$lib/harness';
import { readPreview } from '../../anchorjobs.server';
import {
	MAX_SHEET_BYTES,
	addSheet,
	listSheets,
	nameFromDescription,
	orphanCount,
	removeSheet,
	renameSheet,
	type SheetKind
} from '../../sheets.server';

const WORKSPACE_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

function isKind(v: unknown): v is SheetKind {
	return v === 'character' || v === 'location';
}

export const GET: RequestHandler = async () => {
	return json({ ok: true, sheets: listSheets(), orphans: orphanCount() });
};

export const POST: RequestHandler = async ({ request, fetch }) => {
	let body: {
		kind?: unknown;
		name?: unknown;
		description?: unknown;
		workspace?: unknown;
		artifact?: unknown;
		file?: unknown;
		job?: unknown;
		seed?: unknown;
	};
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const { kind, workspace, artifact, file } = body;
	if (!isKind(kind)) throw error(400, "kind must be 'character' or 'location'");
	const description = typeof body.description === 'string' ? body.description : '';
	const name = typeof body.name === 'string' ? body.name : '';

	// Two kinds of source, because there are now two kinds of render. A sheet
	// comes back through the harness and is identified by a workspace triple; a
	// character preview skips the harness entirely and is already a file on this
	// machine. Keeping from a preview is therefore a copy, not a fetch.
	const jobId = typeof body.job === 'string' ? body.job : '';
	if (jobId) {
		const local = readPreview(jobId);
		if (!local) return json({ ok: false, error: 'that preview is gone — render it again' }, { status: 200 });
		const seed = Number.isFinite(Number(body.seed)) ? Math.floor(Number(body.seed)) : undefined;
		const sheet = addSheet({
			kind,
			name: name || nameFromDescription(description, kind),
			description,
			bytes: local,
			ext: '.png',
			...(seed !== undefined ? { seed } : {})
		});
		return json({ ok: true, sheet, sheets: listSheets() });
	}

	if (typeof workspace !== 'string' || !WORKSPACE_RE.test(workspace)) {
		throw error(400, 'Bad workspace id');
	}
	if (typeof artifact !== 'string' || !artifact) throw error(400, 'Missing artifact id');
	if (typeof file !== 'string' || !file) throw error(400, 'Missing file key');

	// Straight from the harness, while the workspace agent is still alive to
	// serve it. A sheet is worth having a local copy of for the same reason a
	// clip is — more so, since every later render depends on it.
	const url = `${HARNESS}/workspaces/${workspace}/artifacts/${encodeURIComponent(
		artifact
	)}/${encodeURIComponent(file)}`;
	let bytes: Uint8Array;
	try {
		const res = await fetch(url);
		if (!res.ok) {
			return json({ ok: false, error: `the harness answered ${res.status}` }, { status: 200 });
		}
		bytes = new Uint8Array(await res.arrayBuffer());
	} catch (e) {
		return json({ ok: false, error: `could not fetch the sheet: ${e}` }, { status: 200 });
	}

	// The harness answers a missing artifact with a JSON envelope and a 200, so
	// size alone is not proof — an eight-byte "sheet" would otherwise be stored
	// and only fail months later inside a render. A PNG starts with its own
	// signature and a JPEG with its own; anything else is not an image.
	const looksPng =
		bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	const looksJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (!looksPng && !looksJpeg) {
		return json(
			{ ok: false, error: 'that artifact is not an image — the render probably failed' },
			{ status: 200 }
		);
	}
	if (bytes.byteLength > MAX_SHEET_BYTES) {
		return json({ ok: false, error: 'the sheet is implausibly large' }, { status: 200 });
	}

	const sheet = addSheet({
		kind,
		name: name || nameFromDescription(description, kind),
		description,
		bytes,
		ext: looksJpeg ? '.jpg' : '.png',
		workspace
	});
	return json({ ok: true, sheet, sheets: listSheets() });
};

export const PATCH: RequestHandler = async ({ request }) => {
	let body: { id?: unknown; name?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}
	if (typeof body.id !== 'string' || typeof body.name !== 'string') {
		throw error(400, 'id and name are required');
	}
	const row = renameSheet(body.id, body.name);
	if (!row) return json({ ok: false, error: 'no such sheet' }, { status: 200 });
	return json({ ok: true, sheet: row, sheets: listSheets() });
};

export const DELETE: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id') ?? '';
	if (!id) throw error(400, 'id is required');
	const gone = removeSheet(id);
	return json({ ok: gone, sheets: listSheets() });
};
