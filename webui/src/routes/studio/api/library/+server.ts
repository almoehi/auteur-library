/** CRUD for the local library of workflows and skills.
 *
 *  GET returns everything the library page needs to render without a second
 *  call. POST saves one entry; DELETE removes one. Nothing here talks to the
 *  harness — loading into a workspace happens at launch, from the same store.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	LIBRARY_PATH,
	NAME_RE,
	deleteSkill,
	deleteWorkflow,
	listSkills,
	listWorkflows,
	saveSkill,
	saveWorkflow,
	workflowSize,
	type Provider
} from '../../library.server';

const PROVIDERS: Provider[] = ['modal', 'beam', 'runpod'];

/** A ComfyUI export is a JSON object of nodes. Anything else is a file picked
 *  by mistake, and the harness would take it and fail much later, on a GPU. */
function looksLikeComfyGraph(text: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return 'that file is not valid JSON — pick the ComfyUI API export, not a screenshot or a workflow link';
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return 'the JSON is not a ComfyUI graph (expected an object of nodes)';
	}
	const keys = Object.keys(parsed as Record<string, unknown>);
	if (!keys.length) return 'the graph is empty';
	// ComfyUI API exports are keyed by node id, each with a class_type.
	const hasNodes = keys.some((k) => {
		const n = (parsed as Record<string, unknown>)[k];
		return !!n && typeof n === 'object' && 'class_type' in (n as Record<string, unknown>);
	});
	if (!hasNodes) {
		return 'no nodes with a class_type — this looks like the UI export; use "Save (API format)" in ComfyUI instead';
	}
	return null;
}

export const GET: RequestHandler = async () => {
	return json({
		path: LIBRARY_PATH,
		workflows: listWorkflows().map((w) => ({
			name: w.name,
			description: w.description ?? '',
			hasBundle: !!w.yamlContent,
			lazy: !!w.lazy,
			provider: w.provider ?? null,
			enabled: w.enabled,
			updatedAt: w.updatedAt,
			bytes: workflowSize(w.name)
		})),
		skills: listSkills().map((s) => ({
			name: s.name,
			enabled: s.enabled,
			updatedAt: s.updatedAt,
			chars: s.markdownContent.length,
			preview: s.markdownContent.slice(0, 220)
		}))
	});
};

interface SaveBody {
	kind?: 'workflow' | 'skill';
	name?: string;
	jsonContent?: string;
	yamlContent?: string;
	markdownContent?: string;
	description?: string;
	lazy?: boolean;
	provider?: string;
	enabled?: boolean;
}

export const POST: RequestHandler = async ({ request }) => {
	let body: SaveBody;
	try {
		body = (await request.json()) as SaveBody;
	} catch {
		throw error(400, 'Body must be JSON');
	}

	const name = (body.name ?? '').trim().toLowerCase();
	if (!NAME_RE.test(name)) {
		return json({
			ok: false,
			error:
				'the name must be lowercase letters, digits and underscores, 3–49 characters, starting with a letter — it becomes the agents’ tool name'
		});
	}

	if (body.kind === 'skill') {
		const md = (body.markdownContent ?? '').trim();
		if (!md) return json({ ok: false, error: 'the skill file is empty' });
		const s = saveSkill({ name, markdownContent: md, enabled: body.enabled !== false });
		return json({ ok: true, saved: s.name, updatedAt: s.updatedAt });
	}

	const jsonContent = body.jsonContent ?? '';
	const complaint = looksLikeComfyGraph(jsonContent);
	if (complaint) return json({ ok: false, error: complaint });

	const provider =
		body.provider && PROVIDERS.includes(body.provider as Provider)
			? (body.provider as Provider)
			: undefined;

	const w = saveWorkflow({
		name,
		jsonContent,
		yamlContent: (body.yamlContent ?? '').trim() || undefined,
		description: (body.description ?? '').trim() || undefined,
		lazy: body.lazy === true,
		provider,
		enabled: body.enabled !== false
	});
	return json({ ok: true, saved: w.name, updatedAt: w.updatedAt });
};

export const DELETE: RequestHandler = async ({ url }) => {
	const kind = url.searchParams.get('kind');
	const name = (url.searchParams.get('name') ?? '').trim();
	if (!name) throw error(400, 'name is required');
	const gone = kind === 'skill' ? deleteSkill(name) : deleteWorkflow(name);
	return json({ ok: gone });
};
