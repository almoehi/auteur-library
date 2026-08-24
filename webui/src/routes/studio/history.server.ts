/** Every production that has been started, so you can go back to one.
 *
 *  Until now a run existed only in the tab that launched it: close it and the
 *  film was still on the harness but unreachable from here, because nothing
 *  remembered its workspace id. This is that memory.
 *
 *  On disk next to the rest of the studio's state rather than in a database —
 *  same reason as the library and the tuning overrides: one user, one machine,
 *  and being able to open the file and delete a bad line is worth more than any
 *  query it would gain.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), 'auteur', 'studio-library');
const FILE = join(DIR, 'history.json');

/** Enough to scroll through a few weeks of work; past that the list stops being
 *  a memory and becomes an archive nobody reads. */
const KEEP = 60;

export interface Production {
	/** The brief slug — unique per launch, and the id both workspaces derive
	 *  from, which is what makes it the right key here. */
	slug: string;
	title: string;
	sceneCount: number;
	/** Both are stored because reopening needs to know how far the run got: a
	 *  production with a render workspace resumes into the shoot, one without
	 *  resumes into the plan. */
	planningWs?: string;
	renderWs?: string;
	startedAt: number;
	updatedAt: number;
	/** The pitch, for the list — a title alone rarely says which film this was.
	 *  Truncated on the way in, because the list is all it is for. */
	pitch?: string;
	/** Simple mode only, and stored whole: there the prompt is not a description
	 *  of the work, it is the work. Re-rendering one setting against another
	 *  needs the previous text back character for character, and the truncated
	 *  pitch cannot give it — the first comparison run had to be reconstructed by
	 *  hand from the browser tab that launched it. */
	prompt?: string;
}

function read(): Production[] {
	try {
		if (!existsSync(FILE)) return [];
		const parsed: unknown = JSON.parse(readFileSync(FILE, 'utf8'));
		if (!Array.isArray(parsed)) return [];
		return (parsed as Production[]).filter((p) => p?.slug);
	} catch {
		// A corrupt history costs you the list, never the studio.
		return [];
	}
}

function write(rows: Production[]): void {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
	writeFileSync(FILE, JSON.stringify(rows.slice(0, KEEP), null, 2), 'utf8');
}

export function listProductions(): Production[] {
	return read().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Insert or update by slug. Called twice per production — once when planning
 *  opens and again when the shoot does — so it has to merge rather than replace,
 *  or the second call would erase the pitch the first one recorded. */
export function recordProduction(p: Partial<Production> & { slug: string }): Production {
	const rows = read();
	const existing = rows.find((r) => r.slug === p.slug);
	const merged: Production = {
		slug: p.slug,
		title: p.title ?? existing?.title ?? p.slug,
		sceneCount: p.sceneCount ?? existing?.sceneCount ?? 0,
		planningWs: p.planningWs ?? existing?.planningWs,
		renderWs: p.renderWs ?? existing?.renderWs,
		pitch: p.pitch ?? existing?.pitch,
		prompt: p.prompt ?? existing?.prompt,
		startedAt: existing?.startedAt ?? p.startedAt ?? Date.now(),
		updatedAt: Date.now()
	};
	write([merged, ...rows.filter((r) => r.slug !== p.slug)]);
	return merged;
}

export function forgetProduction(slug: string): boolean {
	const rows = read();
	if (!rows.some((r) => r.slug === slug)) return false;
	// Only the entry goes. The workspaces stay on the harness, where they are
	// immutable anyway — this list is a bookmark, not the film.
	write(rows.filter((r) => r.slug !== slug));
	return true;
}
