/** What a character sounds like when nobody has said.
 *
 *  A real sentence rather than a placeholder, because a placeholder is not a
 *  value: it looks filled in and renders as nothing, so a character shipped
 *  with a grey suggestion in the box and silence in the clip. This is written
 *  into the character when it is made, and shown as the starting text for the
 *  ones made before it existed.
 *
 *  Deliberately unremarkable — it is a floor, not a characterisation. Anything
 *  more specific would be a guess about someone the description has not
 *  described, and would be wrong more often than it was right. */
export const DEFAULT_VOICE = 'a low, unhurried voice with a slight rasp';

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

/** What the harness will spend on one render, and how many times it will try.
 *
 *  These are not the studio's numbers to choose. They are written into the
 *  compute profile of every workspace it composes — compose.ts reads them from
 *  here — and the harness abandons a task that outlives them. They live in this
 *  file because the studio also has to read them back: a run can only still be
 *  running for as long as the harness is still prepared to run it.
 */
export const RENDER_TIMEOUT_SEC = 1800;
export const RENDER_MAX_ATTEMPTS = 2;

/** How long a run can still plausibly be alive.
 *
 *  Deliberately not a round number. It is the longest thing the harness can
 *  produce, worked out from its own budget: the longest phase is the shoot, at
 *  most SCENE_COUNT_MAX clips plus the assembly, and each of those is one task
 *  the harness gives up on after RENDER_TIMEOUT_SEC x RENDER_MAX_ATTEMPTS. They
 *  are counted end to end rather than overlapping, because the studio does not
 *  schedule them — the planner creates them at runtime and we do not get to
 *  assume they run at once. Every other phase fits well inside it: planning is
 *  LLM-only and takes minutes, and a clip, a sheet or a continuation is a single
 *  task under the same budget (a continuation's is longer — CONT_TIMEOUT_SEC in
 *  compose.ts — and still well short of this).
 *
 *  Past this point nothing the harness was asked to do is still being attempted.
 *  A run restored from older than this is a record of something that ended, not
 *  work in progress, and must not be presented as one.
 */
export const RUN_CEILING_MS =
	(SCENE_COUNT_MAX + 1) * RENDER_TIMEOUT_SEC * RENDER_MAX_ATTEMPTS * 1_000;

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
		| 'shootboard'
		| 'sheet'
		| 'takes';
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
		/** Set when this shot continues an existing clip rather than starting one.
		 *
		 *  Carries the three ids the server reads the prior clip's bytes by, and the
		 *  character and location it was shot with — a continuation requires both,
		 *  and they are not a fresh choice: they are whatever the first clip used. */
		continues?: {
			workspace: string;
			artifact: string;
			file: string;
			/** Absent where the clip was shot without a kept sheet. The launch then
			 *  cuts that plate out of the clip itself — the workflow wants a picture
			 *  in the slot, not specifically a sheet. */
			characterId?: string;
			locationId?: string;
			characterName?: string;
			locationName?: string;
			/** Both plates come from kept sheets. False means at least one is a
			 *  frame of the clip, which still works and holds less precisely. */
			exact?: boolean;
			/** Whether the seam is pinned to the prior clip's final frame. Default
			 *  true. Chosen before the brief is written, so the writer and the
			 *  render always agree about whether <Picture 3> exists. */
			pinned?: boolean;
		};
		/** The kept character sheet this clip is shot with. Chosen before the
		 *  writer runs, because it decides which brief template gets written. */
		characterId?: string;
		characterName?: string;
		/** The kept location this clip is shot in. */
		locationId?: string;
		locationName?: string;
		/** Structural faults the brief still has after the writer was given one
		 *  chance to fix them. Never a refusal — the brief renders and this is the
		 *  line that says what to look at if the clip comes back wrong. */
		warn?: string[];
		/** Faults the check caught and the retry then cleared. Shown in the past
		 *  tense: nothing to act on, but it is why the brief took two passes. */
		fixed?: string[];
	};
	/** This error's retry has been pressed. On the item so it survives a reload —
	 *  a flag beside the transcript emptied on every refresh and handed the button
	 *  back over a render that was already running. */
	retried?: boolean;
	/** a planning document or rendered clip presented in the transcript
	 *  (kind=artifact, clips). `taskId` is what reset-task needs for a revision;
	 *  `body` is the fetched text of a planning document, absent for videos. */
	artifact?: {
		/** The harness's artifact id. Carried because a scene is assembled from the
		 *  chat, and the server reads each clip's bytes by (workspace, artifact,
		 *  file) — the id was previously buried inside the file url alone. */
		id?: string;
		key: string;
		title: string;
		taskId: string;
		files: { name: string; url: string }[];
		body?: string;
		/** Which run produced this, so a verdict given on a card you scrolled back
		 *  to lands on that run's row and not on whichever one is current. */
		workspace?: string;
	};
	/** several takes of one beat, rendered at once, waiting to be chosen between
	 *  (kind=takes).
	 *
	 *  One card for the whole batch rather than one per take, because four takes
	 *  exist for a single reason — one of them gets used — and four independent
	 *  cards make the only decision that matters a scroll-and-remember. The runs
	 *  keep their own workspaces, so a chosen take rates, continues and joins a
	 *  scene exactly like a clip rendered on its own.
	 *
	 *  Every run is listed from the moment the batch starts, including the ones
	 *  still on the GPU: the strip then has its final shape from the first
	 *  second and nothing moves as they land. */
	takes?: {
		/** The batch id the server groups these under, and the key this card is
		 *  found by when a poll brings news. */
		batch: string;
		runs: {
			index: number;
			slug: string;
			state: 'rendering' | 'ready' | 'failed';
			error?: string;
			clip?: { workspace: string; artifact: string; file: string };
		}[];
		/** The take you kept, once you have chosen one. Choosing also fills in
		 *  `artifact` above, which is what lets the kept take render through the
		 *  same card a single clip does — with the same verdict, continue and
		 *  scene controls, none of them rewritten for this. */
		kept?: number;
	};
	/** a rendered character or location sheet, awaiting a name and a keep
	 *  (kind=sheet). `id` is set once it has been stored, which is also what
	 *  stops the card offering to store it twice. */
	sheet?: {
		kind: 'character' | 'location';
		/** `anchor` is the cheap single-picture preview of a character; `sheet` is
		 *  the six-view turnaround. They share the model and the seed, so an
		 *  anchor is the same face the sheet will produce. Absent means sheet. */
		stage?: 'anchor' | 'sheet';
		/** Carried from the preview into the full sheet, so the turnaround is of
		 *  the person you approved rather than a new one. */
		seed?: number;
		/** The English description the workflow will receive — editable on the
		 *  card, for the same reason the shot prompt is: a description nobody can
		 *  see is one nobody can correct, and this one is rendered once and lived
		 *  with for a whole production. */
		description: string;
		/** What you typed, kept so a rewrite asks for the same subject again
		 *  rather than editing the writer's English. */
		request?: string;
		/** How this person sounds, invented alongside their look and carried onto
		 *  their sheet when the character is kept. Characters only. */
		voice?: string;
		/** One line from the writer saying what it changed, or that it only
		 *  translated. */
		why?: string;
		/** Set once this card has been sent to render, so it stops offering. */
		launched?: boolean;
		/** This subject is a picture you supplied rather than one we drew.
		 *
		 *  It changes what the card may promise. A drawn character gets its
		 *  six-view turnaround rendered behind you; an uploaded one never will,
		 *  because both sheet workflows are text-to-image and have no image input
		 *  to redraw a photograph from. One picture is the whole of it, and saying
		 *  otherwise would leave someone waiting for views that are not coming. */
		uploaded?: boolean;
		/** Set on the card the render comes back on. Its presence is what tells
		 *  the two states apart: no url is a draft awaiting your yes, a url is a
		 *  finished sheet awaiting a name. */
		url?: string;
		/** The three ids the store needs to fetch the bytes itself, for anything
		 *  that came back through the harness. */
		workspace?: string;
		artifact?: string;
		file?: string;
		/** A direct preview instead: the render skipped the harness, so the bytes
		 *  are already a file on this machine and the job id is what names them. */
		job?: string;
		/** Your name for it. Seeded from the description, editable on the card. */
		name?: string;
		/** Set by a successful keep. */
		id?: string;
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

/** One sheet as the store keeps it. The server module owns the writing; this is
 *  the shape the page reads back, and it is declared here rather than imported
 *  from sheets.server.ts because that module touches the filesystem and must
 *  never be pulled into a client bundle. */
export interface StoredSheet {
	id: string;
	kind: 'character' | 'location';
	name: string;
	description: string;
	file: string;
	size: number;
	addedAt: string;
	workspace?: string;
	seed?: number;
	/** How this person sounds, one sentence, carried into every clip they are in.
	 *  Characters only — a room does not speak. See sheets.server.ts. */
	voice?: string;
	/** The conversation this subject was made in, so its six views are posted
	 *  back into it. Absent on everything made before this existed, and absent
	 *  means any. */
	sessionSlug?: string;
	/** Whether the six views have already been shown in that conversation. What
	 *  the sidebar reads to tell "finished while you were elsewhere" from
	 *  "finished and seen". */
	delivered?: boolean;
	/** The six-view turnaround, which arrives minutes after the character does —
	 *  absent until one has been asked for. */
	sheet?: {
		state: 'rendering' | 'ready' | 'failed';
		/** When the turnaround was started, so the card can say how long it has
		 *  been going. */
		startedAt?: string;
		file?: string;
		error?: string;
		/** The turnaround clip the six views were cut from, when there was one. */
		clip?: { workspace: string; artifact: string; file: string };
		attempt?: number;
	};
}

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
	workflows?: { entry: { name: string }; state: string; in_flight?: number; pending?: number }[];
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
	/** The harness itself did not answer. */
	offline?: boolean;
	/** The harness answered, but this one workspace did not. Its agent has
	 *  wedged; the render behind it may still be running on the GPU. Told apart
	 *  from `offline` because the two need opposite advice — one says restart the
	 *  container, the other says on no account restart the container. */
	wedged?: boolean;
	error?: string;
	data?: T;
}
