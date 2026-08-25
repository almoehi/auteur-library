# Conversion Report: `krea2_location_sheet`

## Update — pre-existing bug fixed: VAE path missing `h3/` prefix (node 42)

`e2e-test.ts` run failed at `loadFromContent` with "references models not declared in the
models stanza: vae/minimax_h3_video_vae_fp16.safetensors" — a **pre-existing bug**, unrelated
to the view-frame port change below. Node 42 (`VAELoader`) baked in `vae_name:
"minimax_h3_video_vae_fp16.safetensors"` (no folder prefix), but `workflow.yaml` declares the
model under `filename: h3/minimax_h3_video_vae_fp16.safetensors` — the `h3/` prefix convention
used across all other H3 workflows (see `krea2_character_sheet`'s node 42, which already bakes
the prefix in). This bundle's `report.md` (below) is the original unreconciled auto-generated
draft, suggesting it was never actually e2e-verified before. Fixed by baking `h3/` into node
42's `vae_name` in both `workflow.json` and `source_workflow.json`, matching the established
convention and the yaml's declared filename — no other node/filename pairs in this bundle were
affected (verified against every `UNETLoader`/`CLIPLoader`/`VAELoader`/`LoraLoaderModelOnly`
node).

## Update — individual view-frame outputs added (nodes 78–89)

Same change as `krea2_character_sheet`: the harness's output-port system is strictly one
port → one file (`serverless-comfy/app/handlers/render.py` uploads only the first non-temp
file per node and discards the rest of a batch), so node 60's (`OrbitSheetsFrameSelect`)
6-image selection batch could not be exposed directly as a port — doing so would silently
drop 5 of 6 frames. 6 pairs of core `ImageFromBatch` (`batch_index=0..5, length=1`) +
`SaveImage` nodes split the batch into individual sinks, wired from node 60's `frames`
output, added to both `workflow.json` and `source_workflow.json` for UI/API parity. New
auxiliary ports: `view_1`..`view_6` (node_ids 79/81/83/85/87/89).

Unlike the character sheet, this workflow has no fixed canonical shot script — coverage,
`space`, `wide_establishing_shot`, and `detail_shot` are all configurable, and this bundle's
current defaults (`space=interior`, both establishing/detail shots off) only script 4
distinct locked-off views for a requested 6-way selection. So these ports are named
positionally (`view_1` = earliest frame in the orbit take, ... `view_6` = latest) rather than
semantically — see the `pose_*` port docs in `krea2_character_sheet/workflow.yaml` for the
contrast. Validated with `validate_ports.py` (passes); not yet e2e-tested (see caller for
e2e run).

**Note:** the rest of this report below is the original auto-generated conversion draft and
is stale relative to the finished `workflow.yaml` (e.g. `saveimage`/`text_string_user_prompt`
port names, missing `prompt_location`/primary role) — left as-is, out of scope for this change.

---

**Recommended GPU:** `rtx5090` (32 GB VRAM)  
**Peak VRAM estimate:** 23.5 GB  

**Total model download:** ~20.5 GB  

## Ports

| Port                    | Kind   | Role / Default                        | Binding   | Status |
| ----------------------- | ------ | ------------------------------------- | --------- | ------ |
| text_string_user_prompt | string | param (default: A moonlit stone cour) | value@10  | ✓      |
| width                   | int    | param (default: 1920)                 | width@27  | ✓      |
| height                  | int    | param (default: 1080)                 | height@27 | ✓      |
| seed                    | int    | param (default: 0)                    | seed@28   | ✓      |
| steps                   | int    | param (default: 8)                    | steps@28  | ✓      |
| cfg                     | float  | param (default: 1.0)                  | cfg@28    | ✓      |
| frames                  | int    | param (default: 124)                  | length@44 | ✓      |
| fps                     | int    | param (default: 24)                   | fps@76    | ✓      |
| saveimage               | image  | output (auxiliary)                    | 70        | ✓      |
| anchor_preview          | image  | output (auxiliary)                    | 75        | ✓      |
| save_video              | video  | output (auxiliary)                    | 77        | ✓      |

_Note: fill any `TODO: fill description` entries in `workflow.yaml` → `ports:` section, then run `--validate` to confirm all bindings._

## Models

| Filename                                                    | Type             | Confidence | Size     | URL                                                           |
| ----------------------------------------------------------- | ---------------- | ---------- | -------- | ------------------------------------------------------------- |
| Krea2_Turbo_convrot_int8mixed.safetensors                   | diffusion_models | unknown    | unknown  | —                                                             |
| qwen3vl_4b_fp8_scaled.safetensors                           | clip             | unknown    | unknown  | —                                                             |
| qwen_image_vae.safetensors                                  | vae              | medium     | unknown  | https://huggingface.co/zhenshipo/qwen_image_vae_models/resol… |
| minimax_h3_fl2va_pruned_int8_convrot.safetensors            | diffusion_models | high       | 20.48 GB | https://civitai.com/api/download/models/3193337?type=VAE&for… |
| qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors                | clip             | unknown    | unknown  | —                                                             |
| minimax_h3_video_vae_fp16.safetensors                       | vae              | unknown    | unknown  | —                                                             |
| minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors | lora             | unknown    | unknown  | —                                                             |
| minimax_h3_ref_lora_rank_256_bf16.safetensors               | lora             | unknown    | unknown  | —                                                             |

## Custom Nodes

_No custom nodes detected._

## nodes.lock Entries

Append these lines to `serverless-comfy/nodes.lock` (sorted by URL):

```
# (none — all custom node SHAs are unresolved)
```

## Manual TODOs

1. Verify download URL for model `Krea2_Turbo_convrot_int8mixed.safetensors` (confidence: unknown)
2. Verify download URL for model `qwen3vl_4b_fp8_scaled.safetensors` (confidence: unknown)
3. Verify download URL for model `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (confidence: unknown)
4. Verify download URL for model `minimax_h3_video_vae_fp16.safetensors` (confidence: unknown)
5. Verify download URL for model `minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors` (confidence: unknown)
6. Verify download URL for model `minimax_h3_ref_lora_rank_256_bf16.safetensors` (confidence: unknown)
7. Fill description for port `10` (PrimitiveStringMultiline) in workflow.yaml → ports: section
8. Write `description` in workflow.yaml
9. Write `context` in workflow.yaml (GPU notes, download size, etc.)
10. Run `--validate workflows/<name>` to confirm all port bindings are correct
