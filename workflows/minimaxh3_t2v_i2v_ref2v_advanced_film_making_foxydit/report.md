# Conversion Report: `minimaxh3-t2v-i2v-ref2v-advanced-film-making-foxydit`

**Recommended GPU:** `rtx4090` (24 GB VRAM)  
**Peak VRAM estimate:** 24.0 GB  

**Total model download:** ~0.0 GB  

## Ports

| Port            | Kind   | Role / Default                        | Binding   | Status |
| --------------- | ------ | ------------------------------------- | --------- | ------ |
| steps           | int    | param (default: 8)                    | steps@124 | ✓      |
| seed            | int    | param (default: 446059383552270)      | seed@142  | ✓      |
| positive_prompt | string | param (default: subject_definitions:) | value@138 | ✓      |
| video_combine   | video  | output (primary)                      | 145       | ✓      |

_Note: fill any `TODO: fill description` entries in `workflow.yaml` → `ports:` section, then run `--validate` to confirm all bindings._

## Models

| Filename                                                    | Type             | Confidence | Size    | URL  |
| ----------------------------------------------------------- | ---------------- | ---------- | ------- | ---- |
| minimax_h3_fl2va_pruned_int8_convrot.safetensors            | diffusion_models | unknown    | unknown | —    |
| qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors                | clip             | unknown    | unknown | —    |
| minimax_h3_audio_vae_fp32.safetensors                       | vae              | unknown    | unknown | —    |
| minimax_h3_video_vae_fp16.safetensors                       | vae              | unknown    | unknown | —    |
| minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors | lora             | low        | unknown | —    |

## Custom Nodes

| class_type                  | Repo                                                    | SHA                                      | Notes |
| --------------------------- | ------------------------------------------------------- | ---------------------------------------- | ----- |
| VHS_VideoCombine            | https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite | 4ee72c065db22c9d96c2427954dc69e7b908444b |       |
| Power Lora Loader (rgthree) | https://github.com/rgthree/rgthree-comfy                | 6b76ee6f2c5a007710b5a16f97c94330d6ecc871 |       |

## nodes.lock Entries

Append these lines to `serverless-comfy/nodes.lock` (sorted by URL):

```
https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git 4ee72c065db22c9d96c2427954dc69e7b908444b
https://github.com/rgthree/rgthree-comfy.git 6b76ee6f2c5a007710b5a16f97c94330d6ecc871
```

## Manual TODOs

1. Verify download URL for model `minimax_h3_fl2va_pruned_int8_convrot.safetensors` (confidence: unknown)
2. Verify download URL for model `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` (confidence: unknown)
3. Verify download URL for model `minimax_h3_audio_vae_fp32.safetensors` (confidence: unknown)
4. Verify download URL for model `minimax_h3_video_vae_fp16.safetensors` (confidence: unknown)
5. Verify download URL for model `minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors` (confidence: low)
6. Run `--validate workflows/<name>` to confirm all port bindings are correct
