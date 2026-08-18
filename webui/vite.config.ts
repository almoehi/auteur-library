import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	/** Bound to loopback on purpose. The app proxies to a local harness, writes
	 *  tuning files into the home directory and has no authentication of any
	 *  kind — it is an operator's tool, not a service. */
	server: { host: '127.0.0.1', port: 5174 }
});
