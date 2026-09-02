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
import { absoluteGraphUrl, modelBlock, stack, writeLoraStack } from '../../../../bundle.server';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBaseOverrides, parsePicks, parseRunSlug, type Lora } from '../../../../loras';

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

/** The card this bundle runs on, and the cards whose compute image cannot run
 *  SageAttention.
 *
 *  The second list is the harness's own — SAGE_BLACKLIST_GPU_TYPES in
 *  video_harness_harness.wasm reads ["h100", "l40s"]. It is repeated here because
 *  one of this graph's two Sage patches has no off switch and must be removed
 *  from the graph rather than disabled; the harness deals with the other itself,
 *  from the port declared in buildYaml. */
const CARD = 'h100';
const SAGE_BLIND = ['h100', 'l40s'];

const SAGE_KJ = '157';
const SAGE_MM = '663';
const SOL_ATTN = '636';

/** Take out the patch that cannot be switched off, when the card cannot run it.
 *
 *  MiniMaxH3MemoryEfficientSageAttentionPatch takes a model and nothing else, and
 *  rewrites every transformer block onto an fp8+int8 path the published compute
 *  images have no sm89/sm90 build for — sageattention stops at CUDA 12.8, so the
 *  image's nvcc emitted nothing for those architectures and said nothing about
 *  it. On an h100 the render dies at the sampler with
 *  cudaErrorNoKernelImageForDevice; on an a100 the same graph is fine and the
 *  patch earns its place. So it is removed for the blind cards and kept for the
 *  rest, rather than deleted outright — deleting it would quietly slow the card
 *  that has carried every render so far, to fix one it never runs on. */
function fitSageForCard(
	graph: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>
): void {
	const kj = graph[SAGE_KJ];
	const mm = graph[SAGE_MM];
	const sol = graph[SOL_ATTN];
	if (
		kj?.class_type !== 'PathchSageAttentionKJ' ||
		mm?.class_type !== 'MiniMaxH3MemoryEfficientSageAttentionPatch' ||
		!sol?.inputs
	) {
		throw error(500, 'the base graph no longer carries the Sage nodes this expects — it has been re-exported');
	}
	if (!SAGE_BLIND.includes(CARD)) return;
	delete graph[SAGE_MM];
	sol.inputs.model = [SAGE_KJ, 0];
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

	writeLoraStack(node, entries);

	addReferencePath(graph, refs);
	fitSageForCard(graph);
	return JSON.stringify(graph, null, 2);
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
	const inputs = inputsBlock(refs);
	let withPorts = inputs ? out.replace(/^ports:\n/m, `ports:\n${inputs}`) : out;

	// The card, and the switch the harness needs to see.
	//
	// A param named exactly `sage_attention` is what makes the harness's own
	// per-GPU override fire: it forces the value to disabled when dispatching to a
	// card on its blacklist and leaves it alone everywhere else. Declaring it is
	// what lets one bundle serve both cards correctly.
	// The bracket, and whatever the line says after it — this one carries a
	// trailing comment, and an anchored $ silently matched nothing until the guard
	// below turned that into a 500 instead of a bundle served on the wrong card.
	const gpu = /^gpu_types: \[[^\]]*\].*$/m;
	if (!gpu.test(withPorts)) {
		throw error(500, 'the base bundle has no gpu_types line — it has been re-exported');
	}
	withPorts = withPorts.replace(gpu, `gpu_types: [${CARD}]`);

	const sagePort =
		`    - name: sage_attention\n` +
		`      kind: string\n` +
		`      description: "SageAttention mode. Left to the harness, which forces it to disabled on the cards whose compute image has no sm89/sm90 kernels and leaves it alone elsewhere."\n` +
		`      binding: sage_attention@${SAGE_KJ}\n` +
		`      required: false\n` +
		`      default: auto\n`;
	if (!withPorts.includes('\n  outputs:')) {
		throw error(500, 'the base bundle has no outputs: section — it has been re-exported');
	}
	return withPorts.replace('\n  outputs:', `\n${sagePort}  outputs:`);
}

export const GET: RequestHandler = async ({ params, url }) => {
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
		return text(absoluteGraphUrl(buildYaml(entries, refs), url), {
			headers: { 'content-type': 'text/yaml' }
		});
	}
	throw error(404, 'a bundle is workflow.yaml, workflow.json and its reference images');
};
