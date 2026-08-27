/** What a batch of parallel renders is, and where it is written down.
 *
 *  A batch is several takes of one beat, launched at once. It exists because the
 *  alternative — four sequential rounds with a person in each gap — costs four
 *  cold starts and most of an afternoon, while the harness will run four at once
 *  (RENDER_PARALLELISM=4) and the container stays warm across them.
 *
 *  Written to disk rather than kept in memory, and for a reason this project has
 *  learned twice today: a render outlives the process that started it. An
 *  in-memory row is a row that a dev-server restart turns into a batch that
 *  renders on a GPU and is never collected by anybody.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), 'auteur', 'studio-library');
const FILE = join(DIR, 'batches.json');

/** Longer than any render has ever taken, and longer than the harness's own
 *  patience. A row still claiming to render after this is a row whose process
 *  died — reported as failed rather than left spinning for ever. */
const STALE_MS = 45 * 60 * 1000;

export interface BatchRun {
	/** The batch these takes belong to, so the page can group them. */
	batch: string;
	/** This take's own slug and workspace — one per render, unchanged from the
	 *  single-clip path, so the render log, the chain and the clip cache all stay
	 *  keyed exactly as they were. */
	slug: string;
	workspace: string;
	seed: number;
	/** Which take this is, 1-based, for a label that means something. */
	index: number;
	at: string;
	state: 'rendering' | 'ready' | 'failed';
	error?: string;
	/** Where the finished clip landed, addressable by the page. */
	clip?: { workspace: string; artifact: string; file: string };
}

function ensure(): void {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

/** A run nobody is rendering any more. Read-side, so a process that IS still
 *  working recovers on its own the moment it writes a result. */
function stale(r: BatchRun): BatchRun {
	if (r.state !== 'rendering') return r;
	const began = Date.parse(r.at);
	if (!Number.isFinite(began) || Date.now() - began < STALE_MS) return r;
	return { ...r, state: 'failed', error: 'the render was interrupted' };
}

export function listRuns(): BatchRun[] {
	ensure();
	try {
		if (!existsSync(FILE)) return [];
		const parsed: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
		if (!Array.isArray(parsed)) return [];
		return (parsed as BatchRun[]).filter((r) => r?.batch && r?.slug).map(stale);
	} catch {
		return [];
	}
}

/** Written through a temporary file and renamed.
 *
 *  Several takes finish at once by design, so several writers race here. A
 *  half-written batches.json would take the whole record with it; a rename is
 *  atomic on the same filesystem, so a reader sees either the old file or the
 *  new one. */
function write(rows: BatchRun[]): void {
	ensure();
	const tmp = `${FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf8');
	renameSync(tmp, FILE);
}

export function addRuns(runs: BatchRun[]): void {
	write([...listRuns(), ...runs].slice(-200));
}

export function updateRun(slug: string, patch: Partial<BatchRun>): void {
	const rows = listRuns();
	const i = rows.findIndex((r) => r.slug === slug);
	if (i < 0) return;
	rows[i] = { ...rows[i], ...patch };
	write(rows);
}
