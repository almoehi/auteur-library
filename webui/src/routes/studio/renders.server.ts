/** One line per clip: what was asked for, what it was rendered with, and — when
 *  it is known — how it turned out.
 *
 *  Nothing has been recording this. The settings that produced a good clip lived
 *  in the workspace YAML the harness printed at launch and nowhere else, which
 *  is why answering "what were the adapters on that one?" this afternoon meant
 *  reading a Docker log. Worse, the one honest quality signal in the whole app
 *  was being thrown away: when you change the adapters on a card before sending
 *  it, that is a labelled correction of the writer's judgement, free and exact,
 *  and it vanished the moment the render started.
 *
 *  So both are written down. The writer's own choice and the launched choice are
 *  kept as separate fields rather than one field overwritten, because the
 *  difference between them is the entire point — a row where they agree says
 *  the writer was left alone, and a row where they differ says precisely how it
 *  was wrong.
 *
 *  JSONL, appended, in the same directory as the rest of the studio's state. One
 *  line per clip means a partial write costs one row rather than the file, tail
 *  works, and you can read it without a tool. It is not a database and should
 *  not become one.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIR = join(homedir(), 'auteur', 'studio-library');
const FILE = join(DIR, 'renders.jsonl');

export interface RenderPick {
	key: string;
	strength: number;
}

export interface RenderRow {
	/** The render workspace, which is what later facts are keyed by. */
	workspace: string;
	slug: string;
	at: number;

	/** What you typed. */
	request: string;
	/** What the writer produced from it — the literal text the model received. */
	prompt: string;

	/** The adapters the writer chose. Never overwritten. */
	wrote: RenderPick[];
	/** The adapters the render actually ran with. Equal to `wrote` unless you
	 *  changed them on the card, and the gap between the two is the signal. */
	launched: RenderPick[];

	steps: number;
	width: number;
	height: number;
	seconds: number;
	fps: number;
	seed: number;

	/** The character and location this clip was shot with, if any.
	 *
	 *  Recorded because a clip is not only a file — it is a shot of someone,
	 *  somewhere, and the next thing you want from it is usually more of the same
	 *  scene. Continuing a clip needs both by id, and until now the render log
	 *  kept every other detail of a run and not these two, so the answer lived
	 *  only in the chat transcript of the tab that launched it.
	 *
	 *  The names are kept beside the ids on purpose. An id resolves to nothing
	 *  once a character is deleted, and "shot with someone you have since removed"
	 *  is a more useful thing to be able to say than a dangling identifier. */
	characterId?: string;
	characterName?: string;
	locationId?: string;
	locationName?: string;

	/** Launch to terminal, as this app saw it — so it includes the workspace
	 *  opening, any model downloads, and up to one poll interval of lag. It is a
	 *  wall clock, not the GPU's number, and is named for what it is: the GPU's
	 *  own timing lives in the Modal logs and is not worth a round trip to fetch
	 *  for a figure that is only ever read as "about how long did that take". */
	wallSeconds?: number;
	/** What became of the clip. `kept` and `rejected` need a person to say so;
	 *  `failed` the harness can say on its own. */
	outcome?: 'kept' | 'rejected' | 'failed';
	/** What was wrong with it, in your words.
	 *
	 *  A verdict alone says a clip missed; it does not say whether the anatomy
	 *  came apart, the motion stalled, or it simply rendered something other than
	 *  what was asked for — and those want three different fixes. This is the
	 *  field that makes a rejection actionable instead of merely counted. */
	note?: string;
}

function ensure(): void {
	if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
}

export function recordRender(row: RenderRow): void {
	try {
		ensure();
		appendFileSync(FILE, JSON.stringify(row) + '\n', 'utf8');
	} catch {
		// A render that succeeded must not be reported as failed because the
		// bookkeeping did. This log is evidence, not the product.
	}
}

export function readRenders(): RenderRow[] {
	try {
		if (!existsSync(FILE)) return [];
		const out: RenderRow[] = [];
		for (const line of readFileSync(FILE, 'utf8').split('\n')) {
			if (!line.trim()) continue;
			try {
				const row = JSON.parse(line) as RenderRow;
				if (row?.workspace) out.push(row);
			} catch {
				// One malformed line is one lost clip, not a lost log.
			}
		}
		return out;
	} catch {
		return [];
	}
}

/** Add what was not known at launch — how long the render took, what you made of
 *  it — to the row for one workspace.
 *
 *  Rewrites the file rather than appending a patch line. At the scale this runs
 *  at, a few thousand rows at most, reading and writing the whole thing is
 *  cheaper to reason about than replaying an event log, and the temp-then-rename
 *  keeps a crash from costing the history. If it ever grows enough for that to
 *  hurt, the honest fix is to stop keeping every row, not to make this cleverer.
 */
export function updateRender(workspace: string, patch: Partial<RenderRow>): boolean {
	const rows = readRenders();
	const i = rows.findIndex((r) => r.workspace === workspace);
	if (i < 0) return false;
	rows[i] = { ...rows[i], ...patch, workspace: rows[i].workspace };
	try {
		ensure();
		const tmp = `${FILE}.part`;
		writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
		renameSync(tmp, FILE);
		return true;
	} catch {
		return false;
	}
}

/** The rows where you overruled the writer, newest first.
 *
 *  This is the shape step three wants, and the reason the two adapter lists are
 *  stored separately. Feeding the writer its whole history would grow the prompt
 *  on every render and buy almost nothing — the rows where it was already right
 *  teach it nothing it does not already do. The corrections are the small,
 *  interesting minority, and a handful of them is a short prompt.
 */
export function corrections(limit = 20): RenderRow[] {
	const same = (a: RenderPick[], b: RenderPick[]) =>
		a.length === b.length &&
		[...a].sort((x, y) => x.key.localeCompare(y.key)).every((p, i) => {
			const q = [...b].sort((x, y) => x.key.localeCompare(y.key))[i];
			return p.key === q.key && p.strength === q.strength;
		});
	return readRenders()
		.filter((r) => !same(r.wrote ?? [], r.launched ?? []))
		.reverse()
		.slice(0, limit);
}

export const RENDERS_PATH = FILE;
