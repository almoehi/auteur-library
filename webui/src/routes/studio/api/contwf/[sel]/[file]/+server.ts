/** The continuation bundle: Hannes's graph, our render path.
 *
 *  `minimax_h3_video_continuation` extends an existing clip — it takes the clip
 *  as a reference video alongside a character sheet and a location plate, and
 *  generates what happens next. What it does NOT do is look like our clips, and
 *  the gap is not one missing adapter. Read against our own graph, six things
 *  differ, and every one of them is visible in the result:
 *
 *    - no LoRA loader at all, so none of our adapters apply
 *    - a different checkpoint (the full 34 GB fl2va, ours is the pruned one our
 *      adapters were validated against) and a different text encoder
 *    - no MiniMaxH3SigmaShift, which reshapes the sigma schedule the LightX2V
 *      4-step distill runs on — this is the one whose absence we cannot predict
 *    - no sage-attention patches
 *    - no RIFE, so it renders 24 fps against our 48
 *    - resolution hard-coded at ~848x480 by a ResolutionSelector with no port
 *
 *  The last two are not merely quality: a continuation at a different frame size
 *  or frame rate cannot be joined to the clip it continues, and joining is the
 *  entire point.
 *
 *  So this route does to the continuation graph what api/wf does to ours — it
 *  fits our render path into it and serves the result. Hannes's bundle is
 *  fetched live rather than vendored, so his fixes reach us; every edit below is
 *  anchored on something that must exist, and throws if it does not, because a
 *  bundle that quietly loses the adapters would look like a bad render rather
 *  than a broken build.
 */
import { error, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelBlock, stack, writeLoraStack } from '../../../../bundle.server';
import { parseBaseOverrides, parsePicks } from '../../../../loras';

const REPO =
	'https://raw.githubusercontent.com/almoehi/auteur-library/refs/heads/main/workflows';
const BUNDLE = 'minimax_h3_video_continuation';

/** Our own base bundle, read for its model list. One source of truth for which
 *  checkpoint and text encoder a clip of ours is made with — a second copy here
 *  would drift the first time either is changed. */
const OURS = 'minimaxh3_t2v_i2v_ref2v_advanced_film_making_foxydit';

function oursPath(name: string): string {
	for (const p of [
		join(process.cwd(), '..', 'workflows', OURS, name),
		join(process.cwd(), 'workflows', OURS, name)
	]) {
		if (existsSync(p)) return p;
	}
	throw error(500, `our base bundle is not where it should be — looked for ${name}`);
}

const OPEN = '  # <<LORAS>>';
const CLOSE = '  # <</LORAS>>';

/** Node ids in Hannes's graph. Read off the published workflow.json rather than
 *  guessed, and every one is checked before use. */
const N = {
	unet: '160',
	scheduler: '141',
	guider: '143',
	refToVideo: '169',
	noise: '161',
	videoDecode: '139',
	createVideo: '150',
	resolution: '157'
} as const;

/** Ids we add. Named rather than numbered so a reader can tell at a glance which
 *  nodes are ours and which came with the bundle. */
const OUR = {
	sageKj: 'our_sage_kj',
	sageMm: 'our_sage_mm',
	solAttn: 'our_solattn',
	sigma: 'our_sigma',
	loader: 'our_loras',
	width: 'wh_width',
	height: 'wh_height',
	seed: 'our_seed',
	rife: 'our_rife'
} as const;

type Node = { class_type?: string; inputs?: Record<string, unknown> };
type Graph = Record<string, Node>;

/** Every loader in their graph, repointed at the file our models: block declares.
 *
 *  All four, not just the checkpoint. Their bundle names each weight with an
 *  `h3/` prefix because that is the subdirectory its own model rows download
 *  into; ours declare bare filenames and land flat. Swap the model list without
 *  swapping the loaders and the graph asks for `h3/minimax_h3_video_vae_fp16`
 *  while the volume holds `minimax_h3_video_vae_fp16` — a render that dies on the
 *  GPU saying the model is missing, minutes in, for a reason no log spells out.
 *
 *  The text encoder is the one worth a note: theirs is an uncensored fine-tune
 *  and ours is not, which sounds like the wrong trade for this material. It is
 *  not — our clips carry explicit prompts through this encoder every day, and
 *  the adapters and prompt templates are tuned against it. Matching the clip is
 *  what a continuation is for.
 */
const LOADERS: { node: string; cls: string; key: string; file: string }[] = [
	{
		node: '160',
		cls: 'UNETLoader',
		key: 'unet_name',
		// Ours is the pruned build our adapters were validated against, and 13 GB
		// less to load — which the latency work found to be the dominant cost.
		file: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors'
	},
	{ node: '149', cls: 'CLIPLoader', key: 'clip_name', file: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors' },
	{ node: '144', cls: 'VAELoader', key: 'vae_name', file: 'minimax_h3_video_vae_fp16.safetensors' },
	{ node: '145', cls: 'VAELoader', key: 'vae_name', file: 'minimax_h3_audio_vae_fp32.safetensors' }
];

/** Our model path, transplanted whole.
 *
 *  Values are copied from the graph our clips actually render with, not from the
 *  node defaults — SolAttnPatch alone carries eleven settings, and a default is
 *  not what we have been shipping.
 *
 *  The rgthree Any Switch that sits between the loader and the first patch in
 *  our own graph is deliberately not reproduced: it exists there to merge a
 *  branch this graph does not have, and a one-input switch is a passthrough.
 */
function fitOurModelPath(graph: Graph, entries: ReturnType<typeof stack>): void {
	// Every weight the graph loads, repointed at what our models: block declares.
	// The class is checked as well as the id: a renumbered node that still exists
	// under the old id would otherwise take a filename for a field it does not
	// have, and the graph would look fine until the GPU disagreed.
	for (const l of LOADERS) {
		const n = graph[l.node];
		if (!n?.inputs) throw error(502, `the continuation graph has no node ${l.node} (${l.cls})`);
		if (n.class_type !== l.cls) {
			throw error(502, `node ${l.node} is ${n.class_type}, expected ${l.cls} — the bundle has been restructured`);
		}
		n.inputs[l.key] = l.file;
	}

	graph[OUR.sageKj] = {
		class_type: 'PathchSageAttentionKJ',
		inputs: { sage_attention: 'auto', allow_compile: false, model: [N.unet, 0] }
	};
	graph[OUR.sageMm] = {
		class_type: 'MiniMaxH3MemoryEfficientSageAttentionPatch',
		inputs: { model: [OUR.sageKj, 0] }
	};
	graph[OUR.solAttn] = {
		class_type: 'SolAttnPatch',
		inputs: {
			model: [OUR.sageMm, 0],
			tau: 1.3,
			start_percent: 0.2,
			end_percent: 0.9,
			min_tokens: 4096,
			int8_qk: true,
			sink_conditioning: 'exact_kv_and_rows',
			morton: false,
			morton_curve: '2d_frame',
			int8_pv: true,
			verbose: false,
			use_tma: false,
			dense_blocks: ''
		}
	};
	graph[OUR.sigma] = {
		class_type: 'MiniMaxH3SigmaShift',
		inputs: { model: [OUR.solAttn, 0], shift_video: 12, shift_audio: 6 }
	};
	graph[OUR.loader] = {
		class_type: 'Power Lora Loader (rgthree)',
		inputs: {
			model: [OUR.sigma, 0],
			PowerLoraLoaderHeaderWidget: { type: 'PowerLoraLoaderHeaderWidget' }
		}
	};
	writeLoraStack(graph[OUR.loader], entries);

	// The two consumers of MODEL, repointed at the end of our chain. Same shape
	// as our own graph, where 674 feeds BasicGuider and BasicScheduler.
	for (const id of [N.scheduler, N.guider]) {
		const n = graph[id];
		if (!n?.inputs) throw error(500, `the continuation graph has no node ${id}`);
		n.inputs.model = [OUR.loader, 0];
	}
}

/** Frame size, frame rate and seed — none of which this graph lets a profile
 *  reach on its own.
 *
 *  Resolution is hard-coded in a ResolutionSelector at 0.4 megapixels, and the
 *  bundle exposes no width or height port, so our render profile's 1024x576 has
 *  nothing to bind to. Seed is a literal 42 in RandomNoise, which would make
 *  every continuation of every clip the same draw. And the frame rate port only
 *  reaches the muxer: the frames themselves are generated at 24, so a profile
 *  asking for 48 would produce a double-speed clip half the length it asked for
 *  — unless the interpolation that earns those frames is put back.
 */
function fitOurOutputShape(graph: Graph): void {
	const ref = graph[N.refToVideo];
	if (!ref?.inputs) throw error(500, `the continuation graph has no node ${N.refToVideo}`);
	if (!graph[N.resolution]) throw error(500, `the continuation graph has no node ${N.resolution}`);

	// PrimitiveInt, not PrimitiveFloat. Their reference node declares width and
	// height as INT and ComfyUI rejects the graph outright — "received_type(FLOAT)
	// mismatch input_type(INT)" — before a single step is sampled. Our own graph
	// wires a PrimitiveFloat into the same class and renders happily, which is not
	// a licence to copy it: whatever lets ours through, this one is checked, and
	// an INT source is right in both.
	graph[OUR.width] = { class_type: 'PrimitiveInt', inputs: { value: 1024 } };
	graph[OUR.height] = { class_type: 'PrimitiveInt', inputs: { value: 576 } };
	ref.inputs.width = [OUR.width, 0];
	ref.inputs.height = [OUR.height, 0];

	// Identity is the whole reason a reference is attached, so the same setting
	// our clips use. Theirs is "match", which scales each reference to the
	// generation's pixel area and costs less.
	ref.inputs.ref_image_size = 'max';

	const noise = graph[N.noise];
	if (!noise?.inputs) throw error(500, `the continuation graph has no node ${N.noise}`);
	graph[OUR.seed] = { class_type: 'easy seed', inputs: { seed: 0 } };
	noise.inputs.noise_seed = [OUR.seed, 0];

	const decode = graph[N.videoDecode];
	const create = graph[N.createVideo];
	if (!decode || !create?.inputs) {
		throw error(500, `the continuation graph is missing ${N.videoDecode} or ${N.createVideo}`);
	}
	graph[OUR.rife] = {
		class_type: 'RIFE VFI',
		inputs: {
			ckpt_name: 'rife49.pth',
			frames: [N.videoDecode, 0],
			multiplier: 2,
			clear_cache_after_n_frames: 10,
			fast_mode: true,
			ensemble: true,
			scale_factor: 1,
			dtype: 'float32',
			torch_compile: false,
			batch_size: 1
		}
	};
	create.inputs.images = [OUR.rife, 0];
}

async function fetchBundle(file: 'workflow.json' | 'workflow.yaml'): Promise<string> {
	const res = await fetch(`${REPO}/${BUNDLE}/${file}`, { signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw error(502, `the continuation bundle answered ${res.status} for ${file}`);
	return await res.text();
}

async function buildJson(entries: ReturnType<typeof stack>): Promise<string> {
	const graph = JSON.parse(await fetchBundle('workflow.json')) as Graph;
	fitOurModelPath(graph, entries);
	fitOurOutputShape(graph);
	return JSON.stringify(graph, null, 2);
}

/** Our model list, which is the list our clips are made from.
 *
 *  Taken from our own bundle rather than restated, with the per-clip adapter
 *  rows spliced into the same markers api/wf uses. It replaces theirs entirely:
 *  the graph now loads our checkpoint and our text encoder, so declaring theirs
 *  would download 34 GB nothing reads.
 */
function ourModels(entries: ReturnType<typeof stack>): string {
	const src = readFileSync(oursPath('workflow.yaml'), 'utf8');
	const at = src.indexOf('\nmodels:');
	if (at < 0) throw error(500, 'our base bundle has no models: section');
	const models = src.slice(at + 1);
	const a = models.indexOf(OPEN);
	const b = models.indexOf(CLOSE);
	if (a < 0 || b < 0 || b < a) {
		throw error(500, 'our base bundle has lost its <<LORAS>> markers — nothing to replace');
	}
	return (
		models.slice(0, a) +
		`  # Generated for one continuation. Edit webui/src/routes/studio/loras.ts.\n` +
		modelBlock(entries) +
		models.slice(b + CLOSE.length)
	);
}

async function buildYaml(entries: ReturnType<typeof stack>): Promise<string> {
	const src = await fetchBundle('workflow.yaml');

	const at = src.indexOf('\nmodels:');
	if (at < 0) {
		throw error(502, 'the continuation bundle has no models: section — it has been restructured');
	}
	let out = src.slice(0, at + 1) + ourModels(entries);

	// One card, for the same reason the clip bundle pins one: when a workflow
	// allows several the harness takes the cheapest, and the cheapest is not what
	// a 40 GB model path should run on.
	const gpu = /^gpu_types: \[[^\]]*\]$/m;
	if (!gpu.test(out)) {
		throw error(502, 'the continuation bundle has no gpu_types line — it has been restructured');
	}
	out = out.replace(gpu, 'gpu_types: [a100]');

	// The three the render profile must be able to reach, and cannot as shipped.
	//
	// Seed is the one that matters most and is easiest to overlook: their graph
	// carries a literal 42, so without a port every continuation of every clip
	// would be the same draw, and asking for another take would return the take
	// you already had.
	//
	// Width and height default to what our clips are rendered at, because a
	// continuation that cannot be joined to its clip is not a continuation. They
	// are ports rather than constants so the size can follow the source clip once
	// the app passes it.
	const outputs = '\n  outputs:';
	if (!out.includes(outputs)) {
		throw error(502, 'the continuation bundle has no outputs: section — it has been restructured');
	}
	const added =
		`    - name: seed\n` +
		`      kind: int\n` +
		`      description: "Noise seed. -1 draws a new one, so a second take differs from the first."\n` +
		`      binding: seed@${OUR.seed}\n` +
		`      required: false\n` +
		`      default: -1\n` +
		`    - name: width\n` +
		`      kind: int\n` +
		`      description: "Frame width. Must match the clip being continued, or the two cannot be joined."\n` +
		`      binding: value@${OUR.width}\n` +
		`      required: false\n` +
		`      default: 1024\n` +
		`    - name: height\n` +
		`      kind: int\n` +
		`      description: "Frame height. Must match the clip being continued."\n` +
		`      binding: value@${OUR.height}\n` +
		`      required: false\n` +
		`      default: 576\n`;
	out = out.replace(outputs, `\n${added}  outputs:`);

	return out;
}

export const GET: RequestHandler = async ({ params }) => {
	const entries = stack(parsePicks(params.sel ?? ''), parseBaseOverrides(params.sel ?? ''));
	const file = params.file ?? '';

	if (file === 'workflow.json') {
		return text(await buildJson(entries), { headers: { 'content-type': 'application/json' } });
	}
	if (file === 'workflow.yaml' || file === 'workflow.yml') {
		return text(await buildYaml(entries), { headers: { 'content-type': 'text/yaml' } });
	}
	throw error(404, 'a continuation bundle is workflow.yaml and workflow.json');
};
