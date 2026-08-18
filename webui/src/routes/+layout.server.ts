/** The bar needs to say which harness this app is pointed at — the one thing
 *  that is genuinely ambiguous once the UI runs outside a single fixed setup.
 *  The URL is a localhost address, not a secret, so handing it to the client is
 *  fine; the point of keeping HARNESS server-side is that a client bundle has no
 *  business calling the harness directly, not that the string is sensitive. */
import { HARNESS } from '$lib/harness';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => ({
	harness: HARNESS.replace(/^https?:\/\//, '')
});
