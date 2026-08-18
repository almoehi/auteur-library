/** Read and write the tuning overrides behind the admin panel.
 *
 *  GET returns the whole registry — every tunable with its shipped default, the
 *  current override if any, what it affects and which model runs it — so the
 *  panel never has to know anything the server does not tell it.
 *
 *  Unauthenticated, like every other route here — this is a local tool.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { DEFAULT_MODELS, MODEL_CHOICES, TUNABLES, type Overrides } from '../../tunables';
import { OVERRIDES_PATH, readOverrides, writeOverrides } from '../../overrides.server';

export const GET: RequestHandler = async () => {
	const stored = readOverrides();
	return json({
		path: OVERRIDES_PATH,
		updatedAt: stored.updatedAt ?? null,
		models: MODEL_CHOICES,
		defaultModels: DEFAULT_MODELS,
		items: TUNABLES.map((t) => ({
			id: t.id,
			label: t.label,
			affects: t.affects,
			agent: t.agent ?? null,
			runBy: t.runBy ?? null,
			model: t.agent ? (stored.models?.[t.agent] ?? DEFAULT_MODELS[t.agent]) : t.model,
			defaultModel: t.agent ? DEFAULT_MODELS[t.agent] : t.model,
			risky: t.risky ?? false,
			fallback: t.fallback,
			override: stored.prompts?.[t.id] ?? null
		}))
	});
};

/** Body: { prompts?: Record<id,string>, models?: Record<agent,string> }.
 *  Sent whole rather than per-field: the panel holds one form, and a partial
 *  write would make "which of these is live?" unanswerable after a failed save.
 *
 *  An empty string clears an override — the registry treats blank as unset, so
 *  clearing a box in the panel restores the shipped default rather than sending
 *  an empty system prompt to a model. */
export const POST: RequestHandler = async ({ request }) => {

	let body: Overrides;
	try {
		body = (await request.json()) as Overrides;
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const validIds = new Set(TUNABLES.map((t) => t.id));
	const validAgents = new Set(Object.keys(DEFAULT_MODELS));
	const validModels = new Set<string>(MODEL_CHOICES.map((m) => m.id));

	const prompts: Record<string, string> = {};
	for (const [id, text] of Object.entries(body.prompts ?? {})) {
		if (!validIds.has(id)) continue;
		if (typeof text !== 'string') continue;
		const trimmed = text.trim();
		// A prompt long enough to be a mistake is still a prompt; one that is
		// empty is a request to go back to stock.
		if (trimmed) prompts[id] = text;
	}

	const models: Record<string, string> = {};
	for (const [agent, model] of Object.entries(body.models ?? {})) {
		if (!validAgents.has(agent)) continue;
		if (typeof model !== 'string' || !validModels.has(model)) continue;
		if (model !== DEFAULT_MODELS[agent]) models[agent] = model;
	}

	const stored = writeOverrides({ prompts, models });
	return json({ ok: true, updatedAt: stored.updatedAt });
};
