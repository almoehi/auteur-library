# Conversion Report: `krea2_base_realism`

**Recommended GPU:** `rtx3090` (24 GB VRAM)  

**Total model download:** ~0.0 GB  

## Ports

| Port            | Kind   | Role / Default                        | Binding    | Status |
| --------------- | ------ | ------------------------------------- | ---------- | ------ |
| width           | int    | param (default: 1440)                 | width@232  | ✓      |
| height          | int    | param (default: 1920)                 | height@232 | ✓      |
| seed            | int    | param (default: -1)                   | seed@276   | ✓      |
| negative_prompt | string | param (default: )                     | value@271  | ✓      |
| positive_prompt | string | param (default: A middle-aged man si) | value@48   | ✓      |
| save_image      | image  | output (primary)                      | 213        | ✓      |

_Note: fill any `TODO: fill description` entries in `workflow.yaml` → `ports:` section, then run `--validate` to confirm all bindings._

## Models

| Filename                            | Type             | Confidence | Size    | URL  |
| ----------------------------------- | ---------------- | ---------- | ------- | ---- |
| qwen3vl_4b_bf16.safetensors         | clip             | unknown    | unknown | —    |
| wan21_vae_fp32.safetensors          | vae              | unknown    | unknown | —    |
| krea2_raw_bf16.safetensors          | diffusion_models | unknown    | unknown | —    |
| TURBO_LORA_HERE.safetensors         | lora             | unknown    | unknown | —    |
| FILTER_BYPASS_LORA_HERE.safetensors | lora             | unknown    | unknown | —    |
| None                                | lora             | low        | unknown | —    |
| None                                | lora             | low        | unknown | —    |

## Custom Nodes

| class_type                  | Repo                                         | SHA                                      | Notes |
| --------------------------- | -------------------------------------------- | ---------------------------------------- | ----- |
| ClownsharKSampler_Beta      | https://github.com/ClownsharkBatwing/RES4LYF | 215f61fe8c0c3f4473744e0956367519eb9f12a5 |       |
| Seed (rgthree)              | https://github.com/rgthree/rgthree-comfy     | 6b76ee6f2c5a007710b5a16f97c94330d6ecc871 |       |
| Power Lora Loader (rgthree) | https://github.com/rgthree/rgthree-comfy     | 6b76ee6f2c5a007710b5a16f97c94330d6ecc871 |       |

## nodes.lock Entries

Append these lines to `serverless-comfy/nodes.lock` (sorted by URL):

```
https://github.com/ClownsharkBatwing/RES4LYF.git 215f61fe8c0c3f4473744e0956367519eb9f12a5
https://github.com/rgthree/rgthree-comfy.git 6b76ee6f2c5a007710b5a16f97c94330d6ecc871
```

## Manual TODOs

1. Verify download URL for model `qwen3vl_4b_bf16.safetensors` (confidence: unknown)
2. Verify download URL for model `wan21_vae_fp32.safetensors` (confidence: unknown)
3. Verify download URL for model `krea2_raw_bf16.safetensors` (confidence: unknown)
4. Verify download URL for model `TURBO_LORA_HERE.safetensors` (confidence: unknown)
5. Verify download URL for model `FILTER_BYPASS_LORA_HERE.safetensors` (confidence: unknown)
6. Verify download URL for model `None` (confidence: low)
7. Verify download URL for model `None` (confidence: low)
8. Write `description` in workflow.yaml
9. Write `context` in workflow.yaml (GPU notes, download size, etc.)
10. Run `--validate workflows/<name>` to confirm all port bindings are correct
