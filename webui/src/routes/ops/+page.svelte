<script lang="ts">
	/** Dashboard for a locally running auteur harness (see ~/auteur).
	 *
	 *  The harness ships a terminal UI, which cannot display an image or play a
	 *  clip — for a video production tool that is the one thing you actually want
	 *  to look at. This surface exists mainly so rendered artifacts render, with
	 *  the task list, failure reasons and the manager chat alongside them.
	 *
	 *  Everything goes through /api/harness, which 404s outside dev.
	 */
	import { onMount } from 'svelte';

	type Task = {
		id: string;
		key: string;
		title: string;
		status: string;
		agent: string | null;
		origin: string | null;
	};
	/** The harness sends a bare filename per file (`["screenplay.md"]`). Object
	 *  entries are tolerated too, in case a richer shape shows up later. */
	type ArtifactFile = string | Record<string, unknown>;
	type Artifact = {
		id: string;
		key: string;
		name: string;
		description: string;
		status: string;
		files: ArtifactFile[];
	};
	type Workflow = {
		entry: { name: string; workflow_type?: string; model_family?: string };
		state: string;
		// The HITL release split queue_depth into the two numbers it was summing.
		in_flight?: number;
		pending?: number;
	};
	type PollState = {
		workspace?: {
			name?: string;
			version?: string;
			is_open?: boolean;
			context_utilization?: number;
		};
		tasks?: Task[];
		artifacts?: Artifact[];
		workflows?: Workflow[];
	};

	const POLL_MS = 5000;
	// Status vocabularies differ per entity: tasks end on `success`, artifacts on
	// `approved`, and the harness also uses `completed` in places — all three read
	// as done. Failure is `permanently-failed` for tasks, `rejected` for artifacts.
	const DONE = ['success', 'completed', 'approved'];
	const DEAD = ['permanently-failed', 'failed', 'rejected'];

	// The workspace shipped with the harness. Any other id can be typed in — it is
	// `<metadata.name>@<metadata.version>` from the workspace YAML.
	let workspace = $state('demo-workspace@1.0');
	let poll = $state<PollState | null>(null);
	let offline = $state(false);
	let lastError = $state('');
	let lastTick = $state<Date | null>(null);

	// taskId -> failureReason, filled on demand for tasks that ended badly.
	let failures = $state<Record<string, string>>({});
	// `${artifactId}::${fileKey}` -> signed URL, resolved lazily per file.
	let mediaUrls = $state<Record<string, string>>({});

	/** Both lookups above are populated from inside an $effect. Their
	 *  "did I already ask for this?" guards therefore must NOT read the reactive
	 *  maps — doing so makes the effect depend on what it writes and it re-runs
	 *  itself forever. Plain Sets keep the bookkeeping outside the graph. */
	const failureAsked = new Set<string>();
	const mediaAsked = new Set<string>();

	let chatLog = $state<{ who: 'you' | 'agent'; text: string }[]>([]);
	let chatInput = $state('');
	let chatBusy = $state(false);

	let retryFor = $state<string | null>(null);
	let retryNote = $state('');

	async function call(op: string, body: unknown = {}) {
		const res = await fetch('/api/harness', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ workspace, op, body })
		});
		if (!res.ok) throw new Error(`proxy ${res.status}`);
		return (await res.json()) as {
			ok: boolean;
			status?: number;
			offline?: boolean;
			data?: unknown;
		};
	}

	async function tick() {
		try {
			const r = await call('poll-state');
			if (r.offline) {
				offline = true;
				return;
			}
			offline = false;
			if (!r.ok) {
				// A failing workspace (a crashed agent answers 500 forever) must not be
				// drawn as an empty one — "no tasks" reads as "nothing to do" when the
				// truth is "nothing is reachable". Keep the last good state on screen
				// and put the harness's own error above it.
				const d = r.data as { code?: string; error?: string } | string | undefined;
				const detail =
					typeof d === 'string' ? d : `${d?.code ?? r.status} — ${(d?.error ?? '').slice(0, 300)}`;
				lastError = detail;
				return;
			}
			lastError = '';
			poll = r.data as PollState;
			lastTick = new Date();
		} catch (e) {
			lastError = String(e);
		}
	}

	/** Failure text lives behind a separate call, so it is fetched only for tasks
	 *  that actually died — and only once each. */
	async function loadFailure(taskId: string) {
		if (failureAsked.has(taskId)) return;
		failureAsked.add(taskId);
		try {
			const r = await call('get-worker-status', { taskId });
			const d = r.data as { failureReason?: string; attempts?: number } | undefined;
			if (d?.failureReason) {
				failures[taskId] = d.attempts
					? `${d.failureReason} (${d.attempts} attempt${d.attempts > 1 ? 's' : ''})`
					: d.failureReason;
			}
		} catch {
			/* a missing reason is not worth surfacing as an error of its own */
		}
	}

	function fileKeyOf(f: ArtifactFile): string {
		if (typeof f === 'string') return f;
		for (const k of ['key', 'name', 'filename', 'file']) {
			const v = f[k];
			if (typeof v === 'string' && v) return v;
		}
		return '';
	}

	/** Saves a round-trip when an entry already carries a usable URL. */
	function directUrlOf(f: ArtifactFile): string {
		if (typeof f === 'string') return f.startsWith('http') ? f : '';
		for (const k of ['url', 'href', 'signedUrl']) {
			const v = f[k];
			if (typeof v === 'string' && v.startsWith('http')) return v;
		}
		return '';
	}

	async function resolveMedia(artifactId: string, f: ArtifactFile) {
		const key = fileKeyOf(f);
		const cacheKey = `${artifactId}::${key}`;
		if (mediaAsked.has(cacheKey)) return;
		mediaAsked.add(cacheKey);

		const direct = directUrlOf(f);
		if (direct) {
			mediaUrls[cacheKey] = direct;
			return;
		}
		if (!key) return;
		try {
			const r = await call('get-artifact-url', { req: { artifactId, fileKey: key } });
			const d = r.data;
			const url = typeof d === 'string' ? d : (d as { url?: string })?.url;
			if (typeof url === 'string' && url.startsWith('http')) mediaUrls[cacheKey] = url;
		} catch {
			/* leave it unresolved — the card shows the filename without a preview */
		}
	}

	function kindOf(name: string): 'image' | 'video' | 'other' {
		const n = name.toLowerCase();
		if (/\.(png|jpe?g|webp|gif|avif)$/.test(n)) return 'image';
		if (/\.(mp4|webm|mov|m4v)$/.test(n)) return 'video';
		return 'other';
	}

	async function send() {
		const msg = chatInput.trim();
		if (!msg || chatBusy) return;
		chatInput = '';
		chatLog = [...chatLog, { who: 'you', text: msg }];
		chatBusy = true;
		try {
			const r = await call('chat', { msg });
			const d = r.data;
			chatLog = [...chatLog, { who: 'agent', text: typeof d === 'string' ? d : JSON.stringify(d) }];
		} catch (e) {
			chatLog = [...chatLog, { who: 'agent', text: `— error: ${e}` }];
		} finally {
			chatBusy = false;
		}
	}

	async function doRetry(taskId: string) {
		const instructions = retryNote.trim();
		retryFor = null;
		retryNote = '';
		// Clear both, so a second failure re-fetches its reason instead of showing
		// the stale one from the previous attempt.
		delete failures[taskId];
		failureAsked.delete(taskId);
		try {
			await call('reset-task', {
				req: { taskId, ...(instructions ? { instructions } : {}) }
			});
			await tick();
		} catch (e) {
			lastError = String(e);
		}
	}

	function pill(status: string) {
		if (DONE.includes(status)) return 'bg-green text-bg';
		if (status === 'running') return 'bg-blue text-white';
		if (DEAD.includes(status)) return 'bg-coral text-white';
		return 'bg-surface-2 text-muted';
	}

	onMount(() => {
		tick();
		const id = setInterval(tick, POLL_MS);
		return () => clearInterval(id);
	});

	// Pull the reason for anything that died, and a URL for anything renderable,
	// as soon as either shows up in a poll.
	$effect(() => {
		for (const t of poll?.tasks ?? []) if (DEAD.includes(t.status)) loadFailure(t.id);
		for (const a of poll?.artifacts ?? []) for (const f of a.files ?? []) resolveMedia(a.id, f);
	});

	const tasks = $derived(poll?.tasks ?? []);
	const artifacts = $derived(poll?.artifacts ?? []);
	const workflows = $derived(poll?.workflows ?? []);
	const fileCount = $derived(artifacts.reduce((n, a) => n + (a.files?.length ?? 0), 0));
</script>

<svelte:head>
	<title>ops · auteur</title>
</svelte:head>

<main class="min-h-screen pt-24 pb-20">
	<div class="mx-auto max-w-6xl px-5">
		<p class="mb-2 text-[10px] font-bold tracking-[0.3em] text-muted uppercase">operator view</p>
		<div class="mb-6 flex flex-wrap items-end justify-between gap-4">
			<h1 class="font-display text-2xl font-bold tracking-tight">auteur</h1>
			<div class="flex items-center gap-3">
				<label class="text-[10px] font-bold tracking-[0.2em] text-muted uppercase" for="ws">
					workspace
				</label>
				<input
					id="ws"
					bind:value={workspace}
					spellcheck="false"
					class="rounded-lg border border-border bg-surface px-3 py-1.5 font-mono text-sm text-text outline-none focus:border-muted"
				/>
			</div>
		</div>

		{#if offline}
			<div class="mb-6 rounded-xl border border-border bg-surface p-4">
				<p class="font-display text-sm font-semibold">The harness is not responding.</p>
				<p class="mt-1 text-sm text-muted">
					Start the container:
					<code class="font-mono text-text">cd ~/auteur &amp;&amp; ./run.sh</code>
				</p>
			</div>
		{:else if lastError}
			<div class="mb-6 rounded-xl border border-border bg-surface p-4">
				<p class="text-sm text-muted">{lastError}</p>
			</div>
		{/if}

		<div class="grid gap-6 xl:grid-cols-[1fr_380px]">
			<div class="min-w-0 space-y-6">
				<!-- Tasks -->
				<section class="rounded-2xl border border-border bg-surface p-5">
					<div class="mb-4 flex items-baseline justify-between">
						<h2 class="font-display text-sm font-bold tracking-wide">tasks</h2>
						<span class="text-xs text-muted">{tasks.length}</span>
					</div>

					{#if tasks.length === 0}
						<p class="text-sm text-muted">
							No tasks yet — start a production in the studio, or open a workspace
							with the auteur CLI.
						</p>
					{:else}
						<ul class="space-y-2">
							{#each tasks as t (t.id)}
								<li class="rounded-xl bg-surface-2 p-3.5">
									<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
										<span
											class="rounded-md px-2 py-0.5 font-display text-[11px] font-bold {pill(
												t.status
											)}"
										>
											{t.status}
										</span>
										<span class="font-display text-sm font-semibold">{t.title}</span>
										{#if t.agent}
											<span class="font-mono text-xs text-muted">{t.agent}</span>
										{/if}
										{#if DEAD.includes(t.status)}
											<button
												type="button"
												class="ml-auto cursor-pointer rounded-lg bg-coral px-3 py-1 font-display text-xs font-semibold text-white transition-colors hover:bg-coral-dark"
												onclick={() => (retryFor = retryFor === t.id ? null : t.id)}
											>
												retry
											</button>
										{/if}
									</div>

									{#if failures[t.id]}
										<p class="mt-2.5 font-mono text-xs leading-relaxed text-muted">
											{failures[t.id]}
										</p>
									{/if}

									{#if retryFor === t.id}
										<div class="mt-3 flex flex-wrap gap-2">
											<input
												bind:value={retryNote}
												placeholder="extra instruction for the agent (optional)"
												class="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-muted"
											/>
											<button
												type="button"
												class="cursor-pointer rounded-lg bg-green px-4 py-2 font-display text-xs font-semibold text-bg transition-opacity hover:opacity-80"
												onclick={() => doRetry(t.id)}
											>
												run
											</button>
										</div>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
				</section>

				<!-- Artifacts -->
				<section class="rounded-2xl border border-border bg-surface p-5">
					<div class="mb-4 flex items-baseline justify-between">
						<h2 class="font-display text-sm font-bold tracking-wide">artifacts</h2>
						<span class="text-xs text-muted">{fileCount} {fileCount === 1 ? 'file' : 'files'}</span>
					</div>

					{#if artifacts.length === 0}
						<p class="text-sm text-muted">No artifacts yet.</p>
					{:else}
						<div class="grid gap-4 sm:grid-cols-2">
							{#each artifacts as a (a.id)}
								<article class="overflow-hidden rounded-xl bg-surface-2">
									{#each a.files ?? [] as f, i (fileKeyOf(f) || i)}
										{@const name = fileKeyOf(f)}
										{@const url = mediaUrls[`${a.id}::${name}`]}
										{@const kind = kindOf(name)}
										{#if url && kind === 'image'}
											<img src={url} alt={name} class="block w-full bg-bg object-contain" />
										{:else if url && kind === 'video'}
											<!-- svelte-ignore a11y_media_has_caption -->
											<video
												src={url}
												controls
												playsinline
												class="video-with-controls block w-full bg-bg"
											></video>
										{/if}
									{/each}

									<div class="p-3.5">
										<div class="flex items-center gap-2">
											<span
												class="rounded-md px-2 py-0.5 font-display text-[11px] font-bold {pill(
													a.status
												)}"
											>
												{a.status}
											</span>
											<span class="font-display text-sm font-semibold">{a.name}</span>
										</div>
										{#if (a.files?.length ?? 0) > 0}
											<ul class="mt-2 space-y-1">
												{#each a.files as f, i (fileKeyOf(f) || i)}
													{@const name = fileKeyOf(f)}
													{@const url = mediaUrls[`${a.id}::${name}`]}
													<li class="font-mono text-xs text-muted">
														{#if url}
															<a
																href={url}
																target="_blank"
																rel="noreferrer"
																class="hover:text-text"
															>
																{name || 'file'}
															</a>
														{:else}
															{name || 'file'}
														{/if}
													</li>
												{/each}
											</ul>
										{:else}
											<p class="mt-2 text-xs text-muted">{a.description}</p>
										{/if}
									</div>
								</article>
							{/each}
						</div>
					{/if}
				</section>

				<!-- Workflows -->
				{#if workflows.length > 0}
					<section class="rounded-2xl border border-border bg-surface p-5">
						<h2 class="mb-4 font-display text-sm font-bold tracking-wide">workflows</h2>
						<ul class="space-y-2">
							{#each workflows as w (w.entry.name)}
								<li class="flex flex-wrap items-center gap-x-3 gap-y-1">
									<span
										class="rounded-md px-2 py-0.5 font-display text-[11px] font-bold {pill(
											w.state
										)}"
									>
										{w.state}
									</span>
									<span class="font-mono text-sm">{w.entry.name}</span>
									{#if w.entry.workflow_type}
										<span class="text-xs text-muted">{w.entry.workflow_type}</span>
									{/if}
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			</div>

			<!-- Chat -->
			<section
				class="flex h-[520px] flex-col rounded-2xl border border-border bg-surface p-5 xl:sticky xl:top-24"
			>
				<div class="mb-3 flex items-baseline justify-between">
					<h2 class="font-display text-sm font-bold tracking-wide">manager</h2>
					{#if lastTick}
						<span class="text-[10px] text-muted">
							{lastTick.toLocaleTimeString('hu-HU')}
						</span>
					{/if}
				</div>

				<div class="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
					{#if chatLog.length === 0}
						<p class="text-sm leading-relaxed text-muted">
							Ask about the workspace, or give it a task. For example:
							<span class="mt-1 block font-mono text-xs text-text">show me the tasks summary</span>
							<span class="font-mono text-xs text-text"
								>combine all clips into a final video file</span
							>
						</p>
					{/if}
					{#each chatLog as m, i (i)}
						<div class:text-right={m.who === 'you'}>
							<p
								class="inline-block max-w-[90%] rounded-xl px-3 py-2 text-left text-sm leading-relaxed {m.who ===
								'you'
									? 'bg-surface-2 text-text'
									: 'bg-bg text-text'}"
							>
								{m.text}
							</p>
						</div>
					{/each}
					{#if chatBusy}
						<p class="text-xs text-muted">gondolkodik…</p>
					{/if}
				</div>

				<form
					class="mt-3 flex gap-2"
					onsubmit={(e) => {
						e.preventDefault();
						send();
					}}
				>
					<input
						bind:value={chatInput}
						placeholder="message the manager"
						class="min-w-0 flex-1 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text outline-none placeholder:text-muted focus:border-muted"
					/>
					<button
						type="submit"
						disabled={chatBusy || !chatInput.trim()}
						class="cursor-pointer rounded-lg bg-coral px-4 py-2 font-display text-xs font-semibold text-white transition-colors hover:bg-coral-dark disabled:cursor-default disabled:opacity-40"
					>
						send
					</button>
				</form>
			</section>
		</div>
	</div>
</main>
