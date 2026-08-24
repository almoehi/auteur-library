<script lang="ts">
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
	import { onMount } from 'svelte';
	import { parseEventLog, type ActivityRow } from './activity';
	import { renderDocument, type Block } from './render-doc';
	import {
		SCENE_COUNT_MAX,
		SCENE_COUNT_MIN,
		type Artifact,
		type ArtifactFile,
		type Brief,
		type ChatItem,
		type LaunchResult,
		type PollState,
		type ProxyResult,
		type Task
	} from './types';
	import { CATALOGUE, MAX_PICKS, loraFor } from './loras';

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

	/** Which door this session is using. Simple by default: it is the one that
	 *  produced usable clips today, and the planning chain is a twenty-minute
	 *  round trip to find out whether it did. Remembered across visits — a mode
	 *  is a working habit, not a per-run choice. */
	let mode = $state<'simple' | 'advanced'>('simple');
	const MODE_KEY = 'auteur-studio-mode';

	const WELCOME_TEXT =
		'Describe the film in one sentence. We start with a plan — screenplay, cast, ' +
		'art direction — and you approve every document here. ' +
		'No GPU time is used until you approve.';

	/** Simple mode's opening. It says what the mode actually does, because the
	 *  difference that matters is not "fewer steps" — it is that you see the exact
	 *  text the model receives, and can change it, before anything is spent. */
	const WELCOME_SIMPLE =
		'Describe the shot you want. I write the render prompt, you read it and ' +
		'change anything you like, then it goes straight to the model. ' +
		'No GPU time is used until you press render.';

	const welcomeFor = (m: 'simple' | 'advanced') =>
		m === 'simple' ? WELCOME_SIMPLE : WELCOME_TEXT;

	/** The greeting is a property of the empty page, not a message in the
	 *  conversation — so switching modes rewrites it where it stands. Pushing a
	 *  fresh one each time stacked a paragraph per switch, and flipping twice to
	 *  compare the two modes left four of them. */
	let welcomeId = $state('');

	function showWelcome() {
		const existing = welcomeId && chat.find((c) => c.id === welcomeId);
		if (existing) existing.text = welcomeFor(mode);
		else welcomeId = pushStudio(welcomeFor(mode)).id;
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

	/** Simple mode is given one shot, not a film, so its seeds name the act and
	 *  the camera rather than a premise. */
	const EXAMPLES_SIMPLE = [
		'a blonde woman on her knees sucking a black man, filmed close on her mouth',
		'two women on a bed, one going down on the other, handheld from the side',
		'she rides him facing the camera, phone propped on the nightstand'
	];

	const examples = $derived(mode === 'simple' ? EXAMPLES_SIMPLE : EXAMPLES);

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
		return item;
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
	const simpleRun = $derived(/-direct@/.test(renderWs));

	/** The slug this run is filed under, the same one the history sidebar shows.
	 *  Derived rather than stored: the planning workspace is `<slug>@v` and the
	 *  render one `<slug>-shoot@v` or `<slug>-direct@v`, so the ids already carry
	 *  it and cannot disagree with a copy. */
	const runSlug = $derived(
		planningWs
			? planningWs.split('@')[0]
			: renderWs
				? renderWs.split('@')[0].replace(/-(shoot|direct)$/, '')
				: ''
	);

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
	};
	let history = $state<Production[]>([]);
	let sidebarOpen = $state(false);

	async function loadHistory() {
		try {
			const r = await fetch('/studio/api/history');
			if (!r.ok) return;
			history = ((await r.json()) as { productions: Production[] }).productions;
		} catch {
			/* the list is a convenience; never let it break the studio */
		}
	}

	/** Reopening writes the resume payload and reloads.
	 *
	 *  Deliberately not a soft in-place swap: restoring a run means rebuilding
	 *  the transcript, the poller, the document phases and the revision chain
	 *  from scratch, and there is already one tested path that does all of that —
	 *  the one that runs on load. Reusing it is worth the reload. */
	function reopen(p: Production) {
		try {
			// The run's own conversation, if it was saved: what you typed, the
			// prompt or the plan you approved, the documents, the clips. Pointing
			// at it is the whole of reopening.
			if (localStorage.getItem(runKey(p.slug))) {
				localStorage.setItem(POINTER_KEY, p.slug);
				location.href = '/studio';
				return;
			}
			// Older runs, saved before conversations were kept. All that can be
			// rebuilt is the identity — enough to poll the workspace and show what
			// is in it, not enough to show how it got there.
			localStorage.removeItem(POINTER_KEY);
			localStorage.setItem(
				RESUME_KEY,
				JSON.stringify({
					brief: {
						slug: p.slug,
						title: p.title,
						story: p.pitch ?? '',
						style: '',
						sceneCount: p.sceneCount,
						seed: 0
					},
					launchedBrief: {
						slug: p.slug,
						title: p.title,
						story: p.pitch ?? '',
						style: '',
						sceneCount: p.sceneCount,
						seed: 0
					},
					planningWs: p.planningWs ?? '',
					renderWs: p.renderWs ?? '',
					assemblySent: false,
					startedAt: p.startedAt,
					// A simple run never had a brief. Handing one back draws the
					// advanced plan card over a run that has no plan, with a start
					// button that would open a second workspace.
					...(/-direct@/.test(p.renderWs ?? '') ? { brief: null, launchedBrief: null } : {})
				})
			);
		} catch {
			/* private mode — fall through to a plain reload, which starts fresh */
		}
		location.href = '/studio';
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

	function firstFileOfKind(a: Artifact, kind: 'text' | 'video'): string {
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
		if (mode === 'simple') return 'Describe the shot — one clip per message';
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
	$effect(() => {
		if (!sending) {
			sendingFor = 0;
			return;
		}
		sendingSince = Date.now();
		const id = setInterval(() => {
			sendingFor = Math.round((Date.now() - sendingSince) / 1000);
		}, 1000);
		return () => clearInterval(id);
	});

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

	const showExamples = $derived(!brief && !sending && !chat.some((c) => c.who === 'user'));

	const composerPlaceholder = $derived.by(() => {
		if (mode === 'simple')
			return 'a blonde woman on her knees sucking a black man, filmed close on her mouth';
		if (!brief) return 'a late-night confession from someone who knows exactly what they want';
		if (!planningWs) return 'make it more suggestive, keep the same character';
		return 'a question or request for the crew';
	});

	async function submit() {
		const text = input.trim();
		if (!text || sending) return;
		input = '';
		shrink(composer);
		pushItem({ who: 'user', kind: 'text', text });
		sending = true;
		try {
			// Simple mode never plans. Every message is a scene to render, and the
			// answer is the prompt itself — offered for reading and editing before
			// it costs anything.
			if (mode === 'simple') await shotFromRequest(text);
			else if (!brief) await planFromIdea(text);
			else if (!planningWs) await refinePlan(text);
			else await managerChat(text);
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
		pin?: { seconds?: number; orientation?: 'portrait' | 'landscape' }
	): Promise<ChatItem['shot'] | null> {
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
		const r = (await res.json()) as { ok: boolean; shot?: ChatItem['shot']; error?: string };
		// Snapshot the writer's own choice the moment it arrives. Everything after
		// this can be edited on the card; this copy is what the edit is measured
		// against, so it is taken before anyone can touch it.
		if (r.shot) r.shot.wroteLoras = (r.shot.loras ?? []).map((p) => ({ ...p }));
		if (!r.ok || !r.shot) {
			pushError(r.error || 'The prompt could not be written.');
			return null;
		}
		return r.shot;
	}

	/** What the user typed, kept so a rewrite asks for the same scene again rather
	 *  than editing the prompt the model last produced. */
	let lastRequest = $state('');

	async function shotFromRequest(request: string) {
		const shot = await callShotPrompt(request);
		if (!shot) return;
		lastRequest = request;
		pushItem({ who: 'studio', kind: 'shot', shot });
	}

	/** Rewrite the card in place. The old one collapses rather than disappearing:
	 *  a prompt that was nearly right is worth being able to look back at. */
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
			pushItem({ who: 'studio', kind: 'shot', shot });
		} finally {
			shotBusy[itemId] = false;
		}
	}

	/** Send the card's prompt — the edited text, whatever is in the box now — to
	 *  the renderer. The clip comes back through the same poll, cache and player
	 *  the planning chain uses; only the road to the GPU is shorter. */
	async function renderShot(itemId: string) {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.shot || item.shot.launched || shotBusy[itemId]) return;
		const spec = {
			slug: `direct-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
			title: lastRequest.slice(0, 60) || 'Direct render',
			prompts: [item.shot.prompt],
			seconds: item.shot.seconds,
			// The detailer was trained at 1024 and 480 across cannot hold what it
			// encodes: pores, fine hair and uneven tone are high-frequency detail
			// with nowhere to sit at that width, which is most of why the clips
			// read as almost-real. Both frames go up a step, staying divisible by
			// 32 as the workflow requires.
			width: item.shot.orientation === 'portrait' ? 576 : 1024,
			height: item.shot.orientation === 'portrait' ? 1024 : 576,
			// Random again: both tunings it was pinned for are settled. While it was
			// fixed it did its job — three runs came back as the same room, the same
			// woman and the same pose, so the step count and the adapter strength
			// were the only things being compared. If another setting needs the same
			// treatment, pinning it is this one line.
			seed: Math.floor(Math.random() * 1_000_000_000),
			loras: item.shot.loras ?? [],
			wroteLoras: item.shot.wroteLoras ?? item.shot.loras ?? [],
			request: lastRequest
		};
		shotBusy[itemId] = true;
		try {
			const res = await fetch('/studio/api/launch', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ stage: 'direct', direct: spec })
			});
			const r = (await res.json()) as { ok?: boolean; error?: string; workspaceId?: string };
			if (!r.ok || !r.workspaceId) {
				pushError(r.error || 'The render could not start.');
				return;
			}
			item.shot.launched = true;
			renderWs = r.workspaceId;
			startedAt = Date.now();
			// The render poll narrates a shoot it announces first; there is no
			// shoot here, only this clip, so the announcement is already spent.
			shootsAnnounced = true;
			pushStudio(`Rendering ${item.shot.seconds}s, ${item.shot.orientation}.`);
			persist();
			startPolling();
		} catch (e) {
			pushError(`The render could not start: ${e}`);
		} finally {
			shotBusy[itemId] = false;
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
			superseded[itemId] = true;
			pushItem({ who: 'studio', kind: 'shot', shot: { ...shot, ...pin } });
		} finally {
			shotBusy[itemId] = false;
		}
	}

	function setShotSeconds(itemId: string, seconds: number) {
		const item = chat.find((c) => c.id === itemId);
		if (!item?.shot || item.shot.seconds === seconds) return;
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
			if (r.offline) {
				pushError(OFFLINE_TEXT);
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

	function stopPolling() {
		if (timer) clearTimeout(timer);
		timer = null;
		runId += 1;
		pollingActive = false;
	}

	function startPolling() {
		stopPolling();
		quiet = 0;
		lastSig = '';
		sawAllDone = false;
		pollingActive = true;
		tick(runId);
	}

	async function tick(id: number) {
		// The target is captured up front: a launch mid-tick retargets the loop
		// through startPolling (which bumps runId), so a stale tick simply exits.
		const target = activeWs;
		if (!target || id !== runId) return;

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
			if (r.offline) {
				offline = true;
				quiet += 1;
				if (!offlineNoted) {
					offlineNoted = true;
					pushError(OFFLINE_TEXT);
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
			let finished = false;
			if (renderWs) {
				const anyDead = ts.some((t) => DEAD.includes(t.status));
				// Rendering ends when the final film was posted, or when a shoot
				// failed permanently and no assembly will be requested.
				finished = terminal && (finalPosted || (anyDead && !assemblySent));
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
						}).catch(() => {});
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
				pushError(`A shooting step stalled: ${t.title || t.key}.`);
			}
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
					key: a.key,
					title: isFinal ? 'A film' : a.name || name,
					taskId: '',
					files: [{ name, url: fileUrl(renderWs, a.id, name) }]
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
			status: finalPosted
				? 'done'
				: asm
					? mapStatus(asm.status)
					: assemblySent
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
			finalByNameOnly
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
		if (!brief || !(planningWs || renderWs)) return;
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
		forget();
		chat = [];
		superseded = {};
		brief = null;
		originalPitch = '';
		launchedBrief = null;
		latestPlanId = '';
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

	function useExample(text: string) {
		input = text;
		composer?.focus();
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

	onMount(() => {
		// Staged references survive a reload — they live on the server, not in
		// this tab — so the composer has to ask for them rather than assume none.
		void loadRefFiles();
		void loadHistory();

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

		let resumed = false;
		try {
			const pointer = localStorage.getItem(POINTER_KEY);
			const raw =
				(pointer && localStorage.getItem(runKey(pointer))) ??
				localStorage.getItem(RESUME_KEY) ??
				sessionStorage.getItem(RESUME_KEY);
			if (raw) {
				const s = JSON.parse(raw) as Partial<ReturnType<typeof snapshot>>;
				// A workspace to poll is the whole requirement. Requiring a brief on
				// top of it meant a simple run could not be resumed at all — there is
				// no plan in one, only a prompt — and a reload mid-render left the
				// clip finishing on the harness with nothing watching for it.
				if (s.planningWs || s.renderWs) {
					resumed = true;
					brief = s.brief ?? null;
					launchedBrief = s.launchedBrief ?? s.brief ?? null;
					sceneCount = s.brief?.sceneCount ?? sceneCount;
					planningWs = s.planningWs ?? '';
					renderWs = s.renderWs ?? '';
					// The mode follows the run you opened. Landing in a simple run with
					// the advanced composer under it is the same mismatch as the rail:
					// the page describing one mode while showing the other.
					if (/-direct@/.test(renderWs)) mode = 'simple';
					else if (s.planningWs) mode = 'advanced';
					assemblySent = s.assemblySent ?? false;
					startedAt = s.startedAt || Date.now();
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
					} else if (brief) {
						const item = pushItem({ who: 'studio', kind: 'plan', plan: brief });
						latestPlanId = item.id;
					}
					startPolling();
				}
			}
		} catch {
			/* nothing to resume */
		}
		if (!resumed) showWelcome();

		// Elapsed time is shown in whole minutes, so a 15s clock is plenty.
		const clock = setInterval(() => (now = Date.now()), 15_000);
		return () => {
			clearInterval(clock);
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
			{status === 'running' ? 'bg-[var(--st-accent)] font-semibold text-white' : ''}
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

{#snippet videoCard(name: string, url: string, caption: string)}
	<figure class="mt-3 overflow-hidden rounded-2xl bg-[var(--st-surface)]">
		<!-- The app-wide CSS in layout.css hides every native media control on
		     <video> unless the element opts in with .video-with-controls. -->
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			src={url}
			controls
			playsinline
			preload="metadata"
			onerror={(e) => recoverVideo(e.currentTarget as HTMLVideoElement, url)}
			class="video-with-controls block aspect-video w-full bg-black"
		></video>
		<figcaption class="px-4 py-3 text-sm text-[var(--st-muted)]">{caption || name}</figcaption>
	</figure>
{/snippet}

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
			onclick={() => (sidebarOpen = false)}
		></button>
	{/if}

	<aside
		class="fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-[var(--st-surface-2)] bg-[var(--st-bg)] transition-transform lg:static lg:z-auto lg:translate-x-0 {sidebarOpen
			? 'translate-x-0'
			: '-translate-x-full'}"
	>
		<div class="px-3 pt-4 pb-2">
			<button
				type="button"
				onclick={() => {
					reset();
					sidebarOpen = false;
				}}
				class="flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--st-surface)]"
			>
				<svg viewBox="0 0 16 16" class="size-4 shrink-0 text-[var(--st-muted)]" fill="none" aria-hidden="true">
					<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
				</svg>
				<span class="font-display font-semibold">New production</span>
			</button>
		</div>

		<nav class="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
			{#if history.length}
				<p class="px-3 pt-3 pb-1.5 text-[10px] font-bold tracking-[0.2em] text-[var(--st-faint)] uppercase">
					recent
				</p>
				{#each history as p (p.slug)}
					{@const current = brief?.slug === p.slug}
					<div class="group relative">
						<button
							type="button"
							onclick={() => reopen(p)}
							class="w-full cursor-pointer rounded-xl px-3 py-2 pr-8 text-left transition-colors {current
								? 'bg-[var(--st-surface)]'
								: 'hover:bg-[var(--st-surface)]'}"
						>
							<span class="block truncate text-[13px] text-[var(--st-text)]">{p.title}</span>
							<span class="mt-0.5 block text-[11px] text-[var(--st-faint)]">
								{whenLabel(p.updatedAt)} · {p.sceneCount} scenes{p.renderWs ? ' · shot' : ''}
							</span>
						</button>
						<button
							type="button"
							aria-label="remove {p.title} from the list"
							onclick={(e) => dropFromHistory(p, e)}
							class="absolute top-2 right-1.5 cursor-pointer rounded-lg px-1.5 py-1 text-xs text-[var(--st-faint)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--st-text)] focus:opacity-100"
						>
							×
						</button>
					</div>
				{/each}
			{:else}
				<p class="px-3 pt-4 text-xs leading-relaxed text-[var(--st-faint)]">
					Films you start show up here, so you can come back to one after closing the tab.
				</p>
			{/if}
		</nav>

		<!-- Tuning lives at the bottom because it is a settings surface, not a
		     destination — the same place every app of this shape puts one. -->
		<div class="border-t border-[var(--st-surface-2)] px-3 py-3">
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<a
				href="/studio/admin"
				class="flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-sm text-[var(--st-muted)] transition-colors hover:bg-[var(--st-surface)] hover:text-[var(--st-text)]"
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

	<main class="flex min-w-0 flex-1 flex-col overflow-hidden pt-4 lg:pt-8">
		<div class="mx-auto flex min-h-0 w-full max-w-[66rem] flex-1 flex-col px-5">
			<header class="mb-4 flex shrink-0 items-center gap-3">
				<button
					type="button"
					aria-label="show past productions"
					class="-ml-1.5 cursor-pointer rounded-lg p-1.5 text-[var(--st-muted)] transition-colors hover:text-[var(--st-text)] lg:hidden"
					onclick={() => (sidebarOpen = true)}
				>
					<svg viewBox="0 0 16 16" class="size-5" fill="none" aria-hidden="true">
						<path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
					</svg>
				</button>
				<p class="text-[10px] font-bold tracking-[0.3em] text-[var(--st-faint)] uppercase">
					auteur studio
				</p>
				<!-- Two ways to reach the renderer, and they are different jobs rather
					 than a beginner and an expert door: this one builds a film out of a
					 sentence, the other sends a prompt you already have. -->
				<nav class="ml-auto flex gap-1.5" aria-label="mode">
					{#each [['simple', 'simple'], ['advanced', 'advanced']] as [val, label] (val)}
						<button
							type="button"
							aria-pressed={mode === val}
							class="font-display cursor-pointer rounded-full px-3 py-1 text-xs font-semibold transition-colors {mode ===
							val
								? 'bg-[var(--st-accent)] text-white'
								: 'bg-[var(--st-surface)] text-[var(--st-muted)] hover:text-[var(--st-text)]'}"
							onclick={() => setMode(val as 'simple' | 'advanced')}>{label}</button
						>
					{/each}
				</nav>
			</header>

		<div
			class="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-10"
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
					class="scroller min-h-0 flex-1 space-y-5 overflow-y-auto pr-1 pb-2 {showExamples
						? 'flex flex-col justify-center'
						: ''}"
				>
					{#each chat as item (item.id)}
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
															class="cursor-pointer rounded-full bg-[var(--st-surface-2)] px-3.5 py-2 text-xs font-semibold text-[var(--st-muted)] transition-colors hover:text-[var(--st-text)]"
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
																	class="font-display cursor-pointer rounded-xl bg-[var(--st-accent)] px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-[var(--st-accent-strong)] disabled:cursor-default disabled:opacity-40"
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
											class="font-display cursor-pointer rounded-full bg-[var(--st-accent)] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--st-accent-strong)] disabled:cursor-default disabled:bg-[var(--st-surface-2)] disabled:text-[var(--st-faint)]"
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
									<span class="font-mono text-[11px] text-[var(--st-faint)] tabular-nums">
										{mmss(shootElapsed)}
									</span>
								</div>
								<p class="mb-4 text-xs leading-relaxed text-[var(--st-muted)]">
									Each scene is written into a prompt, then rendered on a GPU. A clip usually
									takes several minutes and there is no output until it is finished — the timer
									is the only thing that moves.
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
						{:else if item.kind === 'error'}
							<div class="enter rounded-2xl bg-[var(--st-surface)] p-4">
								<p class="text-xs font-semibold text-[#f2d7cd]">
									<span class="mr-2 rounded-md bg-[#5c2f24] px-2 py-0.5">error</span>
								</p>
								<p class="doc mt-2 text-sm leading-relaxed text-[var(--st-muted)]">{item.text}</p>
							</div>
						{:else if item.kind === 'shot' && item.shot}
							{@const n = item.shot.prompt.trim() ? item.shot.prompt.trim().split(/\s+/).length : 0}
							{@const picked = item.shot.loras ?? []}
							<article class="enter rounded-2xl bg-[var(--st-surface)] p-5 sm:p-6">
								<div class="mb-3 flex items-baseline justify-between gap-4">
									<h3 class="font-display text-base font-semibold">The prompt</h3>
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
									 shipped briefs describing a face instead of a scene. -->
								<label class="sr-only" for="shot-{item.id}">Render prompt</label>
								<textarea
									id="shot-{item.id}"
									bind:value={item.shot.prompt}
									rows="10"
									spellcheck="false"
									readonly={item.shot.launched}
									class="block w-full resize-y rounded-xl bg-[var(--st-bg)] p-3 font-mono text-[13px] leading-relaxed text-[var(--st-text)] outline-none read-only:text-[var(--st-muted)]"
								></textarea>

								{#if item.shot.why}
									<p class="mt-2.5 text-xs text-[var(--st-faint)]">{item.shot.why}</p>
								{/if}

								<!-- What this clip renders with. The writer picks; you overrule it
									 here, before the GPU rather than after. Two more adapters load on
									 every clip regardless and are not listed — they are not choices.
									 The cap is two: four at once produced a clip whose anatomy fell
									 apart exactly where two adapters overlapped. -->
								<div class="mt-4 border-t border-[var(--st-line)] pt-3.5">
									<div class="mb-2 flex items-baseline gap-2">
										<span class="text-xs text-[var(--st-faint)]">adapters</span>
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
														? 'bg-[var(--st-accent)] font-semibold text-white'
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
														? 'bg-[var(--st-accent)] font-semibold text-white'
														: 'text-[var(--st-muted)] hover:text-[var(--st-text)]'}"
													onclick={() => setShotSeconds(item.id, sec)}>{sec}</button
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
														? 'bg-[var(--st-accent)] font-semibold text-white'
														: 'text-[var(--st-muted)] hover:text-[var(--st-text)]'}"
													onclick={() =>
														setShotOrientation(item.id, val as 'portrait' | 'landscape')}
													>{label}</button
												>
											{/each}
										</div>
									</div>

									<div class="mt-5 flex flex-wrap items-center gap-2.5">
										<button
											type="button"
											disabled={shotBusy[item.id]}
											class="font-display cursor-pointer rounded-full bg-[var(--st-accent)] px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[var(--st-accent-strong)] disabled:opacity-40"
											onclick={() => renderShot(item.id)}
										>
											{shotBusy[item.id] ? 'starting…' : 'render this'}
										</button>
										<button
											type="button"
											disabled={shotBusy[item.id]}
											class="cursor-pointer rounded-full px-3 py-2 text-sm text-[var(--st-faint)] transition-colors hover:text-[var(--st-text)] disabled:opacity-40"
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
											class="cursor-pointer rounded-full bg-[var(--st-accent)] px-5 py-2.5 font-display text-xs font-semibold text-white transition-colors hover:bg-[var(--st-accent-strong)]"
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
												class="cursor-pointer rounded-full bg-[var(--st-accent)] px-6 py-2.5 font-display text-sm font-semibold text-white transition-colors hover:bg-[var(--st-accent-strong)] disabled:cursor-default disabled:opacity-50"
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
													class="cursor-pointer rounded-full bg-[var(--st-surface-2)] px-4 py-2 text-xs font-semibold text-[var(--st-text)] transition-colors hover:bg-[var(--st-line)]"
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
														class="cursor-pointer rounded-xl bg-[var(--st-accent)] px-4 py-2.5 font-display text-xs font-semibold text-white transition-colors hover:bg-[var(--st-accent-strong)] disabled:cursor-default disabled:opacity-40"
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
						{:else if item.kind === 'clips' && item.artifact}
							<div class="enter">
								{#each item.artifact.files as f (f.name)}
									{@render videoCard(f.name, f.url, item.text ?? item.artifact.title)}
								{/each}
							</div>
						{/if}
					{/each}

					{#if sending}
						<!-- A word alone reads as frozen once it has been on screen for
							 ten seconds. The counter is the proof that something is still
							 happening, and it makes a stall visible as a stall. -->
						<p class="flex items-center gap-2.5 text-xs text-[var(--st-faint)]">
							<span class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-accent)]"></span>
							<span>{mode === 'simple' ? 'writing the prompt' : brief && planningWs ? 'the crew is replying' : 'planning'}</span>
							{#if sendingFor > 1}
								<span class="tabular-nums">{sendingFor}s</span>
							{/if}
						</p>
					{/if}

					{#if showExamples}
						<div class="flex flex-wrap gap-2 pt-1">
							{#each examples as ex (ex)}
								<button
									type="button"
									class="cursor-pointer rounded-full bg-[var(--st-surface)] px-3.5 py-2 text-left text-xs text-[var(--st-muted)] transition-colors hover:bg-[var(--st-surface-2)] hover:text-[var(--st-text)]"
									onclick={() => useExample(ex)}
								>
									{ex}
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
						<p class="mb-2 flex items-center gap-2.5 px-2 text-xs text-[var(--st-muted)]">
							<span class="beacon size-1.5 shrink-0 rounded-full bg-[var(--st-accent)]"></span>
							<span class="tabular-nums">{elapsedLabel(now - startedAt)}</span>
							{#if railRunning}
								<span class="text-[var(--st-faint)]">·</span>
								<span class="min-w-0 truncate">{railRunning.label}</span>
							{/if}
						</p>
					{/if}
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
						<p class="mb-2 px-2 text-xs text-[var(--st-muted)]">{refError}</p>
					{/if}
					<p class="mb-1.5 px-2 text-xs text-[var(--st-faint)]">{composerHint}</p>
					<div
						class="rounded-3xl bg-[var(--st-surface)] p-3"
					>
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
							class="block max-h-56 w-full resize-none border-0 bg-transparent px-3 py-2 text-[1.05rem] leading-relaxed outline-none focus:ring-0 placeholder:text-[var(--st-faint)]"
						></textarea>

						<div class="flex items-center justify-between gap-3 px-2 pt-1 pb-1">
							{#if !planningWs}
								<div class="flex items-center gap-1.5">
									<label
										title="Attach a face, a room, a movement for the render to copy"
										class="mr-1 flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-[var(--st-faint)] transition-colors hover:text-[var(--st-text)]"
									>
										<svg viewBox="0 0 20 20" class="h-4 w-4" fill="none" aria-hidden="true">
											<path
												d="M13 7l-5.5 5.5a2.1 2.1 0 003 3L16 10a3.5 3.5 0 00-5-5l-5.5 5.5a5 5 0 007 7L18 12"
												stroke="currentColor"
												stroke-width="1.6"
												stroke-linecap="round"
												stroke-linejoin="round"
											/>
										</svg>
										<span class="sr-only">attach reference files</span>
										<input
											type="file"
											multiple
											accept="image/*,video/*"
											class="hidden"
											disabled={refBusy}
											onchange={(e) => {
												attachRefs((e.currentTarget as HTMLInputElement).files);
												(e.currentTarget as HTMLInputElement).value = '';
											}}
										/>
									</label>
									<!-- Scene count is the planning chain's knob: it decides how many
										 documents get written and how many clips get scheduled. Simple
										 mode renders the one shot on the card. -->
									{#if mode === 'advanced'}
									<span class="mr-1 text-xs text-[var(--st-faint)]">scenes</span>
									{#each SCENE_CHOICES as n (n)}
										<button
											type="button"
											aria-pressed={sceneCount === n}
											class="h-7 w-7 cursor-pointer rounded-full text-xs transition-colors {sceneCount ===
											n
												? 'bg-[var(--st-surface-2)] font-semibold text-[var(--st-text)]'
												: 'text-[var(--st-faint)] hover:text-[var(--st-muted)]'}"
											onclick={() => {
												sceneCount = n;
												if (brief) brief.sceneCount = n;
											}}
										>
											{n}
										</button>
									{/each}
									{/if}
								</div>
							{:else}
								<span></span>
							{/if}

							<button
								type="button"
								aria-label="send"
								disabled={sending || !input.trim()}
								onclick={submit}
								class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[var(--st-accent)] text-white transition-colors hover:bg-[var(--st-accent-strong)] disabled:cursor-default disabled:bg-[var(--st-surface-2)] disabled:text-[var(--st-faint)]"
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
											class="font-display cursor-pointer rounded-full bg-[var(--st-surface-2)] px-4 py-2 text-xs font-semibold text-[var(--st-text)] transition-colors hover:bg-[var(--st-accent)] hover:text-white disabled:cursor-default disabled:opacity-50"
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
</div>

<style>
	/* The one moving thing on the page, and it earns it: during a render nothing
	   else changes for minutes, so stillness would read as a hang. Anyone who has
	   asked the system to stop animating gets a static ring instead — the state
	   is already carried by the shape and the word beside it. */
	.spin {
		animation: st-spin 0.9s linear infinite;
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
		--st-surface-2: #1e1e1e;
		--st-line: var(--color-border);
		--st-text: var(--color-text);
		--st-muted: var(--color-muted);
		--st-faint: #565656;
		--st-accent: var(--color-coral);
		--st-accent-strong: var(--color-coral-dark);
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
