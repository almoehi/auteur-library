/** The list of past productions, and removing one from it. */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { forgetProduction, listProductions } from '../../history.server';

export const GET: RequestHandler = async () => json({ productions: listProductions() });

export const DELETE: RequestHandler = async ({ url }) => {
	const slug = (url.searchParams.get('slug') ?? '').trim();
	if (!slug) throw error(400, 'slug is required');
	return json({ ok: forgetProduction(slug), productions: listProductions() });
};
