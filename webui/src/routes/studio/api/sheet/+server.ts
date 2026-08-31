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
	setSheetVoice,
	markSheetDelivered,
	type Sheet,
	type SheetKind
} from '../../sheets.server';

const WORKSPACE_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/;

function isKind(v: unknown): v is SheetKind {
	return v === 'character' || v === 'location';
}

export const GET: RequestHandler = async () => {
	return json({ ok: true, sheets: listSheets(), orphans: orphanCount() });
};

/** A character made from a picture you already have.
 *
 *  The third source, and the only one that never touches a GPU. It exists
 *  because a face you own is a better character than a face you describe — and
 *  because the machinery a clip needs is just an image: the render stages it to
 *  S3 and hands the url to the workflow, and nothing downstream asks where it
 *  came from.
 *
 *  It gets a six-view turnaround too, though not from the sheet workflows —
 *  both are text-to-image with no image input at all, so they can draw a person
 *  from a description and have no way to redraw one from a photograph. The video
 *  model can: see api/turnaround. That runs in the background and is never
 *  mentioned, because you attached a picture, you did not ask for a render.
 */
async function fromUpload(request: Request, fetchFn: typeof globalThis.fetch): Promise<Response> {
	const form = await request.formData();
	const file = form.get('file');
	if (!(file instanceof File)) throw error(400, 'Missing file');
	const kind = form.get('kind');
	if (!isKind(kind)) throw error(400, "kind must be 'character' or 'location'");

	if (file.size > MAX_SHEET_BYTES) {
		return json({ ok: false, error: 'that picture is too large' }, { status: 200 });
	}
	const bytes = new Uint8Array(await file.arrayBuffer());

	// The same signature check the harness path runs. A browser's content-type is
	// whatever the file extension suggested, which is not evidence — and a stored
	// non-image fails later, on a GPU, minutes into a render.
	const looksPng =
		bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
	const looksJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	const looksWebp =
		bytes.length > 12 &&
		String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
		String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
	if (!looksPng && !looksJpeg && !looksWebp) {
		return json({ ok: false, error: 'that file is not a PNG, JPEG or WebP image' }, { status: 200 });
	}

	// What you typed in the composer, if anything, otherwise the filename. The
	// description is not decoration here: it is the only record of who this is,
	// and the writer names the character from it when a clip uses them.
	const typed = String(form.get('description') ?? '').trim();
	const stem = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
	const description = typed || stem;
	const name = String(form.get('name') ?? '').trim() || nameFromDescription(description, kind);

	// Which conversation this was started in, so the six views can be posted
	// back into it rather than into whatever is on screen when they land.
	const sessionSlug = String(form.get('sessionSlug') ?? '').trim();
	const sheet = addSheet({
		kind,
		name,
		description,
		bytes,
		ext: looksJpeg ? '.jpg' : looksWebp ? '.webp' : '.png',
		uploaded: true,
		...(sessionSlug ? { sessionSlug } : {})
	});

	// Characters get a turnaround built from the picture, in the background and
	// without a word about it. Locations do not: a room does not have a front and
	// a back the way a person does, and a camera orbiting a photograph of one is
	// a different problem that has not been tried.
	if (kind === 'character') {
		void fetchFn('/studio/api/turnaround', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			// `typed`, not the stored description: with nothing typed the description
			// falls back to the filename, and "Screenshot 2026 08 25 at 23.23.38" in
			// a render prompt is worse than no description at all.
			body: JSON.stringify({ id: sheet.id, look: typed })
		}).catch(() => {
			// A character that exists is the product here. The sheet is an
			// improvement to it, and one that fails to start is not worth telling
			// anyone about — nobody asked for it.
		});
	}

	return json({ ok: true, sheet, sheets: listSheets(), uploaded: true });
}

export const POST: RequestHandler = async ({ request, fetch }) => {
	// An upload arrives as a form because it arrives as bytes. Everything else on
	// this route is JSON, so the content type is the fork.
	if ((request.headers.get('content-type') ?? '').includes('multipart/form-data')) {
		return await fromUpload(request, fetch);
	}

	let body: {
		kind?: unknown;
		name?: unknown;
		description?: unknown;
		voice?: unknown;
		workspace?: unknown;
		artifact?: unknown;
		file?: unknown;
		job?: unknown;
		seed?: unknown;
		sessionSlug?: unknown;
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
	const voice = typeof body.voice === 'string' ? body.voice : '';

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
			...(voice ? { voice } : {}),
			...(seed !== undefined ? { seed } : {}),
			...(typeof body.sessionSlug === 'string' && body.sessionSlug.trim()
				? { sessionSlug: body.sessionSlug.trim() }
				: {})
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
		...(voice ? { voice } : {}),
		workspace
	});
	return json({ ok: true, sheet, sheets: listSheets() });
};

export const PATCH: RequestHandler = async ({ request }) => {
	let body: {
		id?: unknown;
		name?: unknown;
		description?: unknown;
		voice?: unknown;
		delivered?: unknown;
	};
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON');
	}
	// The voice is edited on its own — the control for it sits next to the
	// character and has nothing to do with renaming, so requiring a name here
	// would mean every voice edit had to re-send one and could clobber it.
	// Delivered is its own edit for the same reason the voice is: it arrives on
	// its own, from the card that showed the six views, and folding it into the
	// rename would mean every delivery had to re-send a name it might clobber.
	if (typeof body.id === 'string' && body.delivered === true) {
		const row = markSheetDelivered(body.id);
		if (!row) return json({ ok: false, error: 'no such sheet' }, { status: 200 });
		return json({ ok: true, sheet: row, sheets: listSheets() });
	}
	// Whichever fields came, in one edit.
	//
	// These used to be alternatives: a voice-only branch guarded on the name
	// being absent, then a rename. That held while the two controls lived on
	// different screens. The character's own card now carries both, and one
	// Update button sending both landed in the rename branch — which took the
	// name, ignored the voice, and answered ok, so the field kept its new text
	// on screen and lost it on reload.
	if (typeof body.id !== 'string') throw error(400, 'id is required');
	if (typeof body.name !== 'string' && typeof body.voice !== 'string') {
		throw error(400, 'name or voice is required');
	}
	let row: Sheet | null = null;
	if (typeof body.voice === 'string') row = setSheetVoice(body.id, body.voice);
	if (typeof body.name === 'string') {
		row =
			renameSheet(
				body.id,
				body.name,
				typeof body.description === 'string' ? body.description : undefined
			) ?? row;
	}
	if (!row) return json({ ok: false, error: 'no such sheet' }, { status: 200 });
	return json({ ok: true, sheet: row, sheets: listSheets() });
};

export const DELETE: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id') ?? '';
	if (!id) throw error(400, 'id is required');
	const gone = removeSheet(id);
	return json({ ok: gone, sheets: listSheets() });
};
