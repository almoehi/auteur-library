<script lang="ts">
	/*  Two workspace-id patterns, hoisted to the very top of the script.
	 *
	 *  They used to sit among the $derived declarations, and one of the deriveds
	 *  reads WS_SUFFIX — which is a temporal dead zone waiting to happen, because
	 *  Svelte evaluates the reactive graph by dependency rather than by source
	 *  order. It happened: every load threw "WS_SUFFIX is not defined" from inside
	 *  the runtime, and the derived that throws is the one that names the slug a
	 *  conversation is saved under. That is why runs kept coming back with
	 *  "this conversation was not saved".
	 *
	 *  Plain constants at the top of the file cannot be caught out that way.
	 *  ONE_CLIP_WS comes along because the two have to agree about `cont`. */
	const ONE_CLIP_WS = /-(direct|cont)@/;
	const WS_SUFFIX = /-(shoot|direct|cont)$/;

	/** Studio — chat-first surface for the local auteur harness (~/auteur).
	 *
	 *  The whole production happens in one growing transcript, like a chat with a
	 *  studio. The user types an idea; the plan comes back as a chat message; each
	 *  planning document (screenplay, cast, scenes, art direction, visual bible)
	 *  lands in the chat for approval or revision; only after the user approves
	 *  does GPU rendering start. A right-hand rail mirrors the full pipeline —
	 *  including steps that have not started yet — the way the harness's own TUI
	 *  does.
	 *
	 *  Workspaces are immutable and unpausable, so the approval gate cannot live
	 *  in the harness. The production is therefore split in two:
	 *
	 *    planning workspace  `${slug}@1.0`        — LLM-only, ~4 minutes, no GPU
	 *    render workspace    `${slug}-shoot@1.0`  — opened only after approval,
	 *                                               carries the approved documents
	 *                                               inline and renders on Modal
	 *
	 *  Per-document revision goes through reset-task on the planning workspace.
	 *  Downstream planning documents do NOT re-run on their own, so this page
	 *  orchestrates a chain reset: wait for the upstream artifact to come back,
	 *  then reset the next planning task in dependency order, and so on.
	 *
	 *  Same-origin routes back it:
	 *    /studio/api/plan    — idea (or prior plan + feedback) -> Brief
	 *    /studio/api/launch  — {stage:'planning'|'render'} -> workspace
	 *    /api/harness        — POST proxy (poll-state, chat, reset-task…)
	 *    /api/file           — raw artifact bytes, same-origin (the harness
	 *                          itself sends no CORS headers)
	 */
	// Aliased: this file already has a tick(id) of its own for the poll loop.
	import { onMount, tick as flush } from 'svelte';
	import { friendly, parseEventLog, type ActivityRow } from './activity';
	import { recordWait, typicalWait, typicalLabel } from './timings';
	import { renderDocument, type Block } from './render-doc';
	import {
		DEFAULT_VOICE,
		RUN_CEILING_MS,
		SCENE_COUNT_MAX,
		SCENE_COUNT_MIN,
		type Artifact,
		type ArtifactFile,
		type Brief,
		type ChatItem,
		type LaunchResult,
		type PollState,
		type ProxyResult,
		type StoredSheet,
		type Task
	} from './types';
	import { BASE, CATALOGUE, MAX_PICKS, loraFor, type Pick } from './loras';

	/** Polling cadence, unchanged from the previous surface: the harness author
	 *  asked not to hammer the status endpoints. 15s while things move, 30s once
	 *  three consecutive polls came back identical, no polling once terminal. */
	const POLL_FAST_MS = 15_000;
	const POLL_SLOW_MS = 30_000;
	const QUIET_CYCLES = 3;

	// Status vocabularies differ per entity: tasks end on `success`, artifacts on
	// `approved`, and the harness also says `completed` in places. Failure is
	// `permanently-failed` for tasks, `rejected` for artifacts.
	const DONE = ['success', 'completed', 'approved'];
	const DEAD = ['permanently-failed', 'failed', 'rejected'];

	/** The five planning steps in dependency order. Each pairs the task that
	 *  writes it with the artifact it registers, the ApprovedDocs field the
	 *  render launch carries it under, and the name a person reads.
	 *  The chain reset walks this list top to bottom. */
	const PLANNING_STEPS = [
		{ task: 'write_screenplay', artifact: 'screenplay', doc: 'screenplay', label: 'Screenplay' },
		{ task: 'character_table', artifact: 'character_table', doc: 'characterTable', label: 'Cast' },
		{ task: 'create_scenes', artifact: 'scene_list', doc: 'sceneList', label: 'Scenes' },
		{ task: 'write_art_direction', artifact: 'art_direction', doc: 'artDirection', label: 'Art direction' },
		{ task: 'write_visual_bible', artifact: 'visual_bible', doc: 'visualBible', label: 'Visual bible' }
	] as const;

	type PlanningStep = (typeof PLANNING_STEPS)[number];

	/** The instruction a downstream planning task gets when an upstream document
	 *  changed. Agent-facing, so English. */
	const CONSISTENCY_INSTRUCTION =
		'An upstream planning document changed — regenerate this document so it stays consistent with the updated upstream content.';

	/** The assembly instruction that worked live — verbatim, do not "improve" it. */
	const ASSEMBLY_MSG =
		'Combine all rendered scene clips into a single final video file, in scene order. ' +
		'Use the scene-assembler skill. Resolve each clip from the artifact index rather ' +
		'than guessing by filename. Register the result as a new artifact.';

	const OFFLINE_TEXT =
		'The harness is not responding. Start the container: cd ~/auteur && ./run.sh';

	/** The other silence, and it needs the opposite advice. The harness answers
	 *  fine and every other workspace answers in milliseconds; this run's agent
	 *  has stopped talking on its own. The render behind it is very likely still
	 *  going on the GPU, so restarting the container is the one thing that would
	 *  actually lose work. */
	const WEDGED_TEXT =
		'This run has stopped reporting — but the harness is up and the render may ' +
		'still be running on the GPU. Do not restart the container; it would lose ' +
		'the render. The clip appears here if it finishes.';

	/** Which door this session is using. Simple by default: it is the one that
	 *  produced usable clips today, and the planning chain is a twenty-minute
	 *  round trip to find out whether it did. Remembered across visits — a mode
	 *  is a working habit, not a per-run choice. */
	let mode = $state<'simple' | 'advanced'>('simple');
	const MODE_KEY = 'auteur-studio-mode';

	/** The empty page says what the product is, in two beats, and stops. It used
	 *  to run to three sentences of mechanics — how the prompt gets written, who
	 *  approves what, when the GPU starts — which is a subhead's job on a page
	 *  that has no subhead, and it changed wording with the mode, so the first
	 *  thing you read moved when you touched a toggle.
	 *
	 *  "Adult film" fixes the medium beyond argument; "directed by you" is the
	 *  one credit this tool can print, and it is what the name already means.
	 *  Two lines, one per beat, at every width. */
	const WELCOME_LINES = ['Adult film.', 'Directed by you.'];
	const WELCOME_TEXT = WELCOME_LINES.join(' ');

	/** The greeting is a property of the empty page, not a message in the
	 *  conversation — so switching modes rewrites it where it stands. Pushing a
	 *  fresh one each time stacked a paragraph per switch, and flipping twice to
	 *  compare the two modes left four of them. */
	let welcomeId = $state('');

	function showWelcome() {
		// Still a chat item so reset() and the transcript machinery keep working,
		// but the template gives it the page's own treatment rather than a
		// paragraph's — see the welcomeId branch in the transcript.
		if (welcomeId && chat.find((c) => c.id === welcomeId)) return;
		welcomeId = pushStudio(WELCOME_TEXT).id;
	}

	/** Seed pitches for the audience this plugs into: adult creators making promo
	 *  and teaser content for their own profiles. They set the register in one
	 *  glance — confident, sensual, character-led — which a blank input never
	 *  does, and they steer the model away from the children's-story default it
	 *  otherwise falls into. */
	const EXAMPLES = [
		'a late-night confession from someone who knows exactly what they want',
		'a slow burn between two rivals who keep pretending they are not interested',
		'a teasing introduction to a character who is used to being adored'
	];

	// One set for both modes. The simple-mode trio named the act outright, which
	// put hardcore copy in the chrome — the first thing on screen for anyone who
	// walks past the machine. These steer the register just as well and the
	// prompt box accepts exactly the same input.
	const examples = EXAMPLES;

	/** Survives an accidental reload mid-run. Chat items are rebuilt from poll
	 *  state on resume; only the run identity is persisted. */
	const RESUME_KEY = 'auteur-studio-chat-v2';

	const SCENE_CHOICES = Array.from(
		{ length: SCENE_COUNT_MAX - SCENE_COUNT_MIN + 1 },
		(_, i) => SCENE_COUNT_MIN + i
	);

	/** Tasks whose key/title says they combine clips belong to the Final cut
	 *  rail entry, not the shoot list. */
	const ASSEMBLE_RE = /assemb|combin|final|stitch|concat/i;

	// --- transcript ----------------------------------------------------------

	let chat = $state<ChatItem[]>([]);
	/** Items replaced by a newer version collapse to one line. */
	let superseded = $state<Record<string, boolean>>({});
	let idSeq = 0;
	function mkId(): string {
		idSeq += 1;
		return `i${Date.now().toString(36)}-${idSeq}`;
	}
	function pushItem(partial: Omit<ChatItem, 'id' | 'at'>): ChatItem {
		const item: ChatItem = { ...partial, id: mkId(), at: Date.now() };
		chat.push(item);
		// The pushed element, not the object that was pushed. `chat` is $state, so
		// writing into it stores a proxy — and the local `item` is the unproxied
		// original. Returning that made every mutation through the returned
		// reference invisible: the character preview updated its own card's url
		// when the picture arrived, nothing re-rendered, and the card sat empty
		// while the file was on disk. Callers that re-find by id were unaffected,
		// which is why only one path ever showed it.
		return chat[chat.length - 1];
	}
	function pushStudio(text: string): ChatItem {
		return pushItem({ who: 'studio', kind: 'text', text });
	}
	function pushError(text: string): ChatItem {
		return pushItem({ who: 'studio', kind: 'error', text });
	}

	// --- the production ------------------------------------------------------

	/** The current plan. Refinement replaces it wholesale; edits patch it. */
	let brief = $state<Brief | null>(null);
	/** The user's first idea, kept as context for plan revisions. */
	let originalPitch = $state('');
	/** The Brief the planning workspace was actually opened with — its slug may
	 *  carry a retry suffix, and the render workspace derives from it. */
	let launchedBrief = $state<Brief | null>(null);
	let latestPlanId = $state('');
	let sceneCount = $state(4);


	let planningWs = $state('');
	let renderWs = $state('');
	const activeWs = $derived(renderWs || planningWs);

	/** Whether the live render workspace is a simple-mode one. Read off the id
	 *  rather than carried as a flag, because a flag has to be set on every road
	 *  in and one of them was missed: reopening a past run from the sidebar
	 *  restored the workspace without it, the single clip task counted as a
	 *  finished shoot, and the page asked a workspace with no assembler to
	 *  assemble — which it answered, at length, in the transcript.
	 *
	 *  The id cannot be missed. composeDirectWorkspace names every direct
	 *  workspace `<slug>-direct`, so this is true however we arrived. */
	/** One task, one clip — as opposed to a planned shoot with several scenes and
	 *  a final cut.
	 *
	 *  Two id shapes qualify, and forgetting the second cost a delivery: a
	 *  continuation opens `<slug>-cont@v`, not `<slug>-direct@v`. Tested in one
	 *  place because it is asked in five, and a run that answers "no" here is
	 *  offered a planning rail it has no documents for and an assembly step it has
	 *  nothing to assemble. */
	/** Every suffix a render workspace id can carry. It lives beside ONE_CLIP_WS
	 *  because the two have to agree, and they had stopped: `cont` was added there
	 *  and not to the slug derivation below, so a continuation filed its
	 *  conversation under `cont-xxx-cont` while the sidebar looked it up as
	 *  `cont-xxx`. Reopening one could never find what it had just saved. */
	const simpleRun = $derived(ONE_CLIP_WS.test(renderWs));

	/** Whether the live render is a sheet rather than a clip. Read off the id for
	 *  exactly the reason simpleRun is: composeSheetWorkspace names every one of
	 *  them `<slug>-sheet`, so no road in can forget to set it. It decides what a
	 *  finished artifact becomes — a clip card or a sheet card — and it keeps a
	 *  sheet run out of the shoot bookkeeping, which counts clips. */
	const sheetRun = $derived(/-sheet@/.test(renderWs));

	/** The slug this run is filed under, the same one the history sidebar shows.
	 *  Derived rather than stored: the planning workspace is `<slug>@v` and the
	 *  render one `<slug>-shoot@v` or `<slug>-direct@v`, so the ids already carry
	 *  it and cannot disagree with a copy. */
	/** The working session, once one has been started.
	 *
	 *  A session is what a person does in one sitting: describe a character, keep
	 *  it, shoot a clip with it, continue the clip. The sidebar files a row per
	 *  slug, and before this the slug came off the workspace id — so each of those
	 *  four steps opened its own row, and the first minute of a session, before
	 *  any render existed, had no row at all. */
	let sessionSlug = $state('');

	const runSlug = $derived(
		sessionSlug ||
			(planningWs
				? planningWs.split('@')[0]
				: renderWs
					? renderWs.split('@')[0].replace(WS_SUFFIX, '')
					: '')
	);

	/** Open a row the moment work starts, rather than when a GPU does.
	 *
	 *  Called from every path a session can begin on. It is idempotent: a session
	 *  that already has a slug keeps it, which is the whole point — the row is the
	 *  sitting, not the render. */
	async function startSession(title: string): Promise<void> {
		if (sessionSlug) return;
		const slug = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
		sessionSlug = slug;
		try {
			const r = await fetch('/studio/api/history', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ slug, title: title.slice(0, 80) || 'New session', pitch: title.slice(0, 200) })
			});
			const d = (await r.json()) as { productions?: Production[] };
			if (d.productions) history = d.productions;
		} catch {
			// The row is a convenience. A session that could not announce itself
			// still works; it simply appears when its first render lands.
		}
	}

	/** One saved conversation per run, plus a pointer at the live one.
	 *  Before this there was a single slot, so opening an older run from the
	 *  sidebar could only rebuild a guess of it — a synthetic brief, an advanced
	 *  plan card, and the planning rail sitting in `waiting` over a simple run
	 *  that never had a plan. The conversation itself is the state; keep it. */
	const runKey = (slug: string) => `auteur-studio-run-${slug}`;
	const POINTER_KEY = 'auteur-studio-current';

	let startedAt = $state(0);
	let now = $state(Date.now());

	/** Last good poll per workspace — kept separately so the rail can keep
	 *  drawing the planning steps after the poll target moves to rendering. */
	let planningPoll = $state<PollState | null>(null);
	let renderPoll = $state<PollState | null>(null);

	let offline = $state(false);
	let lastError = $state('');
	let lastTick = $state<Date | null>(null);
	let pollingActive = $state(false);

	/** A restored run the harness cannot still be working on.
	 *
	 *  `startedAt` outlives the tab, so a run left behind by a closed laptop —
	 *  or simply reopened from the sidebar a week later — comes back with a
	 *  timestamp and a poller and no way of its own to tell that it is over. The
	 *  clock then counts up from a moment that is days gone, and the composer
	 *  says a production is in progress that nothing has touched since Tuesday.
	 *  Of everything this surface can get wrong, claiming to be doing work it is
	 *  not is the one that costs the reader their trust in the rest of it.
	 *
	 *  So an old run is restored as what it is: the record of a run, whole and
	 *  readable, with nothing on it pretending to be live. See RUN_CEILING_MS for
	 *  where the line sits and why it sits there.
	 */
	let staleRun = $state(false);

	// --- planning documents ----------------------------------------------------

	/** Per planning artifact key: undefined/waiting -> posted -> (regen -> posted).
	 *  `regen` means a reset was issued and the current artifact content is stale. */
	let docPhase = $state<Record<string, 'posted' | 'regen'>>({});
	/** [ok] is a UI state only — the harness already moved on. */
	let docAccepted = $state<Record<string, boolean>>({});
	/** artifact key -> latest chat item showing it, so re-posts collapse the old. */
	let latestDocItem = $state<Record<string, string>>({});
	/** artifact key -> loaded document text (what the render launch carries). */
	let docBody = $state<Record<string, string>>({});
	/** artifact key -> the filename it came from. The renderer needs it to tell a
	 *  JSON visual bible from a markdown document. */
	let docFile = $state<Record<string, string>>({});

	/** Where the document can be downloaded, and which task wrote it — both were
	 *  carried on the per-document card until the board replaced it. */
	let docUrl = $state<Record<string, string>>({});
	let docTaskId = $state<Record<string, string>>({});

	/** Posted once, the moment planning starts, so the five steps are on screen
	 *  before any of them has finished. */
	let boardId = $state('');

	/* ── past productions ──────────────────────────────────────────────────────
	 *  A run used to exist only in the tab that started it. The server now keeps
	 *  a bookmark per production, and this is the way back to one.
	 */
	type Production = {
		slug: string;
		title: string;
		sceneCount: number;
		planningWs?: string;
		renderWs?: string;
		startedAt: number;
		updatedAt: number;
		pitch?: string;
		/** Simple mode keeps the writer's prompt whole on the row. Dropped from
		 *  this type until now, which is why a run with no saved conversation had
		 *  nothing to show even though the text was on disk. */
		prompt?: string;
	};
	let history = $state<Production[]>([]);
	/** The rail is a place you go back to, not a thing you read, so it closes.
	 *  It used to be permanent above lg with no way to shut it, and off-canvas
	 *  below with no way to keep it — one control now does both, and the choice
	 *  survives a reload because it is a working habit, not a per-run decision. */
	let sidebarOpen = $state(false);
	const NAV_KEY = 'auteur-studio-nav';

	async function loadHistory() {
		try {
			const r = await fetch('/studio/api/history');
			if (!r.ok) return;
			history = ((await r.json()) as { productions: Production[] }).productions;
		} catch {
			/* the list is a convenience; never let it break the studio */
		}
	}

	/** Put a run in the sidebar the moment it becomes one.
	 *
	 *  The list was fetched once, on mount, so a production you had just started
	 *  was absent from its own history until the next reload — the one place a
	 *  user is certain to look for it. The server row is written during the
	 *  launch request, so by the time a slug exists here it exists there too.
	 *
	 *  Keyed on the slug rather than on every change: a run's row is written
	 *  once, and re-fetching the whole list on each poll would be sixty rows a
	 *  second for a number that did not move. */
	let listedSlug = '';
	$effect(() => {
		const slug = runSlug;
		if (!slug || slug === listedSlug) return;
		listedSlug = slug;
		void loadHistory();
	});

	/** How much of a conversation a saved snapshot actually holds.
	 *
	 *  The greeting does not count: it is pushed on load by every session,
	 *  including one that went on to do nothing, so a snapshot containing only
	 *  the greeting is an empty page that happens to have a file. */
	function savedTurns(slug: string): number {
		try {
			const raw = localStorage.getItem(runKey(slug));
			if (!raw) return 0;
			const s = JSON.parse(raw) as { chat?: { id?: string }[]; welcomeId?: string };
			const chat = s.chat ?? [];
			return chat.filter((c) => !s.welcomeId || c.id !== s.welcomeId).length;
		} catch {
			return 0;
		}
	}

	/** A run rebuilt from the records that outlived its conversation.
	 *
	 *  Productions launched before conversations were saved have no transcript,
	 *  so their sidebar row opened onto an empty page. But the two halves worth
	 *  reading both survived on disk: the render log keeps the request verbatim —
	 *  untruncated, unlike the history row's sixty-character title — and the
	 *  prompt the writer produced from it, with the adapters it chose.
	 *
	 *  The clip cannot come back. Its cache file is named
	 *  sha256(workspace + artifact + file) and the artifact id was written down
	 *  nowhere, so the mp4 is still in ~/auteur/studio-library/clips with nothing
	 *  to say which run it belongs to. A page that silently omits the video looks
	 *  like a page that lost it, so this says so instead.
	 *
	 *  The shot card is marked launched: it is a record of what ran, not an offer
	 *  to spend a GPU running it again.
	 */
	function rebuiltChat(p: Production): ChatItem[] | null {
		const row = p.renderWs ? logRow[p.renderWs] : undefined;
		const prompt = row?.prompt ?? p.prompt ?? '';
		const request = row?.request ?? p.title ?? '';
		if (!prompt && !request) return null;

		const at = p.startedAt || Date.now();
		const out: ChatItem[] = [];
		const add = (i: Omit<ChatItem, 'id' | 'at'>) => out.push({ ...i, id: mkId(), at });

		add({
			who: 'studio',
			kind: 'text',
			text: row
				? 'This conversation was not saved. Rebuilt from the render log — the request and the prompt below are exact. The clip it produced cannot be located.'
				: 'This conversation was not saved, and there is no render log for it. All that is left is the request.'
		});
		if (request) add({ who: 'user', kind: 'text', text: request });
		if (prompt) {
			add({
				who: 'studio',
				kind: 'shot',
				shot: {
					prompt,
					seconds: row?.seconds ?? 0,
					orientation: (row?.width ?? 0) >= (row?.height ?? 1) ? 'landscape' : 'portrait',
					why: '',
					loras: row?.launched ?? [],
					launched: true,
					...(row?.characterId ? { characterId: row.characterId } : {}),
					...(row?.characterName ? { characterName: row.characterName } : {}),
					...(row?.locationId ? { locationId: row.locationId } : {}),
					...(row?.locationName ? { locationName: row.locationName } : {})
				}
			});
		}
		if (row?.outcome) {
			add({ who: 'studio', kind: 'text', text: `You marked this one ${row.outcome}.` });
		}
		return out;
	}

	/** Reopening writes the resume payload and reloads.
	 *
	 *  Deliberately not a soft in-place swap: restoring a run means rebuilding
	 *  the transcript, the poller, the document phases and the revision chain
	 *  from scratch, and there is already one tested path that does all of that —
	 *  the one that runs on load. Reusing it is worth the reload. */
	function reopen(p: Production) {
		if (runSlug === p.slug) {
			// Already the run on screen. On a phone the rail covers the page, so
			// the only useful thing left to do is get out of the way.
			if (window.innerWidth < 1024) setNavOpen(false);
			return;
		}

		// Read what this run should show BEFORE anything is torn down: reset()
		// clears the pointer and the resume slot, and the payload for the run
		// being opened may be sitting in exactly those places.
		let raw: string | null = null;
		let saved = false;
		try {
			saved = savedTurns(p.slug) > 0;
			// The run's own conversation, if it was saved: what you typed, the
			// prompt or the plan you approved, the documents, the clips.
			//
			// A key is not the same as a conversation, and the two were being
			// treated as one. A snapshot written before the run had said anything
			// holds nothing but the greeting, and taking its existence as proof of
			// content opened the row onto a blank page — with the rebuild below
			// skipped, because the key was there. So ask what is in it.
			if (saved) raw = localStorage.getItem(runKey(p.slug));
		} catch {
			/* private mode — fall through to the rebuild */
		}

		if (!raw) {
			// Older runs, saved before conversations were kept. The identity is
			// enough to poll the workspace, and for a run past RUN_CEILING_MS not
			// even that happens — so without the rebuild the page would open
			// empty. See rebuiltChat for what can honestly be put back.
			const rebuilt = rebuiltChat(p);
			const asBrief = {
				slug: p.slug,
				title: p.title,
				story: p.pitch ?? '',
				style: '',
				sceneCount: p.sceneCount,
				seed: 0
			};
			raw = JSON.stringify({
				// Reopening a row puts you back in that session, not in a new one
				// that happens to show its workspace.
				sessionSlug: p.slug,
				brief: asBrief,
				launchedBrief: asBrief,
				planningWs: p.planningWs ?? '',
				renderWs: p.renderWs ?? '',
				assemblySent: false,
				startedAt: p.startedAt,
				// A simple run never had a brief. Handing one back draws the
				// advanced plan card over a run that has no plan, with a start
				// button that would open a second workspace.
				...(ONE_CLIP_WS.test(p.renderWs ?? '') ? { brief: null, launchedBrief: null } : {}),
				...(rebuilt ? { chat: rebuilt } : {})
			});
		}

		// Swapped in place rather than through a reload. Reopening used to write a
		// pointer and set location.href, which threw away a warm page — fonts,
		// history, staged references and all — and blanked the screen, to arrive
		// at a state this tab could simply have adopted. reset() and resumeFrom()
		// between them are the whole of what that reload was for.
		reset();
		if (!resumeFrom(raw)) showWelcome();
		try {
			if (saved) localStorage.setItem(POINTER_KEY, p.slug);
		} catch {
			/* the run is on screen either way; the pointer only matters next load */
		}
		if (window.innerWidth < 1024) setNavOpen(false);
	}

	async function dropFromHistory(p: Production, e: MouseEvent) {
		e.stopPropagation();
		const r = await fetch(`/studio/api/history?slug=${encodeURIComponent(p.slug)}`, {
			method: 'DELETE'
		});
		if (r.ok) history = ((await r.json()) as { productions: Production[] }).productions;
	}

	/** "today", "yesterday", then the date — the grouping people actually use
	 *  when looking for something they made recently. */
	/** What a history row actually is. Nothing stores this, so it is read back
	 *  from what the launch route wrote:
	 *
	 *    a film  — the only stage that opens a planning workspace
	 *    a sheet — the sheet stage passes a literal title and no plan
	 *    a clip  — everything else, which is direct mode
	 *
	 *  A `kind` on the record would be sturdier than a title match, and it is a
	 *  three-line change in api/launch. Until then this reads the same facts. */
	const SHEET_TITLE = /^(Character|Location) sheet$/;
	function runKind(p: Production): 'film' | 'sheet' | 'clip' {
		if (p.planningWs) return 'film';
		if (SHEET_TITLE.test(p.title)) return 'sheet';
		return 'clip';
	}

	/** Runs, by the day they were last touched, with the sheets taken out.
	 *
	 *  Sheets were never productions: they are in Cast & sets, they carry a
	 *  constant title so nine of them read identically, and reopening one lands
	 *  in the legacy branch because runSlug never matches a sheet id. Listing
	 *  them here also spent the 60-row budget on rows nobody can use. */
	const historyDays = $derived.by(() => {
		const days: { label: string; items: Production[] }[] = [];
		for (const p of history) {
			if (runKind(p) === 'sheet') continue;
			const label = whenLabel(p.updatedAt);
			const day = days.find((d) => d.label === label);
			if (day) day.items.push(p);
			else days.push({ label, items: [p] });
		}
		return days;
	});

	function whenLabel(ts: number): string {
		const d = new Date(ts);
		const today = new Date();
		const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
		if (same(d, today)) return 'today';
		const y = new Date(today);
		y.setDate(y.getDate() - 1);
		if (same(d, y)) return 'yesterday';
		return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
	}

	type BoardState = 'waiting' | 'writing' | 'done' | 'rewriting' | 'failed';

	/** The five planning steps with the state each is actually in.
	 *
	 *  Derived rather than pushed, so the board is never a snapshot of a moment
	 *  that has passed — the row for the document being written now is the same
	 *  row that will carry it when it is done. */
	const board = $derived.by(() => {
		const tasks = planningPoll?.tasks ?? [];
		return PLANNING_STEPS.map((step) => {
			const t = tasks.find((x) => x.key === step.task);
			const phase = docPhase[step.artifact];
			let state: BoardState = 'waiting';
			if (phase === 'regen') state = 'rewriting';
			else if (phase === 'posted') state = 'done';
			else if (t && DEAD.includes(t.status)) state = 'failed';
			else if (t && !DONE.includes(t.status)) state = 'writing';
			return {
				key: step.artifact,
				label: step.label,
				state,
				body: docBody[step.artifact],
				file: docFile[step.artifact],
				url: docUrl[step.artifact]
			};
		});
	});

	const boardDone = $derived(board.filter((b) => b.state === 'done').length);

	/** The shoot, one row per scene.
	 *
	 *  A render is minutes of nothing — no output until the clip exists, and the
	 *  harness reports the task as "running" throughout whether it is writing a
	 *  prompt, waiting for a GPU, or stuck. So this says what can honestly be
	 *  said: which scene, what stage it has reached, and how long it has been
	 *  there. The elapsed number is the important one. It is what turns "this
	 *  feels slow" into a judgement someone can actually make. */
	const shootBoard = $derived.by(() => {
		const tasks = (renderPoll?.tasks ?? []).filter((t) => /shoot[_ ]?scene/i.test(t.key ?? t.title ?? ''));
		const arts = renderPoll?.artifacts ?? [];
		return tasks
			.map((t) => {
				const n = sceneNo(t.key ?? '', t.title ?? '');
				const art = arts.find((a) => sceneNo(a.key ?? '', a.name ?? '') === n && /clip/i.test(a.key ?? ''));
				const done = art?.status === 'approved';
				const failed = DEAD.includes(t.status);
				return {
					n,
					title: (t.title ?? `Scene ${n}`).replace(/^Shoot\s+/i, ''),
					state: done ? 'done' : failed ? 'failed' : 'running',
					retries: retryCounts.get(t.key ?? '') ?? 0
				};
			})
			.sort((a, b) => a.n - b.n);
	});

	/** Set when the shoot workspace opens, so a row can say how long it has been
	 *  going. Per-scene start times are not available — the harness dispatches
	 *  them together — so this is the honest granularity. */
	const shootElapsed = $derived(startedAt ? Math.floor((now - startedAt) / 1000) : 0);

	function mmss(sec: number): string {
		const m = Math.floor(sec / 60);
		return m < 1 ? `${sec}s` : `${m}m ${String(sec % 60).padStart(2, '0')}s`;
	}
	let approvalId = $state('');

	/** The chain reset in flight, or null. `armed` flips once the reset task was
	 *  seen non-terminal — only then does "success" mean "re-ran", not "still the
	 *  old result". `polls` is the safety valve for a re-run faster than one poll
	 *  interval: after enough polls with the task terminal and never armed, the
	 *  re-run is assumed missed rather than stalling the chain forever. */
	let chain = $state<{
		taskKey: string;
		downstream: string[];
		armed: boolean;
		polls: number;
	} | null>(null);

	// --- rendering -------------------------------------------------------------

	let shootsAnnounced = $state(false);
	let assemblySent = $state(false);
	let finalPosted = $state(false);
	let renderLaunching = $state(false);

	/* Stopping a run.
	 *
	 *  Two-step, because it is not undoable: a workspace id can be opened once,
	 *  so a stopped production cannot be resumed — it can only be started again
	 *  from the plan, under a fresh slug. A single misplaced click should not
	 *  cost that.
	 */
	let stopArmed = $state(false);
	let stopping = $state(false);

	async function stopRun() {
		const b = launchedBrief ?? brief;
		if (!b?.slug || stopping) return;
		stopping = true;
		try {
			const ids = [planningWs, renderWs].filter((w): w is string => !!w);
			const res = await fetch('/studio/api/stop', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(ids.length ? { workspaces: ids } : { slug: b.slug })
			});
			const d = (await res.json()) as { ok: boolean; removed?: number; torndown?: boolean };

			// Stop polling before saying anything: a tick that lands after the
			// message would re-report the run as alive.
			runId += 1;
			pollingActive = false;

			pushStudio(
				d.ok
					? `Stopped. ${d.torndown ? 'The compute is released' : 'Compute was already idle'}` +
							`${d.removed ? ` and ${d.removed} queued ${d.removed === 1 ? 'task was' : 'tasks were'} removed` : ''}. ` +
							`This production cannot be resumed — start a new one when you are ready.`
					: 'Nothing was left running to stop.'
			);
			persist();
		} catch (e) {
			pushError(`Could not stop the run: ${e}`);
		} finally {
			stopping = false;
			stopArmed = false;
		}
	}

	// --- composer ----------------------------------------------------------------

	let input = $state('');
	let sending = $state(false);
	let composer = $state<HTMLTextAreaElement | null>(null);

	/* ── the harness's own account of itself ──────────────────────────────────
	 *  Its event log carries the things that matter most and show up nowhere
	 *  else: a task sent back by a quality gate, an agent that could not start,
	 *  the crew's own analysis of a failure. Without this the studio shows
	 *  "running" while the harness quietly retries the same rejection, which is
	 *  indistinguishable from slow work and has cost this project whole
	 *  afternoons.
	 */
	let seenActivity = $state(new Set<string>());

	/** How many times each task has been sent back, and which ones we have
	 *  already warned about.
	 *
	 *  The harness retries a failed task indefinitely, including failures that
	 *  cannot succeed on a second attempt — a CUDA kernel mismatch, a model that
	 *  refuses the content. Each retry of a render is a GPU call you pay for.
	 *  One afternoon of that cost real money before anyone noticed, because from
	 *  outside a retry loop looks exactly like slow work. */
	const RETRY_ALARM = 3;
	let retryCounts = $state(new Map<string, number>());
	let retryWarned = new Set<string>();

	async function pollActivity(target: string) {
		const r = await call('get-event-log', {}, target);
		if (!r.ok) return;
		for (const row of parseEventLog(r.data)) {
			if (seenActivity.has(row.id)) continue;
			seenActivity.add(row.id);

			// The board says all of this, in one place, without three lines per
			// document. What survives is trouble — a rejection or a failure has
			// nowhere else to appear, and is the whole reason this feed exists.
			const evKey = row.id.split('|')[2] ?? '';
			const routine = row.tone === 'step' || row.tone === 'good';
			const planning = PLANNING_STEPS.some((st) => st.task === evKey || st.artifact === evKey);
			if (!(routine && planning)) {
				pushItem({ who: 'studio', kind: 'activity', activity: row });
			}

			// A retry is identified by the task it belongs to, which is the part
			// of the row id before the first bar. Counting rows rather than
			// parsing the event again keeps this on one source of truth.
			if (row.tone !== 'warn' && row.tone !== 'bad') continue;
			const key = row.id.split('|')[2] || row.id;
			if (!key) continue;
			const n = (retryCounts.get(key) ?? 0) + 1;
			retryCounts.set(key, n);
			if (n >= RETRY_ALARM && !retryWarned.has(key)) {
				retryWarned.add(key);
				pushError(
					`This has failed ${n} times in a row and the harness will keep trying. ` +
						`If the cause is the same every time — a refused prompt, a broken workflow — ` +
						`retrying cannot fix it, and every render attempt costs GPU time. ` +
						`Open the details above to see what it actually said, and stop the run if it reads final.`
				);
			}
		}
	}


	/* ── reference files ───────────────────────────────────────────────────────
	 *  Faces, rooms, movements you want the render to copy. They are staged on
	 *  the server until the plan is approved, because there is nowhere to put
	 *  them before that — the harness keeps artifacts inside a workspace, and
	 *  the one that needs them is the render workspace, which does not exist
	 *  yet. Launching the render consumes them, which is why the list empties
	 *  itself at that point rather than lingering into the next film.
	 */
	type RefFile = { id: string; name: string; description: string; size: number };
	let refFiles = $state<RefFile[]>([]);
	let refBusy = $state(false);
	let refError = $state('');
	let refDragging = $state(false);

	async function loadRefFiles() {
		try {
			const r = await fetch('/studio/api/refs');
			if (!r.ok) return;
			refFiles = ((await r.json()) as { files: RefFile[] }).files;
		} catch {
			/* the staging area is optional; never let it break the composer */
		}
	}

	async function attachRefs(list: FileList | null) {
		if (!list?.length || refBusy) return;
		refBusy = true;
		refError = '';
		try {
			const fd = new FormData();
			for (const f of Array.from(list)) {
				fd.append('file', f);
				fd.append('description', '');
			}
			const r = await fetch('/studio/api/refs', { method: 'POST', body: fd });
			const d = (await r.json()) as { ok: boolean; error?: string; files?: RefFile[] };
			if (!d.ok) refError = d.error ?? 'could not attach that';
			if (d.files) refFiles = d.files;
		} catch (e) {
			refError = String(e);
		} finally {
			refBusy = false;
		}
	}

	async function dropRef(id: string) {
		const r = await fetch(`/studio/api/refs?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
		const d = (await r.json()) as { files?: RefFile[] };
		if (d.files) refFiles = d.files;
	}

	/** Keep a picture you already have as a character or a location.
	 *
	 *  Same paperclip, different meaning, decided by the mode the composer is
	 *  already in: attaching in clip mode stages a reference for that one render,
	 *  attaching in character mode makes the picture a character you keep. No
	 *  second control for a second meaning — the band above the box already says
	 *  which question is being answered.
	 *
	 *  One file, not the list: a character is one person. Clip mode still takes as
	 *  many as you like.
	 *
	 *  There is no render here and no GPU. The picture is the character, and a
	 *  clip that uses it stages it exactly as it stages a drawn one.
	 */
	/** A picked photograph, waiting for you to press send.
	 *
	 *  It used to upload the instant it was chosen, which put the description on
	 *  the wrong side of the click: attach first and then start typing, and the
	 *  character was already made — named after the file, with nothing for the
	 *  turnaround to work from. Holding it here means one flow either way, and the
	 *  text in the box at send time is the text that counts. */
	let pendingPhoto = $state<File | null>(null);

	function holdPhoto(list: FileList | null) {
		const file = list?.[0];
		if (!file) return;
		pendingPhoto = file;
		composer?.focus();
	}

	async function uploadSubject(file: File | null, said: string) {
		if (!file || refBusy) return;
		const kind: 'character' | 'location' = wantTarget === 'location' ? 'location' : 'character';
		refBusy = true;
		refError = '';
		try {
			const fd = new FormData();
			fd.append('file', file);
			fd.append('kind', kind);
			// Passed in, not read from the box.
			//
			// submit() clears the composer before it dispatches, so reading `input`
			// here found an empty string every time — three uploads went out
			// described only by their filename because of it, and each one looked
			// like the operator had forgotten to type.
			fd.append('description', said.trim());
			// Which conversation this belongs to. The turnaround behind it runs for
			// minutes server-side, and without this the card announcing it was posted
			// into whatever chat happened to be open when the poll caught it.
			if (runSlug) fd.append('sessionSlug', runSlug);
			const res = await fetch('/studio/api/sheet', { method: 'POST', body: fd });
			const r = (await res.json()) as {
				ok?: boolean;
				sheet?: StoredSheet;
				sheets?: StoredSheet[];
				error?: string;
			};
			if (!r.ok || !r.sheet) {
				pushError(r.error || 'That picture could not be kept.');
				return;
			}
			if (r.sheets) sheets = r.sheets;
			// Start watching. The turnaround runs server-side, so nothing else in
			// this tab will ever notice it finish — and without this the cards it
			// posts on that transition simply never arrive.
			watchSheets();
			pushItem({
				who: 'studio',
				kind: 'sheet',
				sheet: {
					kind,
					stage: 'anchor',
					uploaded: true,
					id: r.sheet.id,
					name: r.sheet.name,
					description: r.sheet.description,
					url: `/studio/api/sheet/img/${r.sheet.id}`,
					// Saved the moment it arrived — there is nothing to approve about a
					// picture you chose yourself, and nothing to launch.
					launched: true
				}
			});
			// Said out loud now, unlike the first version of this. A render starts
			// here — minutes of GPU — and someone who does not know that reads the
			// pause as the app having done nothing.
			if (kind === 'character') {
				pushStudio(
					'Building the six views behind this — a short turnaround render of the photograph, ' +
						'which is what the longer videos use to keep the same person across shots.'
				);
			}
			input = '';
			pendingPhoto = null;
			wantTarget = 'clip';
			currentCharacter = null;
			persist();
		} catch (e) {
			pushError(String(e));
		} finally {
			refBusy = false;
		}
	}

	async function describeRefFile(id: string, description: string) {
		await fetch('/studio/api/refs', {
			method: 'PATCH',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ id, description })
		});
	}


	// --- plan editing (only the latest plan, only before launch) -----------------

	let editingPlan = $state(false);
	let editTitle = $state('');
	let editStory = $state('');
	let editStyle = $state('');

	// --- per-item UI state ---------------------------------------------------------

	let expanded = $state<Record<string, boolean>>({});
	let changeOpen = $state<Record<string, boolean>>({});
	let changeText = $state<Record<string, string>>({});
	let changeBusy = $state<Record<string, boolean>>({});

	// --- rail ---------------------------------------------------------------------

	let railOpen = $state(false); // mobile toggle
	let showDetails = $state(false);

	// --- one-shot bookkeeping, deliberately non-reactive ---------------------------
	// Written from the poll loop (imperative code), read nowhere in the template.
	/* eslint-disable svelte/prefer-svelte-reactivity */
	const clipPosted = new Set<string>(); // artifact ids already shown as clips
	const failedNoted = new Set<string>(); // task ids already reported as failed
	const preAssemblyIds = new Set<string>(); // artifacts that existed before assembly
	/* eslint-enable svelte/prefer-svelte-reactivity */
	/** After a resume, preAssemblyIds is empty — "new artifact since assembly"
	 *  can no longer be told apart from a scene clip, so the final film is
	 *  recognised by name alone until this run observes an assembly itself. */
	let finalByNameOnly = false;
	let errorNoted = false; // one error chat item per error episode
	let offlineNoted = false;
	let planningLaunchAttempts = 0;
	let renderLaunchAttempts = 0;

	// Poll loop bookkeeping — plain locals, nothing here belongs on screen.
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** Epoch, bumped by every stop. A tick already awaiting its fetch when the
	 *  loop is stopped or retargeted checks this and exits instead of scheduling
	 *  a second loop against a harness whose author asked us not to hammer it. */
	let runId = 0;
	let quiet = 0;
	let lastSig = '';
	let sawAllDone = false;
	/** Whether this tab ever saw this run mid-flight.
	 *
	 *  The clip estimate is measured from the run's start to the moment the
	 *  poller notices it finished — which is the render's length only if somebody
	 *  was watching. Reopen a session whose clip landed while the tab was closed
	 *  and the poll concludes on its first tick, recording "yesterday until now".
	 *  That is how the stored sample set came to read 6746, 2557, 5428 and 5486
	 *  seconds against real renders of four to eleven minutes, and how the button
	 *  came to promise twenty-four. */
	let sawRunning = false;

	// --- proxy ------------------------------------------------------------------

	async function call(op: string, body: unknown = {}, ws: string = activeWs) {
		const res = await fetch('/api/harness', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspace: ws, op, body })
		});
		if (!res.ok) throw new Error(`proxy ${res.status}`);
		return (await res.json()) as ProxyResult;
	}

	// --- files -------------------------------------------------------------------

	function fileKeyOf(f: ArtifactFile): string {
		if (typeof f === 'string') return f;
		for (const k of ['key', 'name', 'filename', 'file']) {
			const v = f[k];
			if (typeof v === 'string' && v) return v;
		}
		return '';
	}

	function kindOf(name: string): 'image' | 'video' | 'text' | 'other' {
		const n = name.toLowerCase();
		if (/\.(png|jpe?g|webp|gif|avif)$/.test(n)) return 'image';
		if (/\.(mp4|webm|mov|m4v)$/.test(n)) return 'video';
		if (/\.(md|markdown|txt|json|ya?ml)$/.test(n)) return 'text';
		return 'other';
	}

	/** Clip filenames are NOT uniform (`scene1_clip.mp4` next to `scene3.mp4`) —
	 *  ordering reads the first number found anywhere in the artifact's identity.
	 *  No number means "sort last", never "scene zero". */
	function sceneNo(...parts: string[]): number {
		const m = parts.join(' ').match(/\d+/);
		return m ? Number(m[0]) : 999;
	}

	function firstFileOfKind(a: Artifact, kind: 'text' | 'video' | 'image'): string {
		for (const f of a.files ?? []) {
			const name = fileKeyOf(f);
			if (name && kindOf(name) === kind) return name;
		}
		return '';
	}

	/** Same-origin file route — the browser cannot read the harness directly
	 *  (no CORS on it), so everything renderable goes through this proxy. */
	function fileUrl(ws: string, artifactId: string, fileKey: string, bust = false): string {
		const q = new URLSearchParams({ workspace: ws, artifact: artifactId, file: fileKey });
		if (bust) q.set('t', String(Date.now()));
		return `/api/file?${q.toString()}`;
	}

	/** Take a copy of a clip on the server, now, while the workspace agent is
	 *  still alive to serve it.
	 *
	 *  Every clip URL goes through the harness, and the harness needs a living
	 *  workspace agent to resolve an artifact. The agent reliably dies at the
	 *  assembly step — so without this, finishing the shoot and failing the
	 *  assembly leaves every rendered clip unplayable, which is the wrong way
	 *  round: the clips are the expensive part and they were already finished.
	 *
	 *  Fire-and-forget on purpose. A failed copy costs a clip its safety net; a
	 *  copy that blocked the poll loop would cost the run its progress display. */
	function keepClip(ws: string, artifactId: string, fileKey: string): void {
		const q = new URLSearchParams({
			workspace: ws,
			artifact: artifactId,
			file: fileKey,
			warm: '1'
		});
		void fetch(`/api/file?${q.toString()}`).catch(() => {});
	}

	/** Give a video element that failed a second chance.
	 *
	 *  A clip's src is set the moment the clip is posted, which is also the moment
	 *  its local copy starts downloading — so the first request can still land on
	 *  the harness, and the harness is exactly what is unreliable at the end of a
	 *  run. An element that loses that race is stuck: a <video> that has errored
	 *  never retries, so the card sits black at 0:00 and pressing play does
	 *  nothing, even after the local copy has finished and would serve instantly.
	 *
	 *  The retry costs nothing when the first load worked, which is most of them.
	 *  The changing query is only there to stop the browser reusing its own cached
	 *  failure — the file route ignores it. */
	const videoAttempts = new WeakMap<HTMLVideoElement, number>();

	function recoverVideo(el: HTMLVideoElement, url: string): void {
		const n = videoAttempts.get(el) ?? 0;
		if (n >= 4) return;
		videoAttempts.set(el, n + 1);
		// Backing off: the copy is several megabytes, so the first retry can be
		// too early. Measured against a cold cache the recovery landed on the third
		// try, which is uncomfortably close to the end — four reach ~15s, wide
		// enough for the largest clip a run has produced.
		setTimeout(
			() => {
				el.src = `${url}${url.includes('?') ? '&' : '?'}retry=${n + 1}`;
				el.load();
			},
			1500 * (n + 1)
		);
	}

	/** Reads a planning document as text. Cache-busted: after a chain reset the
	 *  same artifact id carries new bytes. Returns null on failure — the chat
	 *  item then degrades to a link, never an empty box. */
	async function fetchDocBody(artifactId: string, fileKey: string): Promise<string | null> {
		try {
			const res = await fetch(fileUrl(planningWs, artifactId, fileKey, true));
			if (!res.ok) return null;
			const text = (await res.text()).trim();
			return text || null;
		} catch {
			return null;
		}
	}

	// --- composer: one input, three meanings --------------------------------------

	/** What the input does right now. Deliberately does NOT switch to a "sending"
	 *  state: the transcript already shows a live line for that, and a label that
	 *  flickers between two strings on every submit is noise on a surface whose
	 *  whole job is to stay calm for twenty minutes. */
	const composerHint = $derived.by(() => {
		// Simple mode has no plan to refine and no crew to message: every line is
		// another shot, whether it is the first or the fifth.
		if (mode === 'simple') {
			// Nothing above the box for a character or a location: the banner inside
			// it already says what this mode is for, and saying it twice in two
			// different wordings is how a screen stops being read at all.
			// Nothing at all in the clip state: the placeholder says the same thing
			// in the same words, five pixels lower, and one of them was always the
			// one nobody read.
			return '';
		}
		if (!brief) return 'New film — describe the idea in one sentence';
		if (!planningWs) return 'Refining the plan — describe what to change';
		if (!renderWs) return 'Message to the planning crew lead';
		return 'Message to the shooting crew lead';
	});

	/** Examples are a cure for the blank page, so they belong only on a blank
	 *  page. They go the moment the user commits to anything — not when the plan
	 *  comes back, which is several seconds later and leaves them sitting under
	 *  the user's own message looking like unread options. */
	/** Seconds the current request has been in flight — drives the live counter
	 *  next to the busy line. Reset on every send so it always counts this call,
	 *  not the session. */
	let sendingSince = $state(0);
	let sendingFor = $state(0);
	/** What this wait has cost before, from this machine's own finished runs.
	 *  Read when the wait starts rather than derived: the source is localStorage,
	 *  which nothing can subscribe to, and the answer cannot change while a
	 *  single request is in flight. Null until there are enough runs to mean
	 *  something — see typicalWait. */
	let typicalPrompt = $state<number | null>(null);
	let typicalClip = $state<number | null>(null);
	$effect(() => {
		if (!sending) {
			sendingFor = 0;
			return;
		}
		typicalPrompt = typicalWait('prompt');
		sendingSince = Date.now();
		const id = setInterval(() => {
			sendingFor = Math.round((Date.now() - sendingSince) / 1000);
		}, 1000);
		return () => clearInterval(id);
	});

	/** Half again as long as usual. Not an error — a cold model load does this
	 *  legitimately — but it is the moment the reader starts wondering, and
	 *  saying it first is the difference between a slow page and a broken one. */
	const OVERDUE = 1.5;
	const promptOverdue = $derived(
		!!typicalPrompt && sendingFor * 1000 > typicalPrompt * OVERDUE
	);
	const clipOverdue = $derived(
		!!typicalClip && startedAt > 0 && now - startedAt > typicalClip * OVERDUE
	);

	/** Which document cards the GPU gate opens. Not persisted: the gate is a
	 *  single decision made once, and a reopened production is past it. */
	let gateOpen = $state<Record<string, boolean>>({});

	/** The gate's review list. Visual bible first and visually lifted: it is the
	 *  document every render prompt inherits verbatim, so a mistake there is the
	 *  one that shows up in all four clips. */
	const GATE_NOTES: Record<string, string> = {
		visual_bible: 'how every character and place will look — inherited by every shot',
		art_direction: 'the visual language of the whole film',
		scene_list: 'what happens in each scene',
		character_table: 'who appears and how they are described',
		screenplay: 'the script the scenes came from'
	};
	const GATE_ORDER = [
		'visual_bible',
		'art_direction',
		'scene_list',
		'character_table',
		'screenplay'
	];

	const summaryDocs = $derived.by(() =>
		GATE_ORDER.map((key) => {
			const step = PLANNING_STEPS.find((s) => s.artifact === key);
			return {
				key,
				artifact: key,
				label: step?.label ?? key,
				note: GATE_NOTES[key] ?? '',
				file: docFile[key] ?? '',
				body: docBody[key] ?? ''
			};
		}).filter((d) => d.body)
	);

	/** Only while the transcript holds nothing but the greeting.
	 *
	 *  It used to ask whether the user had said anything, which is not the same
	 *  question: keeping a picture, a sheet card, an error or a run's activity
	 *  all leave the transcript full while `who === 'user'` never appears, so the
	 *  seed cards sat under the reply. And because this same flag puts
	 *  `justify-center` on the scroll container, a transcript taller than the box
	 *  was then centred inside it — which puts its top above scrollTop 0, where
	 *  nothing can reach it. One wrong predicate, two bugs. */
	const showExamples = $derived(
		!brief && !sending && chat.every((c) => c.id === welcomeId)
	);

	const composerPlaceholder = $derived.by(() => {
		// An instruction, not an example. A worked example belongs on the empty
		// page, where there is room to read three of them and pick one; in the box
		// it has to be short enough to set on one line, and it was not — the old
		// simple-mode line ran to 74 characters and clipped against a rows="1"
		// field whose autosize only runs on input, so half of it was never seen.
		// It also put explicit copy in the chrome, where it greets anyone walking
		// past the machine before they have asked for anything.
		if (mode === 'simple') {
			if (wantTarget === 'character')
				return currentCharacter ? 'Describe the change' : 'Describe the person, with an age';
			if (wantTarget === 'location') return 'Describe the place';
			return 'Describe one shot';
		}
		if (!brief) return 'Describe the film in one sentence';
		if (!planningWs) return 'Describe what to change';
		return 'Message the crew';
	});

	async function submit() {
		const text = input.trim();
		// The row appears now, not when a GPU starts. Idempotent, so the second
		// message of a session does nothing here.
		if (text || pendingPhoto) void startSession(text || pendingPhoto?.name || 'New session');
		// A held photograph is a message on its own: the picture is the character,
		// and the description is optional. Without this the send button stays dead
		// until you type something, which reads as the attachment not having worked.
		if ((!text && !pendingPhoto) || sending) return;
		input = '';
		shrink(composer);
		pushItem({ who: 'user', kind: 'text', text });
		sending = true;
		try {
			// Simple mode never plans. Every message is a scene to render, and the
			// answer is the prompt itself — offered for reading and editing before
			// it costs anything.
			if (mode === 'simple') {
				if (pendingPhoto && wantTarget !== 'clip') await uploadSubject(pendingPhoto, text);
				else if (continuing) await continueFromRequest(text);
				// Read it back first, in a sentence, before spending anything on it.
				// The brief and the render follow from the button on that card —
				// see confirmFromRequest and acceptConfirm.
				else if (wantTarget === 'clip') await confirmFromRequest(text);
				else await sheetFromRequest(text, wantTarget);
			}
			else if (!brief) await planFromIdea(text);
			else if (!planningWs) await refinePlan(text);
			else await managerChat(text);
		} catch (e) {
			// A throw here used to be invisible: the try had a finally and no catch,
			// so an exception after the response arrived — a body that would not
			// parse, most likely — cleared the spinner and put nothing in the
			// transcript. No card, no error, no clue. That happened, and the only
			// way to tell it apart from "the writer is still thinking" was to read
			// the source. Whatever breaks, say so on screen.
			pushError(`Something went wrong sending that: ${e instanceof Error ? e.message : e}`);
		} finally {
			sending = false;
		}
	}

	// --- simple mode: one prompt, one clip -------------------------------------------

	/** Ask the writer for a render prompt. `pin` carries a duration or a frame the
	 *  user has already moved on the card: both change the beat structure — the
	 *  timestamps come from the duration and the camera language from the shape of
	 *  the frame — so the prompt is written again rather than patched. */
	async function callShotPrompt(
		request: string,
		pin?: {
			seconds?: number;
			orientation?: 'portrait' | 'landscape';
			character?: string;
			/** The kept character's voice, when they have one. Sent so the writer
			 *  names it rather than inventing a new one for this clip. */
			voice?: string;
			location?: string;
			continues?: {
				priorPrompt?: string;
				priorLoras?: Pick[];
				pinned?: boolean;
				/** The two plates are frames of the prior clip, not kept sheets. */
				platesFromClip?: boolean;
			};
		}
	): Promise<ChatItem['shot'] | null> {
		const askedAt = Date.now();
		let res: Response;
		try {
			res = await fetch('/studio/api/shotprompt', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ request, ...pin })
			});
		} catch (e) {
			pushError(`Could not reach the prompt writer: ${e}`);
			return null;
		}
		if (!res.ok) {
			const m = (await res.json().catch(() => null)) as { message?: string } | null;
			pushError(m?.message || `The prompt could not be written (${res.status}).`);
			return null;
		}
		let r: { ok: boolean; shot?: ChatItem['shot']; warn?: string[]; fixed?: string[]; error?: string };
		try {
			r = (await res.json()) as typeof r;
		} catch {
			pushError('The prompt writer answered with something this page could not read.');
			return null;
		}
		// Carried onto the shot so the card can say it. The server has already given
		// the writer one chance to clear these; what is left is worth reading before
		// pressing render, and worth nothing at all after.
		if (r.shot && r.warn?.length) r.shot.warn = r.warn;
		if (r.shot && r.fixed?.length) r.shot.fixed = r.fixed;
		// Snapshot the writer's own choice the moment it arrives. Everything after
		// this can be edited on the card; this copy is what the edit is measured
		// against, so it is taken before anyone can touch it.
		if (r.shot) r.shot.wroteLoras = (r.shot.loras ?? []).map((p) => ({ ...p }));
		if (!r.ok || !r.shot) {
			pushError(r.error || 'The prompt could not be written.');
			return null;
		}
		// Only the path that produced a shot. A failure tells you how long the
		// failure took, which is not what the waiting line is promising.
		recordWait('prompt', Date.now() - askedAt);
		return r.shot;
	}

	/** Frame size, as three named steps rather than a pair of numbers.
	 *
	 *  Two constraints, and together they leave far fewer sizes than either does
	 *  alone. Both sides must divide by 32, which the workflow requires. And the
	 *  ratio must be one the harness recognises — it validates the profile
	 *  against a fixed list and rejects the workspace outright otherwise:
	 *
	 *    480x832 is not a supported aspect ratio (expected one of: 1:1, 16:9,
	 *    9:16, 4:3, 3:4, 3:2, 2:3, 21:9)
	 *
	 *  A first attempt at this offered 480p and 720p at 832x480 and 1280x704,
	 *  which divide by 32 and are not 16:9 — 1.733 and 1.818 against 1.778 — so
	 *  both were refused before a GPU was touched. Between 256 and 1920 there are
	 *  exactly three 16:9 sizes whose sides both divide by 32, and these are they.
	 *
	 *  Named for the short edge, which is what they actually are. The steps are
	 *  wide apart because that is where the arithmetic put them: a quarter of the
	 *  pixels, the middle, and two and a quarter times. 576p stays the default —
	 *  every clip so far was made at it. */
	const RESOLUTIONS = {
		'288p': { long: 512, short: 288 },
		'576p': { long: 1024, short: 576 },
		'864p': { long: 1536, short: 864 }
	} as const;
	type ResKey = keyof typeof RESOLUTIONS;
	const RES_KEYS = Object.keys(RESOLUTIONS) as ResKey[];

	function frameFor(res: ResKey, orientation: 'portrait' | 'landscape') {
		const { long, short } = RESOLUTIONS[res] ?? RESOLUTIONS['576p'];
		return orientation === 'portrait'
			? { width: short, height: long }
			: { width: long, height: short };
	}

	/** What the composer is set to for the next clip.
	 *
	 *  These used to exist only on the card, which meant the writer produced a
	 *  brief at whatever it felt like and changing the length or the frame threw
	 *  that brief away and asked for another — the beats are derived from the
	 *  duration and the camera language from the shape, so a change there is a
	 *  rewrite, not a relabel. Setting them before you send spends one call
	 *  instead of two.
	 *
	 *  Kept across reloads: these are how you work, not what this clip is. */
	const SETUP_KEY = 'auteur-studio-setup';
	let wantSeconds = $state(8);
	let wantOrientation = $state<'portrait' | 'landscape'>('portrait');
	let wantRes = $state<ResKey>('576p');
	/** What the next message makes. A clip is the default and the common case;
	 *  the other two make a reference sheet instead, and they are here rather
	 *  than on a separate screen because they are the same act — you describe
	 *  something and the machine renders it. */
	let wantTarget = $state<'clip' | 'character' | 'location'>('clip');

	/** The wait named by what is being made, not by the machinery making it.
	 *  "writing the prompt" was true of all three simple-mode waits, which is
	 *  what made it useless: it never told you which one you were in. The chosen
	 *  face is deliberately not repeated here — the chip saying so is two lines
	 *  below, and a line this small should not spend half its width on it. */
	const sendingWhat = $derived(
		mode !== 'simple'
			? brief && planningWs
				? 'the crew is replying'
				: 'planning'
			: wantTarget === 'character'
				? 'writing the character'
				: wantTarget === 'location'
					? 'writing the location'
					: 'writing the shot'
	);

	/** The kept character the next clip is shot with, by id. Empty means the clip
	 *  invents whoever the words describe, which is the old behaviour and stays
	 *  the default. */
	let wantCharacter = $state('');
	/** The kept location the next clip is shot in. Empty means the clip invents
	 *  wherever the words describe, which stays the default. */
	let wantLocation = $state('');

	/** The composer used to carry both kept rows open at all times, each capped
	 *  at three by `slice(0, 3)` — so a fourth character was unreachable from
	 *  here and nothing on screen said so. Both rows fold into one menu: level
	 *  one is what you can add, level two is a grid of everything you keep.
	 *  What you picked does not go with them; it comes back as a chip. */
	let addOpen = $state(false);
	/** null while the grid is closed, otherwise which kind it is showing. */
	let pickKind = $state<null | 'character' | 'location'>(null);
	/** Length, size and frame, folded for the same reason: all three have a
	 *  saved default that works, so none of them blocks a first send. */
	let fmtOpen = $state(false);
	/** One clip or a full production. It used to sit in the header, where it read
	 *  as a property of the page; it is a property of the message you are about
	 *  to send, so it belongs beside the send button. */
	let modeOpen = $state(false);

	/** How many takes one message makes.
	 *
	 *  One is the resting answer and always will be: the common case must not pay
	 *  for the rare one. Above one, the same beat is rendered that many times with
	 *  different seeds, at once — the harness runs four together, and four at once
	 *  cost about what one costs, where four in a row cost four cold starts.
	 *
	 *  It lives on the mode chip rather than beside it because that chip already
	 *  answers the same question — what will this message make — and because this
	 *  is the first control here where one press spends four times. A commitment
	 *  like that has to be readable without opening anything. */
	let takes = $state(1);
	/** How many camera angles the same beat is shot from.
	 *
	 *  A second axis, not a second mode: every message makes `takes × angles`
	 *  clips, and "one clip" is simply 1 × 1. Both end the same way — you look at
	 *  what came back and carry one forward — and they differ only in what varies
	 *  between them, the seed or the camera.
	 *
	 *  The product is capped at MAX_AT_ONCE because that is the harness's
	 *  RENDER_PARALLELISM: every allowed combination is one warm batch of about
	 *  210 seconds. Without the cap 3 × 3 is nine renders in three waves, and the
	 *  thing this app promises about speed quietly stops being true. */
	let angles = $state(1);
	const MAX_AT_ONCE = 4;
	/** What the next message will make, in the fewest words that are still true.
	 *  With one axis raised the beat is named; with both, only the total is —
	 *  "2 camera angles, 2 versions each" on a chip is a recipe, and the chip's
	 *  job is the size of the commitment. The breakdown is one tap away. */

	function shutMenus() {
		addOpen = false;
		pickKind = null;
		fmtOpen = false;
		modeOpen = false;
	}

	function saveSetup() {
		try {
			localStorage.setItem(
				SETUP_KEY,
				JSON.stringify({
					s: wantSeconds,
					o: wantOrientation,
					r: wantRes,
					t: wantTarget,
					c: wantCharacter,
					l: wantLocation,
					// Not persisted for a while, which made it the one composer setting
					// that silently reset — and the one whose reset costs money in the
					// wrong direction is worth writing down.
					k: takes,
					kk: angles
				})
			);
		} catch {
			/* a preference that will not persist is not worth an error */
		}
	}

	/** What the user typed, kept so a rewrite asks for the same scene again rather
	 *  than editing the prompt the model last produced. */
	let lastRequest = $state('');

/** The rounds already agreed in this session, oldest first.
 *
 *  Read out of the chat rather than kept in a variable, for the same reason the
 *  awaited sheets are: the conversation is the record and a variable is not. It
 *  survives a reload; a variable does not, and a refinement that has forgotten
 *  what it is refining silently drops everything said before it. */
/** The operator's half and ours, told apart.
 *
 *  The read-back is what they said; anything after the marker is what the
 *  studio is filling in for them. Rendered at the same weight they read as one
 *  paragraph, and then a room nobody asked for looks like a room they asked
 *  for — which is precisely the agreement this layer exists to make honest.
 *
 *  Split on the marker the writer is told to emit rather than on sentence
 *  punctuation: a full stop is in every abbreviation and half the prose, and a
 *  wrong split here would attribute their own words to us. No marker means
 *  there was nothing to add, which is a normal and good answer. */
	function splitConfirm(line: string): { said: string; added: string } {
		const at = line.search(/(^|[.!?…]\s+)(Hozzátettük|We added)\s*:/i);
		if (at === -1) return { said: line, added: '' };
		const marker = line.slice(at).search(/(Hozzátettük|We added)\s*:/i);
		// The marker stays. It used to be stripped, back when the second half was
		// the proposal itself and "Hozzáteszem:" was just a seam. It is an
		// attribution now — take the word off and the line opens lower-case in the
		// middle of a thought, and stops saying whose the list is.
		return { said: line.slice(0, at + marker).trim(), added: line.slice(at + marker).trim() };
	}

		function confirmHistory(): string[] {
		const out: string[] = [];
		for (const c of chat) {
			if (c.kind === 'confirm' && c.confirm?.line && !c.confirm.sent) out.push(c.confirm.line);
		}
		return out;
	}

	/** Read back what is about to be shot, streamed, before anything is written.
	 *
	 *  The card is pushed empty and filled in as the text arrives. pushItem hands
	 *  back the state proxy for exactly this. */
	async function confirmFromRequest(said: string) {
		const item = pushItem({
			who: 'studio',
			kind: 'confirm',
			confirm: { said, line: '', streaming: true }
		});
		const askedAt = Date.now();
		try {
			const res = await fetch('/studio/api/shotconfirm', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					request: said,
					seconds: composerShape.seconds,
					res: composerShape.res,
					aspect: composerShape.portrait ? '9:16' : '16:9',
					makes: batchLabel,
					character: chosenCharacter?.name,
					location: chosenLocation?.description || chosenLocation?.name,
					refs: refFiles.map((f) => f.description || f.name).filter(Boolean),
					history: confirmHistory()
				})
			});

			// One endpoint, two shapes: a stream when it worked, our house JSON
			// error when it did not. Content-type tells them apart, so neither has
			// to lie about its status code.
			if (!res.ok || !res.body || (res.headers.get('content-type') ?? '').includes('json')) {
				const r = (await res.json().catch(() => null)) as { error?: string } | null;
				item.confirm!.error = r?.error || `that could not be read back (${res.status})`;
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				item.confirm!.line += decoder.decode(value, { stream: true });
			}
			if (!item.confirm!.line.trim()) {
				item.confirm!.error = 'nothing came back — try sending that again';
			}
		} catch (e) {
			item.confirm!.error = `that could not be read back — ${e instanceof Error ? e.message : e}`;
		} finally {
			item.confirm!.streaming = false;
			recordWait('confirm', Date.now() - askedAt);
			persist();
		}
	}

	/** The operator pressed the button: write the brief, check it, and shoot.
	 *
	 *  What goes to the writer is BOTH texts, the raw one first. The writer is
	 *  told to use the operator's own plain words and it can only do that if it
	 *  has them — a read-back is a restatement, and a restatement that has been
	 *  through a model is not a safe place to keep the only copy of what somebody
	 *  actually asked for. The accepted line follows it as the agreed reading.
	 *
	 *  It renders on its own from here. That is the whole point: the brief is not
	 *  a thing to approve twice. The one exception is a brief the checker had to
	 *  change — then it stops and says what changed, because that is a different
	 *  clip from the one that was agreed to.
	 */
/** Start a brief the way its own card would.
 *
 *  The composer can be set to several takes or several camera angles, and the
 *  card offers renderBatch for those — calling renderShot from here regardless
 *  would quietly deliver one clip where two were asked for and read back. */
	async function startFromCard(card: ChatItem): Promise<void> {
		if (!card.shot) return;
		const cardAngles = card.shot.continues && card.shot.continues.pinned !== false ? 1 : angles;
		const n = takes * cardAngles;
		if (n > 1) await renderBatch(card.id, takes, cardAngles);
		else await renderShot(card.id);
	}

		async function acceptConfirm(itemId: string) {
		const item = chat.find((c) => c.id === itemId);
		const c = item?.confirm;
		if (!c || shotBusy[itemId]) return;
		shotBusy[itemId] = true;
		c.error = undefined;
		try {
			// Second press: the brief already exists and was shown, changes and all.
			// Write it again and the operator is shown one set of changes and shoots
			// another — and pays a minute for the privilege.
			const already = c.cardId ? chat.find((x) => x.id === c.cardId) : undefined;
			if (already?.shot && !already.shot.launched) {
				c.fixed = undefined;
				await startFromCard(already);
				return;
			}

			c.fixed = undefined;
			const request = c.line.trim() ? `${c.said}\n\n---\n\n${c.line.trim()}` : c.said;
			const card = await shotFromRequest(request);
			if (!card?.shot) return;

			c.sent = true;
			c.cardId = card.id;
			// Stop and say so. A brief the checker rewrote is not the brief that was
			// read back, and letting it shoot anyway would mean the sentence they
			// approved was not the order — which is the one thing this whole layer
			// exists to prevent.
			if (card.shot.fixed?.length) {
				c.fixed = card.shot.fixed;
				return;
			}
			await startFromCard(card);
		} catch (e) {
			c.error = `that could not be started — ${e instanceof Error ? e.message : e}`;
		} finally {
			shotBusy[itemId] = false;
			persist();
		}
	}

	async function shotFromRequest(request: string): Promise<ChatItem | null> {
		// Pinned from the composer, so the brief arrives written for this length
		// and this frame rather than being rewritten into them afterwards.
		const shot = await callShotPrompt(request, {
			seconds: wantSeconds,
			orientation: wantOrientation,
			character: chosenCharacter?.name,
			// Carried so the writer names this person's voice rather than inventing
			// one. Without it every clip is an independent roll and the same woman
			// comes back sounding like somebody else two shots later.
			voice: chosenCharacter?.voice,
			// The description, not the label.
			//
			// The writer's only knowledge of the place is this string, and a plate
			// uploaded without a description falls back to its filename — so it was
			// being told "the location IMG 2482" and inventing the room from the act
			// instead. A scene that needs no furniture survives that; one that needs
			// a surface gets a mattress conjured into a dining room.
			location: chosenLocation?.description || chosenLocation?.name
		});
		if (!shot) return null;
		lastRequest = request;
		shot.resolution = wantRes;
		// Stamped onto the card rather than read at launch: the brief was written
		// for this person, so a card that renders with a different one — because
		// the picker moved while you were reading — would be a brief describing
		// somebody who is not in the shot.
		if (chosenCharacter) {
			shot.characterId = chosenCharacter.id;
			shot.characterName = chosenCharacter.name;
		}
		if (chosenLocation) {
			shot.locationId = chosenLocation.id;
			shot.locationName = chosenLocation.name;
		}
		return pushItem({ who: 'studio', kind: 'shot', shot });
	}

	/** Put the composer into continuation mode for one clip.
	 *
	 *  Nothing is rendered here — this only changes what the next message means.
	 *  The character and the location come from the render log rather than the
	 *  pickers: a continuation is of a particular clip, and swapping either would
	 *  make it a different scene wearing the same seam. */
	function startContinue(item: ChatItem) {
		const ws = item.artifact?.workspace ?? '';
		const info = contInfo(ws);
		// A joined scene has no artifact id of its own — it is a file assembled
		// here out of clips that each have one. So continue its LAST PART, which
		// is what continuing a scene means anyway: the scene ends where that clip
		// ends, and the workflow reads its reference video from the start, so
		// handing it a 25-second assembly would ask the model to guess what
		// follows second 25 from the first few seconds of it.
		//
		// Until now the button was offered on the scene card and answered with an
		// error, which is a wall placed exactly where somebody would carry on.
		const part = item.artifact?.id
			? { artifact: item.artifact.id, file: item.artifact.files?.[0]?.name ?? '' }
			: (() => {
					const chain = chainOf(ws);
					const last = chain[chain.length - 1];
					return last ? { artifact: last.artifact, file: last.file } : null;
				})();
		if (!info.ok || !info.row || !part?.artifact || !part.file) {
			pushError(info.why || 'this clip cannot be continued');
			return;
		}
		continuing = {
			workspace: ws,
			artifact: part.artifact,
			file: part.file,
			// Either may be absent, and that is no longer a refusal: the launch
			// cuts the missing plate out of the clip. Passed through as undefined
			// rather than coerced, so the server can tell "none was kept" from
			// "this one".
			characterId: info.row.characterId,
			locationId: info.row.locationId,
			characterName: info.row.characterName,
			locationName: info.row.locationName,
			exact: info.exact
		};
		pinSeam = true;
		// Angles cannot apply to a pinned seam, and a chip left reading "2 camera
		// angles" with the row inert is a control the user cannot put down. Reset it
		// here: a continuation starts as one clip per version, and raising it again
		// is one tap once the seam is free.
		angles = 1;
		saveSetup();
		wantTarget = 'clip';
		composer?.focus();
	}

	/** Write the continuation brief and offer it, exactly as a clip is offered. */
	async function continueFromRequest(request: string) {
		const c = continuing;
		if (!c) return;
		const prior = logRow[c.workspace];
		// The length is yours, and only the length.
		//
		// This followed the prior clip for a while, on the same argument that makes
		// the frame follow it. That argument does not reach this far: two pieces at
		// different sizes cannot be concatenated, but two pieces of different
		// LENGTHS join perfectly well. Deciding how long the next beat runs is a
		// director's choice and taking it away was a mistake.
		//
		// What actually went wrong was never the source of the number, it was that
		// there were two of them — the card's and the composer's — and only one was
		// on screen. They are kept in step now, at setShotSeconds.
		const shot = await callShotPrompt(request, {
			seconds: wantSeconds,
			orientation: wantOrientation,
			character: c.characterName,
			// From the character the clip was shot with, not the composer's current
			// pick — a continuation is of a particular clip, and the person in it is
			// whoever was in it. The continuation writer is told to carry the prior
			// brief's voice sentence across; this pins it for the case where that
			// brief predates the rule and names none.
			voice: characters.find((x) => x.id === c.characterId)?.voice,
			location: c.locationName,
			continues: {
				priorPrompt: prior?.prompt,
				priorLoras: prior?.launched,
				pinned: pinSeam,
				// So the writer knows what the two plates are. A frame of the scene
				// and a sheet on a grey backdrop want opposite retention rules, and
				// getting that backwards throws away the room.
				platesFromClip: c.exact === false
			}
		});
		if (!shot) return;
		lastRequest = request;
		// The frame follows the clip being continued, not the composer: two pieces
		// at different sizes cannot be joined, and joining is the whole point.
		//
		// This said exactly that and then read the composer anyway, so a clip whose
		// size was set on its own card was continued at whatever the composer still
		// had — and the join refused the pair it had just offered to make, after
		// both renders were paid for. The composer is the fallback now, for a prior
		// row that has no size recorded.
		if (prior?.width && prior?.height) {
			const longest = Math.max(prior.width, prior.height);
			shot.resolution = RES_KEYS.find((k) => RESOLUTIONS[k].long === longest) ?? wantRes;
			shot.orientation = prior.width >= prior.height ? 'landscape' : 'portrait';
		} else {
			shot.resolution = wantRes;
		}
		shot.continues = { ...c, pinned: pinSeam };
		shot.characterId = c.characterId;
		shot.characterName = c.characterName;
		shot.locationId = c.locationId;
		shot.locationName = c.locationName;
		continuing = null;
		pushItem({ who: 'studio', kind: 'shot', shot });
	}

	/** Glue every clip in this one's chain into a single scene. */
	async function joinScene(ws: string) {
		if (joining[ws]) return;
		const parts = chainOf(ws);
		if (parts.length < 2) {
			pushError('there is only one clip here — nothing to join yet');
			return;
		}
		joining[ws] = true;
		try {
			const res = await fetch('/studio/api/join', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ parts })
			});
			const r = (await res.json()) as {
				ok?: boolean;
				error?: string;
				url?: string;
				parts?: number;
				seconds?: number;
			};
			if (!r.ok || !r.url) {
				pushError(r.error || 'the scene could not be assembled');
				return;
			}
			pushItem({
				who: 'studio',
				kind: 'clips',
				text: `The whole scene — ${r.parts} clips, ${r.seconds}s.`,
				artifact: {
					key: 'scene',
					title: 'The whole scene',
					taskId: '',
					files: [{ name: 'scene.mp4', url: r.url }],
					workspace: ws
				}
			});
			persist();
		} catch (e) {
			pushError(`the scene could not be assembled: ${e}`);
		} finally {
			joining[ws] = false;
		}
	}

	/** The same first-name rule the store uses, applied here so the card shows the
	 *  name it is about to be saved under rather than an empty box. */
	function firstWords(description: string, kind: 'character' | 'location'): string {
		const words = description
			.replace(/[\n\r]+/g, ' ')
			// A character description is required to open with the workflow's own
			// framing — the sheet writer is told to begin exactly "A photography of
			// full body of" — so the first six words are that formula every single
			// time, and every character was offered the same name. Drop it and the
			// six words that follow are the person.
			.replace(/^\s*a\s+photograph(?:y|)\s+of\s+(?:a\s+)?full\s+body\s+of\s+/i, '')
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 6)
			.join(' ')
			.slice(0, 60)
			.trim();
		return words || (kind === 'character' ? 'Character' : 'Location');
	}

	// --- sheets: a character or a location, kept and reused ------------------------

	/** Every sheet this machine has made, newest first. Loaded once on mount and
	 *  refreshed by every write, so a picker never has to ask. */
	let sheets = $state<StoredSheet[]>([]);
	const characters = $derived(sheets.filter((s) => s.kind === 'character'));
	const locations = $derived(sheets.filter((s) => s.kind === 'location'));
	/** The chosen character, or undefined once it has been deleted from under us.
	 *  Derived rather than stored so a removed sheet cannot be launched with. */
	const chosenCharacter = $derived(characters.find((c) => c.id === wantCharacter));
	const chosenLocation = $derived(locations.find((l) => l.id === wantLocation));
	let sheetBusy = $state<Record<string, boolean>>({});


	/** Three voices worth having without writing one.
	 *
	 *  Physical description only — pitch, weight, accent, pace. Not a mood and
	 *  not a character trait: the model renders what a microphone would pick up,
	 *  and "confident" is not a sound. */
	const VOICE_PRESETS = [
		{ label: 'low and husky', text: 'a low, warm, slightly husky adult female voice, neutral American accent, unhurried' },
		{ label: 'bright and young', text: 'a bright, light adult female voice, neutral American accent, quick and forward' },
		{ label: 'soft and breathy', text: 'a soft, breathy adult female voice, neutral American accent, close and unhurried' }
	];

	/** The voice being edited.
	 *
	 *  A writable derived, not a $state seeded once: a local copy of a derived
	 *  value stays frozen when the source changes, so switching characters would
	 *  leave the previous one's sentence in the box and save it onto the wrong
	 *  person at the next blur. This tracks whoever is chosen and still takes
	 *  typing. */
	// The stored voice, or the one a character made today would be given. Every
	// character has one from the moment it exists now; only the ones made before
	// that fall back, and they fall back to real text rather than to grey
	// suggestion text that reads as filled in and renders as silence.
	let voiceDraft = $derived(chosenCharacter?.voice ?? DEFAULT_VOICE);

	/** Written on blur, not behind a Save button. There is one field and it is
	 *  one sentence; a button to confirm a sentence is a button nobody needs. */
	async function saveVoice() {
		const c = chosenCharacter;
		if (!c) return;
		const next = voiceDraft.trim().slice(0, 240);
		if (next === (c.voice ?? '')) return;
		try {
			const res = await fetch('/studio/api/sheet', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: c.id, voice: next })
			});
			const r = (await res.json()) as { ok?: boolean; sheets?: StoredSheet[]; error?: string };
			if (r.ok && r.sheets) sheets = r.sheets;
			else pushError(r.error || 'the voice could not be saved');
		} catch (e) {
			pushError(`the voice could not be saved — ${e}`);
		}
	}

	async function loadSheets() {
		try {
			const res = await fetch('/studio/api/sheet');
			if (!res.ok) return;
			const r = (await res.json()) as { ok?: boolean; sheets?: StoredSheet[] };
			if (r.sheets) sheets = r.sheets;
		} catch {
			/* the list is a convenience; failing to load it must not break the page */
		}
	}

	/** Render a sheet from a plain-English description.
	 *
	 *  No writer stands between the two. Both sheet workflows take a description
	 *  rather than a structured prompt — their own port notes say so in as many
	 *  words — so a writer here would only have prose to paraphrase, and every
	 *  paraphrase is a chance to lose the detail you actually cared about.
	 */
	/** The character currently being worked on: the description that produced the
	 *  last preview and the seed it was rendered with.
	 *
	 *  Both travel forward. The description so the next message can refine it
	 *  rather than start over, and the seed so refining changes the person because
	 *  of the words rather than because the noise moved — and so the full sheet,
	 *  when you ask for it, is a turnaround of the face you approved. */
	let currentCharacter = $state<{ description: string; seed: number } | null>(null);

	async function sheetFromRequest(request: string, kind: 'character' | 'location') {
		try {
			// The writer is back in front of a character, and it is worth being clear
			// about what it buys, because it was taken out and put back in one
			// afternoon. It no longer exists to translate — the audience is English
			// — it exists because a four-word description leaves the model to invent
			// the rest at random, and a random face is not something anyone can
			// refine. It fills identity gaps only, in a few words, and says which
			// ones it filled.
			//
			// It costs about ten seconds, measured. That is more than the five it
			// cost when it only translated, and the difference is output length
			// rather than the model: grok-4.5 and grok-fast came in at the same
			// number, so this sits on grok-fast.
			const res = await fetch('/studio/api/sheetprompt', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					request,
					kind,
					// A refinement merges into the description already on screen
					// rather than starting over from the few words you just typed.
					...(currentCharacter ? { previous: currentCharacter.description } : {})
				})
			});
			const r = (await res.json()) as {
				ok?: boolean;
				sheet?: { kind: 'character' | 'location'; description: string; voice?: string; why?: string };
				error?: string;
			};
			if (!r.ok || !r.sheet) {
				pushError(r.error || 'The description could not be prepared.');
				return;
			}
			// Neither stops to be approved any more. A preview costs a third of a
			// sheet and is the same picture the sheet would build on, so it is a
			// better thing to react to than a paragraph — you look at it and say
			// what to change.
			const seed = currentCharacter?.seed ?? Math.floor(Math.random() * 1_000_000_000);
			currentCharacter = { description: r.sheet.description, seed };
			await previewSubject(kind, r.sheet.description, seed, r.sheet.why, r.sheet.voice);
		} catch (e) {
			pushError(String(e));
		}
	}

	/** A character preview, rendered without the harness.
	 *
	 *  The full sheet still goes through launchSheetRender and a workspace; only
	 *  this one skips it, because only this one has nothing for the harness to
	 *  decide. Measured, that is 112 seconds against 150.
	 *
	 *  The job is detached server-side and polled here, rather than the request
	 *  being held open for two minutes: a reload during a render would otherwise
	 *  abandon GPU time that is already being paid for.
	 */
	let previewBusy = $state(false);

	async function previewSubject(
		kind: 'character' | 'location',
		description: string,
		seed: number,
		why?: string,
		/** Written by the same call that wrote the description, and carried here so
		 *  it is on the card before the picture is — keeping the character then
		 *  files the voice with the face rather than leaving the field empty for
		 *  somebody to fill in by hand. */
		voice?: string
	) {
		if (previewBusy) return;
		previewBusy = true;
		const card = pushItem({
			who: 'studio',
			kind: 'sheet',
			sheet: { kind, stage: 'anchor', description, why, seed, voice, launched: true }
		});
		try {
			const res = await fetch('/studio/api/anchor', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ description, seed, kind })
			});
			const r = (await res.json()) as { ok?: boolean; job?: string; error?: string };
			if (!r.ok || !r.job) {
				card.kind = 'error';
				card.text = r.error || 'The preview did not start.';
				return;
			}
			// Durable before the picture exists, not after it arrives.
			//
			// This handle is the only way back to a render that runs server-side
			// for roughly two minutes, and it used to be written onto the card only
			// once the loop below saw the picture land. Reload during those two
			// minutes and the id was gone: the card came back saying "Rendering…"
			// with its button dead, and the finished PNG sat on disk with nothing
			// able to ask for it.
			if (card.sheet) card.sheet.job = r.job;
			persist();
			await followPreview(card, r.job);
		} catch (e) {
			card.kind = 'error';
			card.text = String(e);
		} finally {
			previewBusy = false;
		}
	}

	/** Watch a character preview to its end. Separate from starting one, because
	 *  a reload has to be able to do the second half without the first. */
	async function followPreview(card: ChatItem, job: string) {
		{
			const started = Date.now();
			for (;;) {
				if (Date.now() - started > 10 * 60 * 1000) {
					card.kind = 'error';
					card.text = 'The preview did not finish within ten minutes.';
					return;
				}
				await new Promise((r2) => setTimeout(r2, 2500));
				let st: { ok?: boolean; phase?: string; url?: string; error?: string; elapsedSec?: number };
				try {
					const p = await fetch(`/studio/api/anchor?job=${encodeURIComponent(job)}`);
					st = (await p.json()) as typeof st;
				} catch {
					continue;
				}
				if (st.phase === 'failed') {
					card.kind = 'error';
					card.text = st.error || 'The preview failed.';
					persist();
					return;
				}
				// A reply with no phase at all is the "no such preview" envelope: the
				// job is gone, not slow. Treated as still running it would spin until
				// the ten minutes were up.
				if (!st.phase && st.ok === false) {
					card.kind = 'error';
					card.text = st.error || 'That preview is gone — render it again.';
					persist();
					return;
				}
				if (st.phase !== 'done' || !st.url) continue;
				if (card.sheet) {
					card.sheet.url = st.url;
					card.sheet.job = job;
					card.sheet.name = firstWords(card.sheet.description ?? '', card.sheet.kind);
				}
				persist();
				return;
			}
		}
	}

	/** Re-attach to any preview that was still rendering when this tab last
	 *  closed. The render did not stop when the page did. */
	function resumePreviews() {
		for (const c of chat) {
			const sh = c.sheet;
			if (c.kind !== 'sheet' || !sh) continue;
			if (sh.stage !== 'anchor' || sh.url || !sh.job) continue;
			void followPreview(c, sh.job);
		}
	}

	/** The one road to the GPU for anything sheet-shaped. Returns true when the
	 *  render actually started. */
	async function launchSheetRender(opts: {
		kind: 'character' | 'location';
		description: string;
		stage: 'anchor' | 'sheet';
		seed: number;
		why?: string;
	}): Promise<boolean> {
		// Guarded the same way a clip launch is, and no more strictly. There is one
		// render slot and starting a second render retargets it — that is already
		// true of every clip you launch, so a sheet must not be the one thing that
		// refuses because a finished run is still on screen.
		if (renderLaunching) return false;
		renderLaunching = true;
		try {
			const spec = {
				slug: `sheet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
				kind: opts.kind,
				stage: opts.stage,
				description: opts.description,
				seed: opts.seed
			};
			const res = await fetch('/studio/api/launch', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ stage: 'sheet', sheet: spec })
			});
			const r = (await res.json()) as { ok?: boolean; workspaceId?: string; error?: string };
			if (!r.ok || !r.workspaceId) {
				pushError(r.error || 'The sheet render did not start.');
				return false;
			}
			pendingSheet = { ...opts };
			renderWs = r.workspaceId;
			startedAt = Date.now();
			shootsAnnounced = true;
			pushStudio(
				opts.stage === 'anchor'
					? 'Rendering one picture of them — about a minute.'
					: opts.kind === 'character'
						? 'Rendering the full character sheet — six views of the same person.'
						: 'Rendering a location sheet — six views of the same place.'
			);
			persist();
			startPolling();
			return true;
		} catch (e) {
			pushError(String(e));
			return false;
		} finally {
			renderLaunching = false;
		}
	}

	/** The location card's button: an approved description goes to the GPU. */
	async function renderSheet(itemId: string) {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.sheet || item.sheet.launched || sheetBusy[itemId]) return;
		const { kind, description } = item.sheet;
		if (!description.trim()) return;
		sheetBusy[itemId] = true;
		try {
			const ok = await launchSheetRender({
				kind,
				description,
				stage: 'sheet',
				seed: item.sheet.seed ?? Math.floor(Math.random() * 1_000_000_000)
			});
			if (ok) item.sheet.launched = true;
		} finally {
			sheetBusy[itemId] = false;
		}
	}

	/** Keep the person, then let the turnaround catch up.
	 *
	 *  The save is the whole transaction as far as you are concerned: the
	 *  character exists, has a face, and is pickable for a clip the moment this
	 *  returns. The six-view sheet is started behind it and lands minutes later —
	 *  which is why nothing here waits for it, and why the rail shows which
	 *  characters are still being drawn. */
	async function saveSubject(itemId: string) {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.sheet || item.sheet.id || sheetBusy[itemId]) return;
		const { job, description, name, seed, kind, voice } = item.sheet;
		if (!job) return;
		sheetBusy[itemId] = true;
		try {
			const res = await fetch('/studio/api/sheet', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				// The voice as it stands on the card, not as the writer first wrote
				// it: the field above the name is editable, and a save that ignored
				// an edit would keep a voice the operator had just changed.
				body: JSON.stringify({
					kind,
					name,
					description,
					job,
					seed,
					...(voice ? { voice } : {}),
					...(runSlug ? { sessionSlug: runSlug } : {})
				})
			});
			const r = (await res.json()) as {
				ok?: boolean;
				sheet?: StoredSheet;
				sheets?: StoredSheet[];
				error?: string;
			};
			if (!r.ok || !r.sheet) {
				pushError(r.error || 'The character could not be saved.');
				return;
			}
			item.sheet.id = r.sheet.id;
			if (r.sheets) sheets = r.sheets;
			// This subject is finished; the next message describes a new one.
			currentCharacter = null;
			persist();

			// Fire and forget. It is server-side and outlives this tab, so a failure
			// here costs the turnaround, never the character.
			void fetch('/studio/api/sheetfull', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: r.sheet.id })
			})
				.then(() => watchSheets())
				.catch(() => {});
		} catch (e) {
			pushError(String(e));
		} finally {
			sheetBusy[itemId] = false;
		}
	}

	/** Poll the library while any turnaround is still being drawn, and stop when
	 *  none is. A spinner that never resolves is worse than no spinner. */
	let sheetWatch: ReturnType<typeof setTimeout> | null = null;

	/** A sheet being drawn somewhere. It is work in this session even though this
	 *  tab is polling nothing: the turnaround runs server-side, so the render
	 *  poller — which is what the sidebar's dot used to key off — sits idle
	 *  throughout and the row looked asleep while a GPU was busy. */
	const sheetsWorking = $derived(sheets.some((x) => x.sheet?.state === 'rendering'));

	/** How long the six views take, and how long this one has been going.
	 *
	 *  Measured, not guessed: a sheet's workspace id carries the moment it was
	 *  launched and its file carries the moment it landed, so the wait is the
	 *  difference — start to picture on screen, which is what a person sits
	 *  through rather than the GPU's share of it.
	 *
	 *  Character turnarounds only: 269, 250, 240 seconds. The first version of
	 *  this number averaged in the location sheets on disk (273, 277, 350) and
	 *  came out 20 seconds long. Those are a different job on a different
	 *  endpoint — `sheetwf`, drawing a still — and this line is only ever shown
	 *  beside a character.
	 *
	 *  Stated as an estimate because it is one — a cold endpoint adds most of a
	 *  minute — and replaced by plain words once it is past, rather than counting
	 *  down into the negative and calling that information. */
	const TURN_ETA_SEC = 250;

	function since(iso?: string): number {
		if (!iso) return 0;
		const t = Date.parse(iso);
		return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 1000)) : 0;
	}

	function clock(sec: number): string {
		const m = Math.floor(sec / 60);
		return `${m}:${String(sec % 60).padStart(2, '0')}`;
	}

	/** What the card says while a turnaround is drawing. The counter is the proof
	 *  that something is happening; the estimate is what stops it feeling open
	 *  ended. Past the estimate it stops guessing rather than guessing wrong. */
	function turnStatus(sh?: StoredSheet): string {
		const el = since(sh?.sheet?.startedAt);
		const left = TURN_ETA_SEC - el;
		if (left > 15) return `${clock(el)} · about ${Math.ceil(left / 60)} min left`;
		if (el < TURN_ETA_SEC + 120) return `${clock(el)} · nearly there`;
		return `${clock(el)} · taking longer than usual`;
	}

	/** Sessions with six views still being drawn, and sessions where they have
	 *  landed and nobody has looked yet. Both keyed by the session the subject
	 *  was made in, which is what stops a mark appearing on a row that has
	 *  nothing to do with it. */
	const sessionsDrawing = $derived(
		new Set(
			sheets
				.filter((x) => x.sheet?.state === 'rendering' && x.sessionSlug)
				.map((x) => x.sessionSlug!)
		)
	);
	/** The characters this session is drawing right now, for the strip above the
	 *  box. Scoped to this session for the same reason the six views are: a
	 *  turnaround started in another conversation is that conversation's news,
	 *  and the sidebar is where it belongs. */
	const drawingHere = $derived(
		sheets.filter((x) => x.sheet?.state === 'rendering' && x.sessionSlug === runSlug)
	);

	const sessionsDone = $derived(
		new Set(
			sheets
				.filter((x) => x.sheet?.state === 'ready' && x.sheet.file && !x.delivered && x.sessionSlug)
				.map((x) => x.sessionSlug!)
		)
	);

	/** Ids this tab has already reported, so the effect below settles after one
	 *  pass instead of chasing its own write. */
	const markedSeen = new Set<string>();

	/** Take the mark off this session's finished sheets.
	 *
	 *  Tied to the session being open, not to a card being posted. The first
	 *  version rode along with the card: mark it seen at the moment the six views
	 *  are pushed into the conversation. But a card is posted once, and the mark
	 *  outlives it — come back to a session whose card was posted last week and
	 *  the poller skips it as already shown, so the green never cleared and the
	 *  sidebar claimed news that had been read for days.
	 *
	 *  Opening the session is the whole condition, which is also what it means. */
	$effect(() => {
		const slug = runSlug;
		if (!slug) return;
		for (const x of sheets) {
			if (x.sheet?.state !== 'ready' || !x.sheet.file) continue;
			if (x.sessionSlug !== slug || x.delivered || markedSeen.has(x.id)) continue;
			markedSeen.add(x.id);
			x.delivered = true;
			void fetch('/studio/api/sheet', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id: x.id, delivered: true })
			}).catch(() => {});
		}
	});

	/** The characters this conversation is still owed a sheet for.
	 *
	 *  Read out of the chat rather than held in a variable, because the wait
	 *  outlives the tab. An upload posts its picture and the turnaround then runs
	 *  for minutes on a server that does not care whether anyone is still looking:
	 *  close the tab, reload, and the expectation has to survive that. The card
	 *  that announced the render is the record of it. */
	function awaitedSheets(): Set<string> {
		const out = new Set<string>();
		for (const c of chat) {
			const sh = c.sheet;
			if (c.kind === 'sheet' && sh?.uploaded && sh.stage === 'anchor' && sh.id) out.add(sh.id);
		}
		return out;
	}

	/** Whether the six views are already in this conversation. The chat is the
	 *  record and a set in memory is not — the set dies on reload, and then the
	 *  same sheet is posted a second time. */
	function sheetShown(id: string): boolean {
		return chat.some((c) => c.kind === 'sheet' && c.sheet?.stage === 'sheet' && c.sheet.id === id);
	}

	function watchSheets() {
		if (sheetWatch) clearTimeout(sheetWatch);
		const tick = async () => {
			// Which ones were still being drawn before this poll.
			const wasRendering = new Set(
				sheets.filter((x) => x.sheet?.state === 'rendering').map((x) => x.id)
			);
			await loadSheets();
			// Two ways to be due a card. Watching one finish is the obvious one, and
			// it was the only one — which made the card depend on this tab happening
			// to be looking at the right second. It was not, twice: once because the
			// upload path never started this poller, and once because a reload landed
			// mid-render. The moment passed and the sheet was never mentioned again.
			//
			// So the question asked here is not "did it just finish" but "am I still
			// waiting for it" — which the chat can answer at any time, including
			// minutes later in a tab that was closed when it happened.
			const awaited = awaitedSheets();
			for (const x of sheets) {
				if (x.sheet?.state !== 'ready' || !x.sheet.file) continue;
				// Its own conversation, and no other.
				//
				// `wasRendering` is a purely temporal test — it fires wherever the tab
				// happens to be when the poll catches the finish. Start a character,
				// switch sessions, and the six views landed in the middle of unrelated
				// work. A sheet made before this was recorded has no session, and no
				// session means any: those keep the old behaviour rather than becoming
				// undeliverable.
				if (x.sessionSlug && x.sessionSlug !== runSlug) continue;
				if (!wasRendering.has(x.id) && !awaited.has(x.id)) continue;
				if (sheetPosted.has(x.id) || sheetShown(x.id)) continue;
				sheetPosted.add(x.id);
				// The turnaround first, then what was cut out of it. That is the order
				// they happened in and the order they explain each other in: the video
				// is why the six views look the way they do.
				const c = x.sheet.clip;
				if (c?.workspace && c.artifact && c.file) {
					pushItem({
						who: 'studio',
						kind: 'clips',
						artifact: {
							id: c.artifact,
							key: 'turnaround',
							title: `${x.name} — the turn`,
							taskId: '',
							files: [{ name: c.file, url: fileUrl(c.workspace, c.artifact, c.file) }],
							workspace: c.workspace
						}
					});
				}
				// The six views, in the conversation that asked for them. The upload
				// itself stays quiet; this is the other end of it — you were told a
				// render had started, so you are told when it finished.
				pushItem({
					who: 'studio',
					kind: 'sheet',
					sheet: {
						kind: x.kind,
						stage: 'sheet',
						description: x.description ?? '',
						name: x.name,
						id: x.id,
						url: `/studio/api/sheet/full/${x.id}`,
						launched: true
					}
				});
				persist();
			}
			if (sheets.some((s) => s.sheet?.state === 'rendering')) {
				sheetWatch = setTimeout(tick, 8000);
			} else {
				sheetWatch = null;
			}
		};
		sheetWatch = setTimeout(tick, 4000);
	}

	/** Sheets already shown as a card, so a later poll does not post them twice. */
	const sheetPosted = new Set<string>();

	/** What the running sheet render was asked for. The finished artifact carries
	 *  no memory of the description that produced it, and that description is the
	 *  most useful thing to keep beside a sheet — it is what you would edit to
	 *  make a variant. */
	let pendingSheet: {
		kind: 'character' | 'location';
		description: string;
		stage: 'anchor' | 'sheet';
		seed: number;
		why?: string;
	} | null = null;

	/** Keep a rendered sheet. The bytes are fetched server-side, from the harness,
	 *  while this workspace is still answering. */
	async function keepSheet(itemId: string) {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.sheet || item.sheet.id || sheetBusy[itemId]) return;
		const { workspace, artifact, file, job } = item.sheet;
		// A draft card has no render behind it yet, so it has nothing to keep.
		if (!job && (!workspace || !artifact || !file)) return;
		sheetBusy[itemId] = true;
		try {
			const res = await fetch('/studio/api/sheet', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					kind: item.sheet.kind,
					name: item.sheet.name,
					description: item.sheet.description,
					...(item.sheet.voice ? { voice: item.sheet.voice } : {}),
					...(job ? { job } : { workspace, artifact, file })
				})
			});
			const r = (await res.json()) as {
				ok?: boolean;
				sheet?: StoredSheet;
				sheets?: StoredSheet[];
				error?: string;
			};
			if (!r.ok || !r.sheet) {
				pushError(r.error || 'The sheet could not be kept.');
				return;
			}
			item.sheet.id = r.sheet.id;
			// Point the card at our own copy now that there is one — the harness
			// stops serving an artifact the moment its workspace agent dies.
			item.sheet.url = `/studio/api/sheet/img/${r.sheet.id}`;
			if (r.sheets) sheets = r.sheets;
			persist();
		} catch (e) {
			pushError(String(e));
		} finally {
			sheetBusy[itemId] = false;
		}
	}

	



	/** Rewrite the card in place. The old one collapses rather than disappearing:
	 *  a prompt that was nearly right is worth being able to look back at. */
	/** What a rewrite must not touch.
	 *
	 *  The writer authored the brief and nothing else on the card. Who is in the
	 *  shot, where it is, what clip it follows, the frame size and any adapter
	 *  strengths you moved were all your decisions — and they are the fields that
	 *  decide what actually gets sent to the GPU. Dropping them turned "make this
	 *  eight seconds instead of six" into a render of a different person in a
	 *  different room that could then neither be continued nor joined, because
	 *  nothing recorded what it followed.
	 *
	 *  Carried explicitly rather than by spreading the old shot: the brief fields
	 *  must lose to the new one, and a blanket spread in the wrong order is how
	 *  that silently reverses. */
	function carried(prev: NonNullable<ChatItem['shot']>) {
		return {
			...(prev.continues ? { continues: prev.continues } : {}),
			...(prev.characterId ? { characterId: prev.characterId } : {}),
			...(prev.characterName ? { characterName: prev.characterName } : {}),
			...(prev.locationId ? { locationId: prev.locationId } : {}),
			...(prev.locationName ? { locationName: prev.locationName } : {}),
			resolution: prev.resolution ?? wantRes,
			baseLoras: prev.baseLoras
		};
	}

	async function rewriteShot(itemId: string) {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.shot || shotBusy[itemId]) return;
		shotBusy[itemId] = true;
		try {
			const shot = await callShotPrompt(lastRequest || item.shot.prompt, {
				seconds: item.shot.seconds,
				orientation: item.shot.orientation
			});
			if (!shot) return;
			superseded[itemId] = true;
			pushItem({ who: 'studio', kind: 'shot', shot: { ...shot, ...carried(item.shot) } });
		} finally {
			shotBusy[itemId] = false;
		}
	}

	/** Send the card's prompt — the edited text, whatever is in the box now — to
	 *  the renderer. The clip comes back through the same poll, cache and player
	 *  the planning chain uses; only the road to the GPU is shorter. */
	/** Send one shot to the renderer, wherever it came from.
	 *
	 *  Both the writer's card and the fix a diagnosis produced go through here.
	 *  They were about to be two copies of the same forty lines, and the copy the
	 *  fix used would have been the one that quietly stopped matching. */
	async function launchShot(
		shot: NonNullable<ChatItem['shot']>,
		announce = true
	): Promise<boolean> {
		// A continuation is a different workspace with different inputs, so it takes
		// its own stage rather than a flag on this one: the only thing the two share
		// is that a prompt goes to a GPU.
		if (shot.continues) {
			const c = shot.continues;
			const spec = {
				slug: `cont-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
				title: (lastRequest || 'Continuation').slice(0, 60),
				prompt: shot.prompt,
				seconds: shot.seconds,
				...frameFor((shot.resolution as ResKey) ?? wantRes, shot.orientation),
				seed: Math.floor(Math.random() * 1_000_000_000),
				loras: shot.loras ?? [],
				baseLoras: shot.baseLoras ?? {},
				request: lastRequest,
				priorWorkspace: c.workspace,
				priorArtifact: c.artifact,
				priorFile: c.file,
				characterId: c.characterId,
				locationId: c.locationId,
				pinned: c.pinned !== false,
				...(sessionSlug ? { sessionSlug } : {})
			};
			try {
				const res = await fetch('/studio/api/launch', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ stage: 'continue', continuation: spec })
				});
				const r = (await res.json()) as { ok?: boolean; error?: string; workspaceId?: string };
				if (!r.ok || !r.workspaceId) {
					pushError(r.error || 'The continuation could not start.');
					return false;
				}
				renderWs = r.workspaceId;
				startedAt = Date.now();
				shootsAnnounced = true;
				if (announce) pushStudio(`Continuing — ${shot.seconds}s more.`);
				persist();
				startPolling();
				return true;
			} catch (e) {
				pushError(`The continuation could not start: ${e}`);
				return false;
			}
		}

		const spec = {
			slug: `direct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
			title: lastRequest.slice(0, 60) || 'Direct render',
			prompts: [shot.prompt],
			seconds: shot.seconds,
			...frameFor((shot.resolution as ResKey) ?? wantRes, shot.orientation),
			seed: Math.floor(Math.random() * 1_000_000_000),
			loras: shot.loras ?? [],
			baseLoras: shot.baseLoras ?? {},
			wroteLoras: shot.wroteLoras ?? shot.loras ?? [],
			request: lastRequest,
			...(sessionSlug ? { sessionSlug } : {}),
			...(shot.characterId ? { characterId: shot.characterId } : {}),
			...(shot.locationId ? { locationId: shot.locationId } : {})
		};
		try {
			const res = await fetch('/studio/api/launch', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ stage: 'direct', direct: spec })
			});
			const r = (await res.json()) as { ok?: boolean; error?: string; workspaceId?: string };
			if (!r.ok || !r.workspaceId) {
				pushError(r.error || 'The render could not start.');
				return false;
			}
			renderWs = r.workspaceId;
			startedAt = Date.now();
			// The render poll narrates a shoot it announces first; there is no
			// shoot here, only this clip, so the announcement is already spent.
			shootsAnnounced = true;
			// Nothing is announced here any more. The card above already carries
			// the length and the frame size, the event feed says "Started clip 1"
			// a moment later, and the live line below counts. Three statements of
			// the same fact, and the only one of the three that could not tell you
			// it was still going was this one.
			persist();
			startPolling();
			return true;
		} catch (e) {
			pushError(`The render could not start: ${e}`);
			return false;
		}
	}

	/** Several takes of one card, rendered at once and followed by the server.
	 *
	 *  A continuation cannot be one of these: take two would need take one's clip
	 *  as its reference, so the chain is sequential by physics rather than by
	 *  interface. Only a fresh clip can be forked.
	 *
	 *  The card is marked launched exactly as a single render marks it, because it
	 *  has been: the beat is spent, and offering "render this" underneath four
	 *  takes of it already running is how somebody pays for a fifth by accident. */
	async function renderBatch(itemId: string, takes: number, angles: number) {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.shot || item.shot.launched || shotBusy[itemId]) return;
		shotBusy[itemId] = true;
		try {
			const shot = item.shot;

			// Angles are written before anything is launched, from the prompt on the
			// card rather than from the request behind it. By now that prompt has
			// been read and possibly edited; sending the request back to the writer
			// would produce different scenes, and sending it the prompt produces
			// different views of one.
			let variants: string[] = [];
			if (angles > 1) {
				const a = await fetch('/studio/api/angles', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ prompt: shot.prompt, count: angles })
				});
				const ar = (await a.json()) as { ok?: boolean; angles?: string[]; error?: string };
				if (!ar.ok || !ar.angles?.length) {
					pushError(ar.error || 'the camera angles could not be written');
					return;
				}
				variants = ar.angles;
			}
			// A continuation batch is the same two axes against a different stage.
			// Every take continues the SAME prior clip — not the take before it —
			// which is what makes versions coherent here at all: they are
			// alternative next stretches of one film, and you keep the one you like.
			const c = shot.continues;
			const payload = c
				? {
						takes,
						...(variants.length ? { variants } : {}),
						continuation: {
							title: (lastRequest || 'Continuation').slice(0, 60),
							prompt: shot.prompt,
							seconds: shot.seconds,
							...frameFor((shot.resolution as ResKey) ?? wantRes, shot.orientation),
							loras: shot.loras ?? [],
							baseLoras: shot.baseLoras ?? {},
							request: lastRequest,
							priorWorkspace: c.workspace,
							priorArtifact: c.artifact,
							priorFile: c.file,
							characterId: c.characterId,
							locationId: c.locationId,
							pinned: c.pinned !== false,
							...(sessionSlug ? { sessionSlug } : {})
						}
					}
				: {
						takes,
						...(variants.length ? { variants } : {}),
						direct: {
							title: (lastRequest || 'Take').slice(0, 60),
							prompts: [shot.prompt],
							seconds: shot.seconds,
							...frameFor((shot.resolution as ResKey) ?? wantRes, shot.orientation),
							loras: shot.loras ?? [],
							baseLoras: shot.baseLoras ?? {},
							wroteLoras: shot.wroteLoras ?? shot.loras ?? [],
							request: lastRequest,
							...(sessionSlug ? { sessionSlug } : {}),
							...(shot.characterId ? { characterId: shot.characterId } : {}),
							...(shot.locationId ? { locationId: shot.locationId } : {})
						}
					};
			const res = await fetch('/studio/api/batch', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload)
			});
			const r = (await res.json()) as {
				ok?: boolean;
				error?: string;
				batch?: string;
				runs?: ServerRun[];
			};
			if (!r.ok || !r.batch) {
				pushError(r.error || 'The takes could not start.');
				return;
			}
			shot.launched = true;
			// The card goes up with every take already on it, the ones still on the
			// GPU included. The strip is then its final shape from the first second
			// and nothing moves under the cursor as they land — which matters here
			// more than usual, because the thing you do on this card is aim at a
			// small picture.
			pushItem({
				who: 'studio',
				kind: 'takes',
				takes: { batch: r.batch, runs: (r.runs ?? []).map(takeRun) }
			});
			persist();
			watchBatches();
		} catch (e) {
			pushError(`The takes could not start: ${e}`);
		} finally {
			shotBusy[itemId] = false;
		}
	}

	/** What the batch record looks like on the wire. Wider than the card needs,
	 *  so it is narrowed on the way in rather than stored as it arrives: every
	 *  poll writes the transcript to localStorage, and a batch of four carries
	 *  four seeds, four timestamps and four workspace ids that nothing reads. */
	type ServerRun = {
		batch?: string;
		index: number;
		slug: string;
		state: string;
		error?: string;
		clip?: { workspace: string; artifact: string; file: string };
	};

	function takeRun(r: ServerRun): NonNullable<ChatItem['takes']>['runs'][number] {
		return {
			index: r.index,
			slug: r.slug,
			state: r.state === 'ready' ? 'ready' : r.state === 'failed' ? 'failed' : 'rendering',
			...(r.error ? { error: r.error } : {}),
			...(r.clip ? { clip: r.clip } : {})
		};
	}

	/** Bring the takes cards in this conversation up to date, and stop.
	 *
	 *  It only ever updates cards that are already here. The version before it
	 *  created one card per landed take, keyed on "is this take already on
	 *  screen" — which is a question a fresh transcript answers no to for every
	 *  take of every batch ever run, so opening the studio in a new conversation
	 *  would have posted the whole history into it. A batch is announced by the
	 *  press that started it and by nothing else; a poll may only bring news
	 *  about one that is already on the page. */
	let batchWatch: ReturnType<typeof setTimeout> | null = null;

	function watchBatches() {
		if (batchWatch) clearTimeout(batchWatch);
		const waiting = () =>
			chat.filter((c) => c.kind === 'takes' && c.takes?.runs.some((r) => r.state === 'rendering'));
		if (!waiting().length) {
			batchWatch = null;
			return;
		}
		const tick = async () => {
			const cards = waiting();
			if (!cards.length) {
				batchWatch = null;
				return;
			}
			let runs: ServerRun[] = [];
			try {
				const r = (await (await fetch('/studio/api/batch')).json()) as { runs?: ServerRun[] };
				runs = r.runs ?? [];
			} catch {
				batchWatch = setTimeout(tick, 12000);
				return;
			}
			let moved = false;
			for (const card of cards) {
				const t = card.takes;
				if (!t) continue;
				for (const run of runs) {
					if (run.batch !== t.batch) continue;
					const mine = t.runs.find((x) => x.slug === run.slug);
					if (!mine || mine.state !== 'rendering') continue;
					const next = takeRun(run);
					if (next.state === 'rendering') continue;
					Object.assign(mine, next);
					moved = true;
				}
			}
			if (moved) {
				persist();
				// A take that has landed has a row in the render log, and the card
				// under it reads that row for the adapters, the size and the seed.
				void loadVerdicts();
			}
			batchWatch = waiting().length ? setTimeout(tick, 12000) : null;
		};
		batchWatch = setTimeout(tick, 5000);
	}

	/** Returns whether the brief actually reached a GPU. The retry button reads it:
	 *  a launch that never started should hand the button back, and one that did
	 *  must not. */
	async function renderShot(itemId: string): Promise<boolean> {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.shot || item.shot.launched || shotBusy[itemId]) return false;
		shotBusy[itemId] = true;
		try {
			if (await launchShot(item.shot)) {
				item.shot.launched = true;
				// Written down, not just remembered.
				//
				// launchShot persists on its way out — before this line runs — so the
				// snapshot on disk said the card had never been launched. Leave the
				// conversation and come back and the restore believed it: the card
				// came up with its controls live and "render this" ready, over a clip
				// that was already on a GPU. Pressing it would have paid for the same
				// five seconds twice.
				persist();
				return true;
			}
			return false;
		} finally {
			shotBusy[itemId] = false;
		}
	}

	/** Send a brief to the GPU again, after a render died on the way.
	 *
	 *  The same prompt, a new seed and a new workspace — nothing about the brief
	 *  is at fault when the harness reports its own infrastructure, so rewriting
	 *  it would throw away a good one and cost another writer call. `launched` is
	 *  cleared first because renderShot refuses a card that has already been sent,
	 *  which is the guard that stops a double-spend and has to be stood down
	 *  deliberately rather than worked around. */
	async function retryShot(errorItemId: string, shotItemId: string) {
		const err = chat.find((c) => c.id === errorItemId);
		const item = chat.find((c) => c.id === shotItemId);
		if (!err || !item?.shot || shotBusy[shotItemId] || err.retried) return;
		// On the card, not in a map beside it.
		//
		// A map is component state and a reload empties it, so the button came back
		// live over a render that was already going — which is what a person
		// reloading to pick up a fix saw, and it is the same double-spend the guard
		// was added to stop. The transcript is saved; the press belongs in it.
		err.retried = true;
		persist();
		// Stood down so renderShot will take the card, and put back if it does not.
		// Leaving it false after a launch that never started loses the retry
		// altogether: the error card finds its brief by looking for a launched one,
		// so the button would vanish at exactly the moment it is wanted. Measured,
		// after breaking it that way.
		item.shot.launched = false;
		if (!(await renderShot(shotItemId))) {
			item.shot.launched = true;
			err.retried = false;
			persist();
		}
	}

	/** Moving the duration or the frame rewrites the prompt rather than relabelling
	 *  it. Both are structural: timestamps are derived from the duration, and the
	 *  camera language from the shape of the frame. A card that said 6 seconds over
	 *  beats written for 10 would be a card that lies. */
	async function respin(
		itemId: string,
		pin: { seconds: number; orientation: 'portrait' | 'landscape' }
	) {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.shot || item.shot.launched || shotBusy[itemId]) return;
		shotBusy[itemId] = true;
		try {
			const shot = await callShotPrompt(lastRequest || item.shot.prompt, pin);
			if (!shot) return;
			// Everything except the brief survives the rewrite. Only the words are
			// being written again; the settings around them were your decisions and
			// losing them silently is how a rewrite turns into a step backwards.
			superseded[itemId] = true;
			pushItem({
				who: 'studio',
				kind: 'shot',
				shot: { ...shot, ...pin, ...carried(item.shot) }
			});
		} finally {
			shotBusy[itemId] = false;
		}
	}

	function setShotSeconds(itemId: string, seconds: number) {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.shot || item.shot.seconds === seconds) return;
		// Through to the composer as well.
		//
		// The card and the chip were two stores of one setting, and only the chip
		// is on screen when you press "continue this". Change it on a card, and
		// the chip went on showing the old number and quietly sending it — the way
		// a clip made at five seconds came to be continued at ten. Whichever of
		// the two you touch, both now say the same thing.
		wantSeconds = seconds;
		saveSetup();
		void respin(itemId, { seconds, orientation: item.shot.orientation });
	}

	/** Add or remove one adapter on a card that has not been sent yet.
	 *
	 *  The writer chooses, and this is where you disagree with it — before the
	 *  render rather than after, which is the whole reason the choice is on the
	 *  card at all. Acts replace each other rather than stacking, the same rule
	 *  the writer is given, because a clip is one thing happening. */
	function toggleLora(itemId: string, key: string) {
		const item = chat.find((c) => c.id === itemId);
		const lora = loraFor(key);
		if (!item?.shot || item.shot.launched || !lora) return;
		const picks = item.shot.loras ?? [];
		if (picks.some((p) => p.key === key)) {
			item.shot.loras = picks.filter((p) => p.key !== key);
			return;
		}
		const kept = lora.kind === 'act' ? picks.filter((p) => loraFor(p.key)?.kind !== 'act') : picks;
		if (kept.length >= MAX_PICKS) return;
		item.shot.loras = [...kept, { key, strength: lora.strength }];
	}

	/** Your verdict on a finished clip, and what was wrong with it.
	 *
	 *  Keyed by workspace rather than held on the chat item, so scrolling back to
	 *  an older clip shows the verdict you already gave it and cannot collect a
	 *  second one. Nothing here reads the log back — the file is the record, this
	 *  is only what the page needs to stop offering a button you already pressed.
	 */
	let verdict = $state<Record<string, 'kept' | 'rejected'>>({});

	async function rate(workspace: string, outcome: 'kept' | 'rejected') {
		if (!workspace) return;
		verdict[workspace] = outcome;
		// Fire and forget, like the run's own closing call. A verdict that fails to
		// save is a lost row; a verdict that blocks the page is a lost afternoon.
		void fetch('/studio/api/renders', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspace, outcome })
		}).catch(() => {});
		// A clip that missed is looked at straight away. Asking you to type what
		// was wrong first was asking for the answer before doing the work — the
		// model is about to look at the frames and can see it for itself, and the
		// question only stood between you and the fix.
		if (outcome === 'rejected') void diagnose(workspace);
	}

	/** The takes card you are looking at properly, and which take of it.
	 *
	 *  One overlay for the whole page, because only one can be open and because
	 *  of the single number this feature turns on: the clip is 1024 across in
	 *  here, which is its own width, and the transcript column can never give it
	 *  more than 720. Four near-identical five-second takes are not separable at
	 *  thumbnail size and barely separable at column width, so the room to look
	 *  at them properly is the feature — the strip is only the way in. */
	let takesAt = $state<{ id: string; index: number } | null>(null);
	/** The tile it was opened from, to hand focus back to on the way out. */
	let takesFrom: HTMLElement | null = null;

	/** The takes there is anything to look at. One still on the GPU and one that
	 *  failed have no frames, so the arrows step over them rather than landing on
	 *  a black rectangle. */
	function readyTakes(id: string) {
		const item = chat.find((c) => c.id === id);
		return (item?.takes?.runs ?? []).filter((r) => r.state === 'ready' && r.clip);
	}

	function openTake(id: string, index: number, from?: HTMLElement) {
		if (!readyTakes(id).some((r) => r.index === index)) return;
		takesFrom = from ?? null;
		takesAt = { id, index };
	}

	function shutTake() {
		takesAt = null;
		takesFrom?.focus();
		takesFrom = null;
	}

	/** Left and right on the picture itself. The arrows are hidden on a phone —
	 *  a 44px target floating over a 316px-wide clip covers the thing it is there
	 *  to help you look at — so this is how you move between takes there.
	 *  Vertical drags are left alone, or the transcript could not be scrolled
	 *  from over the viewer. */
	let swipeX = 0;
	let swipeY = 0;

	function swipeStart(e: TouchEvent) {
		swipeX = e.changedTouches[0].clientX;
		swipeY = e.changedTouches[0].clientY;
	}

	function swipeEnd(e: TouchEvent) {
		const dx = e.changedTouches[0].clientX - swipeX;
		const dy = e.changedTouches[0].clientY - swipeY;
		if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) stepTake(dx < 0 ? 1 : -1);
	}

	function stepTake(d: number) {
		const at = takesAt;
		if (!at) return;
		const list = readyTakes(at.id);
		if (list.length < 2) return;
		const i = list.findIndex((r) => r.index === at.index);
		takesAt = { id: at.id, index: list[(i + d + list.length) % list.length].index };
	}

	/** Keep one take: the card becomes the clip you chose.
	 *
	 *  It writes the same `artifact` a single render produces, and that is the
	 *  whole trick — the kept take then draws through the clip card unchanged,
	 *  with the verdict buttons, the continue and the scene join it already has.
	 *  None of that was rewritten for batches.
	 *
	 *  Choosing does not rate anything. Best of four and good are different
	 *  claims, and the card goes on asking "how was it?" underneath, because a
	 *  batch where you kept the least bad of four is exactly the case the quality
	 *  signal most needs to hear about. The takes you passed over are not marked
	 *  bad either, and not deleted: they stay behind "the other three". */
	function keepTake(id: string, index: number) {
		const item = chat.find((c) => c.id === id);
		const run = item?.takes?.runs.find((r) => r.index === index);
		if (!item?.takes || !run?.clip) return;
		const c = run.clip;
		item.takes.kept = index;
		// No caption. "Take 3, kept." said what the card already showed: the strip
		// collapses to the one you pressed, so the only picture on screen IS the
		// one you kept, and a line naming it is a label on a thing with no
		// alternatives left to distinguish it from.
		item.artifact = {
			id: c.artifact,
			key: run.slug,
			title: `Take ${index}`,
			taskId: '',
			files: [{ name: c.file, url: fileUrl(c.workspace, c.artifact, c.file) }],
			workspace: c.workspace
		};
		persist();
		shutTake();
	}

	// --- the film -----------------------------------------------------------------

	/** The clips you have decided to keep, in the order they will be cut.
	 *
	 *  Server-side, not in the transcript: a transcript is stored per run, so a
	 *  film living there would vanish the moment you opened another production —
	 *  which is exactly the thing it must survive. It holds the same
	 *  (workspace, artifact, file) triple `api/join` already takes, so a clip
	 *  from any run, of any age, can be added without copying anything. That is
	 *  also why it works backwards: every clip card in every old conversation
	 *  already carries those three ids. */
	interface FilmClip {
		workspace: string;
		artifact: string;
		file: string;
		title?: string;
		continues?: string;
		at: string;
	}
	let film = $state<FilmClip[]>([]);
	/** Open by choice, remembered for the session. The first clip opens it once —
	 *  so the shelf is discovered rather than explained — and after that it obeys
	 *  you. */
	let filmOpen = $state(false);
	let filmEverOpened = false;
	let filmBusy = $state(false);

	const filmKey = (c: { workspace: string; artifact: string; file: string }) =>
		`${c.workspace} ${c.artifact} ${c.file}`;
	const filmSeconds = $derived(film.reduce((n, c) => n + (logRow[c.workspace]?.seconds || 5), 0));

	function inFilm(a: NonNullable<ChatItem['artifact']> | undefined): boolean {
		const c = filmPart(a);
		return !!c && film.some((x) => filmKey(x) === filmKey(c));
	}

	/** The three ids, or null when the card cannot name them — a joined scene has
	 *  no artifact id of its own, and neither has anything that arrived before the
	 *  studio recorded one. Those cannot be cut into a film, and the button is not
	 *  offered rather than offered and failing. */
	function filmPart(a: NonNullable<ChatItem['artifact']> | undefined) {
		const f = a?.files?.[0]?.name;
		if (!a?.workspace || !a?.id || !f) return null;
		return { workspace: a.workspace, artifact: a.id, file: f };
	}

	async function saveFilm() {
		try {
			const res = await fetch('/studio/api/film', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ clips: film })
			});
			const r = (await res.json()) as { ok?: boolean; clips?: FilmClip[]; error?: string };
			if (r.ok && r.clips) film = r.clips;
			else if (r.error) pushError(r.error);
		} catch (e) {
			pushError(`the film could not be saved: ${e}`);
		}
	}

	/** Add a clip the film by its three ids. The card path and the viewer path
	 *  both end here — the film has never cared where a clip came from, only
	 *  that it can be found. */
	function addClipToFilm(c: { workspace: string; artifact: string; file: string }, title: string) {
		if (film.some((x) => filmKey(x) === filmKey(c))) return;
		film.push({
			...c,
			title,
			continues: logRow[c.workspace]?.continuesWorkspace || undefined,
			at: new Date().toISOString()
		});
		// Always, not just the first time. Adding a clip is the one moment you want
		// to see what the film now looks like — and the reel is where the order and
		// the seams are, which is exactly what a new clip changes.
		filmOpen = true;
		filmEverOpened = true;
		void saveFilm();
	}

	function addToFilm(item: ChatItem) {
		const part = filmPart(item.artifact);
		if (!part) return;
		addClipToFilm(part, item.artifact?.title || item.text || '');
	}

	function dropFromFilm(i: number) {
		film.splice(i, 1);
		if (!film.length) filmOpen = false;
		void saveFilm();
	}

	function moveInFilm(from: number, to: number) {
		if (from === to || from < 0 || to < 0 || from >= film.length || to >= film.length) return;
		const [m] = film.splice(from, 1);
		film.splice(to, 0, m);
		void saveFilm();
	}

	/** Two neighbours match only when one continues the other — the workflow
	 *  starts the second from the first's final frame. Anything else will jump,
	 *  and the reel marks the seam rather than letting playback be the first
	 *  place you find out. */
	function seamJumps(i: number): boolean {
		if (i <= 0 || i >= film.length) return false;
		return film[i].continues !== film[i - 1].workspace;
	}

	/** Assemble what is in the reel. Same endpoint the scene join has always
	 *  used — it never cared whether the parts were a chain. */
	async function exportFilm() {
		if (film.length < 2 || filmBusy) return;
		filmBusy = true;
		try {
			const res = await fetch('/studio/api/join', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ parts: film.map((c) => ({ workspace: c.workspace, artifact: c.artifact, file: c.file })) })
			});
			const r = (await res.json()) as {
				ok?: boolean;
				error?: string;
				url?: string;
				parts?: number;
				seconds?: number;
			};
			if (!r.ok || !r.url) {
				pushError(r.error || 'the film could not be assembled');
				return;
			}
			pushItem({
				who: 'studio',
				kind: 'clips',
				text: `The film — ${r.parts} clips, ${r.seconds}s.`,
				artifact: {
					key: 'film',
					title: 'The film',
					taskId: '',
					files: [{ name: 'film.mp4', url: r.url }],
					// The last clip's workspace, so continuing the film continues where
					// it ends — the same rule joinScene already follows.
					workspace: film[film.length - 1]?.workspace
				}
			});
			persist();
		} catch (e) {
			pushError(`the film could not be assembled: ${e}`);
		} finally {
			filmBusy = false;
		}
	}

	/** Which shot of the film is on screen, or null. Separate from `takesAt`
	 *  rather than folded into it: the takes viewer exists to choose between
	 *  drafts and carries the controls for it, while this one is a cut being
	 *  watched. Sharing the state would mean every control asking which of the
	 *  two it is in. */
	let filmAt = $state<number | null>(null);
	let filmReturn: HTMLElement | null = null;

	function openFilmViewer(i: number, from?: HTMLElement) {
		if (!film.length) return;
		filmReturn = from ?? null;
		filmAt = Math.min(Math.max(0, i), film.length - 1);
	}
	function shutFilmViewer() {
		filmAt = null;
		filmReturn?.focus();
		filmReturn = null;
	}
	function stepFilm(d: number) {
		if (filmAt === null || film.length < 2) return;
		filmAt = (filmAt + d + film.length) % film.length;
	}
	/** The clips are separate files, so playing the film means chaining them:
	 *  when one ends the next begins. Nothing is written to disk until Export —
	 *  you can watch the cut before paying to assemble it. */
	function nextShot() {
		if (filmAt === null) return;
		if (filmAt < film.length - 1) filmAt += 1;
	}

	/** Tiles play, silently, and only while they are on screen.
	 *
	 *  A take cannot be judged from a poster frame — the takes share the shot,
	 *  the prompt and the framing, and what separates them is motion. So they
	 *  move. But a transcript with a few batches in it would then be a dozen
	 *  videos decoding at once, on a laptop that is also running the render, so
	 *  the ones scrolled away from stop. */
	let tileEyes: IntersectionObserver | null = null;

	function looping(el: HTMLVideoElement) {
		tileEyes ??= new IntersectionObserver(
			(entries) =>
				entries.forEach((e) => {
					const v = e.target as HTMLVideoElement;
					if (e.isIntersecting) void v.play().catch(() => {});
					else v.pause();
				}),
			{ rootMargin: '120px' }
		);
		tileEyes.observe(el);
		return { destroy: () => tileEyes?.unobserve(el) };
	}

	/** Three stills off the clip that is already on screen: near the start, the
	 *  middle where the key beat sits, and near the end.
	 *
	 *  Drawn from the <video> element rather than cut server-side. The host has no
	 *  ffmpeg, the harness's copy sits behind a docker exec this app should not be
	 *  making, and the browser has the decoded frames already. Scaled down on the
	 *  way out — the model reads a malformed hand at 768 across as well as at
	 *  1024, and three full-size stills is a megabyte of base64 for nothing. */
	async function grabFrames(video: HTMLVideoElement, count = 3): Promise<string[]> {
		const dur = video.duration;
		if (!Number.isFinite(dur) || dur <= 0) return [];
		const wasAt = video.currentTime;
		const scale = Math.min(1, 768 / (video.videoWidth || 768));
		// globalThis, not the bare name. This component declares a snippet called
		// `document`, and svelte compiles snippets to module-scoped consts — which
		// shadows the global for the whole file. The failure it caused was not
		// obvious from the outside: the button did nothing at all, because
		// `document.querySelector is not a function` came back as an unhandled
		// rejection with no visible effect on the page.
		const canvas = globalThis.document.createElement('canvas');
		canvas.width = Math.round((video.videoWidth || 768) * scale);
		canvas.height = Math.round((video.videoHeight || 432) * scale);
		const ctx = canvas.getContext('2d');
		if (!ctx) return [];

		const out: string[] = [];
		for (let i = 0; i < count; i++) {
			const at = dur * (0.15 + (0.7 * i) / Math.max(1, count - 1));
			try {
				await new Promise<void>((resolve, reject) => {
					const done = () => {
						video.removeEventListener('seeked', done);
						resolve();
					};
					video.addEventListener('seeked', done);
					// A clip that will not seek must not hang the button forever.
					setTimeout(() => {
						video.removeEventListener('seeked', done);
						reject(new Error('seek timed out'));
					}, 4000);
					video.currentTime = at;
				});
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
				out.push(canvas.toDataURL('image/jpeg', 0.82));
			} catch {
				break;
			}
		}
		video.currentTime = wasAt;
		return out;
	}

	let diagnosing = $state<Record<string, boolean>>({});

	/** Put back the verdicts already given, from the log that has them.
	 *
	 *  They were held only in this tab, so a reload lost them and offered the same
	 *  clip for rating a second time. The log is the record; the page was keeping
	 *  a private copy and losing it. Failures are ignored on purpose — a studio
	 *  that will not load because the verdict history did not is a bad trade for a
	 *  row of buttons. */
	interface LogRow {
		workspace: string;
		launched?: { key: string; strength: number }[];
		steps?: number;
		width?: number;
		height?: number;
		seconds?: number;
		fps?: number;
		seed?: number;
		wallSeconds?: number;
		outcome?: string;
		/** What you typed, verbatim. The history row's title is the same text cut
		 *  to sixty characters; this one is not cut. */
		request?: string;
		/** What the clip was shot with, and what it continues. Both arrived with the
		 *  render log rather than the chat, so an old clip has neither. */
		prompt?: string;
		characterId?: string;
		characterName?: string;
		locationId?: string;
		locationName?: string;
		continuesWorkspace?: string;
	}
	let logRow = $state<Record<string, LogRow>>({});

	/** The clip the composer is currently continuing, or null.
	 *
	 *  A separate axis from `wantTarget`: that one chooses what a NEW message
	 *  makes, and this one says the next message extends something that already
	 *  exists. Setting it puts the composer into continuation mode; sending or
	 *  cancelling clears it. */
	let continuing = $state<NonNullable<ChatItem['shot']>['continues'] | null>(null);

	/** Whether the seam is pinned to the prior clip's final frame.
	 *
	 *  Up here with `continuing` rather than down by the banner that sets it,
	 *  because the composer's own chip reads it: a pinned seam rules camera angles
	 *  out, and a derived declared above the state it reads is the dead zone this
	 *  file documents at composerShape. */
	let pinSeam = $state(true);

	/** What the composer is actually about to send, which is not always what the
	 *  composer is set to.
	 *
	 *  While you are continuing a clip, its length, size and frame all come from
	 *  the clip being continued — they have to, or the pieces cannot be joined.
	 *  The chip went on showing the saved defaults anyway, so the screen read
	 *  "5s" directly beside "Continuing — 10s more." and the honest question
	 *  followed immediately: why is it making ten. It was right to make ten. The
	 *  chip was wrong to say five.
	 *
	 *  Declared here rather than up with the other settings because it reads
	 *  `continuing`, and a derived that reads a state declared below it is the
	 *  dead zone this file has already been caught by once. */
	const composerShape = $derived.by(() => {
		const prior = continuing ? logRow[continuing.workspace] : null;
		if (!prior?.width || !prior?.height) {
			return { seconds: wantSeconds, res: wantRes, portrait: wantOrientation === 'portrait', fixed: false };
		}
		const longest = Math.max(prior.width, prior.height);
		// Length stays yours even here. Only the two that decide whether the pieces
		// can be joined are taken over.
		return {
			seconds: wantSeconds,
			res: RES_KEYS.find((k) => RESOLUTIONS[k].long === longest) ?? wantRes,
			portrait: prior.height > prior.width,
			fixed: true
		};
	});

	/** What a given pair of counts makes, in the fewest words that are still true. */
	function countLabel(t: number, a: number): string {
		const n = t * a;
		if (n === 1) return 'one clip';
		if (a === 1) return `${t} versions`;
		if (t === 1) return `${a} camera angles`;
		return `${n} clips`;
	}

	/** Camera angles cannot apply to a continuation whose seam is pinned.
	 *
	 *  Versions can, and do: every take continues the SAME prior clip, so they are
	 *  alternative next stretches and you keep one. An angle is different in kind —
	 *  the pinned seam nails the first instant to the frame the last clip ended on,
	 *  and a second camera cannot start from that frame. On a free start it is
	 *  coherent again, which is why this is a condition rather than a ban. */
	const anglesApply = $derived(!(continuing && pinSeam));
	const effAngles = $derived(anglesApply ? angles : 1);
	const effAtOnce = $derived(takes * effAngles);
	/** What the next message will make. It reports the run, not the setting: the
	 *  chip used to read "2 camera angles" with a pinned continuation in flight
	 *  while one clip came back, which is the same lie composerShape was written
	 *  to stop the length and the size telling. */
	const batchLabel = $derived(countLabel(takes, effAngles));
	let joining = $state<Record<string, boolean>>({});
	/** The character or location the delete button is armed on.
	 *
	 *  Two clicks, because one is how a face nobody meant to touch disappears —
	 *  and a sheet is minutes of GPU time, not a row in a list. */
	let dropArmed = $state('');

	/** What is being typed into a kept subject's card, before it is applied.
	 *
	 *  Held here rather than bound to the card's own copy of the subject, because
	 *  that copy is a snapshot taken when the card was written and the store has
	 *  moved since — the voice is also editable from the composer, and a rename
	 *  applied there would be silently undone by a card still showing the old name.
	 *  Empty means "show what is stored", which is the state a card should be in
	 *  for all but the few seconds someone is editing it. */
	let keptEdits = $state<Record<string, { name?: string; voice?: string }>>({});

	function editKept(id: string, field: 'name' | 'voice', v: string) {
		keptEdits[id] = { ...keptEdits[id], [field]: v };
	}

	/** Name and voice of a subject that is already kept, edited from its own card.
	 *
	 *  Separate from saveSubject, which creates one. This is the case the card had
	 *  no answer for: an uploaded character is kept the moment the picture lands, so
	 *  there is nothing to save — but the voice arrives blank and the name arrives
	 *  as whatever was typed in the box, and both are worth changing once the six
	 *  views are on screen and you can see who they are.
	 *
	 *  An explicit button rather than saving on blur, because the voice is a
	 *  sentence: leaving the field to re-read the sheet should not commit a half
	 *  written one, and there is no way back from a save nobody asked for.
	 */
	async function updateKept(itemId: string, id: string, name: string, voice: string) {
		if (!id || sheetBusy[itemId]) return;
		sheetBusy[itemId] = true;
		try {
			const res = await fetch('/studio/api/sheet', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id, name: name.trim(), voice: voice.trim().slice(0, 240) })
			});
			const r = (await res.json()) as { ok?: boolean; sheets?: StoredSheet[]; error?: string };
			if (r.ok && r.sheets) {
				sheets = r.sheets;
				// Back to showing what is stored, which is now what was typed.
				delete keptEdits[itemId];
			} else pushError(r.error || 'that could not be updated');
		} catch (e) {
			pushError(`that could not be updated — ${e}`);
		} finally {
			sheetBusy[itemId] = false;
		}
	}

	async function dropSheet(id: string) {
		try {
			const res = await fetch(`/studio/api/sheet?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
			const r = (await res.json()) as { ok?: boolean; sheets?: StoredSheet[] };
			if (r.sheets) sheets = r.sheets;
			// Whatever was pointing at it stops pointing at it.
			if (wantCharacter === id) wantCharacter = '';
			if (wantLocation === id) wantLocation = '';
			saveSetup();
		} catch (e) {
			pushError(`could not remove that: ${e}`);
		} finally {
			dropArmed = '';
		}
	}

	/** Whether a clip can be continued, how exactly, and why not when it cannot.
	 *
	 *  It used to demand a kept character AND a kept location, because the
	 *  workflow declares a picture in each of its two plate slots as required. But
	 *  the workflow requires a *picture*, not a *sheet* — and the person and the
	 *  room are both already in the clip. So a missing plate is cut out of the
	 *  clip at launch, and the only clip that cannot be continued now is one whose
	 *  bytes are gone.
	 *
	 *  `exact` is the difference that remains and it is worth stating rather than
	 *  hiding: with both sheets the continuation is anchored to a face the
	 *  operator approved and a room they chose, and can hold across many clips.
	 *  From frames it is anchored to one moment of one clip, so whatever drifted
	 *  there is inherited. */
	function contInfo(ws: string): { ok: boolean; why: string; exact: boolean; row?: LogRow } {
		const row = logRow[ws];
		if (!row) {
			return {
				ok: false,
				exact: false,
				why: 'this clip was made before the studio started recording what it was shot with — it cannot be extended'
			};
		}
		const c = !!row.characterId && sheets.some((x) => x.id === row.characterId);
		const l = !!row.locationId && sheets.some((x) => x.id === row.locationId);
		return { ok: true, why: '', exact: c && l, row };
	}

	/** The chain this clip belongs to, oldest first.
	 *
	 *  Walked backwards along continuesWorkspace and then matched against the
	 *  transcript, because the render log knows the order and the transcript knows
	 *  the artifact ids. A gap in either returns nothing: a scene assembled from
	 *  a chain with a hole in it would skip, and skipping quietly is worse than
	 *  offering nothing. */
	function chainOf(ws: string): { workspace: string; artifact: string; file: string }[] {
		const order: string[] = [];
		const seen = new Set<string>();
		let cur: string | undefined = ws;
		while (cur && !seen.has(cur)) {
			seen.add(cur);
			order.unshift(cur);
			cur = logRow[cur]?.continuesWorkspace;
		}
		const out: { workspace: string; artifact: string; file: string }[] = [];
		for (const w of order) {
			const it = chat.find(
				(c) => c.kind === 'clips' && c.artifact?.workspace === w && c.artifact?.id && c.artifact.files?.length
			);
			if (!it?.artifact?.id) return [];
			out.push({ workspace: w, artifact: it.artifact.id, file: it.artifact.files[0].name });
		}
		return out;
	}

	async function loadVerdicts() {
		try {
			const res = await fetch('/studio/api/renders?limit=200');
			const { rows } = (await res.json()) as { rows: LogRow[] };
			for (const r of rows ?? []) {
				logRow[r.workspace] = r;
				if (r.outcome === 'kept' || r.outcome === 'rejected') {
					verdict[r.workspace] = r.outcome as 'kept' | 'rejected';
				}
			}
		} catch {
			// see above
		}
	}

	/** The fix a diagnosis produced, held until you decide what to do with it.
	 *
	 *  It used to be pushed straight into the transcript as another card. That
	 *  works, but it puts a second launch button on screen for the same clip and
	 *  buries the diagnosis three hundred pixels below the thing it is about. It
	 *  reads better attached to the clip it explains. */
	let fix = $state<Record<string, NonNullable<ChatItem['shot']>>>({});
	/** Set only once a replacement card actually exists. The card used to announce
	 *  "the next attempt is below" from the verdict alone, which is a sentence
	 *  that reads as a fact and was not one — a diagnosis interrupted mid-flight
	 *  left the claim on screen with nothing under it, and no way to tell. */
	let diagnosed = $state<Record<string, boolean>>({});

	/** Show the clip to a model that can see, and put the next attempt on a card.
	 *
	 *  A diagnosis you have to act on by hand is a diagnosis most people read and
	 *  close, so what comes back is a whole shot — prompt and adapters both —
	 *  ready to send. Nothing is spent until you send it. */
	async function diagnose(workspace: string) {
		if (!workspace || diagnosing[workspace]) return;
		// globalThis for the same reason as in grabFrames: `document` is a snippet
		// in this file and shadows the global.
		const video = globalThis.document.querySelector<HTMLVideoElement>(
			`video[data-clip="${CSS.escape(workspace)}"]`
		);
		if (!video) {
			pushError('the clip is not on screen any more, so there is nothing to look at.');
			return;
		}
		diagnosing[workspace] = true;
		try {
			const frames = await grabFrames(video);
			if (!frames.length) {
				pushError('could not read any frames out of that clip.');
				return;
			}
			const res = await fetch('/studio/api/diagnose', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ workspace, frames })
			});
			const r = (await res.json()) as { ok?: boolean; shot?: ChatItem['shot']; error?: string };
			if (!r.ok || !r.shot) {
				pushError(r.error || 'the diagnosis did not come back with anything usable.');
				return;
			}
			r.shot.wroteLoras = (r.shot.loras ?? []).map((p) => ({ ...p }));
			fix[workspace] = r.shot;
			// The diagnosis is what the note field was for. Written by whoever
			// actually looked rather than typed from memory, and it turns a row
			// that says a clip failed into one that says how.
			if (r.shot.why) {
				void fetch('/studio/api/renders', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ workspace, note: r.shot.why })
				}).catch(() => {});
			}
			diagnosed[workspace] = true;
			persist();
		} catch (e) {
			pushError(`the diagnosis failed — ${e}`);
		} finally {
			diagnosing[workspace] = false;
		}
	}

	let fixBusy = $state<Record<string, boolean>>({});

	async function renderFix(workspace: string) {
		const shot = fix[workspace];
		if (!shot || fixBusy[workspace]) return;
		fixBusy[workspace] = true;
		try {
			await launchShot(shot);
		} finally {
			fixBusy[workspace] = false;
		}
	}

	/** For when you want to read the whole brief, or change it, before spending
	 *  three minutes on it. The fix arrives as a summary; this is the long form. */
	function openFix(workspace: string) {
		const shot = fix[workspace];
		if (!shot) return;
		pushItem({ who: 'studio', kind: 'shot', shot });
		delete fix[workspace];
		persist();
	}

	/** Move one adapter's strength on a card that has not been sent yet.
	 *
	 *  The writer is held inside the range its author published, because it is
	 *  choosing a number from a description and has no way to check the result.
	 *  You are not held to it. You have the clip in front of you, and the author's
	 *  range came from their material rather than yours — so the band is shown as
	 *  a reference and the slider goes past it. */
	function setLoraStrength(itemId: string, key: string, value: number) {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.shot || item.shot.launched) return;
		const n = Math.round(Math.min(2, Math.max(0, value)) * 20) / 20;
		item.shot.loras = (item.shot.loras ?? []).map((p) => (p.key === key ? { ...p, strength: n } : p));
	}

	/** Move an always-loaded adapter for this clip only.
	 *
	 *  These cannot be switched off — they are what every clip is built on — but
	 *  the realism slider and the anatomy corrector are both worth a nudge now and
	 *  then, and until this existed nudging one meant editing the catalogue and
	 *  committing it. */
	function setBaseStrength(itemId: string, key: string, value: number) {
		const item = chat.find((c) => c.id === itemId);
		const l = loraFor(key);
		if (!item?.shot || item.shot.launched || !l) return;
		const n = Math.round(Math.min(2, Math.max(0, value)) * 20) / 20;
		item.shot.baseLoras = { ...(item.shot.baseLoras ?? {}), [key]: n };
	}

	/** Back to what the adapter's author recommends. */
	function resetLoraStrength(itemId: string, key: string) {
		const l = loraFor(key);
		if (!l) return;
		if (l.kind === 'base') setBaseStrength(itemId, key, l.strength);
		else setLoraStrength(itemId, key, l.strength);
	}

	function setShotOrientation(itemId: string, orientation: 'portrait' | 'landscape') {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.shot || item.shot.orientation === orientation) return;
		void respin(itemId, { seconds: item.shot.seconds, orientation });
	}

	let shotBusy = $state<Record<string, boolean>>({});

	/** Switching modes changes what the composer does with the next message and
	 *  nothing else. The transcript stays: a card you already rendered is still
	 *  worth looking at from the other side of the switch, and a run in flight
	 *  keeps polling. */
	function setMode(next: 'simple' | 'advanced') {
		if (mode === next) return;
		mode = next;
		try {
			localStorage.setItem(MODE_KEY, next);
		} catch {
			/* private mode — the switch still works for this session */
		}
		if (!chat.some((c) => c.who === 'user')) showWelcome();
	}

	// --- planning the plan ----------------------------------------------------------

	async function callPlan(body: unknown): Promise<Brief | null> {
		const res = await fetch('/studio/api/plan', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			// A 4xx here is a SvelteKit error(), whose body is { message }.
			const m = (await res.json().catch(() => null)) as { message?: string } | null;
			pushError(m?.message || `Planning could not start (${res.status}).`);
			return null;
		}
		const r = (await res.json()) as { ok: boolean; brief?: Brief; error?: string };
		if (!r.ok || !r.brief) {
			pushError(r.error || 'The plan could not be created.');
			return null;
		}
		return r.brief;
	}

	async function planFromIdea(idea: string) {
		const b = await callPlan({ prompt: idea, sceneCount });
		if (!b) return;
		originalPitch = idea;
		brief = b;
		sceneCount = b.sceneCount;
		const item = pushItem({ who: 'studio', kind: 'plan', plan: b });
		latestPlanId = item.id;
	}

	/** A message typed while a plan awaits approval refines that plan: the prior
	 *  Brief and the feedback both travel to /plan, and the revision lands as a
	 *  new chat item while the old one collapses. */
	async function refinePlan(feedback: string) {
		if (!brief) return;
		const b = await callPlan({ prompt: originalPitch, sceneCount, prior: brief, feedback });
		if (!b) return;
		if (latestPlanId) superseded[latestPlanId] = true;
		editingPlan = false;
		brief = b;
		sceneCount = b.sceneCount;
		const item = pushItem({ who: 'studio', kind: 'plan', plan: b });
		latestPlanId = item.id;
	}

	function openEdit() {
		if (!brief) return;
		editTitle = brief.title;
		editStory = brief.story;
		editStyle = brief.style;
		editingPlan = true;
	}

	function saveEdit() {
		if (!brief) return;
		brief = {
			...brief,
			title: editTitle.trim() || brief.title,
			story: editStory.trim() || brief.story,
			style: editStyle.trim() || brief.style
		};
		const item = chat.find((c) => c.id === latestPlanId);
		if (item) item.plan = brief;
		editingPlan = false;
	}

	// --- talking to a workspace manager --------------------------------------------

	async function managerChat(msg: string) {
		try {
			const r = await call('chat', { msg }, activeWs);
			const d = r.data;
			if (r.offline || r.wedged) {
				pushError(r.wedged ? WEDGED_TEXT : OFFLINE_TEXT);
			} else if (!r.ok) {
				const e = d as { code?: string; error?: string } | string | undefined;
				const detail =
					typeof e === 'string' ? e : `${e?.code ?? r.status} — ${(e?.error ?? '').slice(0, 300)}`;
				pushError(`Error from the harness: ${detail}`);
			} else {
				pushStudio(typeof d === 'string' ? d : JSON.stringify(d));
				// A manager message can schedule new work — make sure the poller is
				// awake and fast again, whatever state the backoff was in.
				startPolling();
			}
		} catch (e) {
			pushError(String(e));
		}
	}

	// --- launching --------------------------------------------------------------------

	let launchingPlanning = $state(false);

	async function callLaunch(body: unknown): Promise<LaunchResult> {
		const res = await fetch('/studio/api/launch', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!res.ok) {
			const m = (await res.json().catch(() => null)) as { message?: string } | null;
			return { ok: false, error: m?.message || `launch ${res.status}` };
		}
		return (await res.json()) as LaunchResult;
	}

	/** [start] on the plan card. Opens the LLM-only planning workspace — cheap,
	 *  no GPU. A workspace id can only be opened once (reopening is a silent
	 *  no-op), so a retry after a failure carries a suffixed slug. */
	async function launchPlanning() {
		if (!brief || launchingPlanning || planningWs) return;
		launchingPlanning = true;
		planningLaunchAttempts += 1;
		const b: Brief = {
			...brief,
			slug: planningLaunchAttempts === 1 ? brief.slug : `${brief.slug}-r${planningLaunchAttempts}`,
			sceneCount
		};
		try {
			const r = await callLaunch({ stage: 'planning', brief: b });
			if (!r.ok) {
				pushError(r.offline ? OFFLINE_TEXT : r.error || 'The workspace did not open.');
				return;
			}
			launchedBrief = b;
			planningWs = r.workspaceId;
			// Before anything has been written. The point of the board is to show
			// the shape of the work while it is still empty.
			if (!boardId) boardId = pushItem({ who: 'studio', kind: 'board' }).id;
			startedAt = Date.now();
			now = Date.now();
			editingPlan = false;
			pushStudio(
				'Planning has started. About four minutes, still no GPU — documents appear here as they are written.'
			);
			persist();
			startPolling();
		} catch (e) {
			pushError(String(e));
		} finally {
			launchingPlanning = false;
		}
	}

	/** [start shooting] on the approval card. Collects the five approved
	 *  document texts and opens the render workspace, whose planner prompt
	 *  carries them inline. */
	async function launchRender() {
		if (!launchedBrief || renderLaunching || renderWs) return;
		renderLaunching = true;
		try {
			// Re-fetch anything that failed to load earlier — the render launch is
			// the one moment every document text must actually be in hand. Keys are
			// the ApprovedDocs field names compose.ts asserts on, not artifact keys.
			const approved: Record<string, string> = {};
			for (const step of PLANNING_STEPS) {
				let body = docBody[step.artifact];
				if (!body) {
					const a = (planningPoll?.artifacts ?? []).find((x) => x.key === step.artifact);
					const name = a ? firstFileOfKind(a, 'text') : '';
					if (a && name) body = (await fetchDocBody(a.id, name)) ?? '';
				}
				if (!body) {
					pushError(`The ${step.label} document could not be read — shooting cannot start.`);
					return;
				}
				approved[step.doc] = body;
			}
			renderLaunchAttempts += 1;
			const b: Brief = {
				...launchedBrief,
				slug:
					renderLaunchAttempts === 1
						? launchedBrief.slug
						: `${launchedBrief.slug}-s${renderLaunchAttempts}`
			};
			const r = await callLaunch({ stage: 'render', brief: b, approved });
			if (!r.ok) {
				pushError(r.offline ? OFFLINE_TEXT : r.error || 'The shooting workspace did not open.');
				return;
			}
			renderWs = r.workspaceId;
			startedAt = Date.now();
			now = Date.now();

			// Say what the crew was actually given. A workflow that failed to load
			// does not stop the shoot — it quietly removes an option the agents
			// would otherwise have had, and that is invisible unless said here.
			const extras: string[] = [];
			const loadedWf = r.library?.workflows.filter((w) => w.ok).map((w) => w.name) ?? [];
			const failedWf = r.library?.workflows.filter((w) => !w.ok) ?? [];
			const loadedSk = r.library?.skills.filter((k) => k.ok).map((k) => k.name) ?? [];
			const failedSk = r.library?.skills.filter((k) => !k.ok) ?? [];
			if (loadedWf.length) extras.push(`Extra workflows loaded: ${loadedWf.join(', ')}.`);
			if (loadedSk.length) extras.push(`Extra skills loaded: ${loadedSk.join(', ')}.`);
			for (const f of [...failedWf, ...failedSk]) {
				extras.push(`${f.name} did not load — ${f.detail ?? 'no reason given'}. The shoot goes on without it.`);
			}
			if (r.refs?.imported.length) {
				extras.push(
					`Reference material attached: ${r.refs.imported.join(', ')}. The crew cannot see these — they go to the render as reference input, guided by the descriptions you wrote.`
				);
			}
			if (r.refs?.error) {
				extras.push(`Your reference files could not be attached — ${r.refs.error}`);
			}

			pushItem({ who: 'studio', kind: 'shootboard' });
			if (extras.length) pushStudio(extras.join('\n\n'));
			persist();
			startPolling();
		} catch (e) {
			pushError(String(e));
		} finally {
			renderLaunching = false;
		}
	}

	// --- polling ----------------------------------------------------------------------

	/** Everything that would make the screen change. Identical signatures back to
	 *  back mean nothing moved, which is what the backoff keys off. */
	function signature(p: PollState): string {
		const t = (p.tasks ?? []).map((x) => `${x.id}:${x.status}`).join(',');
		const a = (p.artifacts ?? [])
			.map((x) => `${x.id}:${x.status}:${(x.files ?? []).length}`)
			.join(',');
		return `${t}|${a}`;
	}

	/** Called wherever a render begins. The estimate is read once per run for the
	 *  same reason as the prompt one, and re-read after a run finishes so the
	 *  next wait already knows about the one that just ended. */
	function refreshClipEstimate() {
		typicalClip = typicalWait('clip');
	}

	function stopPolling() {
		if (timer) clearTimeout(timer);
		timer = null;
		runId += 1;
		pollingActive = false;
	}

	function startPolling() {
		stopPolling();
		// Nothing to watch is not the same as watching nothing happen. `tick` bails
		// out when there is no workspace, but it bailed out *after* the flag was
		// already true — so the live status line sat under the composer with its
		// dot pulsing and its clock climbing, announcing a render that had never
		// been launched. A session restored before its first render did exactly
		// this, and read as hung. Refuse the run instead of narrating it.
		if (!activeWs) return;
		// The one choke point where a run becomes live again: a resumed shoot, a
		// new clip, a continuation. Whatever it was, it is not a leftover now.
		staleRun = false;
		refreshClipEstimate();
		quiet = 0;
		lastSig = '';
		sawAllDone = false;
		sawRunning = false;
		pollingActive = true;
		tick(runId);
	}

	async function tick(id: number) {
		// The target is captured up front: a launch mid-tick retargets the loop
		// through startPolling (which bumps runId), so a stale tick simply exits.
		const target = activeWs;
		if (id !== runId) return;
		// The workspace can also go away under a live loop — a reset, a session
		// swap. Same rule as above: stop claiming to poll.
		if (!target) {
			pollingActive = false;
			return;
		}

		// The board carries the documents AND the button that starts the shoot, so
		// a production without one cannot be approved at all — there is nothing to
		// press. It was posted in exactly one place, at launch, behind a guard that
		// a stale id could hold shut; that happened, and the run became
		// unapprovable while the rail cheerfully showed it progressing.
		//
		// So it is posted from here as well. Whatever went wrong upstream — a
		// resumed tab, a guard left set, a launch path that did not run — the next
		// poll puts it back.
		if (planningWs && !boardId) {
			boardId = pushItem({ who: 'studio', kind: 'board' }).id;
		}
		// Only a poll that actually answered may be used to decide anything.
		// A failed poll is never progress.
		let answered = false;
		let fresh: PollState | null = null;
		try {
			const r = await call('poll-state', {}, target);
			// Fetched alongside, never instead: a failing event log must not stop
			// the state poll that drives everything else on screen.
			void pollActivity(target).catch(() => {});
			if (r.offline || r.wedged) {
				offline = true;
				quiet += 1;
				if (!offlineNoted) {
					offlineNoted = true;
					pushError(r.wedged ? WEDGED_TEXT : OFFLINE_TEXT);
				}
			} else if (!r.ok) {
				// A crashed workspace agent answers 500 INTERNAL_AGENT_EXECUTION_FAILED
				// on every endpoint, forever. The last good state stays on screen and
				// the harness's own words go above it — never an empty page.
				offline = false;
				const d = r.data as { code?: string; error?: string } | string | undefined;
				lastError =
					typeof d === 'string' ? d : `${d?.code ?? r.status} — ${(d?.error ?? '').slice(0, 300)}`;
				quiet += 1;
				if (!errorNoted) {
					errorNoted = true;
					pushError(`Error from the harness: ${lastError}`);
				}
			} else {
				offline = false;
				offlineNoted = false;
				errorNoted = false;
				lastError = '';
				answered = true;
				fresh = r.data as PollState;
				lastTick = new Date();
				const sig = signature(fresh);
				if (sig === lastSig) quiet += 1;
				else {
					quiet = 0;
					lastSig = sig;
				}
			}
		} catch (e) {
			lastError = String(e);
			quiet += 1;
		}

		if (answered && fresh) {
			if (target === renderWs && renderWs) {
				renderPoll = fresh;
				await processRender(fresh);
			} else if (target === planningWs) {
				planningPoll = fresh;
				await processPlanning(fresh);
			}
		}

		// End of the loop, decided only on confirmed data and only after two
		// consecutive polls agree — there are windows (planner just finished,
		// assembly just requested) where "all terminal" is true for one poll while
		// new tasks are still being ingested.
		if (answered && fresh && target === activeWs) {
			const ts = fresh.tasks ?? [];
			const terminal =
				ts.length > 0 && ts.every((t) => DONE.includes(t.status) || DEAD.includes(t.status));
			// One poll that saw work still in flight is what makes the elapsed time
			// a render's length rather than the gap since somebody last looked.
			if (!terminal && ts.length > 0) sawRunning = true;
			let finished = false;
			if (renderWs) {
				const anyDead = ts.some((t) => DEAD.includes(t.status));
				// Rendering ends when the final film was posted, or when a shoot
				// failed permanently and no assembly will be requested.
				//
				// Simple mode has neither. There is one clip and no assembly step, so
				// `finalPosted` — which needs `assemblySent` before a clip can count
				// as the film — stays false for the entire run, and a successful run
				// never concluded. Only failures did, through the anyDead branch,
				// which is why every finished row in the render log was missing its
				// elapsed time while every failed one had it.
				finished = simpleRun ? terminal : terminal && (finalPosted || (anyDead && !assemblySent));
			} else {
				const allPosted = PLANNING_STEPS.every((s) => docPhase[s.artifact] === 'posted');
				const anyDead = ts.some((t) => DEAD.includes(t.status));
				// Planning ends (poll-wise) when every document is on screen and no
				// chain reset is in flight — the workspace just sits there while the
				// user reads. Anything that schedules new work restarts the loop.
				finished = terminal && !chain && (allPosted || anyDead);
			}
			if (finished) {
				if (sawAllDone) {
					// One clip only, and only one that worked. A full production is an
					// order of magnitude longer, and a couple of them in the sample
					// would make the clip estimate useless.
					// Only a render this tab actually watched. See sawRunning.
					if (
						sawRunning &&
						simpleRun &&
						startedAt &&
						!ts.some((t) => DEAD.includes(t.status))
					) {
						recordWait('clip', Date.now() - startedAt);
						refreshClipEstimate();
					}
					// Close the render log's row for this run. Fire and forget: the
					// row is evidence, and a clip that rendered must not look failed
					// because the bookkeeping call did.
					if (renderWs) {
						const dead = ts.some((t) => DEAD.includes(t.status));
						void fetch('/studio/api/renders', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								workspace: renderWs,
								finished: true,
								...(dead ? { outcome: 'failed' } : {})
							})
						})
							.then(() => loadVerdicts())
							.catch(() => {});
					}
					stopPolling();
					return;
				}
				sawAllDone = true;
			} else {
				sawAllDone = false;
			}
		}

		if (id !== runId) return;
		timer = setTimeout(() => tick(id), quiet >= QUIET_CYCLES ? POLL_SLOW_MS : POLL_FAST_MS);
	}

	// --- planning workspace: post documents, drive the chain reset ----------------------

	async function processPlanning(p: PollState) {
		const tasks = p.tasks ?? [];
		const arts = p.artifacts ?? [];

		// Advance the chain reset, if one is in flight. The next downstream task is
		// reset only AFTER the upstream re-ran to completion AND its artifact is
		// approved again — the artifact content is what the downstream regeneration
		// reads, so a merely-terminal task is not enough.
		if (chain) {
			const t = tasks.find((x) => x.key === chain!.taskKey);
			if (t) {
				chain.polls += 1;
				if (t.status === 'pending' || t.status === 'running') chain.armed = true;
				const step = PLANNING_STEPS.find((s) => s.task === chain!.taskKey);
				const a = step ? arts.find((x) => x.key === step.artifact) : undefined;
				const done = DONE.includes(t.status) && (!step || a?.status === 'approved');
				// A re-run that never comes back approved (rejected artifact, wedged
				// task) must not hold the chain — and the poll loop — open forever.
				// ~40 polls is 10-20 minutes; a planning task re-run is ~1 minute.
				if (!done && chain.polls >= 40) {
					pushError(
						'The regeneration did not finish in time — the documents stay on their previous version.'
					);
					for (const key of [chain.taskKey, ...chain.downstream]) {
						const s = PLANNING_STEPS.find((x) => x.task === key);
						if (s && docPhase[s.artifact] === 'regen') docPhase[s.artifact] = 'posted';
					}
					chain = null;
				}
				// Armed-and-done is the normal path; the polls>=8 fallback covers a
				// re-run faster than one poll interval, so the chain cannot stall on
				// a missed observation.
				else if (done && (chain.armed || chain.polls >= 8)) {
					if (step) delete docPhase[step.artifact]; // back to waiting -> re-posts below
					const next = chain.downstream[0];
					if (next) {
						const ok = await resetTaskByKey(next, CONSISTENCY_INSTRUCTION);
						if (ok) {
							chain = { taskKey: next, downstream: chain.downstream.slice(1), armed: false, polls: 0 };
						} else {
							pushError('Could not start regenerating the next document.');
							// The unreset tasks still hold their old (valid) content —
							// hand the cards back so the user is not stuck on a card
							// that says "regenerating" forever.
							for (const key of [chain.taskKey, ...chain.downstream]) {
								const s = PLANNING_STEPS.find((x) => x.task === key);
								if (s && docPhase[s.artifact] === 'regen') docPhase[s.artifact] = 'posted';
							}
							chain = null;
						}
					} else {
						chain = null;
					}
				}
			}
		}

		// Report a permanently failed planning step, once.
		for (const t of tasks) {
			if (DEAD.includes(t.status) && !failedNoted.has(t.id)) {
				failedNoted.add(t.id);
				const step = PLANNING_STEPS.find((s) => s.task === t.key);
				pushError(
					`A planning step stalled: ${step?.label ?? t.key}. Ask for a change to run it again.`
				);
			}
		}

		// Post each approved document as a chat item, exactly once per version.
		// A key in `regen` is skipped: its artifact still carries the pre-reset
		// content until the chain confirms the re-run.
		for (const step of PLANNING_STEPS) {
			const phase = docPhase[step.artifact];
			if (phase === 'posted' || phase === 'regen') continue;
			const a = arts.find((x) => x.key === step.artifact);
			const t = tasks.find((x) => x.key === step.task);
			if (!a || a.status !== 'approved' || !t || !DONE.includes(t.status)) continue;
			const name = firstFileOfKind(a, 'text');
			if (!name) continue;
			const body = await fetchDocBody(a.id, name);
			docPhase[step.artifact] = 'posted';
			docAccepted[step.artifact] = false;
			if (body) {
				docBody[step.artifact] = body;
				docFile[step.artifact] = name;
			}
			// No card per document any more. They land in the board that was posted
			// when the run started, which is the only way to see the five as a set
			// with the one still being written marked as such — a card that appears
			// on completion can only ever show what is already finished.
			docUrl[step.artifact] = fileUrl(planningWs, a.id, name);
			docTaskId[step.artifact] = t.id;
		}

		// The approval gate: all five documents on screen, no revision in flight.
		const allPosted = PLANNING_STEPS.every((s) => docPhase[s.artifact] === 'posted');
		if (allPosted && !chain && !renderWs && !approvalId) {
			const item = pushItem({
				who: 'studio',
				kind: 'approval',
				text:
					'The plan is ready. Read anything you want to check above — once shooting starts, none of it can be changed.\n\nIf you want a particular face, room or movement in the film, attach it with the clip on the message box before you start. That is the last moment it can be handed to the crew.\n\nShooting uses GPU time and costs money.'
			});
			approvalId = item.id;
		}
	}

	async function resetTaskByKey(taskKey: string, instructions: string): Promise<boolean> {
		const t = (planningPoll?.tasks ?? []).find((x) => x.key === taskKey);
		if (!t) return false;
		try {
			const r = await call('reset-task', { req: { taskId: t.id, instructions } }, planningWs);
			return r.ok;
		} catch {
			return false;
		}
	}

	/** [request a change] submitted on a document card. Resets that one planning
	 *  task with the user's instructions, then marks it and everything downstream
	 *  for regeneration — the chain reset regenerates them in dependency order. */
	async function requestChange(itemId: string, artifactKey: string) {
		const text = (changeText[itemId] ?? '').trim();
		if (!text || changeBusy[itemId]) return;
		const idx = PLANNING_STEPS.findIndex((s) => s.artifact === artifactKey);
		if (idx === -1) return;
		const step = PLANNING_STEPS[idx];
		changeBusy[itemId] = true;
		try {
			const ok = await resetTaskByKey(step.task, text);
			if (!ok) {
				pushError('Could not send the change request.');
				return;
			}
			for (const s of PLANNING_STEPS.slice(idx)) {
				docPhase[s.artifact] = 'regen';
				docAccepted[s.artifact] = false;
			}
			chain = {
				taskKey: step.task,
				downstream: PLANNING_STEPS.slice(idx + 1).map((s) => s.task),
				armed: false,
				polls: 0
			};
			// A pending approval card no longer describes the truth — collapse it;
			// a fresh one posts when the regenerated set is complete.
			if (approvalId) {
				superseded[approvalId] = true;
				approvalId = '';
			}
			changeOpen[itemId] = false;
			changeText[itemId] = '';
			pushStudio(
				`Rewriting the ${step.label.toLowerCase()}. Everything built on it is refreshed too, in order.`
			);
			startPolling();
		} finally {
			changeBusy[itemId] = false;
		}
	}

	// --- render workspace: clips, then the assembly ---------------------------------------

	function isShootTask(t: Task): boolean {
		return t.key !== 'schedule_video_renders' && !ASSEMBLE_RE.test(`${t.key} ${t.title}`);
	}

	async function processRender(p: PollState) {
		const tasks = p.tasks ?? [];
		const arts = p.artifacts ?? [];
		const shoots = tasks.filter(isShootTask);

		if (!shootsAnnounced && shoots.length > 0) {
			shootsAnnounced = true;
			pushStudio(`Shoot scheduled — ${shoots.length} scenes to render.`);
		}

		for (const t of tasks) {
			if (DEAD.includes(t.status) && !failedNoted.has(t.id)) {
				failedNoted.add(t.id);
				// The card itself offers the retry — see the error branch in the
				// markup, which looks back for the brief rather than being told about
				// it here. A render dies on the harness's side more often than on
				// ours: "render-infra-fatal: invalid-output: timed out" at 340s against
				// a 2400s budget, on a chain whose previous clip took 657s and was
				// fine. The answer to that is the same button again, and it used to be
				// three scrolls up on a card that says "launched".
				pushError(`A shooting step stalled: ${t.title || t.key}.`);
			}
		}

		// A sheet run produces one image and nothing else, so it is handled first
		// and returns — the clip bookkeeping below counts scenes and assembles
		// films, neither of which a sheet has any business in.
		if (sheetRun) {
			for (const a of arts) {
				if (a.status !== 'approved') continue;
				const name = firstFileOfKind(a, 'image');
				if (!name || clipPosted.has(a.id)) continue;
				clipPosted.add(a.id);
				const kind = pendingSheet?.kind ?? 'character';
				const description = pendingSheet?.description ?? '';
				const stage = pendingSheet?.stage ?? 'sheet';
				pushItem({
					who: 'studio',
					kind: 'sheet',
					sheet: {
						kind,
						stage,
						description,
						why: pendingSheet?.why,
						seed: pendingSheet?.seed,
						url: fileUrl(renderWs, a.id, name),
						workspace: renderWs,
						artifact: a.id,
						file: name,
						name: firstWords(description, kind),
						// A preview is already spent — it exists to be looked at, not
						// launched again — so it arrives latched.
						launched: true
					}
				});
			}
			return;
		}

		// Every approved artifact with a video file becomes a clip in the chat.
		// After the assembly request, a new artifact (or one named like a final
		// cut) is the film itself and closes the transcript.
		const clipArts = arts
			.filter((a) => a.status === 'approved' && firstFileOfKind(a, 'video'))
			.sort((x, y) => sceneNo(x.key, x.name) - sceneNo(y.key, y.name));
		for (const a of clipArts) {
			if (clipPosted.has(a.id)) continue;
			clipPosted.add(a.id);
			const name = firstFileOfKind(a, 'video');
			// Before anything else is done with it — this is the one moment the
			// clip is known to exist and the agent is known to be answering.
			keepClip(renderWs, a.id, name);
			const isFinal =
				assemblySent &&
				(ASSEMBLE_RE.test(`${a.key} ${a.name} ${name}`) ||
					(!finalByNameOnly && !preAssemblyIds.has(a.id)));
			pushItem({
				who: 'studio',
				kind: 'clips',
				text: isFinal ? 'The film is ready.' : a.name || name,
				artifact: {
					id: a.id,
					key: a.key,
					title: isFinal ? 'A film' : a.name || name,
					taskId: '',
					files: [{ name, url: fileUrl(renderWs, a.id, name) }],
					workspace: renderWs
				}
			});
			if (isFinal) {
				finalPosted = true;
				persist();
			}
		}

		// The assembly cannot be a declared task (requires.tasks cannot reference
		// dynamically created shoots), so this page triggers it: when every shoot
		// is a success, the proven instruction goes to the manager.
		if (
			!assemblySent &&
			!simpleRun &&
			shoots.length > 0 &&
			shoots.every((t) => DONE.includes(t.status)) &&
			tasks.every((t) => !DEAD.includes(t.status))
		) {
			assemblySent = true;
			persist();
			for (const a of arts) preAssemblyIds.add(a.id);
			pushStudio('All scenes are done. Assembling the final cut.');
			try {
				const r = await call('chat', { msg: ASSEMBLY_MSG }, renderWs);
				if (r.ok && typeof r.data === 'string' && r.data.trim()) pushStudio(r.data);
				else if (!r.ok) pushError('The assembly request did not go through — you can send it again from the chat.');
			} catch (e) {
				pushError(`The assembly request did not go through: ${e}`);
			}
			// New work was just scheduled — wake the backoff and forget any
			// "everything is terminal" observation.
			startPolling();
		}
	}

	// --- rail --------------------------------------------------------------------------

	type RailStatus = 'pending' | 'running' | 'done' | 'failed' | 'regen';
	type RailEntry = { id: string; label: string; status: RailStatus };

	function mapStatus(s: string): RailStatus {
		if (DONE.includes(s)) return 'done';
		if (DEAD.includes(s)) return 'failed';
		if (s === 'running') return 'running';
		return 'pending';
	}

	const STATUS_LABEL: Record<RailStatus, string> = {
		pending: 'waiting',
		running: 'running',
		done: 'done',
		failed: 'stalled',
		regen: 'rerunning'
	};

	/** The full pipeline, future steps included — ghosts (pending) until a poll
	 *  brings the real task, shoot entries from the render poll once the planner
	 *  created them, N static ghosts from the brief before that. */
	const rail = $derived.by<RailEntry[]>(() => {
		// A simple run is one task per clip. Showing it the planning chain listed
		// every document it will never write as `waiting`, above the clip that was
		// actually running — a rail describing the other mode.
		if (simpleRun) {
			return (renderPoll?.tasks ?? [])
				.slice()
				.sort((x, y) => sceneNo(x.key) - sceneNo(y.key))
				.map((t) => ({ id: t.id, label: t.key, status: mapStatus(t.status) }));
		}

		const b = brief;
		if (!b) return [];
		// The rail speaks the workspace's own vocabulary: these are the exact task
		// keys the harness, its event log and its terminal UI use. One name per
		// step, so a screenshot of this rail and a line in an error message are
		// talking about the same thing without translation.
		const out: RailEntry[] = [{ id: 'plan', label: 'plan', status: 'done' }];

		const ptasks = planningPoll?.tasks ?? [];
		for (const s of PLANNING_STEPS) {
			const t = ptasks.find((x) => x.key === s.task);
			let status: RailStatus = t ? mapStatus(t.status) : 'pending';
			if (docPhase[s.artifact] === 'regen' || chain?.taskKey === s.task) status = 'regen';
			out.push({ id: s.task, label: s.task, status });
		}

		const rtasks = renderPoll?.tasks ?? [];
		const sched = rtasks.find((t) => t.key === 'schedule_video_renders');
		out.push({
			id: 'schedule',
			label: 'schedule_video_renders',
			status: sched ? mapStatus(sched.status) : 'pending'
		});

		const shoots = rtasks.filter(isShootTask).sort((x, y) => sceneNo(x.key) - sceneNo(y.key));
		if (shoots.length > 0) {
			shoots.forEach((t, i) =>
				out.push({ id: t.id, label: t.key, status: mapStatus(t.status) })
			);
		} else {
			for (let i = 0; i < b.sceneCount; i++) {
				out.push({ id: `shoot-ghost-${i}`, label: `shoot_scene_${i + 1}`, status: 'pending' });
			}
		}

		const asm = rtasks.find((t) => ASSEMBLE_RE.test(`${t.key} ${t.title}`));
		out.push({
			id: 'assemble',
			// The only step whose key we cannot know in advance: the manager agent
			// names this task itself when it creates it at runtime (we have seen
			// both assemble_final_film and combine_clips_final_video). Show the
			// real key once it exists, a placeholder while it is still a ghost.
			label: asm?.key ?? 'assemble_final_film',
			// `assemblySent` survives a reload, so on a stale run this pill drew
			// `rendering` forever — the live line's claim, made a second time by
			// the rail beside it.
			status: finalPosted
				? 'done'
				: asm
					? mapStatus(asm.status)
					: assemblySent && !staleRun
						? 'running'
						: 'pending'
		});
		return out;
	});

	const railDone = $derived(rail.filter((e) => e.status === 'done').length);
	const railRunning = $derived(rail.find((e) => e.status === 'running' || e.status === 'regen'));
	const railSummary = $derived.by(() => {
		const head = `${railDone}/${rail.length} steps done`;
		return railRunning ? `${head} · ${railRunning.label.toLowerCase()}` : head;
	});

	/** Precise rather than rounded: during a twenty-minute run the difference
	 *  between "4 minutes" and "4m 31s" is the difference between a page that
	 *  looks frozen and one that is visibly counting. */
	function elapsedLabel(ms: number): string {
		const s = Math.max(0, Math.floor(ms / 1000));
		const m = Math.floor(s / 60);
		return m === 0 ? `${s}s` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
	}

	// --- resume / reset -----------------------------------------------------------------

	/** Everything a reload has to bring back.
	 *
	 *  This used to save the run's identity only, on the theory that the
	 *  transcript would rebuild itself from poll state. It does — right up until
	 *  the workspace agent dies, which is when a reload is most likely and the
	 *  poll returns nothing. A finished production would then reload into an
	 *  empty page: the clips still on disk, the conversation simply gone.
	 *
	 *  So the transcript is saved as itself. The clip cards keep working because
	 *  their urls resolve against the local copy, not the harness.
	 */
	function snapshot(withBodies: boolean) {
		return {
			sessionSlug,
			// What you are in the middle of continuing.
			//
			// It lived only in memory, so a reload between pressing "continue this"
			// and sending the next beat dropped the intent silently — and the text
			// you then typed would have been shot as an unrelated new clip rather
			// than as the next part of the scene. The banner disappears with it, so
			// there is a version of this that is merely confusing and a version that
			// costs a render.
			continuing,
			brief,
			launchedBrief,
			planningWs,
			renderWs,
			assemblySent,
			startedAt,
			// the conversation
			chat: withBodies
				? chat
				: chat.map((i) =>
						i.artifact?.body ? { ...i, artifact: { ...i.artifact, body: undefined } } : i
					),
			superseded,
			latestPlanId,
			boardId,
			approvalId,
			gateOpen,
			// document cards and the revision chain behind them
			docPhase,
			docAccepted,
			latestDocItem,
			docBody: withBodies ? docBody : {},
			docFile,
			docUrl,
			docTaskId,
			// the guards that stop a live poll re-posting what is already shown
			clipPosted: [...clipPosted],
			failedNoted: [...failedNoted],
			preAssemblyIds: [...preAssemblyIds],
			seenActivity: [...seenActivity],
			shootsAnnounced,
			finalPosted,
			finalByNameOnly,
			// Without this the greeting returns as the transcript's first paragraph
			// on every reopen: the item is in `chat`, but the id that tells the
			// template it is the greeting was minted fresh on load and no longer
			// matches it, so it falls through to the plain-text branch.
			welcomeId,
			// The text a re-render is a re-render OF. Without it a clip launched
			// after reopening files itself under the title 'Direct render' and
			// writes an empty request into the render log — the one record that is
			// supposed to say what was asked for.
			lastRequest
		};
	}

	function persist() {
		const slug = runSlug;
		if (!slug) return;
		// Document bodies are most of the payload and the least of the loss: the
		// transcript still reads, the cards fall back to a link. So a run too big
		// for the quota drops them rather than saving nothing at all.
		for (const withBodies of [true, false]) {
			try {
				localStorage.setItem(runKey(slug), JSON.stringify(snapshot(withBodies)));
				localStorage.setItem(POINTER_KEY, slug);
				return;
			} catch {
				/* quota, or private mode — try smaller, then give up */
			}
		}
	}

	/** Save whenever the conversation grows.
	 *
	 *  The explicit calls elsewhere mark milestones — a launch, an approval, the
	 *  final cut — and between them the transcript fills with documents, clips and
	 *  progress lines that a reload would otherwise lose. Debounced because
	 *  activity arrives in bursts on each poll, and one write per burst is
	 *  plenty. */
	let persistTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		chat.length;
		// The precondition is a slug to file it under, and nothing more. It used
		// to also demand a brief — which only an advanced production has — so in
		// simple mode the conversation was written once, by the explicit call at
		// launch, and then never again: the clip that came back, the activity and
		// every later message were all dropped. That is most of the list.
		if (!runSlug) return;
		if (persistTimer) clearTimeout(persistTimer);
		persistTimer = setTimeout(persist, 800);
	});

	function forget() {
		if (persistTimer) clearTimeout(persistTimer);
		try {
			// Only the pointer. Each run's conversation stays where it is — that is
			// what the sidebar is for, and starting a new production is not a
			// reason to lose the last one.
			localStorage.removeItem(POINTER_KEY);
			localStorage.removeItem(RESUME_KEY);
			sessionStorage.removeItem(RESUME_KEY);
		} catch {
			/* ignore */
		}
	}

	function reset() {
		stopPolling();
		staleRun = false;
		forget();
		chat = [];
		superseded = {};
		brief = null;
		originalPitch = '';
		launchedBrief = null;
		latestPlanId = '';
		sessionSlug = '';
		planningWs = '';
		renderWs = '';
		planningPoll = null;
		renderPoll = null;
		offline = false;
		lastError = '';
		docPhase = {};
		docAccepted = {};
		latestDocItem = {};
		docBody = {};
		docFile = {};
		docUrl = {};
		docTaskId = {};
		// The board is posted once per production, guarded by this id. Left set, the
		// guard held on the second run and the board never appeared — the tasks were
		// running, the rail showed them, and the transcript showed nothing.
		boardId = '';
		// Per-run too: the activity feed dedupes against this, the retry alarm
		// counts against these, and the stop button arms into these.
		seenActivity = new Set<string>();
		retryCounts = new Map<string, number>();
		retryWarned = new Set<string>();
		stopArmed = false;
		stopping = false;
		gateOpen = {};
		approvalId = '';
		chain = null;
		shootsAnnounced = false;
		assemblySent = false;
		shotBusy = {};
		lastRequest = '';
		finalPosted = false;
		editingPlan = false;
		expanded = {};
		changeOpen = {};
		changeText = {};
		changeBusy = {};
		railOpen = false;
		showDetails = false;
		clipPosted.clear();
		failedNoted.clear();
		preAssemblyIds.clear();
		finalByNameOnly = false;
		errorNoted = false;
		offlineNoted = false;
		planningLaunchAttempts = 0;
		renderLaunchAttempts = 0;
		welcomeId = '';
		showWelcome();
	}

	// --- small UI helpers ------------------------------------------------------------------

	function grow(el: HTMLTextAreaElement | null) {
		if (!el) return;
		el.style.height = 'auto';
		el.style.height = `${el.scrollHeight}px`;
	}

	/** Back to one row.
	 *
	 *  Not grow() with an empty value: clearing `input` is a state assignment
	 *  that has not reached the DOM yet when this runs, so measuring scrollHeight
	 *  here measures the message that was just sent and the box stays tall.
	 *  Dropping the inline height hands the size back to the rows attribute,
	 *  which needs no measurement to be right. */
	function shrink(el: HTMLTextAreaElement | null) {
		if (!el) return;
		el.style.height = '';
	}

	async function useExample(text: string) {
		input = text;
		composer?.focus();
		// After the flush, not before it: grow() measures scrollHeight, and until
		// Svelte has written the new value into the element that is the height of
		// the old one. Measuring early left a three-line seed clipped to one.
		await flush();
		grow(composer);
	}

	/** Collapse threshold for document prose — roughly twelve lines of text. */
	function isLong(text: string): boolean {
		return text.length > 700 || text.split('\n').length > 12;
	}

	// Follow the conversation, but only when the reader is already near the
	// bottom — nobody's scroll position gets yanked while they re-read a scene.
	let bottomEl = $state<HTMLElement | null>(null);
	/** The transcript element — the page's only scroll container. */
	let scrollEl = $state<HTMLElement | null>(null);
	/** Whether the reader is parked at the latest message. Drives both the
	 *  follow-the-tail behaviour and the "latest ↓" button. */
	let atBottom = $state(true);

	/** Within this many pixels of the end still counts as "at the bottom" —
	 *  a reader who has scrolled up by a line or two has not left the tail. */
	const TAIL_SLACK = 120;

	function onTranscriptScroll() {
		const el = scrollEl;
		if (!el) return;
		atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= TAIL_SLACK;
	}

	function scrollToBottom(behavior: ScrollBehavior = 'auto') {
		const el = scrollEl;
		if (!el) return;
		el.scrollTo({ top: el.scrollHeight, behavior });
		atBottom = true;
	}

	let seenLen = 0;
	$effect(() => {
		const len = chat.length;
		if (len <= seenLen) {
			seenLen = len;
			return;
		}
		seenLen = len;
		// Follow the tail only for a reader who is already there. Yanking someone
		// out of a document they are mid-way through reading is the one thing a
		// long-running transcript must never do — this run posts messages for
		// twenty minutes.
		if (!atBottom) return;
		// Two frames: the first lets Svelte flush the new node, the second lets
		// layout settle so scrollHeight is the post-insert value.
		requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom('smooth')));
	});

	function setNavOpen(open: boolean) {
		sidebarOpen = open;
		try {
			localStorage.setItem(NAV_KEY, open ? '1' : '0');
		} catch {
			/* a preference that will not persist is not worth an error */
		}
	}

	/** Put a saved run on screen: the transcript, the workspaces, the poller.
	 *
	 *  Lifted out of onMount so reopening a production can call it directly. It
	 *  used to live inline there, which is why reopening had to write a pointer
	 *  and reload the whole document to reach it — a white flash and a cold boot
	 *  of the app to move between two conversations already in the same tab.
	 *
	 *  Everything it touches is component state, so it may be called more than
	 *  once in a session provided reset() has run in between.
	 */
	function resumeFrom(raw: string | null): boolean {
		if (!raw) return false;
		let s: Partial<ReturnType<typeof snapshot>>;
		try {
			s = JSON.parse(raw) as Partial<ReturnType<typeof snapshot>>;
		} catch {
			return false;
		}
		// A workspace to poll is the whole requirement. Requiring a brief on top
		// of it meant a simple run could not be resumed at all — there is no plan
		// in one, only a prompt — and a reload mid-render left the clip finishing
		// on the harness with nothing watching for it.
		// ...or a session that has started and not yet rendered anything. Before
		// sessions existed there was nothing to restore in that state; now there
		// is a conversation, and dropping it on reload was the same loss as
		// dropping a run.
		if (!(s.planningWs || s.renderWs || s.sessionSlug)) return false;
			sessionSlug = s.sessionSlug ?? '';
			// Back into the same state the banner reads, so a reload lands you where
			// you were rather than one step to the side of it.
			continuing = s.continuing ?? null;
			brief = s.brief ?? null;
			launchedBrief = s.launchedBrief ?? s.brief ?? null;
			sceneCount = s.brief?.sceneCount ?? sceneCount;
			planningWs = s.planningWs ?? '';
			renderWs = s.renderWs ?? '';
			// The mode follows the run you opened. Landing in a simple run with
			// the advanced composer under it is the same mismatch as the rail:
			// the page describing one mode while showing the other.
			if (ONE_CLIP_WS.test(renderWs)) mode = 'simple';
			else if (s.planningWs) mode = 'advanced';
			assemblySent = s.assemblySent ?? false;
			startedAt = s.startedAt || Date.now();
			// Asked here rather than anywhere later, because everything below
			// reads as live: the poller, the clock, the rail's pills.
			staleRun = Date.now() - startedAt > RUN_CEILING_MS;
			if (assemblySent) {
				shootsAnnounced = true;
				finalByNameOnly = true;
			}

			// A saved conversation is restored as itself. Anything older —
			// written before transcripts were saved — falls back to the plan
			// card, which is what it used to do.
			if (s.chat?.length) {
				chat = s.chat;
				superseded = s.superseded ?? {};
				latestPlanId = s.latestPlanId ?? '';
				boardId = s.boardId ?? '';
				approvalId = s.approvalId ?? '';
				gateOpen = s.gateOpen ?? {};
				docPhase = s.docPhase ?? {};
				docAccepted = s.docAccepted ?? {};
				latestDocItem = s.latestDocItem ?? {};
				docBody = s.docBody ?? {};
				docFile = s.docFile ?? {};
				docUrl = s.docUrl ?? {};
				docTaskId = s.docTaskId ?? {};
				for (const id of s.clipPosted ?? []) clipPosted.add(id);
				for (const id of s.failedNoted ?? []) failedNoted.add(id);
				for (const id of s.preAssemblyIds ?? []) preAssemblyIds.add(id);
				seenActivity = new Set(s.seenActivity ?? []);
				shootsAnnounced = s.shootsAnnounced ?? shootsAnnounced;
				finalPosted = s.finalPosted ?? false;
				finalByNameOnly = s.finalByNameOnly ?? finalByNameOnly;
				welcomeId = s.welcomeId ?? '';
			lastRequest = s.lastRequest ?? '';
			} else if (brief) {
				const item = pushItem({ who: 'studio', kind: 'plan', plan: brief });
				latestPlanId = item.id;
			}
			// A run past the ceiling is not polled. The harness has already
			// given up on every task it could have been running, so the loop
			// would only ask a dead workspace the same question every thirty
			// seconds while the page counted the hours since the tab closed.
			//
			// The cost, stated plainly: work that finished after this tab was
			// closed is not collected. Nothing that was still running can be —
			// it was abandoned hours before the ceiling — but a clip that
			// landed and was never posted stays uncollected until the run is
			// started again.
			if (!staleRun) startPolling();
		return true;
	}

	onMount(() => {
		try {
			const saved = localStorage.getItem(NAV_KEY);
			// Open on a desktop by default, shut on a phone, where the transcript
			// is the page and a rail would take a third of it.
			sidebarOpen = saved === null ? window.innerWidth >= 1024 : saved === '1';
		} catch {
			sidebarOpen = window.innerWidth >= 1024;
		}

		// Staged references survive a reload — they live on the server, not in
		// this tab — so the composer has to ask for them rather than assume none.
		void loadRefFiles();
		void loadHistory();
		void loadVerdicts();
		// Sheets live on the server too, and outlast every run — the picker has to
		// ask rather than assume this tab has seen them before.
		// Unconditionally, not only when something is still rendering. A turnaround
		// that finished while this tab was closed is the case that kept losing its
		// cards, and by definition nothing is rendering by the time you come back.
		// One poll, four seconds in; it stops itself if there is nothing to wait for.
		void loadSheets().then(() => watchSheets());
		// How long a clip takes, read now rather than when one starts.
		//
		// It used to be read only from startPolling, which is fine for the line
		// that appears during a render — but the button that spends the money is
		// on screen long before that, and it was offering a wait with no number
		// beside it. Reading it here costs one localStorage lookup on mount.
		refreshClipEstimate();
		try {
			const raw = localStorage.getItem(SETUP_KEY);
			if (raw) {
				const v = JSON.parse(raw) as {
					s?: number;
					o?: string;
					r?: string;
					t?: string;
					c?: string;
					l?: string;
					k?: number;
					kk?: number;
				};
				if (typeof v.s === 'number' && v.s >= 4 && v.s <= 15) wantSeconds = v.s;
				if (v.o === 'portrait' || v.o === 'landscape') wantOrientation = v.o;
				if (v.r && v.r in RESOLUTIONS) wantRes = v.r as ResKey;
				if (v.t === 'clip' || v.t === 'character' || v.t === 'location') wantTarget = v.t;
				if (typeof v.c === 'string') wantCharacter = v.c;
				if (typeof v.l === 'string') wantLocation = v.l;
				if (typeof v.k === 'number' && v.k >= 1 && v.k <= 4) takes = Math.round(v.k);
				if (typeof v.kk === 'number' && v.kk >= 1 && v.kk <= 4) angles = Math.round(v.kk);
				if (takes * angles > 4) angles = 1;
			}
		} catch {
			/* a preference that will not load is not worth an error */
		}

		// A run left behind by a reload picks up where it was: the run identity is
		// restored and the poller re-attaches. Document and clip items rebuild
		// themselves from poll state; the conversation itself is not replayed.
		// Before anything is written to the transcript: the greeting, the composer
		// and the rail all read it.
		try {
			const saved = localStorage.getItem(MODE_KEY);
			if (saved === 'simple' || saved === 'advanced') mode = saved;
		} catch {
			/* default stands */
		}

		// Continuations saved their conversation under `cont-xxx-cont`, because the
		// slug derivation did not strip the `-cont` suffix that the workspace ids
		// had grown — see WS_SUFFIX. The sidebar files those runs under `cont-xxx`
		// and so could never find them. The snapshots are still there and still
		// good, so bring them to the name they should have had.
		//
		// Copied rather than moved, and never over an existing one: this runs on a
		// user's only copy of conversations that cannot be regenerated.
		try {
			for (const k of Object.keys(localStorage)) {
				const m = /^auteur-studio-run-(.+)-cont$/.exec(k);
				if (!m) continue;
				const right = runKey(m[1]);
				if (localStorage.getItem(right)) continue;
				const body = localStorage.getItem(k);
				if (body) localStorage.setItem(right, body);
			}
		} catch {
			/* a full quota or private mode — the orphans stay orphans, nothing is lost */
		}

		const pointer = localStorage.getItem(POINTER_KEY);
		if (
			!resumeFrom(
				(pointer && localStorage.getItem(runKey(pointer))) ??
					localStorage.getItem(RESUME_KEY) ??
					sessionStorage.getItem(RESUME_KEY)
			)
		) {
			showWelcome();
		}

		// After the restore, not before it. A character preview runs server-side
		// for about two minutes, and this re-enters the poll for any card still
		// waiting on one — but the cards only exist once resumeFrom has put the
		// conversation back, so called any earlier it reads an empty list and
		// quietly does nothing, which is the failure that looks like a fix.
		resumePreviews();
		// And any takes still rendering. They run server-side, so this tab simply
		// has to ask — the same reason the sheet watcher starts unconditionally.
		watchBatches();
		// The film is not part of this conversation, so it is not in the snapshot
		// the restore just replayed. It is asked for once, here, and is the same
		// film in every production and every browser.
		void (async () => {
			try {
				const r = (await (await fetch('/studio/api/film')).json()) as { clips?: FilmClip[] };
				if (Array.isArray(r.clips)) film = r.clips;
			} catch {
				/* a film that will not load is not a reason to fail the studio */
			}
		})();

		// Elapsed time is shown in whole minutes, so a 15s clock is plenty.
		const clock = setInterval(() => (now = Date.now()), 15_000);
		// Except while something is being drawn, where a counter is on screen and a
		// number that moves once a quarter of a minute reads as a frozen page.
		const fast = setInterval(() => {
			if (sheetsWorking) now = Date.now();
		}, 1_000);
		return () => {
			clearInterval(clock);
			clearInterval(fast);
			stopPolling();
		};
	});
</script>

<svelte:head>
	<title>studio · auteur</title>
</svelte:head>

{#snippet statusPill(status: RailStatus)}
	<span
		class="shrink-0 rounded-md px-2 py-0.5 text-[10px] tracking-wide
			{status === 'running' ? 'bg-[var(--st-surface-2)] font-semibold text-[var(--st-text)]' : ''}
			{status === 'done' ? 'bg-[var(--st-surface-2)] text-[var(--st-muted)]' : ''}
			{status === 'failed' ? 'bg-[#5c2f24] text-[#f2d7cd]' : ''}
			{status === 'regen' ? 'bg-[var(--st-surface-2)] text-[var(--st-text)]' : ''}
			{status === 'pending' ? 'text-[var(--st-faint)]' : ''}"
	>
		{STATUS_LABEL[status]}
	</span>
{/snippet}

{#snippet railList()}
	{#if offline || lastError}
		<div class="mb-3 rounded-xl bg-[var(--st-surface-2)] px-3 py-2">
			<p class="text-xs leading-relaxed text-[var(--st-muted)]">
				{offline ? 'The harness is not responding — showing the last known state.' : 'Error from the harness — showing the last known state.'}
			</p>
		</div>
	{/if}
	<ol class="space-y-1.5">
		{#each rail as e (e.id)}
			<li class="flex items-center justify-between gap-3">
				<span
					class="min-w-0 truncate text-[13px] {e.status === 'pending'
						? 'text-[var(--st-faint)]'
						: 'text-[var(--st-text)]'}"
				>
					{e.label}
				</span>
				{@render statusPill(e.status)}
			</li>
		{/each}
	</ol>
	<div class="mt-4">
		<button
			type="button"
			class="cursor-pointer text-xs text-[var(--st-faint)] underline-offset-4 hover:text-[var(--st-muted)] hover:underline"
			onclick={() => (showDetails = !showDetails)}
		>
			{showDetails ? 'hide details' : 'details'}
		</button>
		{#if showDetails}
			<div class="mt-2 space-y-1 font-mono text-[10px] leading-relaxed text-[var(--st-faint)]">
				{#if planningWs}<p class="break-all">plan: {planningWs}</p>{/if}
				{#if renderWs}<p class="break-all">shoot: {renderWs}</p>{/if}
				{#if lastTick}<p>last update: {lastTick.toLocaleTimeString('en-GB')}</p>{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet document(blocks: Block[])}
	<div class="space-y-3.5 text-[0.95rem] leading-[1.7] text-[var(--st-text)]">
		{#each blocks as b, i (i)}
			{#if b.kind === 'heading'}
				<h4
					class="font-display font-semibold {b.level === 1
						? 'text-base'
						: 'text-sm'} {i > 0 ? 'pt-2' : ''}"
				>
					{b.text}
				</h4>
			{:else if b.kind === 'para'}
				<p>{#each b.spans as s, j (j)}{#if s.bold}<strong class="font-semibold"
								>{s.text}</strong
							>{:else if s.italic}<em>{s.text}</em>{:else}{s.text}{/if}{/each}</p>
			{:else if b.kind === 'list'}
				<ul class="space-y-1.5 pl-4">
					{#each b.items as item, j (j)}
						<li class="list-disc">
							{#each item as s, k (k)}{#if s.bold}<strong class="font-semibold">{s.text}</strong
								>{:else if s.italic}<em>{s.text}</em>{:else}{s.text}{/if}{/each}
						</li>
					{/each}
				</ul>
			{:else if b.kind === 'table'}
				<!-- Wide tables scroll inside their own card rather than pushing the
					 whole column sideways. -->
				<div class="scroller -mx-1 overflow-x-auto px-1">
					<table class="w-full min-w-[34rem] border-collapse text-sm">
						<thead>
							<tr>
								{#each b.head as h (h)}
									<th
										class="border-b border-[var(--st-line)] px-2.5 py-2 text-left text-xs font-semibold tracking-wide text-[var(--st-muted)] uppercase"
									>
										{h}
									</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each b.rows as row, r (r)}
								<tr class="align-top">
									{#each row as cell, c (c)}
										<td
											class="border-b border-[var(--st-line)] px-2.5 py-2.5 {c === 0
												? 'font-semibold whitespace-nowrap'
												: ''}"
										>
											{cell}
										</td>
									{/each}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else if b.kind === 'rule'}
				<hr class="border-[var(--st-line)]" />
			{:else if b.kind === 'slug'}
				<p class="pt-3 font-mono text-xs font-semibold tracking-widest text-[var(--st-muted)] uppercase">
					{b.text}
				</p>
			{:else if b.kind === 'transition'}
				<p class="text-right font-mono text-xs tracking-widest text-[var(--st-faint)] uppercase">
					{b.text}
				</p>
			{:else if b.kind === 'cue'}
				<!-- Dialogue indented the way a script page does it: the eye finds who
					 is speaking without reading the line. -->
				<div class="pl-6 sm:pl-12">
					<p class="font-mono text-xs font-semibold tracking-wider">
						{b.who}{#if b.parenthetical}<span class="font-normal text-[var(--st-muted)]">
								({b.parenthetical})</span
							>{/if}
					</p>
					{#each b.lines as l, j (j)}
						<p class="text-[0.95rem]">{l}</p>
					{/each}
				</div>
			{:else if b.kind === 'anchor'}
				<!-- An anchor is pasted verbatim into every render prompt, so it is
					 shown as the quotable unit it is, not as prose. -->
				<div class="rounded-xl bg-[var(--st-surface-2)] px-3.5 py-3">
					<p class="text-[10px] font-semibold tracking-[0.18em] text-[var(--st-faint)] uppercase">
						{b.label}
					</p>
					<p class="mt-1.5 text-[0.9rem] leading-relaxed">{b.text}</p>
				</div>
			{/if}
		{/each}
	</div>
{/snippet}

{#snippet videoCard(name: string, url: string, caption: string, clipKey = '')}
	<!-- No surface and no rounding of its own. The caller wraps this together with
	     the action band in one rounded card: the picture and what you can do with
	     it are one object, and drawing them as two blocks with the page's black
	     between them said they were not. -->
	<figure class="contents">
		<!-- The app-wide CSS in layout.css hides every native media control on
		     <video> unless the element opts in with .video-with-controls. -->
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			src={url}
			controls
			playsinline
			preload="metadata"
			data-clip={clipKey || null}
			crossorigin="anonymous"
			onerror={(e) => recoverVideo(e.currentTarget as HTMLVideoElement, url)}
			class="video-with-controls block aspect-video w-full bg-black"
		></video>
		{#if caption}
			<figcaption class="px-4 pt-3 text-sm text-[var(--st-muted)]">{caption}</figcaption>
		{/if}
	</figure>
{/snippet}

<!-- One take, at whatever size the grid it sits in gives it. The same tile
	 serves the strip in the transcript and the filmstrip inside the viewer, so
	 the two can never drift apart — pressing one in the strip opens the viewer
	 on exactly the picture that was pressed.

	 A run still on the GPU keeps its place and its number rather than being left
	 out: the strip is then its final shape from the first second, and nothing
	 moves under the cursor as the takes land. -->
{#snippet takeTile(
	item: ChatItem,
	run: NonNullable<ChatItem['takes']>['runs'][number],
	film = false
)}
	{@const chosen = film && takesAt?.index === run.index}
	{#if run.state === 'ready' && run.clip}
		<button
			type="button"
			aria-label="take {run.index}"
			aria-current={film ? chosen : undefined}
			onclick={(e) => openTake(item.id, run.index, e.currentTarget)}
			class="relative block aspect-video w-full cursor-pointer overflow-hidden rounded-[10px] bg-[var(--st-surface)] transition-[transform,opacity] duration-200 hover:scale-[1.014] {film
				? chosen
					? 'opacity-100 shadow-[inset_0_0_0_2px_var(--st-text)]'
					: 'opacity-50 hover:opacity-80'
				: ''}"
		>
			<!-- svelte-ignore a11y_media_has_caption -->
			<video
				src={fileUrl(run.clip.workspace, run.clip.artifact, run.clip.file)}
				muted
				loop
				playsinline
				preload="auto"
				use:looping
				class="h-full w-full bg-black object-cover"
			></video>
			<span
				class="pointer-events-none absolute bottom-1.5 left-1.5 rounded-[5px] px-1.5 py-px text-[11px] font-medium tabular-nums backdrop-blur-md {chosen
					? 'bg-[var(--st-text)] text-black'
					: 'bg-black/50 text-white'}"
			>
				{run.index}
			</span>
		</button>
	{:else}
		<div
			class="st-slot relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-[10px] bg-[var(--st-surface)] {run.state ===
			'rendering'
				? 'st-waiting'
				: ''}"
		>
			{#if run.state === 'failed'}
				<!-- The word, not the reason: the tile is 175px across and the reason
					 is a sentence. It goes on the card's own line underneath. -->
				<span class="px-2 text-center text-[11px] text-[var(--st-faint)]">interrupted</span>
			{/if}
			<span
				class="pointer-events-none absolute bottom-1.5 left-1.5 rounded-[5px] bg-black/50 px-1.5 py-px text-[11px] font-medium tabular-nums text-white backdrop-blur-md"
			>
				{run.index}
			</span>
		</div>
	{/if}
{/snippet}

<!-- Escape closes the composer's menus. A click outside them is handled by the
	 backdrop the menus render behind themselves, not from here: Svelte delegates
	 element handlers to the root, so a window-level listener and a
	 stopPropagation in a delegated handler do not reliably compose. -->
<!-- The takes viewer takes the keyboard first while it is open: it covers the
	 page, so Escape belongs to it and not to menus nobody can see. -->
<svelte:window
	onkeydown={(e) => {
		if (filmAt !== null) {
			if (e.key === 'Escape') shutFilmViewer();
			else if (e.key === 'ArrowLeft') stepFilm(-1);
			else if (e.key === 'ArrowRight') stepFilm(1);
			return;
		}
		if (takesAt) {
			if (e.key === 'Escape') shutTake();
			else if (e.key === 'ArrowLeft') stepTake(-1);
			else if (e.key === 'ArrowRight') stepTake(1);
			return;
		}
		if (e.key === 'Escape') shutMenus();
	}}
/>

<!-- Chat-app shell: the page itself never scrolls. The window is split into a
	 fixed header, a scrolling transcript and a pinned composer, so the input and
	 the task rail stay put while only the conversation moves — the layout every
	 chat client converges on. 100dvh (not vh) keeps it correct on mobile Safari,
	 where the URL bar changes the viewport height mid-scroll. -->
<div class="studio flex h-[100dvh] overflow-hidden">
	<!-- ── past productions ────────────────────────────────────────────────────
	     Off-canvas below lg, because the transcript is the page on a phone and a
	     permanent rail would take a third of it. Above lg it is simply there:
	     going back to a run should not cost a click to reveal the way back. -->
	{#if sidebarOpen}
		<button
			type="button"
			aria-label="close the production list"
			class="fixed inset-0 z-30 cursor-default bg-black/50 lg:hidden"
			onclick={() => setNavOpen(false)}
		></button>
	{/if}

	<aside
		class="fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-[var(--st-line)] bg-[var(--st-bg)] transition-transform lg:static lg:z-auto {sidebarOpen
			? 'translate-x-0 lg:translate-x-0'
			: '-translate-x-full lg:hidden'}"
	>
		<!-- The control that closes the rail sits in the rail, at the same point on
			 the screen it occupies when the rail is shut. It never appears to move;
			 the panel slides out from under it. Putting it in the main header only
			 meant the button and the thing it opened were in two different places. -->
		<div class="flex h-12 shrink-0 items-center gap-2.5 px-3">
			<button
				type="button"
				aria-label="hide past productions"
				aria-expanded="true"
				onclick={() => setNavOpen(false)}
				class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--st-muted)] transition-colors hover:bg-[var(--st-surface)] hover:text-[var(--st-text)]"
			>
<!-- Three rules, the last one short. It reads as a list that can be
	 pulled open rather than as a menu, and the ragged end keeps it from
	 sitting like a block of three identical bars. -->
<svg viewBox="0 0 16 16" class="size-[18px]" fill="none" aria-hidden="true">
	<path d="M2.5 4h11M2.5 8h11M2.5 12h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
</svg>
			</button>
			<h1 class="font-display truncate text-[1.0625rem] font-semibold tracking-[-0.02em]">Auteur</h1>
		</div>

		<div class="px-3 pt-2 pb-2">
			<button
				type="button"
				onclick={() => {
					reset();
					if (window.innerWidth < 1024) setNavOpen(false);
				}}
				class="flex min-h-10 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-sm text-[var(--st-text)] transition-colors hover:bg-[var(--st-surface)]"
			>
				<svg viewBox="0 0 16 16" class="size-4 shrink-0 text-[var(--st-muted)]" fill="none" aria-hidden="true">
					<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
				</svg>
				<span>New production</span>
			</button>
		</div>

		<nav class="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
			{#if historyDays.length}
				<!-- The day is a heading, not a word repeated on every row. Twelve runs
					 in one afternoon printed "today" twelve times and said nothing. -->
				{#each historyDays as day (day.label)}
					<p
						class="px-3 pt-4 pb-1.5 font-mono text-[0.7rem] font-medium tracking-[0.13em] text-[var(--st-faint)] uppercase"
					>
						{day.label}
					</p>
					{#each day.items as p (p.slug)}
						<!-- `brief` is null for every one-clip run, so this was dead-false on
							 all of them and reopening one looked like nothing had happened.
							 runSlug is the same value the row is filed under. -->
						{@const current = (runSlug || brief?.slug) === p.slug}
						{@const kind = runKind(p)}
						<!-- Only ever the run this tab is watching. Whether some other run is
							 working is not knowable from here without polling sixty
							 workspaces, and a dot that is sometimes right is worse than no
							 dot at all.

							 A sheet counts as work even though nothing here polls for it: the
							 turnaround behind an upload runs server-side, so the render poller
							 is idle for its whole six minutes and the row sat dark while a GPU
							 was busy. -->
						{@const working = current && !staleRun && pollingActive}
						<!-- A character being drawn is knowable for every row, not just this
							 one: the sheet carries the session it was started in, so the
							 sidebar can say which conversation the GPU is busy for even while
							 you are reading a different one. Green rather than the accent,
							 because it is the only mark here that survives leaving the room —
							 and it ends on a state worth walking back for. -->
						{@const drawing = sessionsDrawing.has(p.slug)}
						{@const finished = sessionsDone.has(p.slug)}
						<div class="group relative">
							<button
								type="button"
								onclick={() => reopen(p)}
								class="w-full cursor-pointer rounded-xl py-2 pr-9 pl-3 text-left transition-colors {current
									? 'bg-[var(--st-surface)]'
									: 'hover:bg-[var(--st-surface)]'}"
							>
								<span class="flex items-center gap-2">
									{#if drawing}
										<span
											class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-green)]"
											title="a character is being drawn here"
										></span>
										<span class="sr-only">a character is being drawn here</span>
									{:else if finished}
										<!-- Steady, not pulsing. The pulse means "wait"; this means
											 "it is here" — the same colour arriving at rest, which is
											 the whole of what changed. -->
										<span
											class="size-1.5 shrink-0 rounded-full bg-[var(--st-green)]"
											title="a character is ready here"
										></span>
										<span class="sr-only">a character is ready here</span>
									{:else if working}
										<span
											class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-accent)]"
											aria-hidden="true"
										></span>
									{/if}
									<span class="min-w-0 flex-1 truncate text-sm text-[var(--st-text)]">{p.title}</span>
								</span>
								<!-- Only what is true and only where it adds something. A clip's
									 title is the prompt, so a second line under it would be filler;
									 a film has a scene count, which is the one number that says how
									 big the thing is. -->
								<!-- No clock here.
									 It used to show the elapsed time, on the argument that a moving
									 number proves the page is alive where a static label does not.
									 That was written when a row was one render. A row is a session
									 now, and the number became "how long you have been sitting here"
									 — which nobody asked to be told, and which reads as pressure
									 rather than progress. The pulsing dot says the same thing
									 without the running total, and the clip card still carries the
									 render's own timing where it means something. -->
								{#if drawing}
									{@const sh = sheets.find(
										(x) => x.sessionSlug === p.slug && x.sheet?.state === 'rendering'
									)}
									<!-- Not the name: the row above it is the name, and a session is
										 usually one subject. What the second line is for is the part the
										 title cannot say — what is being made and how long is left. -->
									<span class="mt-0.5 block text-xs text-[var(--st-muted)]">
										Drawing the six views · {turnStatus(sh)}
									</span>
								{:else if working && railRunning}
									<span class="mt-0.5 block text-xs text-[var(--st-muted)]">
										{friendly(railRunning.label)}
									</span>
								{:else if kind === 'film'}
									<span class="mt-0.5 block text-xs text-[var(--st-faint)]">
										{p.sceneCount} scene{p.sceneCount === 1 ? '' : 's'}{p.renderWs ? ' · shot' : ' · planning'}
									</span>
								{/if}
							</button>
							<button
								type="button"
								aria-label="remove {p.title} from the list"
								onclick={(e) => dropFromHistory(p, e)}
								class="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-lg text-[var(--st-faint)] opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-[var(--st-surface-2)] hover:text-[var(--st-text)] focus-visible:opacity-100"
							>
								×
							</button>
						</div>
					{/each}
				{/each}
			{:else}
				<p class="px-3 pt-4 text-xs leading-relaxed text-[var(--st-faint)]">
					Films you start show up here, so you can come back to one after closing the tab.
				</p>
			{/if}
		</nav>

		<!-- Cast & sets used to sit here, which put a management panel — rename,
		     retry, delete — inside a list whose job is navigation. It moved to
		     /studio/admin/cast, beside the workflows and the skills, which is
		     where the local library already lives. Picking a face for the next
		     clip never happened here anyway; that is the composer's own picker.

		     Tuning stays at the bottom because it is a settings surface rather
		     than a destination — the same place every app of this shape puts one. -->
		<div class="px-3 pt-1 pb-3 {sheets.length ? '' : 'border-t border-[var(--st-line)]'}">
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a
				href="/studio/admin"
				class="flex min-h-10 cursor-pointer items-center gap-3 rounded-xl px-3 text-sm text-[var(--st-muted)] transition-colors hover:bg-[var(--st-surface)] hover:text-[var(--st-text)]"
			>
				<svg viewBox="0 0 16 16" class="size-4 shrink-0" fill="none" aria-hidden="true">
					<path d="M3 5h10M3 11h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
					<circle cx="6" cy="5" r="1.8" fill="var(--st-bg)" stroke="currentColor" stroke-width="1.5" />
					<circle cx="10.5" cy="11" r="1.8" fill="var(--st-bg)" stroke="currentColor" stroke-width="1.5" />
				</svg>
				Prompts &amp; models
			</a>
		</div>
	</aside>

	<!-- The rail takes 256px off the left when it opens. Matching that with an
		 equal phantom margin on the right keeps the reading column's centre on the
		 screen's centre in both states, so opening the rail moves nothing — on a
		 desktop the two never meet anyway, and a page that jumps sideways when you
		 reveal a list is a page that punishes you for looking. Below lg the rail is
		 an overlay and takes no width, so no compensation is owed. -->
	<main class="relative flex min-w-0 flex-1 flex-col overflow-hidden">
		<!-- Pinned to the page's left edge, not to the centre column: this is the
			 same point the rail's own toggle occupies, so the control stays put and
			 the panel slides out from under it. Inside the centred wrapper it sat a
			 hundred and twenty pixels in, and the rail then opened from somewhere
			 else entirely — the button and the thing it opened in two places. -->
		<header class="flex h-12 shrink-0 items-center gap-2.5 px-3">
				{#if !sidebarOpen}
					<button
						type="button"
						aria-label="show past productions"
						aria-expanded="false"
						class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--st-muted)] transition-colors hover:bg-[var(--st-surface)] hover:text-[var(--st-text)]"
						onclick={() => setNavOpen(true)}
					>
<!-- Three rules, the last one short. It reads as a list that can be
	 pulled open rather than as a menu, and the ragged end keeps it from
	 sitting like a block of three identical bars. -->
<svg viewBox="0 0 16 16" class="size-[18px]" fill="none" aria-hidden="true">
	<path d="M2.5 4h11M2.5 8h11M2.5 12h7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
</svg>
					</button>
					<!-- The product's name, at a size a name is set at. It was ten pixels
						 of letterspaced caps in the faintest colour on the page — the least
						 legible text in the app was the thing it is called. -->
					<h1 class="font-display text-[1.0625rem] font-semibold tracking-[-0.02em]">Auteur</h1>
				{/if}
		</header>

		<!-- 66rem only when the task rail is beside it and needs the room. On its
			 own a reading column that wide is not a measure, it is a stretch: the
			 composer became a thousand pixels of single line and the eye had to
			 travel the width of the screen to find the send button. -->
		<div
			class="mx-auto flex min-h-0 w-full flex-1 flex-col px-5 pt-1 {brief
				? 'max-w-[66rem]'
				: 'max-w-[48rem]'}"
		>

		<!-- Two columns only when there is a second column to put something in.
			 The task rail below is behind an if, but the grid reserved its 16rem
			 and the 40px gap unconditionally — so with no production running the
			 page held 296px of nothing on the right and pushed the reading column
			 148px left of centre. That was the centring that would not come right,
			 and it was never the sidebar. -->
		<div
			class="flex min-h-0 flex-1 flex-col {brief
				? 'lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-10'
				: ''}"
		>
			<!-- ── chat column ─────────────────────────────────────────────── -->
			<!-- min-h-0 is load-bearing: without it a flex child refuses to shrink
				 below its content and the inner overflow-y-auto never engages. -->
			<div class="flex min-h-0 min-w-0 flex-1 flex-col">
				<!-- Mobile: the rail collapses into a slim strip above the chat. -->
				{#if brief}
					<div class="mb-5 lg:hidden">
						<button
							type="button"
							class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-2xl bg-[var(--st-surface)] px-4 py-3 text-left"
							onclick={() => (railOpen = !railOpen)}
						>
							<span class="min-w-0 truncate text-xs text-[var(--st-muted)]">{railSummary}</span>
							<span class="shrink-0 text-xs text-[var(--st-faint)]">
								{railOpen ? 'hide' : 'progress'}
							</span>
						</button>
						{#if railOpen}
							<div class="enter mt-2 rounded-2xl bg-[var(--st-surface)] p-4">
								{@render railList()}
							</div>
						{/if}
					</div>
				{/if}

				<!-- ── the transcript — the only scrolling region on the page ── -->
				<!-- Empty state centres its own content: a welcome line pinned to the
					 top of a tall blank column reads as a page that failed to load.
					 Once the transcript has real messages it goes back to flowing from
					 the top, which is what a conversation wants. -->
				<div
					bind:this={scrollEl}
					onscroll={onTranscriptScroll}
					class="scroller min-h-0 flex-1 space-y-5 overflow-y-auto px-1 pb-2 {showExamples
						? 'flex flex-col justify-center'
						: ''}"
				>
					{#each chat as item, itemAt (item.id)}
						{#if superseded[item.id]}
							<p class="text-xs text-[var(--st-faint)]">
								earlier version
								{#if item.kind === 'plan' && item.plan}
									· {item.plan.title}
								{:else if item.kind === 'artifact' && item.artifact}
									· {item.artifact.title}
								{/if}
							</p>
						{:else if item.who === 'user'}
							<div class="flex justify-end">
								<p
									class="enter doc max-w-[85%] rounded-2xl rounded-br-md bg-[var(--st-surface-2)] px-4 py-2.5 text-[0.95rem] leading-relaxed"
								>
									{item.text}
								</p>
							</div>
						{:else if item.kind === 'text' && item.id === welcomeId && !showExamples}
							<!-- Nothing. The greeting is the empty page's, and once you have said
								 something the page is not empty — leaving it there turns a headline
								 into the first line of the transcript, which it never was. It stays
								 in `chat` so reset() and the restore path are untouched. -->
						{:else if item.kind === 'text' && item.id === welcomeId && showExamples}
							<!-- The greeting is the page, not a message in it. Short enough to
								 set at display size, so it gets one. -->
							<h2
								class="font-display enter mx-auto max-w-[26rem] text-center text-[clamp(2.25rem,6vw,3.25rem)] leading-[1.06] font-semibold tracking-[-0.042em] text-balance"
							>
								{#each WELCOME_LINES as line, i (line)}
									{line}{#if i === 0}<br />{/if}
								{/each}
							</h2>
						{:else if item.kind === 'text'}
							<div class="enter">
								<p class="doc text-[0.95rem] leading-[1.75] text-[var(--st-text)]">{item.text}</p>
							</div>
						{:else if item.kind === 'board'}
							<article class="enter rounded-2xl bg-[var(--st-surface)] p-5 sm:p-6">
								<div class="mb-4 flex items-baseline justify-between gap-3">
									<h3 class="font-display text-base font-semibold">The plan</h3>
									<span class="font-mono text-[11px] text-[var(--st-faint)]">
										{boardDone} of {board.length}
									</span>
								</div>

								<div class="divide-y divide-[var(--st-surface-2)]">
									{#each board as row (row.key)}
										<div class="py-3 first:pt-0 last:pb-0">
											<div class="flex items-center gap-3">
												<!-- State reads without colour too: a spinner spins, a
												     check is a check. Colour alone would fail anyone who
												     cannot separate the green from the grey. -->
												<span class="flex size-4 shrink-0 items-center justify-center">
													{#if row.state === 'done'}
														<svg viewBox="0 0 16 16" class="size-4 text-[#5b8f6e]" fill="none" aria-hidden="true">
															<path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
														</svg>
													{:else if row.state === 'writing' || row.state === 'rewriting'}
														<span class="spin size-3.5 rounded-full border-2 border-[var(--st-surface-2)] border-t-[var(--st-accent)]"></span>
													{:else if row.state === 'failed'}
														<svg viewBox="0 0 16 16" class="size-4 text-[#c4614b]" fill="none" aria-hidden="true">
															<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
														</svg>
													{:else}
														<span class="size-1.5 rounded-full bg-[var(--st-faint)]"></span>
													{/if}
												</span>

												<span
													class="font-display flex-1 text-sm font-semibold {row.state === 'waiting'
														? 'text-[var(--st-faint)]'
														: 'text-[var(--st-text)]'}"
												>
													{row.label}
												</span>

												{#if row.state === 'done'}
													<button
														type="button"
														class="cursor-pointer text-xs text-[var(--st-muted)] underline-offset-4 transition-colors hover:text-[var(--st-text)] hover:underline"
														onclick={() => (expanded[row.key] = !expanded[row.key])}
													>
														{expanded[row.key] ? 'close' : 'read'}
													</button>
												{:else if row.state === 'rewriting'}
													<span class="text-xs text-[var(--st-faint)]">rewriting</span>
												{:else if row.state === 'writing'}
													<span class="text-xs text-[var(--st-faint)]">writing…</span>
												{:else if row.state === 'failed'}
													<span class="text-xs text-[var(--st-muted)]">stalled</span>
												{/if}
											</div>

											{#if row.state === 'done' && expanded[row.key]}
												<div class="mt-3 border-l border-[var(--st-surface-2)] pl-4">
													{#if row.body}
														{@render document(renderDocument(row.file ?? '', row.body))}
													{:else if row.url}
														<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
														<a href={row.url} class="text-xs text-[var(--st-muted)] underline" download>
															download the file
														</a>
													{/if}

													<div class="mt-4 flex flex-wrap items-center gap-2">
														<button
															type="button"
															onclick={() => (changeOpen[row.key] = !changeOpen[row.key])}
															class="btn btn-secondary btn-sm"
														>
															request a change
														</button>
														<!-- The way out, next to the way in. A document runs to several
														     screens, and without this the only way to close one was to
														     scroll back up to the row that opened it. -->
														<button
															type="button"
															onclick={() => (expanded[row.key] = false)}
															class="cursor-pointer rounded-full px-3.5 py-2 text-xs text-[var(--st-faint)] transition-colors hover:text-[var(--st-text)]"
														>
															close
														</button>
													</div>
													<div>
														{#if changeOpen[row.key]}
															<form
																class="mt-3 flex gap-2"
																onsubmit={(e) => {
																	e.preventDefault();
																	requestChange(row.key, row.key);
																}}
															>
																<label class="sr-only" for="change-{row.key}">What should change</label>
																<input
																	id="change-{row.key}"
																	bind:value={changeText[row.key]}
																	placeholder="what should change in this document"
																	class="min-w-0 flex-1 rounded-xl border border-[var(--st-line)] bg-[var(--st-bg)] px-3.5 py-2.5 text-sm outline-none placeholder:text-[var(--st-faint)] focus:border-[var(--st-muted)]"
																/>
																<button
																	type="submit"
																	disabled={changeBusy[row.key] || !(changeText[row.key] ?? '').trim()}
																	class="btn btn-primary"
																>
																	send
																</button>
															</form>
															<p class="mt-2 text-xs text-[var(--st-faint)]">
																This step is rewritten, and everything built on it is refreshed after it.
															</p>
														{/if}
													</div>
												</div>
											{/if}
										</div>
									{/each}
								</div>

								<!-- The button belongs to the thing it acts on. It is present from
								     the start, disabled, so the shape of the run is visible before
								     any of it has happened — and so nobody hunts for it once the
								     last document lands. -->
								{#if renderWs}
									<p class="mt-5 text-xs text-[var(--st-faint)]">shooting has started</p>
								{:else}
									<div class="mt-5 flex flex-wrap items-center gap-3">
										<button
											type="button"
											disabled={boardDone < board.length || renderLaunching || !!chain}
											onclick={launchRender}
											class="btn btn-primary"
										>
											{renderLaunching ? 'starting…' : 'start shooting'}
										</button>
										<span class="text-xs text-[var(--st-faint)]">
											{#if chain}
												a document is being rewritten
											{:else if boardDone < board.length}
												ready when all five are written
											{:else}
												uses GPU time and costs money
											{/if}
										</span>
									</div>
								{/if}
							</article>
						{:else if item.kind === 'shootboard'}
							<article class="enter rounded-2xl bg-[var(--st-surface)] p-5 sm:p-6">
								<div class="mb-1 flex items-baseline justify-between gap-3">
									<h3 class="font-display text-base font-semibold">Shooting</h3>
									{#if !staleRun}
										<!-- Dropped rather than frozen on a stale run: we know the
											 shoot is over, but not when it ended, and a stopped clock
											 showing a number we made up is worse than no clock. -->
										<span class="font-mono text-[11px] text-[var(--st-faint)] tabular-nums">
											{mmss(shootElapsed)}
										</span>
									{/if}
								</div>
								<p class="mb-4 text-xs leading-relaxed text-[var(--st-muted)]">
									Each scene is written into a prompt, then rendered on a GPU. A clip usually
									takes several minutes and there is no output until it is finished{#if !staleRun} —
										the timer is the only thing that moves{/if}.
								</p>

								{#if shootBoard.length}
									<div class="divide-y divide-[var(--st-surface-2)]">
										{#each shootBoard as row (row.n)}
											<div class="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
												<span class="flex size-4 shrink-0 items-center justify-center">
													{#if row.state === 'done'}
														<svg viewBox="0 0 16 16" class="size-4 text-[#5b8f6e]" fill="none" aria-hidden="true">
															<path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
														</svg>
													{:else if row.state === 'failed'}
														<svg viewBox="0 0 16 16" class="size-4 text-[#c4614b]" fill="none" aria-hidden="true">
															<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
														</svg>
													{:else}
														<span class="spin size-3.5 rounded-full border-2 border-[var(--st-surface-2)] border-t-[var(--st-accent)]"></span>
													{/if}
												</span>
												<span class="min-w-0 flex-1 truncate text-sm">{row.title}</span>
												<span class="shrink-0 text-xs text-[var(--st-faint)]">
													{#if row.state === 'done'}
														ready
													{:else if row.state === 'failed'}
														stalled
													{:else if row.retries >= 3}
														<span class="text-[var(--st-muted)]">retried {row.retries}×</span>
													{:else}
														rendering
													{/if}
												</span>
											</div>
										{/each}
									</div>
								{:else}
									<p class="text-sm text-[var(--st-faint)]">
										Working out how many scenes to shoot…
									</p>
								{/if}
							</article>
						{:else if item.kind === 'activity' && item.activity}
							<!-- Quiet by design. These are constant during a run, and a
							     progress line that shouts competes with the documents the
							     user is actually here to read. Trouble is the exception:
							     a rejection or a failure gets colour, because that is the
							     one case where not noticing is expensive. -->
							{@const a = item.activity}
							<div class="enter flex items-start gap-2.5 py-0.5">
								<span
									class="mt-[0.45rem] size-1.5 shrink-0 rounded-full {a.tone === 'bad'
										? 'bg-[#c4614b]'
										: a.tone === 'warn'
											? 'bg-[#b98a3e]'
											: a.tone === 'good'
												? 'bg-[#5b8f6e]'
												: 'bg-[var(--st-faint)]'}"
								></span>
								<div class="min-w-0">
									<p
										class="text-[0.82rem] leading-relaxed {a.tone === 'bad' || a.tone === 'warn'
											? 'text-[var(--st-muted)]'
											: 'text-[var(--st-faint)]'}"
									>
										{a.text}
									</p>
									{#if a.detail}
										<details class="mt-0.5">
											<summary
												class="cursor-pointer text-[0.72rem] text-[var(--st-faint)] hover:text-[var(--st-muted)]"
											>
												what it said
											</summary>
											<p
												class="doc mt-1 border-l border-[var(--st-surface-2)] pl-3 font-mono text-[0.72rem] leading-relaxed text-[var(--st-muted)]"
											>
												{a.detail}
											</p>
										</details>
									{/if}
								</div>
							</div>
						{:else if item.kind === 'confirm' && item.confirm}
							<!-- What is about to be shot, in the operator's own language.
							     Deliberately plain: no card chrome, no heading, no label saying
							     what it is. It reads as the studio answering, because that is
							     what it is — and a box around it would make it look like a form
							     to fill in rather than a sentence to agree with.

							     The button only appears on the newest one. An older round is a
							     step in the conversation, not an order you can still place, and
							     two live buttons is two ways to shoot the wrong version. -->
							{@const newest =
								chat.filter((c) => c.kind === 'confirm').at(-1)?.id === item.id}
							<!-- Gone once its clip is on a GPU. It came back reading "start the
							     render" over a render that was already running, and pressing it
							     again wrote a second brief and paid for the same eight seconds
							     twice. A started clip lives on the card below. -->
							{@const started = item.confirm.cardId
								? !!chat.find((x) => x.id === item.confirm?.cardId)?.shot?.launched
								: false}
							{@const parts = splitConfirm(item.confirm.line)}
							<div class="enter">
								<!-- What this paragraph is, and what to do with it.
								     Without it the studio answers a request with three sentences of
								     prose and no frame: it could be a plan, a summary, or something
								     that already happened, and the only clue that a decision is owed
								     is a button below the fold. One line, and only on the round that
								     can still be acted on — repeated over every earlier round it
								     stops being orientation and becomes wallpaper. -->
								{#if newest && !started}
									<p class="mb-1.5 text-xs text-[var(--st-faint)]">
										Ezt fogjuk leforgatni — indítsd el, vagy írj, ha változtatnál.
									</p>
								{/if}
								<p class="doc text-sm leading-relaxed text-[var(--st-text)]">
									{parts.said}{#if item.confirm.streaming && !parts.added}<span
											class="caret"
											aria-hidden="true"></span>{/if}
								</p>
								{#if parts.added}
									<!-- Ours, and it has to look it. Same size, quieter colour: it is
									     not a footnote — it is half of what starts if the button is
									     pressed — but it is an offer, and an offer that looks like a
									     statement is not one. -->
									<p class="doc mt-1.5 text-sm leading-relaxed text-[var(--st-muted)]">
										{parts.added}{#if item.confirm.streaming}<span
												class="caret"
												aria-hidden="true"></span>{/if}
									</p>
								{/if}

								{#if item.confirm.error}
									<p class="mt-2 text-xs leading-relaxed text-[var(--st-faint)]">
										{item.confirm.error}
									</p>
								{/if}

								<!-- The checker had to change the brief, so this is no longer the
								     clip that was agreed to. It says what moved and waits: sending
								     it anyway is a decision, and it is not ours. -->
								{#if item.confirm.fixed?.length}
									<p class="mt-3 text-xs leading-relaxed text-[var(--st-muted)]">
										Írás közben ezt igazítottuk rajta: {item.confirm.fixed.join(' · ')}
									</p>
								{/if}

								{#if newest && !started && !item.confirm.streaming && item.confirm.line.trim()}
									<div class="mt-3.5 flex flex-wrap items-center gap-2.5">
										<button
											type="button"
											disabled={shotBusy[item.id]}
											class="btn btn-primary"
											onclick={() => acceptConfirm(item.id)}
										>
											{#if shotBusy[item.id]}
												indul…
											{:else if item.confirm.fixed?.length}
												mehet így
											{:else}
												Videó generálás indítása
											{/if}
										</button>
										<!-- The cost, next to the thing that spends it. Not a warning —
										     just the two numbers a person wants before they commit. -->
										<span class="text-xs text-[var(--st-faint)]">
											{composerShape.seconds}s{#if typicalClip}&nbsp;·
												{typicalLabel(typicalClip)}{/if}
										</span>
									</div>
								{/if}
							</div>
						{:else if item.kind === 'error'}
							<!-- The card that launched the render this error is about, found by
								 looking back rather than read off the item.
							     Stored at push time it would only ever appear on errors raised
							     after this shipped, and the one on screen when it was asked for was
							     already saved. A rule about what is displayed has to hold for what
							     is on disk — the same lesson the caption taught an hour earlier. -->
							{@const stalled = /^A shooting step stalled/.test(item.text ?? '')}
							{@const src = stalled
								? [...chat.slice(0, itemAt)].reverse().find((c) => c.kind === 'shot' && c.shot?.launched)
								: undefined}
							<div class="enter rounded-2xl bg-[var(--st-surface)] p-4">
								<p class="text-xs font-semibold text-[#f2d7cd]">
									<span class="mr-2 rounded-md bg-[#5c2f24] px-2 py-0.5">error</span>
								</p>
								<p class="doc mt-2 text-sm leading-relaxed text-[var(--st-muted)]">{item.text}</p>
								{#if src}
									<button
										type="button"
										disabled={shotBusy[src.id] || item.retried}
										class="btn btn-secondary btn-sm mt-3"
										onclick={() => retryShot(item.id, src.id)}
										>{shotBusy[src.id]
											? 'starting…'
											: item.retried
												? 'started again'
												: 'try it again'}</button
									>
								{/if}
							</div>
						{:else if item.kind === 'sheet' && item.sheet}
							<article class="enter rounded-2xl bg-[var(--st-surface)] p-5 sm:p-6">
								<div class="mb-3 flex items-baseline justify-between gap-4">
									<h3 class="font-display text-base font-semibold">
										{item.sheet.stage === 'anchor'
											? 'The character'
											: item.sheet.kind === 'character'
												? 'Character sheet'
												: 'Location sheet'}
									</h3>
									<span class="text-xs text-[var(--st-faint)]">
										{item.sheet.uploaded
											? 'your own picture — kept as it is'
											: item.sheet.stage === 'anchor'
												? 'one picture — say what to change, or save it'
												: item.sheet.kind === 'character'
													? 'front · face · profiles · rear · expression'
													: 'six views of the same place'}
									</span>
								</div>

								{#if item.sheet.url}
									<img
										src={item.sheet.url}
										alt={item.sheet.name ?? ''}
										class="w-full rounded-xl bg-[var(--st-bg)]"
									/>
									{#if item.sheet.description}
										<p class="doc mt-3 text-sm leading-relaxed text-[var(--st-muted)]">
											{item.sheet.description}
										</p>
									{/if}
								{:else}
									<!-- The description before it costs anything, editable, for the
										 same reason the shot prompt is: a sheet is rendered once and
										 every clip afterwards is shot against it. -->
									<textarea
										bind:value={item.sheet.description}
										readonly={item.sheet.launched}
										rows="3"
										spellcheck="false"
										class="block w-full resize-y rounded-xl bg-[var(--st-bg)] p-3 font-mono text-[0.8rem] leading-relaxed outline-none focus:ring-0 read-only:text-[var(--st-muted)]"
									></textarea>
									{#if item.sheet.why}
										<p class="mt-2 text-xs text-[var(--st-faint)]">{item.sheet.why}</p>
									{/if}
									<div class="mt-4 flex items-center justify-between gap-3 border-t border-[var(--st-line)] pt-4">
										<p class="text-xs text-[var(--st-faint)]">
											{item.sheet.launched
												? 'Rendering — it appears here when it is done.'
												: 'Six views, about as long as a clip takes.'}
										</p>
										<button
											type="button"
											disabled={item.sheet.launched ||
												sheetBusy[item.id] ||
												!item.sheet.description.trim()}
											onclick={() => renderSheet(item.id)}
											class="btn btn-primary"
										>
											{item.sheet.launched ? 'Rendering…' : 'Render it'}
										</button>
									</div>
								{/if}

								{#if item.sheet.url && item.sheet.stage === 'anchor'}
								<div class="mt-4 border-t border-[var(--st-line)] pt-4">
									{#if item.sheet.id && item.sheet.uploaded}
										{@const kept = sheets.find((x) => x.id === item.sheet?.id)}
										{@const dn =
											keptEdits[item.id]?.name ?? kept?.name ?? item.sheet.name ?? ''}
										<!-- The stored voice, or the one a character made today would have
											 been given. Characters made before that was written have none,
											 and an empty box with grey suggestion text meant the suggestion
											 was never what got rendered — a placeholder looks filled in and
											 is worth nothing. Now it is real text you can edit, and Update
											 is what makes it theirs. -->
										{@const dv = keptEdits[item.id]?.voice ?? kept?.voice ?? DEFAULT_VOICE}
										{@const changed =
											dn.trim() !== (kept?.name ?? '') ||
											dv.trim() !== (kept?.voice ?? DEFAULT_VOICE)}
										<!-- The character is usable the moment the picture lands — the
									 turnaround is an improvement to it, not a condition of it. So
									 the first line is the useful state and the wait is a second,
									 quieter one, rather than the card going silent for three
									 minutes with a sentence in the past tense above it. -->
										<p class="text-sm text-[var(--st-muted)]">
											Ready to use — pick
											<span class="text-[var(--st-text)]">{kept?.name ?? item.sheet.name}</span>
											from
											<span class="text-[var(--st-text)]">+</span> in the box below.
										</p>
												<!-- No progress line here. It is in the strip above the box now,
											 where it stays on screen; a card scrolls away in a minute and
											 took the only sign of a running GPU with it. What stays is the
											 outcome, which the strip cannot report because by then it is
											 gone. -->
												{#if kept?.sheet?.state === 'failed'}
											<p class="mt-2 text-xs text-[var(--st-faint)]">
												The six views could not be drawn. {item.sheet.kind === 'character'
													? 'They are'
													: 'It is'} still usable without them.
											</p>
										{/if}

										<!-- What is worth changing once you can see who they are: what
									 they are called, and how they sound. The voice was reachable
									 only from the composer, which is not where this decision
									 happens. -->
										<div class="mt-4 border-t border-[var(--st-line)] pt-4">
											{#if item.sheet.kind === 'character'}
												<label
													class="block text-xs text-[var(--st-faint)]"
													for="kept-voice-{item.id}"
												>
													How they sound — carried into every clip they are in
												</label>
												<input
													id="kept-voice-{item.id}"
													value={dv}
													oninput={(e) => editKept(item.id, 'voice', e.currentTarget.value)}
													spellcheck="false"
													maxlength="240"
																										class="mt-2 mb-4 w-full rounded-lg bg-[var(--st-bg)] px-3 py-2 text-sm outline-none focus:ring-0"
												/>
											{/if}
											<label
												class="block text-xs text-[var(--st-faint)]"
												for="kept-name-{item.id}"
											>
												{item.sheet.kind === 'character' ? 'Name them' : 'Name it'} — this is what
												the picker will show
											</label>
											<div class="mt-2 flex flex-wrap items-center gap-2">
												<input
													id="kept-name-{item.id}"
													value={dn}
													oninput={(e) => editKept(item.id, 'name', e.currentTarget.value)}
													spellcheck="false"
													class="min-w-0 flex-1 rounded-lg bg-[var(--st-bg)] px-3 py-2 text-sm outline-none focus:ring-0"
												/>
												<!-- Only when there is something to apply. A button that is
											 always lit invites a press that does nothing, and then the
											 one that matters looks the same as the one that did not. -->
												{#if changed}
													<button
														type="button"
														disabled={sheetBusy[item.id] || !dn.trim()}
														onclick={() => updateKept(item.id, item.sheet?.id ?? '', dn, dv)}
														class="btn btn-primary"
														>{sheetBusy[item.id] ? 'Updating…' : 'Update'}</button
													>
												{/if}
												<button
													type="button"
													onclick={() => item.sheet?.id && dropSheet(item.sheet.id)}
													class="btn btn-secondary">Remove</button
												>
											</div>
										</div>
									{:else if item.sheet.id}
										{@const kept = sheets.find((x) => x.id === item.sheet?.id)}
										<!-- Only claim they are drawing while they are. This said it
											 unconditionally, so a card whose six views had finished — or
											 whose render had failed — went on promising them for ever. -->
										<p class="text-sm text-[var(--st-muted)]">
											Saved as <span class="font-semibold text-[var(--st-text)]">{item.sheet.name}</span>.
											Pick {item.sheet.kind === 'character' ? 'them' : 'it'} from
											<span class="text-[var(--st-text)]">+</span> in the box below{kept?.sheet?.state ===
											'rendering'
												? ' — the six views are still drawing.'
												: kept?.sheet?.file
													? ' — the six views are ready on it.'
													: '.'}
										</p>
									{:else}
										<!-- The voice, where the decision to keep them is made.
											 It was written by the same call that wrote the description and
											 it travels onto the sheet on save, but it was doing that
											 invisibly: the first question asked of this card was "where
											 would I see it?", which is the answer to whether it belongs
											 here. Editable, so what is on screen is what gets kept. -->
										{#if item.sheet.kind === 'character' && item.sheet.voice !== undefined}
											<label class="block text-xs text-[var(--st-faint)]" for="char-voice-{item.id}">
												How they sound — carried into every clip they are in
											</label>
											<input
												id="char-voice-{item.id}"
												bind:value={item.sheet.voice}
												spellcheck="false"
												maxlength="240"
												class="mt-2 mb-4 w-full rounded-lg bg-[var(--st-bg)] px-3 py-2 text-sm outline-none focus:ring-0"
											/>
										{/if}
										<label class="block text-xs text-[var(--st-faint)]" for="char-name-{item.id}">
											{item.sheet.kind === 'character' ? 'Name them' : 'Name it'} — this is what the
											picker will show
										</label>
										<div class="mt-2 flex flex-wrap items-center gap-2">
											<input
												id="char-name-{item.id}"
												bind:value={item.sheet.name}
												spellcheck="false"
												class="min-w-0 flex-1 rounded-lg bg-[var(--st-bg)] px-3 py-2 text-sm outline-none focus:ring-0"
											/>
											<button
												type="button"
												disabled={sheetBusy[item.id] || !item.sheet.name?.trim()}
												onclick={() => saveSubject(item.id)}
												class="btn btn-primary"
											>
												{sheetBusy[item.id]
													? 'Saving…'
													: item.sheet.kind === 'character'
														? 'Save character'
														: 'Save location'}
											</button>
										</div>
										<p class="mt-2 text-xs leading-relaxed text-[var(--st-faint)]">
											Not right? Say what to change in the chat — {item.sheet.kind === 'character'
												? 'the same person is'
												: 'the same place is'} kept and only what you name moves.
										</p>
									{/if}
								</div>
								{:else if item.sheet.url}
								<div class="mt-4 border-t border-[var(--st-line)] pt-4">
									{#if item.sheet.id}
										<p class="text-sm text-[var(--st-muted)]">
											Kept as <span class="font-semibold text-[var(--st-text)]">{item.sheet.name}</span>.
											Every clip can use it from here on.
										</p>
									{:else}
										<label class="block text-xs text-[var(--st-faint)]" for="sheet-name-{item.id}">
											Name it — this is what the picker will show
										</label>
										<div class="mt-2 flex flex-wrap items-center gap-2">
											<input
												id="sheet-name-{item.id}"
												bind:value={item.sheet.name}
												spellcheck="false"
												class="min-w-0 flex-1 rounded-lg bg-[var(--st-bg)] px-3 py-2 text-sm outline-none focus:ring-0"
											/>
											<button
												type="button"
												disabled={sheetBusy[item.id] || !item.sheet.name?.trim()}
												onclick={() => keepSheet(item.id)}
												class="btn btn-primary"
											>
												{sheetBusy[item.id] ? 'Keeping…' : 'Keep it'}
											</button>
										</div>
										<p class="mt-2 text-xs text-[var(--st-faint)]">
											Keep it now — the harness stops serving this image once the run's
											workspace shuts down.
										</p>
									{/if}
								</div>
								{/if}
							</article>
						{:else if item.kind === 'shot' && item.shot}
							{@const n = item.shot.prompt.trim() ? item.shot.prompt.trim().split(/\s+/).length : 0}
							{@const picked = item.shot.loras ?? []}
							<article class="enter rounded-2xl bg-[var(--st-surface)] p-5 sm:p-6">
								<div class="mb-3 flex items-baseline justify-between gap-4">
									<h3 class="font-display text-base font-semibold">
										The prompt
										{#if item.shot.characterName || item.shot.locationName}
											<span class="ml-2 align-middle text-xs font-normal text-[var(--st-faint)]">
												{item.shot.characterName ? `with ${item.shot.characterName}` : ''}{item.shot
													.characterName && item.shot.locationName
													? ' '
													: ''}{item.shot.locationName ? `in ${item.shot.locationName}` : ''}
											</span>
										{/if}
									</h3>
									<span
										class="text-xs tabular-nums {n > 700
											? 'font-semibold text-[#e0a03a]'
											: 'text-[var(--st-faint)]'}"
									>
										{n} / 700 words
									</span>
								</div>

								<!-- The literal text the workflow will receive. Editable, because the
									 planning chain's render prompts were invisible and that is how it
									 shipped briefs describing a face instead of a scene.

									 Closed by default now. Seven hundred words is not something a
									 person reads on the way past — it was ten rows of monospace
									 standing between the operator and the button, and it got clicked
									 past rather than read, which is worse than not showing it: it
									 looks like it was checked. What they approved is the sentence
									 above; this is the machine's version of it, one tap away for the
									 one time in ten that something came back wrong. -->
								<details class="group">
									<summary
										class="flex cursor-pointer list-none items-center gap-2 py-1 text-xs text-[var(--st-faint)] transition-colors hover:text-[var(--st-text)]"
									>
										<span
											class="text-[0.6rem] transition-transform group-open:rotate-90"
											aria-hidden="true">›</span
										>
										<span>The words the crew gets</span>
									</summary>
									<label class="sr-only" for="shot-{item.id}">Render prompt</label>
									<textarea
										id="shot-{item.id}"
										bind:value={item.shot.prompt}
										rows="10"
										spellcheck="false"
										readonly={item.shot.launched}
										class="mt-2 block w-full resize-y rounded-xl bg-[var(--st-bg)] p-3 font-mono text-[13px] leading-relaxed text-[var(--st-text)] outline-none read-only:text-[var(--st-muted)]"
									></textarea>
								</details>

								{#if item.shot.why}
									<p class="mt-2.5 text-xs text-[var(--st-faint)]">{item.shot.why}</p>
								{/if}

								<!-- What this clip renders with. The writer picks; you overrule it
									 here, before the GPU rather than after. Two more adapters load on
									 every clip regardless and are not listed — they are not choices.
									 The cap is two: four at once produced a clip whose anatomy fell
									 apart exactly where two adapters overlapped. -->
								<div class="mt-4 border-t border-[var(--st-line)] pt-3.5">
									<!-- The always-loaded set, shown rather than hidden. Moving one of
										 these into the base made it vanish off the card, which is how
										 you end up asking for an adapter that is already running. They
										 cannot be switched off — every clip is built on them — but the
										 realism slider and the anatomy corrector are both worth a nudge,
										 and doing that used to mean editing the catalogue. -->
									<div class="mb-3">
										<div class="mb-2 text-xs text-[var(--st-faint)]">always on</div>
										{#each BASE as l (l.key)}
											{@const at = item.shot.baseLoras?.[l.key] ?? l.strength}
											<div class="mt-1.5 flex items-center gap-3">
												<span class="w-40 shrink-0 truncate text-xs text-[var(--st-muted)]"
													>{l.label}</span
												>
												{#if item.shot.launched}
													<span class="flex-1 text-xs tabular-nums text-[var(--st-faint)]"
														>{at}</span
													>
												{:else}
													<input
														type="range"
														min="0"
														max="2"
														step="0.05"
														value={at}
														aria-label="{l.label} strength"
														oninput={(e) =>
															setBaseStrength(item.id, l.key, Number(e.currentTarget.value))}
														class="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--st-accent)]"
													/>
													<button
														type="button"
														title="back to {l.strength}"
														onclick={() => resetLoraStrength(item.id, l.key)}
														class="w-9 shrink-0 cursor-pointer text-right text-xs tabular-nums {at ===
														l.strength
															? 'text-[var(--st-muted)]'
															: 'text-[var(--st-text)]'}">{at.toFixed(2)}</button
													>
													<span
														class="w-24 shrink-0 text-right text-xs tabular-nums text-[var(--st-faint)]"
													>
														{l.band ? `${l.band[0]}–${l.band[1]}` : `author ${l.strength}`}
													</span>
												{/if}
											</div>
										{/each}
									</div>

									<div class="mb-2 flex items-baseline gap-2">
										<span class="text-xs text-[var(--st-faint)]">on top of that</span>
										{#if picked.length === 0}
											<span class="text-xs text-[var(--st-faint)]">— none chosen</span>
										{/if}
									</div>
									{#if item.shot.launched}
										<div class="flex flex-wrap gap-1.5">
											{#each picked as p (p.key)}
												<span
													class="rounded-md bg-[var(--st-bg)] px-2 py-0.5 text-xs text-[var(--st-muted)]"
													>{loraFor(p.key)?.label ?? p.key}
													<span class="tabular-nums opacity-60">{p.strength}</span></span
												>
											{/each}
										</div>
									{:else}
										<div class="flex flex-wrap gap-1.5">
											{#each CATALOGUE as l (l.key)}
												{@const on = picked.some((p) => p.key === l.key)}
												<button
													type="button"
													title="{l.use}{l.trigger ? ` · trigger: ${l.trigger}` : ''}"
													class="cursor-pointer rounded-md px-2 py-0.5 text-xs transition-colors {on
														? 'bg-[var(--st-surface-2)] font-semibold text-[var(--st-text)]'
														: 'text-[var(--st-muted)] hover:text-[var(--st-text)]'}"
													onclick={() => toggleLora(item.id, l.key)}
												>
													{l.label}
													{#if on}<span class="tabular-nums opacity-70"
															>{picked.find((p) => p.key === l.key)?.strength}</span
														>{/if}
												</button>
											{/each}
										</div>

										<!-- One slider per chosen adapter. The number starts on the
											 author's own recommendation, which is the only figure here
											 that came from someone rendering with it. The band beside it
											 is what they published; the slider goes past it on purpose,
											 because you can see the clip and they could not. -->
										{#each picked as p (p.key)}
											{@const l = loraFor(p.key)}
											{#if l}
												<div class="mt-2.5 flex items-center gap-3">
													<span class="w-40 shrink-0 truncate text-xs text-[var(--st-muted)]"
														>{l.label}</span
													>
													<input
														type="range"
														min="0"
														max="2"
														step="0.05"
														value={p.strength}
														aria-label="{l.label} strength"
														oninput={(e) =>
															setLoraStrength(item.id, p.key, Number(e.currentTarget.value))}
														class="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--st-accent)]"
													/>
													<button
														type="button"
														title="back to the author's recommendation, {l.strength}"
														onclick={() => resetLoraStrength(item.id, p.key)}
														class="w-9 shrink-0 cursor-pointer text-right text-xs tabular-nums {p.strength ===
														l.strength
															? 'text-[var(--st-muted)]'
															: 'text-[var(--st-text)]'}">{p.strength.toFixed(2)}</button
													>
													<span
														class="w-24 shrink-0 text-right text-xs tabular-nums text-[var(--st-faint)]"
													>
														{l.band ? `${l.band[0]}–${l.band[1]}` : `author ${l.strength}`}
													</span>
												</div>
											{/if}
										{/each}
									{/if}
								</div>

								{#if !item.shot.launched}
									<div class="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
										<div class="flex items-center gap-1.5">
											<span class="mr-1 text-xs text-[var(--st-faint)]">seconds</span>
											{#each [5, 6, 8, 10, 12, 15] as sec (sec)}
												<button
													type="button"
													class="cursor-pointer rounded-md px-2 py-0.5 text-xs tabular-nums transition-colors {item
														.shot.seconds === sec
														? 'bg-[var(--st-surface-2)] font-semibold text-[var(--st-text)]'
														: 'text-[var(--st-muted)] hover:text-[var(--st-text)]'}"
													onclick={() => setShotSeconds(item.id, sec)}>{sec}</button
												>
											{/each}
										</div>
										<!-- Not offered on a continuation. The frame there is not a choice:
											 it is whatever the clip being continued was shot at, and anything
											 else produces two pieces that cannot be concatenated — which is
											 discovered only after both have been rendered. A control whose
											 every other setting breaks the thing it feeds is not a control. -->
										{#if item.shot.continues}
											<span class="text-xs text-[var(--st-faint)]"
												>{frameFor(item.shot.resolution ?? '576p', item.shot.orientation)
													.width}x{frameFor(item.shot.resolution ?? '576p', item.shot.orientation)
													.height} · follows the clip before it</span
											>
										{:else}
											<div class="flex items-center gap-1.5">
												<!-- Unlike seconds and frame shape, this changes no words in
													 the brief, so it is set in place and costs no rewrite. -->
												<span class="mr-1 text-xs text-[var(--st-faint)]">size</span>
												{#each RES_KEYS as r (r)}
													{@const f = frameFor(r, item.shot.orientation)}
													<button
														type="button"
														title="{f.width}x{f.height}"
														class="cursor-pointer rounded-md px-2 py-0.5 text-xs tabular-nums transition-colors {(item
															.shot.resolution ?? '576p') === r
															? 'bg-[var(--st-surface-2)] font-semibold text-[var(--st-text)]'
															: 'text-[var(--st-muted)] hover:text-[var(--st-text)]'}"
														onclick={() => {
															if (item.shot) item.shot.resolution = r;
														}}>{r}</button
													>
												{/each}
											</div>
											<div class="flex items-center gap-1.5">
												<span class="mr-1 text-xs text-[var(--st-faint)]">frame</span>
												{#each [['portrait', 'portrait'], ['landscape', 'landscape']] as [val, label] (val)}
													<button
														type="button"
														class="cursor-pointer rounded-md px-2 py-0.5 text-xs transition-colors {item
															.shot.orientation === val
															? 'bg-[var(--st-surface-2)] font-semibold text-[var(--st-text)]'
															: 'text-[var(--st-muted)] hover:text-[var(--st-text)]'}"
														onclick={() =>
															setShotOrientation(item.id, val as 'portrait' | 'landscape')}
														>{label}</button
													>
												{/each}
											</div>
										{/if}
									</div>

									<!-- The button states what it will do. How many clips is chosen
										 once, in the composer, and confirmed here at the moment of
										 spend — a second control asking the same question is how a card
										 grows a settings panel. A continuation is always one: a second
										 version would need the first one's clip as its reference, and a
										 second camera angle on a shot that continues another would
										 break the join it exists to make. -->
									<!-- The counts this card will actually spend. Versions apply to a
										 continuation like any other shot — each take continues the same
										 prior clip, so they are alternatives you choose between. Angles
										 do not, when the seam is pinned: the first instant is nailed to
										 the frame the last clip ended on and a second camera cannot
										 start there. On a free start they apply again. -->
									{@const cardAngles =
										item.shot.continues && item.shot.continues.pinned !== false ? 1 : angles}
									{@const n = takes * cardAngles}
									<!-- Anything the check could not get the writer to fix, said once,
										 directly above the button that spends the money. Not a warning
										 dialog and not a block: the brief renders, and this is what to
										 look at if the clip comes back wrong. The way out is already
										 here — "write it again" is the next control along. -->
									{#if item.shot.warn?.length}
										<p class="mt-4 text-xs leading-relaxed text-[var(--st-faint)]">
											{item.shot.warn.join(' · ')}
										</p>
									{/if}
									<!-- A fault the check caught and the writer then fixed. Said in the
										 past tense because there is nothing to do about it — it is here
										 because the brief took twice as long to arrive and the wait
										 otherwise looks like the writer being slow. -->
									{#if item.shot.fixed?.length}
										<p class="mt-4 text-xs leading-relaxed text-[var(--st-faint)]">
											újraírva — {item.shot.fixed.join(' · ')}
										</p>
									{/if}
									<div class="mt-5 flex flex-wrap items-center gap-2.5">
										<button
											type="button"
											disabled={shotBusy[item.id]}
											class="btn btn-primary"
											onclick={() =>
												n > 1 ? renderBatch(item.id, takes, cardAngles) : renderShot(item.id)}
										>
											{shotBusy[item.id]
												? 'starting…'
												: n > 1
													? `render ${countLabel(takes, cardAngles)}`
													: 'render this'}
										</button>
										<button
											type="button"
											disabled={shotBusy[item.id]}
											class="btn btn-quiet"
											onclick={() => rewriteShot(item.id)}>write it again</button
										>

									</div>
								{/if}
							</article>
						{:else if item.kind === 'plan' && item.plan}
							<article class="enter rounded-2xl bg-[var(--st-surface)] p-5 sm:p-6">
								{#if editingPlan && item.id === latestPlanId}
									<label class="sr-only" for="edit-title">Title</label>
									<input
										id="edit-title"
										bind:value={editTitle}
										class="w-full rounded-xl border border-[var(--st-line)] bg-[var(--st-bg)] px-3.5 py-2.5 font-display text-lg font-semibold outline-none focus:border-[var(--st-muted)]"
									/>
									<label class="sr-only" for="edit-story">Story</label>
									<textarea
										id="edit-story"
										bind:value={editStory}
										rows="12"
										class="mt-3 block w-full resize-y rounded-xl border border-[var(--st-line)] bg-[var(--st-bg)] p-4 text-[0.95rem] leading-[1.75] outline-none focus:border-[var(--st-muted)]"
									></textarea>
									<label class="sr-only" for="edit-style">Look</label>
									<textarea
										id="edit-style"
										bind:value={editStyle}
										rows="2"
										class="mt-3 block w-full resize-y rounded-xl border border-[var(--st-line)] bg-[var(--st-bg)] p-4 text-sm leading-relaxed outline-none focus:border-[var(--st-muted)]"
									></textarea>
									<div class="mt-4 flex items-center gap-3">
										<button
											type="button"
											onclick={saveEdit}
											class="btn btn-primary"
										>
											save
										</button>
										<button
											type="button"
											onclick={() => (editingPlan = false)}
											class="cursor-pointer px-2 py-2.5 text-xs text-[var(--st-muted)] hover:text-[var(--st-text)]"
										>
											cancel
										</button>
									</div>
								{:else}
									<h3 class="font-display text-lg leading-snug font-semibold tracking-tight">
										{item.plan.title}
									</h3>
									<!-- The voice the model picked. Your sentence rarely specifies one,
									     so this is a decision taken on your behalf — and seeing it named
									     is what lets you disagree with it in one line, rather than
									     reverse-engineering it from four hundred words of prose. -->
									{#if item.plan.register}
										<p class="mt-1.5 font-mono text-[11px] tracking-wide text-[var(--st-faint)]">
											{item.plan.register}
										</p>
									{/if}
									<!-- The summary, not the story. Four hundred words of prose is
									     what the crew needs and not what a person reads before deciding
									     whether this is the film they asked for — and asking them to
									     read it to find out buries the decision under the material.
									     The story is one click away and entirely unchanged. -->
									<p class="doc mt-3 text-[0.95rem] leading-[1.75] text-[var(--st-text)]">
										{item.plan.summary || item.plan.story}
									</p>
									<p class="mt-3 text-sm leading-relaxed text-[var(--st-muted)]">
										{item.plan.style}
									</p>
									{#if item.plan.summary}
										<button
											type="button"
											class="mt-3 cursor-pointer text-xs text-[var(--st-muted)] underline-offset-4 hover:text-[var(--st-text)] hover:underline"
											onclick={() => (expanded[item.id] = !expanded[item.id])}
										>
											{expanded[item.id] ? 'hide the full story' : 'read the full story'}
										</button>
										{#if expanded[item.id]}
											<p
												class="doc enter mt-3 rounded-xl bg-[var(--st-bg)] px-4 py-3.5 text-[0.95rem] leading-[1.75] text-[var(--st-muted)]"
											>
												{item.plan.story}
											</p>
										{/if}
									{/if}
									<p class="mt-3 text-xs text-[var(--st-faint)]">
										{item.plan.sceneCount} scenes
										{#if item.id === latestPlanId && !planningWs}
											· refine it by typing in the chat
										{/if}
									</p>
									{#if item.id === latestPlanId && !planningWs}
										<div class="mt-5 flex flex-wrap items-center gap-3">
											<button
												type="button"
												disabled={launchingPlanning}
												onclick={launchPlanning}
												class="btn btn-primary"
											>
												{launchingPlanning ? 'starting…' : 'start'}
											</button>
											<button
												type="button"
												disabled={launchingPlanning}
												onclick={openEdit}
												class="cursor-pointer px-2 py-2.5 text-sm text-[var(--st-muted)] transition-colors hover:text-[var(--st-text)] disabled:cursor-default disabled:opacity-50"
											>
												edit
											</button>
										</div>
									{:else if item.id === latestPlanId}
										<p class="mt-4 text-xs text-[var(--st-faint)]">started</p>
									{/if}
								{/if}
							</article>
						{:else if item.kind === 'artifact' && item.artifact}
							{@const art = item.artifact}
							{@const isCurrent = latestDocItem[art.key] === item.id}
							{@const phase = docPhase[art.key]}
							<article class="enter rounded-2xl bg-[var(--st-surface)] p-5 sm:p-6">
								<h3 class="font-display text-base font-semibold">{art.title}</h3>
								{#if art.body}
									<div class="relative mt-3" class:clamp={isLong(art.body) && !expanded[item.id]}>
										{@render document(renderDocument(art.files[0]?.name ?? '', art.body))}
									</div>
									{#if isLong(art.body)}
										<button
											type="button"
											class="mt-3 cursor-pointer text-xs text-[var(--st-muted)] underline-offset-4 hover:text-[var(--st-text)] hover:underline"
											onclick={() => (expanded[item.id] = !expanded[item.id])}
										>
											{expanded[item.id] ? 'collapse' : 'more'}
										</button>
									{/if}
								{:else}
									<!-- The text could not be read — the file itself is offered
									     instead of an empty card. Same-origin route, but not a
									     SvelteKit page, hence the lint exception. -->
									{#each art.files as f (f.name)}
										<p class="mt-2 text-sm text-[var(--st-muted)]">
											<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
											<a
												href={f.url}
												target="_blank"
												rel="noreferrer"
												class="underline underline-offset-4"
											>
												{f.name}
											</a>
										</p>
									{/each}
								{/if}

								{#if isCurrent && !renderWs}
									<div class="mt-4 border-t border-[var(--st-line)] pt-4">
										{#if phase === 'regen'}
											<p class="text-xs text-[var(--st-muted)]">regenerating</p>
										{:else if docAccepted[art.key]}
											<p class="text-xs text-[var(--st-faint)]">elfogadva</p>
										{:else}
											<div class="flex flex-wrap items-center gap-3">
												<button
													type="button"
													onclick={() => (docAccepted[art.key] = true)}
													class="btn btn-secondary btn-sm"
												>
													ok
												</button>
												<button
													type="button"
													onclick={() => (changeOpen[item.id] = !changeOpen[item.id])}
													class="cursor-pointer px-1 py-2 text-xs text-[var(--st-muted)] transition-colors hover:text-[var(--st-text)]"
												>
													request a change
												</button>
											</div>
											{#if changeOpen[item.id]}
												<form
													class="mt-3 flex gap-2"
													onsubmit={(e) => {
														e.preventDefault();
														requestChange(item.id, art.key);
													}}
												>
													<label class="sr-only" for="change-{item.id}">What should change</label>
													<input
														id="change-{item.id}"
														bind:value={changeText[item.id]}
														placeholder="what should change in this document"
														class="min-w-0 flex-1 rounded-xl border border-[var(--st-line)] bg-[var(--st-bg)] px-3.5 py-2.5 text-sm outline-none placeholder:text-[var(--st-faint)] focus:border-[var(--st-muted)]"
													/>
													<button
														type="submit"
														disabled={changeBusy[item.id] || !(changeText[item.id] ?? '').trim()}
														class="btn btn-primary"
													>
														send
													</button>
												</form>
												<p class="mt-2 text-xs text-[var(--st-faint)]">
													This step is rewritten, and everything built on it is refreshed after it.
												</p>
											{/if}
										{/if}
									</div>
								{/if}
							</article>
						{:else if item.kind === 'approval'}
							<!-- A second way to start the shoot. The board has the real one, and
							     this is deliberately duplicate: for one evening the button lived
							     only there, the board failed to post, and an otherwise finished
							     plan could not be approved by any means at all. A control that
							     gates the entire run should not have exactly one home. -->
							<!-- Text only. The board above already lists the five documents and
							     opens each one; repeating that here put the same list twice on
							     one screen, and the button that matters ended up below the
							     duplicate rather than beside the thing it acts on. Both now live
							     on the board. -->
							<p class="enter doc text-[0.95rem] leading-[1.75] text-[var(--st-text)]">
								{item.text}
							</p>
						{:else if item.kind === 'takes' && item.takes && !item.artifact}
							<!-- A batch nobody has chosen from yet: the strip, and nothing else.
								 No verdict row and no continue here — those belong to the take you
								 keep, and offering them on four clips at once would ask for four
								 answers to a question that has one. -->
							{@const t = item.takes}
							{@const live = t.runs.filter((r) => r.state === 'rendering').length}
							{@const done = t.runs.filter((r) => r.state === 'ready')}
							{@const gone = t.runs.filter((r) => r.state === 'failed')}
							{@const row = done[0]?.clip ? logRow[done[0].clip.workspace] : undefined}
							<div class="enter">
								<p class="text-[0.95rem] leading-[1.75] text-[var(--st-text)]">
									{#if live}
										{t.runs.length} clips of this shot, rendering together.
									{:else if done.length}
										{done.length}
										{done.length === 1 ? 'clip' : 'clips'} of this shot.
										<span class="text-[var(--st-faint)]">Press one to look properly.</span>
									{/if}
								</p>

								<!-- The grid follows the count rather than always being four: two
									 takes in a four-column grid leave half the row empty and the card
									 reads as broken. Two across on a phone whatever the count — at
									 375px four tiles are 77 wide, which is too small to press, and
									 two are 161. -->
								<div class="st-takes mt-3" data-n={t.runs.length}>
									{#each t.runs as run (run.slug)}
										{@render takeTile(item, run)}
									{/each}
								</div>

								<div
									class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--st-faint)]"
								>
									{#if live}
										<span class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-accent)]"
										></span>
										<span class="tabular-nums">{done.length} of {t.runs.length} landed</span>
									{/if}
									<!-- One row describes all of them: the takes differ by seed and by
										 nothing else, so the size, the length and the adapters are the
										 same sentence four times over. -->
									{#if row}
										{#if row.launched?.length}
											<span class="text-[var(--st-muted)]">
												{row.launched
													.map((p) => `${loraFor(p.key)?.label ?? p.key} ${p.strength}`)
													.join(' · ')}
											</span>
										{/if}
										<span class="tabular-nums"
											>{row.steps} steps · {row.width}×{row.height} · {row.fps}fps · {row.seconds}s</span
										>
									{/if}
								</div>

								{#if !live && !done.length}
									<p class="text-[0.95rem] leading-[1.75] text-[var(--st-text)]">
										None of them finished.
									</p>
								{/if}
								{#each gone as g (g.slug)}
									<p class="mt-1 text-xs leading-relaxed text-[var(--st-faint)]">
										Clip {g.index} — {g.error || 'no reason given'}
									</p>
								{/each}
							</div>
						{:else if (item.kind === 'clips' || item.kind === 'takes') && item.artifact}
							{@const ws = item.artifact.workspace ?? ''}
							{@const v = verdict[ws]}
							<!-- A caption only where it says more than the title does. An assembled
							     thing has a length and a part count worth reading — "The film — 3
							     clips, 23s." — and a single clip has a name that repeats what the
							     card already is. Those two used to look the same.

							     A takes card never gets one. Not writing the caption at keep time
							     was not enough: the text lives in the saved transcript, so every
							     card kept before that change went on showing "Take 1, kept." after
							     it. The rule has to hold for what is already on disk, not only for
							     what is written next.

							     Up here with the other consts because {@const} must be a block's
							     immediate child — this file's own rule, and I had just put it inside
							     a div. -->
							<!-- A turnaround is a reference picture that happens to be a video:
							     there is nothing to continue from it, nothing to put in a film,
							     and no verdict to give it — it either resembles the character or
							     it is redrawn from the card. Offering the scene band under it put
							     four controls on screen that all lead somewhere wrong. -->
							{@const scenic = item.artifact.key !== 'turnaround'}
							<!-- No caption on a turnaround either. It sat directly under the
							     character's own card and said, in a full sentence, what the picture
							     above it had already said — and with a long descriptive name in the
							     middle of it, "The turn ultra slim body, flat breast was built
							     from." reads as broken English rather than a label.

							     Written into the transcript, so cards kept before this change carry
							     it too; the rule has to hold for what is on disk, not only for what
							     is written next. -->
							{@const said =
								scenic && item.kind !== 'takes' && item.text && item.text !== item.artifact.title
									? item.text
									: ''}
							<div class="enter">
								<div class="mt-3 overflow-hidden rounded-2xl bg-[var(--st-surface)]">
								{#each item.artifact.files as f (f.name)}
									{@render videoCard(f.name, f.url, said, ws)}
								{/each}

								<!-- Everything you can do with a finished clip, in one band.
								     It used to be five: a caption, a line of render settings, "how
								     was it?", the buttons, and a paragraph. Five stacked rows are a
								     list, not a hierarchy, and the eye had nowhere to land.

								     One row now. What carries the work forward is filled and first;
								     the verdict sits at the far end, quiet, because it is asked
								     rather than inferred and should not stand between you and the
								     next clip. It is still a real action — "not good" is what starts
								     the diagnosis, not a survey answer.

								     The render settings go behind a disclosure. Nine times in ten
								     nobody wants them; the tenth time a clip came back wrong and the
								     seed and the adapters are exactly what is needed, so they are one
								     tap away rather than gone. -->
										{#if ws && scenic}
									{@const ci = contInfo(ws)}
									{@const chain = chainOf(ws)}
									{@const others =
										item.kind === 'takes' && item.takes
											? readyTakes(item.id).filter((r) => r.index !== item.takes?.kept)
											: []}
									{@const v = verdict[ws]}
									<div class="flex flex-col gap-2 px-4 pt-3 pb-4">
										<div class="flex flex-wrap items-center gap-2">
											<button
												type="button"
												disabled={!ci.ok}
												onclick={() => startContinue(item)}
												class="btn btn-primary btn-sm"
												>Continue</button
											>
											{#if filmPart(item.artifact)}
												{#if inFilm(item.artifact)}
													<span class="flex items-center gap-1.5 px-1 text-xs text-[var(--st-muted)]">
														<span aria-hidden="true">✓</span><span>In the film</span>
													</span>
												{:else}
													<button
														type="button"
														onclick={() => addToFilm(item)}
														class="btn btn-secondary btn-sm"
														>Add to film</button
													>
												{/if}
											{/if}
											{#if chain.length > 1}
												<button
													type="button"
													disabled={joining[ws]}
													onclick={() => joinScene(ws)}
													class="btn btn-secondary btn-sm"
													>{joining[ws] ? 'Joining…' : `The whole scene · ${chain.length}`}</button
												>
											{/if}
											{#if others.length}
												<button
													type="button"
													onclick={(e) => openTake(item.id, others[0].index, e.currentTarget)}
													class="btn btn-quiet btn-sm"
													>{others.length === 1 ? 'Other take' : `${others.length} other takes`}</button
												>
											{/if}

											<!-- Pushed to the far end. Asked, not inferred, and not on the
											     path to the next clip. -->
											<span class="ml-auto flex items-center gap-0.5">
												{#if !v}
													<button
														type="button"
														onclick={() => rate(ws, 'kept')}
														class="btn btn-quiet btn-sm"
														>Good</button
													>
													<button
														type="button"
														onclick={() => rate(ws, 'rejected')}
														class="btn btn-quiet btn-sm"
														>Not good</button
													>
												{:else if v === 'kept'}
													<span class="px-2 text-xs text-[var(--st-faint)]">Noted as good</span>
												{:else if diagnosing[ws]}
													<span class="flex items-center gap-2 px-2 text-xs text-[var(--st-faint)]">
														<span class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-accent)]"
														></span>
														<span>Working out the fix</span>
													</span>
												{:else if !fix[ws]}
													<button
														type="button"
														onclick={() => diagnose(ws)}
														class="btn btn-secondary btn-sm"
														>Work out why</button
													>
												{/if}
											</span>
										</div>

										{#if !ci.ok}
											<p class="text-xs leading-relaxed text-[var(--st-faint)]">{ci.why}</p>
										{:else if !ci.exact}
											<p class="text-xs text-[var(--st-faint)]">Continues from a frame of this clip.</p>
										{/if}
									</div>
								{/if}
								</div>

									{#if ws && scenic}
									{#if fix[ws]}
										{@const f = fix[ws]}
										<div class="mt-2.5 rounded-2xl bg-[var(--st-surface)] p-4">
											<p class="text-[13px] leading-relaxed text-[var(--st-text)]">{f.why}</p>
											{#if f.loras?.length}
												<p class="mt-2 text-xs text-[var(--st-muted)]">
													next attempt with {f.loras
														.map((p) => `${loraFor(p.key)?.label ?? p.key} ${p.strength}`)
														.join(' · ')}
												</p>
											{/if}
											<div class="mt-3.5 flex flex-wrap items-center gap-2.5">
												<button
													type="button"
													disabled={fixBusy[ws]}
													class="btn btn-primary"
													onclick={() => renderFix(ws)}
												>
													{fixBusy[ws] ? 'starting…' : 'render the fix'}
												</button>
												<button
													type="button"
													class="cursor-pointer rounded-full px-3 py-2 text-xs text-[var(--st-faint)] transition-colors hover:text-[var(--st-text)]"
													onclick={() => openFix(ws)}>read the brief first</button
												>
												<button
													type="button"
													class="cursor-pointer rounded-full px-3 py-2 text-xs text-[var(--st-faint)] transition-colors hover:text-[var(--st-text)]"
													onclick={() => diagnose(ws)}>look again</button
												>
											</div>
										</div>
									{/if}
								{/if}
							</div>
						{/if}
					{/each}

					{#if sending}
						<!-- A word alone reads as frozen once it has been on screen for
							 ten seconds. The counter is the proof that something is still
							 happening, and it makes a stall visible as a stall. -->
						<p class="flex items-center gap-2.5 text-xs text-[var(--st-faint)]">
							<span class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-accent)]"></span>
							<span>{sendingWhat}</span>
							{#if sendingFor > 1}
								<span class="tabular-nums">{sendingFor}s</span>
							{/if}
							{#if typicalPrompt && sendingFor > 2}
								<span aria-hidden="true">·</span>
								<span>{promptOverdue ? 'longer than usual' : typicalLabel(typicalPrompt)}</span>
							{/if}
						</p>
					{/if}

					{#if showExamples}
						<!-- Three of them, one row, equal width — a set the eye reads as a
							 set. Stacked full-width pills made three sentences of different
							 lengths look like three unrelated things, and the longest one
							 decided the shape of the block. -->
						<div class="grid gap-2.5 pt-2 sm:grid-cols-3">
							{#each examples as ex (ex)}
								<button
									type="button"
									class="flex min-h-[5.5rem] cursor-pointer items-start gap-2.5 rounded-xl p-4 text-left text-sm leading-snug text-[var(--st-muted)] ring-1 ring-[var(--st-line)] transition-colors hover:bg-[var(--st-surface)] hover:text-[var(--st-text)] hover:ring-transparent"
									onclick={() => useExample(ex)}
								>
									<!-- Says what the click does: it fills the box, it does not send. -->
									<svg viewBox="0 0 16 16" class="mt-0.5 size-3.5 shrink-0 opacity-45" fill="none" aria-hidden="true">
										<path d="M4 12L12 4M6 4h6v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
									</svg>
									<span class="min-w-0">{ex}</span>
								</button>
							{/each}
						</div>
					{/if}

					<div bind:this={bottomEl}></div>
				</div>

				<!-- ── the composer — pinned, outside the scrolling region ── -->
				<div class="relative shrink-0 pt-3 pb-4">
					{#if !atBottom}
						<!-- Scrolled up and reading? New messages must not yank the view.
							 This is the way back down, the way every chat client offers it. -->
						<button
							type="button"
							class="enter absolute -top-9 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full bg-[var(--st-surface-2)] px-3.5 py-1.5 text-xs text-[var(--st-text)]"
							onclick={() => scrollToBottom('smooth')}
						>
							latest ↓
						</button>
					{/if}
					{#if pollingActive && startedAt}
						<!-- Live status: the dot says something is happening, the clock says
							 how long, and the label says what — the three things a reader
							 waiting twenty minutes actually wants. Opacity-only pulse: the
							 house rules forbid glows. -->
							<p class="mb-2 flex items-center gap-2.5 text-xs text-[var(--st-muted)]">
							<span class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-accent)]"></span>
							<span class="tabular-nums">{elapsedLabel(now - startedAt)}</span>
							{#if simpleRun && typicalClip}
								<!-- The other half of the sentence. `4m 59s` alone cannot tell
									 you whether the answer is due at five minutes or at twenty,
									 and that is the whole difference between waiting and
									 wondering whether the page has hung. -->
								<span class="text-[var(--st-faint)]">·</span>
								<span class="text-[var(--st-faint)]">
									{clipOverdue ? 'longer than usual' : typicalLabel(typicalClip)}
								</span>
							{/if}
							{#if railRunning}
								<span class="text-[var(--st-faint)]">·</span>
								<span class="min-w-0 truncate">{friendly(railRunning.label)}</span>
							{/if}
						</p>
					{/if}
						<!-- A character being drawn belongs in the same slot as everything else
					     that is happening, which is here: pinned above the box, the way a
					     chat client reports its own work. It was inside the character's
					     card, where it scrolls out of sight in a minute and then there is
					     nothing on screen saying a GPU is busy.

					     Not an {:else} of the render line above. They are different work and
					     both can be running — a clip shooting while a character draws — and
					     hiding one behind the other would make the quieter one a mystery.

					     What used to be here was "not running · started yesterday", which is
					     a line saying nothing is happening. Silence already says that, and
					     it said it about a `startedAt` days old, next to a box you were
					     about to type in. -->
						{#each drawingHere as sh (sh.id)}
							<p class="mb-2 flex items-center gap-2.5 text-xs text-[var(--st-muted)]">
								<span
									class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-green)]"
									aria-hidden="true"
								></span>
								<span class="min-w-0 truncate">Building the six views for {sh.name}</span>
								<span class="text-[var(--st-faint)]">·</span>
								<span class="shrink-0 tabular-nums">{turnStatus(sh)}</span>
							</p>
						{/each}
					{#if refFiles.length}
						<div class="mb-2 space-y-1.5">
							{#each refFiles as f (f.id)}
								<div class="flex items-center gap-2 rounded-xl bg-[var(--st-surface)] px-3 py-2">
									<span class="max-w-[9rem] shrink-0 truncate font-mono text-[11px] text-[var(--st-muted)]">
										{f.name}
									</span>
									<input
										value={f.description}
										placeholder="what is this — the crew cannot see the file, only this line"
										onchange={(e) => describeRefFile(f.id, e.currentTarget.value)}
										class="min-w-0 flex-1 border-0 bg-transparent text-xs outline-none placeholder:text-[var(--st-faint)]"
									/>
									<button
										type="button"
										aria-label="remove {f.name}"
										class="shrink-0 cursor-pointer px-1 text-xs text-[var(--st-faint)] hover:text-[var(--st-text)]"
										onclick={() => dropRef(f.id)}
									>
										×
									</button>
								</div>
							{/each}
						</div>
					{/if}
					{#if refError}
						<p class="mb-2 text-xs text-[var(--st-muted)]">{refError}</p>
					{/if}
					<!-- The hint line was a full-width row with an empty right half, so the
						 film costs no height at all. It belongs in this band and not among
						 the composer's setting chips: there it read as a parameter, which
						 is not what it is, and nobody looked for it. -->
					<!-- Only when it has something in it. The reserved 1.6rem stopped the
						 composer jumping when a hint appeared and went away, which was worth
						 it when this row was usually full. It is not: with no hint and no
						 film it is an empty band holding the status line a centimetre clear
						 of the box it is reporting on. -->
					{#if composerHint || film.length}
						<div class="mb-1.5 flex min-h-[1.6rem] items-center gap-3">
							<p class="min-w-0 text-xs text-[var(--st-faint)]">{composerHint}</p>
							<span class="flex-1"></span>
							{#if film.length}
								<button
									type="button"
									aria-expanded={filmOpen}
									onclick={() => (filmOpen = !filmOpen)}
									class="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-[var(--st-surface)] px-2.5 py-1 text-xs tabular-nums text-[var(--st-text)] transition-colors hover:bg-[var(--st-surface-2)] {filmOpen
										? 'bg-[var(--st-surface-2)]'
										: ''}"
								>
									<span class="reelmark" aria-hidden="true"></span>
									<span>{film.length} {film.length === 1 ? 'clip' : 'clips'} · {filmSeconds}s</span>
									<span class="text-[0.6rem] text-[var(--st-faint)] {filmOpen ? 'rotate-180' : ''}"
										>⌄</span
									>
								</button>
							{/if}
						</div>
					{/if}

					{#if film.length && filmOpen}
						<!-- The reel. Whole clips only — that is the line between a strip and
							 an editor, and the one that keeps this from becoming a tool you
							 have to learn. -->
						<div class="enter mb-2 flex items-center gap-2.5 px-2">
							<button
								type="button"
								aria-label="play the film"
								onclick={() => openFilmViewer(0)}
								class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--st-surface-2)] text-[0.7rem] text-[var(--st-text)] transition-colors hover:bg-[var(--st-line-control)]"
							>
								▶
							</button>
							<div class="reel flex min-w-0 flex-1 items-center overflow-x-auto py-0.5">
								{#each film as c, i (filmKey(c))}
									{#if i}
										<span
											class="relative w-1.5 shrink-0 self-stretch"
											aria-hidden="true"
											class:seam-jump={seamJumps(i)}
										></span>
									{/if}
									<button
										type="button"
										aria-label="shot {i + 1}"
										draggable="true"
										ondragstart={(e) => e.dataTransfer?.setData('text/plain', String(i))}
										ondragover={(e) => e.preventDefault()}
										ondrop={(e) => {
											e.preventDefault();
											moveInFilm(Number(e.dataTransfer?.getData('text/plain')), i);
										}}
										onclick={(e) => {
											const r = e.currentTarget.getBoundingClientRect();
											if (e.clientX > r.right - 22 && e.clientY < r.top + 22) dropFromFilm(i);
											else openFilmViewer(i);
										}}
										class="group relative aspect-video w-[5.4rem] shrink-0 cursor-grab overflow-hidden rounded-lg bg-[var(--st-surface)] active:cursor-grabbing"
									>
										<!-- svelte-ignore a11y_media_has_caption -->
										<video
											src={fileUrl(c.workspace, c.artifact, c.file)}
											muted
											loop
											playsinline
											preload="auto"
											use:looping
											class="h-full w-full bg-black object-cover"
										></video>
										<span
											class="pointer-events-none absolute top-0.5 right-0.5 flex size-[1.1rem] items-center justify-center rounded-full bg-black/60 text-[0.65rem] text-white opacity-0 backdrop-blur transition-opacity group-hover:opacity-100"
											>✕</span
										>
									</button>
								{/each}
							</div>
							<button
								type="button"
								disabled={film.length < 2 || filmBusy}
								onclick={exportFilm}
								class="shrink-0 cursor-pointer rounded-full bg-[var(--st-text)] px-3.5 py-1.5 text-xs font-medium text-black transition-colors hover:bg-white disabled:cursor-default disabled:opacity-40 disabled:hover:bg-[var(--st-text)]"
							>
								{filmBusy ? 'assembling…' : 'Export'}
							</button>
						</div>
					{/if}
					<!-- `relative` is load-bearing: the add and format menus open upward
						 from inside the composer and anchor to this box, not to the page. -->
					<div
						class="relative rounded-3xl bg-[var(--st-surface)] p-3"
					>
						<!-- Making a character or a location is a state you are IN, not a tab
							 sitting beside the clip settings. It was a tab, and that put two
							 different questions on one row — what this message makes, and who is
							 in the clip — in identical chips. You enter this from the picker
							 below, and this band is how you know you are here and how you leave. -->
						{#if mode === 'simple' && continuing}
							<div
								class="mb-2 flex items-center justify-between gap-3 rounded-2xl bg-[var(--st-bg)] px-3.5 py-2.5"
							>
								<div class="min-w-0">
									<p class="font-display text-sm font-semibold">Continuing that clip</p>
									<p class="mt-0.5 text-xs leading-relaxed text-[var(--st-faint)]">
										Say what happens next — with {continuing.characterName ?? 'the same person'} in
										{continuing.locationName ?? 'the same place'}. The new piece renders on its own
										and joins onto the end.
									</p>
									<!-- Two options, not one switch.
									     This was a single button showing its own state, and it was read
									     as a choice: clicking "starts on the last frame" to ask for that
									     turned it off. A pair where the chosen one is filled is how the
									     length and the resolution already work on this card, and it
									     cannot be misread the same way.

									     The whole prior clip goes to the model either way — the person,
									     the room, the light and the motion all come from it. This only
									     decides whether the FIRST INSTANT is nailed to the frame the
									     last clip ended on. -->
									<div class="mt-2 flex flex-wrap items-center gap-1.5">
										{#each [[true, 'from the last frame'], [false, 'free start']] as [on, label] (label)}
											<button
												type="button"
												aria-pressed={pinSeam === on}
												onclick={() => (pinSeam = on as boolean)}
												class="cursor-pointer rounded-full px-3 py-1 text-xs transition-colors {pinSeam ===
												on
													? 'bg-[var(--st-surface-2)] font-semibold text-[var(--st-text)]'
													: 'text-[var(--st-faint)] hover:text-[var(--st-muted)]'}">{label}</button
											>
										{/each}
									</div>
									<p class="mt-1 text-xs leading-relaxed text-[var(--st-faint)]">
										{pinSeam
											? 'Seamless — the first instant is the frame the clip ended on.'
											: 'The scene carries over, but the action can begin somewhere else. The join may step.'}
									</p>
								</div>
								<button
									type="button"
									class="btn btn-secondary btn-sm shrink-0"
									onclick={() => (continuing = null)}>never mind</button
								>
							</div>
						{/if}
						{#if mode === 'simple' && !continuing && wantTarget !== 'clip'}
							<div
								class="mb-2 flex items-center justify-between gap-3 rounded-2xl bg-[var(--st-bg)] px-3.5 py-2.5"
							>
								<div class="min-w-0">
									<p class="font-display text-sm font-semibold">
										{wantTarget === 'character' ? 'New character' : 'New location'}
									</p>
									<p class="mt-0.5 text-xs leading-relaxed text-[var(--st-faint)]">
										{wantTarget === 'character'
											? 'Describe them — age, build, hair, what they are wearing. A picture comes back in about a minute. Or attach a photograph, and describe only what it cannot show.'
											: 'Describe the place — six views of it to shoot against. Or attach a photograph and keep that instead.'}
									</p>
								</div>
								<button
									type="button"
									class="btn btn-secondary btn-sm shrink-0"
									onclick={() => {
										wantTarget = 'clip';
										currentCharacter = null;
										saveSetup();
									}}
								>
									back to clips
								</button>
							</div>
						{/if}
						{#if mode === 'simple' && wantTarget === 'clip'}
							<!-- What this clip will be made with, and only that. The rows this
								 replaces showed every kept sheet whether or not you had chosen
								 it; a chip shows what you chose and nothing else, so the answer
								 to "who and where" is still one glance. -->
							<div class="mb-1 flex flex-wrap items-center gap-1.5 px-1">
								{#if chosenCharacter}
									<span class="flex items-center gap-2 rounded-full bg-[var(--st-bg)] py-1 pr-1 pl-1 text-xs">
										<img
											src="/studio/api/sheet/img/{chosenCharacter.id}"
											alt=""
											class="size-5 shrink-0 rounded-full object-cover"
										/>
										<!-- 4rem, because a sheet made from a photograph is named after the
											 file, and "Screenshot 2026 08 25 at 23.24.11" made a 244px chip
											 next to an 85px one. The chip's own furniture — avatar, ×,
											 padding — is 68px, so matching `one clip` exactly would leave
											 the name 17px. This is the smallest cap that still fits every
											 name anyone actually types: the longest measured, "Neon alley",
											 needs 57px. -->
										<span class="max-w-[4rem] truncate">{chosenCharacter.name}</span>
										<button
											type="button"
											aria-label="shoot with anyone instead"
											onclick={() => {
												wantCharacter = '';
												saveSetup();
											}}
											class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--st-faint)] transition-colors hover:bg-[var(--st-surface-2)] hover:text-[var(--st-text)]"
											>×</button
										>
									</span>
								{/if}
								{#if chosenLocation}
									<span class="flex items-center gap-2 rounded-full bg-[var(--st-bg)] py-1 pr-1 pl-1 text-xs">
										<img
											src="/studio/api/sheet/img/{chosenLocation.id}"
											alt=""
											class="size-5 shrink-0 rounded-md object-cover"
										/>
										<span class="max-w-[4rem] truncate">{chosenLocation.name}</span>
										<button
											type="button"
											aria-label="shoot anywhere instead"
											onclick={() => {
												wantLocation = '';
												saveSetup();
											}}
											class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--st-faint)] transition-colors hover:bg-[var(--st-surface-2)] hover:text-[var(--st-text)]"
											>×</button
										>
									</span>
								{/if}

								{#if !planningWs}
									<!-- Beside the format chip rather than in the field row: both
										 answer "what will this message make", both open a panel, and
										 in the row it was squeezing the sentence into a box one line
										 tall — at 390px the placeholder was clipped by it. -->
									<button
										type="button"
										aria-expanded={modeOpen}
										onclick={() => {
											const open = !modeOpen;
											shutMenus();
											modeOpen = open;
										}}
										class="flex min-h-8 cursor-pointer items-center gap-2 rounded-full bg-[var(--st-bg)] px-3 text-xs whitespace-nowrap text-[var(--st-muted)] transition-colors hover:text-[var(--st-text)]"
									>
										{mode !== 'simple' ? 'full production' : batchLabel}
										<svg viewBox="0 0 10 10" class="size-2.5 shrink-0" fill="none" aria-hidden="true">
											<path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
										</svg>
									</button>
								{/if}

								<!-- Length, size and frame in one chip. All three keep a saved
									 default, so none of them is a question you have to answer
									 before the first send. -->
								<button
									type="button"
									aria-expanded={fmtOpen}
									onclick={() => {
										const open = !fmtOpen;
										shutMenus();
										fmtOpen = open;
									}}
									class="flex min-h-8 cursor-pointer items-center gap-2 rounded-full bg-[var(--st-bg)] px-3 font-mono text-xs text-[var(--st-muted)] transition-colors hover:text-[var(--st-text)]"
								>
									{composerShape.seconds}s · {composerShape.res} · {composerShape.portrait
										? '9:16'
										: '16:9'}
									<!-- The same chevron the mode control carries. Two chips that open
										 the same kind of panel were reading as two different kinds of
										 thing: one looked like a control, the other like a readout.
										 Dropped while continuing, where it really is a readout. -->
									<svg viewBox="0 0 10 10" class="size-2.5 shrink-0" fill="none" aria-hidden="true">
										<path d="M2 4l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
									</svg>
								</button>
							</div>
						{/if}

						<!-- The dismiss target for all three menus. A backdrop rather than a
							 window listener, for the reason given at the <svelte:window> above,
							 and it is the same shape the off-canvas sidebar already uses. -->
						{#if addOpen || pickKind || fmtOpen || modeOpen}
							<button
								type="button"
								aria-label="close the menu"
								class="fixed inset-0 z-20 cursor-default"
								onclick={shutMenus}
							></button>
						{/if}

						<!-- ── the add menu, level one ─────────────────────────────── -->
						{#if addOpen}
							<div
								role="menu"
								class="enter absolute bottom-full left-2 z-30 mb-2 w-[20rem] max-w-[calc(100vw-3rem)] rounded-2xl bg-[var(--st-surface)] p-2 shadow-[0_16px_44px_rgba(0,0,0,.6)] ring-1 ring-[var(--st-line)]"
							>
								{#each [['character', characters.length, 'New character'], ['location', locations.length, 'New location']] as [kind, kept, label] (kind)}
									<button
										type="button"
										role="menuitem"
										onclick={() => {
											// With nothing kept there is nothing to choose between, so
											// the row does the only useful thing and starts making one.
											if (kept === 0) {
												wantTarget = kind as 'character' | 'location';
												currentCharacter = null;
												saveSetup();
												shutMenus();
											} else {
												addOpen = false;
												pickKind = kind as 'character' | 'location';
											}
										}}
										class="flex min-h-[3.125rem] w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors hover:bg-[var(--st-surface-2)]"
									>
										<span
											class="flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--st-muted)] ring-1 ring-[var(--st-line)]"
										>
											{#if kind === 'character'}
												<svg viewBox="0 0 16 16" class="size-[15px]" fill="none" aria-hidden="true">
													<circle cx="8" cy="5.6" r="2.7" stroke="currentColor" stroke-width="1.4" />
													<path d="M3 13.2c.7-2.3 2.6-3.4 5-3.4s4.3 1.1 5 3.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
												</svg>
											{:else}
												<svg viewBox="0 0 16 16" class="size-[15px]" fill="none" aria-hidden="true">
													<rect x="2.2" y="3.4" width="11.6" height="9.2" rx="1.6" stroke="currentColor" stroke-width="1.4" />
													<path d="M2.4 10.2l3-2.6 2.6 2.2 2.4-1.8 3.2 2.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
												</svg>
											{/if}
										</span>
										<span class="min-w-0">
											<span class="block">{label}</span>
											<span class="mt-0.5 block text-xs text-[var(--st-faint)]">
												{kept ? `${kept} kept — or make another` : 'nothing kept yet'}
											</span>
										</span>
										{#if kept}
											<svg viewBox="0 0 10 10" class="ml-auto size-2.5 shrink-0 text-[var(--st-faint)]" fill="none" aria-hidden="true">
												<path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
											</svg>
										{/if}
									</button>
								{/each}

								<label
									class="flex min-h-[3.125rem] w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors hover:bg-[var(--st-surface-2)]"
								>
									<span class="flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--st-muted)] ring-1 ring-[var(--st-line)]">
										<svg viewBox="0 0 20 20" class="size-4" fill="none" aria-hidden="true">
											<path
												d="M13 7l-5.5 5.5a2.1 2.1 0 003 3L16 10a3.5 3.5 0 00-5-5l-5.5 5.5a5 5 0 007 7L18 12"
												stroke="currentColor"
												stroke-width="1.6"
												stroke-linecap="round"
												stroke-linejoin="round"
											/>
										</svg>
									</span>
									<span class="min-w-0">
										<span class="block">Attach reference image</span>
										<span class="mt-0.5 block text-xs text-[var(--st-faint)]">a face or a place to shoot against</span>
									</span>
									<input
										type="file"
										multiple
										accept="image/*,video/*"
										class="hidden"
										disabled={refBusy}
										onchange={(e) => {
											const el = e.currentTarget as HTMLInputElement;
											attachRefs(el.files);
											el.value = '';
											shutMenus();
										}}
									/>
								</label>
							</div>
						{/if}

						<!-- ── the add menu, level two ─────────────────────────────── -->
						{#if pickKind}
							{@const kept = pickKind === 'character' ? characters : locations}
							<div
								role="menu"
								class="enter absolute bottom-full left-2 z-30 mb-2 flex w-[23rem] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl bg-[var(--st-surface)] shadow-[0_16px_44px_rgba(0,0,0,.6)] ring-1 ring-[var(--st-line)]"
							>
								<div class="flex items-center gap-2 border-b border-[var(--st-line)] py-2 pr-2.5 pl-1.5">
									<button
										type="button"
										aria-label="back"
										onclick={() => {
											pickKind = null;
											addOpen = true;
										}}
										class="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--st-muted)] transition-colors hover:bg-[var(--st-surface-2)] hover:text-[var(--st-text)]"
									>
										<svg viewBox="0 0 16 16" class="size-3.5" fill="none" aria-hidden="true">
											<path d="M9.5 3l-4 5 4 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
										</svg>
									</button>
									<span class="text-sm font-medium">
										{pickKind === 'character' ? 'Who is in it' : 'Where it happens'}
									</span>
									<button
										type="button"
										onclick={() => {
											wantTarget = pickKind as 'character' | 'location';
											currentCharacter = null;
											saveSetup();
											shutMenus();
										}}
										class="ml-auto flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-[var(--st-surface-2)] px-3 text-xs font-medium transition-colors hover:bg-[var(--st-line)]"
									>
										<span class="text-sm leading-none">+</span>
										{pickKind === 'character' ? 'New character' : 'New location'}
									</button>
								</div>

								<!-- A grid, not a list. The rows this replaces stopped at three
									 with no way past them; five to a row means twenty faces read
									 in four. -->
								<div class="scroller max-h-[20rem] overflow-y-auto px-3 pt-3.5 pb-3">
									<div class="grid grid-cols-5 gap-x-2 gap-y-3">
										{#each [{ id: '', name: pickKind === 'character' ? 'anyone' : 'anywhere' }, ...kept] as s (s.id)}
											{@const on = pickKind === 'character' ? wantCharacter === s.id : wantLocation === s.id}
											{@const row = sheets.find((x) => x.id === s.id)}
											{@const sheetState = row?.sheet?.state}
											<div class="group relative flex min-w-0 flex-col">
											<button
												type="button"
												role="menuitemradio"
												aria-checked={on}
												title={s.id
													? pickKind === 'character'
														? `shoot this clip with ${s.name}`
														: `shoot this clip in ${s.name}`
													: pickKind === 'character'
														? 'nobody in particular — the clip invents whoever the words describe'
														: 'nowhere in particular — the clip invents wherever the words describe'}
												onclick={() => {
													if (pickKind === 'character') wantCharacter = s.id;
													else wantLocation = s.id;
													saveSetup();
													shutMenus();
												}}
												class="flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-xl pb-1"
											>
												{#if s.id}
													<img
														src="/studio/api/sheet/img/{s.id}"
														alt=""
														class="aspect-square w-full object-cover transition-opacity hover:opacity-80 {pickKind ===
														'character'
															? 'rounded-full'
															: 'rounded-lg'} {on ? 'ring-2 ring-[var(--st-text)]' : ''}"
													/>
												{:else}
													<span
														class="aspect-square w-full ring-1 ring-[var(--st-line)] {pickKind === 'character'
															? 'rounded-full'
															: 'rounded-lg'} {on ? 'ring-2 ring-[var(--st-text)]' : ''}"
													></span>
												{/if}
												<span
													class="max-w-full truncate text-[0.7rem] leading-tight {on
														? 'font-medium text-[var(--st-text)]'
														: 'text-[var(--st-faint)]'}"
												>
													{s.name}
												</span>
											</button>

											{#if s.id}
												<!-- The six views: a quiet dot while they render, and the
												     sheet itself to open once they are there. Not announced
												     anywhere else — this is where you would look for it. -->
												{#if sheetState === 'rendering'}
													<span
														title="the six views are rendering"
														class="beacon pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-[var(--st-accent)]"
													></span>
												{:else if row?.sheet?.file}
													<a
														href="/studio/api/sheet/full/{s.id}"
														target="_blank"
														rel="noreferrer"
														title="open the six views"
														onclick={(e) => e.stopPropagation()}
														class="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-[var(--st-bg)]/80 text-[0.6rem] text-[var(--st-muted)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--st-text)]"
														>⤢</a
													>
												{/if}

												<!-- Two clicks. A face is minutes of GPU time, not a row. -->
												{#if dropArmed === s.id}
													<div class="absolute inset-x-0 bottom-5 flex justify-center gap-1">
														<button
															type="button"
															onclick={(e) => {
																e.stopPropagation();
																dropSheet(s.id);
															}}
															class="cursor-pointer rounded-full bg-[var(--st-bg)] px-2 py-0.5 text-[0.6rem] text-[var(--st-text)]"
															>remove</button
														>
														<button
															type="button"
															onclick={(e) => {
																e.stopPropagation();
																dropArmed = '';
															}}
															class="cursor-pointer rounded-full bg-[var(--st-bg)] px-2 py-0.5 text-[0.6rem] text-[var(--st-faint)]"
															>keep</button
														>
													</div>
												{:else}
													<button
														type="button"
														aria-label="remove {s.name}"
														onclick={(e) => {
															e.stopPropagation();
															dropArmed = s.id;
														}}
														class="absolute top-1 left-1 flex size-5 cursor-pointer items-center justify-center rounded-full bg-[var(--st-bg)]/80 text-[0.7rem] leading-none text-[var(--st-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--st-text)]"
														>×</button
													>
												{/if}
											{/if}
											</div>
										{/each}
									</div>
								</div>

								<!-- ── how they sound ──────────────────────────────────────
									 Here rather than on a screen of its own, because the voice
									 is part of who somebody is and this is where you say who is
									 in the clip. Only for a character: a room does not speak.

									 It is a description, not a recording — the model reads the
									 words. The same sentence pulls the same voice back, which is
									 what makes a two-clip scene sound like one woman instead of
									 two. Empty is a real answer: each clip then picks its own,
									 which is what every clip did before this existed. -->
								{#if pickKind === 'character' && chosenCharacter}
									<div class="flex flex-col gap-2 border-t border-[var(--st-line)] px-3 py-3">
										<!-- One line whatever the name is. A character named from its own
											 description can be sixty characters long, and a label that wraps
											 to two lines pushes the field it belongs to off the bottom. -->
										<label class="flex min-w-0 items-baseline gap-1 text-xs text-[var(--st-muted)]" for="voice-field">
											<span class="shrink-0">How</span>
											<span class="min-w-0 truncate font-medium text-[var(--st-text)]">{chosenCharacter.name}</span>
											<span class="shrink-0">sounds</span>
										</label>
										<input
											id="voice-field"
											type="text"
											bind:value={voiceDraft}
											onblur={saveVoice}
											onkeydown={(e) => {
												if (e.key === 'Enter') {
													e.preventDefault();
													(e.currentTarget as HTMLInputElement).blur();
												}
											}}
											maxlength="240"
											class="min-h-9 w-full rounded-lg bg-[var(--st-surface-2)] px-3 text-sm text-[var(--st-text)] ring-1 ring-[var(--st-line)] outline-none placeholder:text-[var(--st-faint)] focus-visible:ring-2 focus-visible:ring-[var(--st-text)]"
										/>
										<div class="flex flex-wrap gap-1.5">
											{#each VOICE_PRESETS as v (v.label)}
												<button
													type="button"
													onclick={() => {
														voiceDraft = v.text;
														void saveVoice();
													}}
													class="min-h-7 cursor-pointer rounded-full bg-[var(--st-surface-2)] px-2.5 text-[0.7rem] text-[var(--st-muted)] transition-colors hover:bg-[var(--st-line)] hover:text-[var(--st-text)]"
													>{v.label}</button
												>
											{/each}
										</div>
									</div>
								{/if}
							</div>
						{/if}

						<!-- ── one clip or a full production ───────────────────────── -->
						{#if modeOpen}
							<div
								role="menu"
								class="enter absolute bottom-full left-2 z-30 mb-2 w-[19.5rem] max-w-[calc(100vw-3rem)] rounded-2xl bg-[var(--st-surface)] p-2 shadow-[0_16px_44px_rgba(0,0,0,.6)] ring-1 ring-[var(--st-line)]"
							>
								<!-- One list, one question — what this message makes. Two axes on
									 it rather than two modes: versions vary the draw, angles vary
									 the camera, and every message makes the product of the two.
									 "one clip" is 1 x 1 rather than a special case.

									 No subtitles on the two rows. The titles carry it, a popover
									 menu is not a settings list, and beside a count they wrapped to
									 two lines each — which is the clutter this menu has already
									 been cleaned of twice. -->
								<button
									type="button"
									role="menuitemradio"
									aria-checked={mode === 'simple' && effAtOnce === 1}
									onclick={() => {
										setMode('simple');
										takes = 1;
										angles = 1;
										saveSetup();
										shutMenus();
									}}
									class="flex min-h-[2.75rem] w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 text-left text-sm transition-colors hover:bg-[var(--st-surface-2)]"
								>
									<span class="w-3.5 shrink-0 text-xs {mode === 'simple' && effAtOnce === 1 ? '' : 'invisible'}"
										>&#10003;</span
									>
									<span class="min-w-0">one clip</span>
								</button>

								{#each [{ id: 'versions', label: 'versions' }, { id: 'angles', label: 'camera angles' }] as axis (axis.id)}
									{@const mine = axis.id === 'versions' ? takes : angles}
									{@const other = axis.id === 'versions' ? angles : takes}
									<div
										class="flex min-h-[2.75rem] w-full items-center gap-2.5 rounded-xl px-3 text-sm"
									>
										<span
											class="w-3.5 shrink-0 text-xs {mode === 'simple' && mine > 1 ? '' : 'invisible'}"
											>&#10003;</span
										>
										<span
											class="min-w-0 flex-1 whitespace-nowrap {axis.id === 'angles' && !anglesApply
												? 'text-[var(--st-faint)]'
												: ''}">{axis.label}</span
										>
										<span class="flex shrink-0 gap-0.5">
											{#each [1, 2, 3, 4] as n (n)}
												{@const off = axis.id === 'angles' && !anglesApply}
												{@const over = n * other > MAX_AT_ONCE || off}
												<button
													type="button"
													role="menuitemradio"
													aria-checked={mode === 'simple' && !off && mine === n}
													aria-disabled={over}
													onclick={() => {
														if (over) return;
														setMode('simple');
														if (axis.id === 'versions') takes = n;
														else angles = n;
														saveSetup();
													}}
													class="flex size-[1.55rem] items-center justify-center rounded-lg text-xs font-medium tabular-nums transition-colors {mode ===
														'simple' && mine === n
														? 'bg-[var(--st-text)] text-black'
														: over
															? 'cursor-default text-[var(--st-faint)] opacity-25'
															: 'cursor-pointer text-[var(--st-faint)] hover:bg-white/10 hover:text-[var(--st-text)]'}"
													>{n}</button
												>
											{/each}
										</span>
									</div>
								{/each}

								{#if !anglesApply}
									<!-- Said once, under the row it applies to, rather than grey
										 controls with the reason left to be guessed at. And it names
										 the way out: the same continuation on a free start can have
										 angles, because nothing is nailed to the last frame then. -->
									<p class="mt-0.5 mb-1 pl-[2.25rem] text-xs text-[var(--st-faint)]">
										Angles need a free start.
									</p>
								{:else if mode === 'simple' && takes > 1 && effAngles > 1}
									<!-- Only when they actually multiply. Saying "3 clips" under a
										 row that already reads "3" is noise. -->
									<p class="mt-0.5 mb-1 pl-[2.25rem] text-xs tabular-nums text-[var(--st-faint)]">
										{effAtOnce} clips — {effAngles} angles, {takes} versions of each
									</p>
								{/if}
								<div class="my-1 h-px bg-[var(--st-line)]"></div>
								<button
									type="button"
									role="menuitemradio"
									aria-checked={mode === 'advanced'}
									onclick={() => {
										setMode('advanced');
										shutMenus();
									}}
									class="flex min-h-[2.75rem] w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 text-left text-sm transition-colors hover:bg-[var(--st-surface-2)]"
								>
									<span class="w-3.5 shrink-0 text-xs {mode === 'advanced' ? '' : 'invisible'}"
										>&#10003;</span
									>
									<span class="min-w-0">
										<span class="block">full production</span>
										<span class="mt-0.5 block text-xs text-[var(--st-faint)]"
											>screenplay and cast first, then a multi-scene shoot</span
										>
									</span>
								</button>
							</div>
						{/if}

						<!-- ── length, size, frame ─────────────────────────────────── -->
						{#if fmtOpen}
							<!-- One row per question, label left, choices right — the shape an
								 inspector has. Stacked as three headed groups, six durations did
								 not fit the panel's width and 15s fell onto a line of its own, so
								 the block stopped reading as one set. A row per question makes
								 that wrap impossible by construction. -->
							<div
								role="menu"
								class="enter absolute bottom-full left-2 z-30 mb-2 w-[19.5rem] max-w-[calc(100vw-3rem)] overflow-hidden rounded-2xl bg-[var(--st-surface)] shadow-[0_16px_44px_rgba(0,0,0,.6)] ring-1 ring-[var(--st-line)]"
							>
								<div class="flex items-center gap-3 px-3 py-2.5">
									<span class="flex items-center gap-2.5 text-sm whitespace-nowrap text-[var(--st-muted)]">
										<svg viewBox="0 0 16 16" class="size-[15px] shrink-0 opacity-80" fill="none" aria-hidden="true">
											<circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.4" />
											<path d="M8 4.8V8l2.2 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
										</svg>
										Length
									</span>
									<span class="ml-auto flex gap-0.5 rounded-full bg-[var(--st-bg)] p-0.5">
										{#each [5, 6, 8, 10, 12, 15] as sec (sec)}
											<button
												type="button"
												aria-pressed={wantSeconds === sec}
												title="{sec} seconds"
												onclick={() => {
													wantSeconds = sec;
													saveSetup();
												}}
												class="flex min-h-7 min-w-7 cursor-pointer items-center justify-center rounded-full px-1.5 font-mono text-xs tabular-nums transition-colors {wantSeconds ===
												sec
													? 'bg-[var(--st-surface-2)] font-medium text-[var(--st-text)]'
													: 'text-[var(--st-faint)] hover:text-[var(--st-text)]'}">{sec}</button
											>
										{/each}
									</span>
								</div>

								<div class="flex items-center gap-3 px-3 py-2.5 shadow-[inset_0_1px_0_var(--st-line)]">
									<span class="flex items-center gap-2.5 text-sm whitespace-nowrap text-[var(--st-muted)]">
										<svg viewBox="0 0 16 16" class="size-[15px] shrink-0 opacity-80" fill="none" aria-hidden="true">
											<rect x="2" y="4" width="12" height="8" rx="1.4" stroke="currentColor" stroke-width="1.4" />
											<path d="M5 7.5h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
										</svg>
										Size
									</span>
									<span class="ml-auto flex gap-0.5 rounded-full bg-[var(--st-bg)] p-0.5">
										{#each RES_KEYS as r (r)}
											{@const f = frameFor(r, composerShape.portrait ? 'portrait' : 'landscape')}
											<button
												type="button"
												disabled={composerShape.fixed}
												aria-pressed={composerShape.res === r}
												title="{f.width}x{f.height} — bigger frames cost render time"
												onclick={() => {
													wantRes = r;
													saveSetup();
												}}
												class="flex min-h-7 items-center justify-center rounded-full px-2.5 font-mono text-xs tabular-nums transition-colors {composerShape.fixed
													? 'cursor-default opacity-40'
													: 'cursor-pointer'} {composerShape.res ===
												r
													? 'bg-[var(--st-surface-2)] font-medium text-[var(--st-text)]'
													: 'text-[var(--st-faint)] hover:text-[var(--st-text)]'}">{r}</button
											>
										{/each}
									</span>
								</div>

								<div class="flex items-center gap-3 px-3 py-2.5 shadow-[inset_0_1px_0_var(--st-line)]">
									<span class="flex items-center gap-2.5 text-sm whitespace-nowrap text-[var(--st-muted)]">
										<svg viewBox="0 0 16 16" class="size-[15px] shrink-0 opacity-80" fill="none" aria-hidden="true">
											<rect x="2.4" y="3" width="11.2" height="10" rx="1.4" stroke="currentColor" stroke-width="1.4" />
										</svg>
										Frame
									</span>
									<!-- The one place a glyph beats the label: the thing being chosen
										 IS a shape, and two rectangles say it faster than 9:16 does. -->
									<span class="ml-auto flex gap-0.5 rounded-full bg-[var(--st-bg)] p-0.5">
										{#each [['portrait', '9:16', 'h-3 w-2'], ['landscape', '16:9', 'h-2 w-3.5']] as [val, label, box] (val)}
											<button
												type="button"
												disabled={composerShape.fixed}
												aria-pressed={(composerShape.portrait ? 'portrait' : 'landscape') === val}
												title={label}
												onclick={() => {
													wantOrientation = val as 'portrait' | 'landscape';
													saveSetup();
												}}
												class="flex min-h-7 items-center gap-1.5 rounded-full px-2.5 font-mono text-xs tabular-nums transition-colors {composerShape.fixed
													? 'cursor-default opacity-40'
													: 'cursor-pointer'} {(composerShape.portrait ? 'portrait' : 'landscape') ===
												val
													? 'bg-[var(--st-surface-2)] font-medium text-[var(--st-text)]'
													: 'text-[var(--st-faint)] hover:text-[var(--st-text)]'}"
											>
												<span class="block rounded-[2px] border border-current {box}"></span>
												{label}
											</button>
										{/each}
									</span>
								</div>
							</div>
						{/if}
						{#if pendingPhoto}
							<!-- Held, not sent. A description is written after the picture is
								 chosen at least as often as before it, so the upload waits here
								 and takes whatever is in the box when send is pressed. -->
							<div class="mb-1.5 flex items-center gap-2">
								<span
									class="flex min-w-0 items-center gap-1.5 rounded-full bg-[var(--st-surface-2)] px-2.5 py-1 text-xs text-[var(--st-text)]"
								>
									<span class="truncate">{pendingPhoto.name}</span>
									<button
										type="button"
										aria-label="drop the photo"
										onclick={() => (pendingPhoto = null)}
										class="cursor-pointer text-[var(--st-faint)] hover:text-[var(--st-text)]">×</button
									>
								</span>
								<span class="text-xs text-[var(--st-faint)]">
									describe {wantTarget === 'location' ? 'the place' : 'them'} if you like, then send
								</span>
							</div>
						{/if}
						<!-- One row: the way in, the sentence, the mode, the send. Everything
							 that used to sit under this in three rows of chips either became a
							 chip above (because you chose it) or moved into the menu on the left
							 (because you had not). -->
						<div class="flex items-end gap-1.5">
							{#if mode === 'simple' && wantTarget === 'clip'}
								<button
									type="button"
									aria-label="add a character, a location or a reference image"
									aria-expanded={addOpen}
									onclick={() => {
										const open = !addOpen && pickKind === null;
										shutMenus();
										addOpen = open;
									}}
									class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--st-muted)] transition-colors hover:bg-[var(--st-bg)] hover:text-[var(--st-text)]"
								>
									<svg viewBox="0 0 16 16" class="size-[1.05rem]" fill="none" aria-hidden="true">
										<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
									</svg>
								</button>
							{:else}
								<!-- In a creation state there is nothing to pick between, so the
									 paperclip is the whole menu and stands on its own. -->
								<label
									title={wantTarget === 'character'
										? 'Use a picture you already have as this character'
										: wantTarget === 'location'
											? 'Use a picture you already have as this location'
											: 'Attach a face, a room, a movement for the render to copy'}
									class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--st-muted)] transition-colors hover:bg-[var(--st-bg)] hover:text-[var(--st-text)]"
								>
									<svg viewBox="0 0 20 20" class="size-4" fill="none" aria-hidden="true">
										<path
											d="M13 7l-5.5 5.5a2.1 2.1 0 003 3L16 10a3.5 3.5 0 00-5-5l-5.5 5.5a5 5 0 007 7L18 12"
											stroke="currentColor"
											stroke-width="1.6"
											stroke-linecap="round"
											stroke-linejoin="round"
										/>
									</svg>
									<span class="sr-only">use a picture you already have</span>
									<input
										type="file"
										accept="image/*"
										class="hidden"
										disabled={refBusy}
										onchange={(e) => {
											const el = e.currentTarget as HTMLInputElement;
											holdPhoto(el.files);
											el.value = '';
										}}
									/>
								</label>
							{/if}

							<label class="sr-only" for="composer">Message</label>
							<textarea
								id="composer"
								bind:this={composer}
								bind:value={input}
								rows="1"
								spellcheck="false"
								placeholder={composerPlaceholder}
								oninput={(e) => grow(e.currentTarget)}
								onkeydown={(e) => {
									// Enter sends, Shift+Enter breaks the line.
									if (e.key === 'Enter' && !e.shiftKey) {
										e.preventDefault();
										submit();
									}
								}}
								class="block max-h-56 min-h-9 w-full flex-1 resize-none border-0 bg-transparent px-2 py-2 text-[1.05rem] leading-relaxed outline-none focus:ring-0 placeholder:text-[var(--st-faint)]"
							></textarea>

							{#if mode === 'advanced' && !planningWs}
								<!-- Scene count is the planning chain's knob: it decides how many
									 documents get written and how many clips get scheduled. It has
									 no simple-mode counterpart, so it sits here rather than in the
									 menu, which is about what a clip is made with. -->
								<div class="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--st-bg)] p-0.5">
									{#each SCENE_CHOICES as n (n)}
										<button
											type="button"
											aria-pressed={sceneCount === n}
											title="{n} scenes"
											class="size-7 cursor-pointer rounded-full text-xs tabular-nums transition-colors {sceneCount ===
											n
												? 'bg-[var(--st-surface-2)] font-semibold text-[var(--st-text)]'
												: 'text-[var(--st-faint)] hover:text-[var(--st-text)]'}"
											onclick={() => {
												sceneCount = n;
												if (brief) brief.sceneCount = n;
											}}>{n}</button
										>
									{/each}
								</div>
							{/if}

							<button
								type="button"
								aria-label="send"
								disabled={sending || (!input.trim() && !pendingPhoto)}
								onclick={submit}
								class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--st-accent)] text-[var(--st-on-accent)] transition-colors hover:bg-[var(--st-accent-strong)] disabled:cursor-default disabled:bg-[var(--st-surface-2)] disabled:text-[var(--st-faint)]"
							>
								{#if sending}
									<span class="text-xs">…</span>
								{:else}
									<svg viewBox="0 0 20 20" class="h-4 w-4" fill="none" aria-hidden="true">
										<path
											d="M10 16V4M10 4l-5 5M10 4l5 5"
											stroke="currentColor"
											stroke-width="2"
											stroke-linecap="round"
											stroke-linejoin="round"
										/>
									</svg>
								{/if}
							</button>
						</div>
					</div>

				</div>
			</div>

			<!-- ── desktop task rail ────────────────────────────────────────── -->
			{#if brief}
				<aside class="hidden min-h-0 lg:block">
					<div
						class="scroller max-h-full overflow-y-auto rounded-2xl bg-[var(--st-surface)] p-5"
					>
						<p class="text-[10px] font-bold tracking-[0.25em] text-[var(--st-faint)] uppercase">
							the production
						</p>
						{#if pollingActive && startedAt}
							<p class="mt-1 text-xs text-[var(--st-faint)]">{elapsedLabel(now - startedAt)}</p>
						{:else if staleRun}
							<p class="mt-1 text-xs text-[var(--st-faint)]">not running</p>
						{/if}
						<div class="mt-4">
							{@render railList()}
						</div>

						<!-- Beneath the list, not above it: reaching for this means having
						     read the list and decided the run is not worth continuing. -->
						{#if pollingActive}
							<div class="mt-5 border-t border-[var(--st-line)] pt-4">
								{#if !stopArmed}
									<button
										type="button"
										class="cursor-pointer text-xs text-[var(--st-faint)] underline-offset-4 transition-colors hover:text-[var(--st-text)] hover:underline"
										onclick={() => (stopArmed = true)}
									>
										stop this production
									</button>
								{:else}
									<p class="text-xs leading-relaxed text-[var(--st-muted)]">
										This releases the GPU and clears the queue. It cannot be resumed —
										a new run starts from the plan again.
									</p>
									<div class="mt-2.5 flex items-center gap-3">
										<button
											type="button"
											disabled={stopping}
											onclick={stopRun}
											class="btn btn-secondary btn-sm"
										>
											{stopping ? 'stopping…' : 'stop it'}
										</button>
										<button
											type="button"
											class="cursor-pointer text-xs text-[var(--st-faint)] hover:text-[var(--st-text)]"
											onclick={() => (stopArmed = false)}
										>
											keep going
										</button>
									</div>
								{/if}
							</div>
						{/if}
					</div>
				</aside>
			{/if}
		</div>
	</div>
	</main>

	<!-- The rail takes 16rem off the left when it opens; this gives the same back
		 on the right, so the reading column's centre stays on the screen's centre
		 and opening the rail moves nothing. On a desktop the rail never reaches
		 the column anyway, and a page that jumps sideways when you reveal a list
		 punishes you for looking.

		 A spacer rather than a padding rule on main: the rule has to be
		 conditional, and a conditional Tailwind variant is not reliably found by
		 the scanner while a scoped attribute selector is dropped by Svelte's
		 pruner. Both failed silently. This is static classes inside an if, which
		 cannot. Below lg the rail is an overlay and owes nothing. -->
	{#if sidebarOpen}
		<div class="hidden w-64 shrink-0 lg:block" aria-hidden="true"></div>
	{/if}

	<!-- ── the film viewer ────────────────────────────────────────────────────────
		 Watch the cut before paying to assemble it. One clip at a time, chained on
		 `ended`, with the reel along the bottom saying where you are. No keep and
		 no add: nothing here is a draft you are choosing between. -->
	{#if filmAt !== null && film[filmAt]}
		{@const shot = film[filmAt]}
		<div
			class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/92 px-6 py-12 backdrop-blur-[28px]"
			role="dialog"
			aria-modal="true"
			aria-label="the film"
		>
			<button
				type="button"
				aria-label="close"
				onclick={shutFilmViewer}
				class="absolute top-5 right-5 flex size-11 cursor-pointer items-center justify-center rounded-full bg-white/10 text-sm text-[var(--st-text)] backdrop-blur-md transition-colors hover:bg-white/20"
			>
				✕
			</button>
			{#if film.length > 1}
				<button
					type="button"
					aria-label="previous shot"
					onclick={() => stepFilm(-1)}
					class="absolute top-1/2 left-6 hidden size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-xl text-[var(--st-text)] backdrop-blur-md transition-colors hover:bg-white/20 sm:flex"
				>
					‹
				</button>
				<button
					type="button"
					aria-label="next shot"
					onclick={() => stepFilm(1)}
					class="absolute top-1/2 right-6 hidden size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-xl text-[var(--st-text)] backdrop-blur-md transition-colors hover:bg-white/20 sm:flex"
				>
					›
				</button>
			{/if}

			<div class="lift stage overflow-hidden rounded-2xl bg-black shadow-[0_24px_70px_rgba(0,0,0,.6)]">
				{#key filmKey(shot)}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						src={fileUrl(shot.workspace, shot.artifact, shot.file)}
						controls
						autoplay
						playsinline
						preload="auto"
						onended={nextShot}
						class="video-with-controls block aspect-video w-full bg-black"
					></video>
				{/key}
			</div>

			<div class="lift stage mt-4 flex flex-wrap items-center gap-2">
				<span class="text-[13px] font-medium text-[var(--st-text)]">The film</span>
				<span class="text-xs tabular-nums text-[var(--st-faint)]">
					shot {filmAt + 1} of {film.length} · {filmSeconds}s
				</span>
			</div>

			{#if film.length > 1}
				<div class="lift stage mt-4 flex justify-center gap-1.5 overflow-x-auto">
					{#each film as c, i (filmKey(c))}
						<button
							type="button"
							aria-label="shot {i + 1}"
							aria-current={i === filmAt}
							onclick={() => (filmAt = i)}
							class="aspect-video w-[min(16rem,22vw)] min-w-[6rem] shrink-0 cursor-pointer overflow-hidden rounded-lg bg-[var(--st-surface)] transition-opacity {i ===
							filmAt
								? 'opacity-100 shadow-[inset_0_0_0_2px_var(--st-text)]'
								: 'opacity-50 hover:opacity-80'}"
						>
							<!-- svelte-ignore a11y_media_has_caption -->
							<video
								src={fileUrl(c.workspace, c.artifact, c.file)}
								muted
								loop
								playsinline
								preload="auto"
								use:looping
								class="h-full w-full bg-black object-cover"
							></video>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	{/if}

	<!-- ── the takes viewer ───────────────────────────────────────────────────────
		 The room for choosing. The clip is 1024 across in here, which is the width
		 it was rendered at, so this is the one place it is never resampled — the
		 transcript column tops out at 720. On a short window the picture gives way
		 first and the bar and the filmstrip stay put, because a viewer you cannot
		 reach the controls of is not a viewer. -->
	{#if takesAt}
		{@const item = chat.find((c) => c.id === takesAt?.id)}
		{@const runs = readyTakes(takesAt.id)}
		{@const run = runs.find((r) => r.index === takesAt?.index)}
		{#if item && run?.clip}
			{@const row = logRow[run.clip.workspace]}
			<div
				class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/92 px-6 py-12 backdrop-blur-3xl"
				role="dialog"
				aria-modal="true"
				aria-label="the takes of this beat"
			>
				<button
					type="button"
					aria-label="close"
					onclick={shutTake}
					class="absolute top-5 right-5 flex size-11 cursor-pointer items-center justify-center rounded-full bg-white/10 text-sm text-[var(--st-text)] backdrop-blur-md transition-colors hover:bg-white/20"
				>
					✕
				</button>
				{#if runs.length > 1}
					<button
						type="button"
						aria-label="previous take"
						onclick={() => stepTake(-1)}
						class="absolute top-1/2 left-6 hidden size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-xl text-[var(--st-text)] backdrop-blur-md transition-colors hover:bg-white/20 sm:flex"
					>
						‹
					</button>
					<button
						type="button"
						aria-label="next take"
						onclick={() => stepTake(1)}
						class="absolute top-1/2 right-6 hidden size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/10 text-xl text-[var(--st-text)] backdrop-blur-md transition-colors hover:bg-white/20 sm:flex"
					>
						›
					</button>
				{/if}

				<div

					class="lift stage overflow-hidden rounded-2xl bg-black shadow-[0_24px_70px_rgba(0,0,0,.6)]"

					ontouchstart={swipeStart}

					ontouchend={swipeEnd}

				>
					<!-- Keyed so that stepping to another take replaces the element rather
						 than swapping its src: a <video> handed a new src keeps the old
						 frame on screen until the new one decodes, which reads as the arrow
						 having done nothing. -->
					{#key run.slug}
						<!-- svelte-ignore a11y_media_has_caption -->
						<video
							src={fileUrl(run.clip.workspace, run.clip.artifact, run.clip.file)}
							controls
							autoplay
							muted
							loop
							playsinline
							preload="auto"
							class="video-with-controls block aspect-video w-full bg-black"
						></video>
					{/key}
				</div>

				<div class="lift stage mt-4 flex flex-wrap items-center gap-2">
					<span class="text-[13px] font-medium tabular-nums text-[var(--st-text)]"
						>Take {run.index}</span
					>
					{#if row}
						<span class="text-xs tabular-nums text-[var(--st-faint)]">seed {row.seed}</span>
					{/if}
					<span class="flex-1"></span>
					<!-- On the take you already kept there is nothing to press: a button
						 that repeats a decision you have made is a control that does
						 nothing, dressed as one that does something. -->
					{#if item.takes?.kept === run.index}
						<span class="text-xs text-[var(--st-faint)]">kept</span>
					{:else}
						<button
							type="button"
							onclick={() => keepTake(item.id, run.index)}
							class="cursor-pointer rounded-full bg-[var(--st-text)] px-3.5 py-1.5 text-xs font-medium text-black transition-colors hover:bg-white"
						>
							use this take
						</button>
					{/if}
					{#if run.clip}
						{@const already = film.some((x) => filmKey(x) === filmKey(run.clip!))}
						{#if already}
							<span class="flex items-center gap-1.5 text-xs text-[var(--st-faint)]">
								<span aria-hidden="true">✓</span><span>in the film</span>
							</span>
						{:else}
							<button
								type="button"
								onclick={() => addClipToFilm(run.clip!, `Take ${run.index}`)}
								class="cursor-pointer rounded-full bg-white/10 px-3.5 py-1.5 text-xs text-[var(--st-text)] transition-colors hover:bg-white/20"
								>add to film</button
							>
						{/if}
					{/if}
				</div>

				{#if runs.length > 1}
					<div class="st-takes st-film lift stage mt-4" data-n={runs.length}>
						{#each runs as r (r.slug)}
							{@render takeTile(item, r, true)}
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	{/if}
</div>


<style>
	/* The one moving thing on the page, and it earns it: during a render nothing
	   else changes for minutes, so stillness would read as a hang. Anyone who has
	   asked the system to stop animating gets a static ring instead — the state
	   is already carried by the shape and the word beside it. */
	.spin {
		animation: st-spin 0.9s linear infinite;
	}

	/* The takes grid, in :global for the reason the sidebar spacer above
	   documents twice over: the pruner drops scoped attribute selectors and the
	   Tailwind scanner does not reliably find a conditionally built variant.
	   Both failed silently the last time. A phone gets two columns whatever the
	   count — three across at 375px is a 113px tile, too small to judge motion
	   in — and above that the grid is as wide as the batch. */
	:global(.st-takes) {
		display: grid;
		gap: 0.375rem;
		grid-template-columns: repeat(2, 1fr);
	}
	@media (min-width: 640px) {
		:global(.st-takes[data-n='3']) {
			grid-template-columns: repeat(3, 1fr);
		}
		:global(.st-takes[data-n='4']) {
			grid-template-columns: repeat(4, 1fr);
		}
	}

	/* The viewer's filmstrip is a way back to the other takes, not a second place
	   to judge them — the picture above it is that. So its tiles are capped and
	   the row is centred: without the cap a batch of two put two 509px thumbnails
	   under a 1024px stage, which reads as three players stacked rather than one
	   picture and its index. Four takes are unaffected; they were already 251. */
	:global(.st-takes.st-film) {
		justify-content: center;
		grid-template-columns: repeat(2, minmax(0, 16rem));
	}
	@media (min-width: 640px) {
		:global(.st-takes.st-film[data-n='3']) {
			grid-template-columns: repeat(3, minmax(0, 16rem));
		}
		:global(.st-takes.st-film[data-n='4']) {
			grid-template-columns: repeat(4, minmax(0, 16rem));
		}
	}

	/* Two tiny frames — a reel, at chip scale. */
	.reelmark {
		position: relative;
		width: 0.85rem;
		height: 0.6rem;
		display: inline-block;
	}
	.reelmark::before,
	.reelmark::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		width: 0.36rem;
		border-radius: 2px;
		background: var(--st-muted);
	}
	.reelmark::before {
		left: 0;
	}
	.reelmark::after {
		right: 0;
	}

	/* The seam between two shots. A hairline gap where they match, a dotted rule
	   where they do not — the cut will jump there, and playback should not be the
	   first place that becomes apparent. */
	.seam-jump::after {
		content: '';
		position: absolute;
		left: 50%;
		top: 14%;
		bottom: 14%;
		width: 1px;
		background: repeating-linear-gradient(var(--st-faint) 0 2px, transparent 2px 5px);
	}

	/* The reel scrolls without a bar of its own. */
	.reel {
		scrollbar-width: none;
	}
	.reel::-webkit-scrollbar {
		display: none;
	}

	/* A take still on the GPU. Global, because the class is only ever produced by
	   an expression and Svelte's pruner drops what it cannot see in the markup —
	   the same silent failure the sidebar spacer above documents. */
	:global(.st-waiting) {
		animation: st-breathe 2.6s ease-in-out infinite;
	}
	@keyframes st-breathe {
		0%,
		100% {
			opacity: 0.45;
		}
		50% {
			opacity: 0.8;
		}
	}

	/* 64rem is 1024px, which is the width the clips are rendered at, so the
	   viewer shows one at 1:1 and never resamples it. The transcript column tops
	   out at 720. Below that the height decides: the picture gives way first so
	   the bar and the filmstrip cannot be pushed off a short window — a viewer
	   whose controls are off-screen is worse than no viewer. */
	.stage {
		width: min(64rem, 100%, calc((100dvh - 19rem) * 16 / 9));
	}

	/* The sheet curve: slow out, no bounce. */
	.lift {
		animation: st-lift 0.26s cubic-bezier(0.32, 0.72, 0, 1) both;
	}
	@keyframes st-lift {
		from {
			opacity: 0;
			transform: scale(0.965);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		:global(.st-waiting),
		.lift {
			animation: none;
		}
	}
	@keyframes st-spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spin {
			animation: none;
		}
	}

	/* The studio wears the ratemyd brand: the app's own near-black surfaces, coral
	 * accent and type pairing. The --st-* names stay as the component's internal
	 * vocabulary so the markup never hardcodes a colour — only this block maps
	 * them onto the app tokens, which is also what makes a future re-theme a
	 * six-line edit. --st-surface-2 and --st-faint have no app-level counterpart:
	 * they are the one step of lift above a card and the one step below muted,
	 * derived from the same ramp. No glows anywhere: depth is fills and spacing,
	 * per the house rules. */
	.studio {
		--st-bg: var(--color-bg);
		--st-surface: var(--color-surface);
		--st-surface-2: var(--color-surface-2);
		--st-line: var(--color-border);
		/* The one border that has to be seen rather than felt: where a 1px edge is
		 * the only thing identifying a control. Decoration keeps --st-line. */
		--st-line-control: #4c4c52;
		--st-text: var(--color-text);
		--st-muted: var(--color-muted);
		--st-faint: var(--color-faint);
		--st-accent: var(--color-coral);
		--st-green: var(--color-green);
		--st-accent-strong: var(--color-coral-dark);
		/* What sits on top of a filled accent surface. The accent is white now, so
		 * this is the one that had to move with it. */
		--st-on-accent: var(--color-on-accent);
		background: var(--st-bg);
		color: var(--st-text);
		font-family: var(--font-body);
	}

	/* Headings and the wordmark carry the display face, the way they do across
	 * the product. Body copy — including the generated prose, which is the thing
	 * people actually read here — stays on the body face. */
	.studio :global(h1),
	.studio :global(h2),
	.studio :global(h3) {
		font-family: var(--font-display);
	}

	/* The two scroll regions: a thin, unobtrusive bar that matches the surface
	 * rather than the OS default light one. Firefox gets the standard property,
	 * WebKit/Blink the pseudo-elements. */
	/* Opacity only — a colour glow would be a neon halo, which the house rules
	   forbid. Slow enough to read as breathing, not as an alarm. */
	.beacon {
		animation: beacon 1.8s ease-in-out infinite;
	}
	@keyframes beacon {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.35;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.beacon {
			animation: none;
		}
	}

	/* The cursor at the end of a sentence that is still arriving. Opacity only,
	   same rule as the beacon — and a blinking block is the oldest signal there
	   is for "there is more of this coming". */
	.caret {
		display: inline-block;
		width: 0.45em;
		height: 1em;
		margin-left: 0.12em;
		vertical-align: -0.14em;
		background: var(--st-muted);
		animation: caret 1.1s steps(1, end) infinite;
	}
	@keyframes caret {
		0%,
		55% {
			opacity: 1;
		}
		56%,
		100% {
			opacity: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.caret {
			animation: none;
			opacity: 0.6;
		}
	}

	.scroller {
		scrollbar-width: thin;
		scrollbar-color: var(--st-line) transparent;
	}
	.scroller::-webkit-scrollbar {
		width: 10px;
	}
	.scroller::-webkit-scrollbar-track {
		background: transparent;
	}
	.scroller::-webkit-scrollbar-thumb {
		background: var(--st-line);
		border: 3px solid transparent;
		background-clip: content-box;
		border-radius: 999px;
	}

	/* Generated text is markdown-ish prose: keep the author's line breaks, keep
	 * the measure readable. */
	.doc {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* Collapsed document: roughly twelve lines, then a fade into the card's own
	 * fill. The gradient is the surface color, not a colored halo. */
	.clamp {
		max-height: 21rem;
		overflow: hidden;
	}
	.clamp::after {
		content: '';
		position: absolute;
		inset-inline: 0;
		bottom: 0;
		height: 4.5rem;
		background: linear-gradient(to bottom, transparent, var(--st-surface));
		pointer-events: none;
	}

	/* Things arrive during a long wait; they should settle in rather than pop.
	 * One animation for the whole page, and none of it for anyone who asked the
	 * OS to stop moving things. */
	.enter {
		animation: enter 0.45s cubic-bezier(0.25, 1, 0.5, 1) both;
	}
	@keyframes enter {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.enter {
			animation: none;
		}
	}
</style>
