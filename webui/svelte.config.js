import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** adapter-node, not a platform adapter: this app is meant to run next to the
 *  harness on the operator's own machine. `pnpm build && node build` gives you
 *  a self-contained server if you want one; `pnpm dev` is the normal way in. */
export default {
	preprocess: vitePreprocess(),
	kit: { adapter: adapter() }
};
