<script lang="ts">
	/** The shell every admin surface shares.
	 *
	 *  Four things are tuned here and they are genuinely different in kind —
	 *  what the crew is told, what tools it has, what skills it has, and what
	 *  material it is given — so they get a page each rather than four
	 *  accordions on one. The nav is the only thing that has to stay identical
	 *  between them.
	 */
	import { page } from '$app/state';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();

	const TABS = [
		{ href: '/studio/admin', label: 'prompts & models', exact: true },
		{ href: '/studio/admin/workflows', label: 'workflows', exact: false },
		{ href: '/studio/admin/skills', label: 'skills', exact: false },
		{ href: '/studio/admin/cast', label: 'cast & sets', exact: false }
	];

	const path = $derived(page.url.pathname.replace(/\/$/, '') || '/studio/admin');
</script>

<main class="studio min-h-screen pt-10 pb-24">
	<div class="mx-auto max-w-[52rem] px-5">
		<header class="mb-7">
			<div class="flex items-baseline justify-between gap-4">
				<p class="text-[10px] font-bold tracking-[0.3em] text-[var(--st-faint)] uppercase">
					auteur tuning
				</p>
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
				<a
					href="/studio"
					class="text-xs text-[var(--st-faint)] underline-offset-4 hover:text-[var(--st-muted)] hover:underline"
				>
					back to the studio
				</a>
			</div>

			<nav class="mt-4 flex flex-wrap gap-1.5">
				{#each TABS as t (t.href)}
					{@const active = t.exact ? path === t.href : path.startsWith(t.href)}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
					<a
						href={t.href}
						aria-current={active ? 'page' : undefined}
						class="font-display rounded-full px-3.5 py-1.5 text-sm font-semibold transition-colors {active
							? 'bg-[var(--st-accent)] text-[var(--st-on-accent)]'
							: 'bg-[var(--st-surface)] text-[var(--st-muted)] hover:text-[var(--st-text)]'}"
					>
						{t.label}
					</a>
				{/each}
			</nav>
		</header>

		{@render children()}
	</div>
</main>

<style>
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
		--st-accent-strong: var(--color-coral-dark);
		/* What sits on top of a filled accent surface. The accent is white now, so
		 * this is the one that had to move with it. */
		--st-on-accent: var(--color-on-accent);
		background: var(--st-bg);
		color: var(--st-text);
		font-family: var(--font-body);
	}
	.studio :global(h1) {
		font-family: var(--font-display);
	}
</style>
