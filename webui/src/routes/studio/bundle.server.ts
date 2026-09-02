/** The parts of a generated workflow bundle that more than one bundle needs.
 *
 *  There are two now. The clip bundle (api/wf) grafts a reference-to-video path
 *  onto our own base graph; the continuation bundle (api/contwf) takes Hannes's
 *  continuation graph and fits our render path into it. Both have to load the
 *  same adapters at the same strengths and declare them the same way, because
 *  the whole point of a continuation is that it looks like the clip it continues.
 *
 *  So the adapter stack and the model rows live here, once. Everything else —
 *  which graph, which nodes, which ports — stays with the bundle that owns it,
 *  because those are exactly the parts that differ.
 */
import { env } from '$env/dynamic/private';
import { BASE, loraFor, type Lora, type Pick } from './loras';

export interface StackEntry {
	lora: Lora;
	strength: number;
}

/** The pair, then the picks.
 *
 *  Order matters to the loader only in that later adapters are applied over
 *  earlier ones; the base pair goes first so a shot adapter is layered on top of
 *  the realism pass rather than under it.
 *
 *  The base pair always loads. Its strengths can be moved for one clip — the
 *  realism slider and the anatomy corrector are both worth tuning by hand — but
 *  the adapters themselves are not a choice, so an override only ever changes a
 *  number and never whether one is present.
 */
export function stack(picks: Pick[], baseAt: Record<string, number> = {}): StackEntry[] {
	const out = BASE.map((l) => ({ lora: l, strength: baseAt[l.key] ?? l.strength }));
	for (const p of picks) {
		const l = loraFor(p.key);
		if (l && !BASE.some((b) => b.key === l.key)) out.push({ lora: l, strength: p.strength });
	}
	return out;
}

/** The `models:` rows for an adapter stack, in the base bundle's own layout.
 *
 *  No `dest:` here, though the base file carried one for a while. The harness
 *  never reads that key: the download payload it sends the worker is
 *  `{url, dest_type: <folder type>, filename, sha256}`, so a model gets a folder
 *  *type* and a bare name and nothing else. The `loras/MINIMAX/` we used to
 *  declare was inert — the volume has no MINIMAX directory and never had one;
 *  every adapter sits flat in `ComfyUI/models/loras/`.
 */
export function modelBlock(entries: StackEntry[]): string {
	const rows: string[] = [];
	for (const { lora } of entries) {
		const civitai = lora.url.includes('civitai.com');
		rows.push(
			`  - name: ${lora.file.replace(/\.safetensors$/, '')}`,
			`    type: lora`,
			`    files:`,
			`      - url: ${lora.url}`,
			// Civitai serves the file behind a redirect that does not carry the
			// name, so it has to be stated. Hugging Face URLs end in the filename
			// and need no help.
			...(civitai ? [`        filename: ${lora.file}`] : []),
			`        sha256: ${lora.sha256}`,
			``
		);
	}
	return rows.join('\n');
}

/** Write an adapter stack into an rgthree Power Lora Loader node.
 *
 *  Drops whatever the node carries first, so a served graph never inherits an
 *  adapter nobody asked for.
 *
 *  A bare filename, no folder. The rgthree loader exported these as
 *  `MINIMAX\name.safetensors` and we kept that, but the harness was quietly
 *  flattening it: the old release ran the graph through flattenModelPaths()
 *  before storing it, so the renderer only ever saw the basename. The HITL
 *  release stores the graph as written and checks each loader path against the
 *  declared filenames, which is what turned an invisible mismatch into a hard
 *  prefetch failure. Writing the basename ourselves reproduces the graph that has
 *  been rendering all along, rather than inventing a layout to test.
 */
export function writeLoraStack(
	node: { inputs?: Record<string, unknown> },
	entries: StackEntry[]
): void {
	if (!node.inputs) return;
	for (const k of Object.keys(node.inputs)) {
		if (/^lora_\d+$/.test(k)) delete node.inputs[k];
	}
	entries.forEach((e, i) => {
		node.inputs![`lora_${i + 1}`] = {
			on: true,
			lora: e.lora.file,
			strength: e.strength
		};
	});
}

/** The bundle's own reference to its graph, made absolute.
 *
 *  A bundle is two files, and the YAML points at the JSON with a relative
 *  `url: workflow.json`. The local harness resolves that against the YAML's
 *  address and comes back here for the graph; the hosted harness does not —
 *  the same bundle from the same public path failed there until that one line
 *  was made absolute, and then it rendered (5677401). So every served YAML
 *  says the full address of its sibling. The address is taken from the request
 *  that fetched the YAML, which is by construction one the caller can reach.
 */
export function absoluteGraphUrl(yaml: string, reqUrl: URL): string {
	// Only when a hosted harness is the target. The local harness — the pinned
	// known-good image — does the opposite of the hosted one: it joins the url:
	// onto the YAML's directory even when it is absolute, and a render died on
	// "…/contwf/<sel>/http://host.docker.internal:5290/…/workflow.json → 404".
	// Two loaders, two behaviours; the studio serves the one the target reads.
	// AUTEUR_STUDIO_URL is set exactly when the studio is being reached from
	// outside, which is the hosted case.
	if (!env.AUTEUR_STUDIO_URL) return yaml;
	const sibling = new URL(reqUrl.href);
	sibling.pathname = sibling.pathname.replace(/workflow\.ya?ml$/, 'workflow.json');
	sibling.search = '';
	return yaml.replace(/^url:\s*workflow\.json\s*$/m, `url: ${sibling.href}`);
}
