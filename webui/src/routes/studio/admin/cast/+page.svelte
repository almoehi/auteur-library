<script lang="ts">
	/** The kept cast and sets, and everything you can do to one.
	 *
	 *  This lived at the foot of the studio rail, where it was a management panel
	 *  pinned inside a navigation list — a third thing in a place that holds two.
	 *  The admin shell already sorts the local library by kind: what the crew is
	 *  told, what tools it has, and what material it is given. A kept face is
	 *  material, so it belongs here beside the workflows and the skills.
	 *
	 *  Picking one for the next clip is a different act and stays where it was,
	 *  in the composer's own picker. This page is for renaming, checking on a
	 *  turnaround, and throwing one away.
	 */
	import { onMount } from 'svelte';
	import type { StoredSheet } from '../../types';

	let sheets = $state<StoredSheet[]>([]);
	let loaded = $state(false);
	let busy = $state<Record<string, boolean>>({});
	/** Which one has been asked about but not yet confirmed. A bare × deleted a
	 *  sheet that cost three minutes of GPU time; a stray click is not consent. */
	let confirmDrop = $state('');
	let error = $state('');

	const characters = $derived(sheets.filter((s) => s.kind === 'character'));
	const locations = $derived(sheets.filter((s) => s.kind === 'location'));

	async function load() {
		try {
			const res = await fetch('/studio/api/sheet');
			if (!res.ok) return;
			const r = (await res.json()) as { sheets?: StoredSheet[] };
			if (r.sheets) sheets = r.sheets;
		} catch {
			error = 'the list could not be read';
		} finally {
			loaded = true;
		}
	}

	async function rename(id: string, name: string) {
		const trimmed = name.trim();
		if (!trimmed) return;
		try {
			const res = await fetch('/studio/api/sheet', {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id, name: trimmed })
			});
			const r = (await res.json()) as { sheets?: StoredSheet[] };
			if (r.sheets) sheets = r.sheets;
		} catch {
			/* the next load will be right */
		}
	}

	async function drop(id: string) {
		confirmDrop = '';
		busy[id] = true;
		try {
			const res = await fetch(`/studio/api/sheet?id=${encodeURIComponent(id)}`, {
				method: 'DELETE'
			});
			const r = (await res.json()) as { sheets?: StoredSheet[] };
			if (r.sheets) sheets = r.sheets;
		} catch {
			/* as above */
		} finally {
			busy[id] = false;
		}
	}

	async function retry(id: string) {
		busy[id] = true;
		try {
			await fetch('/studio/api/sheetfull', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ id })
			});
			// The turnaround takes minutes; poll until it settles rather than
			// leaving the row claiming it failed.
			for (let i = 0; i < 40; i++) {
				await new Promise((r) => setTimeout(r, 5000));
				await load();
				const s = sheets.find((x) => x.id === id);
				if (s?.sheet?.state !== 'rendering') break;
			}
		} catch {
			error = 'the retry could not be sent';
		} finally {
			busy[id] = false;
		}
	}

	onMount(load);
</script>

<svelte:head><title>cast & sets · auteur</title></svelte:head>

{#if error}
	<p class="mb-6 rounded-xl bg-[var(--st-surface)] px-4 py-3 text-sm text-[var(--st-muted)]">
		{error}
	</p>
{/if}

{#if loaded && !sheets.length}
	<p class="max-w-[52ch] text-sm leading-relaxed text-[var(--st-faint)]">
		Nothing kept yet. A character or a location made in the studio shows up here, and every
		clip can then be shot with the same face.
	</p>
{/if}

{#each [{ label: 'Characters', items: characters, round: true }, { label: 'Sets', items: locations, round: false }] as group (group.label)}
	{#if group.items.length}
		<section class="mb-10">
			<h2
				class="mb-3.5 font-mono text-[0.7rem] font-medium tracking-[0.13em] text-[var(--st-faint)] uppercase"
			>
				{group.label}
				<span class="ml-1.5 tabular-nums opacity-70">{group.items.length}</span>
			</h2>

			<div class="grid gap-3 sm:grid-cols-2">
				{#each group.items as sh (sh.id)}
					<article class="flex gap-3.5 rounded-2xl bg-[var(--st-surface)] p-3.5">
						<!-- Round for a face, square for a place. The same shape language the
							 composer's picker uses, so a thumbnail says which kind it is
							 without a label doing it. -->
						<img
							src="/studio/api/sheet/img/{sh.id}"
							alt=""
							class="size-16 shrink-0 bg-[var(--st-bg)] object-cover {group.round
								? 'rounded-full'
								: 'rounded-xl'}"
						/>

						<div class="flex min-w-0 flex-1 flex-col">
							<!-- The name is the field, not a label with an edit button beside it.
								 It is the only thing here anyone changes. -->
							<label class="sr-only" for="name-{sh.id}">Name</label>
							<input
								id="name-{sh.id}"
								value={sh.name}
								spellcheck="false"
								onblur={(e) => rename(sh.id, e.currentTarget.value)}
								onkeydown={(e) => {
									if (e.key === 'Enter') e.currentTarget.blur();
								}}
								class="w-full truncate rounded-lg border-0 bg-transparent px-1.5 py-1 text-[0.95rem] text-[var(--st-text)] outline-none focus:bg-[var(--st-bg)] focus:ring-0"
							/>

							<!-- What state the turnaround is in. A character is usable without
								 one, so this is progress rather than a warning — except when it
								 failed, which is worth saying out loud. -->
							<p class="mt-0.5 px-1.5 text-xs text-[var(--st-faint)]">
								{#if sh.sheet?.state === 'rendering'}
									<span class="inline-flex items-center gap-1.5">
										<span
											class="spin block size-2 rounded-full border border-[var(--st-surface-2)] border-t-[var(--st-accent)]"
										></span>
										drawing the six views
									</span>
								{:else if sh.sheet?.state === 'ready'}
									<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
									<a
										href="/studio/api/sheet/full/{sh.id}"
										target="_blank"
										rel="noreferrer"
										class="text-[var(--st-muted)] underline-offset-2 hover:text-[var(--st-text)] hover:underline"
									>
										six views — open
									</a>
								{:else if sh.sheet?.state === 'failed'}
									<button
										type="button"
										disabled={busy[sh.id]}
										title={sh.sheet.error ?? ''}
										onclick={() => retry(sh.id)}
										class="cursor-pointer text-[var(--st-warn,#b98a3e)] hover:underline disabled:cursor-default disabled:opacity-50"
									>
										{busy[sh.id]
											? 'asking again…'
											: (sh.sheet.attempt ?? 1) > 1
												? 'sheet failed twice — try again'
												: 'sheet failed — retry'}
									</button>
								{:else}
									one picture · no turnaround yet
								{/if}
							</p>

							<div class="mt-auto flex items-center justify-end gap-2 pt-2">
								{#if confirmDrop === sh.id}
									<button
										type="button"
										onclick={() => (confirmDrop = '')}
										class="min-h-8 cursor-pointer rounded-full px-3 text-xs text-[var(--st-faint)] transition-colors hover:text-[var(--st-text)]"
									>
										keep
									</button>
									<button
										type="button"
										disabled={busy[sh.id]}
										onclick={() => drop(sh.id)}
										class="min-h-8 cursor-pointer rounded-full bg-[#5c2f24] px-3.5 text-xs font-semibold text-[#f2d7cd] transition-colors hover:bg-[#6d372a] disabled:opacity-50"
									>
										delete
									</button>
								{:else}
									<button
										type="button"
										onclick={() => (confirmDrop = sh.id)}
										class="min-h-8 cursor-pointer rounded-full px-3 text-xs text-[var(--st-faint)] transition-colors hover:bg-[var(--st-surface-2)] hover:text-[var(--st-text)]"
									>
										delete
									</button>
								{/if}
							</div>
						</div>
					</article>
				{/each}
			</div>
		</section>
	{/if}
{/each}

<style>
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
</style>
