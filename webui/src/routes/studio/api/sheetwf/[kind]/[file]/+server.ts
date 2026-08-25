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

/** The one card we pin to — and it is the cheapest one, which took two
 *  measurements to earn.
 *
 *  The same sheet was rendered on both tiers, same description, same everything:
 *
 *    l40s   09:54:22 -> 09:57:17   175s
 *    h100   11:03:46 -> 11:06:36   170s
 *
 *  Three percent. The GPU is not what this workflow spends its time on. Nearly
 *  all of those seconds are ComfyUI starting and ~45 GB of weights being read
 *  off the Modal volume, because `scaledown_window=2` destroys the container two
 *  seconds after each job, `@modal.enter()` is an empty `pass`, and ComfyUI is
 *  started lazily inside `run()`. None of that is faster on a better card, and
 *  all three settings live in the harness's deploy.py rather than here.
 *
 *  So this pin is not "use the fast card". It is "do not let the choice drift":
 *  the workflow's own spec allows [l40s, a100, h100], the harness picks the
 *  cheapest of whatever it is allowed, and that is a decision worth making on
 *  purpose rather than inheriting. Measured, the cheapest is also the right one.
 *  An h100 endpoint stays deployed for the clip workflow, where a render is
 *  three to fifteen times longer and the sampling share is worth re-testing.
 *
 *  One correction to an earlier note in this spot, since it would mislead the
 *  next person to change this line: Modal endpoints are never probed. The
 *  harness constructs a URL for every supported tier from the workspace slug and
 *  the version, so naming an undeployed card does NOT quietly resolve to
 *  something cheaper — it fails at submit with a retryable error and starts a
 *  GPU downgrade ladder. A wrong value here is a slow confusing failure, not a
 *  silent demotion. */
const PIN = 'l40s';

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
