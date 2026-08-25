# Conversion Report: `minimax_h3_v2v_nsfw`

**Recommended GPU:** `rtx3090` (24 GB VRAM)  

**Total model download:** ~0.0 GB  

## Ports

| Port                          | Kind   | Role / Default                        | Binding   | Status                   |
| ----------------------------- | ------ | ------------------------------------- | --------- | ------------------------ |
| load_image_primary_char_sheet | image  | input                                 | image@178 | ⚠ TODO: fill description |
| load_image_scene_no_chars     | image  | input                                 | image@170 | ⚠ TODO: fill description |
| load_image_optional           | image  | input                                 | image@187 | ⚠ TODO: fill description |
| steps                         | int    | param (default: 20)                   | steps@141 | ✓                        |
| fps                           | int    | param (default: 24)                   | fps@150   | ✓                        |
| input_text_prompt             | string | param (default: How the reference vi) | value@182 | ✓                        |
| save_video                    | video  | output (primary)                      | 176       | ✓                        |

_Note: fill any `TODO: fill description` entries in `workflow.yaml` → `ports:` section, then run `--validate` to confirm all bindings._

## Models

| Filename                                                         | Type             | Confidence | Size    | URL  |
| ---------------------------------------------------------------- | ---------------- | ---------- | ------- | ---- |
| minimax_h3_video_vae_fp16.safetensors                            | vae              | unknown    | unknown | —    |
| minimax_h3_audio_vae_fp32.safetensors                            | vae              | unknown    | unknown | —    |
| qwen3vl_32b_h3_ultra_uncensored_heretic_int8_convrot.safetensors | clip             | unknown    | unknown | —    |
| minimax_h3_fl2va_int8_convrot.safetensors                        | diffusion_models | unknown    | unknown | —    |

## Custom Nodes

_No custom nodes detected._

## nodes.lock Entries

Append these lines to `serverless-comfy/nodes.lock` (sorted by URL):

```
# (none — all custom node SHAs are unresolved)
```

## Manual TODOs

1. Verify download URL for model `minimax_h3_video_vae_fp16.safetensors` (confidence: unknown)
2. Verify download URL for model `minimax_h3_audio_vae_fp32.safetensors` (confidence: unknown)
3. Verify download URL for model `qwen3vl_32b_h3_ultra_uncensored_heretic_int8_convrot.safetensors` (confidence: unknown)
4. Verify download URL for model `minimax_h3_fl2va_int8_convrot.safetensors` (confidence: unknown)
5. Fill description for port `182` (PrimitiveStringMultiline) in workflow.yaml → ports: section
6. Fill description for port `178` (LoadImage) in workflow.yaml → ports: section
7. Fill description for port `170` (LoadImage) in workflow.yaml → ports: section
8. Fill description for port `187` (LoadImage) in workflow.yaml → ports: section
9. Write `description` in workflow.yaml
10. Write `context` in workflow.yaml (GPU notes, download size, etc.)
11. Run `--validate workflows/<name>` to confirm all port bindings are correct
