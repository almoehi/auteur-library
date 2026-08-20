<script lang="ts">
	/** Tuning panel for the studio's prompts and model assignments.
	 *
	 *  Every entry states what it moves and which model executes it, because the
	 *  question a person actually has in front of a wall of prompts is "which one
	 *  of these changes what I am looking at". Order is by leverage, not by
	 *  pipeline position: the prompt writer decides what the video looks like, so
	 *  it sits first.
	 *
	 *  Changes apply to the NEXT production. A running one composed its YAML at
	 *  launch and cannot be edited — that is the harness's rule, not ours.
	 */
	import { onMount } from 'svelte';

	type Item = {
		id: string;
		label: string;
		affects: string;
		agent: string | null;
		runBy: string | null;
		model: string;
		defaultModel: string;
		risky: boolean;
		fallback: string;
		override: string | null;
	};
	type Payload = {
		path: string;
		updatedAt: string | null;
		models: { id: string; note: string }[];
		defaultModels: Record<string, string>;
		items: Item[];
	};

	let data = $state<Payload | null>(null);
	let text = $state<Record<string, string>>({});
	let models = $state<Record<string, string>>({});
	let open = $state<Record<string, boolean>>({});
	let saving = $state(false);
	let saved = $state('');
	let err = $state('');

	/** Seeded from the server payload inside an effect, not at init: the fetch
	 *  resolves after mount, and a plain assignment would freeze the boxes empty. */
	$effect(() => {
		const d = data;
		if (!d) return;
		const t: Record<string, string> = {};
		const m: Record<string, string> = {};
		for (const it of d.items) {
			t[it.id] = it.override ?? it.fallback;
			if (it.agent) m[it.agent] = it.model;
		}
		text = t;
		models = m;
	});

	const dirty = $derived.by(() => {
		const d = data;
		if (!d) return false;
		for (const it of d.items) {
			if ((text[it.id] ?? '') !== (it.override ?? it.fallback)) return true;
			if (it.agent && models[it.agent] !== it.model) return true;
		}
		return false;
	});

	function isStock(it: Item): boolean {
		const sameText = (text[it.id] ?? '').trim() === it.fallback.trim();
		const sameModel = !it.agent || models[it.agent] === it.defaultModel;
		return sameText && sameModel;
	}

	async function load() {
		err = '';
		try {
			const res = await fetch('/studio/api/tuning');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			data = (await res.json()) as Payload;
		} catch (e) {
			err = `Could not load the registry: ${e}`;
		}
	}

	async function save() {
		if (!data || saving) return;
		saving = true;
		err = '';
		saved = '';
		try {
			// Only send what differs from stock. Sending everything would write the
			// shipped defaults into the overrides file, and a later change to a
			// default would then be silently ignored.
			const prompts: Record<string, string> = {};
			for (const it of data.items) {
				const v = (text[it.id] ?? '').trim();
				if (v && v !== it.fallback.trim()) prompts[it.id] = text[it.id];
			}
			const res = await fetch('/studio/api/tuning', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ prompts, models })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			saved = 'Saved — applies to the next production.';
			await load();
		} catch (e) {
			err = `Save failed: ${e}`;
		} finally {
			saving = false;
		}
	}

	function resetOne(it: Item) {
		text[it.id] = it.fallback;
		if (it.agent) models[it.agent] = it.defaultModel;
	}

	function lines(s: string): number {
		return Math.min(30, Math.max(6, s.split('\n').length + 1));
	}

	onMount(load);
</script>

<svelte:head><title>tuning · auteur</title></svelte:head>

<h1 class="font-display mb-2 text-xl font-semibold">Prompts and models</h1>

		<p class="mb-8 text-sm leading-relaxed text-[var(--st-muted)]">
			These are the fixed instructions the crew works from. Changes apply to the next
			production — a running one composed its workspace at launch and cannot be edited.
			Clearing a box restores the shipped default.
		</p>

		{#if err}
			<p class="mb-6 rounded-xl bg-[var(--st-surface-2)] px-4 py-3 text-sm">{err}</p>
		{/if}

		{#if !data}
			<p class="text-sm text-[var(--st-faint)]">loading…</p>
		{:else}
			<div class="space-y-3">
				{#each data.items as it (it.id)}
					<section class="rounded-2xl bg-[var(--st-surface)] p-5">
						<button
							type="button"
							class="flex w-full cursor-pointer items-start justify-between gap-4 text-left"
							onclick={() => (open[it.id] = !open[it.id])}
						>
							<span class="min-w-0">
								<span class="font-display flex items-center gap-2 text-sm font-semibold">
									{it.label}
									{#if !isStock(it)}
										<span
											class="rounded-md bg-[var(--st-accent)] px-1.5 py-0.5 text-[10px] font-semibold text-white"
										>
											changed
										</span>
									{/if}
									{#if it.risky}
										<span class="text-[10px] text-[var(--st-faint)]">— can break the pipeline</span>
									{/if}
								</span>
								<span class="mt-1 block text-xs leading-relaxed text-[var(--st-muted)]">
									{it.affects}
								</span>
							</span>
							<span class="shrink-0 font-mono text-[11px] text-[var(--st-faint)]">
								{open[it.id] ? 'close' : 'edit'}
							</span>
						</button>

						{#if open[it.id]}
							<div class="mt-4 space-y-3">
								{#if it.agent}
									<div class="flex flex-wrap items-center gap-2">
										<span class="font-mono text-[11px] text-[var(--st-faint)]">model</span>
										{#each data.models as m (m.id)}
											<button
												type="button"
												class="cursor-pointer rounded-full px-3 py-1.5 font-mono text-[11px] transition-colors {models[
													it.agent
												] === m.id
													? 'bg-[var(--st-accent)] text-white'
													: 'bg-[var(--st-surface-2)] text-[var(--st-muted)] hover:text-[var(--st-text)]'}"
												onclick={() => (models[it.agent!] = m.id)}
												title={m.note}
											>
												{m.id}
											</button>
										{/each}
									</div>
								{:else}
									<p class="font-mono text-[11px] text-[var(--st-faint)]">
										run by the {it.runBy} agent on {it.model} — change the model in that
										agent's own entry below
									</p>
								{/if}

								<textarea
									bind:value={text[it.id]}
									rows={lines(text[it.id] ?? '')}
									spellcheck="false"
									class="block w-full resize-y rounded-xl border-0 bg-[var(--st-bg)] px-3.5 py-3 font-mono text-[12px] leading-relaxed outline-none"
								></textarea>

								<div class="flex items-center gap-4">
									<button
										type="button"
										class="cursor-pointer text-xs text-[var(--st-faint)] underline-offset-4 hover:text-[var(--st-text)] hover:underline"
										onclick={() => resetOne(it)}
									>
										restore default
									</button>
									<span class="font-mono text-[11px] text-[var(--st-faint)]">
										{(text[it.id] ?? '').length} chars
									</span>
								</div>
							</div>
						{/if}
					</section>
				{/each}
			</div>

			<div
				class="sticky bottom-0 mt-6 flex flex-wrap items-center gap-4 bg-[var(--st-bg)] py-4"
			>
				<button
					type="button"
					disabled={!dirty || saving}
					onclick={save}
					class="font-display cursor-pointer rounded-full bg-[var(--st-accent)] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--st-accent-strong)] disabled:cursor-default disabled:opacity-40"
				>
					{saving ? 'saving…' : 'save'}
				</button>
				{#if saved}<span class="text-xs text-[var(--st-muted)]">{saved}</span>{/if}
				{#if data.updatedAt}
					<span class="font-mono text-[11px] text-[var(--st-faint)]">
						last change {new Date(data.updatedAt).toLocaleString('en-GB')}
					</span>
				{/if}
			</div>

			<p class="mt-6 font-mono text-[11px] break-all text-[var(--st-faint)]">
				{data.path}
			</p>
		{/if}
