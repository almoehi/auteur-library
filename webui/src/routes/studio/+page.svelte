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
	 *    /studio/api/harness        — POST proxy (poll-state, chat, reset-task…)
	 *    /studio/api/file           — raw artifact bytes, same-origin (the harness
	 *                          itself sends no CORS headers)
	 */
	// Aliased: this file already has a tick(id) of its own for the poll loop.
	import { onMount, tick as flush, untrack } from 'svelte';
	import { trackClipReady } from '$lib/analytics';
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
	/** The cadence while the answer is expected, and the share of the typical
	 *  wait it starts at. A render moves nothing for minutes, so `quiet` always
	 *  reaches its cap and the loop settles on POLL_SLOW_MS — which means a clip
	 *  that has finished can sit unnoticed for a full thirty seconds.
	 *
	 *  Half, not three quarters. The last dozen renders in the harness log ran
	 *  246, 254, 285, 305, 395, 426, 426, 436, 458 and 686 seconds — a median
	 *  around 410, with the quickest finishing at 0.60 of it. A window opening at
	 *  0.7 would therefore miss exactly the fast runs, which are the ones where a
	 *  thirty-second tail is the largest share of the wait.
	 *
	 *  Eight seconds rather than five for what it costs: five would shave another
	 *  1.5s off the average lag and ask half again as many times. See pollDelay
	 *  for the bound at the other end. */
	const POLL_CLOSING_MS = 8_000;
	const CLOSING_FROM = 0.5;

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
		{
			task: 'write_art_direction',
			artifact: 'art_direction',
			doc: 'artDirection',
			label: 'Art direction'
		},
		{
			task: 'write_visual_bible',
			artifact: 'visual_bible',
			doc: 'visualBible',
			label: 'Visual bible'
		}
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
		'a latino man jerking off over a naked blonde lying in front of him',
		'two guys alone in the gym showers, one jerking the other off',
		"two women in their twenties in a pool at night, one licking the other's breasts"
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
				body: JSON.stringify({
					slug,
					title: title.slice(0, 80) || 'New session',
					pitch: title.slice(0, 200)
				})
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
		const tasks = (renderPoll?.tasks ?? []).filter((t) =>
			/shoot[_ ]?scene/i.test(t.key ?? t.title ?? '')
		);
		const arts = renderPoll?.artifacts ?? [];
		return tasks
			.map((t) => {
				const n = sceneNo(t.key ?? '', t.title ?? '');
				const art = arts.find(
					(a) => sceneNo(a.key ?? '', a.name ?? '') === n && /clip/i.test(a.key ?? '')
				);
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
		const ids = [planningWs, renderWs].filter((w): w is string => !!w);
		// A clip run has no brief, and used to have no way out.
		//
		// This required a slug, which only a full production has — so on the stage
		// the only stop was the studio's own api/stop called by hand, and the page
		// went on counting over a render that had already been torn down. A run
		// with a live workspace id is stoppable whether or not anything wrote a
		// plan for it.
		if ((!b?.slug && !ids.length) || stopping) return;
		stopping = true;
		try {
			const res = await fetch('/studio/api/stop', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				// Ids when the run has them, the slug only as the planning path's
				// fallback — and by here one of the two exists.
				body: JSON.stringify(ids.length ? { workspaces: ids } : { slug: b!.slug })
			});
			const d = (await res.json()) as { ok: boolean; removed?: number; torndown?: boolean };

			// Stop polling before saying anything: a tick that lands after the
			// message would re-report the run as alive.
			runId += 1;
			pollingActive = false;
			// And the stage, which counts on its own clock. Left set, the loader
			// carried on over a torn-down run — which is the state this whole
			// button exists to leave.
			stageStartedAt = 0;
			stageWaitFrom = '';
			stageWaitBlurUrl = '';
			sending = false;
			renderWs = '';
			startedAt = 0;

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
		const res = await fetch('/studio/api/harness', {
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
		return `/studio/api/file?${q.toString()}`;
	}

	/** The same url, asked to land on a frame.
	 *
	 *  A <video> shows its first decoded frame, and iOS Safari decodes nothing
	 *  until something plays. `preload="metadata"` fetches the duration and
	 *  stops, so a tile that never plays is a black rectangle — which is what
	 *  every thumbnail here has always been on a phone, the clock in the corner
	 *  reading 0:05 over the black to prove the file was fine all along.
	 *
	 *  Playing them is not the fix, because permission to play is exactly what
	 *  gets withdrawn: Low Power Mode blocks muted autoplay outright, and a
	 *  picture that vanishes when the battery is low is not a picture. A media
	 *  fragment makes a frame the destination instead — the element seeks there
	 *  on load and paints it, with or without permission to play, and the tiles
	 *  that do autoplay still autoplay. The file route already answers ranged
	 *  requests with 206, which is what the seek needs.
	 *
	 *  A tenth of a second rather than zero: on some encodes nothing is
	 *  decodable at the very first timestamp and the seek lands on nothing. */
	function still(url: string): string {
		return `${url}#t=0.1`;
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
		void fetch(`/studio/api/file?${q.toString()}`).catch(() => {});
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
	const promptOverdue = $derived(!!typicalPrompt && sendingFor * 1000 > typicalPrompt * OVERDUE);
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
	const showExamples = $derived(!brief && !sending && chat.every((c) => c.id === welcomeId));

	/** Somebody put themselves in the shot, and there is no picture of them.
	 *
	 *  Three quarters of the people who answered the survey want to be in the clip
	 *  and the prompts show them trying: "me and a woman I just met", "Your
	 *  apartment, late night", "Quero medir meu pau". What the model does with
	 *  that is invent a person — and the measurement that matters here is that
	 *  invented content is exactly what destroys a likeness, one made-up detail at
	 *  a time. So the clip comes back, and it is not them, and nothing said it was
	 *  never going to be.
	 *
	 *  This asks. It does not block: the button underneath still says generate and
	 *  still works, because a person who meant "someone like me" is not wrong and
	 *  should not have to argue with a dialog. It is an offer with the consequence
	 *  attached, which is the only honest shape for it — the accounts that
	 *  attached a reference rendered something 63% of the time against 9% for
	 *  those that did not, so this is also the moment most likely to turn a
	 *  visitor into somebody who finishes.
	 *
	 *  Pronouns in the four languages the operators actually write in. A false
	 *  positive costs one tap; a missed one costs a render and a disappointment. */
	const SELF_WORDS =
		/(?:^|[^\p{L}])(?:i|i'm|im|me|my|myself|mine|you|you're|your|yourself|én|engem|nekem|velem|rám|rajtam|te|téged|neked|veled|rád|yo|mí|conmigo|tú|ti|contigo|eu|meu|minha|comigo|você)(?:[^\p{L}]|$)/iu;

	/** What the studio had to make up, and could ask about instead.
	 *
	 *  One mechanism, six shapes of the same fault: a brief that invents more than
	 *  it was told. The measurement underneath all of them is the same — invented
	 *  content is what destroys a likeness, one made-up detail at a time — and the
	 *  cheapest moment to catch it is before the GPU, not after.
	 *
	 *    blocked   an age that cannot be rendered at all. Not a question: this one
	 *              refuses, in the one place on this surface that is allowed to be
	 *              red, and asks for a different shot.
	 *    self      "me", "my" — themselves in it, with no picture of themselves.
	 *              The answer is a reference, so the offer is to attach one.
	 *    who       "you", "your" — somebody addressed, and nobody kept. The answer
	 *              is not a photo, it is a name: who is this supposed to be.
	 *    sheet     a character sheet typed into a shot box. Eight of a hundred and
	 *              eighteen opened with `subject_definitions:`. It is long and it
	 *              is third person, so nothing else here catches it.
	 *    no-words  a picture arrived and nothing was typed, so the filename is the
	 *              whole prompt.
	 *    too-short a subject, not a shot: under four words there is no place, no
	 *              action and no camera, so all three get made up.
	 *
	 *  Only on the first round, and never on a continuation — except `blocked`,
	 *  which is not a matter of how far into a conversation anybody is. A short
	 *  line later is a refinement ("faster", "closer"), and answering that with a
	 *  question about what happens would be the studio failing to follow itself. */
	let selfAnswered = $state<Record<string, boolean>>({});
	/** Pressing generate answers it: they meant what they wrote. */
	function selfAnsweredBySending(id: string) {
		selfAnswered[id] = true;
	}

	const FILENAME_ONLY = /^[\w .()-]+\.(?:jpe?g|png|webp|heic|gif|mp4|mov|webm)$/i;
	const FIRST_PERSON =
		/(?:^|[^\p{L}])(?:i|i'm|im|me|my|myself|mine|én|engem|nekem|velem|rám|yo|mí|conmigo|eu|meu|minha|comigo)(?:[^\p{L}]|$)/iu;
	const SECOND_PERSON =
		/(?:^|[^\p{L}])(?:you|you're|your|yourself|te|téged|neked|veled|rád|tú|ti|contigo|você|teu|tua)(?:[^\p{L}]|$)/iu;
	const SHEET_FORMAT = /^\s*subject_definitions\b|<Subject \d>|<Picture \d>/i;

	/** An age this cannot render, in any wording.
	 *
	 *  Deliberately narrow and deliberately deterministic. It is the front door,
	 *  not the lock: `minors.server.ts` still runs on the input AND the output at
	 *  both prompt endpoints, and that is what actually refuses. What this adds is
	 *  the answer arriving before a round trip, in words, on the screen where the
	 *  sentence was typed — "A small teen with Open mouth" came through the real
	 *  studio and the operator learned nothing from what happened next. */
	const UNDER_AGE =
		/(?:^|[^\p{L}])(?:teen|teens|teenage[rd]?|schoolgirl|schoolboy|preteen|underage|minor|child|kid|loli|jailbait|kislány|kisfiú|tini|tinédzser|serdülő|niña|niño|adolescente|menina|menino)(?:[^\p{L}]|$)|(?:^|[^\d])(?:1[0-7])\s*(?:years?[- ]old|yo|éves|años|anos)/iu;

	/** What a thin line is missing, named rather than asked for in general.
	 *
	 *  "Say more" is not help. What helps is the two or three things this
	 *  particular sentence does not have — and the checks are crude on purpose,
	 *  because a wrong suggestion costs a glance and a missing one costs a
	 *  render. */
	const HAS_PLACE =
		/\b(room|bed|bedroom|kitchen|bathroom|shower|office|hotel|car|pool|beach|sofa|couch|desk|floor|stairs|garden|club|gym|street|window|wall|table|szoba|ágy|konyha|fürdő|zuhany|iroda|hotel|autó|medence|kanapé)\b/i;
	const HAS_CAMERA =
		/\b(camera|close[- ]?up|pov|wide|angle|shot from|behind|over the shoulder|handheld|slow|zoom|frame|lens|kamera|közeli|hátulról)\b/i;
	function missingBits(said: string): ('character' | 'place' | 'action' | 'camera')[] {
		const out: ('character' | 'place' | 'action' | 'camera')[] = [];
		if (!chosenCharacter && !refFiles.length) out.push('character');
		if (!HAS_PLACE.test(said)) out.push('place');
		out.push('action');
		if (!HAS_CAMERA.test(said)) out.push('camera');
		return out;
	}

	type AskKind = 'blocked' | 'self' | 'who' | 'sheet' | 'no-words' | 'too-short';
	const askAbout = $derived.by<{
		id: string;
		kind: AskKind;
		missing: ReturnType<typeof missingBits>;
	} | null>(() => {
		if (mode !== 'simple' || wantTarget !== 'clip') return null;
		const rounds = chat.filter((c) => c.kind === 'confirm' && c.confirm);
		const last = rounds.at(-1);
		if (!last?.confirm || selfAnswered[last.id] || last.confirm.sent) return null;
		const said = (last.confirm.said ?? '').trim();
		const at = (kind: AskKind) => ({ id: last.id, kind, missing: missingBits(said) });

		// Refusal first, and on every round: an age does not become renderable
		// because it arrived late in a conversation.
		if (UNDER_AGE.test(said)) return at('blocked');
		if (continuing) return null;

		if (FILENAME_ONLY.test(said)) return at('no-words');
		if (SHEET_FORMAT.test(said)) return at('sheet');

		const words = said.split(/\s+/).filter(Boolean).length;
		if (rounds.length === 1 && words > 0 && words < 4) return at('too-short');

		// Themselves in it, or somebody addressed and nobody kept. A picture or a
		// kept face answers the first; only a name answers the second.
		if (refFiles.length || chosenCharacter) return null;
		if (FIRST_PERSON.test(said)) return at('self');
		if (SECOND_PERSON.test(said)) return at('who');
		return null;
	});

	const composerPlaceholder = $derived.by(() => {
		// An instruction, not an example. A worked example belongs on the empty
		// page, where there is room to read three of them and pick one; in the box
		// it has to be short enough to set on one line, and it was not — the old
		// simple-mode line ran to 74 characters and clipped against a rows="1"
		// field whose autosize only runs on input, so half of it was never seen.
		// It also put explicit copy in the chrome, where it greets anyone walking
		// past the machine before they have asked for anything.
		// While the studio has asked something, the box says so. This is the whole
		// signal that it can be talked to — a label under the question saying "you
		// can reply here" would be a sign taped to a door that already opens.
		if (askAbout)
			return askAbout.kind === 'blocked'
				? 'Describe a different shot'
				: askAbout.kind === 'self' || askAbout.kind === 'who'
					? 'Answer, or say who they are'
					: 'What happens in the shot?';
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
		// A held photograph is a message on its own: the picture is the character,
		// and the description is optional. Without this the send button stays dead
		// until you type something, which reads as the attachment not having worked.
		if (!text && !pendingPhoto) return;
		// Already sending: say so, and change nothing.
		//
		// This returned in silence, and the row below was created BEFORE the check —
		// so a press that did nothing still left a production in the sidebar with
		// no render behind it. Two of those appeared while a stuck send held this
		// flag, and from the outside it looked as though the studio had accepted
		// two orders and lost both.
		if (sending) {
			pushError('one is already being made — wait for it, or reload if it has stalled');
			return;
		}
		// The row appears now, not when a GPU starts. Idempotent, so the second
		// message of a session does nothing here. AFTER the guards: a row for a
		// message that was never sent is a lie the sidebar keeps.
		void startSession(text || pendingPhoto?.name || 'New session');
		input = '';
		shrink(composer);
		pushItem({ who: 'user', kind: 'text', text });
		sending = true;
		// The stage's clock does not start here.
		//
		// It used to: everything between the send and the clip was machinery the
		// operator asked not to be shown, so the loader stood in for all of it and
		// a surface that stayed empty read as a button that did nothing. That held
		// while the read-back was accepted automatically and the send really did
		// run to a render.
		//
		// It no longer does. There is a decision in the middle now, and a loader
		// over it hides the one thing the operator is being asked to look at —
		// `working` outranks every other stage phase, so the sentence never gets
		// drawn. The clock starts on the press instead, in acceptConfirm; until
		// then `sending` covers the read-back's own second or two, which is honest,
		// because during it something is genuinely happening.
		try {
			// Simple mode never plans. Every message is a scene to render, and the
			// answer is the prompt itself — offered for reading and editing before
			// it costs anything.
			if (mode === 'simple') {
				if (pendingPhoto && wantTarget !== 'clip') await uploadSubject(pendingPhoto, text);
				// A continuation is read back too. The round remembers which clip and
				// which seam it was written for; the button then writes through
				// continueFromRequest — see acceptConfirm.
				else if (continuing) await confirmFromRequest(text);
				// Read it back first, in a sentence, before spending anything on it.
				// The brief and the render follow from the button on that card —
				// see confirmFromRequest and acceptConfirm.
				//
				// The stage used to accept this for you, which made the send one press
				// instead of two. But the read-back exists because a creator took their
				// references to a general chat and iterated there: what they wanted was
				// to see whether they had been understood while changing it was still
				// free. Accepting it automatically spends a render on every misreading,
				// which is the thing it was built to stop. The stage draws it now.
				else if (wantTarget === 'clip') await confirmFromRequest(text);
				else await sheetFromRequest(text, wantTarget);
			} else if (!brief) await planFromIdea(text);
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
			// The same deadline the read-back got, and for the same reason: a call
			// with no clock can only be ended by closing the tab. Five minutes,
			// because this one genuinely is slow — 42, 44 and 59 seconds measured on
			// three ordinary runs — and a cap that cuts a working writer short would
			// be a worse bug than the one it fixes.
			res = await fetch('/studio/api/shotprompt', {
				method: 'POST',
				signal: AbortSignal.timeout(5 * 60_000),
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ request, ...pin })
			});
		} catch (e) {
			pushError(
				e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
					? 'the brief writer did not answer in five minutes — send it again'
					: `Could not reach the prompt writer: ${e}`
			);
			return null;
		}
		if (!res.ok) {
			const m = (await res.json().catch(() => null)) as { message?: string } | null;
			pushError(m?.message || `The prompt could not be written (${res.status}).`);
			return null;
		}
		let r: {
			ok: boolean;
			shot?: ChatItem['shot'];
			warn?: string[];
			fixed?: string[];
			error?: string;
		};
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
	/** Five seconds and 576p to start with.
	 *  The shortest clip and the middle frame: the first send a person makes
	 *  should be the cheapest one that still shows whether the idea works, and
	 *  eight seconds at the old default spent half again as much to say the same
	 *  thing. Both stay one tap from anything else. */
	let wantSeconds = $state(5);
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
	/** Which group in the settings row above the composer is open.
	 *
	 *  Empty means all of them are folded to their current value, which is the
	 *  resting state: the row then reads as a line of facts — 5s, 288p, 9:16 —
	 *  rather than as a wall of choices. One at a time, so the row keeps to a
	 *  single scroll and the set being chosen is the only one expanded. */
	let pillGrp = $state('');
	/** Where the open panel grows from, in pixels along the settings row.
	 *
	 *  It opened from the row's left edge whatever was tapped, so pressing the
	 *  frame bubble at the right-hand end produced a panel somewhere else — the
	 *  eye had to find it, which is the one thing an animation is supposed to
	 *  save you. `x` places the panel, `o` puts the growth origin under the
	 *  bubble itself, so it unfolds out of the thing you pressed. */
	let pillAt = $state({ x: 0, o: 0 });

	/** Reads the tapped bubble's place in the row and opens from there.
	 *
	 *  Clamped to the row: a bubble near the right edge would otherwise put a
	 *  144px panel half off the screen. When that happens the panel slides back
	 *  inside and only the origin stays under the bubble, which is what keeps the
	 *  movement pointing at the right place even when the box cannot. */
	/** Same trick for the two panels that are not pill groups.
	 *
	 *  They opened from the composer's left edge — one as a sheet glued to the
	 *  bottom of the screen, the other as a popover two hundred pixels from the
	 *  bubble that summoned it. Both are now measured against the composer box
	 *  they are positioned in, so they rise out of the control that was pressed
	 *  like everything else in this row. */
	let panelAt = $state({ x: 0, o: 0 });

	function openPanelAt(ev: MouseEvent, which: 'fmt' | 'mode') {
		const el = ev.currentTarget as HTMLElement;
		const box = el.closest('.composerbox') as HTMLElement | null;
		if (box) {
			const b = el.getBoundingClientRect();
			const w = box.getBoundingClientRect();
			const PANEL = 312;
			const raw = b.left - w.left;
			const x = Math.max(8, Math.min(raw, w.width - PANEL - 8));
			panelAt = { x, o: Math.max(12, Math.min(b.left - w.left - x + b.width / 2, PANEL - 12)) };
		}
		const open = which === 'fmt' ? !fmtOpen : !modeOpen;
		shutMenus();
		if (which === 'fmt') fmtOpen = open;
		else modeOpen = open;
	}

	function openPillAt(ev: MouseEvent, id: string) {
		const el = ev.currentTarget as HTMLElement;
		const wrap = el.closest('.pillwrap') as HTMLElement | null;
		if (wrap) {
			const b = el.getBoundingClientRect();
			const w = wrap.getBoundingClientRect();
			const PANEL = 144;
			const raw = b.left - w.left;
			const x = Math.max(0, Math.min(raw, w.width - PANEL));
			pillAt = { x, o: Math.max(8, Math.min(b.left - w.left - x + b.width / 2, PANEL - 8)) };
		}
		pillGrp = id;
	}

	/** The row's groups, folded or open. Built rather than written out because
	 *  the continuation group only exists when there is something to continue,
	 *  and because each one has to say three things — what it is set to now, what
	 *  else it could be, and what to do about it — which is a shape, not markup.
	 *
	 *  Lower case on purpose. Named PILL_GROUPS it compiled clean and threw
	 *  "PILL_GROUPS is not defined" in the browser: a capitalised identifier in a
	 *  template is a component reference to Svelte, so the call resolved against
	 *  the component namespace instead of this scope. The whole surface below it
	 *  went dead — including the send — with nothing on screen to say why. */
	function pillGroups() {
		const g: {
			id: string;
			up: boolean;
			now: string;
			opts: { v: string; l: string; box: string; off: boolean }[];
			pick: (v: string) => void;
		}[] = [];
		if (stageContinuable) {
			g.push({
				id: 'next',
				up: true,
				now: !continuing ? 'new' : pinSeam ? 'seam' : 'same',
				opts: [
					{ v: 'seam', l: 'Last frame', box: '', off: false },
					{ v: 'same', l: 'Same person', box: '', off: false },
					{ v: 'new', l: 'New clip', box: '', off: false }
				],
				pick: (v: string) => {
					if (v === 'new') {
						contOffFor = stageContinuable?.id ?? '';
						continuing = null;
						spendConfirmChain();
						return;
					}
					contOffFor = '';
					if (!continuing && stageContinuable) startContinue(stageContinuable);
					pinSeam = v === 'seam';
				}
			});
		}
		return g;
	}

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
	function splitConfirm(line: string): { lead: string; said: string; added: string } {
		let rest = line;
		let added = '';
		// The attribution, off the end. The marker stays: it used to be stripped,
		// back when this half was the proposal itself and the word was just a
		// seam. It is an attribution now — take it off and the line opens
		// lower-case in the middle of a thought, and stops saying whose list it is.
		const at = rest.search(/(^|[.!?…]\s+)(Hozzátettük|We added)\s*:/i);
		if (at !== -1) {
			const marker = rest.slice(at).search(/(Hozzátettük|We added)\s*:/i);
			added = rest.slice(at + marker).trim();
			rest = rest.slice(0, at + marker);
		}
		// The opening line, off the front, at the first blank line. Mid-stream
		// there is no blank line yet, so everything is still the lead — which is
		// what it looks like anyway, because the lead is what arrives first.
		//
		// A model that skips the blank line loses its lead rather than leaking a
		// greeting into the description, and from there into the brief. Wrong in
		// the safe direction.
		const brk = rest.indexOf('\n\n');
		const lead = brk === -1 ? rest.trim() : rest.slice(0, brk).trim();
		const said = brk === -1 ? '' : rest.slice(brk).trim();
		// A lead that ran long is not a lead. Prose that happens to start with a
		// short line would otherwise be filed as a greeting and dropped.
		if (lead.length > 90 && !said) return { lead: '', said: lead, added };
		return { lead, said, added };
	}

	/** The composer's settings as the confirmation sees them. */
	type ConfirmSettings = {
		seconds: number;
		who: string;
		where: string;
		angles: number;
		mode: string;
	};
	function settingsNow(): ConfirmSettings {
		return {
			seconds: composerShape.seconds,
			who: chosenCharacter?.name ?? '',
			where: chosenLocation?.name ?? '',
			angles: effAngles,
			// Entering or leaving a continuation, or toggling its seam, is a setting
			// like the others: it gets a round that names the change.
			mode: continuing ? (pinSeam ? 'last frame' : 'same scene, new take') : 'none'
		};
	}
	/** What the newest live round was written for. Null until there is one. */
	let settingsWritten: ConfirmSettings | null = null;
	let settingsTimer: ReturnType<typeof setTimeout> | null = null;

	function settingsDiff(a: ConfirmSettings, b: ConfirmSettings): string[] {
		const out: string[] = [];
		if (a.seconds !== b.seconds) out.push(`length ${a.seconds} -> ${b.seconds} seconds`);
		if (a.who !== b.who) out.push(`character ${a.who || 'none'} -> ${b.who || 'none'}`);
		if (a.where !== b.where) out.push(`location ${a.where || 'none'} -> ${b.where || 'none'}`);
		if (a.angles !== b.angles) out.push(`camera angles ${a.angles} -> ${b.angles}`);
		if (a.mode !== b.mode) out.push(`continuation ${a.mode} -> ${b.mode}`);
		return out;
	}

	/** A setting moved under a live proposal: say so, and re-shape it.
	 *
	 *  The description on screen was written for the length, character and room
	 *  the composer had at the time. Turn the length from five seconds to fifteen
	 *  and nothing used to happen until the next message — so the paragraph a
	 *  person was reading, and the button they were about to press, described a
	 *  five second clip over a fifteen second setting. The render itself was
	 *  fine (the writer is pinned to the composer), but the contract on screen
	 *  was stale, and a stale contract is the one thing this layer must not be.
	 *
	 *  Only while a round is live. After the button, a changed chip is for the
	 *  NEXT shot, and re-describing a clip already on a GPU would be noise.
	 *  Debounced, because a person clicking through 5, 8, 15 wants one answer
	 *  about 15, not three. */
	$effect(() => {
		const now = settingsNow();
		if (!settingsWritten) return;
		if (!settingsDiff(settingsWritten, now).length) return;
		// Entering or leaving a continuation is not a change to the shot being
		// described — it is a different shot. Re-describing the old one under the
		// new mode produced a "new clip" that was still the continuation, and a
		// continuation that inherited an unrelated clip's agreed lines. The chain
		// closes; the next typed message starts clean. Only a seam toggle inside a
		// continuation is answered with a round.
		if ((settingsWritten.mode === 'none') !== (now.mode === 'none')) {
			untrack(() => spendConfirmChain());
			return;
		}
		const live = untrack(() => chat.filter((c) => c.kind === 'confirm').at(-1));
		if (!live?.confirm || live.confirm.sent || live.confirm.streaming) return;
		if (settingsTimer) clearTimeout(settingsTimer);
		settingsTimer = setTimeout(() => {
			settingsTimer = null;
			if (!settingsWritten) return;
			const diffs = settingsDiff(settingsWritten, settingsNow());
			if (diffs.length) void confirmFromRequest('', diffs.join(', '));
		}, 700);
	});

	/** Close the current read-back chain: every unsent round is spent.
	 *
	 *  The rounds of a shot are its "agreed so far"; a round that outlives its
	 *  shot leaks into the next one as agreement nobody made. Called on launch,
	 *  and on entering or leaving a continuation — a continuation is a different
	 *  order from the new clip that was being described before it, and vice
	 *  versa, so neither may inherit the other's history. */
	function spendConfirmChain() {
		for (const x of chat)
			if (x.kind === 'confirm' && x.confirm && !x.confirm.sent) x.confirm.sent = true;
		settingsWritten = null;
		// Written down. In memory the chain was closed; on disk it was not, so a
		// reload after "new clip" brought the old rounds back unsent.
		persist();
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
	/** `auto` presses the button this card exists to offer.
	 *
	 *  The read-back is a cost gate: it restates the order in a sentence so a
	 *  misread costs a glance rather than a GPU. The stage does not show it, so on
	 *  the stage the gate is gone by design — the operator asked for one press
	 *  from typing to clip, and this is the half of that they are paying for. The
	 *  card is still written and still kept; only nobody is asked about it. */
	async function confirmFromRequest(said: string, changed = '', auto = false) {
		// What this round is written for. The settings watcher diffs against it.
		settingsWritten = settingsNow();
		const cont = continuing;
		const snap = cont
			? {
					workspace: cont.workspace,
					pinned: pinSeam,
					characterName: cont.characterName,
					locationName: cont.locationName
				}
			: undefined;
		const item = pushItem({
			who: 'studio',
			kind: 'confirm',
			confirm: {
				said,
				line: '',
				streaming: true,
				...(changed ? { changed } : {}),
				...(snap ? { continues: snap } : {})
			}
		});
		const askedAt = Date.now();
		// A deadline on the whole read-back, stream included.
		//
		// There was none, and the read loop below waits on `reader.read()` with no
		// clock: a stream that stops arriving without closing parks that await
		// forever. Nothing throws, so nothing is caught, so nothing is said — the
		// send stays "in flight", the loader counts to its cap and sits there, and
		// the render is never launched. Ninety-seven per cent, no message, no clip.
		//
		// Sixty seconds is far past any real one — the read-back measures under
		// three — and the point is not to be tight, it is to end.
		const ctl = new AbortController();
		const deadline = setTimeout(() => ctl.abort(), 60_000);
		try {
			const res = await fetch('/studio/api/shotconfirm', {
				method: 'POST',
				signal: ctl.signal,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					request: said,
					...(changed ? { changed } : {}),
					seconds: composerShape.seconds,
					res: composerShape.res,
					aspect: composerShape.portrait ? '9:16' : '16:9',
					makes: batchLabel,
					// Continuing: the people and the place are the prior clip's, whatever
					// the chips say; and the prior brief goes along so the end state can
					// be read off it.
					character: cont ? cont.characterName : chosenCharacter?.name,
					location: cont ? cont.locationName : chosenLocation?.description || chosenLocation?.name,
					...(cont
						? {
								continuing: {
									seam: pinSeam ? 'pinned' : 'free',
									who: cont.characterName,
									where: cont.locationName,
									priorPrompt: logRow[cont.workspace]?.prompt
								}
							}
						: {}),
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
			// An abort is this deadline firing, and it deserves its own words: the
			// generic "could not be read back" reads like the model refused.
			item.confirm!.error =
				e instanceof Error && e.name === 'AbortError'
					? 'the read-back stopped part way — send it again'
					: `that could not be read back — ${e instanceof Error ? e.message : e}`;
		} finally {
			clearTimeout(deadline);
			item.confirm!.streaming = false;
			recordWait('confirm', Date.now() - askedAt);
			persist();
		}
		// Nothing to accept if the read-back itself failed: the error is what the
		// stage should show, and shooting from a line that could not be written is
		// how a misread becomes a render.
		if (auto && !item.confirm!.error) await acceptConfirm(item.id);
		// And when it did fail, the stage has to hear about it: the read-back's
		// error lives on the card, which is exactly what the stage does not draw.
		else if (auto && item.confirm!.error) pushError(item.confirm!.error);
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
		c.busySince = Date.now();
		c.error = undefined;
		// This is the press the stage waits on. From here to the clip is the
		// machinery nobody asked to watch — the brief, the checker, the workspace,
		// the GPU — so the loader covers all of it, and the blur underneath is the
		// clip this one grows out of when it is a continuation.
		if (STAGE_UI) {
			stageStartedAt = Date.now();
			// stageWaitFrom stays the newest: it is how the arrival of a NEW clip is
			// noticed, not where this one comes from.
			stageWaitFrom = stageNewest?.id ?? '';
			// The blur is the clip being continued, which is the one being watched
			// and no longer necessarily the last one. Left on the newest it showed
			// the wrong picture under the loader the moment somebody clicked back
			// through the strip and carried on from there.
			stageWaitBlurUrl = c.continues ? (stageContinuable?.artifact?.files?.[0]?.url ?? '') : '';
		}
		try {
			// Second press: the brief already exists and was shown, changes and all.
			// Write it again and the operator is shown one set of changes and shoots
			// another — and pays a minute for the privilege.
			const already = c.cardId ? chat.find((x) => x.id === c.cardId) : undefined;
			if (already?.shot && !already.shot.launched) {
				c.fixed = undefined;
				c.phase = 'starting';
				await startFromCard(already);
				return;
			}

			c.fixed = undefined;
			// The description only. The opening line and the attribution are the
			// studio talking to a person — "írd át, ha más kell" is an offer, and
			// in a brief it reads as an instruction to the crew.
			const agreed = splitConfirm(c.line).said.trim();
			// Their own words from EVERY round of this shot, not only the last.
			// Round one said "nagy faszt" and round two said "tedd bele hogy
			// remeg"; the writer is told to keep the operator's plain terms, and
			// it can only keep the ones it is given. A round that answered a
			// setting change said nothing and contributes nothing here.
			const rounds = chat.filter((x) => x.kind === 'confirm' && x.confirm && !x.confirm.sent);
			const raw = rounds
				.map((x) => x.confirm!.said.trim())
				.filter(Boolean)
				.join('\n');
			const request = agreed ? `${raw || c.said}\n\n---\n\n${agreed}` : raw || c.said;
			c.phase = 'writing';
			// A continuation writes through its own path, against the clip the round
			// was started from — not whatever the composer points at now.
			if (c.continues) {
				if (continuing?.workspace !== c.continues.workspace) {
					c.error = 'that clip is no longer being continued — press Continue on it again';
					if (STAGE_UI) pushError(c.error);
					return;
				}
				pinSeam = c.continues.pinned;
			}
			const card = c.continues
				? await continueFromRequest(request)
				: await shotFromRequest(request);
			if (!card?.shot) {
				// The writer came back with nothing. It says so on the card, and on
				// the stage there is no card — so say it where the loader is.
				if (STAGE_UI) pushError('the brief could not be written — try sending that again');
				return;
			}

			// The whole chain is spent, not just the round with the button. Left
			// unsent, the earlier rounds of this shot were being read back as
			// "agreed so far" into the NEXT shot's first round.
			spendConfirmChain();
			c.cardId = card.id;
			// Stop and say so. A brief the checker rewrote is not the brief that was
			// read back, and letting it shoot anyway would mean the sentence they
			// approved was not the order — which is the one thing this whole layer
			// exists to prevent.
			//
			// The stage does not stop here, because it has nowhere to stop TO. This
			// gate guards a promise the stage never made: there, the read-back is
			// accepted for you and never shown, so there is no approved sentence
			// for a rewritten brief to differ from. Stopping anyway left the loader
			// sitting at 97% with no card, no message and no way forward — a render
			// that looks like it is running and is not.
			//
			// The checker's changes are already IN the brief either way; what is
			// lost is being told about them, and that is the trade the stage was
			// asked for.
			if (card.shot.fixed?.length && !STAGE_UI) {
				c.fixed = card.shot.fixed;
				return;
			}
			c.phase = 'starting';
			await startFromCard(card);
		} catch (e) {
			c.error = `that could not be started — ${e instanceof Error ? e.message : e}`;
			// Onto the stage as well. The card carries this in the transcript, and
			// the stage does not draw cards — so without this the failure was
			// written somewhere nobody was looking while the loader kept counting.
			if (STAGE_UI) pushError(c.error);
		} finally {
			shotBusy[itemId] = false;
			c.phase = undefined;
			c.busySince = undefined;
			// A press that never reached a GPU gives the surface back.
			//
			// The clock is started by the press and was only ever stopped by a clip
			// arriving, so every way this can fail — the writer returning nothing,
			// the checker's changes, a continuation whose clip is no longer the one
			// being continued, a throw — left the loader running over nothing. The
			// error said so and the loader disagreed with it, and dismissing the
			// error handed back a stage counting toward a render that was never
			// dispatched. Read from the card rather than tracked through the three
			// exits: what matters is whether a clip is actually on its way.
			const started = c.cardId ? chat.find((x) => x.id === c.cardId) : undefined;
			if (STAGE_UI && !started?.shot?.launched) {
				stageStartedAt = 0;
				stageWaitFrom = '';
				stageWaitBlurUrl = '';
			}
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
		// A continuation is a new order; whatever was being read back before it is
		// not its history.
		spendConfirmChain();
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
	async function continueFromRequest(request: string): Promise<ChatItem | null> {
		const c = continuing;
		if (!c) return null;
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
		if (!shot) return null;
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
		return pushItem({ who: 'studio', kind: 'shot', shot });
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
				/** What a SvelteKit error() puts the reason in. */
				message?: string;
				url?: string;
				parts?: number;
				seconds?: number;
			};
			if (!r.ok || !r.url) {
				pushError(r.error || r.message || 'the scene could not be assembled');
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
		{
			label: 'low and husky',
			text: 'a low, warm, slightly husky adult female voice, neutral American accent, unhurried'
		},
		{
			label: 'bright and young',
			text: 'a bright, light adult female voice, neutral American accent, quick and forward'
		},
		{
			label: 'soft and breathy',
			text: 'a soft, breathy adult female voice, neutral American accent, close and unhurried'
		}
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

	/** Give the character a name.
	 *
	 *  Saved on blur, like the voice, and for the same reason: one field, one
	 *  line, and a button to confirm a name is a button nobody needs. */
	async function renameCharacter(id: string, next: string) {
		const row = sheets.find((x) => x.id === id);
		const name = next.trim().slice(0, 80);
		if (!row || !name || name === row.name) return;
		try {
			const res = await fetch('/studio/api/sheet', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id, name })
			});
			const r = (await res.json()) as { ok?: boolean; sheets?: StoredSheet[]; error?: string };
			if (r.ok && r.sheets) sheets = r.sheets;
			else pushError(r.error || 'the name could not be saved');
		} catch (e) {
			pushError(`the name could not be saved — ${e}`);
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
				sheet?: {
					kind: 'character' | 'location';
					description: string;
					voice?: string;
					why?: string;
				};
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
		// The card first, so the stage has the subject the moment the button is
		// pressed. It carries no picture yet; the poll fills this same card in when
		// the artifact lands, rather than posting a second one beside it.
		const card = pushItem({
			who: 'studio',
			kind: 'sheet',
			sheet: { kind, stage: 'anchor', description, why, seed, voice, launched: true }
		});
		try {
			// Through the harness, like every other render.
			//
			// This was the one road that went straight to a compute endpoint, on the
			// argument that a preview has nothing to decide and the harness's work —
			// fetching the models a graph names — had nothing to do. Measured, that
			// saved 38 seconds on 150. Then the fleet moved: the three models the
			// preview names are not on the compute volume, and the direct graph
			// carries no addresses for them, so every preview died on "missing
			// models" — while the six-view sheet, which names the same three through
			// the harness, went on working. The one thing the harness does is the
			// one thing that was missing. The 38 seconds buy a render that happens.
			const ok = await launchSheetRender({ kind, description, stage: 'anchor', seed, why, voice });
			if (!ok) {
				card.kind = 'error';
				card.text = 'The preview did not start.';
				return;
			}
			// Durable before the picture exists: the workspace is the way back to a
			// render that runs for two minutes whether or not this tab stays open.
			if (card.sheet) card.sheet.workspace = renderWs;
			persist();
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
		voice?: string;
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
			// On for the whole of a sheet run — renderInFlight reads it to keep the
			// clip's loader off a render that puts no clip on the stage. It was set and
			// unset on consecutive lines here, which is a no-op, and the loader came
			// back for every sheet.
			renderIsSheet = true;
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
		voice?: string;
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
	/** Keep the person in the clip you are continuing as a character.
	 *
	 *  Offered only when the clip has none. Without it the launch cuts a plate out
	 *  of the prior clip every generation, so each continuation is measured against
	 *  the last render rather than against a face anybody approved — and the drift
	 *  compounds down the chain.
	 *
	 *  The character is usable the moment this returns: a render reads the picture,
	 *  not the six views, and those arrive later on the card by themselves.
	 */
	/** Choosing to carry on with these people is the answer "Keep this person"
	 *  was asking for, so it stops being a question.
	 *
	 *  It sat beside the choice as a button of its own, which made the ordinary
	 *  path — continue, then keep — two clicks and, on a phone, a third line in a
	 *  row that already wrapped. Either continuation answers it. A new clip does
	 *  not: that is the one case where this person is not being carried anywhere.
	 *
	 *  Guarded on exactly what the button was guarded on, so this fires where the
	 *  offer would have been made and nowhere else — the call reads five frames
	 *  and costs a vision request, and a second one would only overwrite the
	 *  sheet the first wrote. */
	/** NOT WIRED UP, and this comment is why.
	 *
	 *  Choosing a continuation is the answer "Keep this person" asks for, so
	 *  firing it from that choice looked free. It is not: makeCharacterFromClip
	 *  calls /studio/api/charfromclip, which writes a sheet AND kicks off a
	 *  turnaround — a GPU render, fire-and-forget, paid for. Tapping "Same
	 *  person" started one, silently, and three of them were running before
	 *  anybody noticed.
	 *
	 *  An automatic action may cost a request. It may not cost a render. Kept
	 *  here so the next attempt starts from the constraint rather than from the
	 *  idea: the marking has to happen without the turnaround, or not at all. */
	function keepPersonForContinuation() {
		if (!continuing || continuing.characterId || charFromClipBusy) return;
		void makeCharacterFromClip();
	}

	async function makeCharacterFromClip() {
		const c = continuing;
		if (!c || charFromClipBusy) return;
		charFromClipBusy = true;
		charFromClipError = '';
		try {
			const res = await fetch('/studio/api/charfromclip', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					workspace: c.workspace,
					artifact: c.artifact,
					file: c.file,
					...(sessionSlug ? { sessionSlug } : {})
				})
			});
			const r = (await res.json()) as {
				ok?: boolean;
				error?: string;
				sheet?: StoredSheet;
				sheets?: StoredSheet[];
			};
			if (!r.ok || !r.sheet) {
				charFromClipError = r.error || 'the character could not be made';
				return;
			}
			if (r.sheets) sheets = r.sheets;
			// Onto the continuation itself, which is what launchShot reads. Replaced
			// rather than mutated so the panel re-renders with the name on it.
			continuing = { ...c, characterId: r.sheet.id, characterName: r.sheet.name };
			// And onto the composer, so the chip stops saying "anyone".
			//
			// It is the same person by every measure that matters — the clip it was
			// cut from is the one being continued — and leaving the chip on "anyone"
			// said the opposite in the one place that answers "who is in this". The
			// next shot, continuation or not, is now cast.
			wantCharacter = r.sheet.id;
			saveSetup();
		} catch (e) {
			charFromClipError = `the character could not be made: ${e}`;
		} finally {
			charFromClipBusy = false;
		}
	}

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
				renderIsSheet = false;
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
			renderIsSheet = false;
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
	/** Every film ever assembled, newest first, from the log beside the renders.
	 *
	 *  The shelf at the foot of the sidebar and the all-media grid both read this.
	 *  Loaded once and refreshed by Export, which is the only thing that adds to
	 *  it. */
	type FilmRow = {
		workspace: string;
		artifact: string;
		file: string;
		parts: number;
		seconds: number;
		at: number;
	};
	let films = $state<FilmRow[]>([]);
	/** The finished film, shown the moment it is made. Closing it does not lose
	 *  it — that is what the shelf is for. */
	let filmPopup = $state<FilmRow | null>(null);
	/** The all-media grid, opened from the shelf's last tile. */
	let mediaOpen = $state(false);

	/** Everything this studio has made, for the page you land on.
	 *
	 *  The film log answers "what did I finish" and is the right list for the
	 *  shelf. It is the wrong list for a front page, because on a studio that has
	 *  assembled nothing it is empty, and an empty front page says the tool has
	 *  never worked. The clip cache is never empty on a studio that has run: it
	 *  is the work itself, a hundred and eighty-eight of them here, and the only
	 *  record that survives a transcript being thrown away.
	 *
	 *  Films first regardless, because a film is the thing that was finished and
	 *  a shot is a part. Duration is what separates them — over twenty seconds is
	 *  longer than this studio can render in one go, so it was assembled. */
	/** The shelf, and only films are on it.
	 *
	 *  A shot is a part; a wall of parts is a scratch folder. What belongs on a
	 *  front page is what was finished, and the server decides what counts —
	 *  the film log for anything assembled since it existed, and, before it, a
	 *  file longer than this studio can render in one go, which can only have
	 *  been joined. Deduplicated there too: a logged film is usually also sitting
	 *  in the cache, and two tiles for one video is worse than a short shelf.
	 *
	 *  So there is nothing to filter or merge here. Whatever comes back is the
	 *  shelf, newest first. */
	interface ShelfItem {
		id: string;
		seconds: number;
		parts?: number;
	}
	let shelf = $state<ShelfItem[]>([]);
	let mediaPopup = $state<ShelfItem | null>(null);
	function shelfUrl(m: ShelfItem): string {
		return `/studio/api/media?id=${m.id}`;
	}
	async function loadMedia() {
		try {
			const r = (await (await fetch('/studio/api/media')).json()) as { items?: ShelfItem[] };
			if (r.items) shelf = r.items;
		} catch {
			/* the front page is a shelf; a failed list leaves the greeting alone */
		}
	}

	/** Load a video only once it is on screen.
	 *
	 *  The picker draws a hundred and eighty-eight of them. A browser will not
	 *  keep that many media elements alive — Chrome stops somewhere under a
	 *  hundred — so past the limit every tile stays black, and a picker you
	 *  cannot see is not a picker. The src is held back until the tile scrolls
	 *  into view and the element is then a normal one.
	 *
	 *  Kept once it has loaded. Tearing the src out again on the way past would
	 *  make scrolling back up reload everything, and the elements that survive
	 *  are the ones somebody is choosing between. */
	function whenSeen(node: HTMLVideoElement, url: string) {
		const eye = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (!e.isIntersecting) continue;
					if (!node.src) node.src = url;
					eye.unobserve(node);
				}
			},
			{ rootMargin: '400px' }
		);
		eye.observe(node);
		return { destroy: () => eye.disconnect() };
	}

	/** Everything in the cache, for choosing from. Loaded only when the picker is
	 *  opened: it is a hundred and eighty-eight rows and the front page needs
	 *  none of them. */
	let pool = $state<ShelfItem[]>([]);
	let pins = $state<string[]>([]);
	async function loadPool() {
		try {
			const r = (await (await fetch('/studio/api/media?all=1')).json()) as {
				items?: ShelfItem[];
				pins?: string[];
			};
			if (r.items) pool = r.items;
			if (r.pins) pins = r.pins;
		} catch {
			/* nothing to choose from is the same as not opening the picker */
		}
	}
	async function togglePin(id: string) {
		const pinned = !pins.includes(id);
		// Moved before the answer comes back. A pin is a click on a thumbnail and
		// the wall behind it is already drawn; waiting a round trip to redraw one
		// ring makes a instant decision feel like a form submission.
		pins = pinned ? [...pins, id] : pins.filter((x) => x !== id);
		try {
			const r = (await (
				await fetch('/studio/api/media', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ id, pinned })
				})
			).json()) as { pins?: string[] };
			if (r.pins) pins = r.pins;
		} catch {
			/* the optimistic move stands; the next open reads the truth */
		}
		void loadMedia();
	}

	/** The starters are a row you page through, not a stack you read.
	 *
	 *  Three cards took two hundred and eighty-four points — a third of a phone —
	 *  and pushed every film below the fold on the one screen that exists to show
	 *  them. One at a time costs a fifth of that and still teaches, which is what
	 *  these are for: not conversion (of the accounts that only ever tapped one,
	 *  one in forty-two rendered anything) but showing what a usable sentence
	 *  looks like — who is in it, where, and what happens. That only works if the
	 *  whole sentence is legible, which is why they are not shortened to labels.
	 *
	 *  Paged rather than swapped on a timer alone. A line that changes by itself
	 *  is a line you might not notice changed; a row with the next card showing at
	 *  its edge and dots underneath says "there are three" before anything moves.
	 *  It still advances on its own, because nobody swipes a thing they have not
	 *  been told is swipeable — but the first frame already says it is.
	 *
	 *  A phone only. From `sm` up the three fit side by side as they always did,
	 *  and the same markup lays out as a grid: no peek, no dots, no advancing.
	 *  The carousel answers a shortage of height, and a desktop has none. */
	let starterAt = $state(0);
	let starterRow = $state<HTMLElement | null>(null);
	/** Stop advancing the moment somebody takes hold of it. Nothing is more
	 *  irritating than a carousel that moves while you are reading it. */
	let starterHeld = $state(false);
	const STARTER_MS = 5200;

	$effect(() => {
		const reduced =
			typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
		// Only where it is a carousel. From `sm` up the three sit side by side and
		// there is nothing to page — a row that scrolled itself while all of it was
		// already on screen would be motion for its own sake.
		const wide = typeof matchMedia === 'function' && matchMedia('(min-width: 640px)').matches;
		if (reduced || wide || starterHeld || !showExamples || examples.length < 2) return;
		const t = setInterval(() => showStarter((starterAt + 1) % examples.length), STARTER_MS);
		return () => clearInterval(t);
	});

	/** Scroll the row to one card. The row is the source of truth for which card
	 *  is showing — a swipe moves it without asking — so this only pushes it, and
	 *  `onscroll` reads it back. */
	function showStarter(i: number) {
		starterAt = i;
		const row = starterRow;
		const card = row?.children[i] as HTMLElement | undefined;
		if (row && card) row.scrollTo({ left: card.offsetLeft - row.offsetLeft, behavior: 'smooth' });
	}

	function starterScrolled() {
		const row = starterRow;
		if (!row) return;
		const w = (row.children[0] as HTMLElement | undefined)?.clientWidth ?? 1;
		starterAt = Math.max(0, Math.min(examples.length - 1, Math.round(row.scrollLeft / (w + 8))));
	}

	/** Two tiles at a time, moving along the wall.
	 *
	 *  A still wall is a folder; eleven walls playing at once is a browser with
	 *  eleven video decoders and a fan. So a couple of them are alive at any
	 *  moment and the pair walks, which is how a shelf of moving pictures is
	 *  usually done — enough motion that the page is clearly not a screenshot,
	 *  little enough that the eye is not being shouted at from six directions.
	 *
	 *  The two are taken from opposite ends of the list rather than side by side.
	 *  Neighbours playing together read as one thing twitching in a corner;
	 *  spread apart, the wall looks alive all over.
	 *
	 *  Off for anybody who has asked for less motion, where a page that animates
	 *  by itself is exactly what was asked against. */
	let tileEls = $state<Record<string, HTMLVideoElement>>({});
	let liveAt = $state(0);
	const STEP_MS = 4200;
	$effect(() => {
		const still =
			typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (still || stagePhase !== 'empty' || shelf.length < 2) return;
		const t = setInterval(() => (liveAt = (liveAt + 1) % shelf.length), STEP_MS);
		return () => clearInterval(t);
	});

	/** Play the two that are up, park everything else on its first frame.
	 *
	 *  Parked rather than merely paused: a video left where it stopped shows a
	 *  different frame every time it comes round, so the wall never settles into
	 *  a picture. Back to the tenth of a second the tile was drawn on. */
	$effect(() => {
		const n = shelf.length;
		if (!n) return;
		const pair = new Set([shelf[liveAt % n]?.id, shelf[(liveAt + Math.floor(n / 2)) % n]?.id]);
		for (const item of shelf) {
			const el = tileEls[item.id];
			if (!el) continue;
			if (pair.has(item.id)) {
				void el.play().catch(() => {});
			} else {
				el.pause();
				try {
					if (el.currentTime > 0.2) el.currentTime = 0.1;
				} catch {
					/* seeking before metadata throws; the next pass gets it */
				}
			}
		}
	});

	/** How tall one sits in its column.
	 *
	 *  A longer film is more work and more to look at, so it takes more wall — and
	 *  a column of identical rectangles is a contact sheet. Set as a ratio rather
	 *  than a row span because the tiles flow in columns now: each column fills
	 *  independently, which is what staggers them against each other instead of
	 *  ruling them into a grid. */
	function tileRatio(seconds: number): string {
		if (seconds >= 30) return 'aspect-[3/4]';
		if (seconds >= 15) return 'aspect-square';
		return 'aspect-[4/3]';
	}
	async function loadFilms() {
		try {
			const r = (await (await fetch('/studio/api/films')).json()) as { films?: FilmRow[] };
			if (r.films) films = r.films;
		} catch {
			/* the shelf is a convenience; a failed list is not worth a message */
		}
	}

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

	/** A clip dragged out of the strip and into the film.
	 *
	 *  Its own MIME type, not the plain text the reel already uses for
	 *  reordering: that payload is an index into the film, and a stray index
	 *  arriving from outside would move a clip nobody touched. Two kinds of drag
	 *  land on the same row, so they have to be told apart by what they carry. */
	const CLIP_DRAG = 'application/x-auteur-clip';
	function dropClipIntoFilm(e: DragEvent) {
		const raw = e.dataTransfer?.getData(CLIP_DRAG);
		if (!raw) return false;
		e.preventDefault();
		try {
			const c = JSON.parse(raw) as { workspace?: string; artifact?: string; file?: string };
			if (!c.workspace || !c.artifact || !c.file) return true;
			addClipToFilm({ workspace: c.workspace, artifact: c.artifact, file: c.file }, '');
			filmOpen = true;
		} catch {
			/* something else was dropped — the film is unchanged, which is the
			   right answer to a payload we cannot read */
		}
		return true;
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
				body: JSON.stringify({
					parts: film.map((c) => ({ workspace: c.workspace, artifact: c.artifact, file: c.file }))
				})
			});
			const r = (await res.json()) as {
				ok?: boolean;
				error?: string;
				/** What a SvelteKit error() puts the reason in. */
				message?: string;
				url?: string;
				parts?: number;
				seconds?: number;
			};
			if (!r.ok || !r.url) {
				// `message` too: a SvelteKit error() answers with that field, not
				// `error`, so every server-side refusal arrived as the generic line and
				// the actual reason — "ffmpeg is not installed" — never reached the
				// screen. The one thing that would have told you what to do.
				pushError(r.error || r.message || 'the film could not be assembled');
				return;
			}
			// Written down before anything else. A film nobody recorded is a file
			// nobody can find again, which is the whole reason this log exists.
			try {
				const rec = (await (
					await fetch('/studio/api/films', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							workspace: film[film.length - 1]?.workspace,
							artifact: film[film.length - 1]?.artifact,
							file: 'scene.mp4',
							parts: r.parts,
							seconds: r.seconds,
							shots: film.map((c) => c.workspace)
						})
					})
				).json()) as { films?: FilmRow[] };
				if (rec.films) films = rec.films;
				filmPopup = films[0] ?? null;
			} catch {
				/* the file exists either way */
			}
			// Straight to disk as well as onto the stage. Export is the word for
			// getting the thing OUT — watching it here is what the stage was
			// already for, and a button called Export that only plays something
			// leaves you hunting for a save.
			//
			// Same origin, so `download` is honoured and names the file; a
			// cross-origin url would ignore it and navigate instead.
			try {
				// `globalThis.document`, because this component has a `document` of its
				// own — a snippet by that name — and the bare identifier resolves to
				// it here rather than to the page.
				const doc = globalThis.document;
				const a = doc.createElement('a');
				a.href = r.url;
				a.download = `auteur-film-${r.parts}-clips-${Math.round(r.seconds ?? 0)}s.mp4`;
				doc.body.appendChild(a);
				a.click();
				a.remove();
			} catch {
				/* the clip is on the stage either way — a blocked download is not a
				   reason to lose the assembly */
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

	/** Park a video on its final frame and leave it there.
	 *
	 *  The chip that offers to continue from the last frame shows the last frame.
	 *  A poster is the first one — which on a five second clip is a different
	 *  moment, a different pose, sometimes a different framing, so the picture
	 *  would have been illustrating the wrong thing while claiming to be exact.
	 *  A hair before the end rather than the end itself: seeking to `duration`
	 *  lands past the last decodable frame in Safari and paints nothing. */
	/** A portrait that has not been drawn yet is not a broken picture.
	 *
	 *  The sheet's own image url answers 404 until the turnaround lands, which is
	 *  the ten minutes right after you upload the photograph — so the card that
	 *  appeared the instant you uploaded showed the browser's torn-page icon for
	 *  the whole of it, which reads as a file that failed rather than a picture
	 *  being made. Hiding the element lets whatever the markup puts behind it —
	 *  the placeholder disc, the surface fill — stand in until there is something
	 *  to show. */
	function sheetImageMissing(e: Event) {
		const img = e.currentTarget as HTMLImageElement | null;
		if (img) img.hidden = true;
	}

	function lastFrame(el: HTMLVideoElement) {
		const park = () => {
			if (!Number.isFinite(el.duration) || el.duration <= 0) return;
			try {
				el.currentTime = Math.max(0, el.duration - 0.06);
			} catch {
				/* a seek before the media is ready throws; loadedmetadata retries it */
			}
		};
		el.addEventListener('loadedmetadata', park);
		if (el.readyState >= 1) park();
		return {
			destroy() {
				el.removeEventListener('loadedmetadata', park);
			}
		};
	}

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
		/** Where this run's clip is, written down when it landed. Absent on rows
		 *  from before the log carried it — every reader falls back. */
		clipArtifact?: string;
		clipFile?: string;
	}
	let logRow = $state<Record<string, LogRow>>({});

	/** The clip the composer is currently continuing, or null.
	 *
	 *  A separate axis from `wantTarget`: that one chooses what a NEW message
	 *  makes, and this one says the next message extends something that already
	 *  exists. Setting it puts the composer into continuation mode; sending or
	 *  cancelling clears it. */
	let continuing = $state<NonNullable<ChatItem['shot']>['continues'] | null>(null);
	/** Set while a character is being cut out of the clip being continued. The
	 *  composer is held for it: sending first would launch the continuation with
	 *  the plate this is replacing, which is the whole thing it is here to fix. */
	let charFromClipBusy = $state(false);
	let charFromClipError = $state('');

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
			return {
				seconds: wantSeconds,
				res: wantRes,
				portrait: wantOrientation === 'portrait',
				fixed: false
			};
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
			const res = await fetch(`/studio/api/sheet?id=${encodeURIComponent(id)}`, {
				method: 'DELETE'
			});
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
				(c) =>
					c.kind === 'clips' &&
					c.artifact?.workspace === w &&
					c.artifact?.id &&
					c.artifact.files?.length
			);
			if (it?.artifact?.id) {
				out.push({ workspace: w, artifact: it.artifact.id, file: it.artifact.files[0].name });
				continue;
			}
			// Not in this transcript, which is the normal case for a session
			// reopened from the library: the cards were never rebuilt, only the
			// log rows. The row now carries the address, so the chain survives a
			// reload. A row from before it did returns nothing, as before.
			const row = logRow[w];
			if (!row?.clipArtifact || !row.clipFile) return [];
			out.push({ workspace: w, artifact: row.clipArtifact, file: row.clipFile });
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
		item.shot.loras = (item.shot.loras ?? []).map((p) =>
			p.key === key ? { ...p, strength: n } : p
		);
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
			renderIsSheet = false;
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
				extras.push(
					`${f.name} did not load — ${f.detail ?? 'no reason given'}. The shoot goes on without it.`
				);
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

	/** How long until the next poll.
	 *
	 *  A render changes nothing for minutes at a time, so `quiet` reaches
	 *  QUIET_CYCLES early and every long run finishes on the slow cadence. The
	 *  cost of that is not the render, it is nobody asking: measured on
	 *  direct-mtr00ax5-5lx19, a 321s clip, the row closed 10.8s after the file
	 *  had already landed, and on the slow cadence that gap is up to 30s.
	 *
	 *  So the cadence tightens where the answer is expected instead of
	 *  everywhere. From half the learned typical wait until the run is overdue, a
	 *  clip polls every eight seconds; outside that window nothing changes. On a
	 *  five-minute render that is roughly thirty extra asks against one workspace
	 *  — more than before and said plainly rather than hidden, but not the
	 *  hammering the harness author asked us to avoid: the first half of every
	 *  run keeps the old cadence, and a production is untouched entirely.
	 *
	 *  Bounded at the top on purpose. Past OVERDUE the page already says "longer
	 *  than usual", and a run that turns out to take twenty minutes must not be
	 *  asked every five seconds for all of them. Bounded at the bottom by the
	 *  estimate existing at all: with no samples yet, typicalWait falls back to a
	 *  shipped figure, and if that is absent this returns the old cadence. */
	function pollDelay(): number {
		if (simpleRun && startedAt > 0 && typicalClip) {
			const elapsed = Date.now() - startedAt;
			if (elapsed >= typicalClip * CLOSING_FROM) {
				// Past overdue the tight window closes — but not all the way back to
				// the slow cadence. The page is already saying "longer than usual" by
				// then, which means somebody is watching it, and a simulation over the
				// last dozen real durations showed the one run that went far past its
				// estimate losing eighteen seconds to a thirty-second tick it happened
				// to land badly on. Fifteen halves that without asking every eight
				// seconds for a quarter of an hour.
				return elapsed <= typicalClip * OVERDUE ? POLL_CLOSING_MS : POLL_FAST_MS;
			}
		}
		return quiet >= QUIET_CYCLES ? POLL_SLOW_MS : POLL_FAST_MS;
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

		// End of the loop, decided only on confirmed data. A production waits for
		// two consecutive polls to agree; a simple run with its clip already in
		// hand does not. The reasoning for both is at the settle decision below.
		//
		// processRender ran above, in this same tick, so an artifact carried by
		// this poll is already a card in `chat` by the time that decision is made.
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
				// Where the clip landed. Looked up before the decision below rather
				// than inside it, because in simple mode this is also what makes the
				// second confirming poll unnecessary.
				const made = chat.find(
					(c) =>
						c.artifact?.workspace === renderWs &&
						c.artifact?.id &&
						c.artifact.files?.some((f) => /\.mp4$/i.test(f.name))
				);
				const madeFile = made?.artifact?.files?.find((f) => /\.mp4$/i.test(f.name));
				// Two consecutive polls have to agree before a run is called finished,
				// because there are windows — the planner just finished, assembly just
				// requested — where "all terminal" is true for one poll while new
				// tasks are still being ingested.
				//
				// Every one of those windows belongs to a production. A simple run has
				// no planner and no assembly step, so the second poll confirms nothing
				// and costs a whole interval: 10.8s on the run measured above, and up
				// to 30s once the loop has settled on the slow cadence.
				//
				// Dropped only when the clip is already on screen, though. A task can
				// read terminal before its artifact has been posted, and closing then
				// would write the row without clipArtifact/clipFile — the one record a
				// later session has of where the clip went, and the thing that took a
				// backfill to repair last time it was missing.
				if (sawAllDone || (simpleRun && !!made?.artifact?.id && !!madeFile)) {
					// One clip only, and only one that worked. A full production is an
					// order of magnitude longer, and a couple of them in the sample
					// would make the clip estimate useless.
					// Only a render this tab actually watched. See sawRunning.
					if (sawRunning && simpleRun && startedAt && !ts.some((t) => DEAD.includes(t.status))) {
						recordWait('clip', Date.now() - startedAt);
						refreshClipEstimate();
					}
					// Close the render log's row for this run. Fire and forget: the
					// row is evidence, and a clip that rendered must not look failed
					// because the bookkeeping call did.
					if (renderWs) {
						const dead = ts.some((t) => DEAD.includes(t.status));
						// `made` and `madeFile` are resolved above, before the settle
						// decision. Written down while the clip is in front of us: a
						// session rebuilt from this log later has no other way to find
						// it, because the harness resolves an artifact only while the
						// workspace agent is alive, and that is the thing that dies.
						void fetch('/studio/api/renders', {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								workspace: renderWs,
								finished: true,
								...(made?.artifact?.id && madeFile
									? { clipArtifact: made.artifact.id, clipFile: madeFile.name }
									: {}),
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
		timer = setTimeout(() => tick(id), pollDelay());
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
							chain = {
								taskKey: next,
								downstream: chain.downstream.slice(1),
								armed: false,
								polls: 0
							};
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
				text: 'The plan is ready. Read anything you want to check above — once shooting starts, none of it can be changed.\n\nIf you want a particular face, room or movement in the film, attach it with the clip on the message box before you start. That is the last moment it can be handed to the crew.\n\nShooting uses GPU time and costs money.'
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
				// A preview launched from the composer already has its card — posted at
				// the press so the stage had the subject while the harness drew it, and
				// stamped with this workspace. Fill that one rather than standing a
				// second beside it; a sheet run started from a card has none, and gets
				// one here as before.
				const waiting = chat.find(
					(c) => c.kind === 'sheet' && c.sheet?.workspace === renderWs && !c.sheet.url
				);
				if (waiting?.sheet) {
					waiting.sheet.url = fileUrl(renderWs, a.id, name);
					waiting.sheet.artifact = a.id;
					waiting.sheet.file = name;
					waiting.sheet.name ??= firstWords(waiting.sheet.description ?? description, kind);
					continue;
				}
				pushItem({
					who: 'studio',
					kind: 'sheet',
					sheet: {
						kind,
						stage,
						description,
						why: pendingSheet?.why,
						seed: pendingSheet?.seed,
						voice: pendingSheet?.voice,
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
			// Said out loud in the same breath: a survey on /studio can only ask
			// what someone thinks of a clip once one of them exists.
			trackClipReady();
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
				else if (!r.ok)
					pushError(
						'The assembly request did not go through — you can send it again from the chat.'
					);
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
			shoots.forEach((t, i) => out.push({ id: t.id, label: t.key, status: mapStatus(t.status) }));
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
		// Every "busy" flag, because a new production is not busy.
		//
		// `sending` was left set, and it is the one that guards the send: a hung
		// round leaves it true, and from then on "New clip" hands you a page that
		// looks completely fresh — empty stage, welcome, examples — with a dead
		// send button behind it. Nothing on screen says why, because everything on
		// screen was reset except the one flag that mattered. The others are here
		// for the same reason rather than because they were seen to stick.
		sending = false;
		filmBusy = false;
		launchingPlanning = false;
		joining = {};

		// The stage, which had no state to clear when this was written.
		//
		// A new production opened with the continuation bar still on it, offering
		// to continue a clip from the session that had just been thrown away —
		// there was nothing to continue, and the one control that says what the
		// next message does was lying about it.
		continuing = null;
		contOffFor = '';
		pinSeam = true;
		stageSel = '';
		stageStartedAt = 0;
		stageWaitFrom = '';
		stageWaitBlurUrl = '';
		stageAutoplayId = '';
	}

	// --- small UI helpers ------------------------------------------------------------------

	/** How tall the box may get before it starts scrolling instead.
	 *
	 *  Five lines. Long orders are normal here — a shot description runs to a
	 *  paragraph — and a box that stays one line makes you write blind. Growing
	 *  without a limit is the other failure: paste a brief and the composer eats
	 *  the clip it was written for. Measured in lines rather than pixels so it
	 *  holds at any text size. */
	const COMPOSER_MAX_LINES = 5;
	function grow(el: HTMLTextAreaElement | null) {
		if (!el) return;
		el.style.height = 'auto';
		const line = parseFloat(getComputedStyle(el).lineHeight);
		// A line-height of `normal` parses to NaN; 24px is this composer's own.
		const max = (Number.isFinite(line) ? line : 24) * COMPOSER_MAX_LINES;
		const want = el.scrollHeight;
		el.style.height = `${Math.min(want, max)}px`;
		// Only when it is actually capped, so a short message has no scrollbar.
		el.style.overflowY = want > max ? 'auto' : 'hidden';
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
		el.style.overflowY = '';
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

	// ── the stage ────────────────────────────────────────────────────────────
	//
	// One fixed surface where the transcript used to scroll. The clip being made
	// is the only thing on screen, and the machinery that makes it — the read-back,
	// the brief, the launch — runs behind it without a card.
	//
	// Built beside the transcript rather than in place of it: the engine is the
	// same functions either way, and a flag that can be turned off is the
	// difference between trying a new surface and betting the working one on it.
	const STAGE_UI = true;

	/** The workspaces that make a sheet rather than a clip.
	 *
	 *  Both prefixes are minted in exactly one place each — `turn-` in the
	 *  turnaround route, `-sheet@` in sheetWorkspaceId — so matching on them is a
	 *  fact about this app rather than a guess about a string. */
	function isSheetWorkspace(ws: string): boolean {
		return ws.startsWith('turn-') || ws.includes('-sheet@');
	}

	/** Every clip in this session, oldest first, read off the transcript the
	 *  engine already keeps. The stage renders this rather than the cards.
	 *
	 *  A sheet's render is not one of them, and it used to be. The six views come
	 *  back as an mp4 — a slow orbit of the person — so it satisfied the only test
	 *  here and landed on the stage as the newest clip, wearing "Add to film",
	 *  "Good" and "Not good". None of those means anything about a turnaround:
	 *  it is not a shot, it cannot be cut into a film, and rating it rates
	 *  nothing. It also pushed the actual last clip out of the way in the middle
	 *  of making a character, which is when you are least able to explain what
	 *  you are looking at. The views belong to the sheet, and the sheet says so
	 *  in its own line. */
	let stageClips = $derived(
		chat.filter(
			(c) =>
				c.artifact?.files?.some((f) => /\.mp4$/i.test(f.name)) &&
				!isSheetWorkspace(c.artifact?.workspace ?? '')
		)
	);
	/** The newest clip, which is what the stage follows on its own. */
	let stageNewest = $derived(stageClips[stageClips.length - 1] ?? null);
	/** Which clip the operator clicked back to, by workspace. Cleared whenever a
	 *  new one lands: a strip that keeps showing an old take while a fresh one
	 *  arrives is hiding the thing the wait was for. */
	let stageSel = $state('');
	$effect(() => {
		if (stageNewest) stageSel = '';
	});
	/** The transcript card for what is on the stage, when there is one. The action
	 *  row needs it — rating and adding to the film both work on a card — and a
	 *  clip recovered from the log alone has none, so the row hides itself. */
	let stageClip = $derived(
		(stageSel && stageClips.find((c) => c.artifact?.workspace === stageSel)) || stageNewest
	);
	/** What is down the left edge: the last four of THE CHAIN, newest first, the
	 *  one on the stage among them. Including it is what makes the strip a place
	 *  rather than a leftovers pile — you can see where you are.
	 *
	 *  The chain rather than the transcript, because a session reopened from the
	 *  library has one and not the other: the log knows what continues what, and
	 *  now also where each clip is. Falls back to the transcript for a session that
	 *  has clips the log cannot place — an older run, or one still in flight. */
	let stageThumbs = $derived(
		(() => {
			const ws = stageNewest?.artifact?.workspace ?? '';
			const chain = ws ? chainOf(ws) : [];
			if (chain.length > 1) {
				return chain
					.slice(-4)
					.reverse()
					.map((c) => ({
						key: c.workspace,
						url: fileUrl(c.workspace, c.artifact, c.file),
						workspace: c.workspace,
						artifact: c.artifact,
						file: c.file
					}));
			}
			return stageClips
				.slice(-4)
				.reverse()
				.map((c) => ({
					// The transcript id, not the workspace. An assembled film carries the
					// last clip's workspace, so keying by workspace put two entries under
					// one key and Svelte tore the whole page down with
					// `each_key_duplicate`. Ids are unique by construction.
					key: c.id,
					url: c.artifact?.files?.[0]?.url ?? '',
					workspace: c.artifact?.workspace ?? '',
					artifact: c.artifact?.id ?? '',
					file: c.artifact?.files?.[0]?.name ?? ''
				}));
		})()
	);
	/** Which strip entry is on the stage, by workspace. */
	let stageShownWs = $derived(stageSel || (stageNewest?.artifact?.workspace ?? ''));
	/** The picture to play: the selected entry's, or the newest clip's. */
	/** The strip entry on the stage, with the three ids the film needs. Every clip
	 *  in the chain has them now — the log carries the address — so the actions
	 *  work on whichever one is being looked at, not only on the newest. */
	let stageShown = $derived(stageThumbs.find((t) => t.workspace === stageShownWs) ?? null);
	/** The picture to play: the clicked entry's, or the newest thing's OWN file.
	 *
	 *  Its own file, not the strip entry that shares its workspace. An assembled
	 *  film carries the last clip's workspace — that is how continuing a film
	 *  continues where it ends — so looking the url up by workspace found the
	 *  clip and played that instead. Export ran, ffmpeg wrote 27 MB, and the
	 *  stage went on showing the same six seconds: "nothing happened", from the
	 *  only place anybody was looking. */
	let stageShownUrl = $derived(
		stageSel
			? (stageThumbs.find((t) => t.workspace === stageSel)?.url ?? '')
			: (stageNewest?.artifact?.files?.[0]?.url ?? '')
	);

	/** Each clip's length, read off the <video> element once its metadata lands.
	 *  Nothing upstream carries it: the artifact is a filename and a url. */
	let clipSecs = $state<Record<string, number>>({});
	function clipClock(sec?: number): string {
		if (!sec || !Number.isFinite(sec)) return '';
		const s = Math.round(sec);
		return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
	}
	/** An error that arrived after the last clip — anything older has been
	 *  answered by a clip landing and is not what the operator is looking at. */
	let stageError = $derived(
		(() => {
			const after = stageNewest ? chat.indexOf(stageNewest) : -1;
			const errs = chat.filter((c, i) => i > after && c.kind === 'error');
			const last = errs[errs.length - 1] ?? null;
			// Not while looking at an older clip: the error belongs to the end of the
			// chain, and stepping back through the strip is not the moment to be told
			// about it again.
			return stageSel ? null : last;
		})()
	);

	/** When the current wait began. Set on send, cleared when a clip lands.
	 *
	 *  Its own clock rather than a reading of the render machinery: the stage only
	 *  needs to know that something is being made and for how long, and every other
	 *  answer to that question is spread across the launch, the poll and the chain. */
	let stageStartedAt = $state(0);
	let stageNow = $state(Date.now());
	$effect(() => {
		if (!stageClockFrom) return;
		const t = setInterval(() => (stageNow = Date.now()), 500);
		return () => clearInterval(t);
	});
	/** The clip that arrived while this page was watching for it.
	 *
	 *  Only that one plays by itself. Autoplay on every load meant opening the app
	 *  started making noise in a tab nobody was looking at — and the clips have
	 *  sound, which is the whole point of them. A finished render is different: the
	 *  operator has been waiting for it and pressing play is a step they did not
	 *  ask for. */
	let stageAutoplayId = $state('');
	/** Which clip was newest when the current wait began.
	 *
	 *  Without it the wait ended the instant it started: the effect below cleared
	 *  the clock as soon as it saw a clip on the stage, and there is always a clip
	 *  on the stage — the one being continued. So the phase never reached
	 *  'working', the loader never appeared, and the previous take sat there
	 *  looking finished for the whole six minutes. */
	let stageWaitFrom = $state('');
	/** The clip this wait continues, blurred behind the loader.
	 *
	 *  Only for a continuation: the picture behind it is then genuinely where the
	 *  new one starts, so it says something true about what is coming. For a fresh
	 *  clip there is nothing honest to show — the last take is a different scene —
	 *  and a picture that has nothing to do with the render would read as progress
	 *  on it. That case gets the dot field instead. */
	let stageWaitBlurUrl = $state('');
	/** The clip's rendered width, measured rather than assumed. The composer under
	 *  it is set to match: the two read as one object when their edges line up, and
	 *  the width depends on the clip's aspect ratio and the height it was given, so
	 *  no fixed number could follow it. */
	let stageVideoW = $state(0);
	/** The shown clip's own shape, straight off the file.
	 *
	 *  `max-height: 100%` only means anything when the box above it has a height
	 *  to take the percentage of, and the picture's box is sized to the picture —
	 *  auto height, so the limit silently evaluated to no limit. A 16:9 clip never
	 *  notices: it runs out of width first. A 9:16 one is taller than the room it
	 *  is given, so it draws its full height regardless and the composer, painted
	 *  after it, ends up lying across the bottom of the picture — measured at 375
	 *  points wide, 596 of clip in a 544-point slot.
	 *
	 *  Only for the shape that needs it. Given a height unconditionally, a
	 *  landscape clip on a phone leaves its box standing full height behind a
	 *  picture a third as tall, and the marks that ride on the picture float in
	 *  the black above it: 335x188 of clip in a 335x572 box. */
	let stageVidW = $state(0);
	let stageVidH = $state(0);
	/** Teardown for the audio rules installed on mount. */
	let cleanupAudio: (() => void) | null = null;
	/** The brief behind what is on the stage.
	 *
	 *  The stage deliberately shows no prompt — that was the point of it. But the
	 *  brief is still what decides how a clip comes back, and when one misses,
	 *  editing the words and sending again is the shortest fix there is. The
	 *  button beside Continue puts it back in the composer, where the send arrow
	 *  already lives. */
	// A NEW clip landing is what ends the wait — not the presence of an old one.
	$effect(() => {
		if (!stageStartedAt || !stageNewest) return;
		if (stageNewest.id === stageWaitFrom) return;
		stageAutoplayId = stageNewest.id;
		stageStartedAt = 0;
	});

	/** Both halves of the wait, from this machine's own finished runs: the model
	 *  round trip that writes the shot, then the render. Falls back to a flat guess
	 *  until there are enough samples to have a median at all. */
	const STAGE_ETA_FALLBACK_MS = 6 * 60 * 1000;
	let stageEtaMs = $derived(
		(typicalWait('prompt') ?? 0) + (typicalWait('clip') ?? 0) || STAGE_ETA_FALLBACK_MS
	);
	/** A render this page did not start, or started before a reload.
	 *
	 *  `stageStartedAt` is memory and dies with the tab; `startedAt` is written
	 *  into the session and comes back with it. Reload during a six-minute render
	 *  and the stage went blank — welcome screen, examples, no loader — while the
	 *  GPU was still working and the old one-line counter below carried on
	 *  ticking. The clip is in flight until its own workspace is the newest thing
	 *  on the stage. */
	/** Whether the run holding the render slot is a sheet rather than a clip.
	 *
	 *  `$state`, and set at every launch rather than only at the sheet's: a flag
	 *  that is only ever turned on stops being a fact about the current run the
	 *  first time a clip follows a sheet. */
	let renderIsSheet = $state(false);

	let renderInFlight = $derived(
		!!renderWs &&
			// A sheet is not a clip, and the stage is the clip's.
			//
			// Sheets take the same render slot as a shot — one slot, deliberately —
			// so launching one sets renderWs and startedAt exactly as a clip does.
			// But this clock only stops when the newest thing on the stage IS that
			// workspace, and a sheet never puts a clip there: it draws six views into
			// the library. So the loader started, found nothing to wait for, climbed
			// to its 97% cap and sat there for the whole ten minutes a turnaround
			// takes — announcing a video that was never coming, over a picture that
			// had already arrived. The sheet has its own line under the composer and
			// says its own name in it.
			!renderIsSheet &&
			startedAt > 0 &&
			stageNewest?.artifact?.workspace !== renderWs
	);
	/** Whichever clock is running. */
	let stageClockFrom = $derived(stageStartedAt || (renderInFlight ? startedAt : 0));
	let stageElapsedMs = $derived(stageClockFrom ? stageNow - stageClockFrom : 0);
	/** Capped just short of full: a bar that sits at 100% while nothing happens is
	 *  a worse lie than one that sits at 97%. */
	let stagePercent = $derived(
		Math.min(97, Math.floor((stageElapsedMs / Math.max(1, stageEtaMs)) * 100))
	);

	/** The clip the composer would continue if asked: the newest one, when the
	 *  chain can actually take a continuation from it. */
	/** The clip a continuation would carry on from: the one being WATCHED, not the
	 *  one that happened to land last.
	 *
	 *  The chain is a strip you can click back through, and clicking back is how
	 *  you decide a take went wrong three clips ago. Pinned to the newest, the
	 *  continuation ignored that: you could sit on the second clip, press "Last
	 *  frame", and get a fifth one starting from the fourth — the surface showed
	 *  one thing and the render used another, with nothing saying so.
	 *
	 *  stageClip already resolves the same way for everything else on this
	 *  surface: the selected entry, or the newest when nothing is selected. The
	 *  effect below re-targets whenever this changes, so switching clips in the
	 *  strip moves the continuation with it, and contOffFor is keyed per clip so
	 *  turning it off for one does not turn it off for the rest. */
	let stageContinuable = $derived(
		(() => {
			const ws = stageClip?.artifact?.workspace ?? '';
			return ws && contInfo(ws).ok ? stageClip : null;
		})()
	);
	/** The clip the operator switched continuation OFF for. Without it the effect
	 *  below would switch it straight back on, which is a tick box that cannot be
	 *  unticked. */
	let contOffFor = $state('');
	// Ticked by default: a clip that just landed is nearly always the thing the
	// next message continues, and making that the standing answer is the whole
	// point of moving the button down here.
	$effect(() => {
		if (!STAGE_UI || !stageContinuable) return;
		if (contOffFor === stageContinuable.id) return;
		if (continuing?.workspace === stageContinuable.artifact?.workspace) return;
		startContinue(stageContinuable);
	});

	/** The round the operator is in the middle of: streaming, waiting to be
	 *  agreed with, or stopped and waiting to be sent again.
	 *
	 *  All three at once, on purpose. They were split before — the stage drew
	 *  only a round that had already finished arriving, and took the loader for
	 *  everything up to it — which put "Generating" over a read-back nobody had
	 *  agreed to yet, then produced the finished sentence in one go. The
	 *  read-back exists to be watched while it is still free to change; a
	 *  surface that hides the writing and shows only the verdict is the
	 *  automatic accept again, wearing a spinner.
	 *
	 *  Never over a render. Once the clock is running the round has been agreed
	 *  and the clip is what the stage is for, and a round left behind by a shot
	 *  that went on to render is history rather than a prompt for action. */
	let stageRound = $derived(
		(() => {
			if (stageClockFrom) return null;
			for (let i = chat.length - 1; i >= 0; i--) {
				const c = chat[i].confirm;
				if (!c) continue;
				const card = c.cardId ? chat.find((x) => x.id === c.cardId) : null;
				if (card?.shot?.launched) return null;
				if (c.error || c.fixed?.length || c.streaming || (!c.sent && c.line.trim())) {
					return chat[i];
				}
				return null;
			}
			return null;
		})()
	);

	/** The message a round is an answer to.
	 *
	 *  Usually its own `said`. A round raised by a moved setting has none — it
	 *  answers the composer rather than a sentence — and in the transcript that
	 *  is fine, because the message it is still about is a few lines up. The
	 *  stage shows one round and nothing above it, so it carries the request
	 *  forward rather than drawing a reply to an empty screen. */
	function roundRequest(item: ChatItem): string {
		const at = chat.indexOf(item);
		for (let i = at; i >= 0; i--) {
			const said = chat[i].confirm?.said?.trim();
			if (said) return said;
		}
		return '';
	}

	/** Whether the strip is on screen at all.
	 *
	 *  Named because two places need the same answer and they had drifted: the
	 *  column rendered whenever a clip was being made, but the margin that keeps
	 *  it clear of the picture was only applied when there was more than one
	 *  thumbnail. One clip plus one pending tile satisfied the first and not the
	 *  second, so the strip sat on top of the video. */
	/** `sending` still counts, for the sends that have no round to show: a photo
	 *  going up, a character or a location sheet being written. A clip's own send
	 *  raises its round in the same tick, so the loader never gets the read-back. */
	/** The measure everything under the stage keeps: the clip's own width.
	 *
	 *  The composer was capped to it so their edges line up, but the rows above it
	 *  — the reference chips, the hint line, the film reel — were outside that and
	 *  ran the full column. Adding a clip to the film therefore opened a bar that
	 *  reached from edge to edge over a composer half its width, which reads as
	 *  two unrelated surfaces rather than one stack.
	 *
	 *  Three consumers, one definition. The last time the same measure was written
	 *  out twice, the two copies drifted the moment the layout beside them moved.
	 *
	 *  There is no gutter any more. Both boxes used to carry six rems of padding
	 *  on the left to clear the strip; the strip is in the right-hand margin now
	 *  and takes nothing, so the padding was width surrendered to a column that
	 *  had moved out from under it. */
	/** …and a floor under it, which is the measure the empty page already uses.
	 *
	 *  Capped to the picture alone the composer inherited the picture's problem:
	 *  the picture is 16:9 and height-bound, so on a wide, short window it is
	 *  narrow, and everything pinned to it went narrow with it — a composer and a
	 *  film reel squeezed into the middle of a screen with room to spare, under
	 *  the three suggestion cards that had been sitting at 48rem the whole time.
	 *
	 *  So: at least what the suggestions take, and the picture's width whenever
	 *  that is more. The two line up on any window tall enough for the picture to
	 *  reach 48rem, which is the case the alignment was for; below that the
	 *  composer stops shrinking rather than following the picture down. */
	const COMPOSER_FLOOR = '48rem';
	let composerCap = $derived(
		STAGE_UI
			? // min() around the floor, because the floor is a desktop measurement.
				// 48rem is 768px and a phone is 375: without this the composer asks to be
				// twice the window, and the "stops shrinking rather than following the
				// picture down" rule — written for a window wider than any clip — turns
				// into an element wider than the screen.
				`max-width:min(100%, max(${COMPOSER_FLOOR}, ${Math.max(stageVideoW, 0)}px))`
			: undefined
	);

	/** A subject being made right now — a photograph going up, or a description
	 *  going to the sheet writer.
	 *
	 *  It is a send like any other, so the stage took the clip's loader for it:
	 *  the full 16:9 block with "Generating" on it, for a second, before the
	 *  character surface replaced it. A picture of a video being made, over work
	 *  that makes no video, and the swap between the two is the jump. The
	 *  character surface owns this from the first press; the wait belongs in the
	 *  frame the picture will land in, at the size the picture will be. */
	let makingSubject = $derived(sending && wantTarget !== 'clip');

	let stagePhaseIsWorking = $derived(
		!stageError && !stageRound && !makingSubject && (stageClockFrom || sending)
	);
	let showStrip = $derived(stageThumbs.length > 1 || !!stagePhaseIsWorking);

	/** The subject this session made — or is making — when there is no clip.
	 *
	 *  It asked for `sheet.id`, and an id only exists once the subject has been
	 *  KEPT. That is a deadlock: keeping is a button on the card, and the card is
	 *  what an id was required to show. A preview rendered for thirty seconds, a
	 *  loader appeared while the request was in flight and vanished the moment it
	 *  returned, and the finished picture landed on disk with no surface able to
	 *  offer it. Four of those are sitting in previews/ unclaimed.
	 *
	 *  A job or a url is the same evidence an id is: something was started, and
	 *  it belongs on the stage. The id then arrives on the card already there.
	 *
	 *  (Originally: the character this session made, when it made one and no
	 *  clip.)
	 *
	 *  A sheet is a chat item, and in simple mode the stage stands in for the
	 *  transcript — so a finished character had nowhere to appear at all. You
	 *  watched a line count down, the line went away, and the surface was the
	 *  welcome screen again. The work was not lost: the sheet is in the library
	 *  and the composer is already pointed at it. Nothing said so.
	 *
	 *  Only when there is no clip. A clip is what the stage is for, and a
	 *  character made in the middle of a chain is a step in it, not the subject. */
	let stageSheet = $derived(
		stageClips.length
			? null
			: (chat
					// `workspace` alone is a preview the harness is still drawing: the card
					// is on the transcript from the launch so the stage has something to
					// stand on while the picture is two minutes out.
					.filter(
						(c) =>
							c.kind === 'sheet' &&
							(c.sheet?.id || c.sheet?.job || c.sheet?.url || c.sheet?.workspace)
					)
					.at(-1) ?? null)
	);

	/** The character this session is drawing right now, when there is no clip to
	 *  keep the surface busy with.
	 *
	 *  Without it the stage went blank between the upload and the sheet landing —
	 *  and then, worse, the finished picture appeared as if the work were over
	 *  while the six views were still ten minutes out. A loader for a second,
	 *  gone, and a photograph in its place is a surface contradicting itself.
	 *
	 *  Only with no clip on the stage. With one, the clip stays and the sheet
	 *  reports on its own line — the alternative is the loader that sat at 97%
	 *  over an arrived picture for a quarter of an hour. */
	/** Which of the character's three things the stage is showing.
	 *
	 *  Empty means follow the work: the reference until the turnaround lands, the
	 *  turnaround until the six views are cut, the six views after that. A press
	 *  pins it, and a different character clears the pin — the choice was about
	 *  that person, not a standing preference. */
	let charView = $state<'' | 'ref' | 'turn' | 'six'>('');

	let stageDrawing = $derived(stageClips.length ? null : (drawingHere[0] ?? null));

	let stagePhase = $derived(
		stageError
			? 'error'
			: stageRound
				? 'round'
				: makingSubject
					? 'character'
					: stageClockFrom || sending
						? 'working'
						: stageClip
							? 'ready'
							: stageDrawing || stageSheet
								? 'character'
								: 'empty'
	);

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
		// The shelf's contents, which outlive every session.
		void loadFilms();
		void loadMedia();

		// One voice at a time, and none of it behind your back.
		//
		// Several clips are on screen at once — the stage, the strip, the reel, the
		// popup — and any of them starting means the last one should stop. Muted
		// ones are decoration and are left alone; it is the audible ones that
		// collide. Without this a clip carried on talking from a closed panel or a
		// production you had already left, and the only way to find it was to hunt
		// through the page for the element still playing.
		//
		// `play` does not bubble, so the listener captures.
		const audible = () =>
			[...globalThis.document.querySelectorAll('video')].filter((v) => !v.muted);
		const onPlay = (e: Event) => {
			// A muted clip starting silences nothing. The rule reads "one thing
			// talking at a time", and decoration is not talking — but the guard used
			// to be only on the victims, never on the trigger, so any muted video
			// beginning would stop whatever was audible. That cost nothing until the
			// front page grew a wall of muted tiles that start themselves every four
			// seconds: opening a film and watching it play for two and a half seconds
			// before stopping dead was this line, every time.
			if ((e.target as HTMLVideoElement).muted) return;
			for (const v of audible()) if (v !== e.target) v.pause();
		};
		const onHidden = () => {
			if (globalThis.document.hidden) for (const v of audible()) v.pause();
		};
		globalThis.document.addEventListener('play', onPlay, true);
		globalThis.document.addEventListener('visibilitychange', onHidden);
		cleanupAudio = () => {
			globalThis.document.removeEventListener('play', onPlay, true);
			globalThis.document.removeEventListener('visibilitychange', onHidden);
		};
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
				// Snapped to what the row can show. The durations were 5/6/8/10/12/15
				// and are now 5/10/15, so a stored 6, 8 or 12 would restore a value with
				// no pill to light up — the fold would read 5s while the send made 8. A
				// setting the surface cannot show is a setting nobody can correct.
				if (typeof v.s === 'number' && v.s >= 4 && v.s <= 15) {
					const was = v.s;
					wantSeconds = [5, 10, 15].reduce((a, b) =>
						Math.abs(b - was) < Math.abs(a - was) ? b : a
					);
				}
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
			if (sheetsWorking || Object.values(shotBusy).some(Boolean)) now = Date.now();
		}, 1_000);
		// A run outlives its poll, and nothing used to notice.
		//
		// The loop reschedules itself at the end of each tick, so any path that
		// returns early — a stale run id, a workspace that went missing for one
		// tick, a throw — simply stops it, and the loop is the only thing that
		// ever collects a finished render. A character sheet finished on the
		// harness, paid for and sitting on a presigned url, while this page showed
		// it building for a quarter of an hour and never asked again. The job was
		// still there: it answered on the first ask afterwards.
		//
		// So: if there is a workspace to watch and nothing watching it, start
		// again. Twenty seconds is far below the cost of noticing by hand and far
		// above the poll's own cadence, so a healthy loop never trips it.
		const watchdog = setInterval(() => {
			if (activeWs && !pollingActive && !staleRun) startPolling();
		}, 20_000);
		return () => {
			clearInterval(clock);
			clearInterval(fast);
			clearInterval(watchdog);
			stopPolling();
			cleanupAudio?.();
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
				{offline
					? 'The harness is not responding — showing the last known state.'
					: 'Error from the harness — showing the last known state.'}
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

{#snippet confirmReply(item: ChatItem, canPress: boolean)}
	{#if item.confirm}
		{@const c = item.confirm}
		{@const parts = splitConfirm(c.line)}
		<!-- What is about to be shot, in the operator's own language.
		     Deliberately plain: no card chrome, no heading, no label saying what it
		     is. It reads as the studio answering, because that is what it is — and a
		     box around it would make it look like a form to fill in rather than a
		     sentence to agree with.

		     One drawing, two surfaces. The stage grew its own version of this — the
		     same three parts, centred in a 16:9 box, at rest — and the two designs
		     drifted the moment there were two of them. `canPress` is the only thing
		     the callers disagree about: the transcript shows the button on the newest
		     unlaunched round and nowhere else, because an older round is a step in
		     the conversation rather than an order you can still place; the stage
		     shows one round and it is always that one. -->
		<div class="enter">
			<!-- What is missing, said in as few words as it takes.
				 No box, no icon, no colour — except the refusal, which is the one
				 thing on this surface allowed to be red. Two of the six also take
				 the card away: a rule cannot be pressed past, and a picture with
				 no words is not a shot to agree to. The rest ask and leave the
				 button alone, and pressing it answers on the way past. -->
			{#if askAbout?.id === item.id && !c.streaming && c.line.trim()}
				{@const ask = askAbout.kind}
				{@const bad = ask === 'blocked'}
				<div class="enter {bad ? 'rounded-xl bg-[var(--st-warn,#e06c6c)]/[0.09] p-3.5' : ''}">
					<p
						class="text-sm leading-relaxed {bad
							? 'font-semibold text-[var(--st-warn,#e06c6c)]'
							: 'text-[var(--st-text)]'}"
					>
						{ask === 'blocked'
							? "Can't make this."
							: ask === 'self'
								? "You're in this one."
								: ask === 'who'
									? 'Who is this?'
									: ask === 'sheet'
										? "That's a character."
										: ask === 'no-words'
											? 'Add a prompt.'
											: "That's a subject."}
					</p>
					<p class="mt-1 max-w-[26rem] text-xs leading-relaxed text-[var(--st-muted)]">
						{ask === 'blocked'
							? 'It describes someone under age. Write a different shot — everyone in it has to be an adult.'
							: ask === 'self'
								? 'Attach a photo, or the model invents a face.'
								: ask === 'who'
									? 'Say who they are, or attach a picture.'
									: ask === 'sheet'
										? 'That describes a person. Say what they do, and where.'
										: ask === 'no-words'
											? 'A picture is not a shot. Say what happens in it.'
											: 'Say what happens, and where.'}
					</p>

					{#if ask === 'self' || ask === 'who'}
						<label
							class="pillglass mt-2.5 inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-full px-3.5 text-xs font-medium text-[var(--st-text)] transition-colors"
						>
							<svg viewBox="0 0 20 20" class="size-3.5" fill="none" aria-hidden="true">
								<path
									d="M13 7l-5.5 5.5a2.1 2.1 0 003 3L16 10a3.5 3.5 0 00-5-5l-5.5 5.5a5 5 0 007 7L18 12"
									stroke="currentColor"
									stroke-width="1.6"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
							{ask === 'self' ? 'Add a photo of you' : 'Add a picture of them'}
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
								}}
							/>
						</label>
					{/if}

					<!-- The missing parts, as things to press rather than things to read.
						 A chip that says "where it happens" is a label; one that opens the
						 location picker is an answer. `action` has nowhere to go but the
						 box, so it puts the cursor there. -->
					{#if (ask === 'too-short' || ask === 'sheet') && askAbout.missing.length}
						<p class="mt-3 text-xs text-[var(--st-faint)]">Add anything?</p>
						<div class="mt-1.5 flex flex-wrap gap-1.5">
							{#each askAbout.missing as bit (bit)}
								<button
									type="button"
									class="pillglass cursor-pointer rounded-full px-2.5 py-1 text-[11px] text-[var(--st-muted)] transition-colors hover:text-[var(--st-text)]"
									onclick={() => {
										if (bit === 'character') {
											shutMenus();
											pickKind = 'character';
										} else if (bit === 'place') {
											shutMenus();
											pickKind = 'location';
										} else {
											composer?.focus();
										}
									}}
								>
									{bit === 'character'
										? 'a character'
										: bit === 'place'
											? 'a place'
											: bit === 'action'
												? 'what happens'
												: 'the camera'}
								</button>
							{/each}
						</div>
					{/if}
				</div>
			{/if}
			<!-- The shot is an object, and the talk around it is talk.
				 Everything on this card used to be prose in one column — the
				 question, the guess, the footnote and the button all the same
				 weight, so there was nothing to agree TO, only a paragraph to
				 read. What is being made now has an edge around it, and the two
				 numbers you commit and the button that commits them are inside
				 that edge rather than floating under it. You approve a thing.

				 The conversation above it stays unframed on purpose: a bubble or a
				 second card around the question would make two objects out of one
				 object and one remark. -->
			<!-- No card under a refusal, and none under a picture with no words.
				 One cannot be pressed past; the other has nothing to agree to yet, and
				 showing an invented shot there is what started all of this. -->
			{#if askAbout?.id !== item.id || (askAbout.kind !== 'blocked' && askAbout.kind !== 'no-words')}
				<div class="shotglass mt-3 overflow-hidden rounded-2xl ring-1 ring-[var(--st-line)]">
					<div class="p-4">
						{#if askAbout?.id === item.id}
							<p class="mb-1.5 text-xs text-[var(--st-faint)]">One way it could go</p>
						{:else if parts.lead}
							<p class="mb-1.5 text-xs text-[var(--st-faint)]">{parts.lead}</p>
						{/if}
						<p class="doc text-sm leading-relaxed text-[var(--st-text)]">
							{parts.said}{#if c.streaming && !parts.added}<span class="caret" aria-hidden="true"
								></span>{/if}
						</p>
						{#if parts.added}
							<!-- Ours, and it has to look it. Same size, quieter colour: it is not a
							     footnote — it is half of what starts if the button is pressed — but
							     it is an offer, and an offer that looks like a statement is not one. -->
							<p class="doc mt-1.5 text-sm leading-relaxed text-[var(--st-muted)]">
								{parts.added}{#if c.streaming}<span class="caret" aria-hidden="true"></span>{/if}
							</p>
						{/if}

						{#if c.error}
							<p class="mt-2 text-xs leading-relaxed text-[var(--st-faint)]">{c.error}</p>
						{/if}

						<!-- The checker had to change the brief, so this is no longer the clip that
						     was agreed to. It says what moved and waits: sending it anyway is a
						     decision, and it is not ours. -->
						{#if c.fixed?.length}
							<p class="mt-3 text-xs leading-relaxed text-[var(--st-muted)]">
								We adjusted this while writing it: {c.fixed.join(' · ')}
							</p>
						{/if}
					</div>

					<!-- No button under a refusal. Everything else here is an offer with
						 the press still available; this one is not, and leaving it there
						 would say the rule is a suggestion. -->
					{#if canPress && !c.streaming && c.line.trim() && askAbout?.kind !== 'blocked'}
						<!-- The cost sits with the button that spends it, on the card's own
						     floor. Not a warning — the two numbers a person wants before
						     they commit, in the place where committing happens. -->
						<div
							class="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--st-line)] py-2.5 pr-3 pl-4"
						>
							<span class="text-xs text-[var(--st-faint)]">
								{composerShape.seconds}s{#if typicalClip}&nbsp;· {typicalLabel(typicalClip)}{/if}
							</span>
							<button
								type="button"
								disabled={shotBusy[item.id]}
								class="btn btn-primary"
								onclick={() => {
									selfAnsweredBySending(item.id);
									acceptConfirm(item.id);
								}}
							>
								{#if shotBusy[item.id]}
									{@const el = Math.max(0, Math.round((now - (c.busySince ?? now)) / 1000))}
									{c.phase === 'writing'
										? 'writing the brief'
										: c.phase === 'starting'
											? 'opening the workspace'
											: 'starting'} ·
									{clock(el)}
								{:else if c.fixed?.length}
									send it anyway
								{:else}
									{c.continues ? 'Continue the clip' : 'Generate the video'}
								{/if}
							</button>
						</div>
					{/if}
				</div>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet filmReel()}
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
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="reel flex min-w-0 flex-1 items-center overflow-x-auto py-0.5"
			ondragover={(e) => {
				if (e.dataTransfer?.types.includes(CLIP_DRAG)) e.preventDefault();
			}}
			ondrop={(e) => dropClipIntoFilm(e)}
		>
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
						if (e.dataTransfer?.types.includes(CLIP_DRAG)) return;
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
						src={still(fileUrl(c.workspace, c.artifact, c.file))}
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
{/snippet}

{#snippet document(blocks: Block[])}
	<div class="space-y-3.5 text-[0.95rem] leading-[1.7] text-[var(--st-text)]">
		{#each blocks as b, i (i)}
			{#if b.kind === 'heading'}
				<h4
					class="font-display font-semibold {b.level === 1 ? 'text-base' : 'text-sm'} {i > 0
						? 'pt-2'
						: ''}"
				>
					{b.text}
				</h4>
			{:else if b.kind === 'para'}
				<p>
					{#each b.spans as s, j (j)}{#if s.bold}<strong class="font-semibold">{s.text}</strong
							>{:else if s.italic}<em>{s.text}</em>{:else}{s.text}{/if}{/each}
				</p>
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
				<p
					class="pt-3 font-mono text-xs font-semibold tracking-widest text-[var(--st-muted)] uppercase"
				>
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
<!-- One thing this studio made. Films get the wider box and the shot count
	 the badge; a shot gets its length and nothing else, because on a grid of
	 thirty-six the only question is which one it was. -->
{#snippet starters()}
	<!-- The next card peeks past the right edge, so the row reads as a row before
		 anything has moved. Snap, so a swipe lands on a card rather than between
		 two of them. -->
	<div class="w-full max-w-[34rem] pt-2 sm:max-w-3xl">
		<div
			bind:this={starterRow}
			onscroll={starterScrolled}
			onpointerdown={() => (starterHeld = true)}
			class="starterrow flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 sm:grid sm:grid-cols-3 sm:gap-2.5 sm:overflow-visible sm:pb-0"
		>
			{#each examples as ex, i (ex)}
				<button
					type="button"
					onclick={() => useExample(ex)}
					aria-label="use this example"
					aria-current={i === starterAt}
					class="relative flex min-h-[5.5rem] w-[86%] shrink-0 cursor-pointer snap-start items-start gap-2.5 rounded-xl p-4 text-left text-sm leading-snug text-[var(--st-muted)] ring-1 ring-[var(--st-line)] transition-colors hover:bg-[var(--st-surface)] hover:text-[var(--st-text)] hover:ring-transparent sm:w-full sm:shrink"
				>
					<span class="min-w-0 pr-4">{ex}</span>
					<!-- Says what the tap does: it fills the box, it does not send. -->
					<svg
						viewBox="0 0 16 16"
						class="absolute top-3 right-3 size-3 opacity-30"
						fill="none"
						aria-hidden="true"
					>
						<path
							d="M4 12L12 4M6 4h6v6"
							stroke="currentColor"
							stroke-width="1.6"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</button>
			{/each}
		</div>
		<!-- How many there are, and which one this is. The dots do the telling;
			 they are not a control, so they are not a target. -->
		<div class="mt-2 flex justify-center gap-1.5 sm:hidden" aria-hidden="true">
			{#each examples as ex, i (ex)}
				<span
					class="h-1.5 rounded-full transition-all duration-300 {i === starterAt
						? 'w-4 bg-[var(--st-muted)]'
						: 'w-1.5 bg-[var(--st-line)]'}"
				></span>
			{/each}
		</div>
	</div>
{/snippet}

{#snippet mediaTile(m: ShelfItem, i: number)}
	<button
		type="button"
		aria-label="film, {clipClock(m.seconds)}"
		onclick={() => (mediaPopup = m)}
		class="group relative mb-2 block w-full cursor-pointer break-inside-avoid overflow-hidden rounded-xl bg-[var(--st-surface)] {tileRatio(
			m.seconds
		)}"
	>
		<!-- No length, no shot count, no caption. A wall of stills is looked at,
			 not read, and a badge on every tile turns a shelf back into a file
			 listing — which is what this stopped being. The length is still in the
			 label for anybody navigating by voice or keyboard, where it is the only
			 way to tell one tile from the next. -->
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={tileEls[m.id]}
			src={still(shelfUrl(m))}
			muted
			loop
			playsinline
			preload="metadata"
			class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.04]"
		></video>
	</button>
{/snippet}

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
				src={still(fileUrl(run.clip.workspace, run.clip.artifact, run.clip.file))}
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
				class="pointer-events-none absolute bottom-1.5 left-1.5 rounded-[5px] bg-black/50 px-1.5 py-px text-[11px] font-medium text-white tabular-nums backdrop-blur-md"
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
	<!-- The name and the control that opens the list, in the page's own corner.
		 There were two of these — one in the rail, one in the main column, each
		 shown when the other was not — on the theory that they sat at the same
		 point and so nothing appeared to move. They did sit at the same point,
		 until the layout beside them changed: the main column now starts after the
		 rail's reserved space, so the closed copy was drawn a rail's width in and
		 the wordmark jumped sideways every time the list was opened or shut.

		 Two things that must stay in one place cannot be two things. This is one
		 header, fixed to the viewport, above both the rail and the page: it is
		 drawn once, it cannot be moved by anything either of them does, and the
		 panel slides out from under it. -->
	<header class="fixed top-0 left-0 z-50 flex h-12 items-center gap-2.5 px-3">
		<button
			type="button"
			aria-label={sidebarOpen ? 'hide past productions' : 'show past productions'}
			aria-expanded={sidebarOpen}
			onclick={() => setNavOpen(!sidebarOpen)}
			class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--st-muted)] transition-colors hover:bg-[var(--st-surface)] hover:text-[var(--st-text)]"
		>
			<!-- Three rules, the last one short. It reads as a list that can be
					 pulled open rather than as a menu, and the ragged end keeps it from
					 sitting like a block of three identical bars. -->
			<svg viewBox="0 0 16 16" class="size-[18px]" fill="none" aria-hidden="true">
				<path
					d="M2.5 4h11M2.5 8h11M2.5 12h7"
					stroke="currentColor"
					stroke-width="1.5"
					stroke-linecap="round"
				/>
			</svg>
		</button>
		<!-- The product's name, at a size a name is set at. It was ten pixels of
			 letterspaced caps in the faintest colour on the page — the least legible
			 text in the app was the thing it is called. -->
		<!-- The name is the way home. Every product with a shelf behind it works
			 this way, and there was no way back to the front page at all: once a
			 session had a message in it the only route to what you had made was the
			 sidebar, and on a phone the sidebar is closed. -->
		<button
			type="button"
			title="everything you have made"
			onclick={() => {
				reset();
				void loadMedia();
				if (window.innerWidth < 1024) setNavOpen(false);
			}}
			class="cursor-pointer font-display text-[1.0625rem] font-semibold tracking-[-0.02em] transition-opacity hover:opacity-70"
		>
			Auteur
		</button>
	</header>

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
		<!-- The room the fixed header stands in. The rail's list begins below it. -->
		<div class="h-12 shrink-0" aria-hidden="true"></div>

		<!-- The two doors, named apart.
			 They were one radio pair inside the composer's format menu, which put a
			 choice about WHAT KIND OF WORK this is next to a choice about how many
			 takes of it to shoot. They are not the same size of decision: one clip
			 is a shot you carry forward by hand, a full production writes a
			 screenplay and shoots a scene list from it, and the second one keeps the
			 chat surface because a plan is a conversation.
			 The names are the ones the menu already used. -->
		<div class="px-3 pt-2 pb-2">
			<!-- One door. The second one — a full production: a screenplay first, then a
				 scene list shot from it — is a different product with a different
				 surface, and offering it beside "New clip" asked a person to choose
				 between the two before they had made anything at all. The mode is
				 intact and a production already made still opens in it; it is simply
				 not the first question the studio asks. -->
			{#each [{ id: 'simple', label: 'New clip', hint: 'shots, chained by hand' }] as door (door.id)}
				<button
					type="button"
					onclick={() => {
						// `New` in both names, so both start one. The row above them used to
						// be the only way to begin again, and with it gone these have to do
						// what they say — clicking "New clip" while already making clips
						// otherwise did nothing at all, which is the worst answer a button
						// with that name can give.
						reset();
						setMode(door.id as 'simple' | 'advanced');
						if (window.innerWidth < 1024) setNavOpen(false);
					}}
					aria-current={mode === door.id ? 'page' : undefined}
					class="flex min-h-10 w-full cursor-pointer items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors {mode ===
					door.id
						? 'bg-[var(--st-surface)] font-semibold text-[var(--st-text)]'
						: 'text-[var(--st-muted)] hover:bg-[var(--st-surface)]'}"
					title={door.hint}
				>
					<svg
						viewBox="0 0 16 16"
						class="size-4 shrink-0 {mode === door.id ? '' : 'text-[var(--st-faint)]'}"
						fill="none"
						aria-hidden="true"
					>
						{#if door.id === 'simple'}
							<!-- A frame with a play mark in it. The mark was a bare three-point
								 triangle with hard corners sitting inside a rounded frame — the
								 one shape on the icon that had not been told what the others
								 were doing. Stroked in its own fill with a round join, it keeps
								 its weight and gets the corners the rest of the set has. -->
							<rect
								x="2.5"
								y="4"
								width="11"
								height="8"
								rx="2"
								stroke="currentColor"
								stroke-width="1.5"
							/>
							<path
								d="M7.1 6.6 9.9 8l-2.8 1.4z"
								fill="currentColor"
								stroke="currentColor"
								stroke-width="1.1"
								stroke-linejoin="round"
							/>
						{:else}
							<rect
								x="2.5"
								y="3"
								width="11"
								height="10"
								rx="2"
								stroke="currentColor"
								stroke-width="1.5"
							/>
							<path
								d="M5.2 6h5.6M5.2 8.4h5.6M5.2 10.6h3.2"
								stroke="currentColor"
								stroke-width="1.5"
								stroke-linecap="round"
							/>
						{/if}
					</svg>
					<span class="min-w-0 truncate">{door.label}</span>
				</button>
			{/each}
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
									<!-- The full title on hover, because the row truncates it. The
										 native tooltip rather than a built one: it appears only while
										 the pointer is on the row, it cannot cover the row below it,
										 and it costs nothing. -->
									<span
										title={p.title}
										class="min-w-0 flex-1 truncate text-sm text-[var(--st-text)]">{p.title}</span
									>
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
										{p.sceneCount} scene{p.sceneCount === 1 ? '' : 's'}{p.renderWs
											? ' · shot'
											: ' · planning'}
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
		<!-- The shelf: what has actually been finished.
			 Everything above this line is work in progress — a production, a chain,
			 a take. A film is the thing that leaves, so it lives at the foot of the
			 rail where it is always reachable and never in the way, and the last
			 tile opens all of them. -->
		{#if films.length}
			<div class="border-t border-[var(--st-line)] px-3 pt-2.5 pb-1">
				<div class="flex items-center gap-1.5">
					{#each films.slice(0, 5) as f (f.workspace + f.artifact + f.file)}
						<button
							type="button"
							title="{f.parts} shots · {Math.round(f.seconds)}s"
							onclick={() => (filmPopup = f)}
							class="size-9 shrink-0 cursor-pointer overflow-hidden rounded-lg bg-[var(--st-surface)] ring-1 ring-transparent transition hover:ring-[var(--st-line-control)]"
						>
							<!-- svelte-ignore a11y_media_has_caption -->
							<video
								src={still(fileUrl(f.workspace, f.artifact, f.file))}
								muted
								playsinline
								preload="metadata"
								class="h-full w-full object-cover"
							></video>
						</button>
					{/each}
					<button
						type="button"
						aria-label="all media"
						title="all media"
						onclick={() => {
							mediaOpen = true;
							void loadPool();
						}}
						class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-[var(--st-surface)] text-[var(--st-muted)] transition-colors hover:bg-[var(--st-surface-2)] hover:text-[var(--st-text)]"
					>
						<svg viewBox="0 0 16 16" class="size-4" fill="none" aria-hidden="true">
							<rect
								x="2.5"
								y="2.5"
								width="4.6"
								height="4.6"
								rx="1.2"
								stroke="currentColor"
								stroke-width="1.5"
							/>
							<rect
								x="8.9"
								y="2.5"
								width="4.6"
								height="4.6"
								rx="1.2"
								stroke="currentColor"
								stroke-width="1.5"
							/>
							<rect
								x="2.5"
								y="8.9"
								width="4.6"
								height="4.6"
								rx="1.2"
								stroke="currentColor"
								stroke-width="1.5"
							/>
							<rect
								x="8.9"
								y="8.9"
								width="4.6"
								height="4.6"
								rx="1.2"
								stroke="currentColor"
								stroke-width="1.5"
							/>
						</svg>
					</button>
				</div>
			</div>
		{/if}

		<!-- The rail ends with the operator's own work.
		     It carried a link to /studio/admin under it — the prompt and model
		     registry, which is a workbench for whoever tunes the writers rather than
		     somewhere a person making a clip has reason to go. In the hosted app it
		     was worse than clutter: that route is not part of what ships there, so
		     the one control in the rail that was not the operator's own work was
		     also the one that led nowhere. The panel is reached by its own address
		     wherever it is deployed. -->
	</aside>

	<!-- The rail's own place, held while it is away. See the counterweight after
		 </main> for why both sides are reserved from xl up. -->
	{#if !sidebarOpen}
		<div class="hidden w-64 shrink-0 xl:block" aria-hidden="true"></div>
	{/if}

	<main class="relative flex min-w-0 flex-1 flex-col overflow-hidden">
		<!-- The same room on this side, so the transcript starts below the header
			 rather than under it. -->
		<div class="h-12 shrink-0" aria-hidden="true"></div>

		<!-- 66rem only when the task rail is beside it and needs the room. On its
			 own a reading column that wide is not a measure, it is a stretch: the
			 composer became a thousand pixels of single line and the eye had to
			 travel the width of the screen to find the send button. -->
		<div
			class="mx-auto flex min-h-0 w-full flex-1 flex-col px-5 pt-1 {STAGE_UI
				? 'max-w-[104rem]'
				: brief
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
					<!-- The stage is the CLIP surface, and only that.
					 It replaced the transcript in every mode at first, which quietly
					 swallowed the full-production flow: the plan, the screenplay, the
					 scene board and the crew’s replies are all cards, and a full
					 production is a conversation with them. What was left was a loader
					 counting to 97% over a planning run that renders no clip at all,
					 with the work sitting in cards nobody could see. -->
					{#if STAGE_UI && mode === 'simple'}
						<!-- ── the stage ──────────────────────────────────────────────────
					 A clip is made in one place and watched in the same place. The
					 transcript below is the same engine with its cards drawn; this is
					 what the operator asked to see instead — no read-back, no brief, no
					 announcement of a launch, and nothing to scroll. -->
						<!-- The strip floats rather than sits in the row.
					 In the row it took its width off the stage, so the clip centred in
					 what was left while the composer below centred in the whole column —
					 same width, forty-nine pixels apart, which reads as a mistake because
					 it is one. Floated, the clip has the column to itself and the two line
					 up; the strip lives in the margin the picture leaves beside it. -->
						<div class="relative flex min-h-0 flex-1">
							<!-- the chain, newest first. Four, because a strip that grows past
						 the stage's own height starts scrolling, which is the thing this
						 surface exists not to do. -->
							<!-- The chain lives in the right-hand margin, and takes nothing from
								 the picture. It used to sit on the left behind six rems of padding,
								 which is width off the one thing this surface exists to show — and
								 a clip is 16:9 inside a column that is wider than that, so the
								 margin it leaves on either side was already there and already
								 empty. Right rather than left because the eye starts at the
								 picture; the chain is where you go after it, not before. -->
							{#if showStrip}
								<div
									class="absolute right-0 bottom-0 z-10 flex w-[4.5rem] flex-col-reverse gap-2 lg:top-0 lg:bottom-auto lg:w-[5.4rem] lg:flex-col"
								>
									<!-- The one being made takes its place in the strip the moment it is
								 asked for, at the top where it will land. The chain is what this
								 column shows and the next link is already real — it is being paid
								 for — so leaving the row out until it arrives makes the strip
								 disagree with the stage beside it. -->
									{#if stagePhase === 'working'}
										<div
											class="flex aspect-video w-full shrink-0 items-center justify-center rounded-lg bg-[var(--st-surface)] ring-2 ring-[var(--st-text)]"
										>
											<span
												class="spin size-4 rounded-full border-2 border-[var(--st-surface-2)] border-t-[var(--st-accent)]"
											></span>
										</div>
									{/if}
									{#each stageThumbs as t (t.key)}
										{#if t.url}
											<!-- Nothing in the strip is lit while a new one is being made:
										 the pending row is where the attention belongs. -->
											{@const here =
												stagePhase !== 'working' &&
												t.workspace === stageShownWs &&
												(!!stageSel || stageNewest?.artifact?.key !== 'film')}
											<!-- The one on the stage is lit and the rest are stepped back, so
										 where you are in the chain is legible without reading
										 anything. -->
											<button
												type="button"
												draggable={!!t.artifact && !!t.file}
												ondragstart={(e) => {
													e.dataTransfer?.setData(
														CLIP_DRAG,
														JSON.stringify({
															workspace: t.workspace,
															artifact: t.artifact,
															file: t.file
														})
													);
													if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
												}}
												onclick={() => {
													// Picking a clip is leaving the error behind. Without this the
													// stage stayed on it: an export that failed once took over the
													// surface, survived a reload with the transcript, and every
													// thumbnail answered with the same dead message.
													if (stageError) chat = chat.filter((c) => c !== stageError);
													stageSel =
														t.workspace === (stageNewest?.artifact?.workspace ?? '')
															? ''
															: t.workspace;
												}}
												class="relative aspect-video w-full shrink-0 cursor-pointer overflow-hidden rounded-lg bg-black transition-opacity {here
													? 'opacity-100 ring-2 ring-[var(--st-text)]'
													: 'opacity-45 hover:opacity-75'}"
											>
												<!-- svelte-ignore a11y_media_has_caption -->
												<video
													src={still(t.url)}
													muted
													playsinline
													preload="metadata"
													onloadedmetadata={(e) =>
														(clipSecs = { ...clipSecs, [t.key]: e.currentTarget.duration })}
													class="h-full w-full object-cover"
												></video>
												{#if clipSecs[t.key]}
													<span
														class="pointer-events-none absolute right-1 bottom-1 rounded bg-black/65 px-1 font-mono text-[0.6rem] leading-4 text-white"
														>{clipClock(clipSecs[t.key])}</span
													>
												{/if}
											</button>
										{/if}
									{/each}
								</div>
							{/if}

							<!-- Centred while it fits, scrolled from the top when it does not.
								 `justify-center` alone does both jobs badly: a flex column whose
								 content is taller than the box overflows in BOTH directions, and
								 the part above the start edge cannot be scrolled to at all — the
								 front page's own headline and its films sat up there,
								 unreachable, the moment the shelf gave the column something to
								 be tall about. `auto` margins centre the same way and give way
								 when there is nothing left to give. -->
							<div
								class="stagescroll flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto [&>*]:shrink-0 {stagePhase ===
									'empty' && shelf.length
									? 'undercomposer -mb-32 pb-24'
									: ''}"
							>
								<div class="my-auto flex w-full flex-col items-center gap-2">
									{#if stagePhase === 'working'}
										<!-- The percentage is honest about what it is: elapsed against the
								 median of this machine's own finished runs. Half of all runs are
								 past a median, so it caps short of full and says so in words
								 rather than sitting at 100 while nothing happens. -->
										<!-- The size the clip will be, so nothing jumps when it arrives:
								 height-bound and 16:9, the same way the video is measured. -->
										<!-- The size the clip will be, so nothing jumps when it arrives. -->
										<div
											class="relative flex max-h-full max-w-full items-center justify-center overflow-hidden rounded-2xl bg-[var(--st-surface)] {composerShape.portrait
												? 'aspect-[9/16] h-full w-auto'
												: 'aspect-video w-full lg:h-full lg:w-auto'}"
										>
											{#if stageWaitBlurUrl}
												<!-- svelte-ignore a11y_media_has_caption -->
												<video
													src={stageWaitBlurUrl}
													muted
													autoplay
													loop
													playsinline
													class="absolute inset-0 h-full w-full scale-110 object-cover blur-2xl brightness-[0.55]"
												></video>
											{:else}
												<div class="stage-dots absolute inset-0"></div>
											{/if}
											<!-- One slow pass of light across the surface, and nothing else.
									 A still rectangle with a number on it cannot say whether it is
									 working or hung, and the number is the wrong instrument for
									 that: it is an estimate against a median, so it keeps moving
									 whether or not anything is happening. The sweep is the part
									 that means "running" — long, low-contrast, monochrome, closer
									 to breathing than to a spinner. It passes about every four
									 seconds, which is slow enough not to be watched and often
									 enough to be believed. -->
											<div class="stage-sweep pointer-events-none absolute inset-0"></div>
											<div class="relative flex flex-col items-center gap-2">
												<div
													class="flex items-center gap-3 rounded-full bg-black/45 px-4 py-2 backdrop-blur"
												>
													<span class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-accent)]"
													></span>
													<span class="font-display text-sm font-semibold text-white"
														>Generating {stagePercent}%</span
													>
												</div>
												<!-- The way out, where the waiting is.
											     A render is billed per second on somebody's GPU, and until
											     now a clip run had no stop at all — the studio's own endpoint
											     had to be called by hand, and the page went on counting over
											     a run that had already been torn down. Quiet, and two steps,
											     because it cannot be undone: a workspace id opens once. -->
												{#if stopArmed}
													<div class="flex items-center gap-1.5">
														<button
															type="button"
															disabled={stopping}
															onclick={stopRun}
															class="cursor-pointer rounded-full bg-white/90 px-3 py-1 text-xs font-semibold text-black disabled:opacity-60"
															>{stopping ? 'stopping…' : 'yes, stop it'}</button
														>
														<button
															type="button"
															onclick={() => (stopArmed = false)}
															class="cursor-pointer rounded-full px-3 py-1 text-xs text-white/70 hover:text-white"
															>keep going</button
														>
													</div>
												{:else}
													<button
														type="button"
														onclick={() => (stopArmed = true)}
														class="cursor-pointer rounded-full px-3 py-1 text-xs text-white/45 transition-colors hover:text-white/80"
														>stop</button
													>
												{/if}
											</div>
										</div>
									{:else if stagePhase === 'round' && stageRound?.confirm}
										{@const c = stageRound.confirm}
										<!-- The request, in the operator's own words, in the shape the transcript
									gives it. Absent on a round that answers a moved setting rather than a
									message — there is no new sentence to show, so it keeps the one the
									round is still about rather than leaving the reply talking to nobody. -->
										{@const asked = c.said.trim() || roundRequest(stageRound)}
										<!-- The round, drawn as what it is: an exchange.
									
									     The stage used to compose its own version of this — the same sentences,
									     centred inside a 16:9 box the size of the clip that did not exist yet,
									     with the button under them. It read as an alert rather than an answer,
									     and it arrived all at once, finished, because the loader covered the
									     whole of the writing. What the operator asked for is the transcript's
									     own drawing: their line, then the studio's, flowing from the top of a
									     reading column, a word at a time.
									
									     Only this round. The stage shows one thing and the chain is in the strip
									     beside it; a transcript of every round is the transcript, and it is one
									     switch away in full production. -->
										<div
											class="scroller mx-auto flex min-h-0 w-full max-w-[48rem] flex-1 flex-col gap-5 overflow-y-auto px-1 pt-1"
										>
											{#if asked}
												<div class="flex justify-end">
													<p
														class="enter doc max-w-[85%] rounded-2xl rounded-br-md bg-[var(--st-surface-2)] px-4 py-2.5 text-[0.95rem] leading-relaxed"
													>
														{asked}
													</p>
												</div>
											{/if}
											{@render confirmReply(stageRound, true)}
										</div>
									{:else if stagePhase === 'error'}
										<div
											class="flex aspect-video w-full max-w-3xl flex-col items-center justify-center gap-3 rounded-2xl bg-[var(--st-surface)] px-8 text-center"
										>
											<p class="text-sm leading-relaxed text-[var(--st-muted)]">
												{stageError?.text}
											</p>
											<button
												type="button"
												onclick={() => {
													if (stageError) chat = chat.filter((c) => c !== stageError);
												}}
												class="cursor-pointer rounded-full bg-[var(--st-surface-2)] px-4 py-1.5 text-xs font-semibold"
												>try it again</button
											>
										</div>
									{:else if stagePhase === 'character'}
										{@const drawing = stageDrawing}
										{@const sh = drawing ? null : (stageSheet?.sheet ?? null)}
										{@const shownId = sh?.id ?? drawing?.id ?? ''}
										{@const row = sheets.find((x) => x.id === shownId)}
										{@const six = row?.sheet?.state === 'ready' && row.sheet.file ? shownId : ''}
										{@const turn = row?.sheet?.clip}
										{@const isUpload = !!row?.uploaded}
										{@const isChar = row?.kind !== 'location'}
										{@const view = charView || (six ? 'six' : turn ? 'turn' : 'ref')}
										<!-- The character, and the three things the work produces, in one frame.
										 The reference is on screen from the moment you upload it. The turnaround
										 lands and plays — it is a video, so it is shown as one. Then the six
										 views are cut from it and take the surface, because that is what was
										 being made and what every later clip is measured against.
										
										 All three existed already and two were unreachable: the turnaround only
										 by landing on the clip stage where it did not belong, the six views
										 behind a hover-only mark inside a menu. So the honest answer to "why can
										 I not see them" was that there was nowhere to see them from. They switch
										 here, in the frame they belong to, rather than opening a tab away from
										 the work. -->
										<div
											class="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3"
										>
											<div class="flex min-h-0 w-full flex-1 items-center justify-center">
												{#if view === 'six' && six}
													<img
														src="/studio/api/sheet/full/{six}"
														alt=""
														onerror={sheetImageMissing}
														class="max-h-full max-w-full rounded-2xl object-contain"
													/>
												{:else if view === 'turn' && turn}
													<!-- svelte-ignore a11y_media_has_caption -->
													<video
														src={still(fileUrl(turn.workspace, turn.artifact, turn.file))}
														autoplay
														loop
														muted
														playsinline
														controls
														class="max-h-full max-w-full rounded-2xl bg-black object-contain"
													></video>
												{:else if sh?.url}
													<!-- The preview, before it has been kept.
													 Until it is kept the subject has no id, so the sheet endpoint below
													 has nothing to serve and the branch fell through to the spinner —
													 which spun over a picture that had already rendered, was already on
													 disk and was already being served at this very url. The card has
													 carried it since the poll finished; nothing looked. -->
													<img
														src={sh.url}
														alt=""
														class="max-h-full max-w-full rounded-2xl object-contain"
													/>
												{:else if shownId}
													<img
														src="/studio/api/sheet/img/{shownId}"
														alt=""
														onerror={sheetImageMissing}
														class="max-h-full max-w-full rounded-2xl object-contain"
													/>
												{:else}
													<!-- Nothing to show yet, so the wait is here rather than on a rectangle
													 the size of a clip. The picture lands in this frame, and the mark is
													 the size of what is coming rather than of something else entirely. -->
													<span
														class="spin size-6 rounded-full border-2 border-[var(--st-surface-2)] border-t-[var(--st-muted)]"
													></span>
												{/if}
											</div>
											<div class="shrink-0 text-center">
												<!-- Their name, and you can type it. It arrives as the first words of the
												 description, truncated — a label, not a name — and this is the one
												 surface where the thing being named is unmistakably a person. A field
												 shaped like the heading it replaces, so nothing moves when you click
												 into it. -->
												<!-- A field shaped like the heading it replaces gives no sign that it is
												 one, so the mark that means "you can change this" sits beside it —
												 faint, and solid on hover, the way the rest of this surface treats a
												 control you have not reached for yet. It only focuses the field: the
												 field is the control, and a second one that opened a dialog to do the
												 same thing would be a step nobody asked for. -->
												<div class="group mx-auto flex max-w-[24rem] items-center gap-1">
													<input
														value={row?.name ?? sh?.name ?? drawing?.name ?? ''}
														placeholder="Name them"
														disabled={!shownId}
														onblur={(e) => renameCharacter(shownId, e.currentTarget.value)}
														onkeydown={(e) => {
															if (e.key === 'Enter') e.currentTarget.blur();
															if (e.key === 'Escape') {
																e.currentTarget.value = row?.name ?? '';
																e.currentTarget.blur();
															}
														}}
														class="min-w-0 flex-1 rounded-lg border-0 bg-transparent px-2 py-0.5 text-center font-display text-base font-semibold text-[var(--st-text)] outline-none placeholder:text-[var(--st-faint)] hover:bg-[var(--st-surface)] focus:bg-[var(--st-surface)]"
													/>
													<button
														type="button"
														aria-label="rename them"
														disabled={!shownId}
														onclick={(e) => {
															const box = e.currentTarget
																.previousElementSibling as HTMLInputElement | null;
															box?.focus();
															box?.select();
														}}
														class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-[var(--st-faint)] opacity-70 transition-opacity group-hover:opacity-100 hover:text-[var(--st-text)] disabled:cursor-default disabled:opacity-30"
													>
														<svg
															viewBox="0 0 16 16"
															class="size-3.5"
															fill="none"
															aria-hidden="true"
														>
															<path
																d="M11.1 2.9a1.4 1.4 0 0 1 2 2L6.4 11.6l-2.7.7.7-2.7z"
																stroke="currentColor"
																stroke-width="1.4"
																stroke-linejoin="round"
															/>
														</svg>
													</button>
												</div>
												<!-- Only the stages that are actually coming, from the moment there is
												 a reference. The ones not made yet stand there disabled with a
												 turning mark, so the wait is attached to the thing being waited for
												 rather than announced in a sentence somewhere else. They arrive in
												 order, and the surface follows the newest until you press one.

												 All three were shown for everything, and for a place that is a
												 promise the code does not keep. A turnaround is a six-second render
												 of the subject rotating, and api/sheet starts one only for an
												 uploaded CHARACTER — "a room does not have a front and a back the
												 way a person does", in its own words. A drawn subject has no
												 turnaround either: its six views come from the sheet workflow
												 directly. And an uploaded location gets neither, because the sheet
												 workflows are text-to-image with no image input, so there is
												 nothing that can redraw a photograph.
												 A chip that spins forever is worse than one that was never
												 offered. -->
												<div class="mt-2 flex flex-wrap items-center justify-center gap-1.5">
													{#each [{ id: 'ref', label: 'Reference', ok: !!shownId || !!sh?.url, on: true }, { id: 'turn', label: 'Turnaround', ok: !!turn, on: isUpload && isChar }, { id: 'six', label: 'Six views', ok: !!six, on: !(isUpload && !isChar) }].filter((x) => x.on) as t (t.id)}
														<button
															type="button"
															disabled={!t.ok}
															aria-pressed={view === t.id}
															onclick={() => (charView = t.id as 'ref' | 'turn' | 'six')}
															class="btn btn-sm {view === t.id && t.ok
																? 'btn-primary'
																: 'btn-secondary'}"
														>
															{#if !t.ok}
																<span
																	class="spin size-3 shrink-0 rounded-full border-2 border-current/25 border-t-current"
																></span>
															{/if}
															<span>{t.label}</span>
														</button>
													{/each}
												</div>
												{#if sh && !sh.url && !sh.id}
													<!-- A preview the harness is still drawing. One picture, not six —
													 the six-view line below would promise a turnaround this render
													 does not make, and a wait labelled with the wrong work reads as
													 a wait that is not moving. -->
													<p
														class="mt-2 flex items-center justify-center gap-2 text-xs text-[var(--st-faint)]"
													>
														<span
															class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-green)]"
															aria-hidden="true"
														></span>
														<span>
															Rendering one picture of {sh.kind === 'location'
																? 'the place'
																: 'them'} · about two minutes
														</span>
													</p>
												{:else if !six}
													<p class="mt-2 text-xs text-[var(--st-faint)]">
														{turn ? 'Cutting the six views' : 'Building the six views'}{drawing
															? ` · ${turnStatus(drawing)}`
															: ''}
													</p>
												{:else}
													<p class="mt-2 text-xs text-[var(--st-faint)]">
														Kept. Describe a shot and they are in it.
													</p>
												{/if}
											</div>
										</div>
									{:else if stagePhase === 'empty'}
										<!-- A new production opens on what it opened on before: the greeting
								 and three things to try. The stage has nothing to show yet and a
								 blank rectangle where a clip will be is not an invitation. -->
										<h2
											class="enter mx-auto max-w-[26rem] text-center font-display text-[clamp(2.25rem,6vw,3.25rem)] leading-[1.06] font-semibold tracking-[-0.042em] text-balance"
										>
											{#each WELCOME_LINES as line, i (line)}
												{line}{#if i === 0}<br />{/if}
											{/each}
										</h2>
										{@render starters()}

										<!-- What has already been made, under the invitation to make more.
										 A front page that only invites is a brochure; the work is the
										 argument, and it is sitting on the disk either way.
										 Columns rather than a grid, because a grid rules everything
										 into rows and what this wants is the offset — each column
										 fills on its own, so a tall film in one pushes its neighbours
										 out of step and the wall stops looking like a table. -->
										{#if shelf.length}
											<div class="w-full max-w-3xl columns-2 gap-2 pt-8 pb-2 lg:columns-3">
												{#each shelf as m, i (m.id)}
													{@render mediaTile(m, i)}
												{/each}
											</div>
											<!-- Quiet: this is the studio's own housekeeping, not part of making a
												 film. Here rather than only in the sidebar because this is the wall
												 it edits. -->
											<button
												type="button"
												onclick={() => {
													mediaOpen = true;
													void loadPool();
												}}
												class="cursor-pointer pb-1 text-xs text-[var(--st-faint)] transition-colors hover:text-[var(--st-text)]"
												>choose what shows here</button
											>
										{/if}
									{:else if stagePhase === 'ready' && stageClip}
										{@const f = stageShownUrl ? { url: stageShownUrl } : null}
										{@const sws = stageShownWs}
										{@const shownPart =
											stageShown?.artifact && stageShown?.file
												? {
														workspace: stageShown.workspace,
														artifact: stageShown.artifact,
														file: stageShown.file
													}
												: null}
										{@const sv = verdict[sws]}
										<!-- The clip takes the room it is given: this is what the operator
								 came to look at, and a 48rem cap in the middle of a wide screen
								 left a third of it black. Height-bound rather than width-bound, so
								 a portrait clip and a 16:9 one both fill what there is.
								
								 The actions ride on top of the picture rather than under it. Below
								 the frame they pushed the clip up and competed with the composer
								 for the same band of the screen. -->
										<div class="flex min-h-0 w-full flex-1 items-center justify-center">
											<!-- Sized to the clip, not to the column: the row of actions anchors
									 to this box, and anchored to the column it hung off the picture's
									 edges into the black beside it. -->
											<!-- Mobile fits the whole clip rather than filling the box.
											 On a phone the picture is the surface, and a landscape clip in a
											 portrait window has to be seen whole rather than cropped or
											 overflowing the screen — which is what h-full did, pushing a
											 16:9 clip past the right edge. With both dimensions capped and
											 neither set, the element keeps its own ratio and scales down to
											 whichever runs out first: a portrait clip fills the height, a
											 landscape one sits centred and smaller. Desktop keeps h-full,
											 where the window is wider than any clip and the picture should
											 take all the height there is. -->
											<div
												class="relative max-h-full w-fit max-w-full lg:h-full"
												style={stageVidH > stageVidW ? 'height:100%' : undefined}
											>
												{#if f}
													<!-- svelte-ignore a11y_media_has_caption -->
													<video
														src={still(f.url)}
														controls
														autoplay={stageClip.id === stageAutoplayId}
														loop
														playsinline
														bind:clientWidth={stageVideoW}
														bind:videoWidth={stageVidW}
														bind:videoHeight={stageVidH}
														class="video-with-controls max-h-full w-auto max-w-full rounded-2xl bg-black lg:h-full"
													></video>
												{/if}
												<div
													class="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3"
												>
													<span class="pointer-events-auto flex items-center gap-2">
														{#if shownPart}
															{#if film.some((x) => filmKey(x) === filmKey(shownPart))}
																<span
																	class="flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1 text-xs text-white backdrop-blur"
																>
																	<span aria-hidden="true">✓</span><span>In the film</span>
																</span>
															{:else}
																<button
																	type="button"
																	onclick={() =>
																		addClipToFilm(shownPart, stageClip?.artifact?.title ?? '')}
																	class="cursor-pointer rounded-full bg-black/40 px-2.5 py-1 text-[0.6875rem] font-semibold text-white/85 backdrop-blur transition-colors hover:bg-black/75 hover:text-white lg:bg-black/55 lg:px-3 lg:text-xs lg:text-white"
																	>Add to film</button
																>
															{/if}
														{/if}
													</span>
													<span class="pointer-events-auto flex items-center gap-1">
														{#if !sv}
															<button
																type="button"
																onclick={() => rate(sws, 'kept')}
																class="cursor-pointer rounded-full bg-black/40 px-2.5 py-1 text-[0.6875rem] text-white/85 backdrop-blur transition-colors hover:bg-black/75 hover:text-white lg:bg-black/55 lg:px-3 lg:text-xs lg:text-white"
																>Good</button
															>
															<button
																type="button"
																onclick={() => rate(sws, 'rejected')}
																class="cursor-pointer rounded-full bg-black/40 px-2.5 py-1 text-[0.6875rem] text-white/85 backdrop-blur transition-colors hover:bg-black/75 hover:text-white lg:bg-black/55 lg:px-3 lg:text-xs lg:text-white"
																>Not good</button
															>
														{:else}
															<span
																class="rounded-full bg-black/55 px-3 py-1 text-xs text-white backdrop-blur"
																>{sv === 'kept' ? 'Noted as good' : 'Noted'}</span
															>
														{/if}
													</span>
												</div>
											</div>
										</div>
									{/if}
								</div>
							</div>
						</div>
					{:else}
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
										class="enter mx-auto max-w-[26rem] text-center font-display text-[clamp(2.25rem,6vw,3.25rem)] leading-[1.06] font-semibold tracking-[-0.042em] text-balance"
									>
										{#each WELCOME_LINES as line, i (line)}
											{line}{#if i === 0}<br />{/if}
										{/each}
									</h2>
								{:else if item.kind === 'text'}
									<div class="enter">
										<p class="doc text-[0.95rem] leading-[1.75] text-[var(--st-text)]">
											{item.text}
										</p>
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
																<svg
																	viewBox="0 0 16 16"
																	class="size-4 text-[#5b8f6e]"
																	fill="none"
																	aria-hidden="true"
																>
																	<path
																		d="M3.5 8.5l3 3 6-7"
																		stroke="currentColor"
																		stroke-width="2"
																		stroke-linecap="round"
																		stroke-linejoin="round"
																	/>
																</svg>
															{:else if row.state === 'writing' || row.state === 'rewriting'}
																<span
																	class="spin size-3.5 rounded-full border-2 border-[var(--st-surface-2)] border-t-[var(--st-accent)]"
																></span>
															{:else if row.state === 'failed'}
																<svg
																	viewBox="0 0 16 16"
																	class="size-4 text-[#c4614b]"
																	fill="none"
																	aria-hidden="true"
																>
																	<path
																		d="M4 4l8 8M12 4l-8 8"
																		stroke="currentColor"
																		stroke-width="2"
																		stroke-linecap="round"
																	/>
																</svg>
															{:else}
																<span class="size-1.5 rounded-full bg-[var(--st-faint)]"></span>
															{/if}
														</span>

														<span
															class="flex-1 font-display text-sm font-semibold {row.state ===
															'waiting'
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
																<a
																	href={row.url}
																	class="text-xs text-[var(--st-muted)] underline"
																	download
																>
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
																		<label class="sr-only" for="change-{row.key}"
																			>What should change</label
																		>
																		<input
																			id="change-{row.key}"
																			bind:value={changeText[row.key]}
																			placeholder="what should change in this document"
																			class="min-w-0 flex-1 rounded-xl border border-[var(--st-line)] bg-[var(--st-bg)] px-3.5 py-2.5 text-sm outline-none placeholder:text-[var(--st-faint)] focus:border-[var(--st-muted)]"
																		/>
																		<button
																			type="submit"
																			disabled={changeBusy[row.key] ||
																				!(changeText[row.key] ?? '').trim()}
																			class="btn btn-primary"
																		>
																			send
																		</button>
																	</form>
																	<p class="mt-2 text-xs text-[var(--st-faint)]">
																		This step is rewritten, and everything built on it is refreshed
																		after it.
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
											takes several minutes and there is no output until it is finished{#if !staleRun}
												— the timer is the only thing that moves{/if}.
										</p>

										{#if shootBoard.length}
											<div class="divide-y divide-[var(--st-surface-2)]">
												{#each shootBoard as row (row.n)}
													<div class="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
														<span class="flex size-4 shrink-0 items-center justify-center">
															{#if row.state === 'done'}
																<svg
																	viewBox="0 0 16 16"
																	class="size-4 text-[#5b8f6e]"
																	fill="none"
																	aria-hidden="true"
																>
																	<path
																		d="M3.5 8.5l3 3 6-7"
																		stroke="currentColor"
																		stroke-width="2"
																		stroke-linecap="round"
																		stroke-linejoin="round"
																	/>
																</svg>
															{:else if row.state === 'failed'}
																<svg
																	viewBox="0 0 16 16"
																	class="size-4 text-[#c4614b]"
																	fill="none"
																	aria-hidden="true"
																>
																	<path
																		d="M4 4l8 8M12 4l-8 8"
																		stroke="currentColor"
																		stroke-width="2"
																		stroke-linecap="round"
																	/>
																</svg>
															{:else}
																<span
																	class="spin size-3.5 rounded-full border-2 border-[var(--st-surface-2)] border-t-[var(--st-accent)]"
																></span>
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
									<!-- The button only appears on the newest one. An older round is a step in
									     the conversation, not an order you can still place, and two live buttons
									     is two ways to shoot the wrong version. -->
									{@const newest = chat.filter((c) => c.kind === 'confirm').at(-1)?.id === item.id}
									<!-- Gone once its clip is on a GPU. It came back reading "start the render"
									     over a render that was already running, and pressing it again wrote a
									     second brief and paid for the same eight seconds twice. A started clip
									     lives on the card below. -->
									{@const started = item.confirm.cardId
										? !!chat.find((x) => x.id === item.confirm?.cardId)?.shot?.launched
										: false}
									{@render confirmReply(item, newest && !started)}
								{:else if item.kind === 'error'}
									<!-- The card that launched the render this error is about, found by
								 looking back rather than read off the item.
							     Stored at push time it would only ever appear on errors raised
							     after this shipped, and the one on screen when it was asked for was
							     already saved. A rule about what is displayed has to hold for what
							     is on disk — the same lesson the caption taught an hour earlier. -->
									{@const stalled = /^A shooting step stalled/.test(item.text ?? '')}
									{@const src = stalled
										? [...chat.slice(0, itemAt)]
												.reverse()
												.find((c) => c.kind === 'shot' && c.shot?.launched)
										: undefined}
									<div class="enter rounded-2xl bg-[var(--st-surface)] p-4">
										<p class="text-xs font-semibold text-[#f2d7cd]">
											<span class="mr-2 rounded-md bg-[#5c2f24] px-2 py-0.5">error</span>
										</p>
										<p class="doc mt-2 text-sm leading-relaxed text-[var(--st-muted)]">
											{item.text}
										</p>
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
												class="block w-full resize-y rounded-xl bg-[var(--st-bg)] p-3 font-mono text-[0.8rem] leading-relaxed outline-none read-only:text-[var(--st-muted)] focus:ring-0"
											></textarea>
											{#if item.sheet.why}
												<p class="mt-2 text-xs text-[var(--st-faint)]">{item.sheet.why}</p>
											{/if}
											<div
												class="mt-4 flex items-center justify-between gap-3 border-t border-[var(--st-line)] pt-4"
											>
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
														<span class="text-[var(--st-text)]"
															>{kept?.name ?? item.sheet.name}</span
														>
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
														Saved as <span class="font-semibold text-[var(--st-text)]"
															>{item.sheet.name}</span
														>. Pick {item.sheet.kind === 'character' ? 'them' : 'it'} from
														<span class="text-[var(--st-text)]">+</span> in the box below{kept
															?.sheet?.state === 'rendering'
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
														<label
															class="block text-xs text-[var(--st-faint)]"
															for="char-voice-{item.id}"
														>
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
													<label
														class="block text-xs text-[var(--st-faint)]"
														for="char-name-{item.id}"
													>
														{item.sheet.kind === 'character' ? 'Name them' : 'Name it'} — this is what
														the picker will show
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
														Not right? Say what to change in the chat — {item.sheet.kind ===
														'character'
															? 'the same person is'
															: 'the same place is'} kept and only what you name moves.
													</p>
												{/if}
											</div>
										{:else if item.sheet.url}
											<div class="mt-4 border-t border-[var(--st-line)] pt-4">
												{#if item.sheet.id}
													<p class="text-sm text-[var(--st-muted)]">
														Kept as <span class="font-semibold text-[var(--st-text)]"
															>{item.sheet.name}</span
														>. Every clip can use it from here on.
													</p>
												{:else}
													<label
														class="block text-xs text-[var(--st-faint)]"
														for="sheet-name-{item.id}"
													>
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
									{@const n = item.shot.prompt.trim()
										? item.shot.prompt.trim().split(/\s+/).length
										: 0}
									{@const picked = item.shot.loras ?? []}
									<article class="enter rounded-2xl bg-[var(--st-surface)] p-5 sm:p-6">
										<div class="mb-3 flex items-baseline justify-between gap-4">
											<h3 class="font-display text-base font-semibold">
												The prompt
												{#if item.shot.characterName || item.shot.locationName}
													<span
														class="ml-2 align-middle text-xs font-normal text-[var(--st-faint)]"
													>
														{item.shot.characterName ? `with ${item.shot.characterName}` : ''}{item
															.shot.characterName && item.shot.locationName
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
															<span class="flex-1 text-xs text-[var(--st-faint)] tabular-nums"
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
																class="w-24 shrink-0 text-right text-xs text-[var(--st-faint)] tabular-nums"
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
																class="w-24 shrink-0 text-right text-xs text-[var(--st-faint)] tabular-nums"
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
													{#each [5, 10, 15] as sec (sec)}
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
															.width}x{frameFor(
															item.shot.resolution ?? '576p',
															item.shot.orientation
														).height} · follows the clip before it</span
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
												<button type="button" onclick={saveEdit} class="btn btn-primary">
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
												<p
													class="mt-1.5 font-mono text-[11px] tracking-wide text-[var(--st-faint)]"
												>
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
											<div
												class="relative mt-3"
												class:clamp={isLong(art.body) && !expanded[item.id]}
											>
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
															<label class="sr-only" for="change-{item.id}"
																>What should change</label
															>
															<input
																id="change-{item.id}"
																bind:value={changeText[item.id]}
																placeholder="what should change in this document"
																class="min-w-0 flex-1 rounded-xl border border-[var(--st-line)] bg-[var(--st-bg)] px-3.5 py-2.5 text-sm outline-none placeholder:text-[var(--st-faint)] focus:border-[var(--st-muted)]"
															/>
															<button
																type="submit"
																disabled={changeBusy[item.id] ||
																	!(changeText[item.id] ?? '').trim()}
																class="btn btn-primary"
															>
																send
															</button>
														</form>
														<p class="mt-2 text-xs text-[var(--st-faint)]">
															This step is rewritten, and everything built on it is refreshed after
															it.
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
										scenic &&
										item.kind !== 'takes' &&
										item.text &&
										item.text !== item.artifact.title
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
															class="btn btn-primary btn-sm">Continue</button
														>
														{#if filmPart(item.artifact)}
															{#if inFilm(item.artifact)}
																<span
																	class="flex items-center gap-1.5 px-1 text-xs text-[var(--st-muted)]"
																>
																	<span aria-hidden="true">✓</span><span>In the film</span>
																</span>
															{:else}
																<button
																	type="button"
																	onclick={() => addToFilm(item)}
																	class="btn btn-secondary btn-sm">Add to film</button
																>
															{/if}
														{/if}
														{#if chain.length > 1}
															<button
																type="button"
																disabled={joining[ws]}
																onclick={() => joinScene(ws)}
																class="btn btn-secondary btn-sm"
																>{joining[ws]
																	? 'Joining…'
																	: `The whole scene · ${chain.length}`}</button
															>
														{/if}
														{#if others.length}
															<button
																type="button"
																onclick={(e) => openTake(item.id, others[0].index, e.currentTarget)}
																class="btn btn-quiet btn-sm"
																>{others.length === 1
																	? 'Other take'
																	: `${others.length} other takes`}</button
															>
														{/if}

														<!-- Pushed to the far end. Asked, not inferred, and not on the
											     path to the next clip. -->
														<span class="ml-auto flex items-center gap-0.5">
															{#if !v}
																<button
																	type="button"
																	onclick={() => rate(ws, 'kept')}
																	class="btn btn-quiet btn-sm">Good</button
																>
																<button
																	type="button"
																	onclick={() => rate(ws, 'rejected')}
																	class="btn btn-quiet btn-sm">Not good</button
																>
															{:else if v === 'kept'}
																<span class="px-2 text-xs text-[var(--st-faint)]"
																	>Noted as good</span
																>
															{:else if diagnosing[ws]}
																<span
																	class="flex items-center gap-2 px-2 text-xs text-[var(--st-faint)]"
																>
																	<span
																		class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-accent)]"
																	></span>
																	<span>Working out the fix</span>
																</span>
															{:else if !fix[ws]}
																<button
																	type="button"
																	onclick={() => diagnose(ws)}
																	class="btn btn-secondary btn-sm">Work out why</button
																>
															{/if}
														</span>
													</div>

													{#if !ci.ok}
														<p class="text-xs leading-relaxed text-[var(--st-faint)]">{ci.why}</p>
													{:else if !ci.exact}
														<p class="text-xs text-[var(--st-faint)]">
															Continues from a frame of this clip.
														</p>
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
								{@render starters()}
							{/if}

							<div bind:this={bottomEl}></div>
						</div>
					{/if}

					<!-- ── the composer — pinned, outside the scrolling region ── -->
					<div class="composerbox relative shrink-0 pt-3 pb-4">
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
						<!-- Not on the stage, which says this itself and says it right. Two
						 clocks for one render is one too many, and this one cannot tell that
						 the clip already arrived — it counts while the poll is alive, so a
						 session left open reads "116m · longer than usual" over a finished
						 take. -->
						{#if pollingActive && startedAt && !STAGE_UI}
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
						<!-- Everything under the stage shares the composer's measure: the reference
							     chips, the hint line and the film reel line up with the box they belong
							     to instead of running the width of the column over it. -->
						<div>
							<div class={STAGE_UI ? 'mx-auto w-full' : ''} style={composerCap}>
								{#if refFiles.length}
									<div class="mb-2 space-y-1.5">
										{#each refFiles as f (f.id)}
											<div
												class="flex items-center gap-2 rounded-xl bg-[var(--st-surface)] px-3 py-2"
											>
												<span
													class="max-w-[9rem] shrink-0 truncate font-mono text-[11px] text-[var(--st-muted)]"
												>
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
								<!-- Standing on the stage for the same reason the reel's band is: this row
								     appears the moment there is a film to count, and appearing is height, and
								     height is the picture's width. Off the stage it keeps its old behaviour,
								     where an empty row is only an empty row. -->

								<!-- The reel's room is standing, whether or not there is a reel in it.
								     The picture on the stage is height-bound — it is 16:9 filling whatever
								     height is left — and the composer is capped to the picture's width. So a
								     row appearing above the composer took height off the stage, which took
								     width off the picture, which took width off the composer: adding one clip
								     to the film visibly shrank both surfaces and rewrapped the text between
								     them. Nothing about adding a clip should resize the thing you are looking
								     at.
								
								     So the band is always there and the reel opens into it. It costs the
								     picture a fixed slice of height for the whole session rather than a
								     variable one at the moment you act, which is the trade this surface keeps
								     making: the rail's space is held open for the same reason. Only on the
								     stage — with the transcript there is no height-bound picture to protect
								     and an empty band is just a gap. -->
								{#if STAGE_UI && mode === 'simple'}
									<!-- The reel sits at the BOTTOM of its standing room, not the top.
									 Held open the band is taller than the row inside it, and a row pinned
									 to the top left the slack between itself and the count chip under it —
									 a gap that reads as a mistake rather than as breathing room, because
									 everything else in this stack is spaced by one step. Bottom-aligned,
									 the slack goes above it, where the picture is, and the reel keeps its
									 own step to the chip. -->
									<!-- The standing room is a desktop trade. Holding 4.4rem open so the
										 picture does not jump when the reel arrives costs nothing on a wide
										 window and seventy pixels of a phone — where it reads as an empty
										 black band above the composer, and where those pixels are the ones
										 the clip itself is short of. Below lg the band takes only the height
										 of what is actually in it. -->
									<div
										class="flex shrink-0 flex-col justify-end lg:min-h-[4.4rem]"
										aria-hidden={!(film.length && filmOpen)}
									>
										<!-- Only when the stage is not already saying it. The character surface
											 carries the same countdown under the name whenever it is what the
											 stage is showing, and the same sentence twice on one screen reads as
											 two things happening. Here is where it belongs when a clip has the
											 stage and the drawing is the quieter of the two. -->
										{#if stagePhase !== 'character'}
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
										{/if}
										{#if film.length && filmOpen}
											{@render filmReel()}
										{/if}
									</div>
								{:else if film.length && filmOpen}
									{@render filmReel()}
								{/if}
								<!-- `relative` is load-bearing: the add and format menus open upward
						 from inside the composer and anchor to this box, not to the page. -->
								<!-- The stage above is a picture and takes the whole column; this is
						 a line of text and keeps the measure it had. The note above is still
						 true — a composer a thousand pixels wide makes the eye travel the
						 screen to find the send button — so the width went to the clip and
						 not to the box under it. -->
								<!-- The same gutter the stage keeps for the strip. Both boxes centre
						 in the same reduced width, which is the only way their edges line
						 up — pad one and not the other and they sit half a strip apart. -->
							</div>
						</div>
						<!-- The same measure the composer keeps, so their edges line up. Outside it
							 these two ran the width of the column over a box half as wide. -->
						<div class={STAGE_UI ? 'mx-auto w-full' : ''} style={composerCap}>
							{#if composerHint || film.length || (STAGE_UI && mode === 'simple')}
								<div class="mb-1.5 flex min-h-[1.6rem] items-center gap-3">
									<p class="min-w-0 text-xs text-[var(--st-faint)]">{composerHint}</p>
									<span class="flex-1"></span>
									{#if film.length}
										<button
											type="button"
											aria-expanded={filmOpen}
											ondragover={(e) => {
												if (e.dataTransfer?.types.includes(CLIP_DRAG)) e.preventDefault();
											}}
											ondrop={(e) => dropClipIntoFilm(e)}
											onclick={() => (filmOpen = !filmOpen)}
											class="pillglass flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-[var(--st-text)] tabular-nums transition-colors hover:bg-[var(--st-surface-2)] {filmOpen
												? 'bg-[var(--st-surface-2)]'
												: ''}"
										>
											<span class="reelmark" aria-hidden="true"></span>
											<span
												>{film.length}
												{film.length === 1 ? 'clip' : 'clips'} · {filmSeconds}s</span
											>
											<span
												class="text-[0.6rem] text-[var(--st-faint)] {filmOpen ? 'rotate-180' : ''}"
												>⌄</span
											>
										</button>
									{/if}
								</div>
							{/if}
						</div>
						<div>
							<!-- The settings, in the open, above the sentence.
								 The sheet behind the slider holds the same answers and holds them
								 better when there are many — but it costs a tap to see what is set,
								 and on a phone the three that change most often are worth having in
								 sight. A row rather than a wrap: everything stays on one line and the
								 line scrolls, so a fourth group appearing never pushes the field down.
								 Phones only; the desktop chips already say this on one line. -->
							<!-- The row scrolls, so nothing inside it can escape it: overflow-x makes
								 the vertical overflow non-visible too, and a panel opening upward from a
								 bubble would be sliced off at the top. The wrapper is where it opens
								 from instead — outside the scroller, above the row, over the picture. -->
							<div class="pillwrap relative mb-1.5 lg:hidden">
								{#each pillGroups().filter((x) => x.up && pillGrp === x.id) as grp (grp.id)}
									<div
										style="left:{pillAt.x}px; transform-origin:{pillAt.o}px bottom"
										class="pillrise absolute bottom-full z-40 mb-1.5 flex min-w-36 flex-col gap-0.5 rounded-2xl bg-[var(--st-surface)] p-1 shadow-[0_16px_44px_rgba(0,0,0,.6)] ring-1 ring-[var(--st-line)]"
									>
										{#each grp.opts as o, i (o.v)}
											<button
												type="button"
												disabled={o.off}
												aria-pressed={grp.now === o.v}
												onclick={() => {
													grp.pick(o.v);
													pillGrp = '';
												}}
												style="animation-delay:{i * 45}ms"
												title={o.off ? `over ${MAX_AT_ONCE} clips at once` : ''}
												class="pillopen flex min-h-9 items-center gap-2 rounded-xl px-3 text-xs transition-colors {o.off
													? 'cursor-default text-[var(--st-faint)] opacity-35'
													: 'cursor-pointer'} {!o.off && grp.now === o.v
													? 'bg-[var(--st-surface-2)] font-semibold text-[var(--st-text)]'
													: !o.off
														? 'text-[var(--st-faint)] hover:text-[var(--st-text)]'
														: ''}"
											>
												{#if o.box}<span class="block rounded-[2px] border border-current {o.box}"
													></span>{/if}
												{o.l}
											</button>
										{/each}
									</div>
								{/each}
								<!-- Wide between groups, tight inside them. At the same 1.5 the two gaps
									 said the same thing, so 5s 10s 15s 288p 576p 864p read as one run of
									 six options rather than as two questions with three answers each. The
									 grouping is the meaning here; the space has to carry it. -->
								<div class="railstrip flex items-center gap-3 overflow-x-auto pb-0.5">
									<!-- One group open, the rest folded to what they are set to.
										 Six settings side by side is a wall of options nobody asked to read,
										 and it pushed the ones that matter off the end of the line. Folded,
										 each bubble is a fact — 5s, 576p, 9:16 — and opening one is how you
										 change it. Only one opens at a time, so the row never grows past a
										 scroll and the answer you are choosing is the only set on screen. -->
									<!-- The bubble stays whether or not anyone is cast, and this is the
										 second time that rule has had to be learned here: gated on
										 chosenCharacter it disappeared exactly when it was needed, because
										 with nobody chosen there was nothing to tap to choose somebody. The
										 empty state is an answer — "anyone" — and it is the default one.
										 The desktop chip already says this; see the note beside it. -->
									<button
										type="button"
										onclick={() => {
											shutMenus();
											pickKind = 'character';
										}}
										class="pillglass flex min-h-8 max-w-[6.75rem] shrink-0 cursor-pointer items-center gap-1.5 rounded-full py-1 pr-3 pl-1 text-xs whitespace-nowrap {chosenCharacter
											? 'text-[var(--st-text)]'
											: 'text-[var(--st-faint)]'}"
									>
										{#if chosenCharacter}
											<img
												src="/studio/api/sheet/img/{chosenCharacter.id}"
												alt=""
												onerror={sheetImageMissing}
												class="size-6 shrink-0 rounded-full object-cover"
											/>
											<span class="min-w-0 truncate">{chosenCharacter.name}</span>
										{:else}
											<!-- The same filled disc the cast chip wears when it is empty: a
												 placeholder is the shape it stands in for, and a hairline ring
												 at this size reads as a picture that failed to load. -->
											<span
												class="flex size-6 shrink-0 items-center justify-center rounded-full bg-current/10"
											>
												<svg
													viewBox="0 0 16 16"
													class="size-[11px] opacity-55"
													fill="currentColor"
													aria-hidden="true"
												>
													<circle cx="8" cy="5.9" r="2.6" />
													<path d="M3.5 13.4c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4z" />
												</svg>
											</span>
											<span>anyone</span>
										{/if}
										<svg
											viewBox="0 0 10 10"
											class="size-2.5 shrink-0 opacity-70"
											fill="none"
											aria-hidden="true"
										>
											<path
												d="M2 4l3 3 3-3"
												stroke="currentColor"
												stroke-width="1.4"
												stroke-linecap="round"
												stroke-linejoin="round"
											/>
										</svg>
									</button>
									<!-- Second, right after who is in it. What follows this clip is the
										 question a continuation asks first — before how many and
										 before how long — and it was last in the row, past two
										 settings that do not change between takes. -->
									{#each pillGroups() as grp (grp.id)}
										<!-- Length and size stay open; the frame and the continuation fold.
											 Two short numbers each read faster as a set than as a fact you have
											 to tap to question — you can see at a glance that 5s is one of
											 three, not a value out of nowhere. The other two carry a glyph and
											 whole sentences, and unfolding those in line pushes the row off the
											 screen, so they open upward instead. -->
										{@const open = pillGrp === grp.id}
										{@const cur = grp.opts.find((o) => o.v === grp.now) ?? grp.opts[0]}
										<span
											class="pillglass flex shrink-0 items-center gap-0.5 rounded-full p-0.5 whitespace-nowrap"
										>
											{#if !grp.up}
												{#each grp.opts as o, i (o.v)}
													<button
														type="button"
														disabled={composerShape.fixed}
														aria-pressed={grp.now === o.v}
														onclick={() => grp.pick(o.v)}
														style="animation-delay:{i * 40}ms"
														class="pillopen flex min-h-7 items-center gap-1.5 rounded-full px-3 font-mono text-xs tabular-nums transition-colors {composerShape.fixed
															? 'cursor-default opacity-40'
															: 'cursor-pointer'} {grp.now === o.v
															? 'bg-[var(--st-text)] font-semibold text-[var(--st-bg)]'
															: 'text-[var(--st-faint)]'}"
													>
														{o.l}
													</button>
												{/each}
											{:else}
												<button
													type="button"
													aria-expanded={open}
													onclick={(e) => (open ? (pillGrp = '') : openPillAt(e, grp.id))}
													class="flex min-h-7 cursor-pointer items-center gap-1.5 rounded-full px-3 font-mono text-xs tabular-nums transition-colors {open
														? 'bg-[var(--st-text)] font-semibold text-[var(--st-bg)]'
														: 'text-[var(--st-muted)]'}"
												>
													{#if cur.box}<span
															class="block rounded-[2px] border border-current {cur.box}"
														></span>{/if}
													{cur.l}
													<!-- Every control that opens says so the same way. The mode chip
														 carried this chevron and the folded groups did not, so two things
														 with identical behaviour looked like a control and a readout. -->
													<svg
														viewBox="0 0 10 10"
														class="size-2.5 shrink-0 opacity-70 transition-transform {open
															? 'rotate-180'
															: ''}"
														fill="none"
														aria-hidden="true"
													>
														<path
															d="M2 4l3 3 3-3"
															stroke="currentColor"
															stroke-width="1.4"
															stroke-linecap="round"
															stroke-linejoin="round"
														/>
													</svg>
												</button>
											{/if}
										</span>
									{/each}
									<!-- What the send makes, as one bubble opening the panel desktop
										 already uses: one clip, versions, camera angles, full production.
										 It was two groups of my own for a moment — takes and angles side by
										 side — which said the same thing in a worse language and left the
										 product of the two, the number that actually costs money, nowhere on
										 screen. One control, one panel, one place the rule lives. -->
									<button
										type="button"
										aria-expanded={modeOpen}
										onclick={(e) => openPanelAt(e, 'mode')}
										class="pillglass flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs whitespace-nowrap transition-colors {modeOpen
											? 'text-[var(--st-text)]'
											: 'text-[var(--st-muted)]'}"
									>
										{mode !== 'simple' ? 'full production' : batchLabel}
										<svg
											viewBox="0 0 10 10"
											class="size-2.5 shrink-0 opacity-70"
											fill="none"
											aria-hidden="true"
										>
											<path
												d="M2 4l3 3 3-3"
												stroke="currentColor"
												stroke-width="1.4"
												stroke-linecap="round"
												stroke-linejoin="round"
											/>
										</svg>
									</button>
									<!-- Length, size and frame in one bubble, the way the desktop chip
										 already says them. Three groups side by side was six pills and 604
										 pixels of a 335-pixel row: everything on screen, nothing readable.
										 One fact — 5s · 576p · 9:16 — and the panel behind it is the panel
										 desktop opens, so the rule lives in one place. -->
									<button
										type="button"
										aria-expanded={fmtOpen}
										onclick={(e) => openPanelAt(e, 'fmt')}
										class="pillglass flex min-h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-3 font-mono text-xs whitespace-nowrap transition-colors {fmtOpen
											? 'text-[var(--st-text)]'
											: 'text-[var(--st-muted)]'}"
									>
										{composerShape.seconds}s · {composerShape.res} · {composerShape.portrait
											? '9:16'
											: '16:9'}
										<svg
											viewBox="0 0 10 10"
											class="size-2.5 shrink-0 opacity-70 transition-transform {fmtOpen
												? 'rotate-180'
												: ''}"
											fill="none"
											aria-hidden="true"
										>
											<path
												d="M2 4l3 3 3-3"
												stroke="currentColor"
												stroke-width="1.4"
												stroke-linecap="round"
												stroke-linejoin="round"
											/>
										</svg>
									</button>
								</div>
							</div>
							<div
								class="composerglass relative rounded-3xl p-3 {STAGE_UI ? 'mx-auto w-full' : ''}"
								style={composerCap}
							>
								<!-- Making a character or a location is a state you are IN, not a tab
							 sitting beside the clip settings. It was a tab, and that put two
							 different questions on one row — what this message makes, and who is
							 in the clip — in identical chips. You enter this from the picker
							 below, and this band is how you know you are here and how you leave. -->
								{#if mode === 'simple' && (continuing || (STAGE_UI && stageContinuable))}
									{@const clipUrl = stageContinuable?.artifact?.files?.[0]?.url ?? ''}
									<!-- On a phone, on the stage, this band holds nothing. Go through it: the
										 continuation chips are `lg:flex`, every paragraph is `!STAGE_UI`, and
										 STAGE_UI is true. What is left is one error. So it drew as its own
										 padding — a black rounded bar above the field, sitting where a control
										 should be and doing nothing. Shown only when something inside it will
										 actually draw. -->
									{@const bandOnPhone = !STAGE_UI || !!charFromClipError}
									<div
										class="mb-2 {bandOnPhone
											? 'flex'
											: 'hidden lg:flex'} items-center justify-between gap-3 rounded-2xl bg-[var(--st-bg)] px-3.5 py-2.5"
									>
										<div class="min-w-0">
											{#if !STAGE_UI && continuing}
												<p class="font-display text-sm font-semibold">Continuing that clip</p>
												<p class="mt-0.5 text-xs leading-relaxed text-[var(--st-faint)]">
													Say what happens next — with {continuing.characterName ??
														'the same person'} in
													{continuing.locationName ?? 'the same place'}. The new piece renders on
													its own and joins onto the end.
												</p>
											{/if}
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
											<!-- One question, three answers, and the two that carry something show it.
										     It was a toggle, two modifiers of the toggle and an escape hatch — four
										     controls for one decision, with the off state written twice (turning
										     Continue off and pressing "new clip" run the same three lines). And the
										     distinction that actually matters was carried by words alone: whether the
										     next clip starts on this exact frame, or merely with these people in this
										     room. Both of those are pictures. Naming them was doing the work an
										     image does better and faster.

										     So: the frame chip wears the frame it would start on, the person chip
										     wears the person it would keep, and the third wears nothing — which is
										     not an omission, it is the answer. An empty rectangle would read as a
										     picture that failed to load. -->
											<div class="mt-2 hidden flex-wrap items-center gap-1.5 lg:flex">
												<button
													type="button"
													aria-pressed={!!continuing && pinSeam}
													onclick={() => {
														contOffFor = '';
														if (!continuing && stageContinuable) startContinue(stageContinuable);
														pinSeam = true;
													}}
													class="flex min-h-9 cursor-pointer items-center gap-2 rounded-full py-1 pr-3.5 pl-1 text-xs transition-colors {continuing &&
													pinSeam
														? 'bg-[var(--st-text)] font-semibold text-[var(--st-bg)]'
														: 'text-[var(--st-faint)] hover:text-[var(--st-text)]'}"
												>
													{#if clipUrl}
														<!-- svelte-ignore a11y_media_has_caption -->
														<video
															src={clipUrl}
															muted
															playsinline
															preload="metadata"
															use:lastFrame
															class="h-7 w-[3.1rem] shrink-0 rounded-full bg-black object-cover"
														></video>
													{/if}
													<span class="lg:hidden">Last frame</span><span class="hidden lg:inline"
														>From the last frame</span
													>
												</button>
												<button
													type="button"
													aria-pressed={!!continuing && !pinSeam}
													onclick={() => {
														contOffFor = '';
														if (!continuing && stageContinuable) startContinue(stageContinuable);
														pinSeam = false;
													}}
													class="flex min-h-9 cursor-pointer items-center gap-2 rounded-full py-1 pr-3.5 pl-1 text-xs transition-colors {continuing &&
													!pinSeam
														? 'bg-[var(--st-text)] font-semibold text-[var(--st-bg)]'
														: 'text-[var(--st-faint)] hover:text-[var(--st-text)]'}"
												>
													{#if chosenCharacter}
														<img
															src="/studio/api/sheet/img/{chosenCharacter.id}"
															alt=""
															onerror={sheetImageMissing}
															class="size-7 shrink-0 rounded-full object-cover"
														/>
													{:else}
														<!-- Nobody kept yet, so the disc is empty — the same placeholder the
															 cast chip wears, which is also what "Keep this person" fills.
															 Both parts are drawn from the chip's own foreground rather than a
															 fixed token: on the selected chip that foreground is dark, and a dark
															 figure on a dark disc on a white pill was a black blob with something
															 buried in it. Ten per cent for the disc and fifty-five for the figure
															 holds on either ground, which is how a placeholder avatar is drawn on
															 a light surface anyway. -->
														<span
															class="flex size-7 shrink-0 items-center justify-center rounded-full bg-current/10"
														>
															<svg
																viewBox="0 0 16 16"
																class="size-[13px] opacity-55"
																fill="currentColor"
																aria-hidden="true"
															>
																<circle cx="8" cy="5.9" r="2.6" />
																<path d="M3.5 13.4c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4z" />
															</svg>
														</span>
													{/if}
													<span class="lg:hidden">Same person</span><span class="hidden lg:inline"
														>Same person &amp; place</span
													>
												</button>
												<button
													type="button"
													aria-pressed={!continuing}
													onclick={() => {
														contOffFor = stageContinuable?.id ?? '';
														continuing = null;
														spendConfirmChain();
													}}
													class="flex min-h-9 cursor-pointer items-center rounded-full px-3.5 text-xs transition-colors {continuing
														? 'text-[var(--st-faint)] hover:text-[var(--st-text)]'
														: 'bg-[var(--st-text)] font-semibold text-[var(--st-bg)]'}"
												>
													New clip
												</button>

												<!-- The two things you can do TO this clip, as opposed to the three you can
												 do next. Plain weight and no fill, because the accent is spent on the
												 answer above and these are not answers to it. They were a round glyph
												 with a tooltip and a filled white pill respectively, which made the
												 loudest thing in the row the one that was not the decision. -->
												<span class="flex-1"></span>
												{#if continuing && !continuing.characterId}
													<button
														type="button"
														onclick={makeCharacterFromClip}
														disabled={charFromClipBusy}
														class="flex cursor-pointer items-center gap-2 rounded-full px-2.5 py-1 text-xs text-[var(--st-muted)] transition-colors hover:text-[var(--st-text)] disabled:cursor-default disabled:opacity-60"
													>
														<!-- Fifteen seconds of five frames and a vision call. Long enough that a
														 button which only changes its words reads as one that did nothing. -->
														{#if charFromClipBusy}
															<span
																class="spin size-3 shrink-0 rounded-full border-2 border-[var(--st-line)] border-t-[var(--st-text)]"
															></span>
														{/if}
														<span
															>{charFromClipBusy ? 'Reading the clip…' : 'Keep this person'}</span
														>
													</button>
												{/if}
											</div>
											{#if !STAGE_UI}
												<p class="mt-1 text-xs leading-relaxed text-[var(--st-faint)]">
													{pinSeam
														? 'Seamless — the first instant is the frame the clip ended on.'
														: 'Same people, same place, a fresh take — the action can begin anywhere. The join may step.'}
												</p>
											{/if}
											<!-- Recommended, not required.
									     With no kept character the launch cuts a plate out of the prior
									     clip on every generation, so each continuation is measured
									     against the last render rather than against a face anybody
									     approved, and the drift compounds down the chain. One frame kept
									     as a character stops that. The send button stays live: this is
									     advice on the way past, not a gate. -->
											<!-- The offer itself now sits in the row above, beside the choice it
											     belongs to. What stays here is what that row has no place for: the
											     reason, on the surfaces that show reasons, and whatever went wrong. -->
											{#if continuing && !continuing.characterId}
												{#if !STAGE_UI}
													<p class="mt-2 text-xs leading-relaxed text-[var(--st-muted)]">
														No character is kept for this clip, so each continuation copies the one
														before it and the likeness drifts. Keeping one now holds it.
													</p>
												{/if}
												{#if charFromClipError}
													<p class="mt-1.5 text-xs leading-relaxed text-[var(--st-warn,#e06c6c)]">
														{charFromClipError}
													</p>
												{/if}
											{:else if continuing && !STAGE_UI}
												<p class="mt-2 text-xs leading-relaxed text-[var(--st-muted)]">
													Kept as <span class="font-semibold">{continuing.characterName}</span> — every
													continuation from here is measured against that picture.
												</p>
											{/if}
										</div>
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
									<div class="mb-1 hidden flex-wrap items-center gap-1.5 px-1 lg:flex">
										{#if chosenCharacter}
											<span
												class="flex items-center gap-2 rounded-full bg-[var(--st-bg)] py-1 pr-1 pl-1 text-xs"
											>
												<!-- The name opens the picker, the × clears it. Two things you
											 might want from a chip that names a choice — change it, or
											 stop making it — and only the second had a control. -->
												<button
													type="button"
													onclick={() => (pickKind = 'character')}
													class="flex cursor-pointer items-center gap-2"
												>
													<img
														src="/studio/api/sheet/img/{chosenCharacter.id}"
														alt=""
														onerror={sheetImageMissing}
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
												</button>
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
										{:else}
											<!-- The chip stays whether or not anyone is cast.
										 With no character the row simply vanished, so the one place
										 that answers "who is in this" was missing exactly when the
										 answer was "nobody in particular" — which is a real answer and
										 the default one. Saying it out loud also puts the picker one
										 click from where the question is asked, instead of two menus
										 away behind the +. -->
											<button
												type="button"
												onclick={() => (pickKind = 'character')}
												class="flex min-h-8 cursor-pointer items-center gap-2 rounded-full bg-[var(--st-bg)] py-1 pr-3 pl-1 text-xs text-[var(--st-faint)] transition-colors hover:text-[var(--st-text)]"
											>
												<!-- The same disc the cast chip wears, with nobody in it.
											 It was a hairline ring around an outlined figure while the
											 chip beside it — the same slot, filled — was a solid
											 photograph, so one control drew its two states in two
											 different languages and the empty one read as a dropped
											 image rather than as a choice not yet made. A placeholder is
											 the shape it stands in for: a filled disc, and a solid
											 figure inside it, because hairlines at eleven pixels
											 shimmer and an outline at that size is not a drawing, it is
											 a suggestion of one. -->
												<span
													class="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--st-surface-2)]"
												>
													<svg viewBox="0 0 16 16" class="size-[11px]" aria-hidden="true">
														<circle cx="8" cy="5.9" r="2.6" fill="currentColor" />
														<path
															d="M3.5 13.4c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4z"
															fill="currentColor"
														/>
													</svg>
												</span>
												<span>anyone</span>
											</button>
										{/if}
										{#if chosenLocation}
											<span
												class="flex items-center gap-2 rounded-full bg-[var(--st-bg)] py-1 pr-1 pl-1 text-xs"
											>
												<img
													src="/studio/api/sheet/img/{chosenLocation.id}"
													alt=""
													onerror={sheetImageMissing}
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
												<svg
													viewBox="0 0 10 10"
													class="size-2.5 shrink-0"
													fill="none"
													aria-hidden="true"
												>
													<path
														d="M2 4l3 3 3-3"
														stroke="currentColor"
														stroke-width="1.4"
														stroke-linecap="round"
													/>
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
											class="hidden min-h-8 cursor-pointer items-center gap-2 rounded-full bg-[var(--st-bg)] px-3 font-mono text-xs text-[var(--st-muted)] transition-colors hover:text-[var(--st-text)] lg:flex"
										>
											{composerShape.seconds}s · {composerShape.res} · {composerShape.portrait
												? '9:16'
												: '16:9'}
											<!-- The same chevron the mode control carries. Two chips that open
										 the same kind of panel were reading as two different kinds of
										 thing: one looked like a control, the other like a readout.
										 Dropped while continuing, where it really is a readout. -->
											<svg
												viewBox="0 0 10 10"
												class="size-2.5 shrink-0"
												fill="none"
												aria-hidden="true"
											>
												<path
													d="M2 4l3 3 3-3"
													stroke="currentColor"
													stroke-width="1.4"
													stroke-linecap="round"
												/>
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
														<svg
															viewBox="0 0 16 16"
															class="size-[15px]"
															fill="none"
															aria-hidden="true"
														>
															<circle
																cx="8"
																cy="5.6"
																r="2.7"
																stroke="currentColor"
																stroke-width="1.4"
															/>
															<path
																d="M3 13.2c.7-2.3 2.6-3.4 5-3.4s4.3 1.1 5 3.4"
																stroke="currentColor"
																stroke-width="1.4"
																stroke-linecap="round"
															/>
														</svg>
													{:else}
														<svg
															viewBox="0 0 16 16"
															class="size-[15px]"
															fill="none"
															aria-hidden="true"
														>
															<rect
																x="2.2"
																y="3.4"
																width="11.6"
																height="9.2"
																rx="1.6"
																stroke="currentColor"
																stroke-width="1.4"
															/>
															<path
																d="M2.4 10.2l3-2.6 2.6 2.2 2.4-1.8 3.2 2.4"
																stroke="currentColor"
																stroke-width="1.4"
																stroke-linecap="round"
																stroke-linejoin="round"
															/>
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
													<svg
														viewBox="0 0 10 10"
														class="ml-auto size-2.5 shrink-0 text-[var(--st-faint)]"
														fill="none"
														aria-hidden="true"
													>
														<path
															d="M3.5 2l3 3-3 3"
															stroke="currentColor"
															stroke-width="1.4"
															stroke-linecap="round"
														/>
													</svg>
												{/if}
											</button>
										{/each}
									</div>
								{/if}

								<!-- ── the add menu, level two ─────────────────────────────── -->
								{#if pickKind}
									{@const kept = pickKind === 'character' ? characters : locations}
									<div
										role="menu"
										class="enter absolute bottom-full left-2 z-30 mb-2 flex w-[23rem] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl bg-[var(--st-surface)] shadow-[0_16px_44px_rgba(0,0,0,.6)] ring-1 ring-[var(--st-line)]"
									>
										<div
											class="flex items-center gap-2 border-b border-[var(--st-line)] py-2 pr-2.5 pl-1.5"
										>
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
													<path
														d="M9.5 3l-4 5 4 5"
														stroke="currentColor"
														stroke-width="1.5"
														stroke-linecap="round"
														stroke-linejoin="round"
													/>
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
													{@const on =
														pickKind === 'character'
															? wantCharacter === s.id
															: wantLocation === s.id}
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
															<!-- The picture, over the shape it will be.
																 A sheet's image url answers 404 until its six views land, which is the
																 minutes right after you make the character — and hiding the broken
																 element on its own left a hole where a face goes, with the name under
																 nothing. The placeholder sits behind every tile rather than instead of
																 some of them, so the tile is the same shape throughout and the picture
																 simply arrives into it. -->
															<span class="relative block aspect-square w-full">
																<span
																	class="absolute inset-0 flex items-center justify-center bg-[var(--st-surface-2)] {pickKind ===
																	'character'
																		? 'rounded-full'
																		: 'rounded-lg'} {on ? 'ring-2 ring-[var(--st-text)]' : ''}"
																>
																	{#if s.id}
																		<svg
																			viewBox="0 0 16 16"
																			class="size-1/3 text-[var(--st-faint)] opacity-55"
																			fill="currentColor"
																			aria-hidden="true"
																		>
																			<circle cx="8" cy="5.9" r="2.6" />
																			<path d="M3.5 13.4c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4z" />
																		</svg>
																	{/if}
																</span>
																{#if s.id}
																	<img
																		src="/studio/api/sheet/img/{s.id}"
																		alt=""
																		onerror={sheetImageMissing}
																		class="absolute inset-0 h-full w-full object-cover transition-opacity hover:opacity-80 {pickKind ===
																		'character'
																			? 'rounded-full'
																			: 'rounded-lg'} {on ? 'ring-2 ring-[var(--st-text)]' : ''}"
																	/>
																{/if}
															</span>
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
												<label
													class="flex min-w-0 items-baseline gap-1 text-xs text-[var(--st-muted)]"
													for="voice-field"
												>
													<span class="shrink-0">How</span>
													<span class="min-w-0 truncate font-medium text-[var(--st-text)]"
														>{chosenCharacter.name}</span
													>
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
										style="left:{panelAt.x}px; transform-origin:{panelAt.o}px bottom"
										class="pillrise absolute bottom-full z-40 mb-2 w-[19.5rem] max-w-[calc(100vw-2rem)] rounded-2xl bg-[var(--st-surface)] p-2 shadow-[0_16px_44px_rgba(0,0,0,.6)] ring-1 ring-[var(--st-line)] lg:left-2! lg:z-30"
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
											<span
												class="w-3.5 shrink-0 text-xs {mode === 'simple' && effAtOnce === 1
													? ''
													: 'invisible'}">&#10003;</span
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
													class="w-3.5 shrink-0 text-xs {mode === 'simple' && mine > 1
														? ''
														: 'invisible'}">&#10003;</span
												>
												<span
													class="min-w-0 flex-1 whitespace-nowrap {axis.id === 'angles' &&
													!anglesApply
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
											<p
												class="mt-0.5 mb-1 pl-[2.25rem] text-xs text-[var(--st-faint)] tabular-nums"
											>
												{effAtOnce} clips — {effAngles} angles, {takes} versions of each
											</p>
										{/if}
										<div class="my-1 h-px bg-[var(--st-line)]"></div>
										<!-- Shown, and not yet offered.
									 A screenplay, a cast and a multi-scene shoot is the other half
									 of this product and it is not finished; taking the row out
									 entirely would have been honest about today and silent about
									 where this goes, and a person deciding whether to keep using
									 the app is deciding about both. So it stays where it will be,
									 reading as what it is: one step down in contrast, no check
									 column to fill, and the word for when rather than a lock icon —
									 a lock says you may not, and the truth is not yet.

									 aria-disabled rather than a disabled button, because the row is
									 not a control that happens to be off: it is a line of text
									 announcing something. Screen readers get told it is unavailable
									 and the tab order does not stop on it. -->
										<div
											role="menuitem"
											aria-disabled="true"
											class="flex min-h-[2.75rem] w-full cursor-default items-center gap-2.5 rounded-xl px-3 text-left text-sm"
										>
											<span class="invisible w-3.5 shrink-0 text-xs">&#10003;</span>
											<span class="min-w-0">
												<span class="block text-[var(--st-muted)]">full production</span>
												<span class="mt-0.5 block text-xs text-[var(--st-faint)]"
													>screenplay and cast first, then a multi-scene shoot</span
												>
											</span>
											<span
												class="ml-auto shrink-0 self-start pt-0.5 text-xs text-[var(--st-faint)]"
												>coming soon</span
											>
										</div>
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
										style="left:{panelAt.x}px; transform-origin:{panelAt.o}px bottom"
										class="pillrise absolute bottom-full z-40 mb-2 w-[19.5rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl bg-[var(--st-surface)] shadow-[0_16px_44px_rgba(0,0,0,.6)] ring-1 ring-[var(--st-line)] lg:left-2! lg:z-30"
									>
										<div class="flex items-center gap-3 px-4 py-2.5 lg:px-3">
											<span
												class="flex items-center gap-2.5 text-sm whitespace-nowrap text-[var(--st-muted)]"
											>
												<svg
													viewBox="0 0 16 16"
													class="size-[15px] shrink-0 opacity-80"
													fill="none"
													aria-hidden="true"
												>
													<circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.4" />
													<path
														d="M8 4.8V8l2.2 1.4"
														stroke="currentColor"
														stroke-width="1.4"
														stroke-linecap="round"
													/>
												</svg>
												Length
											</span>
											<span class="ml-auto flex gap-0.5 rounded-full p-0.5 lg:bg-[var(--st-bg)]">
												{#each [5, 10, 15] as sec (sec)}
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
															? 'font-semibold text-[var(--st-text)] lg:bg-[var(--st-surface-2)] lg:font-medium'
															: 'text-[var(--st-faint)] hover:text-[var(--st-text)]'}">{sec}</button
													>
												{/each}
											</span>
										</div>

										<div
											class="flex items-center gap-3 px-4 py-2.5 shadow-[inset_0_1px_0_var(--st-line)] lg:px-3"
										>
											<span
												class="flex items-center gap-2.5 text-sm whitespace-nowrap text-[var(--st-muted)]"
											>
												<svg
													viewBox="0 0 16 16"
													class="size-[15px] shrink-0 opacity-80"
													fill="none"
													aria-hidden="true"
												>
													<rect
														x="2"
														y="4"
														width="12"
														height="8"
														rx="1.4"
														stroke="currentColor"
														stroke-width="1.4"
													/>
													<path
														d="M5 7.5h6"
														stroke="currentColor"
														stroke-width="1.4"
														stroke-linecap="round"
													/>
												</svg>
												Size
											</span>
											<span class="ml-auto flex gap-0.5 rounded-full p-0.5 lg:bg-[var(--st-bg)]">
												{#each RES_KEYS as r (r)}
													{@const f = frameFor(
														r,
														composerShape.portrait ? 'portrait' : 'landscape'
													)}
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
															: 'cursor-pointer'} {composerShape.res === r
															? 'font-semibold text-[var(--st-text)] lg:bg-[var(--st-surface-2)] lg:font-medium'
															: 'text-[var(--st-faint)] hover:text-[var(--st-text)]'}">{r}</button
													>
												{/each}
											</span>
										</div>

										<div
											class="flex items-center gap-3 px-4 py-2.5 shadow-[inset_0_1px_0_var(--st-line)] lg:px-3"
										>
											<span
												class="flex items-center gap-2.5 text-sm whitespace-nowrap text-[var(--st-muted)]"
											>
												<svg
													viewBox="0 0 16 16"
													class="size-[15px] shrink-0 opacity-80"
													fill="none"
													aria-hidden="true"
												>
													<rect
														x="2.4"
														y="3"
														width="11.2"
														height="10"
														rx="1.4"
														stroke="currentColor"
														stroke-width="1.4"
													/>
												</svg>
												Frame
											</span>
											<!-- The one place a glyph beats the label: the thing being chosen
										 IS a shape, and two rectangles say it faster than 9:16 does. -->
											<span class="ml-auto flex gap-0.5 rounded-full p-0.5 lg:bg-[var(--st-bg)]">
												{#each [['portrait', '9:16', 'h-3 w-2'], ['landscape', '16:9', 'h-2 w-3.5']] as [val, label, box] (val)}
													<button
														type="button"
														disabled={composerShape.fixed}
														aria-pressed={(composerShape.portrait ? 'portrait' : 'landscape') ===
															val}
														title={label}
														onclick={() => {
															wantOrientation = val as 'portrait' | 'landscape';
															saveSetup();
														}}
														class="flex min-h-7 items-center gap-1.5 rounded-full px-2.5 font-mono text-xs tabular-nums transition-colors {composerShape.fixed
															? 'cursor-default opacity-40'
															: 'cursor-pointer'} {(composerShape.portrait
															? 'portrait'
															: 'landscape') === val
															? 'font-semibold text-[var(--st-text)] lg:bg-[var(--st-surface-2)] lg:font-medium'
															: 'text-[var(--st-faint)] hover:text-[var(--st-text)]'}"
													>
														<span class="block rounded-[2px] border border-current {box}"></span>
														{label}
													</button>
												{/each}
											</span>
										</div>
										<!-- The fourth question, and on a phone the only place it is asked.
									 It used to be a row of three chips above the field, which wrapped
									 to two lines and put a decision in front of somebody who had not
									 asked for one yet. Here it sits with the other three settings,
									 in the same shape, and the field above stays a field.
									 Only when there is something to continue — with no clip behind it
									 the question has no answer, and an empty row is worse than none.
									 Desktop keeps the chips, where the pictures they wear earn their
									 width. -->
										{#if stageContinuable}
											<div
												class="flex items-center gap-3 px-4 py-2.5 shadow-[inset_0_1px_0_var(--st-line)] lg:hidden"
											>
												<span
													class="flex items-center gap-2.5 text-sm whitespace-nowrap text-[var(--st-muted)]"
												>
													<svg
														viewBox="0 0 16 16"
														class="size-[15px] shrink-0 opacity-80"
														fill="none"
														aria-hidden="true"
													>
														<path
															d="M3 8h10M9.5 4.5L13 8l-3.5 3.5"
															stroke="currentColor"
															stroke-width="1.4"
															stroke-linecap="round"
															stroke-linejoin="round"
														/>
													</svg>
													Next
												</span>
												<span class="ml-auto flex gap-0.5 rounded-full p-0.5 lg:bg-[var(--st-bg)]">
													{#each [['seam', 'Last frame'], ['same', 'Same person'], ['new', 'New clip']] as [val, label] (val)}
														{@const on =
															val === 'new'
																? !continuing
																: !!continuing && (val === 'seam') === pinSeam}
														<button
															type="button"
															aria-pressed={on}
															onclick={() => {
																if (val === 'new') {
																	contOffFor = stageContinuable?.id ?? '';
																	continuing = null;
																	spendConfirmChain();
																	return;
																}
																contOffFor = '';
																if (!continuing && stageContinuable)
																	startContinue(stageContinuable);
																pinSeam = val === 'seam';
															}}
															class="flex min-h-7 cursor-pointer items-center rounded-full px-2.5 text-xs transition-colors {on
																? 'font-semibold text-[var(--st-text)] lg:bg-[var(--st-surface-2)] lg:font-medium'
																: 'text-[var(--st-faint)] hover:text-[var(--st-text)]'}"
														>
															{label}
														</button>
													{/each}
												</span>
											</div>
										{/if}
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
												class="cursor-pointer text-[var(--st-faint)] hover:text-[var(--st-text)]"
												>×</button
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
								<!-- Two rows on a phone, one on a desktop.
								 The sentence is the thing; sharing a line with three controls left it
								 a box one line tall with the placeholder clipped at the ends. Wrapped,
								 the field takes the width and starts at the wall, and the controls sit
								 under it where they read as what you reach for after writing rather
								 than as furniture around the writing. -->
								<div class="flex flex-wrap items-end gap-1.5 lg:flex-nowrap">
									{#if mode === 'simple' && wantTarget === 'clip'}
										<button
											type="button"
											aria-label="add a character or a location"
											aria-expanded={addOpen}
											onclick={() => {
												const open = !addOpen && pickKind === null;
												shutMenus();
												addOpen = open;
											}}
											class="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-[var(--st-muted)] transition-colors hover:bg-[var(--st-bg)] hover:text-[var(--st-text)]"
										>
											<svg
												viewBox="0 0 16 16"
												class="size-[1.05rem]"
												fill="none"
												aria-hidden="true"
											>
												<path
													d="M8 3v10M3 8h10"
													stroke="currentColor"
													stroke-width="1.5"
													stroke-linecap="round"
												/>
											</svg>
										</button>
										<!-- Out of the menu and next to the plus.
											 It was the third row of a list you had to open, which is two
											 taps and a read for the one thing here that is not a decision:
											 you either have a picture or you do not. The people who attach
											 one are the ones who finish — sixty-three per cent of the
											 accounts with a reference rendered something, against nine of
											 those without — so it is the last control that should be
											 filed away behind a menu. -->
										<div class="group relative shrink-0">
											<label
												aria-label="reference image"
												class="flex size-9 cursor-pointer items-center justify-center rounded-full text-[var(--st-muted)] transition-colors hover:bg-[var(--st-bg)] hover:text-[var(--st-text)]"
											>
												<svg
													viewBox="0 0 20 20"
													class="size-[1.05rem]"
													fill="none"
													aria-hidden="true"
												>
													<path
														d="M13 7l-5.5 5.5a2.1 2.1 0 003 3L16 10a3.5 3.5 0 00-5-5l-5.5 5.5a5 5 0 007 7L18 12"
														stroke="currentColor"
														stroke-width="1.6"
														stroke-linecap="round"
														stroke-linejoin="round"
													/>
												</svg>
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
											<!-- Its own label rather than `title`: the browser's takes a
												 second to appear and arrives in the operating system's
												 styling, which on a surface this dark reads as a fault. -->
											<span
												class="pointer-events-none absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 rounded-md bg-[var(--st-surface-2)] px-2 py-1 text-[11px] whitespace-nowrap text-[var(--st-text)] opacity-0 shadow-[0_6px_20px_rgba(0,0,0,.5)] transition-opacity duration-150 group-hover:opacity-100"
												>reference image</span
											>
										</div>
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
										class="order-first block max-h-56 min-h-9 w-full flex-none basis-full resize-none border-0 bg-transparent px-1 py-2 text-[1.05rem] leading-relaxed outline-none placeholder:text-[var(--st-faint)] focus:ring-0 lg:order-none lg:flex-1 lg:basis-auto lg:px-2"
									></textarea>

									{#if mode === 'advanced' && !planningWs}
										<!-- Scene count is the planning chain's knob: it decides how many
									 documents get written and how many clips get scheduled. It has
									 no simple-mode counterpart, so it sits here rather than in the
									 menu, which is about what a clip is made with. -->
										<div
											class="flex shrink-0 items-center gap-0.5 rounded-full bg-[var(--st-bg)] p-0.5"
										>
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
										disabled={sending || charFromClipBusy || (!input.trim() && !pendingPhoto)}
										onclick={submit}
										class="ml-auto flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--st-accent)] text-[var(--st-on-accent)] transition-colors hover:bg-[var(--st-accent-strong)] disabled:cursor-default disabled:bg-[var(--st-surface-2)] disabled:text-[var(--st-faint)] lg:ml-0"
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
				</div>

				<!-- ── desktop task rail ────────────────────────────────────────── -->
				{#if brief}
					<aside class="hidden min-h-0 lg:block">
						<div class="scroller max-h-full overflow-y-auto rounded-2xl bg-[var(--st-surface)] p-5">
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
											This releases the GPU and clears the queue. It cannot be resumed — a new run
											starts from the plan again.
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

	<!-- The counterweight on the right, and — from xl up — a standing reservation
		 on both sides, so the rail costs the page nothing to open.

		 In the flow the rail takes 16rem off the left, and this gives the same back
		 on the right, which keeps the reading column's centre on the screen's
		 centre. Centred is not the same as unchanged: it still cost 32rem of width,
		 so opening the list resized the composer and rewrapped every line above it,
		 and a control that changes size because you opened something else has been
		 moved by something that has nothing to do with it.

		 Floating the rail over the gutter instead fixed the resizing and broke
		 worse: out of the flow it covered the composer's left edge, and main
		 stretched across the whole window. So the space is simply always there.
		 Where there is room for it — xl and up — the same 32rem is reserved whether
		 the rail is open or shut, one side standing in for the rail while it is
		 away. Nothing moves, nothing is covered, and the page keeps the proportions
		 it has with the list open, which is the state it is read in.

		 Below xl there is no room to hold 32rem open for a panel that is not there,
		 so that band keeps the counterweight alone.

		 Spacers rather than a padding rule on main: the rule has to be conditional,
		 and a conditional Tailwind variant is not reliably found by the scanner
		 while a scoped attribute selector is dropped by Svelte's pruner. Both
		 failed silently. These are static classes inside an if, which cannot.
		 Below lg the rail is an overlay and owes nothing. -->
	{#if sidebarOpen}
		<div class="hidden w-64 shrink-0 lg:block" aria-hidden="true"></div>
	{:else}
		<div class="hidden w-64 shrink-0 xl:block" aria-hidden="true"></div>
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

			<div
				class="lift stage overflow-hidden rounded-2xl bg-black shadow-[0_24px_70px_rgba(0,0,0,.6)]"
			>
				{#key filmKey(shot)}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						src={still(fileUrl(shot.workspace, shot.artifact, shot.file))}
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
				<span class="text-xs text-[var(--st-faint)] tabular-nums">
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
								src={still(fileUrl(c.workspace, c.artifact, c.file))}
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
							src={still(fileUrl(run.clip.workspace, run.clip.artifact, run.clip.file))}
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
					<span class="text-[13px] font-medium text-[var(--st-text)] tabular-nums"
						>Take {run.index}</span
					>
					{#if row}
						<span class="text-xs text-[var(--st-faint)] tabular-nums">seed {row.seed}</span>
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

<!-- The film, the moment it exists.
	 Export used to end with a file on disk and a card somewhere below the fold,
	 which is a strange way to hand somebody the thing they have been assembling
	 all afternoon. Closing this loses nothing: it is on the shelf. -->
<!-- One item from the front page, at the size it was made for. Nothing here
	 edits or continues it: this is the shelf, and the shelf is for looking.
	 The wall stays visible behind it. At ninety-four per cent black this was a
	 page rather than a layer — you pressed a tile and the studio appeared to be
	 gone, which is the one thing a preview must not do. Two thirds and a light
	 blur reads as something opened ON the page: the shelf is still there,
	 recognisably where you left it, and closing puts you back on the tile you
	 pressed rather than somewhere you have to find again. -->
{#if mediaPopup}
	<div
		class="fixed inset-0 z-[70] flex items-center justify-center bg-black/65 p-4 backdrop-blur-md sm:p-8"
		role="dialog"
		aria-modal="true"
		aria-label="clip"
	>
		<button
			type="button"
			aria-label="close"
			onclick={() => (mediaPopup = null)}
			class="fixed inset-0 cursor-default"
		></button>
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			src={shelfUrl(mediaPopup)}
			controls
			autoplay
			loop
			playsinline
			class="video-with-controls relative max-h-full max-w-full rounded-2xl bg-black"
		></video>
		<button
			type="button"
			aria-label="close"
			onclick={() => (mediaPopup = null)}
			class="fixed top-5 right-5 z-10 flex size-11 cursor-pointer items-center justify-center rounded-full bg-white/10 text-sm text-[var(--st-text)] backdrop-blur-md transition-colors hover:bg-white/20"
		>
			✕
		</button>
	</div>
{/if}

{#if filmPopup}
	<div
		class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-black/92 px-6 py-12 backdrop-blur-[28px]"
		role="dialog"
		aria-modal="true"
		aria-label="the finished film"
	>
		<button
			type="button"
			aria-label="close"
			onclick={() => (filmPopup = null)}
			class="absolute top-5 right-5 flex size-11 cursor-pointer items-center justify-center rounded-full bg-white/10 text-sm text-[var(--st-text)] backdrop-blur-md transition-colors hover:bg-white/20"
		>
			✕
		</button>
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			src={still(fileUrl(filmPopup.workspace, filmPopup.artifact, filmPopup.file))}
			controls
			autoplay
			playsinline
			class="video-with-controls max-h-[70vh] max-w-full rounded-2xl bg-black shadow-[0_24px_70px_rgba(0,0,0,.6)]"
		></video>
		<p class="text-xs text-[var(--st-faint)] tabular-nums">
			{filmPopup.parts} shots · {Math.round(filmPopup.seconds)}s
		</p>
	</div>
{/if}

<!-- Everything that has been finished, at once. -->
{#if mediaOpen}
	<!-- The picker. The front page is a list somebody made, so there has to be a
		 place to make it — and the only honest one is everything the studio has,
		 with a mark on what is already up. A rule cannot do this job: length says
		 a thing was assembled, never that it was any good, and the front page is
		 the one surface where that difference is the whole point. -->
	<div
		class="fixed inset-0 z-[60] overflow-y-auto bg-black/94 px-6 py-14 backdrop-blur-[28px]"
		role="dialog"
		aria-modal="true"
		aria-label="choose what is on the front page"
	>
		<button
			type="button"
			aria-label="close"
			onclick={() => (mediaOpen = false)}
			class="fixed top-5 right-5 z-10 flex size-11 cursor-pointer items-center justify-center rounded-full bg-white/10 text-sm text-[var(--st-text)] backdrop-blur-md transition-colors hover:bg-white/20"
		>
			✕
		</button>
		<h2 class="mb-1 text-center font-display text-lg font-semibold">Choose the front page</h2>
		<p class="mb-5 text-center text-xs text-[var(--st-faint)]">
			{pins.length} pinned of {pool.length}
		</p>
		<div class="mx-auto grid max-w-6xl grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-7">
			{#each pool as m (m.id)}
				{@const on = pins.includes(m.id)}
				<button
					type="button"
					aria-pressed={on}
					aria-label="{on ? 'remove from' : 'add to'} the front page"
					onclick={() => togglePin(m.id)}
					class="group relative aspect-square cursor-pointer overflow-hidden rounded-xl bg-[var(--st-surface)] transition-opacity {on
						? 'opacity-100 ring-2 ring-[var(--st-text)]'
						: 'opacity-55 hover:opacity-90'}"
				>
					<!-- svelte-ignore a11y_media_has_caption -->
					<video
						use:whenSeen={still(`/studio/api/media?id=${m.id}`)}
						muted
						playsinline
						preload="metadata"
						class="h-full w-full object-cover"
					></video>
					<span
						class="pointer-events-none absolute right-1 bottom-1 rounded bg-black/60 px-1 font-mono text-[0.6rem] leading-4 text-white"
						>{clipClock(m.seconds)}</span
					>
					{#if on}
						<span
							class="pointer-events-none absolute top-1 left-1 rounded-full bg-[var(--st-text)] px-1.5 text-[0.6rem] leading-4 font-semibold text-black"
							>pinned</span
						>
					{/if}
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
	/** The wall does not end, it runs out.
	 *
	 *  The column that holds it stops at a hard edge, and a tile crossing that
	 *  edge is guillotined — half a picture, then the composer. It reads as a
	 *  bug rather than as more content below, which is the opposite of what a
	 *  scrolling shelf should say. A mask over the last few centimetres lets the
	 *  bottom row dissolve instead, so the boundary says "there is more" and the
	 *  eye goes back to the field underneath rather than to the seam.
	 *
	 *  Bottom only: fading the top as well would put a veil over the greeting,
	 *  which is the first thing anybody reads here. Prefixed for Safari before
	 *  15.4, where the unprefixed property does nothing at all. */
	.stagescroll {
		-webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 4.5rem), transparent);
		mask-image: linear-gradient(to bottom, #000 calc(100% - 4.5rem), transparent);
	}

	/** On the front page the wall does not stop above the composer, it runs under
	 *  it. Stopping short leaves a band of empty black between the last tile and
	 *  the field, which is the seam this was trying to lose — the picture should
	 *  carry on behind the controls and be hidden by them, the way a library
	 *  scrolls under its own search bar.
	 *
	 *  The negative margin is what does it: in a flex column it shrinks the item's
	 *  outer box, so the column hands the element that height back and the next
	 *  sibling — the composer — moves up over it. The padding underneath gives the
	 *  last row somewhere to go, so it can be scrolled clear of the field rather
	 *  than being permanently behind it.
	 *
	 *  And no fade on this one. The mask above exists for an edge with nothing
	 *  past it; here there is something past it — the composer — and a picture
	 *  that dissolves just before reaching it never arrives underneath, which is
	 *  the whole effect. A library scrolls under its own search bar and is hidden
	 *  by it, not faded out in front of it. */
	/** The scrollbar belongs to the window's edge, and should be almost invisible.
	 *
	 *  Two faults, one rule. It sat twenty points in from the right because the
	 *  column it lives in is padded, so the bar floated in the middle of the page
	 *  with content on both sides of it — a scrollbar is furniture and furniture
	 *  goes against the wall. The negative margin pushes the scroll box out to the
	 *  edge and the matching padding puts the content back where it was, so
	 *  nothing moves but the bar.
	 *
	 *  And it was the brightest thing on a page of dark pictures. Seven points
	 *  wide, seven per cent white, no track at all: present when you look for it,
	 *  gone when you are looking at a film. It lifts to fourteen on hover, which
	 *  is the only moment anybody is aiming at it.
	 *
	 *  Desktop only. A phone has overlay scrollbars that already do all of this
	 *  and reserve no width, and styling them would take width away from the one
	 *  screen that has none to give. */
	@media (min-width: 640px) {
		.stagescroll {
			margin-right: -1.25rem;
			padding-right: 1.25rem;
			scrollbar-width: thin;
			scrollbar-color: rgba(255, 255, 255, 0.07) transparent;
		}
		.stagescroll::-webkit-scrollbar {
			width: 7px;
		}
		.stagescroll::-webkit-scrollbar-track {
			background: transparent;
		}
		.stagescroll::-webkit-scrollbar-thumb {
			background: rgba(255, 255, 255, 0.07);
			border-radius: 99px;
		}
		.stagescroll:hover::-webkit-scrollbar-thumb {
			background: rgba(255, 255, 255, 0.14);
		}
	}

	/* The row scrolls but never shows a bar: the peeking card and the dots
	   already say it moves, and a scrollbar under three cards is furniture. */
	.starterrow {
		scrollbar-width: none;
	}
	.starterrow::-webkit-scrollbar {
		display: none;
	}

	/** The shot card is glass too, lightly.
	 *
	 *  On the stage this card sits over the picture, and a solid panel there is a
	 *  hole cut in the clip you are about to extend. Translucent, it stays a layer
	 *  on top of the thing rather than a replacement for it. In the transcript
	 *  there is only black behind it and the blur costs nothing — the same rule
	 *  reads correctly in both places, which is why it is one rule.
	 *
	 *  The specular line along the top is the whole difference between glass and
	 *  a grey box: it is where light would catch a real edge, and without it the
	 *  material reads as transparency rather than as a surface. One pixel, inset,
	 *  fourteen per cent.
	 *
	 *  Seventy per cent, not less. This card carries the sentence somebody is
	 *  agreeing to and a button that spends money; anything more transparent puts
	 *  a moving picture behind the words at the moment they matter most. */
	.shotglass {
		background: color-mix(in srgb, var(--st-surface) 96%, transparent);
	}
	@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
		.shotglass {
			background: color-mix(in srgb, var(--st-surface) 70%, transparent);
			-webkit-backdrop-filter: blur(28px) saturate(1.4);
			backdrop-filter: blur(28px) saturate(1.4);
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14);
		}
	}

	/** The chips are the same glass as the field under them.
	 *
	 *  Left solid they were six opaque lozenges floating on a translucent card —
	 *  the one part of the bottom of the page that still read as laid on top of
	 *  the picture rather than resting in it. Same treatment, one notch further
	 *  open: they are small, they carry two or three words, and a chip is read in
	 *  a glance rather than dwelt on.
	 *
	 *  Their hover state stays opaque on purpose. Hover is the moment a control
	 *  says it is about to be used, and the clearest way to say it here is to
	 *  stop being glass. */
	.pillglass {
		background: var(--st-surface);
	}
	@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
		.pillglass {
			background: color-mix(in srgb, var(--st-surface) 80%, transparent);
			-webkit-backdrop-filter: blur(18px) saturate(1.15);
			backdrop-filter: blur(18px) saturate(1.15);
		}
	}

	/** The field sits ON the wall, so it lets a little of it through.
	 *
	 *  Solid, it was a bar laid across the picture and the shelf appeared to stop
	 *  at its top edge — which is the seam this stopped having. A touch of the
	 *  tiles showing through says the wall carries on underneath, which is true,
	 *  and it is the difference between a panel and a piece of glass over one.
	 *
	 *  Eighty-four per cent, not less: the placeholder and the chips have to stay
	 *  legible over whatever happens to be behind them, and behind them is
	 *  moving video. The blur is what makes that safe — it takes the detail out
	 *  of the backdrop and leaves only its brightness, so text keeps its contrast
	 *  no matter which tile is playing. Without the blur this would be unreadable
	 *  every time a bright frame passed under it.
	 *
	 *  `color-mix` rather than an opacity modifier so the surface token stays the
	 *  single source of the colour, and a plain background for anybody whose
	 *  browser has no backdrop-filter — where translucency without the blur is
	 *  exactly the unreadable case. */
	.composerglass {
		background: var(--st-surface);
	}
	@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)) {
		.composerglass {
			background: color-mix(in srgb, var(--st-surface) 84%, transparent);
			-webkit-backdrop-filter: blur(22px) saturate(1.15);
			backdrop-filter: blur(22px) saturate(1.15);
		}
	}

	.undercomposer {
		-webkit-mask-image: none;
		mask-image: none;
	}

	/* The one moving thing on the page, and it earns it: during a render nothing
	   else changes for minutes, so stillness would read as a hang. Anyone who has
	   asked the system to stop animating gets a static ring instead — the state
	   is already carried by the shape and the word beside it. */
	/* The waiting ground for a clip that continues nothing.
	 *
	 * A field of dots that breathes rather than a spinner filling the frame: the
	 * pill already says how far along it is, and this is only meant to keep the
	 * rectangle from reading as a picture that failed to load. */
	.stage-dots {
		background-image: radial-gradient(currentColor 1px, transparent 1px);
		background-size: 22px 22px;
		color: var(--st-surface-2);
		animation: stage-dots 3.2s ease-in-out infinite;
	}
	@keyframes stage-dots {
		0%,
		100% {
			opacity: 0.5;
			background-position: 0 0;
		}
		50% {
			opacity: 1;
			background-position: 11px 11px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.stage-dots {
			animation: none;
		}
	}

	/* The pass of light. A wide, very soft band of white at four per cent,
	 * travelling the diagonal — no edge hard enough to read as a shape, and no
	 * colour, because the only colour on this surface is the beacon and it is
	 * already spoken for. 4.2s with a rest at each end: a sweep that restarts the
	 * instant it finishes reads as a machine, and this is meant to read as
	 * something breathing. */
	.stage-sweep {
		background: linear-gradient(
			115deg,
			transparent 38%,
			rgba(255, 255, 255, 0.04) 50%,
			transparent 62%
		);
		background-size: 260% 260%;
		animation: stage-sweep 4.2s ease-in-out infinite;
	}
	@keyframes stage-sweep {
		0% {
			background-position: 100% 0;
		}
		70%,
		100% {
			background-position: 0 100%;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.stage-sweep {
			animation: none;
			background: none;
		}
	}
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

	/* Same for the settings row above the composer. */
	.railstrip {
		scrollbar-width: none;
	}
	.railstrip::-webkit-scrollbar {
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
		/* One step below muted. A bare var(--color-faint) was wrong in a host that
		 * has no such token: an unresolvable var() invalidates the whole
		 * declaration, so every faint line inherited full text colour and the third
		 * step of the hierarchy silently did not exist. The fallback is the
		 * studio's own value, so it looks the same wherever it is mounted. */
		--st-faint: var(--color-faint, #86868b);
		--st-green: var(--color-green, #22c55e);
		/* The accent is white, and it is the studio's own rather than the host's.
		 *
		 * It read var(--color-coral) — the host's accent — and in an app whose
		 * coral is a hot pink the one control that spends GPU time became a hot
		 * pink pill on black, which reads as a tube site rather than a studio and
		 * put the loudest thing on the view on a button instead of on the picture
		 * the view exists for. The standalone app has always had this right: its
		 * own accent token IS white. So the studio names white directly, spends it
		 * once per view, and keeps colour for the semantic layer — the activity
		 * dots, the error card — where it means something. */
		--st-accent: var(--st-text);
		--st-accent-strong: #fff;
		--st-on-accent: var(--st-bg);
		background: var(--st-bg);
		color: var(--st-text);
		font-family: var(--font-body);
	}

	/* ── buttons ──────────────────────────────────────────────────────────────
	 * Four kinds and no fifth. These live in the studio's own stylesheet in the
	 * standalone app and did not come across with it, so all twenty-six buttons
	 * in here rendered as bare text on a bare background: the one control that
	 * spends GPU time looked like a bolder sentence, which is exactly the thing
	 * a primary button exists not to be.
	 *
	 *   .btn-primary    the one thing on a view that spends GPU time or cannot
	 *                   be undone. Filled with the accent. ONE per view.
	 *   .btn-secondary  the ordinary action. Filled with a surface, so it reads
	 *                   as a control without competing with the primary.
	 *   .btn-quiet      dismiss, cancel, "not now". No fill until you reach it.
	 *   .btn-danger     destroys something that cost money. The only red.
	 *
	 * One height, one radius, one weight per kind. .btn-sm is the only size
	 * modifier, for controls sitting inside a card's own furniture. */
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		min-height: 2.25rem;
		padding-inline: 1.125rem;
		border-radius: 9999px;
		font-family: var(--font-body);
		font-size: 0.875rem;
		font-weight: 500;
		white-space: nowrap;
		cursor: pointer;
		transition: background-color 0.2s cubic-bezier(0.32, 0.72, 0, 1);
	}
	.btn:disabled {
		cursor: default;
		opacity: 0.4;
	}
	.btn-sm {
		min-height: 2rem;
		padding-inline: 0.875rem;
		font-size: 0.8125rem;
	}
	/* The accent, filled, and the strip already taught this language: the clip you
	 * are looking at is the one lit with --st-text. */
	.btn-primary {
		background: var(--st-accent);
		color: var(--st-on-accent);
		font-weight: 600;
	}
	.btn-primary:hover:not(:disabled) {
		background: var(--st-accent-strong);
	}
	.btn-primary:disabled {
		background: var(--st-surface-2);
		color: var(--st-faint);
		opacity: 1;
	}
	.btn-secondary {
		background: var(--st-surface-2);
		/* Muted, not full text. On a filled pill the label was as bright as the
		 * primary's, so a row of them read as a row of equals and the eye had to
		 * work out which one mattered. */
		color: var(--st-muted);
	}
	.btn-secondary:hover:not(:disabled) {
		background: var(--st-line);
		color: var(--st-text);
	}
	.btn-quiet {
		background: none;
		color: var(--st-muted);
	}
	.btn-quiet:hover:not(:disabled) {
		background: var(--st-surface);
		color: var(--st-text);
	}
	.btn-danger {
		background: var(--st-surface-2);
		color: #f2938a;
	}
	.btn-danger:hover:not(:disabled) {
		background: #5c2f24;
		color: #f7ded9;
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

	/* A folded setting unfolding.
	   Each option arrives from where the fold was and a beat after the one
	   before it, so the group reads as opening rather than as being replaced —
	   which is what an instant swap looked like, and why the row appeared to
	   flicker when a bubble was tapped. Short: this sits under a thumb that is
	   already moving to the next tap. */
	.pillopen {
		animation: pillopen 0.26s cubic-bezier(0.25, 1, 0.5, 1) both;
	}

	/* The panel growing out of the bubble that was pressed.
	   Scale rather than a slide, and from an origin set on the element itself:
	   a box that merely appears above the row reads as a different object,
	   while one that grows from under your finger reads as the same one
	   opening. The overshoot is small — it is a 144px panel, not a sheet. */
	.pillrise {
		animation: pillrise 0.32s cubic-bezier(0.2, 1.15, 0.4, 1) both;
	}
	@keyframes pillrise {
		from {
			opacity: 0;
			transform: translateY(8px) scale(0.82);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}
	@keyframes pillopen {
		from {
			opacity: 0;
			transform: translateX(-7px) scale(0.93);
		}
		to {
			opacity: 1;
			transform: none;
		}
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
		.enter,
		.pillopen,
		.pillrise {
			animation: none;
		}
	}
</style>
