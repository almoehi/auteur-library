/** The harness's event log, turned into sentences.
 *
 *  The harness narrates itself well — dispatches, policy rejections, root-cause
 *  analyses — but only to whoever runs curl against get-event-log. From the
 *  studio a rejected task and a slow task look identical: both are "running",
 *  for as long as the harness keeps retrying. That gap has cost this project
 *  several afternoons, so this file exists to close it.
 *
 *  Pure: events in, display rows out. No fetching, no state.
 */

/** One line as the harness emits it. Everything past `t` and `event` varies by
 *  event type, so the fields are optional and read defensively. */
export interface HarnessEvent {
	t?: string;
	event?: string;
	key?: string;
	taskId?: string;
	attempt?: number;
	reason?: string;
	summary?: string;
	message?: string;
}

export type ActivityTone = 'step' | 'good' | 'warn' | 'bad';

export interface ActivityRow {
	/** Stable across polls, so a row already shown is never shown twice. */
	id: string;
	at: number;
	tone: ActivityTone;
	text: string;
	/** The harness's own words, when they add something the sentence cannot. */
	detail?: string;
}

/** Task keys are machine names; nobody should have to read `write_visual_bible`
 *  in a transcript. Scene keys are numbered rather than listed, because there
 *  can be any number of them. */
function friendly(key: string | undefined): string {
	if (!key) return 'a task';
	const scene = /^shoot_scene_(\d+)$/.exec(key);
	if (scene) return `Scene ${scene[1]}`;
	const named: Record<string, string> = {
		write_screenplay: 'the screenplay',
		character_table: 'the cast list',
		create_scenes: 'the scene list',
		write_art_direction: 'the art direction',
		write_visual_bible: 'the visual bible',
		schedule_video_renders: 'the shooting plan',
		user_reference_material: 'your reference files'
	};
	if (named[key]) return named[key];
	const clip = /^scene_(\d+)_clip$/.exec(key);
	if (clip) return `the Scene ${clip[1]} clip`;
	return key.replace(/_/g, ' ');
}

/** Capitalise for the start of a sentence without touching the rest — "the
 *  screenplay" becomes "The screenplay", "Scene 1" stays "Scene 1". */
function upper(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A reason arrives prefixed with its class: `policy-rejected: …`,
 *  `model-error: …`, `init-error: …`. The prefix decides the sentence; the rest
 *  is the harness's own explanation and is kept verbatim, because it is usually
 *  the only thing that says what to actually change. */
function explainReason(reason: string, subject: string): { text: string; tone: ActivityTone } {
	const kind = /^([a-z-]+):/.exec(reason.trim())?.[1] ?? '';

	switch (kind) {
		case 'policy-rejected':
			return {
				tone: 'warn',
				text: `${upper(subject)} was sent back — the quality gate refused it. Trying again.`
			};
		case 'model-error':
			return { tone: 'bad', text: `${upper(subject)} hit a model error. Trying again.` };
		case 'init-error':
			return {
				tone: 'bad',
				text: `${upper(subject)} could not start at all — the agent failed to initialise.`
			};
		default:
			return { tone: 'warn', text: `${upper(subject)} is being retried.` };
	}
}

/** Turn one harness event into a row, or null for events with nothing to say to
 *  a person. */
export function toActivity(e: HarnessEvent): ActivityRow | null {
	const at = e.t ? Date.parse(e.t) : Date.now();
	const subject = friendly(e.key);
	const id = `${e.t ?? ''}|${e.event ?? ''}|${e.key ?? ''}|${e.attempt ?? ''}`;

	switch (e.event) {
		case 'dispatch':
			return { id, at, tone: 'step', text: `Started ${subject}.` };

		case 'complete':
			return { id, at, tone: 'good', text: `${upper(subject)} is done.` };

		case 'artifact-received':
			return { id, at, tone: 'good', text: `${upper(subject)} came back.` };

		case 'subgraph-ingested':
			return { id, at, tone: 'step', text: 'The shooting tasks are scheduled.' };

		case 'redispatch': {
			const { text, tone } = explainReason(e.reason ?? '', subject);
			// The harness's own words go under the sentence rather than into it:
			// they are long, they are written for an engineer, and they are the
			// part worth reading when the sentence is not enough.
			const detail = (e.reason ?? '').replace(/^[a-z-]+:\s*/, '').trim() || undefined;
			return { id, at, tone, text, detail };
		}

		case 'workflow-load-error':
			// A render workflow that did not load is not a warning about a task —
			// it is a capability the whole production no longer has, and it shows up
			// as "a task" because the event carries no key. Say what it is, and keep
			// the harness's own message: it names the workflow.
			return {
				id,
				at,
				tone: 'bad',
				text: 'A render workflow could not be loaded — anything that needed it cannot run.',
				detail: (e.message ?? e.reason ?? '').trim() || undefined
			};

		case 'rca':
			return {
				id,
				at,
				tone: 'warn',
				text: `The crew looked into why ${subject} failed.`,
				detail: (e.summary ?? '').trim() || undefined
			};

		default:
			// Unknown event types are shown rather than dropped — a new one that
			// mattered would otherwise be invisible exactly like the rejections
			// this file was written for.
			if (!e.event) return null;
			return { id, at, tone: 'step', text: `${e.event.replace(/[-_]/g, ' ')} — ${subject}` };
	}
}

/** The event log arrives as newline-delimited JSON. A malformed line is skipped
 *  rather than throwing: this is a progress display, and it must never be the
 *  thing that breaks the run it is describing. */
export function parseEventLog(raw: unknown): ActivityRow[] {
	if (typeof raw !== 'string' || !raw.trim()) return [];
	const rows: ActivityRow[] = [];
	for (const line of raw.trim().split('\n')) {
		if (!line.trim()) continue;
		try {
			const row = toActivity(JSON.parse(line) as HarnessEvent);
			if (row) rows.push(row);
		} catch {
			/* skip */
		}
	}
	return rows;
}
