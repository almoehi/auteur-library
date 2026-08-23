<script lang="ts">
	/** Direct mode — your prompt, the GPU, nothing in between.
	 *
	 *  The planning chain turns one sentence into a film. This page exists for
	 *  when you already know the shot: no screenwriter, no scene list, no art
	 *  direction, no prompt writer. What is in the box is what the renderer
	 *  receives, character for character.
	 *
	 *  The word counter is the one piece of guidance on the page, and it is here
	 *  because the chain's own failure was length: it handed the renderer 1125
	 *  words against a documented 350-500, front-loaded with appearance
	 *  description, and got back a portrait of the person it had described
	 *  instead of the scene.
	 */
	import { onMount } from 'svelte';

	type Clip = { key: string; url: string; title: string };

	const MAX_CLIPS = 4;
	/** The model's own prompt guide. Past this the front of the prompt is what
	 *  survives, and the front is rarely the part that matters. */
	const WORDS_IDEAL = 500;

	let prompts = $state<string[]>(['']);
	let seconds = $state(6);
	let portrait = $state(true);
	let title = $state('');

	let running = $state(false);
	let error = $state('');
	let workspace = $state('');
	let tasks = $state<{ key: string; status: string }[]>([]);
	let clips = $state<Clip[]>([]);
	let startedAt = $state(0);
	let now = $state(Date.now());
	let poll: ReturnType<typeof setInterval> | null = null;

	const width = $derived(portrait ? 480 : 720);
	const height = $derived(portrait ? 864 : 480);
	const elapsed = $derived(startedAt ? Math.floor((now - startedAt) / 1000) : 0);
	const ready = $derived(prompts.some((p) => p.trim()) && !running);

	function words(s: string): number {
		const t = s.trim();
		return t ? t.split(/\s+/).length : 0;
	}

	function addClip() {
		if (prompts.length < MAX_CLIPS) prompts = [...prompts, ''];
	}
	function removeClip(i: number) {
		prompts = prompts.filter((_, n) => n !== i);
		if (!prompts.length) prompts = [''];
	}

	/** A fresh id every launch: a workspace can be opened once, and reopening is
	 *  a silent no-op rather than a re-run. */
	function makeSlug(): string {
		const stamp = Date.now().toString(36);
		const rand = Math.random().toString(36).slice(2, 7);
		return `direct-${stamp}-${rand}`;
	}

	async function launch() {
		const list = prompts.map((p) => p.trim()).filter(Boolean);
		if (!list.length) return;
		error = '';
		running = true;
		clips = [];
		tasks = [];
		startedAt = Date.now();

		const spec = {
			slug: makeSlug(),
			title: title.trim() || 'Direct render',
			prompts: list,
			seconds,
			width,
			height,
			seed: Math.floor(Math.random() * 1_000_000_000)
		};

		try {
			const res = await fetch('/studio/api/launch', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ stage: 'direct', direct: spec })
			});
			const data = (await res.json()) as { ok?: boolean; error?: string; workspaceId?: string };
			if (!data.ok) {
				error = data.error || 'the launch failed';
				running = false;
				return;
			}
			workspace = data.workspaceId ?? '';
			startPolling();
		} catch (e) {
			error = String(e);
			running = false;
		}
	}

	function startPolling() {
		stopPolling();
		void tick();
		poll = setInterval(() => void tick(), 6000);
	}
	function stopPolling() {
		if (poll) clearInterval(poll);
		poll = null;
	}

	/** Copy a finished clip to disk while the workspace agent is still answering.
	 *  Playback then resolves against that copy rather than the harness, which
	 *  is what keeps clips watchable after an agent dies. */
	function keepClip(artifact: string, file: string) {
		const q = new URLSearchParams({ workspace, artifact, file, warm: '1' });
		void fetch(`/api/file?${q.toString()}`).catch(() => {});
	}

	async function tick() {
		if (!workspace) return;
		let data: { ok?: boolean; data?: unknown };
		try {
			const res = await fetch('/api/harness', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ workspace, op: 'poll-state', body: {} })
			});
			data = (await res.json()) as { ok?: boolean; data?: unknown };
		} catch {
			return;
		}
		const d = data.data as
			| {
					tasks?: { key?: string; status?: string }[];
					artifacts?: {
						id?: string;
						key?: string;
						status?: string;
						files?: (string | Record<string, string>)[];
					}[];
			  }
			| undefined;
		if (!d) return;

		tasks = (d.tasks ?? []).map((t) => ({ key: t.key ?? '?', status: t.status ?? '?' }));

		const found: Clip[] = [];
		for (const a of d.artifacts ?? []) {
			if (a.status !== 'approved' || !a.id) continue;
			for (const f of a.files ?? []) {
				const name = typeof f === 'string' ? f : (f.name ?? f.key ?? '');
				if (!name || !/\.(mp4|webm|mov|m4v)$/i.test(name)) continue;
				const q = new URLSearchParams({ workspace, artifact: a.id, file: name });
				if (!clips.some((c) => c.key === `${a.id}/${name}`)) keepClip(a.id, name);
				found.push({
					key: `${a.id}/${name}`,
					url: `/api/file?${q.toString()}`,
					title: a.key ?? name
				});
			}
		}
		clips = found;

		const live = tasks.filter((t) => t.status === 'running' || t.status === 'pending');
		if (tasks.length && !live.length) {
			running = false;
			stopPolling();
		}
	}

	/** A <video> that errors never retries on its own, and the first request can
	 *  land before the local copy has finished downloading. */
	const attempts = new WeakMap<HTMLVideoElement, number>();
	function recoverVideo(el: HTMLVideoElement, url: string) {
		const n = attempts.get(el) ?? 0;
		if (n >= 4) return;
		attempts.set(el, n + 1);
		setTimeout(() => {
			el.src = `${url}&retry=${n + 1}`;
			el.load();
		}, 1500 * (n + 1));
	}

	onMount(() => {
		const clock = setInterval(() => (now = Date.now()), 1000);
		return () => {
			clearInterval(clock);
			stopPolling();
		};
	});
</script>

<svelte:head><title>direct · auteur</title></svelte:head>

<main class="studio min-h-screen pt-8 pb-20">
	<div class="mx-auto max-w-[54rem] px-5">
		<header class="mb-7 flex items-center justify-between gap-4">
			<p class="text-[10px] font-bold tracking-[0.3em] text-[var(--st-faint)] uppercase">
				auteur
			</p>
			<nav class="flex gap-1.5" aria-label="mode">
				<span
					aria-current="page"
					class="font-display rounded-full bg-[var(--st-accent)] px-3.5 py-1.5 text-sm font-semibold text-white"
				>
					simple
				</span>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<a
					href="/studio"
					class="font-display rounded-full bg-[var(--st-surface)] px-3.5 py-1.5 text-sm font-semibold text-[var(--st-muted)] transition-colors hover:text-[var(--st-text)]"
				>
					advanced
				</a>
			</nav>
		</header>

		<h1 class="mb-1 text-2xl font-semibold">Your prompt, straight to the renderer</h1>
		<p class="mb-7 text-sm text-[var(--st-muted)]">
			No screenwriter, no scene list, no prompt rewriting. What you type below is what the model
			receives, character for character — one clip per box.
		</p>

		{#each prompts as _, i (i)}
			{@const n = words(prompts[i])}
			<section class="mb-4 rounded-2xl bg-[var(--st-surface)] p-4">
				<div class="mb-2 flex items-baseline justify-between gap-3">
					<span class="text-xs font-semibold tracking-wide text-[var(--st-muted)] uppercase">
						Clip {i + 1}
					</span>
					<span class="flex items-center gap-3 text-xs tabular-nums">
						<span class={n > WORDS_IDEAL ? 'font-semibold text-[#e0a03a]' : 'text-[var(--st-faint)]'}>
							{n} / {WORDS_IDEAL} words
						</span>
						{#if prompts.length > 1}
							<button
								type="button"
								class="cursor-pointer text-[var(--st-faint)] hover:text-[var(--st-text)]"
								onclick={() => removeClip(i)}>remove</button
							>
						{/if}
					</span>
				</div>
				<textarea
					bind:value={prompts[i]}
					rows="8"
					spellcheck="false"
					placeholder="subject_definitions:&#10;&lt;Subject 1&gt; …&#10;&#10;summary:&#10;…&#10;&#10;[Shot 1] …&#10;&#10;overall_soundscape:&#10;…&#10;&#10;non_diegetic_music:&#10;N/A"
					class="block w-full resize-y rounded-xl bg-[var(--st-bg)] p-3 font-mono text-[13px] leading-relaxed text-[var(--st-text)] outline-none placeholder:text-[var(--st-faint)]"
				></textarea>
				{#if n > WORDS_IDEAL}
					<p class="mt-2 text-xs text-[#e0a03a]">
						Past {WORDS_IDEAL} words the model reads the front of the prompt and loses the rest. Put
						the action first, appearance second.
					</p>
				{/if}
			</section>
		{/each}

		{#if prompts.length < MAX_CLIPS}
			<button
				type="button"
				class="mb-6 cursor-pointer rounded-full bg-[var(--st-surface)] px-4 py-2 text-sm text-[var(--st-muted)] transition-colors hover:text-[var(--st-text)]"
				onclick={addClip}>add another clip</button
			>
		{/if}

		<div class="mb-6 flex flex-wrap items-end gap-5 rounded-2xl bg-[var(--st-surface)] p-4">
			<label class="text-xs">
				<span class="mb-1.5 block tracking-wide text-[var(--st-muted)] uppercase">Seconds</span>
				<input
					type="number"
					min="1"
					max="30"
					bind:value={seconds}
					class="w-20 rounded-lg bg-[var(--st-bg)] px-2.5 py-1.5 text-sm tabular-nums text-[var(--st-text)] outline-none"
				/>
			</label>
			<div class="text-xs">
				<span class="mb-1.5 block tracking-wide text-[var(--st-muted)] uppercase">Frame</span>
				<div class="flex gap-1.5">
					<button
						type="button"
						class="cursor-pointer rounded-lg px-3 py-1.5 text-sm {portrait
							? 'bg-[var(--st-accent)] font-semibold text-white'
							: 'bg-[var(--st-bg)] text-[var(--st-muted)]'}"
						onclick={() => (portrait = true)}>480 × 864 portrait</button
					>
					<button
						type="button"
						class="cursor-pointer rounded-lg px-3 py-1.5 text-sm {portrait
							? 'bg-[var(--st-bg)] text-[var(--st-muted)]'
							: 'bg-[var(--st-accent)] font-semibold text-white'}"
						onclick={() => (portrait = false)}>720 × 480 landscape</button
					>
				</div>
			</div>
			<label class="min-w-[12rem] flex-1 text-xs">
				<span class="mb-1.5 block tracking-wide text-[var(--st-muted)] uppercase">
					Name <span class="normal-case">(optional)</span>
				</span>
				<input
					bind:value={title}
					placeholder="Direct render"
					class="w-full rounded-lg bg-[var(--st-bg)] px-2.5 py-1.5 text-sm text-[var(--st-text)] outline-none placeholder:text-[var(--st-faint)]"
				/>
			</label>
		</div>

		<button
			type="button"
			disabled={!ready}
			class="font-display cursor-pointer rounded-full bg-[var(--st-accent)] px-6 py-2.5 font-semibold text-white transition-colors hover:bg-[var(--st-accent-strong)] disabled:cursor-not-allowed disabled:opacity-40"
			onclick={launch}
		>
			{running ? 'rendering…' : `render ${prompts.filter((p) => p.trim()).length} clip${prompts.filter((p) => p.trim()).length === 1 ? '' : 's'}`}
		</button>

		{#if error}
			<p class="mt-5 rounded-xl bg-[#3a201a] px-4 py-3 text-sm text-[#f2d7cd]">{error}</p>
		{/if}

		{#if tasks.length}
			<section class="mt-8">
				<div class="mb-3 flex items-baseline gap-3">
					<h2 class="text-sm font-semibold tracking-wide text-[var(--st-muted)] uppercase">
						Render
					</h2>
					{#if running}
						<span class="text-xs tabular-nums text-[var(--st-faint)]">
							{Math.floor(elapsed / 60)}m {String(elapsed % 60).padStart(2, '0')}s
						</span>
					{/if}
				</div>
				<ul class="mb-6 space-y-1.5">
					{#each tasks as t (t.key)}
						<li class="flex items-center gap-2.5 text-sm">
							<span
								class="size-1.5 shrink-0 rounded-full {t.status === 'success'
									? 'bg-[#5aa469]'
									: t.status === 'running'
										? 'bg-[var(--st-accent)]'
										: 'bg-[var(--st-faint)]'}"
							></span>
							<span class="text-[var(--st-muted)]">{t.key}</span>
							<span class="text-xs text-[var(--st-faint)]">{t.status}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#each clips as c (c.key)}
			<figure class="mt-4 overflow-hidden rounded-2xl bg-[var(--st-surface)]">
				<!-- svelte-ignore a11y_media_has_caption -->
				<video
					src={c.url}
					controls
					playsinline
					preload="metadata"
					onerror={(e) => recoverVideo(e.currentTarget as HTMLVideoElement, c.url)}
					class="video-with-controls block max-h-[70vh] w-full bg-black"
				></video>
				<figcaption class="px-4 py-3 text-sm text-[var(--st-muted)]">{c.title}</figcaption>
			</figure>
		{/each}
	</div>
</main>

<style>
	.studio {
		--st-bg: var(--color-bg);
		--st-surface: var(--color-surface);
		--st-text: var(--color-text);
		--st-muted: var(--color-muted);
		--st-faint: #565656;
		--st-accent: var(--color-coral);
		--st-accent-strong: var(--color-coral-dark);
		background: var(--st-bg);
		color: var(--st-text);
		font-family: var(--font-body);
	}
	.studio :global(h1) {
		font-family: var(--font-display);
	}
</style>
