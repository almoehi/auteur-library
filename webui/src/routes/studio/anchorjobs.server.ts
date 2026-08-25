/** Character previews in flight, and the pictures they produced.
 *
 *  A preview takes about two minutes. Holding an HTTP request open for that long
 *  works until the tab reloads, and then a render nobody can reach is still
 *  costing GPU time — so the render runs here, detached, and the page asks how it
 *  is doing.
 *
 *  The bytes are copied to disk the moment they arrive. The S3 URL the worker
 *  uploads to is presigned and expires, and it points at a bucket the browser has
 *  no business holding a credentialled link to; a local copy is both longer-lived
 *  and less to explain. It also means keeping a preview later reads a file rather
 *  than racing an expiry.
 *
 *  In-memory index on purpose. A preview is worth two minutes of attention and
 *  nothing after that: what survives a restart is a sheet you kept, which lives
 *  in the sheets store and is a different thing.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), 'auteur', 'studio-library', 'previews');

export type JobPhase = 'running' | 'done' | 'failed';

export interface AnchorJob {
	id: string;
	phase: JobPhase;
	/** What the render was asked for, carried so the card can show it without the
	 *  page having to remember across a reload. */
	description: string;
	seed: number;
	startedAt: number;
	finishedAt?: number;
	error?: string;
	/** Seconds the worker itself reported, which is the honest render number —
	 *  the wall time also contains a cold container. */
	elapsedSec?: number;
}

const JOBS = new Map<string, AnchorJob>();

const ID_OK = /^[a-z0-9-]{6,60}$/;

function ensure(): void {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

function pathFor(id: string): string | null {
	return ID_OK.test(id) ? join(DIR, `${id}.png`) : null;
}

export function startJob(id: string, description: string, seed: number): AnchorJob {
	const job: AnchorJob = { id, phase: 'running', description, seed, startedAt: Date.now() };
	JOBS.set(id, job);
	return job;
}

export function failJob(id: string, error: string): void {
	const job = JOBS.get(id);
	if (!job) return;
	job.phase = 'failed';
	job.error = error;
	job.finishedAt = Date.now();
}

export function finishJob(id: string, bytes: Uint8Array, elapsedSec?: number): void {
	const job = JOBS.get(id);
	const p = pathFor(id);
	if (!job || !p) return;
	try {
		ensure();
		writeFileSync(p, bytes);
		job.phase = 'done';
		job.elapsedSec = elapsedSec;
		job.finishedAt = Date.now();
		prune();
	} catch (e) {
		failJob(id, `the picture arrived but could not be saved — ${e}`);
	}
}

export function getJob(id: string): AnchorJob | null {
	return JOBS.get(id) ?? null;
}

export function readPreview(id: string): Buffer | null {
	const p = pathFor(id);
	if (!p || !existsSync(p)) return null;
	try {
		return readFileSync(p);
	} catch {
		return null;
	}
}

/** Previews are working files. A kept sheet has already been copied into the
 *  sheets store by the time it matters, so nothing here is the only copy of
 *  anything. */
function prune(keep = 40): void {
	try {
		if (!existsSync(DIR)) return;
		const files = readdirSync(DIR)
			.filter((n) => n.endsWith('.png'))
			.map((n) => ({ n, at: statSync(join(DIR, n)).mtimeMs }))
			.sort((a, b) => b.at - a.at);
		for (const f of files.slice(keep)) {
			rmSync(join(DIR, f.n), { force: true });
			JOBS.delete(f.n.replace(/\.png$/, ''));
		}
	} catch {
		// Housekeeping is not worth failing a render over.
	}
}
