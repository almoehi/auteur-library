import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	/** Bound to loopback on purpose. The app proxies to a local harness, writes
	 *  tuning files into the home directory and has no authentication of any
	 *  kind — it is an operator's tool, not a service. */
	server: {
		host: '127.0.0.1',
		port: 5174,
		// The harness fetches generated workflow bundles from this server, and it
		// runs in Docker, so its requests arrive with host.docker.internal in the
		// Host header — which vite refuses by default. Naming it here does not
		// widen what is exposed: the bind stays on loopback, and the Docker VM was
		// already able to reach loopback before this line existed. It only stops
		// vite answering those requests with a 403.
		allowedHosts: ['host.docker.internal', 'localhost', '127.0.0.1']
	}
});
