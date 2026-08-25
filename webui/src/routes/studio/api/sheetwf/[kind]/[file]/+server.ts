/** The sheet workflows, served with one line changed: which GPU they may use.
 *
 *  The first character sheet took seventeen minutes, and the reason turned out
 *  to have nothing to do with the workflow. Its published spec says
 *  `gpu_types: [l40s, a100, h100]`, and when a workflow allows several the
 *  harness picks the **cheapest** — so it ran on an l40s, the slowest card
 *  available, while our render profile politely asked for a100 and was ignored.
 *  Modal's own logs settle it: the job ran in `comfy-compute-l40s`, 09:54:22 to
 *  09:57:17, 175 seconds of sampling on the wrong hardware.
 *
 *  A profile cannot override this. `resolveGpuType` consults the workflow's own
 *  allowlist, and a request outside it — or a workflow provisioned before the
 *  profile is read — falls back to the cheapest entry the allowlist permits. The
 *  only lever that actually moves it is the allowlist itself, and that lives in
 *  the workflow bundle rather than in the workspace.
 *
 *  So the bundle is served from here instead of by registry reference, with
 *  `gpu_types` narrowed and everything else passed through untouched. The YAML
 *  is fetched live from the same repository the registry ref points at, so
 *  Hannes's changes still reach us — we are not holding a copy that can drift.
 *  The graph is proxied rather than linked. An absolute `url:` looked cleaner and
 *  does not work: the harness resolves that field against the directory the YAML
 *  came from whether it is absolute or not, and asked us for
 *  `/studio/api/sheetwf/character/https://raw.githubusercontent.com/...`. So
 *  `url: workflow.json` stays relative and the graph is fetched through here,
 *  unmodified, byte for byte.
 */
import { error, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const REPO = 'https://raw.githubusercontent.com/almoehi/auteur-library/refs/heads/main/workflows';

const SHEETS: Record<string, string> = {
	character: 'krea2_character_sheet',
	location: 'krea2_location_sheet'
};

/** The one card we pin to.
 *
 *  h100, deployed 2026-08-25 as `comfy-compute-h100-cu13-0-32-0` alongside the
 *  l40s and a100 apps that were already there. Nothing about this workflow
 *  argues against it: the attention backend it selects is
 *  `comfy kitchen (int8)`, not SageAttention, so the sm_90 kernel gap that pins
 *  our clip workflow to a100 does not apply here.
 *
 *  Naming a tier is not free of consequence, and the earlier note in this spot
 *  had the consequence backwards. Modal endpoints are not probed — the harness
 *  constructs a URL for every supported tier from the workspace slug and the
 *  version, so an undeployed card is "discovered" like any other and fails at
 *  submit with a retryable error that starts a GPU downgrade ladder. It does not
 *  quietly resolve to something cheaper. That makes an undeployed pin a slow,
 *  confusing failure rather than a silent demotion — worth knowing before
 *  changing this line. */
const PIN = 'h100';

/** Fetched per request, but not per fetch: the harness asks for the YAML once
 *  per workspace and there is no reason to hit GitHub every time somebody
 *  starts a render. Small enough to hold, short enough to stay current. */
const CACHE = new Map<string, { at: number; body: string }>();
const CACHE_MS = 10 * 60 * 1000;

async function upstream(
	name: string,
	file: 'workflow.yaml' | 'workflow.json',
	fetch: typeof globalThis.fetch
): Promise<string> {
	const key = `${name}/${file}`;
	const hit = CACHE.get(key);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
	const res = await fetch(`${REPO}/${name}/${file}`);
	if (!res.ok) throw error(502, `could not fetch ${key} — upstream said ${res.status}`);
	const body = await res.text();
	CACHE.set(key, { at: Date.now(), body });
	return body;
}

export const GET: RequestHandler = async ({ params, fetch }) => {
	const name = SHEETS[params.kind ?? ''];
	if (!name) throw error(404, 'a sheet is either a character or a location');
	// The graph, straight through. Nothing about it is ours to change: the only
	// thing this route exists to alter is which card the workflow may run on, and
	// that is declared in the YAML.
	if (params.file === 'workflow.json') {
		return text(await upstream(name, 'workflow.json', fetch), {
			headers: { 'content-type': 'application/json' }
		});
	}
	if (params.file !== 'workflow.yaml' && params.file !== 'workflow.yml') {
		throw error(404, 'a bundle is workflow.yaml and workflow.json');
	}

	const src = await upstream(name, 'workflow.yaml', fetch);

	// `gpu_types: [...]` on its own line, which is how every bundle in this
	// registry writes it. A miss is loud rather than silent: serving the file
	// unchanged would quietly put us back on the l40s and the only symptom would
	// be a render that felt slow.
	if (!/^gpu_types:\s*\[[^\]]*\]\s*$/m.test(src)) {
		throw error(500, `${name} no longer declares gpu_types on one line — check upstream before pinning`);
	}
	let out = src.replace(/^gpu_types:\s*\[[^\]]*\]\s*$/m, `gpu_types: [${PIN}]`);

	// `url: workflow.json` is left exactly as upstream wrote it — the harness
	// resolves it against this directory, which is where the graph is served.
	return text(out, { headers: { 'content-type': 'text/yaml' } });
};
