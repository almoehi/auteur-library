/** One line per assembled film: where it is, what went into it, and when.
 *
 *  Export writes a real file and, until this existed, told nobody. The mp4 sat
 *  in the clip cache under the last shot's workspace, the only reference to it
 *  was a card in a transcript that a reload throws away, and the next morning
 *  there was no way to answer "where is the film I made yesterday" except by
 *  making it again. The clips learned this lesson first — a file you cannot
 *  address is a file you have lost — and this is the same fix for the thing that
 *  is actually the product.
 *
 *  JSONL beside the render log, appended, same directory. One line per film
 *  means a partial write costs one row rather than the file, and you can read it
 *  with tail. It is not a database and should not become one.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), 'auteur', 'studio-library');
const FILE = join(DIR, 'films.jsonl');

export interface FilmRow {
	/** The three ids that fetch it, the same shape a clip is addressed by. */
	workspace: string;
	artifact: string;
	file: string;
	/** How many shots went in, and how long it runs. Both are what you scan a
	 *  list of films by — a title would be a guess, and there is nothing to guess
	 *  one from. */
	parts: number;
	seconds: number;
	at: number;
	/** What the shots were, so a film can say what it is made of without a second
	 *  lookup. Their workspaces only: the addresses live on the render log. */
	shots?: string[];
}

function ensure(): void {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export function recordFilm(row: FilmRow): void {
	try {
		ensure();
		appendFileSync(FILE, JSON.stringify(row) + '\n', 'utf8');
	} catch {
		// An export that produced a file must not report failure because the
		// bookkeeping did. The film is the product; this is the note about it.
	}
}

export function readFilms(): FilmRow[] {
	try {
		if (!existsSync(FILE)) return [];
		const out: FilmRow[] = [];
		for (const line of readFileSync(FILE, 'utf8').split('\n')) {
			if (!line.trim()) continue;
			try {
				const row = JSON.parse(line) as FilmRow;
				if (row?.workspace && row.artifact && row.file) out.push(row);
			} catch {
				// One unreadable line is one lost film, not a lost list.
			}
		}
		// Newest first, which is the order anything looks at them in.
		return out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
	} catch {
		return [];
	}
}
