/** The studio is the app; the root exists only so a bare localhost lands there
 *  rather than on a 404. */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	redirect(307, '/studio');
};
