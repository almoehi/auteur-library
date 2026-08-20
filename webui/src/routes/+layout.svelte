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
	 */
	import '../app.css';

	let { children } = $props();
</script>

{@render children()}
