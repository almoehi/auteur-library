/** Character and location sheets — the things a production keeps.
 *
 *  A sheet is one image holding six views of the same subject: for a character,
 *  front full-body, face close-up, both profiles, rear and one expression; for a
 *  location, six locked-off views of the same place. The continuation workflow
 *  requires one of each, and that is what they are for — you make a character
 *  once and every clip afterwards is the same person.
 *
 *  This is deliberately NOT the `refs` directory next door, and the distinction
 *  matters enough to state: `clearRefs()` deletes every file staged there after
 *  each launch, because staged references belong to one render. A sheet belongs
 *  to a production and has to survive hundreds of them. Nothing here is ever
 *  cleared on a launch; removal is a thing you ask for.
 *
 *  It is also not the clips cache. That store is content-addressed by the
 *  (workspace, artifact, file) triple and has no index, so nothing can list what
 *  is in it — fine for a clip you reopen from the transcript that names it,
 *  useless for an asset you pick from a list months later.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

const DIR = join(homedir(), 'auteur', 'studio-library', 'sheets');
const MANIFEST = join(DIR, 'manifest.json');

/** A sheet is one PNG from a render, not an upload — the size is the model's
 *  business. The cap only exists so a corrupt or wildly wrong response cannot
 *  quietly fill the disk. */
export const MAX_SHEET_BYTES = 40 * 1024 * 1024;

export type SheetKind = 'character' | 'location';

/** The six-view turnaround, which arrives after the character does.
 *
 *  Saving a character is instant — it keeps the preview you just approved — and
 *  the sheet renders behind you. That order is deliberate: the turnaround costs
 *  three minutes and the character is usable without it, so making the save wait
 *  for it would be charging you for something you have not asked to look at yet. */
export interface SheetRender {
	state: 'rendering' | 'ready' | 'failed';
	/** Stored filename of the six-view image, once there is one. */
	file?: string;
	error?: string;
	startedAt?: string;
	/** The workspace it rendered in, for tracing a sheet back to its run. */
	workspace?: string;
	/** Which attempt this is. One automatic retry, then it stops and waits for a
	 *  person — see the note in api/sheetfull. */
	attempt?: number;
	/** The turnaround clip the six views were cut out of, by the three ids the
	 *  clip store addresses bytes with.
	 *
	 *  Kept because the video is worth seeing: it is the evidence behind the
	 *  sheet, and when a view looks wrong it is the only place the reason shows.
	 *  Absent for sheets drawn from a description, which have no clip. */
	clip?: { workspace: string; artifact: string; file: string };
}

export interface Sheet {
	/** Our own handle. Also the stored basename, so the file is findable by
	 *  hand in the folder without consulting the manifest. */
	id: string;
	kind: SheetKind;
	/** What you call it. Starts as something derived from the description and is
	 *  yours to change — this is the label every later picker shows. */
	name: string;
	/** The description that produced it, kept verbatim. It is what you would
	 *  edit to make a variant, and it is the only record of why this sheet looks
	 *  the way it does. */
	description: string;
	/** Stored filename, extension included. */
	file: string;
	size: number;
	addedAt: string;
	/** The workspace that rendered it, for tracing a sheet back to its run. */
	workspace?: string;
	/** The seed the profile picture was rendered with. Carried so the six-view
	 *  sheet is a turnaround of the face you approved rather than a new one. */
	seed?: number;
	/** This subject is a picture you supplied rather than one we drew.
	 *
	 *  It changes where its turnaround comes from — a drawn character gets one
	 *  from the sheet workflow, an uploaded one from a rendered turn of the
	 *  photograph — and it changes what the library says while that is happening,
	 *  which is nothing. You attached a picture; you did not ask for a render. */
	uploaded?: boolean;
	/** How this person sounds, in one sentence, carried into every clip they are
	 *  in.
	 *
	 *  The face has a sheet; without this the voice had nothing. Each clip is an
	 *  independent roll, so a brief that says nothing about the voice does not
	 *  produce a clip without one — it produces a clip whose voice the model
	 *  chose, and it chooses a different one every time. Two clips, one scene,
	 *  two women.
	 *
	 *  A description rather than a recording, because that is what the model
	 *  reads: the same sentence pulls the same voice back, measured on one pair
	 *  and worth re-checking across different scenes. Only meaningful on a
	 *  character; a room does not speak.
	 *
	 *  Nobody types this. It is filled in from the clip the character was kept
	 *  from, and the field exists for changing it afterwards. */
	voice?: string;
	/** The working session this subject was made in.
	 *
	 *  The turnaround runs for minutes on a server that does not care which tab
	 *  is open, and the card announcing it used to be posted into whatever
	 *  conversation happened to be on screen when the poll caught it finishing.
	 *  Start a character, switch sessions, and the six views landed in the middle
	 *  of unrelated work.
	 *
	 *  Absent on everything made before this existed, and absent means "any" —
	 *  those keep the old behaviour rather than becoming undeliverable. */
	sessionSlug?: string;
	/** Set once the six views have been shown in their session.
	 *
	 *  Without it the sidebar cannot tell "finished while you were elsewhere"
	 *  from "finished and you have seen it", and the dot marking the first would
	 *  never go out. Server-side rather than in the tab, because the wait
	 *  outlives the tab and so must the answer. */
	delivered?: boolean;
	/** The turnaround, absent until one has been asked for. */
	sheet?: SheetRender;
}

function ensure(): void {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

/** A turnaround nobody is still rendering.
 *
 *  'rendering' is written to the manifest, on disk, but the only thing that can
 *  clear it is a loop inside the process that started it. Restart the dev
 *  server mid-render and that loop is gone while the word stays — so the row
 *  says rendering for ever. It is not only a stuck spinner: the POST refuses to
 *  start another turnaround for a character already rendering one, so the
 *  character is locked out of every future attempt, and the sidebar's dot
 *  pulses for work that stopped hours ago.
 *
 *  Read-side rather than a repair written back, so a process that IS still
 *  working recovers on its own the moment it finishes. The cutoff is longer
 *  than either deadline that could still be counting down.
 */
const STALE_MS = 30 * 60 * 1000;

function stale(s: Sheet): Sheet {
	const r = s.sheet;
	if (!r || r.state !== 'rendering') return s;
	const began = r.startedAt ? Date.parse(r.startedAt) : NaN;
	if (!Number.isFinite(began) || Date.now() - began < STALE_MS) return s;
	return { ...s, sheet: { ...r, state: 'failed', error: 'the turnaround was interrupted' } };
}

export function listSheets(): Sheet[] {
	ensure();
	try {
		if (!existsSync(MANIFEST)) return [];
		const parsed: unknown = JSON.parse(readFileSync(MANIFEST, 'utf8'));
		if (!Array.isArray(parsed)) return [];
		// A row whose file has gone is worse than a missing row: every picker
		// would offer it and every render using it would fail late, on the GPU.
		return (parsed as Sheet[])
			// Only the profile picture decides whether a character exists. A missing
			// turnaround is a turnaround that failed or has not arrived, not a
			// reason to forget the person.
			.filter((s) => s?.id && s?.file && existsSync(join(DIR, s.file)))
			.map(stale)
			.sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
	} catch {
		return [];
	}
}

function writeManifest(rows: Sheet[]): void {
	ensure();
	writeFileSync(MANIFEST, JSON.stringify(rows, null, 2), 'utf8');
}

/** Ids are ours and are used as filesystem paths, so they are generated rather
 *  than derived from anything a caller typed. */
const ID_OK = /^[a-z0-9]{6,40}$/;

function mkId(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** A first name for a sheet, taken from its own description.
 *
 *  Every sheet needs a label the moment it exists, because the picker that shows
 *  it may be opened before you have got round to naming it. The first few words
 *  of what you asked for are a better guess than "Sheet 3". */
export function nameFromDescription(description: string, kind: SheetKind): string {
	const all = description.replace(/[\n\r]+/g, ' ').split(/\s+/).filter(Boolean);
	const words = all.slice(0, 6).join(' ').slice(0, 60).trim();
	if (!words) return kind === 'character' ? 'Character' : 'Location';
	// Say it is shortened, when it is.
	//
	// A name cut out of a description stops mid-sentence, and the card announces
	// it as "Kept as <name>" — which reads exactly like the sentence you typed
	// having been truncated on its way to the render. It has not been: the
	// description is stored whole and the whole of it is what the render gets.
	// But a label that looks like data loss costs someone the trust to keep
	// typing, and one character fixes it.
	const cut = all.length > 6 || words.length < description.trim().length;
	return cut ? `${words.replace(/[.,;:]$/, '')}…` : words;
}

export function addSheet(row: {
	kind: SheetKind;
	name: string;
	description: string;
	bytes: Uint8Array;
	ext?: string;
	workspace?: string;
	seed?: number;
	uploaded?: boolean;
	/** Written alongside the description by the same call, so a character has a
	 *  voice from the moment they exist rather than an empty field somebody has
	 *  to notice. Characters only. */
	voice?: string;
	sessionSlug?: string;
}): Sheet {
	ensure();
	const id = mkId();
	// The extension is kept because these are opened from Finder as often as
	// from the app, and because the browser is entitled to a content type.
	const ext = (row.ext || '.png').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.png';
	const file = `${id}${ext.startsWith('.') ? ext : `.${ext}`}`;
	writeFileSync(join(DIR, file), row.bytes);
	const sheet: Sheet = {
		id,
		kind: row.kind,
		name: row.name.trim() || nameFromDescription(row.description, row.kind),
		description: row.description.trim(),
		...(row.kind === 'character' && row.voice?.trim()
			? { voice: row.voice.trim().slice(0, 240) }
			: {}),
		file,
		size: row.bytes.byteLength,
		addedAt: new Date().toISOString(),
		...(row.workspace ? { workspace: row.workspace } : {}),
		...(row.seed !== undefined ? { seed: row.seed } : {}),
		...(row.uploaded ? { uploaded: true } : {}),
		...(row.sessionSlug ? { sessionSlug: row.sessionSlug } : {})
	};
	writeManifest([sheet, ...listSheets()]);
	return sheet;
}

/** Mark the six views as shown in their own session.
 *
 *  Called when their session is opened, not when their card is written — a
 *  card is posted once and the mark outlives it, so a session whose six views
 *  were read last week would go on being marked for ever. Until this is set the
 *  sidebar treats a finished sheet as something the session is still owed.
 */
export function markSheetDelivered(id: string): Sheet | null {
	const all = listSheets();
	const row = all.find((s) => s.id === id);
	if (!row) return null;
	if (row.delivered) return row;
	row.delivered = true;
	writeManifest(all);
	return row;
}

export function getSheet(id: string): Sheet | null {
	if (!ID_OK.test(id)) return null;
	return listSheets().find((s) => s.id === id) ?? null;
}

export function readSheet(id: string): Buffer | null {
	const s = getSheet(id);
	if (!s) return null;
	try {
		return readFileSync(join(DIR, s.file));
	} catch {
		return null;
	}
}

/** Mark a character's turnaround as being worked on, or finished, or lost.
 *
 *  Writes the whole manifest each time, which is fine for a list this size and
 *  saves inventing a partial-update path for one field. */
export function setSheetRender(id: string, patch: Partial<SheetRender>): Sheet | null {
	const rows = listSheets();
	const row = rows.find((s) => s.id === id);
	if (!row) return null;
	row.sheet = { state: 'rendering', ...row.sheet, ...patch } as SheetRender;
	writeManifest(rows);
	return row;
}

/** Store the finished turnaround beside the profile picture. */
export function attachSheetImage(
	id: string,
	bytes: Uint8Array,
	workspace?: string,
	clip?: { workspace: string; artifact: string; file: string }
): Sheet | null {
	ensure();
	const rows = listSheets();
	const row = rows.find((s) => s.id === id);
	if (!row) return null;
	const file = `${id}-sheet.png`;
	try {
		writeFileSync(join(DIR, file), bytes);
	} catch (e) {
		row.sheet = { state: 'failed', error: `could not be saved — ${e}` };
		writeManifest(rows);
		return row;
	}
	row.sheet = { state: 'ready', file, ...(workspace ? { workspace } : {}), ...(clip ? { clip } : {}) };
	writeManifest(rows);
	return row;
}

/** The turnaround's bytes, if it has arrived. */
export function readSheetImage(id: string): Buffer | null {
	const s = getSheet(id);
	if (!s?.sheet?.file) return null;
	try {
		const p = join(DIR, s.sheet.file);
		return existsSync(p) ? readFileSync(p) : null;
	} catch {
		return null;
	}
}

/** Rename, and — since it was never editable and needed to be — redescribe.
 *
 *  The description is not decoration on a location. It is the only thing the shot
 *  writer is told about the place, and a plate uploaded without one falls back to
 *  its filename: the writer is handed "IMG 2482", knows nothing about the room,
 *  and invents whatever the act needs. It invented a mattress into a dining room
 *  and said so in its own brief — "the bed staging comes only from the
 *  description below" — and the render obeyed. */
export function renameSheet(id: string, name: string, description?: string): Sheet | null {
	const rows = listSheets();
	const row = rows.find((s) => s.id === id);
	if (!row) return null;
	row.name = name.trim().slice(0, 80) || row.name;
	if (typeof description === 'string' && description.trim()) {
		row.description = description.trim().slice(0, 600);
	}
	writeManifest(rows);
	return row;
}

/** Set or clear the voice. An empty string clears it, which is a real choice —
 *  it puts the character back to letting each clip pick, and there has to be a
 *  way back from a voice you did not mean to keep. */
export function setSheetVoice(id: string, voice: string): Sheet | null {
	const rows = listSheets();
	const row = rows.find((s) => s.id === id);
	if (!row) return null;
	const v = voice.trim().slice(0, 240);
	if (v) row.voice = v;
	else delete row.voice;
	writeManifest(rows);
	return row;
}

export function removeSheet(id: string): boolean {
	const rows = listSheets();
	const row = rows.find((s) => s.id === id);
	if (!row) return false;
	try {
		rmSync(join(DIR, row.file), { force: true });
		if (row.sheet?.file) rmSync(join(DIR, row.sheet.file), { force: true });
	} catch {
		// The manifest row goes either way. A file that will not delete is a
		// smaller problem than a list that keeps offering it.
	}
	writeManifest(rows.filter((s) => s.id !== id));
	return true;
}

export function contentTypeFor(file: string): string {
	const e = extname(file).toLowerCase();
	if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
	if (e === '.webp') return 'image/webp';
	return 'image/png';
}

/** Files sitting in the folder that no manifest row claims. Only used by the
 *  listing endpoint to report a number — nothing deletes them, because a sheet
 *  the manifest lost is exactly the file you would want to recover by hand. */
export function orphanCount(): number {
	ensure();
	try {
		const claimed = new Set(listSheets().flatMap((s) => [s.file, s.sheet?.file].filter(Boolean) as string[]));
		return readdirSync(DIR).filter((n) => n !== 'manifest.json' && !claimed.has(n)).length;
	} catch {
		return 0;
	}
}
