/** Where a tuned prompt lives between productions.
 *
 *  A JSON file next to the harness, not a database: this surface is a local,
 *  single-user tool, and the whole point is that a person can also open the
 *  file, read it, and delete a line that broke something. The shipped defaults stay in
 *  tunables.ts and are never written here — the file only ever holds deltas, so
 *  an empty or missing file means "everything is stock".
 *
 *  Every write keeps the previous version alongside it. A bad prompt does not
 *  announce itself: it produces a slightly worse film twenty minutes later, and
 *  by then you want to know what changed and when.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Overrides } from './tunables';

const DIR = join(homedir(), 'auteur', 'studio-tuning');
const FILE = join(DIR, 'overrides.json');
const HISTORY = join(DIR, 'history');

/** Keep the last N snapshots. Enough to walk back a bad afternoon, not enough
 *  to become a filesystem problem. */
const KEEP = 40;

export interface StoredOverrides extends Overrides {
	/** When this version was written, for the panel's "last changed" line. */
	updatedAt?: string;
}

function ensureDirs(): void {
	if (!existsSync(HISTORY)) mkdirSync(HISTORY, { recursive: true });
}

export function readOverrides(): StoredOverrides {
	try {
		if (!existsSync(FILE)) return {};
		const parsed: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
		if (!parsed || typeof parsed !== 'object') return {};
		const o = parsed as StoredOverrides;
		return {
			prompts: o.prompts && typeof o.prompts === 'object' ? o.prompts : {},
			models: o.models && typeof o.models === 'object' ? o.models : {},
			updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : undefined
		};
	} catch {
		// A corrupt file must not take the studio down with it — stock defaults
		// are always a valid state to fall back to.
		return {};
	}
}

/** Snapshot the current file, then write the new one. Snapshot first: if the
 *  write fails, the history still holds what was there. */
export function writeOverrides(next: Overrides): StoredOverrides {
	ensureDirs();

	if (existsSync(FILE)) {
		try {
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			writeFileSync(join(HISTORY, `${stamp}.json`), readFileSync(FILE, 'utf8'), 'utf8');
			prune();
		} catch {
			/* history is a convenience; never block a save on it */
		}
	}

	const stored: StoredOverrides = {
		prompts: next.prompts ?? {},
		models: next.models ?? {},
		updatedAt: new Date().toISOString()
	};
	writeFileSync(FILE, JSON.stringify(stored, null, 2), 'utf8');
	return stored;
}

function prune(): void {
	const files = readdirSync(HISTORY)
		.filter((f) => f.endsWith('.json'))
		.map((f) => ({ f, t: statSync(join(HISTORY, f)).mtimeMs }))
		.sort((a, b) => b.t - a.t);
	for (const { f } of files.slice(KEEP)) {
		try {
			writeFileSync(join(HISTORY, f), '');
		} catch {
			/* ignore */
		}
	}
}

/** Absolute path, shown in the panel so the file is findable without guessing. */
export const OVERRIDES_PATH = FILE;
