<script lang="ts">
	/** A 5rem bar, which is exactly the top padding every surface already
	 *  reserves. That number is not arbitrary: these pages are written to be
	 *  merged into a host product whose own fixed chrome is 5rem tall, so keeping
	 *  the same reservation here means the page markup does not change on the way
	 *  over.
	 *
	 *  The bar deliberately does not repeat the app's name — each surface already
	 *  labels itself. It carries what only makes sense once this runs standalone:
	 *  which harness is on the other end, and how to get between the three
	 *  surfaces. */
	import { page } from '$app/state';
	import '../app.css';

	let { data, children } = $props();

	/** Tuning is deliberately absent: the studio's own header already links to it,
	 *  and that link is the one that survives the merge into the host product,
	 *  where this bar does not exist. Listing it in both places put the same word
	 *  twice within a centimetre of itself. */
	const LINKS = [
		{ href: '/studio', label: 'studio' },
		{ href: '/ops', label: 'ops' }
	];

	/** Prefix match, so /studio stays lit on /studio/admin — the tuning panel is
	 *  part of the studio, not a third place to be. */
	const path = $derived(page.url.pathname.replace(/\/$/, '') || '/');
	const isCurrent = (href: string) => path === href || path.startsWith(href + '/');
</script>

<header
	class="fixed inset-x-0 top-0 z-50 flex h-20 items-center gap-6 border-b border-border bg-bg px-5"
>
	<nav class="flex items-center gap-5">
		{#each LINKS as l (l.href)}
			<a
				href={l.href}
				class="font-display text-sm font-semibold transition-colors {isCurrent(l.href)
					? 'text-text'
					: 'text-muted hover:text-text'}"
			>
				{l.label}
			</a>
		{/each}
	</nav>

	<span class="ml-auto truncate font-mono text-[11px] text-muted" title="harness endpoint">
		{data.harness}
	</span>
</header>

{@render children()}
