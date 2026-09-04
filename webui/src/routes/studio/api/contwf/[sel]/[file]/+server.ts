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
import { env } from '$env/dynamic/private';
import { absoluteGraphUrl } from '../../../../bundle.server';
import type { RequestHandler } from './$types';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelBlock, stack, writeLoraStack } from '../../../../bundle.server';
import { parseBaseOverrides, parsePicks, parsePinSeam, parseRefStart } from '../../../../loras';
import { CONT_FPS, DROP_SLOTS, OWN_AUDIO_LOADER } from '../../../../compose';

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
	saveVideo: '176',
	resolution: '157',
	videoVae: '144',
	frames: '156',
	priorVideo: '177',
	refPic4: '192',
	refPic5: '193'
} as const;

/** Ids we add. Named rather than numbered so a reader can tell at a glance which
 *  nodes are ours and which came with the bundle. */
/** The card this bundle is pinned to, and the cards whose compute image cannot
 *  run SageAttention.
 *
 *  The second list is the harness's own — SAGE_BLACKLIST_GPU_TYPES in
 *  video_harness_harness.wasm reads ["h100", "l40s"] — repeated here because two
 *  decisions depend on it locally: whether to add the patch that has no off
 *  switch, and what SolAttn should take its model from. The harness handles the
 *  one that does have a switch, on its own, from the port declared below. */
/** Three dials turned together against a metallic voice, all of them here so
 *  they can be turned back one at a time. The step count went from eight to four
 *  and two things broke at once — hands in the picture, ringing in the voice —
 *  and putting the steps back is the known fix and the expensive one. These are
 *  the cheaper things to try first.
 *
 *  `AUDIO_SHIFT` is the only dial in the graph that touches the audio alone. Six
 *  was set with eight sampling steps under it; with four, each step covers twice
 *  as much schedule and where they fall matters more. Lowered rather than raised
 *  because metal is a fine-detail failure and a smaller shift spends more of the
 *  schedule at the low-noise end, which is where fine detail resolves. That is
 *  reasoning, not measurement — if it comes back no better, raising it above six
 *  is the obvious other direction and nobody has tried either.
 *
 *  `QUANT_ATTN` is the int8 quantisation inside the sparse-attention patch. It
 *  is the third candidate and the only one of the three that costs render time,
 *  so it is left ON: the two free dials are being tried first, and turning this
 *  off is what to try next if they are not enough. Its error would sound like
 *  exactly what is being complained about, and it lands harder on audio than on
 *  video because there are far fewer audio rows to average it out over. */
/** One and a half, found by walking down from six.
 *
 *  Six is what the bundle ships with, and it was set under eight sampling steps.
 *  At four the voice came back metallic, and this is the only dial in the graph
 *  that touches the audio alone — the video's shift sits beside it, untouched at
 *  twelve.
 *
 *  Three renders off one source clip and one brief, nothing else moving, judged
 *  by ear: six metallic, three better, one and a half better still, three
 *  quarters worse again. So it overshoots below 1.5 and this is the best of what
 *  was tried; the floor is somewhere between 0.75 and 1.5 and nobody has looked
 *  closer than that.
 *
 *  Free, which is why it was worth three renders to find: they came back at
 *  160.5, 160.8 and 162.9 seconds of GPU. The dial moves where the sampling
 *  steps fall, not how many of them there are. */
const AUDIO_SHIFT = 1.5;

const QUANT_ATTN = true;

/** AUTEUR_GPU_CARD overrides the card — the hosted harness's fleet is not ours,
 *  and a bundle that names a card the target has no endpoint for never binds
 *  (the workflow sits with endpoint_id null and the task at `running`). The
 *  Sage handling below follows the card, so the override is safe to flip. */
const CARD = (env.AUTEUR_GPU_CARD || 'h100').trim();
const SAGE_BLIND = ['h100', 'l40s'];

const OUR = {
	sageKj: 'our_sage_kj',
	sageMm: 'our_sage_mm',
	solAttn: 'our_solattn',
	sigma: 'our_sigma',
	loader: 'our_loras',
	width: 'wh_width',
	height: 'wh_height',
	seed: 'our_seed',
	rife: 'our_rife',
	seam: 'our_seam',
	seamFrame: 'our_seam_frame',
	refAudio: 'our_ref_audio',
	refAudioSrc: 'our_ref_audio_src'
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

	// SageAttention, kept but switchable — and one of its two patches removed.
	//
	// The wheel in every published compute image is an sm_80-only build: no
	// _qattn_sm90.so, and no PTX, so no JIT fallback either. sageattention has no
	// CUDA 13 support (it stops at 12.8), so the image's nvcc emitted nothing for
	// sm89/sm90 and the omission stays silent until a kernel launches. Tracked
	// upstream as video-harness#107. Measured here: the h100 dies at node 142 with
	// cudaErrorNoKernelImageForDevice while the a100 renders the same graph.
	//
	// MiniMaxH3MemoryEfficientSageAttentionPatch is gone for good. It takes a model
	// and nothing else — no toggle anywhere — and unconditionally rewrites every
	// transformer block onto the fp8+int8 path that has no sm_90 build. Nothing can
	// switch it off, so it cannot stay in a graph allowed to run on an h100.
	//
	// PathchSageAttentionKJ stays, and its mode is a PORT rather than a constant.
	// That is the whole trick: the harness carries
	// SAGE_BLACKLIST_GPU_TYPES = ["h100", "l40s"] and forces a param named exactly
	// `sage_attention` to disabled when dispatching to one of them. Its own comment
	// says the mechanism exists so a workflow need not hardcode Sage off and lose
	// it on the cards where it works. Declaring the port serves both from one
	// bundle: off on the h100, on wherever it runs.
	graph[OUR.sageKj] = {
		class_type: 'PathchSageAttentionKJ',
		inputs: { sage_attention: 'auto', allow_compile: false, model: [N.unet, 0] }
	};

	// The second patch, only where it can run.
	//
	// Tied to the card rather than deleted, because on the a100 it works and helps.
	// Deleting it outright would have quietly slowed the card that has carried
	// every render so far, to fix one it never runs on.
	if (!SAGE_BLIND.includes(CARD)) {
		graph[OUR.sageMm] = {
			class_type: 'MiniMaxH3MemoryEfficientSageAttentionPatch',
			inputs: { model: [OUR.sageKj, 0] }
		};
	}


	graph[OUR.solAttn] = {
		class_type: 'SolAttnPatch',
		inputs: {
			model: [SAGE_BLIND.includes(CARD) ? OUR.sageKj : OUR.sageMm, 0],
			tau: 1.3,
			start_percent: 0.2,
			end_percent: 0.9,
			min_tokens: 4096,
			int8_qk: QUANT_ATTN,
			sink_conditioning: 'exact_kv_and_rows',
			morton: false,
			morton_curve: '2d_frame',
			int8_pv: QUANT_ATTN,
			verbose: false,
			use_tma: false,
			dense_blocks: ''
		}
	};
	graph[OUR.sigma] = {
		class_type: 'MiniMaxH3SigmaShift',
		inputs: { model: [OUR.solAttn, 0], shift_video: 12, shift_audio: AUDIO_SHIFT }
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

	// And write the file the way our own graph writes it.
	//
	// The seventh difference, and the one this route missed for weeks. The six in
	// the header are all about how the frames are MADE; this is about how they are
	// written, and nothing in the earlier audit looked there. Their bundle ends in
	// SaveVideo with format "auto" and codec "auto", which is ComfyUI's default and
	// far more compressed than ours: measured across one finished scene, 4782 kb/s
	// for the clip and 1597 then 1287 for the two continuations joined onto it.
	// Three to four times, at a hard cut, in the middle of a scene — which is
	// exactly the "there is a cut at five seconds" that got reported and that I
	// first, wrongly, blamed on a colour tag worth less than one percent.
	//
	// VHS_VideoCombine at crf 16, the same as api/wf. Safe to reach for here: the
	// bundle already loads VHS_LoadVideoFFmpeg, so the VideoHelperSuite pack is
	// installed on the machine this runs on — that is evidence rather than hope.
	//
	// Replaced in place, keeping the node id, because the bundle's outputs section
	// names it (`node_id: "176"`) and the harness collects the artifact from
	// there. A new id would have left the harness collecting from a node that no
	// longer produces anything.
	const save = graph[N.saveVideo];
	if (save?.class_type !== 'SaveVideo') {
		throw error(500, `node ${N.saveVideo} is ${save?.class_type ?? 'missing'}, not the SaveVideo this replaces`);
	}
	const audio = create.inputs.audio;
	if (!audio) throw error(500, `node ${N.createVideo} has no audio input to carry over`);
	graph[N.saveVideo] = {
		class_type: 'VHS_VideoCombine',
		inputs: {
			images: [OUR.rife, 0],
			audio,
			// A literal rather than nothing: the fps port is rebound onto this node
			// in the yaml, but a bundle served without one must still come back at
			// the rate a clip is joined at, not at their native 24.
			frame_rate: CONT_FPS,
			loop_count: 0,
			filename_prefix: 'mmh3_cont',
			format: 'video/h264-mp4',
			pix_fmt: 'yuv420p',
			crf: 16,
			save_output: true,
			pingpong: false,
			save_metadata: false,
			trim_to_audio: false
		}
	};
	// CreateVideo is left in place and unread. Nothing consumes it now, so ComfyUI
	// will not execute it, and deleting a node the bundle's own yaml still mentions
	// is a bigger change than leaving one idle.
}

/** The seam, nailed to the frame it continues from.
 *
 *  A continuation already carries the prior clip's final frame — it goes up as
 *  ref_picture_3 and the brief names it <Picture 3> as "the frame the new clip
 *  starts from". That is a description, and the model is free to read it as
 *  guidance: the clips come back close to the frame rather than on it, which is
 *  the visible cut that gets reported at the join.
 *
 *  A keyframe is not a description. It packs the frame's latent into the
 *  sequence at frame 0 of the target, and the model resumes from it rather than
 *  near it. The two mechanisms are separate and coexist by design — refs travel
 *  on `minimax_refs`, anchors on `minimax_keyframes`, and MiniMaxH3's own
 *  layout walks the reference spans before placing the anchor so the two cannot
 *  collide.
 *
 *  Reading the node ports says the opposite, which is the trap: the node that
 *  takes first_frame takes no references and the node that takes references
 *  takes no first_frame. The anchor does not travel on a port. H3KeyframeInject
 *  puts it on conditioning that already has references, which is exactly this
 *  case, and it ships in ComfyUI-H3-Multishot — already in nodes.lock, so this
 *  adds a node rather than a dependency.
 *
 *  Only when the seam is pinned. A free start has no frame to resume from, and
 *  ref_picture_3 is a placeholder there — anchoring frame 0 to a placeholder is
 *  the one way this could make a clip strictly worse.
 *
 *  Everything it needs is already in the graph and taken from the graph rather
 *  than restated: the frame count comes from the same expression node the
 *  reference node's `length` reads, so the anchor cannot land on a clip of a
 *  different length than the one being sampled, and the frame itself is cut
 *  from the prior clip where it is already loaded.
 *
 *  That last part is the second version. The first took the frame from the
 *  loader ref_picture_3 sits on, which is the same picture and looked obvious.
 *  It failed two renders in four: that port is optional, the operator agent
 *  drops a line from the reference list every so often, and when it does the
 *  harness leaves the loader out of the graph — so the anchor's input pointed
 *  at nothing and ComfyUI rejected the whole prompt. An intermittent omission
 *  that used to cost a pin now killed the render.
 *
 *  The prior clip is a REQUIRED port and is already decoded in the graph, so
 *  its final frame is the same picture with nothing optional in the way. It is
 *  also the better frame: it is the exact one the model reads as the end of
 *  <Video 1>, rather than a separately uploaded PNG that took its own trip
 *  through an encoder.
 */
function pinSeamAnchor(graph: Graph): void {
	const guider = graph[N.guider];
	const from = guider?.inputs?.conditioning;
	if (!guider?.inputs || !Array.isArray(from) || from[0] !== N.refToVideo) {
		throw error(
			502,
			`node ${N.guider} no longer takes its conditioning from ${N.refToVideo} — the bundle has been restructured`
		);
	}
	// Every node this reads, checked by class as well as id. A renumbered graph
	// that still answers to the old id would otherwise anchor the clip to
	// whatever image happened to land on 187.
	for (const [id, cls] of [
		[N.priorVideo, 'VHS_LoadVideoFFmpeg'],
		[N.frames, 'ComfyMathExpression'],
		[N.videoVae, 'VAELoader']
	] as const) {
		if (graph[id]?.class_type !== cls) {
			throw error(
				502,
				`node ${id} is ${graph[id]?.class_type ?? 'missing'}, expected ${cls} — the bundle has been restructured`
			);
		}
	}

	// The last frame of the clip being continued, taken off the loader that is
	// already reading it for <Video 1>.
	graph[OUR.seamFrame] = {
		class_type: 'H3LastFrame',
		inputs: { images: [N.priorVideo, 0] }
	};

	graph[OUR.seam] = {
		class_type: 'H3KeyframeInject',
		inputs: {
			conditioning: [N.refToVideo, 0],
			vae: [N.videoVae, 0],
			start_image: [OUR.seamFrame, 0],
			width: [OUR.width, 0],
			height: [OUR.height, 0],
			// Slot 1 of the expression node, which is the aligned frame count the
			// reference node itself is given. The node re-aligns what it is handed
			// and aligning an aligned count changes nothing, so this stays right
			// even if the expression is edited.
			length: [N.frames, 1]
		}
	};
	guider.inputs.conditioning = [OUR.seam, 0];
}

/** The prior clip's own soundtrack, carried in as a reference.
 *
 *  A continuation already hands the model the prior clip as <Video 1>, and
 *  throws its audio away: the loader returns sound on slot 2 and nothing reads
 *  it. So the only thing tying one clip's voices to the next is the sentence the
 *  writer copies forward — "a light clear adult female voice, neutral accent" —
 *  and a sentence is a description. Each clip is an independent roll, so the
 *  same words come back as a different woman often enough that the check has a
 *  rule about naming a voice at all.
 *
 *  The reference node has taken audio all along. `ref_video_audios` is
 *  index-paired with `ref_videos`, so the prior clip's sound belongs on
 *  `ref_video_audio_0` beside `ref_video_0`, and H3ReferenceAudio is the pack's
 *  own preparation step for it: batch item 0, mono duplicated up to stereo,
 *  resampled to the audio VAE's 32 kHz, trimmed. The stereo part is not a
 *  nicety — a mono reference crashes the sampler.
 *
 *  Five seconds rather than the node's ten. Reference rows sit in the packed
 *  sequence for every sampling step rather than being read once, so the length
 *  is paid for on each of them, and a voice does not need ten seconds to be
 *  recognisable.
 *
 *  Unconditional: a free start still continues the same scene with the same
 *  people, and it is their voices this is for.
 */
/** Back to the node's own default.
 *
 *  Five was ours, taken for the reason above: reference rows are paid on every
 *  sampling step. That reasoning still holds and the cost is still real — but it
 *  was traded against a voice that sounded right, and at four sampling steps it
 *  no longer does. Audio rows are thin next to a frame of video, so this is the
 *  cheapest of the three things being tried against the metallic voice. */
const CONT_REF_AUDIO_SECONDS = 5;

function carryPriorAudio(graph: Graph): void {
	const loader = graph[N.priorVideo];
	if (loader?.class_type !== 'VHS_LoadVideoFFmpeg') {
		throw error(
			502,
			`node ${N.priorVideo} is ${loader?.class_type ?? 'missing'}, not the loader the prior clip's audio comes off`
		);
	}
	const ref = graph[N.refToVideo];
	if (!ref?.inputs) throw error(500, `the continuation graph has no node ${N.refToVideo}`);
	// Index-paired: the soundtrack of ref_video_0. Anchored on the video actually
	// being there, because an audio reference paired with nothing is a label the
	// prompt names and the model cannot find.
	if (!ref.inputs['ref_videos.ref_video_0']) {
		throw error(502, `the continuation graph no longer feeds the prior clip to ref_video_0`);
	}

	// Its own loader, reading the clip whole, rather than slot 2 of the video
	// loader next door.
	//
	// The two used to be the same node, and then the video reference was trimmed
	// to its last second for speed — which silently trimmed the voice reference
	// with it, from the five seconds asked for below to one. The continuations
	// came back metallic. The reference is what carries the voice: the same
	// source clip rendered 352 and 386 Hz written from a description against 262
	// with the audio attached, and one second is near enough to none.
	//
	// Separate rather than conditional on the trim, so the graph always matches
	// the port the manifest declares. It costs a decode on the worker and no
	// tokens at all: only slot 2 is wired, and the sequence is billed for
	// reference IMAGES, which this node's are not — they go nowhere.
	if (OWN_AUDIO_LOADER) {
		graph[OUR.refAudioSrc] = {
			class_type: 'VHS_LoadVideoFFmpeg',
			inputs: { ...loader.inputs, start_time: 0, frame_load_cap: 0 }
		};
	}
	graph[OUR.refAudio] = {
		class_type: 'H3ReferenceAudio',
		inputs: {
			audio: OWN_AUDIO_LOADER ? [OUR.refAudioSrc, 2] : [N.priorVideo, 2],
			max_seconds: CONT_REF_AUDIO_SECONDS
		}
	};
	ref.inputs['ref_video_audios.ref_video_audio_0'] = [OUR.refAudio, 0];
}

/** Read only the tail of the prior clip as the reference video.
 *
 *  The same argument as the audio cap above, and a much bigger bill. A reference
 *  row sits in the packed sequence for every sampling step, so the whole clip
 *  going in meant paying for all of it eight times over. Measured: a 576p
 *  continuation took 507s where a direct render of the same size, steps and card
 *  took 128s — and at 864p the same arithmetic put the render past the harness's
 *  liveness window, which killed it at thirty minutes with nothing produced.
 *
 *  Moved rather than capped. `frame_load_cap` would take the FIRST frames of the
 *  window, and the end is the half that matters: the new clip picks up the motion
 *  where the old one stopped, and H3LastFrame takes the pinned seam's frame off
 *  this same loader. Leaving the cap at zero means the read still runs to the
 *  true end of the clip, so the anchor frame is the one it has always been.
 *
 *  Wired as a literal rather than through the `prior_clip_start_time` port. The
 *  port stays declared for anyone driving the bundle by hand, but the studio
 *  computes this from the clip it is continuing, and a port default arriving
 *  behind us would quietly put the window back to the whole clip.
 */
function trimPriorVideo(graph: Graph, startSec: number): void {
	const loader = graph[N.priorVideo];
	if (loader?.class_type !== 'VHS_LoadVideoFFmpeg') {
		throw error(
			502,
			`node ${N.priorVideo} is ${loader?.class_type ?? 'missing'}, not the prior clip's loader`
		);
	}
	if (!loader.inputs) throw error(500, `node ${N.priorVideo} has no inputs`);
	loader.inputs.start_time = startSec;
	loader.inputs.frame_load_cap = 0;
}

/** Drop the two reference slots the studio never fills.
 *
 *  The bundle wires five reference images and feeds `placeholder.png` to any the
 *  operator did not supply — the bundle's own comment says why: it "keeps
 *  ComfyUI validation happy". The prompt then omits <Picture 4> and <Picture 5>
 *  so the model makes nothing of them. But omitting them from the PROMPT is not
 *  the same as leaving them out of the SEQUENCE: a reference row is packed into
 *  the conditioning and paid for on every sampling step whether a word points at
 *  it or not. Two rows of nothing, eight times over.
 *
 *  The studio has never had a way to fill these, so they are removed rather than
 *  made conditional. Their ports go with them in the yaml — a binding to a node
 *  that is gone is worse than the slot it replaced.
 */
function dropUnusedRefSlots(graph: Graph): void {
	const ref = graph[N.refToVideo];
	if (!ref?.inputs) throw error(500, `the continuation graph has no node ${N.refToVideo}`);
	for (const [node, key] of [
		[N.refPic4, 'ref_images.ref_image_3'],
		[N.refPic5, 'ref_images.ref_image_4']
	] as const) {
		// Anchored: if the bundle stops wiring these, the shape has changed enough
		// that quietly doing nothing would be the wrong answer.
		const wired = ref.inputs[key];
		if (!Array.isArray(wired) || wired[0] !== node) {
			throw error(502, `${key} no longer comes from node ${node} — the bundle has been restructured`);
		}
		delete ref.inputs[key];
		delete graph[node];
	}
}

async function fetchBundle(file: 'workflow.json' | 'workflow.yaml'): Promise<string> {
	const res = await fetch(`${REPO}/${BUNDLE}/${file}`, { signal: AbortSignal.timeout(30_000) });
	if (!res.ok) throw error(502, `the continuation bundle answered ${res.status} for ${file}`);
	return await res.text();
}

async function buildJson(
	entries: ReturnType<typeof stack>,
	pinned: boolean,
	refStart: number | null
): Promise<string> {
	const graph = JSON.parse(await fetchBundle('workflow.json')) as Graph;
	fitOurModelPath(graph, entries);
	// Before the anchor, which reads the width and height nodes this creates.
	fitOurOutputShape(graph);
	carryPriorAudio(graph);
	// After the audio, which anchors on ref_video_0 still being wired, and before
	// the seam, which reads its frame off this same loader.
	if (refStart !== null && refStart > 0) trimPriorVideo(graph, refStart);
	if (DROP_SLOTS) dropUnusedRefSlots(graph);
	if (pinned) pinSeamAnchor(graph);
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

/** Remove one input port block from their yaml, with the node it bound to gone.
 *
 *  Line-based rather than a parse: the file is theirs, it is fetched live, and a
 *  round trip through a YAML library would reformat every line of it and make
 *  the next upstream diff unreadable. A block runs from its `- name:` to the
 *  next one, or to the end of the inputs list. */
function dropPortBlock(yaml: string, port: string): string {
	const lines = yaml.split('\n');
	const head = lines.findIndex((l) => l.trim() === `- name: ${port}`);
	if (head < 0) throw error(502, `the continuation bundle no longer declares a ${port} port`);
	const indent = lines[head].length - lines[head].trimStart().length;
	let tail = head + 1;
	while (tail < lines.length) {
		const l = lines[tail];
		const isNext = l.trim().startsWith('- name: ') && l.length - l.trimStart().length === indent;
		const isOut = l.trim().length > 0 && l.length - l.trimStart().length < indent;
		if (isNext || isOut) break;
		tail++;
	}
	return [...lines.slice(0, head), ...lines.slice(tail)].join('\n');
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
	// a100, and not h100 — tried, 2026-08-27.
	//
	// The card looked worth testing once the idle timeout landed: a warm 5s
	// continuation measured 458s and 455s against 730s and 728s cold, so most of
	// what remained was arithmetic rather than model loading, and that is the part
	// an h100 does roughly twice as fast.
	//
	// It cannot run this graph any more, and that is a REGRESSION rather than a
	// gap: the operator had rendered whole productions on the h100 before, and
	// moved to the a100 only because it showed no speed advantage — which is
	// exactly what a cold-start-dominated workload would look like.
	//
	// The render now fails in 147s with "CUDA error: no kernel image is available
	// for execution on the device". The a100 runs the same graph on the same
	// endpoints, deployed in the same pass, so the compute image simply carries no
	// sm_90 kernels — a TORCH_CUDA_ARCH_LIST at build time, not a setting here.
	// It arrived with the compute image this project upgraded to today
	// (cu13 / comfy 0.32.0). The endpoint deploys and can run nothing.
	out = out.replace(gpu, `gpu_types: [${CARD}]`);

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
	// The fps port drives whichever node writes the file, and that is no longer
	// theirs. buildJson replaces node 176 with a VHS_VideoCombine at crf 16 — see
	// the note there — so the binding has to follow it or the render comes back at
	// their native 24 and cannot be joined to the clip it continues.
	const fpsBinding = 'binding: fps@' + N.createVideo;
	if (!out.includes(fpsBinding)) {
		throw error(502, `the continuation bundle no longer binds fps to ${N.createVideo} — it has been restructured`);
	}
	out = out.replace(fpsBinding, `binding: frame_rate@${N.saveVideo}`);

	// The rest of the fps port, which the binding alone left lying.
	//
	// It arrives required, defaulting to 24, described as "no RIFE interpolation —
	// output is exactly this FPS". All three are false of the graph we serve: RIFE
	// doubles the frames, and a continuation at 24 cannot be joined to the 48 fps
	// clip it continues. The harness oplog shows the operator agent doing exactly
	// what the port tells it — `"fps":24` in the dispatch — and the render profile
	// overriding it to 48 afterwards, which is why the finished clips are right.
	//
	// That is a rescue, not a design. It holds only while the profile carries an
	// fps, and the profile is looked up by quality tier while the continuation
	// workspace declares one tier. Our own bundle does not rely on it: there the
	// port is optional and defaults to 48. Same here now, so the graph literal is
	// a real floor rather than something the port routinely overwrites.
	const fpsRequired = '\n      required: true\n      default: 24\n';
	if (!out.includes(fpsRequired)) {
		throw error(502, 'the continuation bundle no longer declares fps as required/24 — it has been restructured');
	}
	out = out.replace(fpsRequired, `\n      required: false\n      default: ${CONT_FPS}\n`);

	const fpsWords =
		'"Output video frame rate in FPS. Default 24 matches the model\'s native rate. No RIFE interpolation — output is exactly this FPS."';
	if (!out.includes(fpsWords)) {
		throw error(502, 'the continuation bundle no longer describes fps the way this rewrites — it has been restructured');
	}
	out = out.replace(
		fpsWords,
		`"Output video frame rate. ${CONT_FPS} is the model's native 24 through RIFE 2x, and must match the clip being continued or the two cannot be joined."`
	);

	// The one anchor that lives in the other file. buildJson replaces node 176 in
	// place precisely because this names it, so if their outputs section ever
	// points somewhere else the swap would write a file nothing collects — a
	// render that succeeds and delivers nothing, which reads as a failed render.
	if (!out.includes(`node_id: "${N.saveVideo}"`)) {
		throw error(502, `the continuation bundle no longer takes its output from node ${N.saveVideo} — it has been restructured`);
	}

	const outputs = '\n  outputs:';
	if (!out.includes(outputs)) {
		throw error(502, 'the continuation bundle has no outputs: section — it has been restructured');
	}
	const added =
		`    - name: sage_attention\n` +
		`      kind: string\n` +
		`      description: "SageAttention mode. Left to the harness, which forces it to disabled on the cards whose compute image has no sm89/sm90 kernels and leaves it alone elsewhere."\n` +
		`      binding: sage_attention@${OUR.sageKj}\n` +
		`      required: false\n` +
		`      default: auto\n` +
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

	// The audio loader's own file, declared as an INPUT and not a param.
	//
	// The distinction is the whole of it: `inputs` are media the harness fetches
	// and stages onto the worker, `params` are values it passes through. Declared
	// among the params — which is where the block above lands, since it is spliced
	// in before `outputs:` — the loader was handed the S3 URL as a string and
	// rejected it: "Invalid video file: https://…". Twice, because the first
	// diagnosis blamed the two ports sharing one link and gave them separate
	// uploads, which changed the url in the error message and nothing else.
	if (!OWN_AUDIO_LOADER) return out;
	const params = '\n  params:';
	if (!out.includes(params)) {
		throw error(502, 'the continuation bundle has no params: section — it has been restructured');
	}
	out = out.replace(
		params,
		`\n    - name: prior_clip_audio\n` +
			`      kind: video\n` +
			`      description: "The same clip as prior_clip, read whole and used for its soundtrack only. The voice reference wants five seconds; the video reference is deliberately shorter, and the two come off different loaders so one cannot trim the other."\n` +
			`      binding: video@${OUR.refAudioSrc}\n` +
			`      required: false\n` +
			params
	);

	// The slots dropped from the graph, dropped from the contract too.
	out = dropPortBlock(dropPortBlock(out, 'ref_picture_4'), 'ref_picture_5');

	return out;
}

export const GET: RequestHandler = async ({ params, url }) => {
	const entries = stack(parsePicks(params.sel ?? ''), parseBaseOverrides(params.sel ?? ''));
	const file = params.file ?? '';

	if (file === 'workflow.json') {
		return text(
			await buildJson(entries, parsePinSeam(params.sel ?? ''), parseRefStart(params.sel ?? '')),
			{
				headers: { 'content-type': 'application/json' }
			}
		);
	}
	if (file === 'workflow.yaml' || file === 'workflow.yml') {
		return text(absoluteGraphUrl(await buildYaml(entries), url), {
			headers: { 'content-type': 'text/yaml' }
		});
	}
	throw error(404, 'a continuation bundle is workflow.yaml and workflow.json');
};
