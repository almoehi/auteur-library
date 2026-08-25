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
import type { RequestHandler } from './$types';

const REPO = 'https://raw.githubusercontent.com/almoehi/auteur-library/refs/heads/main/workflows';
const SOURCE = 'krea2_character_sheet';

/** Our own name, because the harness refuses a bundle whose `name` disagrees
 *  with the workspace entry that asked for it — and because this is genuinely a
 *  different workflow from the one it is cut out of. */
const NAME = 'krea2_character_anchor';

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

/** Same tier as the sheet, and for the same reason: measured, the card makes no
 *  difference to a render that is almost entirely file reading. */
const PIN = 'l40s';

const CACHE = new Map<string, { at: number; body: string }>();
const CACHE_MS = 10 * 60 * 1000;

async function upstream(file: string, fetch: typeof globalThis.fetch): Promise<string> {
	const hit = CACHE.get(file);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
	const res = await fetch(`${REPO}/${SOURCE}/${file}`);
	if (!res.ok) throw error(502, `could not fetch ${SOURCE}/${file} — upstream said ${res.status}`);
	const body = await res.text();
	CACHE.set(file, { at: Date.now(), body });
	return body;
}

/** One model block, lifted verbatim from the source bundle.
 *
 *  Copied rather than written out here so the URLs and checksums stay upstream's
 *  business. A model declared with the wrong sha256 fails at download, minutes
 *  in, on the GPU. */
function modelBlock(src: string, name: string): string {
	const from = src.indexOf('\nmodels:');
	if (from < 0) throw error(500, `${SOURCE} has no models stanza`);
	const re = new RegExp(
		`^  - name: ${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\n(?:.*\\n)*?(?=^  - name: |^\\\\w|\\\\Z)`,
		'm'
	);
	const m = re.exec(src.slice(from));
	if (!m) throw error(500, `${SOURCE} no longer declares the model "${name}" — the preview cannot match the sheet`);
	return m[0].trimEnd();
}

function buildYaml(src: string): string {
	return `# Generated. The front half of ${SOURCE}: the KREA-2 anchor still, without
# the MiniMax H3 orbit that turns it into six views. Edit
# webui/src/routes/studio/api/anchorwf/[file]/+server.ts, not this.

name: ${NAME}
description: >
  Renders the single KREA-2 anchor image that a character sheet is built from —
  one full-body front view of the described person on a neutral grey studio
  backdrop. Identical model, sampler and seed handling to krea2_character_sheet,
  so the same description and seed produce the same face the full sheet would.
  Best for finding a character before paying for the six-view turnaround. Not
  suitable as a character reference for video workflows, which require the sheet.
url: workflow.json
workflow_type: t2i
model_family: krea2
gpu_types: [${PIN}]

ports:
  params:
    - name: prompt_character
      kind: string
      description: "Character description — physical appearance, clothing and expression in plain English. Do not describe a backdrop; the workflow applies a neutral grey studio backdrop itself."
      binding: value@10
      required: true
      default: "A photography of full body of a beautiful blonde american woman with blue eyes age 25 with beautiful body shape wearing a beautiful dress."
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
      description: "Random seed. Pass the same seed to krea2_character_sheet to get the same face in the full turnaround."
      binding: seed@28
      seed: true
      required: false
      default: 0

  outputs:
    - name: anchor_image
      kind: image
      description: "The rendered character on a neutral grey studio backdrop."
      node_id: "75"
      role: primary

models:
${modelBlock(src, 'Krea2_Turbo_convrot_int8mixed')}

${modelBlock(src, 'qwen3vl_4b_fp8_scaled')}

${modelBlock(src, 'qwen_image_vae')}
`;
}

function buildJson(src: string): string {
	const full = JSON.parse(src) as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const id of KEEP) {
		if (!full[id]) {
			throw error(
				500,
				`node ${id} has gone from ${SOURCE} — the anchor branch has been restructured upstream and this needs re-cutting by hand`
			);
		}
		out[id] = full[id];
	}
	// Nothing is rewired. Every kept node's inputs already point only at other
	// kept nodes — that is what walking back from the anchor established — so the
	// subgraph runs exactly as it does inside the full sheet.
	return JSON.stringify(out, null, 2);
}

export const GET: RequestHandler = async ({ params, fetch }) => {
	if (params.file === 'workflow.json') {
		return text(buildJson(await upstream('workflow.json', fetch)), {
			headers: { 'content-type': 'application/json' }
		});
	}
	if (params.file === 'workflow.yaml' || params.file === 'workflow.yml') {
		return text(buildYaml(await upstream('workflow.yaml', fetch)), {
			headers: { 'content-type': 'text/yaml' }
		});
	}
	throw error(404, 'a bundle is workflow.yaml and workflow.json');
};
