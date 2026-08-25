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
	refNames: string[]
): void {
	if (!refNames.length) return;

	const refs: Record<string, unknown> = {};
	refNames.forEach((base, i) => {
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

function buildJson(entries: { lora: Lora; strength: number }[], refs: string[] = []): string {
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
			// A bare filename, no folder. The rgthree loader exported these as
			// `MINIMAX\name.safetensors` and we kept that, but the harness was
			// quietly flattening it: the old release ran the graph through
			// flattenModelPaths() before storing it, so the renderer only ever
			// saw the basename. The HITL release stores the graph as written and
			// checks each loader path against the declared filenames, which is
			// what turned an invisible mismatch into a hard prefetch failure.
			// Writing the basename ourselves reproduces the graph that has been
			// rendering all along, rather than inventing a layout to test.
			lora: e.lora.file,
			strength: e.strength
		};
	});
	addReferencePath(graph, refs);
	return JSON.stringify(graph, null, 2);
}

/** The model entries for the stack, in the base file's own layout.
 *
 *  No `dest:` here, though the base file carried one for a while. The harness
 *  never reads that key: the download payload it sends the worker is
 *  `{url, dest_type: <folder type>, filename, sha256}`, so a model gets a
 *  folder *type* and a bare name and nothing else. The `loras/MINIMAX/` we
 *  used to declare was inert — the volume has no MINIMAX directory and never
 *  had one; every adapter sits flat in `ComfyUI/models/loras/`. */
function modelBlock(entries: { lora: Lora; strength: number }[]): string {
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
/*  An earlier note here said input ports had already been tried and had died on
 *  a 404 from the exchange bucket, and used that to argue for assets. It was
 *  wrong about the cause, and the wrong lesson was expensive.
 *
 *  The harness's own oplog settles it: across all 409 render dispatches on this
 *  machine, `mediaInputs` was `{}` and `inputFiles` was `0`. No render has ever
 *  staged an input file, so no 404 can have come from staging one. What that
 *  attempt actually hit is a different trap — it passed the url minted by
 *  `mint-upload-urls`, and `importUserArtifact` copies the upload into artifact
 *  scope and then deletes the workspace-scope object while still storing its
 *  now-dead url. Fetching it gets NoSuchKey, which is a 404.
 *
 *  We mint our own url and never touch the artifact store, so that trap is not
 *  on this path. */
/** The reference images, declared as media input ports.
 *
 *  NOT as `assets:`, which is what this used to be and what cost three GPU
 *  renders to disprove. The harness's asset mechanism is documented in
 *  WORKSPACE_GUIDE.md §3.9 as working for both kinds of workflow entry. It does
 *  not. In the wasm, a workspace entry whose `url` ends in `.yaml` — which is
 *  every entry this app writes — goes through buildEntryFromContent, which
 *  rebuilds the spec as `{ name, description, url }` and drops `assets`; the
 *  bundle's own `assets:` key is never read at all (`yamlSpec.assets` occurs
 *  zero times in the binary). The download loop and the string-substitution pass
 *  are both guarded on a non-empty list, so nothing is fetched, nothing is
 *  rewritten, and nothing is logged — which is exactly what we saw. No bundle in
 *  the library's entire history has ever declared `assets:`, so the path was
 *  dead code rather than a regression.
 *
 *  Input ports are the mechanism that does work, and it is the one every
 *  image-to-video bundle already uses — see iamcs_wan22_svi, `binding: image@745`
 *  against a LoadImage node. At render time the harness writes
 *  `<port>.<ext-from-url>` into the bound node's input and puts `{name, url}` on
 *  the worker payload's `images` list; the worker downloads each URL and uploads
 *  it to ComfyUI, where it lands in /ComfyUI/input/ under that name.
 *
 *  Which is why the ports are named for the files: port `ref_0` plus a URL
 *  ending `.png` produces `ref_0.png`, the string the graph already carries.
 *
 *  `required: true` on purpose. An optional port that goes unsupplied has its
 *  consumer edges stripped and the clip renders from text alone — a plausible
 *  video of the wrong person, which is worse than a loud failure.
 */
function inputsBlock(refs: string[]): string {
	if (!refs.length) return '';
	const rows = refs.map((a, i) => {
		const port = a.replace(/\.[^.]+$/, '');
		const role =
			i === 0
				? 'Primary reference — the subject the clip is conditioned on, addressed as <Picture 1> in the prompt.'
				: `Reference ${i + 1}, addressed as <Picture ${i + 1}> in the prompt.`;
		return [
			`    - name: ${port}`,
			`      kind: image`,
			`      description: ${JSON.stringify(role)}`,
			`      binding: image@${port}`,
			`      required: true`
		].join('\n');
	});
	return `  inputs:\n${rows.join('\n')}\n`;
}

function buildYaml(entries: { lora: Lora; strength: number }[], refs: string[] = []): string {
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
	// Inside `ports:`, ahead of `params:` — inputs are a member of ports, which
	// is where the base bundle would carry them if it had any. It has none: this
	// graph was a text-to-video export, and the reference path is grafted in by
	// addReferencePath above.
	const block = inputsBlock(refs);
	return block ? out.replace(/^ports:\n/m, `ports:\n${block}`) : out;
}

export const GET: RequestHandler = async ({ params }) => {
	const sel = params.sel ?? '';
	const slug = parseRunSlug(sel);
	const refs = slug ? stashedNames(slug) : [];
	const file = params.file ?? '';

	// Kept, though the harness no longer fetches from here — the reference images
	// now reach the worker as presigned S3 URLs, because a Modal GPU cannot reach
	// this server and the harness refuses to pretend otherwise. This stays as the
	// way to see what a run actually staged, which is the first question whenever
	// a clip comes back with the wrong face in it.
	if (slug && /^ref_\d+\./.test(file)) {
		const bytes = readStashed(slug, file);
		if (!bytes) throw error(404, 'no such reference image for this run');
		return new Response(new Uint8Array(bytes), {
			headers: { 'content-type': contentTypeFor(file), 'content-length': String(bytes.length) }
		});
	}

	const entries = stack(parsePicks(sel), parseBaseOverrides(sel));

	if (file === 'workflow.json') {
		return text(buildJson(entries, refs), { headers: { 'content-type': 'application/json' } });
	}
	if (file === 'workflow.yaml' || file === 'workflow.yml') {
		return text(buildYaml(entries, refs), { headers: { 'content-type': 'text/yaml' } });
	}
	throw error(404, 'a bundle is workflow.yaml, workflow.json and its reference images');
};
