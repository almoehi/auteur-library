<script lang="ts">
	/** The skill library.
	 *
	 *  A skill is a markdown file that gets folded into an agent's system prompt
	 *  when it picks up a task of the matching kind. It is the difference between
	 *  the prompts page — which changes what one named agent is told — and this,
	 *  which adds knowledge any agent can pick up.
	 *
	 *  The rule that matters and is easy to miss: skills are read when a task is
	 *  created. A production already running will not see an edit made here.
	 */
	import { onMount } from 'svelte';

	type Skill = {
		name: string;
		enabled: boolean;
		updatedAt: string;
		chars: number;
		preview: string;
	};

	let items = $state<Skill[]>([]);
	let libPath = $state('');
	let loading = $state(true);
	let err = $state('');
	let note = $state('');

	let open = $state(false);
	let name = $state('');
	let fileName = $state('');
	let markdown = $state('');
	let saving = $state(false);
	let dragging = $state(false);

	const ready = $derived(name.trim().length >= 3 && markdown.trim().length > 0);

	async function load() {
		try {
			const res = await fetch('/studio/api/library');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const d = (await res.json()) as { skills: Skill[]; path: string };
			items = d.skills;
			libPath = d.path;
		} catch (e) {
			err = `Could not read the library: ${e}`;
		} finally {
			loading = false;
		}
	}

	function slugFromFile(file: string): string {
		return file
			.replace(/\.[^.]+$/, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '')
			.replace(/^([0-9])/, 's$1')
			.slice(0, 48);
	}

	async function takeFiles(files: FileList | null) {
		const f = files?.[0];
		if (!f) return;
		markdown = await f.text();
		fileName = f.name;
		if (!name.trim()) name = slugFromFile(f.name);
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
					kind: 'skill',
					name: name.trim().toLowerCase(),
					markdownContent: markdown,
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
			name = markdown = fileName = '';
			await load();
		} catch (e) {
			err = `Save failed: ${e}`;
		} finally {
			saving = false;
		}
	}

	async function toggle(s: Skill) {
		err = '';
		const res = await fetch('/studio/api/library', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'skill-toggle', name: s.name, enabled: !s.enabled })
		});
		const d = (await res.json()) as { ok: boolean; error?: string };
		if (!d.ok) err = d.error ?? 'could not change it';
		await load();
	}

	async function remove(s: Skill) {
		err = '';
		await fetch(`/studio/api/library?kind=skill&name=${encodeURIComponent(s.name)}`, {
			method: 'DELETE'
		});
		note = `${s.name} removed.`;
		await load();
	}

	onMount(load);
</script>

<svelte:head><title>skills · auteur</title></svelte:head>

<h1 class="font-display mb-2 text-xl font-semibold">Skills</h1>

<p class="mb-5 text-sm leading-relaxed text-[var(--st-muted)]">
	A skill is a markdown file that gets added to an agent's instructions when it picks up a
	task. The prompts page changes what one named agent is told; a skill is knowledge any
	agent can pick up — how to shoot a scene, how to write for a particular render model.
</p>

<div class="mb-7 rounded-2xl bg-[var(--st-surface)] p-5 text-sm leading-relaxed">
	<p class="font-display mb-2 font-semibold">One rule worth knowing</p>
	<p class="text-[var(--st-muted)]">
		Skills are read when a task is <em>created</em>, not when it runs. A production that is
		already going will not pick up anything you change here — it applies from the next one.
	</p>
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
			{#each items as s (s.name)}
				<section class="rounded-2xl bg-[var(--st-surface)] p-5">
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0">
							<p class="font-display flex items-center gap-2 text-sm font-semibold">
								{s.name}
								{#if !s.enabled}
									<span class="text-[10px] font-normal text-[var(--st-faint)]">— off</span>
								{/if}
							</p>
							<p class="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--st-muted)]">
								{s.preview}
							</p>
							<p class="mt-1.5 font-mono text-[11px] text-[var(--st-faint)]">
								{s.chars.toLocaleString('en-GB')} chars
							</p>
						</div>
						<div class="flex shrink-0 items-center gap-3">
							<button
								type="button"
								class="cursor-pointer font-mono text-[11px] text-[var(--st-faint)] underline-offset-4 hover:text-[var(--st-text)] hover:underline"
								onclick={() => toggle(s)}
							>
								{s.enabled ? 'turn off' : 'turn on'}
							</button>
							<button
								type="button"
								class="cursor-pointer font-mono text-[11px] text-[var(--st-faint)] underline-offset-4 hover:text-[var(--st-text)] hover:underline"
								onclick={() => remove(s)}
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
			Nothing added yet — productions run on the skills that ship with the workspace.
		</p>
	{/if}

	{#if !open}
		<button
			type="button"
			class="font-display cursor-pointer rounded-full bg-[var(--st-accent)] px-6 py-2.5 text-sm font-semibold text-[var(--st-on-accent)] transition-colors hover:bg-[var(--st-accent-strong)]"
			onclick={() => (open = true)}
		>
			add a skill
		</button>
	{:else}
		<section class="rounded-2xl bg-[var(--st-surface)] p-5">
			<p class="font-display mb-4 text-sm font-semibold">New skill</p>

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
					Drop a <span class="text-[var(--st-text)]">SKILL.md</span> here, or write it below.
				</p>
				<label class="mt-2 inline-block cursor-pointer text-xs text-[var(--st-faint)] underline">
					or choose a file
					<input
						type="file"
						accept=".md,.markdown,.txt"
						class="hidden"
						onchange={(e) => takeFiles((e.currentTarget as HTMLInputElement).files)}
					/>
				</label>
				{#if fileName}
					<p class="mt-3 font-mono text-[11px] text-[var(--st-muted)]">{fileName}</p>
				{/if}
			</div>

			<label class="mb-3 block">
				<span class="mb-1 block font-mono text-[11px] text-[var(--st-faint)]">name</span>
				<input
					bind:value={name}
					spellcheck="false"
					placeholder="shoot_scene_extra"
					class="block w-full rounded-xl border-0 bg-[var(--st-bg)] px-3.5 py-2.5 font-mono text-[12px] outline-none"
				/>
			</label>

			<label class="block">
				<span class="mb-1 block font-mono text-[11px] text-[var(--st-faint)]">
					the instructions themselves
				</span>
				<textarea
					bind:value={markdown}
					rows="12"
					spellcheck="false"
					class="block w-full resize-y rounded-xl border-0 bg-[var(--st-bg)] px-3.5 py-3 font-mono text-[12px] leading-relaxed outline-none"
				></textarea>
			</label>

			<div class="mt-5 flex items-center gap-4">
				<button
					type="button"
					disabled={!ready || saving}
					onclick={save}
					class="font-display cursor-pointer rounded-full bg-[var(--st-accent)] px-6 py-2.5 text-sm font-semibold text-[var(--st-on-accent)] transition-colors hover:bg-[var(--st-accent-strong)] disabled:cursor-default disabled:opacity-40"
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
				<span class="font-mono text-[11px] text-[var(--st-faint)]">
					{markdown.length.toLocaleString('en-GB')} chars
				</span>
			</div>
		</section>
	{/if}

	<p class="mt-6 font-mono text-[11px] break-all text-[var(--st-faint)]">{libPath}</p>
{/if}
