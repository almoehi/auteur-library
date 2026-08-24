/** The shared contract for the /studio surface.
 *
 *  Three files agree on the shapes in here: the composer (compose.ts), the
 *  launch endpoint (api/launch/+server.ts) and the studio page itself. Nothing
 *  in this file has a runtime cost beyond a couple of constants — it exists so
 *  those three never disagree about what a production is.
 */
import type { Pick } from './loras';

/** Everything a production is described by, before any YAML exists.
 *
 *  A Brief is what the user actually authors: one sentence expanded into a
 *  story, a look, a length, and a pinned seed. `composeWorkspace` turns it into
 *  the ~850-line workspace the harness wants; nothing upstream of that ever
 *  touches YAML. */
export interface Brief {
	/** url-safe slug, unique per launch, becomes the workspace name.
	 *  Workspaces are immutable once opened — reopening an id is a silent no-op —
	 *  so a fresh slug per launch is the only thing that gets a fresh run.
	 *  Must match {@link SLUG_RE}. */
	slug: string;
	/** short human title shown in the UI (becomes spec.description) */
	title: string;
	/** Three to five words naming the voice the model chose for this film. Shown
	 *  on the card because it is a decision made on the user's behalf, from a
	 *  sentence that usually did not specify one — and a decision you can see is
	 *  a decision you can argue with. */
	register?: string;
	/** Two or three sentences saying what the film is. Shown instead of the
	 *  story, which runs to four hundred words nobody reads before deciding
	 *  whether the plan is right. The story is one click away and unchanged. */
	summary?: string;
	/** the prose the screenwriter agent adapts — this becomes spec.story.plot */
	story: string;
	/** one sentence naming the visual medium, e.g.
	 *  "2D digital comic book illustration, bold ink outlines, cel-shaded".
	 *  Lands in the art-direction prompt, which is what every render prompt
	 *  ultimately inherits its look from. */
	style: string;
	/** how many scenes to produce, 2..6 — one rendered clip per scene */
	sceneCount: number;
	/** pinned so every render in this production shares a look */
	seed: number;
}

/** Accepted slug grammar. Deliberately identical to the check in
 *  api/launch/+server.ts: the slug becomes half of a workspace id (`name@1.0`)
 *  and therefore lands verbatim in a URL path. */
export const SLUG_RE = /^[A-Za-z0-9._-]+$/;

/** Scene bounds. The floor is what makes a film rather than a clip; the ceiling
 *  is wall-clock — renders run ~10 minutes per batch of four. */
export const SCENE_COUNT_MIN = 2;
export const SCENE_COUNT_MAX = 6;

/** What POST /studio/api/launch answers with. It always returns 200:
 *  a down container and a rejected YAML are both normal states here, to be drawn
 *  as a banner rather than thrown. */
/** What the render launch loaded into the workspace after opening it. Absent
 *  for the planning stage, which needs neither. */
export interface LaunchExtras {
	library?: {
		workflows: { name: string; ok: boolean; detail?: string }[];
		skills: { name: string; ok: boolean; detail?: string }[];
	};
	refs?: { artifactId?: string; imported: string[]; error?: string };
}

export type LaunchResult =
	| ({ ok: true; workspaceId: string } & LaunchExtras)
	| {
			ok: false;
			/** true when the harness could not be reached at all (nobody started
			 *  the container) as opposed to reached and unhappy */
			offline?: boolean;
			error: string;
	  };

/** One step of the production pipeline as the task rail draws it.
 *
 *  The first six keys map 1:1 onto planning — 'plan' is our own LLM expansion
 *  of the one-sentence idea (no workspace exists yet), the next five are the
 *  planning workspace's tasks in dependency order. The last three belong to the
 *  render workspace: its planner ('schedule'), the fan-out of shoot_* tasks
 *  ('shoot', drawn as one step with a counter), and the chat-triggered final
 *  assembly ('assemble'). */
export type StageKey =
	| 'plan'
	| 'screenplay'
	| 'cast'
	| 'scenes'
	| 'art'
	| 'bible'
	| 'schedule'
	| 'shoot'
	| 'assemble';

/** One entry of the chat transcript — the studio surface is a single list of
 *  these, nothing else. `who: 'studio'` is our app narrating (progress lines,
 *  artifacts landing, approval prompts); the manager agent's chat replies also
 *  arrive as studio text. Exactly one of the optional payloads is set,
 *  according to `kind`. */
export interface ChatItem {
	id: string;
	who: 'user' | 'studio';
	kind:
		| 'text'
		| 'plan'
		| 'shot'
		| 'artifact'
		| 'clips'
		| 'error'
		| 'approval'
		| 'activity'
		| 'board'
		| 'shootboard';
	/** plain text content (kind=text, error, approval) */
	text?: string;
	/** the expanded brief awaiting the user's yes (kind=plan) */
	plan?: Brief;
	/** simple mode's render prompt, awaiting the user's yes (kind=shot).
	 *  `prompt` is the literal text the workflow will receive — editable on the
	 *  card, because a prompt nobody can see is how the planning chain spent
	 *  months shipping briefs that described a face instead of a scene. */
	shot?: {
		prompt: string;
		seconds: number;
		orientation: 'portrait' | 'landscape';
		why: string;
		/** The adapters the writer chose for this shot, shown on the card so the
		 *  choice is visible before it costs a render rather than after. */
		loras?: Pick[];
		/** Strengths for the always-loaded adapters, where you moved one on this
		 *  card. Absent keys use the catalogue's figure. */
		baseLoras?: Record<string, number>;
		/** Frame size step — '480p', '576p' or '720p'. Unlike the length and the
		 *  frame shape this does not change a word of the brief, so moving it
		 *  never costs a rewrite. */
		resolution?: string;
		/** The same list as the writer first returned it, kept untouched while
		 *  `loras` is edited. The two are compared at launch: where they differ,
		 *  a person disagreed with the writer, and that is the only free quality
		 *  signal this app produces. */
		wroteLoras?: Pick[];
		/** Set once this card has been sent to render, so it stops offering. */
		launched?: boolean;
	};
	/** a planning document or rendered clip presented in the transcript
	 *  (kind=artifact, clips). `taskId` is what reset-task needs for a revision;
	 *  `body` is the fetched text of a planning document, absent for videos. */
	artifact?: {
		key: string;
		title: string;
		taskId: string;
		files: { name: string; url: string }[];
		body?: string;
		/** Which run produced this, so a verdict given on a card you scrolled back
		 *  to lands on that run's row and not on whichever one is current. */
		workspace?: string;
	};
	/** one line of the harness's own progress log (kind=activity) */
	activity?: {
		id: string;
		at: number;
		tone: 'step' | 'good' | 'warn' | 'bad';
		text: string;
		detail?: string;
	};
	at: number;
}

/** Where a production is in the studio flow. Exactly one is true at a time.
 *
 *  brief     — the user is typing the one-sentence idea
 *  drafting  — that sentence is being expanded into a story
 *  review    — the story is on screen, editable, Go is armed
 *  launching — the launch POST is in flight; the slug is being burned
 *  producing — the workspace is open and being polled; clips appear as they land
 *  screening — the film exists and is playable
 *  failed    — the launch was refused, or the workspace is unreachable/dead */
export type StudioPhase =
	| 'brief'
	| 'drafting'
	| 'review'
	| 'launching'
	| 'producing'
	| 'screening'
	| 'failed';

/** ── harness wire shapes ────────────────────────────────────────────────────
 *  What poll-state actually sends back. Kept here rather than in each consumer
 *  so the studio page and any future panel read the same fields; the older
 *  dashboard at /ops declares its own copies and is left alone. */

/** status is `pending | running | success | permanently-failed`, with
 *  `completed` and `failed` also observed — hence the widened type. */
export interface Task {
	id: string;
	key: string;
	title: string;
	status: string;
	origin: string | null;
	agent: string | null;
	golem_agent_id?: string | null;
}

/** The harness sends a bare filename per file (`["scene1_clip.mp4"]`). Object
 *  entries are tolerated in case a richer shape shows up later.
 *
 *  Clip filenames are NOT uniform across scenes — `scene1_clip.mp4` next to
 *  `scene3.mp4` is normal. Always resolve files from `files`, never by guessing
 *  a name from a scene number. */
export type ArtifactFile = string | Record<string, unknown>;

/** status is `empty | approved | rejected`. */
export interface Artifact {
	id: string;
	key: string;
	name: string;
	description: string;
	status: string;
	files: ArtifactFile[];
}

export interface PollState {
	workspace?: { name?: string; version?: string; is_open?: boolean; context_utilization?: number };
	tasks?: Task[];
	artifacts?: Artifact[];
	workflows?: { entry: { name: string }; state: string; queue_depth?: number }[];
	worker_statuses?: unknown[];
	recent_messages?: unknown[];
}

/** One line of get-event-log, which arrives as a JSON-encoded string of
 *  newline-separated objects. `event` is one of dispatch, redispatch, rca,
 *  artifact-received, complete, subgraph-ingested — the union is left open
 *  because the harness adds to it. */
export interface EventLine {
	t: string;
	event: string;
	taskId?: string;
	key?: string;
	status?: string;
	files?: string[];
	[k: string]: unknown;
}

/** The envelope every /api/harness call comes back in. Also always 200 —
 *  `ok` is the harness's status, not the proxy's. */
export interface ProxyResult<T = unknown> {
	ok: boolean;
	status?: number;
	offline?: boolean;
	error?: string;
	data?: T;
}
