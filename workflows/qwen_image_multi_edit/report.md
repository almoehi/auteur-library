# Conversion Report: `qwen_image_multi_edit`

**Recommended GPU:** `rtx3090` (24 GB VRAM) — GGUF Q4_K_S quant keeps VRAM low; `rtx4090`/`l40s` also listed as fallback tiers.

**Total model download:** ~23.3 GB (12.4 GB UNet GGUF + 9.4 GB CLIP + 0.85 GB LoRA + 0.25 GB VAE)

## Converter run notes

- `REGISTRY` env var defaults to `docker.io/almoehi/video-harness`, which does not exist locally.
  Run with `REGISTRY=docker.io/almoehi/auteur TAG=latest` to match the locally built fat image
  (`almoehi/auteur:latest`).
- Source is UI-format, 26 nodes, no UUID subgraph nodes — Step 1b (UUID boundary audit) does not apply.
- Converter integrity check: OK.

## Ports (corrected — converter's auto-mapping was wrong, see below)

Also renamed `positive_prompt`/`negative_prompt` → `prompt_positive`/`prompt_negative` — the skill's
naming convention requires the `prompt_xxxx` prefix form for every text-prompt port; the converter
emitted the suffix form.

| Port | Kind | Role / Default | Binding | Status |
|---|---|---|---|---|
| reference_image_1 | image | input (Picture 1 / main-anchor) | image@2 | ✓ corrected |
| reference_image_2 | image | input (Picture 2) | image@1 | ✓ corrected |
| reference_image_3 | image | input (Picture 3) | image@24 | ✓ corrected |
| prompt_positive | string | param, required | prompt@10 | ✓ |
| prompt_negative | string | param (default provided) | text@21 | ✓ |
| steps | int | param (default: 8) | steps@17 | ✓ |
| cfg | float | param (default: 1) | cfg@17 | ✓ |
| seed | int | param (default: -1) | seed@17 | ✓ |
| edited_image | image | output (primary) | node 30 | ✓ renamed from `save_image` |

**Bug found and fixed — image port ↔ "Picture N" mismatch.** The converter's auto-generated port
bindings (`reference_image→image@1`, `reference_image_2→image@24`, `reference_image_3→image@2`) do
**not** match the "Picture 1/2/3" positions the workflow's own prompt and node titles use. Traced
the actual chain via `workflow.json`:

- Node 13 (`QwenEditConfigPreparer`, `image=['2',0]`, `ref_main_image=True`) is the base of the
  `configs` chain — becomes `configs[0]`.
- Node 16 (`image=['1',0]`, `configs=['13',0]`) appends next — becomes `configs[1]`.
- Node 26 (`image=['24',0]`, `configs=['16',0]`) appends last — becomes `configs[2]`.

`TextEncodeQwenImageEditPlusCustom_lrzjason.encode()` labels images as `"Picture {i+1}"` by
`enumerate(configs)` index (confirmed by reading `nodes.py` in the pinned custom node repo — see
below). So **Picture 1 = image@2, Picture 2 = image@1, Picture 3 = image@24** — independently
confirmed by the original author's own `_meta.title` values on those `LoadImage` nodes: node 2 =
"Main image", node 1 = "Image 2", node 24 = "Image 3". Ports were renamed
`reference_image_1/2/3` and rebound accordingly; had this shipped with the converter's default
mapping, every caller-supplied "Picture 2" instruction would have silently applied to the wrong
input image.

## Models — corrected (converter missed the base UNet entirely)

**Bug found and fixed — the actual diffusion model was missing from `models:`.** The converter's
model resolution step only found the VAE, CLIP, and LoRA — it never emitted an entry for
`qwen-image-edit-2511-Q4_K_S.gguf` (the `LoaderGGUF` node's `gguf_name` input), which is the base
UNet and the largest file (12.4 GB). Without it, every render would fail with `MissingModelError`
regardless of a "clean" pre-flight check (see the `⚠ Unchecked Model Keys` section below for why
pre-flight wouldn't have caught it either). Added manually.

Also swapped the VAE and CLIP URLs from the converter's auto-discovered mirrors (`zhenshipo`,
`fangg2000`, medium/unknown confidence) to the canonical `Comfy-Org/Qwen-Image_ComfyUI` repo —
same files, verified by matching SHA256.

| Filename | Type | Source | SHA256 verified |
|---|---|---|---|
| qwen-image-edit-2511-Q4_K_S.gguf | unet | `unsloth/Qwen-Image-Edit-2511-GGUF` | ✓ |
| qwen_image_vae.safetensors | vae | `Comfy-Org/Qwen-Image_ComfyUI` | ✓ |
| qwen_2.5_vl_7b_fp8_scaled.safetensors | clip | `Comfy-Org/Qwen-Image_ComfyUI` | ✓ |
| Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors | lora | `lightx2v/Qwen-Image-Edit-2511-Lightning` | ✓ |

All four URLs return HTTP 200 and all four `sha256` fields are real (fetched from HF LFS pointers),
replacing the converter's `"TODO"` placeholders.

## Custom Nodes — corrected (converter reported "No custom nodes detected")

Known converter bug (per skill doc) — hit here. Classified manually via `cnr_id` in the source UI
JSON's node `properties` and cross-referenced against the ComfyUI Registry API
(`api.comfy.org/nodes/<id>`):

| class_type | cnr_id | Repository | Commit | Route |
|---|---|---|---|---|
| `QwenEditConfigPreparer`, `QwenEditAdaptiveLongestEdge`, `TextEncodeQwenImageEditPlusCustom_lrzjason` | `qweneditutils` | `github.com/lrzjason/Comfyui-QwenEditUtils` | `cdd4d028c6491d27a40092d7795158668cec9189` | `customNodes` |
| `LoaderGGUF` (source workflow) | `gguf` | `github.com/calcuis/gguf` | — | **replaced, see below** |

**`LoaderGGUF` swapped for the already-pinned `city96/ComfyUI-GGUF` loader — no new custom node
needed.** The source workflow's `LoaderGGUF` node comes from `calcuis/gguf`, a *different* package
from `city96/ComfyUI-GGUF` (which only exports `UnetLoaderGGUF`/`UnetLoaderGGUFAdvanced`/etc. — no
`LoaderGGUF` class) already pinned in `nodes.lock` at `6ea2651e7df66d7585f6ffee804b20e92fb38b8a`.
Investigated whether the existing pinned loader could be reused instead of adding a second GGUF
package, by diffing both repos' source at the pinned SHAs:

- **city96's `loader.py` already lists `qwen_image` in its `IMG_ARCH_LIST`** (the set of
  architectures its GGUF reader validates against) — Qwen-Image is explicitly first-class supported,
  not something requiring calcuis's fork.
- For **UNet loading specifically** (as opposed to CLIP/LLM text-encoder GGUF loading, where the two
  packages do differ — key remapping tables for T5/Llama/Gemma tokenizer conventions), both
  packages' code paths are functionally identical: strip the `model.diffusion_model.` prefix, apply
  no architecture-specific key remapping (calcuis's own UNet path, `pig_work`, is a no-op passthrough
  — the same as city96's), dequantize using the same Q4_K block-dequant algorithm (both support the
  full K-quant family: Q2_K–Q6_K, IQ*), then hand off to the same
  `comfy.sd.load_diffusion_model_state_dict()`. The GGUF container format itself is a standardized,
  cross-implementation binary format — the `.gguf` file is byte-identical regardless of which loader
  reads it.
- The only differences are cosmetic: class name (`LoaderGGUF` vs `UnetLoaderGGUF`), input key
  (`gguf_name` vs `unet_name`), and folder alias (`model_gguf` vs `unet_gguf`) — both ultimately
  resolve to the same `models/unet/` directory.
- calcuis/gguf is a much larger, differently-scoped toolkit (its own vendored `gguf_connector`
  reader/writer/quantizer, tokenizer reconstruction for a dozen LLM architectures, vision/mmproj
  support) — none of which this workflow uses; only its single UNet-loader node was needed, which
  city96 already covers.

**Fix applied:** patched `workflow.json` node `3` — `class_type: LoaderGGUF → UnetLoaderGGUF`,
`inputs.gguf_name → inputs.unet_name` (value unchanged). Removed the `gguf` entry from
`customNodes:` in `workflow.yaml`. **Bonus:** this also fully resolves the `⚠ Unchecked Model Keys`
gap below — `unet_name` is already in `MODEL_KEYS` (`gguf_name` was not), so the pre-flight
missing-model check now covers this model too, with zero changes to `serverless-comfy`.

All other node classes (`CFGNorm`, `ModelSamplingAuraFlow`, `LoraLoaderModelOnly`, `CLIPLoader`,
`VAELoader`, `CLIPTextEncode`, `KSampler`, `VAEDecode`, `LoadImage`, `SaveImage`) have
`cnr_id: comfy-core` — confirmed ComfyUI built-ins, no node package needed.

## Widget completeness (Step 1c)

`QwenEditConfigPreparer`, `QwenEditAdaptiveLongestEdge`, and
`TextEncodeQwenImageEditPlusCustom_lrzjason` all use legacy `INPUT_TYPES()` (not `io.Schema`) at the
pinned SHA — low risk per the skill's risk table. Checked all `required` inputs against
`workflow.json`: all present. No default-injection needed.

## ⚠ Unchecked Model Keys — resolved

Originally the `LoaderGGUF` node's `gguf_name` key was absent from `MODEL_KEYS` in
`serverless-comfy/app/comfy/client.py`, which would have let the pre-flight missing-model check
silently skip the 12.4 GB base UNet. Resolved as a side effect of swapping to city96's
`UnetLoaderGGUF` (see Custom Nodes section above) — its input key is `unet_name`, which is already
in `MODEL_KEYS`. No `serverless-comfy` changes needed; re-ran the MODEL_KEYS coverage audit
(Step 1d) after the swap and confirmed zero gaps.

## Taxonomy gaps (documented, not blocking)

- **`workflow_type: i2i`** — this value is **not** in the skill's documented enum table (which only
  lists video-output and pure-t2i/t2v types; there is no multi-reference image-edit category).
  Verified in `validate_ports.py` that `workflow_type` is not enforced against a closed list in code
  — it only gates extra mandatory params via `_T2_TYPES`/`_VIDEO_TYPES` membership. `i2i` is in
  neither set, which produces exactly the correct behavior for this workflow (`steps` mandatory;
  `width`/`height` NOT required since resolution derives entirely from the input images, same as
  `i2v`; `fps` NOT required since output is a still image). Recommend formally adding `i2i` to the
  taxonomy table in a future skill revision.
- **`model_family: qwen_image`** — also not in the documented `ModelFamily` table (image families
  list has no Qwen-Image entry at all). Verified `validate_ports.py` only checks for a non-empty
  string, not a closed enum. `qwen_image` matches the naming already used elsewhere in this
  codebase (e.g. `qwen_image_vae` in `krea2_character_sheet/workflow.yaml`). Recommend adding
  `qwen_image` to the taxonomy table.

## Fixtures

Reused the same frame for all three reference ports by default (`scene2_01.png` ×3) — replaced with
three distinct, semantically appropriate frames since this workflow needs genuinely different
content per input to demonstrate multi-image compositing:

- `reference_image_1.png` ← `fixtures/scene2/scene2_01.png` (American Wife descending stairs, cardigan) — Picture 1 / main
- `reference_image_2.png` ← `fixtures/scene4/scene4_01.png` (American Wife in rain-coat, different look) — Picture 2
- `reference_image_3.png` ← `fixtures/scene1/scene1_01.png` (empty rainy piazza, no person) — Picture 3 / background

`prompt_positive.txt` / `prompt_negative.txt` rewritten to match: "Replace the clothing of the woman
in Picture 1 with the coat from Picture 2, and place her within the rainy outdoor setting shown in
Picture 3."

## Manual TODOs

All items from the original auto-generated report have been resolved:
1. ~~Verify download URL for the LoRA~~ — done, canonical `lightx2v` source, HTTP 200 verified.
2. ~~Write `description`~~ — done.
3. ~~Write `context`~~ — done.
4. ~~Run `--validate`~~ — done, passes clean.
5. ~~`gguf_name` → `MODEL_KEYS`~~ — resolved by swapping to city96's `UnetLoaderGGUF`
   (`unet_name`, already covered); no `serverless-comfy` change needed.

No open items remain.
