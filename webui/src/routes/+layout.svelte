<script lang="ts">
	/** No chrome of its own.
	 *
	 *  There was a bar here carrying a nav and the harness endpoint. Both were
	 *  answers to questions nobody was asking: each surface already names itself
	 *  and links where it needs to, and the endpoint only ever mattered when it
	 *  was down — which the studio says in place, in words, when it happens.
	 *
	 *  The operator view at /ops is still there and still works; it is simply not
	 *  advertised, because it is a debugging surface and this is a product.
	 *
	 *  The one thing that does live here is analytics, because this is the only
	 *  node every surface passes through. It arms listeners and hands back their
	 *  teardown; it renders nothing and, with no key configured, does nothing.
	 */
	import { onMount } from 'svelte';
	import { armPostHog } from '$lib/analytics';
	import '../app.css';

	let { children } = $props();

	onMount(armPostHog);
</script>

{@render children()}
