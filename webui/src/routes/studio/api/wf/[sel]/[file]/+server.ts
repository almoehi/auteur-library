/** The workflow bundle for one clip, assembled when the harness asks for it.
 *
 *  A bundle in git is a file, and a file cannot know whether the shot it is
 *  about to render needs the blowjob adapter or the missionary one. The two
 *  ways around that both end badly: commit a copy per adapter and every future
 *  change has to be made ten times, or commit a copy per combination and there
 *  are a hundred and twenty of them.
 *
 *  So the bundle is built here instead. The guide allows a workflow `url` to be
 *  a plain link rather than a `name@branch` registry ref, the studio is already
 *  an HTTP server, and the harness can reach it — which makes the third option
 *  available: one base in git, and a bundle per clip generated from it.
 *
 *  Two files are served because a bundle is two files. The YAML carries the
 *  ports and the model list, and its own `url: workflow.json` is relative, so
 *  the harness comes back to this same directory for the graph.
 *
 *  Unauthenticated and local, like the rest of this app — but note that this
 *  one is reachable from the Docker host as well, which is why vite.config.ts
 *  now names that host explicitly.
 */
import { error, text } from '@sveltejs/kit';
import { contentTypeFor, readStashed, stashedNames } from '../../../../refstash.server';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	BASE,
	loraFor,
	parseBaseOverrides,
	parsePicks,
	parseRunSlug,
	type Lora,
	type Pick
} from '../../../../loras';

const BUNDLE = 'minimaxh3_t2v_i2v_ref2v_advanced_film_making_foxydit';

/** Where the base bundle lives. The webui runs inside the checkout, so the
 *  workflows directory is one level up — the same reach the prompt writer uses
 *  to read the harness's own skill files. */
function basePath(name: string): string {
	for (const p of [
		join(process.cwd(), '..', 'workflows', BUNDLE, name),
		join(process.cwd(), 'workflows', BUNDLE, name)
	]) {
		if (existsSync(p)) return p;
	}
	throw error(500, `the base bundle is not where it should be — looked for ${name}`);
}

/** The node the adapters are loaded by: rgthree's Power Lora Loader, which
 *  holds each one as its own nested block. Nested is exactly why the adapters
 *  cannot be switched through a port and have to be written into the graph. */
const LOADER_NODE = '674';

/** The pair, then the picks. Order matters to the loader only in that later
 *  adapters are applied over earlier ones; the base pair goes first so a shot
 *  adapter is layered on top of the realism pass rather than under it. */
function stack(picks: Pick[], baseAt: Record<string, number> = {}): { lora: Lora; strength: number }[] {
	// The base pair always loads. Its strengths can be moved for one clip — the
	// realism slider and the anatomy corrector are both worth tuning by hand —
	// but the adapters themselves are not a choice, so an override only ever
	// changes a number and never whether one is present.
	const out = BASE.map((l) => ({ lora: l, strength: baseAt[l.key] ?? l.strength }));
	for (const p of picks) {
		const l = loraFor(p.key);
		if (l && !BASE.some((b) => b.key === l.key)) out.push({ lora: l, strength: p.strength });
	}
	return out;
}

/** Reference-to-video, grafted in only when a clip actually has references.
 *
 *  The model does this natively — MiniMaxH3ReferenceToVideo takes up to nine
 *  reference images and the prompt addresses them as <Picture i> — but the API
 *  export this bundle was built from kept only the text-to-video branch, so the
 *  node has never been in our graph. Everything it needs is: clip, vae,
 *  audio_vae, prompt, width, height and length all already exist and are the
 *  same sources the image-to-video node uses.
 *
 *  Nothing here runs for a clip without references. That is the whole safety
 *  argument: with none attached the graph is byte-identical to what it was, so
 *  if this turns out to be wrong there is nothing to roll back — you just do not
 *  attach a picture. Removing it for good is deleting this function and its one
 *  call site.
 *
 *  Field names come from comfy_extras/nodes_minimax_h3.py rather than from
 *  reading the UI export's widget order, which is positional and would have been
 *  a guess. ref_image_size is the one that is easy to miss: "match" scales each
 *  reference to the generation's pixel area, "max" uses a 2048px short edge for
 *  better identity at several times the cost. Identity is the entire point of
 *  attaching a face, so this takes "max".
 */
const REF_NODE = '136';

function addReferencePath(
	graph: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>,
	assets: string[]
): void {
	if (!assets.length) return;

	const refs: Record<string, unknown> = {};
	assets.forEach((base, i) => {
		const id = `ref_${i}`;
		// A plain LoadImage: the reference node downscales for itself, so the
		// crop-and-resize loader the original export used buys nothing here, and
		// core nodes are the ones whose API shape is not in doubt.
		//
		// The filename is the asset basename, and that is the whole mechanism:
		// the harness scans the graph for strings matching a name in the bundle's
		// `assets` list and replaces each one with a URL it can serve. Nothing
		// else has to carry the image — no port, no agent, no artifact.
		graph[id] = { class_type: 'LoadImage', inputs: { image: base } };
		refs[`ref_images.ref_image_${i}`] = [id, 0];
	});

	graph[REF_NODE] = {
		class_type: 'MiniMaxH3ReferenceToVideo',
		inputs: {
			clip: ['128', 0],
			vae: ['119', 0],
			audio_vae: ['120', 0],
			prompt: ['138', 0],
			width: ['wh_width', 0],
			height: ['wh_height', 0],
			length: ['131', 1],
			ref_image_size: 'max',
			...refs
		}
	};

	// Into the same two switch slots the image-to-video node occupies, which is
	// where the original export sent them: conditioning to 648, latent to 682.
	// rgthree's Any Switch takes the first non-null, so this wins over the
	// text-only path without that path having to be removed.
	const cond = graph['648']?.inputs;
	const latent = graph['682']?.inputs;
	if (cond) cond.any_01 = [REF_NODE, 0];
	if (latent) latent.any_01 = [REF_NODE, 1];
}

function buildJson(entries: { lora: Lora; strength: number }[], assets: string[] = []): string {
	const graph = JSON.parse(readFileSync(basePath('workflow.json'), 'utf8')) as Record<
		string,
		{ class_type?: string; inputs?: Record<string, unknown> }
	>;
	const node = graph[LOADER_NODE];
	if (!node?.inputs) throw error(500, `node ${LOADER_NODE} is missing from the base graph`);

	// Drop whatever the base carries and write the stack fresh, so the served
	// graph never inherits an adapter nobody asked for.
	for (const k of Object.keys(node.inputs)) {
		if (/^lora_\d+$/.test(k)) delete node.inputs[k];
	}
	entries.forEach((e, i) => {
		node.inputs![`lora_${i + 1}`] = {
			on: true,
			// The graph addresses adapters by their folder on the volume, and the
			// separator is a backslash because that is what the loader wrote.
			lora: `MINIMAX\\${e.lora.file}`,
			strength: e.strength
		};
	});
	addReferencePath(graph, assets);
	return JSON.stringify(graph, null, 2);
}

/** The model entries for the stack, in the base file's own layout. */
function modelBlock(entries: { lora: Lora; strength: number }[]): string {
	const rows: string[] = [];
	for (const { lora } of entries) {
		const civitai = lora.url.includes('civitai.com');
		rows.push(
			`  - name: ${lora.file.replace(/\.safetensors$/, '')}`,
			`    type: lora`,
			`    dest: loras/MINIMAX/`,
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

const OPEN = '  # <<LORAS>>';
const CLOSE = '  # <</LORAS>>';

/** The bundle's own `name` is left exactly as the base file has it.
 *
 *  An earlier version stamped a fingerprint of the adapter stack onto it, as
 *  insurance against the harness caching bundles by name. It does not cache by
 *  name — it checks it, and refuses a bundle whose name disagrees with the
 *  workspace entry that asked for it:
 *
 *    WorkflowDownloader: YAML name mismatch — expected "…foxydit", got "…foxydit_h6e2h0"
 *
 *  Which is a better guarantee than the one being bought, and the insurance was
 *  the only thing that failed. Two adapter stacks now differ by URL alone, and
 *  since every run opens a fresh workspace there is nothing for a stale bundle
 *  to persist into. */
/** The reference images, declared as bundle assets.
 *
 *  This replaces an earlier attempt that declared them as `ports.inputs` of
 *  kind image and left the worker agent to find the uploaded artifact and pass
 *  URLs. The agent did its half correctly — it located the files unprompted —
 *  and the render still died on a 404 fetching them from the exchange bucket.
 *
 *  Assets are the mechanism the guide actually describes for getting a static
 *  file into a graph: the harness fetches each basename from the directory the
 *  workflow JSON came from, which is this endpoint, and substitutes a URL for
 *  every string in the graph that matches. That removes both things that
 *  failed — no artifact URL, and no agent in the path.
 */
function assetsBlock(assets: string[]): string {
	if (!assets.length) return '';
	return ['assets:', ...assets.map((a) => `  - ${a}`)].join('\n') + '\n';
}

function buildYaml(entries: { lora: Lora; strength: number }[], assets: string[] = []): string {
	const src = readFileSync(basePath('workflow.yaml'), 'utf8');
	const a = src.indexOf(OPEN);
	const b = src.indexOf(CLOSE);
	if (a < 0 || b < 0 || b < a) {
		throw error(500, 'the base bundle has lost its <<LORAS>> markers — nothing to replace');
	}
	const head = src.slice(0, a);
	const tail = src.slice(b + CLOSE.length);
	const body =
		`  # Generated for one clip. Edit webui/src/routes/studio/loras.ts, not this.\n` +
		modelBlock(entries);
	const out = head + body + tail;
	// Ahead of `ports:`, at the top level — assets are a sibling of ports and
	// models, not a member of either.
	const block = assetsBlock(assets);
	return block ? out.replace(/^ports:/m, `${block}\nports:`) : out;
}

export const GET: RequestHandler = async ({ params }) => {
	const sel = params.sel ?? '';
	const slug = parseRunSlug(sel);
	const assets = slug ? stashedNames(slug) : [];

	// The images sit beside the bundle because that is where the harness looks
	// for an asset: the directory the workflow JSON came from.
	if (slug && /^ref_\d+\./.test(params.file ?? '')) {
		const bytes = readStashed(slug, params.file);
		if (!bytes) throw error(404, 'no such reference image for this run');
		return new Response(new Uint8Array(bytes), {
			headers: { 'content-type': contentTypeFor(params.file), 'content-length': String(bytes.length) }
		});
	}

	const entries = stack(parsePicks(sel), parseBaseOverrides(sel));

	if (params.file === 'workflow.json') {
		return text(buildJson(entries, assets), { headers: { 'content-type': 'application/json' } });
	}
	if (params.file === 'workflow.yaml' || params.file === 'workflow.yml') {
		return text(buildYaml(entries, assets), { headers: { 'content-type': 'text/yaml' } });
	}
	throw error(404, 'a bundle is workflow.yaml, workflow.json and its reference images');
};
