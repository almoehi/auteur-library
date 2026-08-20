<script lang="ts">
	/** The workflow library.
	 *
	 *  A workflow is a ComfyUI graph the crew can call as a tool. Two of them
	 *  ship with every production; anything here is added on top, loaded into
	 *  each render workspace as it opens.
	 *
	 *  The screen is built around the two things that actually go wrong. A graph
	 *  saved from the wrong ComfyUI menu looks like a valid file and fails much
	 *  later on a GPU, so it is checked here, on arrival. And a workflow whose
	 *  models are not yet on the compute node takes twenty minutes on its first
	 *  render, which reads exactly like a hang unless somebody said so first.
	 */
	import { onMount } from 'svelte';

	type Workflow = {
		name: string;
		description: string;
		hasBundle: boolean;
		lazy: boolean;
		provider: string | null;
		enabled: boolean;
		updatedAt: string;
		bytes: number;
	};

	let items = $state<Workflow[]>([]);
	let libPath = $state('');
	let loading = $state(true);
	let err = $state('');
	let note = $state('');

	// The add form.
	let open = $state(false);
	let name = $state('');
	let graphName = $state('');
	let graph = $state('');
	let bundleName = $state('');
	let bundle = $state('');
	let description = $state('');
	let lazy = $state(false);
	let provider = $state('');
	let saving = $state(false);
	let dragging = $state(false);

	const ready = $derived(name.trim().length >= 3 && graph.length > 0);

	async function load() {
		try {
			const res = await fetch('/studio/api/library');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const d = (await res.json()) as { workflows: Workflow[]; path: string };
			items = d.workflows;
			libPath = d.path;
		} catch (e) {
			err = `Could not read the library: ${e}`;
		} finally {
			loading = false;
		}
	}

	/** Filenames are the only name most graphs come with, so it seeds the field —
	 *  but the harness turns the name into an LLM tool name, so it is folded to
	 *  what that grammar allows rather than rejected after the fact. */
	function slugFromFile(file: string): string {
		return file
			.replace(/\.[^.]+$/, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.replace(/^([0-9])/, 'w$1')
			.slice(0, 48);
	}

	async function takeFiles(files: FileList | null) {
		if (!files?.length) return;
		err = '';
		for (const f of Array.from(files)) {
			const text = await f.text();
			if (f.name.endsWith('.yaml') || f.name.endsWith('.yml')) {
				bundle = text;
				bundleName = f.name;
			} else {
				graph = text;
				graphName = f.name;
				if (!name.trim()) name = slugFromFile(f.name);
			}
		}
	}

	async function save() {
		if (!ready || saving) return;
		saving = true;
		err = '';
		note = '';
		try {
			const res = await fetch('/studio/api/library', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					kind: 'workflow',
					name: name.trim().toLowerCase(),
					jsonContent: graph,
					yamlContent: bundle || undefined,
					description,
					lazy,
					provider: provider || undefined,
					enabled: true
				})
			});
			const d = (await res.json()) as { ok: boolean; error?: string; saved?: string };
			if (!d.ok) {
				err = d.error ?? 'the library refused it';
				return;
			}
			note = `${d.saved} added — the next production will load it.`;
			open = false;
			name = graph = bundle = description = graphName = bundleName = '';
			provider = '';
			lazy = false;
			await load();
		} catch (e) {
			err = `Save failed: ${e}`;
		} finally {
			saving = false;
		}
	}

	async function toggle(w: Workflow) {
		// Read the stored copy back, because the list view deliberately does not
		// carry the graph — flipping a checkbox should not require the browser to
		// hold a two-megabyte JSON it has no use for.
		err = '';
		const res = await fetch('/studio/api/library', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'workflow-toggle', name: w.name, enabled: !w.enabled })
		});
		const d = (await res.json()) as { ok: boolean; error?: string };
		if (!d.ok) err = d.error ?? 'could not change it';
		await load();
	}

	async function remove(w: Workflow) {
		err = '';
		await fetch(`/studio/api/library?kind=workflow&name=${encodeURIComponent(w.name)}`, {
			method: 'DELETE'
		});
		note = `${w.name} removed.`;
		await load();
	}

	function kb(n: number): string {
		return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
	}

	onMount(load);
</script>

<svelte:head><title>workflows · auteur</title></svelte:head>

<h1 class="font-display mb-2 text-xl font-semibold">Workflows</h1>

<p class="mb-5 text-sm leading-relaxed text-[var(--st-muted)]">
	A workflow is a ComfyUI graph the crew can call. Two ship with every production — one
	for stills, one for video. Anything you add here is loaded on top, into each production
	as it starts, and the agents get it as a tool they can choose.
</p>

<div class="mb-7 rounded-2xl bg-[var(--st-surface)] p-5 text-sm leading-relaxed">
	<p class="font-display mb-2 font-semibold">Before you add one</p>
	<ul class="space-y-2 text-[var(--st-muted)]">
		<li>
			Export from ComfyUI with <span class="text-[var(--st-text)]">Save (API format)</span>
			— the normal save produces a different file that fails on the GPU, not here.
		</li>
		<li>
			The <span class="text-[var(--st-text)]">first render</span> on a new workflow can take
			20–30 minutes while the compute node downloads its model files. That is not a hang. Later
			renders skip it.
		</li>
		<li>
			If a workflow needs custom ComfyUI nodes, it cannot run until Hannes builds them into
			the compute image — tell him rather than retrying.
		</li>
	</ul>
</div>

{#if err}
	<p class="mb-5 rounded-xl bg-[var(--st-surface-2)] px-4 py-3 text-sm">{err}</p>
{/if}
{#if note}
	<p class="mb-5 text-sm text-[var(--st-muted)]">{note}</p>
{/if}

{#if loading}
	<p class="text-sm text-[var(--st-faint)]">loading…</p>
{:else}
	{#if items.length}
		<div class="mb-6 space-y-3">
			{#each items as w (w.name)}
				<section class="rounded-2xl bg-[var(--st-surface)] p-5">
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0">
							<p class="font-display flex flex-wrap items-center gap-2 text-sm font-semibold">
								{w.name}
								{#if !w.enabled}
									<span class="text-[10px] font-normal text-[var(--st-faint)]">— off</span>
								{/if}
								{#if !w.hasBundle}
									<span class="text-[10px] font-normal text-[var(--st-faint)]">
										— graph only, no instructions
									</span>
								{/if}
							</p>
							{#if w.description}
								<p class="mt-1 text-xs leading-relaxed text-[var(--st-muted)]">{w.description}</p>
							{/if}
							<p class="mt-1.5 font-mono text-[11px] text-[var(--st-faint)]">
								{kb(w.bytes)}{w.provider ? ` · ${w.provider}` : ''}{w.lazy ? ' · lazy' : ''}
							</p>
						</div>
						<div class="flex shrink-0 items-center gap-3">
							<button
								type="button"
								class="cursor-pointer font-mono text-[11px] text-[var(--st-faint)] underline-offset-4 hover:text-[var(--st-text)] hover:underline"
								onclick={() => toggle(w)}
							>
								{w.enabled ? 'turn off' : 'turn on'}
							</button>
							<button
								type="button"
								class="cursor-pointer font-mono text-[11px] text-[var(--st-faint)] underline-offset-4 hover:text-[var(--st-text)] hover:underline"
								onclick={() => remove(w)}
							>
								remove
							</button>
						</div>
					</div>
				</section>
			{/each}
		</div>
	{:else}
		<p class="mb-6 text-sm text-[var(--st-faint)]">
			Nothing added yet — productions run on the two built-in workflows.
		</p>
	{/if}

	{#if !open}
		<button
			type="button"
			class="font-display cursor-pointer rounded-full bg-[var(--st-accent)] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--st-accent-strong)]"
			onclick={() => (open = true)}
		>
			add a workflow
		</button>
	{:else}
		<section class="rounded-2xl bg-[var(--st-surface)] p-5">
			<p class="font-display mb-4 text-sm font-semibold">New workflow</p>

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				role="group"
				class="mb-4 rounded-xl border border-dashed px-4 py-6 text-center transition-colors {dragging
					? 'border-[var(--st-accent)] bg-[var(--st-surface-2)]'
					: 'border-[var(--st-faint)]'}"
				ondragover={(e) => {
					e.preventDefault();
					dragging = true;
				}}
				ondragleave={() => (dragging = false)}
				ondrop={(e) => {
					e.preventDefault();
					dragging = false;
					takeFiles(e.dataTransfer?.files ?? null);
				}}
			>
				<p class="text-sm text-[var(--st-muted)]">
					Drop the ComfyUI <span class="text-[var(--st-text)]">.json</span> here — and the
					converted <span class="text-[var(--st-text)]">.yaml</span> too, if you have one.
				</p>
				<label class="mt-2 inline-block cursor-pointer text-xs text-[var(--st-faint)] underline">
					or choose files
					<input
						type="file"
						accept=".json,.yaml,.yml"
						multiple
						class="hidden"
						onchange={(e) => takeFiles((e.currentTarget as HTMLInputElement).files)}
					/>
				</label>
				{#if graphName || bundleName}
					<p class="mt-3 font-mono text-[11px] text-[var(--st-muted)]">
						{graphName ? `graph: ${graphName}` : ''}{bundleName ? `  ·  bundle: ${bundleName}` : ''}
					</p>
				{/if}
			</div>

			<div class="space-y-3">
				<label class="block">
					<span class="mb-1 block font-mono text-[11px] text-[var(--st-faint)]">
						name — becomes the agents' tool name
					</span>
					<input
						bind:value={name}
						spellcheck="false"
						placeholder="my_custom_workflow"
						class="block w-full rounded-xl border-0 bg-[var(--st-bg)] px-3.5 py-2.5 font-mono text-[12px] outline-none"
					/>
				</label>

				<label class="block">
					<span class="mb-1 block font-mono text-[11px] text-[var(--st-faint)]">
						what it is for — the agents read this when choosing a tool
					</span>
					<textarea
						bind:value={description}
						rows="2"
						class="block w-full resize-y rounded-xl border-0 bg-[var(--st-bg)] px-3.5 py-2.5 text-[13px] leading-relaxed outline-none"
					></textarea>
				</label>

				<div class="flex flex-wrap items-center gap-5 pt-1">
					<label class="flex cursor-pointer items-center gap-2 text-xs text-[var(--st-muted)]">
						<input type="checkbox" bind:checked={lazy} class="accent-[var(--st-accent)]" />
						provision on first use, not at load
					</label>
					<label class="flex items-center gap-2 text-xs text-[var(--st-muted)]">
						compute
						<select
							bind:value={provider}
							class="rounded-lg border-0 bg-[var(--st-bg)] px-2 py-1 font-mono text-[11px] outline-none"
						>
							<option value="">whatever the harness picks</option>
							<option value="modal">modal</option>
							<option value="beam">beam</option>
							<option value="runpod">runpod</option>
						</select>
					</label>
				</div>
			</div>

			{#if !bundle && graph}
				<p class="mt-4 text-xs leading-relaxed text-[var(--st-muted)]">
					No bundle file. It will still run, but the bundle is what carries the parameter
					names, the GPU types and the workflow's own failure notes — without it the agents
					are guessing. The <span class="font-mono">auteur-workflow-convert</span> skill produces
					one.
				</p>
			{/if}

			<div class="mt-5 flex items-center gap-4">
				<button
					type="button"
					disabled={!ready || saving}
					onclick={save}
					class="font-display cursor-pointer rounded-full bg-[var(--st-accent)] px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[var(--st-accent-strong)] disabled:cursor-default disabled:opacity-40"
				>
					{saving ? 'adding…' : 'add'}
				</button>
				<button
					type="button"
					class="cursor-pointer text-xs text-[var(--st-faint)] underline-offset-4 hover:text-[var(--st-text)] hover:underline"
					onclick={() => (open = false)}
				>
					cancel
				</button>
			</div>
		</section>
	{/if}

	<p class="mt-6 font-mono text-[11px] break-all text-[var(--st-faint)]">{libPath}</p>
{/if}
