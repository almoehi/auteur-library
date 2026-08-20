/** Reference files staged for the next production.
 *
 *  These are the images and clips you hand the crew — a face to keep, a room to
 *  match, a movement to copy. They are staged here rather than uploaded on
 *  arrival because there is nowhere to put them yet: the harness holds
 *  artifacts inside a workspace, and the workspace that will need them does not
 *  exist until you approve the plan.
 *
 *  One important limit, worth knowing before you attach anything: the agents
 *  cannot see these files. Every model in the registry is chat-only — no
 *  vision. What reads a reference is the render workflow itself (minimax takes
 *  reference-to-video input), so a reference works by being handed to a render,
 *  not by being described by a writer. The description you give each file is
 *  what the agents read, and it is the only thing they have.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), 'auteur', 'studio-library', 'refs');
const MANIFEST = join(DIR, 'manifest.json');

/** Big enough for a reference clip, small enough that a mis-drag of a whole
 *  film does not silently occupy the disk. */
export const MAX_REF_BYTES = 200 * 1024 * 1024;

export interface RefFile {
	/** Stored name on disk, unique within the staging area. */
	stored: string;
	/** What the user's file was called — this is what the agents see. */
	name: string;
	description: string;
	size: number;
	addedAt: string;
}

function ensure(): void {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export function listRefs(): RefFile[] {
	ensure();
	try {
		if (!existsSync(MANIFEST)) return [];
		const parsed: unknown = JSON.parse(readFileSync(MANIFEST, 'utf8'));
		if (!Array.isArray(parsed)) return [];
		// Drop entries whose file went missing — a manifest that promises a file
		// the import will not find is worse than a short list.
		return (parsed as RefFile[]).filter((r) => r?.stored && existsSync(join(DIR, r.stored)));
	} catch {
		return [];
	}
}

function writeManifest(rows: RefFile[]): void {
	ensure();
	writeFileSync(MANIFEST, JSON.stringify(rows, null, 2), 'utf8');
}

/** Stored under a name that cannot collide or escape the directory, while the
 *  original name travels in the manifest for the agents to read. */
export function addRef(name: string, description: string, bytes: Uint8Array): RefFile {
	ensure();
	const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').slice(-60) || 'file';
	const stored = `${Date.now().toString(36)}-${Math.abs(hash(name)).toString(36)}-${safe}`;
	writeFileSync(join(DIR, stored), bytes);
	const row: RefFile = {
		stored,
		name,
		description: description.trim(),
		size: bytes.byteLength,
		addedAt: new Date().toISOString()
	};
	writeManifest([...listRefs(), row]);
	return row;
}

export function describeRef(stored: string, description: string): boolean {
	const rows = listRefs();
	const row = rows.find((r) => r.stored === stored);
	if (!row) return false;
	row.description = description.trim();
	writeManifest(rows);
	return true;
}

export function removeRef(stored: string): boolean {
	const rows = listRefs();
	const row = rows.find((r) => r.stored === stored);
	if (!row) return false;
	try {
		rmSync(join(DIR, stored));
	} catch {
		/* the manifest is the record that matters */
	}
	writeManifest(rows.filter((r) => r.stored !== stored));
	return true;
}

export function readRef(stored: string): Buffer | null {
	try {
		return readFileSync(join(DIR, stored));
	} catch {
		return null;
	}
}

/** Called once the files have been imported into a workspace. Staging is for
 *  the *next* production; leaving them would silently attach a face from last
 *  week to the next film. */
export function clearRefs(): void {
	for (const r of listRefs()) {
		try {
			rmSync(join(DIR, r.stored));
		} catch {
			/* ignore */
		}
	}
	try {
		if (existsSync(MANIFEST)) rmSync(MANIFEST);
	} catch {
		/* ignore */
	}
	// Anything left behind is an orphan from an interrupted write.
	try {
		for (const f of readdirSync(DIR)) if (f !== 'manifest.json') rmSync(join(DIR, f));
	} catch {
		/* ignore */
	}
}

function hash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	return h;
}

export const REFS_PATH = DIR;
