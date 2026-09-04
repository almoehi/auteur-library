import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** adapter-node, not a platform adapter: this app is meant to run next to the
 *  harness on the operator's own machine. `pnpm build && node build` gives you
 *  a self-contained server if you want one; `pnpm dev` is the normal way in. */
export default {
	preprocess: vitePreprocess(),
	/** `studio-app`, not the default `_app`: this app is meant to be served
	 *  under ratemyd.app/studio by a path rewrite, next to a second SvelteKit
	 *  app that already owns `/_app`. Two apps behind one host cannot both
	 *  answer `/_app/immutable/...`; naming ours puts every asset under a
	 *  prefix that is ours alone, so the rewrite is two rules: `/studio/*`
	 *  and `/studio-app/*`. */
	kit: { adapter: adapter(), appDir: 'studio-app' }
};
