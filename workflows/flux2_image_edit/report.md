# Conversion Report: `flux2_image_edit`

**GPU requirement (corrected — see "GPU / VRAM audit" below):** `gpu_types: [l40s, a100, h100, blackwell]`
— the converter's auto-suggested `rtx3090` (24 GB) was a **false/default estimate** ("VRAM
estimate: 0.0 GB" in the converter log — no real analysis was performed) and is **insufficient**.

**Total model download:** ~18.8 GB (9.8 GB + 8.7 GB + 0.3 GB, measured via HTTP `Content-Length`)

## Prompting guide research (context: field expanded)

Researched image-editing-specific prompting guidance and folded it into `workflow.yaml`'s
`context:` field (previously a short paragraph; now includes structure/length guidance and 4
example prompts covering garment transfer, object swap, background replacement, and
texture/style transfer).

**Sources consulted:**
- Official BFL prompting guide — https://docs.bfl.ai/guides/prompting_guide_flux2 (primary
  source; sections "Prompt Structure", "Multi-Reference Image Editing", "Best Practices
  Summary", "Quick Reference"). Confirmed: word-order priority ("earlier words carry more
  weight"), the Subject+Action+Style+Context framework, the three length tiers (short 10-30
  words / medium 30-80 words "usually ideal" / long 80+ words for complex scenes), and — most
  actionable — **no negative-prompt mechanism exists**: the guide explicitly says to state the
  desired outcome positively ("sharp focus" not "no blur") rather than negating unwanted
  results. Folded this into a new "say what you want, not what you don't" prompting rule.
- huggingface.co/black-forest-labs/FLUX.2-dev model card and bfl.ai/blog/flux-2 — checked
  first, both light on editing-specific detail; used mainly to locate the docs.bfl.ai guide.
- The workflow author's own guide (already cited at
  https://comfy.org/workflows/image_flux2_klein_9b_kv_image_edit-546732126bf6/) — kept as
  Example 1, unchanged.

**Reconciled a genuine discrepancy:** the official guide describes multi-reference images by
*content* in narrative prose ("the outfit", "clothing items") rather than numbering them, and
gives no explicit "keep X unchanged" preservation guidance. This workflow's port bindings and
the author's own working example instead use an explicit "Figure 1"/"Figure 2" numbered
convention — which is also what this session's own e2e test render used successfully
(`prompt_positive.txt`: "the woman in Figure 1... the cardigan sweater from Figure 2...",
render succeeded). Kept the numbered convention as the primary recommendation (empirically
validated for this specific workflow) and added the content-based alternative as a secondary,
compatible option — both are stated as workable, not contradictory.

`--validate` re-run clean after the edit; scanned the new `context:` text for banned content
(model names, VRAM, node/graph internals) — none found (the pre-existing model-name mention in
the `steps` port description was already present before this edit and was left untouched, out
of this edit's scope).

## e2e test: stale converter binary produced a silently-broken output check

The first e2e run (`renderId=49cad2fcdb7f63b725f8ee3dfe7ed8d7`) reported `ALL CHECKS PASSED ✓`,
but the magic-byte image verification never actually ran — `ProducedFile` (the real shape of
`result.outputs[i]` returned by `runStatus()`) only carries `nodeId`/`filename`/`url`/`mime`/`size`;
it has **no `kind` field**. The generated test checked `out.kind === 'image'`, which is always
`undefined`, so the `if/else if` chain silently matched nothing and the check simply never
logged — a false "pass" (0 failures) rather than a caught bug.

This is **not specific to this workflow** — it's a bug in the `e2e-test.ts` template that
`auteur-workflow-converter` (the installed `~/.local/bin/auteur-workflow-converter` binary) generated. The
canonical source template (`toolchain/workflow-converter/output/e2e_gen.py`) has **already been
fixed upstream** (resolves `kind`/`name` from `manifest.outputs` by `nodeId`, falling back to a
filename-stem match) — the installed binary is simply stale relative to the toolchain source.
Manually applied the same fix to this workflow's `e2e-test.ts` (see diff — Step 6 now builds a
`port` lookup per output before running the magic-byte check) and re-ran the test to confirm the
`is image` check now actually executes. **Recommend rebuilding/reinstalling
`auteur-workflow-converter` from current toolchain source** so future conversions don't
regenerate the broken pattern.

## Ports (final, after hardening)

| Port                     | Kind   | Role / Default    | Binding   | Status |
| ------------------------ | ------ | ----------------- | --------- | ------ |
| subject_image            | image  | input             | image@76  | ✓      |
| garment_reference_image  | image  | input             | image@81  | ✓      |
| prompt_positive          | string | param (required)  | text@135  | ✓      |
| steps                    | int    | param (default 4) | steps@137 | ✓      |
| cfg                      | float  | param (default 1) | cfg@138   | ✓      |
| seed                     | int    | param (default -1, `seed: true`) | noise_seed@125 | ✓ (added for #229) |
| edited_image             | image  | output (primary)  | 94        | ✓      |

Renamed from the converter's auto-drafted names (`reference_image`/`reference_image_2` →
`subject_image`/`garment_reference_image`, swapping which binding each name points to since the
auto-draft had them backwards relative to the prompt's "Figure 1"/"Figure 2" convention;
`clip_text_encode_positive_prompt` → `prompt_positive` per naming convention; `save_image` →
`edited_image`). `prompt_positive` promoted to `required: true` (no universal default makes
sense for an edit instruction). `--validate` passes clean.

`seed` (added for #229, design studio): bound to the literal `RandomNoise.noise_seed` widget of
node 125 and marked `seed: true`, so `-1`/omitted re-rolls per render and seed variations
(`create-variations`) work for this edit workflow.

## Models (final — SHA256 resolved)

| Filename                           | Type             | SHA256 verified | URL                                                           |
| ----------------------------------- | ---------------- | :--------------: | -------------------------------------------------------------- |
| flux-2-klein-9b-kv-fp8.safetensors | diffusion_models | ✓                | https://huggingface.co/black-forest-labs/FLUX.2-klein-9b-kv-… |
| qwen_3_8b_fp8mixed.safetensors     | clip              | ✓                | https://huggingface.co/PatrickZane/qwen_3_8b_fp8mixed.safete… |
| flux2-vae.safetensors              | vae               | ✓                | https://huggingface.co/z7umer/flux2vae/resolve/main/flux2-va… |

All 3 URLs verified HTTP 200; SHA256 fetched from each HF repo's LFS pointer (`/raw/` variant of
the URL). `type: clip` for `qwen_3_8b_fp8mixed` is correct as-is even though this ComfyUI build's
`CLIPLoader` node reads from the `text_encoders` folder_paths key — confirmed
`folder_paths.py` registers `models/clip/` as an additional search path under the
`text_encoders` key (legacy alias), so the `clip` → `clip/` destination folder from
`MODEL_TYPE_TO_DEST` in `workflow-agent.ts` is still discoverable. No change needed.
`type: diffusion_models` (not `unet`) confirmed correct for the `UNETLoader` node — ComfyUI core
reads `UNETLoader`'s file list from `folder_paths.get_filename_list("diffusion_models")`.

## UUID Subgraph Boundary Audit (Step 1b)

The converter flagged 2 integrity warnings on links 212/213 (subgraph instance `134` outputs →
subgraph instance `132` inputs), claiming the cross-boundary sources were "not wired into any
132:* node's inputs". Manual trace of both subgraph definitions (`27eacb9f...` for instance 134,
`93041a64...` for instance 132 — both named "Reference Conditioning") shows this is a **false
positive**:

- Each subgraph's output slot 0 ("positive") is produced by internal local node **118/121**
  (the higher-numbered node), and slot 1 ("negative") by local node **116/119** (the
  lower-numbered node) — a non-monotonic mapping. The checker's heuristic apparently assumes
  slot 0 maps to the lowest local node id, which is false for this subgraph template.
- Expected wiring per link 212/213: `132:121.conditioning = 134:118` (positive→positive) and
  `132:119.conditioning = 134:116` (negative→negative).
- Actual `workflow.json`: `132:121.inputs.conditioning = ["134:118", 0]` and
  `132:119.inputs.conditioning = ["134:116", 0]` — matches exactly.

Confirmed downstream: `CFGGuider` (node 138) `positive=["132:121",0]`, `negative=["132:119",0]`,
consistent with the reference-image conditioning chain (text prompt → man reference → outfit
reference, applied identically to both the real and zeroed-out conditioning branches). **No
patch to `workflow.json` was required.**

## Custom Nodes

Confirmed (not just "not detected") — every `class_type` in `workflow.json` (`FluxKVCache`,
`Flux2Scheduler`, `EmptyFlux2LatentImage`, `ImageScaleToTotalPixels`, `ReferenceLatent`,
`ConditioningZeroOut`, `GetImageSize`, `CFGGuider`, `SamplerCustomAdvanced`, `KSamplerSelect`,
`RandomNoise`, `UNETLoader`, `CLIPLoader`, `VAELoader`, `VAEEncode`, `VAEDecode`, `LoadImage`,
`SaveImage`) is a built-in ComfyUI core node (`comfy_extras/` or `nodes.py`), verified by
grepping the running `harness-comfyui` image. No `customNodes` stanza needed.

## Widget Completeness Audit (Step 1c)

Read `define_schema()` for the three FLUX.2-specific nodes (`FluxKVCache`, `Flux2Scheduler`,
`EmptyFlux2LatentImage` — new in this ComfyUI build) plus `ImageScaleToTotalPixels` and
`ReferenceLatent`. All non-optional inputs are present in `workflow.json` (either as literal
values or valid upstream connections). No missing-default patch required.

## MODEL_KEYS Coverage (Step 1d)

All 3 model-path input keys (`unet_name`, `clip_name`, `vae_name`) are covered by `MODEL_KEYS`
in `serverless-comfy/app/comfy/client.py`. No gap.

## GPU / VRAM audit (found during parity review — BLOCKER, fixed)

The converter's own log showed `VRAM estimate: 0.0 GB → rtx3090` — i.e. no real estimate was
computed and it silently fell back to the cheapest tier. The model publisher's HF card for
`black-forest-labs/FLUX.2-klein-9b-kv-fp8` states: *"The FLUX.2 [klein] 9B-KV model fits in
~29GB VRAM and is accessible on NVIDIA RTX 5090 and above."* (17B combined params — 9B flow
model + 8B Qwen3 text embedder — at FP8). A 24 GB card (`rtx3090`/`rtx4090`) cannot fit this;
using the converter's default would have caused OOM at render time.

Cross-checked against this repo's actual deployable GPU pools
(`video-harness/src/render/backend/{gpu-types,runpod-backend}.ts`):
- `rtx5090` (the publisher's cited minimum) has **no working pool anywhere in this codebase** —
  `runpod-backend.ts` lists `rtx5090: []` (empty pool) and it isn't in `MODAL_GPU_NAMES` or
  `BEAM_GPU_NAMES` at all. It is not actually deployable today despite being a valid `GpuType`.
- `l40s` (48 GB) is the cheapest tier that both (a) comfortably covers the ~29 GB requirement
  and (b) has a real, deployed pool on RunPod/Modal/Beam.

Set `gpu_types: [l40s, a100, h100, blackwell]` in `workflow.yaml` (sorted cheapest→largest;
`rtx4090`/`rtx3090` excluded for insufficient VRAM, `rtx5090` excluded for having no deployed
pool). Updated `e2e-test.ts`'s `GPU_TYPE` from `rtx3090` → `l40s` and corrected its
"~0 GB model download" timeout comments to the measured ~18.8 GB total.

## Taxonomy gaps found and resolved

This workflow doesn't fit any existing `workflow_type` (two-image editing, still-image output —
not `t2i`, which is text-only) or `model_family` (FLUX.2 is a distinct model line from
`flux1`/`flux3`). Per user direction:

- Added `i2i` to `WorkflowType` (`video-harness/src/workflows/types.ts`) — union member +
  `WORKFLOW_TYPE_META` entry. `npm run typecheck` passes.
- Added `flux2` to `ModelFamily` (same file) — union member + doc comment.
- Filed **[video-harness#128](https://github.com/almoehi/video-harness/issues/128)** to track
  full wiring: `validate_ports.py` "≥1 image input port" rule for `i2i`, linter/prompt-enhancer
  audit, skill doc table updates, and workspace-agent-facing discoverability.
- This workflow uses `workflow_type: i2i`, `model_family: flux2`.

## nodes.lock Entries

None — all custom-node repos resolved to built-in ComfyUI core (see above); no `nodes.lock`
changes needed.

## Manual TODOs

All resolved — see sections above. `--validate workflows/flux2_image_edit` passes clean.
