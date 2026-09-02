/** One face, cheaply — the same face the sheet will give you.
 *
 *  A character sheet costs about three minutes, and almost none of it is
 *  drawing: measured, twelve of its one hundred and seventy-five seconds are
 *  sampling and the rest is reading 56.7 GB of weights into VRAM. That makes
 *  hunting for a face expensive in the one way that matters — five attempts is
 *  fifteen minutes of waiting for a picture you will mostly reject.
 *
 *  So this serves the front half of that workflow and stops. The sheet renders a
 *  KREA-2 still and then feeds it to MiniMax H3 as the first frame of a 124-frame
 *  orbit; everything downstream of that still is what costs the money. Cut there
 *  and you keep the still, and you drop the entire H3 model suite with it:
 *
 *    character sheet   Krea2 + H3 + Qwen3-VL-32B + three VAEs   56.7 GB
 *    this              Krea2 + Qwen3-VL-4B + one VAE            17.1 GB
 *
 *  Thirty percent of the load, and load is what the clock is.
 *
 *  The important property is not the speed though — it is that the preview is
 *  the same picture. Same unet, same text encoder, same VAE, same sampler
 *  settings, same node ids, so the same seed and the same description produce the
 *  same anchor the sheet would have produced. That is the whole reason this is
 *  carved out of the sheet's own graph rather than pointed at the plain
 *  `krea2_base_realism` workflow sitting in the repo: that one runs
 *  `krea2_raw_bf16` with the turbo adapter bolted on beside it, a different text
 *  encoder and a different sampler node. It would render a person, quickly, and
 *  that person would not be the one the sheet then gave you — which is worse than
 *  no preview at all.
 *
 *  Both files are derived from upstream at request time, so Hannes's changes to
 *  the sheet reach the preview too and the two cannot drift apart.
 */
import { error, text } from '@sveltejs/kit';
import { absoluteGraphUrl } from '../../../../bundle.server';
import type { RequestHandler } from './$types';

const REPO = 'https://raw.githubusercontent.com/almoehi/auteur-library/refs/heads/main/workflows';

/** Both sheet workflows are built the same way — a KREA-2 still, then an H3
 *  orbit over it — so the same cut works on both. They even use the same node
 *  ids. The one structural difference is node 80: the character sheet appends a
 *  neutral grey studio backdrop to the description, and a location does not,
 *  because a location IS the backdrop.
 *
 *  Our own names, because the harness refuses a bundle whose `name` disagrees
 *  with the workspace entry that asked for it — and because these are genuinely
 *  different workflows from the ones they are cut out of. */
const KINDS = {
	character: {
		source: 'krea2_character_sheet',
		name: 'krea2_character_anchor',
		port: 'prompt_character',
		keep: ['10', '20', '21', '22', '25', '26', '27', '28', '29', '75', '80'],
		subject: 'the described person on a neutral grey studio backdrop',
		portNote:
			'Character description — physical appearance, clothing and expression in plain English. Do not describe a backdrop; the workflow applies a neutral grey studio backdrop itself.',
		example:
			'A photography of full body of a beautiful blonde american woman with blue eyes age 25 with beautiful body shape wearing a beautiful dress.'
	},
	location: {
		source: 'krea2_location_sheet',
		name: 'krea2_location_anchor',
		port: 'prompt_location',
		keep: ['10', '20', '21', '22', '25', '26', '27', '28', '29', '75'],
		subject: 'the described place, with no people in it',
		portNote:
			'Plain-English description of the location — architecture, materials, lighting, atmosphere and distinctive spatial details. No people.',
		example:
			'A moonlit stone courtyard ringed by tall cypress trees, worn flagstones, a dry central fountain'
	}
} as const;

type Kind = keyof typeof KINDS;

/** The nodes the anchor image depends on, resolved by walking back from the
 *  VAEDecode that produces it, plus the SaveImage that writes it out.
 *
 *    10  the description            80  the backdrop suffix concatenated onto it
 *    20  Krea2 unet                 21  Qwen3-VL-4B text encoder
 *    22  Qwen image VAE             25  CLIPTextEncode
 *    26  ConditioningZeroOut        27  EmptyLatentImage (width, height)
 *    28  KSampler (steps, seed)     29  VAEDecode
 *    75  SaveImage
 *
 *  Listed rather than recomputed: a graph walk would quietly follow whatever
 *  upstream adds next, and the point of this file is that it stays small. If the
 *  set no longer resolves, that is a change worth looking at by hand.
 */
const KEEP = ['10', '20', '21', '22', '25', '26', '27', '28', '29', '75', '80'];

/** Same tier as the sheet.
 *
 *  h100 by request, and the measurement says it buys nothing. Six warm previews
 *  of one description on 2026-08-29, three per card: h100 9.31 / 9.63 / 9.52s,
 *  l40s 9.48 / 9.55 / 9.21s. Identical inside the noise, because this render is
 *  almost entirely file reading and the card only matters to the part that is
 *  not. The cold number is the one that moves — 25.4s on the first h100 run,
 *  while the models were fetched onto that card's volume.
 *
 *  So this line is a cost decision, not a speed one. Put it back to l40s to
 *  spend less for the same 9.5 seconds. */
const PIN = 'h100';

const CACHE = new Map<string, { at: number; body: string }>();
const CACHE_MS = 10 * 60 * 1000;

async function upstream(kind: Kind, file: string, fetch: typeof globalThis.fetch): Promise<string> {
	const src = KINDS[kind].source;
	const key = `${src}/${file}`;
	const hit = CACHE.get(key);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
	const res = await fetch(`${REPO}/${src}/${file}`);
	if (!res.ok) throw error(502, `could not fetch ${key} — upstream said ${res.status}`);
	const body = await res.text();
	CACHE.set(key, { at: Date.now(), body });
	return body;
}

/** One model block, lifted verbatim from the source bundle.
 *
 *  Copied rather than written out here so the URLs and checksums stay upstream's
 *  business. A model declared with the wrong sha256 fails at download, minutes
 *  in, on the GPU. */
function modelBlock(kind: Kind, src: string, name: string): string {
	const from = src.indexOf('\nmodels:');
	if (from < 0) throw error(500, `${KINDS[kind].source} has no models stanza`);
	const re = new RegExp(
		`^  - name: ${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n(?:.*\\n)*?(?=^  - name: |^\\\\w|\\\\Z)`,
		'm'
	);
	const m = re.exec(src.slice(from));
	if (!m) throw error(500, `${KINDS[kind].source} no longer declares the model "${name}" — the preview cannot match the sheet`);
	return m[0].trimEnd();
}

function buildYaml(kind: Kind, src: string): string {
	const k = KINDS[kind];
	return `# Generated. The front half of ${k.source}: the KREA-2 anchor still, without
# the MiniMax H3 orbit that turns it into six views. Edit
# webui/src/routes/studio/api/anchorwf/[file]/+server.ts, not this.

name: ${k.name}
description: >
  Renders the single KREA-2 anchor image that ${k.source} is built from — one
  view of ${k.subject}. Identical model, sampler and seed handling to that
  workflow, so the same description and seed produce the same picture the full
  sheet would. Best for finding what you want before paying for the six-view
  version. Not suitable as a reference for video workflows, which require the
  sheet.
url: workflow.json
workflow_type: t2i
model_family: krea2
gpu_types: [${PIN}]

ports:
  params:
    - name: ${k.port}
      kind: string
      description: ${JSON.stringify(k.portNote)}
      binding: value@10
      required: true
      default: ${JSON.stringify(k.example)}
    - name: width
      kind: int
      description: "Image width in pixels. Must be divisible by 16."
      binding: width@27
      constraints: { min: 256, max: 2048 }
      required: true
      default: 1920
    - name: height
      kind: int
      description: "Image height in pixels. Must be divisible by 16."
      binding: height@27
      constraints: { min: 256, max: 2048 }
      required: true
      default: 1080
    - name: steps
      kind: int
      description: "Denoising steps. 6-10 gives good quality; 8 is the recommended default and is what the full sheet uses."
      binding: steps@28
      constraints: { min: 1, max: 30 }
      required: true
      default: 8
    - name: seed
      kind: int
      description: "Random seed. Pass the same seed to ${k.source} to get the same picture in the full sheet."
      binding: seed@28
      seed: true
      required: false
      default: 0

  outputs:
    - name: anchor_image
      kind: image
      description: "The rendered anchor image."
      node_id: "75"
      role: primary

models:
${modelBlock(kind, src, 'Krea2_Turbo_convrot_int8mixed')}

${modelBlock(kind, src, 'qwen3vl_4b_fp8_scaled')}

${modelBlock(kind, src, 'qwen_image_vae')}
`;
}

function buildJson(kind: Kind, src: string): string {
	const full = JSON.parse(src) as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const id of KINDS[kind].keep) {
		if (!full[id]) {
			throw error(
				500,
				`node ${id} has gone from ${KINDS[kind].source} — the anchor branch has been restructured upstream and this needs re-cutting by hand`
			);
		}
		out[id] = full[id];
	}
	// Nothing is rewired. Every kept node's inputs already point only at other
	// kept nodes — that is what walking back from the anchor established — so the
	// subgraph runs exactly as it does inside the full sheet.
	return JSON.stringify(out, null, 2);
}

export const GET: RequestHandler = async ({ params, fetch, url }) => {
	const kind = params.kind as Kind;
	if (!KINDS[kind]) throw error(404, 'an anchor is either a character or a location');
	if (params.file === 'workflow.json') {
		return text(buildJson(kind, await upstream(kind, 'workflow.json', fetch)), {
			headers: { 'content-type': 'application/json' }
		});
	}
	if (params.file === 'workflow.yaml' || params.file === 'workflow.yml') {
		return text(absoluteGraphUrl(buildYaml(kind, await upstream(kind, 'workflow.yaml', fetch)), url), {
			headers: { 'content-type': 'text/yaml' }
		});
	}
	throw error(404, 'a bundle is workflow.yaml and workflow.json');
};
