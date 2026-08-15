# Conversion Report: `iamcs_wan22_svi`

**Recommended GPU:** `rtx4090` (24 GB VRAM)  
**Peak VRAM estimate:** 24.0 GB  

**Total model download:** ~0.0 GB  

## Ports

| Port               | Kind   | Role / Default                        | Binding    | Status |
| ------------------ | ------ | ------------------------------------- | ---------- | ------ |
| reference_image    | image  | input                                 | image@745  | ✓ auto |
| reference_image_2  | image  | input                                 | image@371  | ✓ auto |
| reference_image_3  | image  | input                                 | image@746  | ✓ auto |
| cfg                | float  | param (default: 1)                    | cfg@858    | ✓      |
| negative_prompt    | string | param (default: 色调艳丽，过曝，静态，细节模糊不清，字幕) | text@1813  | ✓      |
| positive_prompt    | string | param (default: Camera tracks tha fa) | value@1795 | ✓      |
| seed               | int    | param (default: 845444788612421)      | seed@1806  | ✓      |
| video_combine      | video  | output (auxiliary)                    | 212        | ✓      |
| video_combine      | video  | output (auxiliary)                    | 204        | ✓      |
| video_combine      | video  | output (auxiliary)                    | 1829       | ✓      |
| final_output_video | video  | output (primary)                      | 1830       | ✓      |

_Note: fill any `TODO: fill description` entries in `workflow.yaml` → `ports:` section, then run `--validate` to confirm all bindings._

## Models

| Filename                                                               | Type | Confidence | Size    | URL                                                           |
| ---------------------------------------------------------------------- | ---- | ---------- | ------- | ------------------------------------------------------------- |
| wan_2.1_vae.safetensors                                                | vae  | medium     | unknown | https://huggingface.co/ratoenien/wan_2.1_vae/resolve/main/wa… |
| umt5_xxl_fp8_e4m3fn_scaled.safetensors                                 | clip | medium     | unknown | https://huggingface.co/ratoenien/umt5_xxl_fp8_e4m3fn_scaled/… |
| wan2.2_i2v_high_noise_14B_Q5_K_M.gguf                                  | unet | unknown    | unknown | —                                                             |
| wan2.2_i2v_low_noise_14B_Q5_K_M.gguf                                   | unet | unknown    | unknown | —                                                             |
| wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors | lora | high       | unknown | https://huggingface.co/SlartyG/wan2.2_i2v_A14b_high_noise_lo… |
| SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors         | lora | high       | unknown | https://huggingface.co/Stottsteven/SVI_v2_PRO_Wan2.2-I2V-A14… |
| wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors  | lora | unknown    | unknown | —                                                             |
| SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors          | lora | high       | unknown | https://huggingface.co/alphaghost13/SVI_v2_PRO_Wan2.2-I2V-A1… |

## Custom Nodes

| class_type                  | Repo                                                      | SHA                                      | Notes                                                                    |
| --------------------------- | --------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| ShowText|pysssss            | https://github.com/pythongosssss/ComfyUI-Custom-Scripts   | 609f3afaa74b2f88ef9ce8d939626065e3247469 | [display]                                                                |
| RIFE VFI                    | https://github.com/Fannovel16/ComfyUI-Frame-Interpolation | 26545cc2dd95bc3d27f056016300673bdeee78f5 |  rife49.pth auto-downloaded by the node; do NOT list in models stanza    |
| VHS_GetImageCount           | https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite   | 4ee72c065db22c9d96c2427954dc69e7b908444b |                                                                          |
| MathExpression|pysssss      | https://github.com/pythongosssss/ComfyUI-Custom-Scripts   | 609f3afaa74b2f88ef9ce8d939626065e3247469 |                                                                          |
| easy float                  | https://github.com/yolain/ComfyUI-Easy-Use                | 595e0738a9e3f8d0d9c4d875461b2d2c9e7559c7 |                                                                          |
| easy int                    | https://github.com/yolain/ComfyUI-Easy-Use                | 595e0738a9e3f8d0d9c4d875461b2d2c9e7559c7 |                                                                          |
| KSampler Config (rgthree)   | https://github.com/rgthree/rgthree-comfy                  | 6b76ee6f2c5a007710b5a16f97c94330d6ecc871 |                                                                          |
| VHS_VideoCombine            | https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite   | 4ee72c065db22c9d96c2427954dc69e7b908444b |                                                                          |
| LayerUtility: PurgeVRAM     | https://github.com/chflame163/ComfyUI_LayerStyle          | 64f976fec8492ea4930c0e30c32369573189b23d |                                                                          |
| ImageResize+                | https://github.com/cubiq/ComfyUI_essentials               | 9d9f4bedfc9f0321c19faf71855e228c93bd0dc9 |                                                                          |
| GetImageSize+               | https://github.com/cubiq/ComfyUI_essentials               | 9d9f4bedfc9f0321c19faf71855e228c93bd0dc9 |                                                                          |
| GGUFLoaderKJ                | https://github.com/kijai/ComfyUI-KJNodes                  | 4d46ac107c33ed8a3d181b8776ede66498583380 |  NOT city96/ComfyUI-GGUF; resolves via unet/ folder                      |
| WanImageMotionPro           | https://github.com/IAMCCS/IAMCCS-nodes                    | 355ced604934d0cdcf71396808d07b5624b00004 |                                                                          |
| AdjustContrast              | https://github.com/cubiq/ComfyUI_essentials               | 9d9f4bedfc9f0321c19faf71855e228c93bd0dc9 |                                                                          |
| ImageBatchExtendWithOverlap | https://github.com/pythongosssss/ComfyUI-Custom-Scripts   | 609f3afaa74b2f88ef9ce8d939626065e3247469 |                                                                          |
| IAMCCS_AutoLinkArguments    | https://github.com/IAMCCS/IAMCCS-nodes                    | 355ced604934d0cdcf71396808d07b5624b00004 | [display]                                                                |
| Seed (rgthree)              | https://github.com/rgthree/rgthree-comfy                  | 6b76ee6f2c5a007710b5a16f97c94330d6ecc871 |                                                                          |
| IAMCCS_WanLoRAStackModelIO  | https://github.com/IAMCCS/IAMCCS-nodes                    | 355ced604934d0cdcf71396808d07b5624b00004 |  lora1-4 inputs may have Windows path prefixes — strip before committing |
| WanMotionProTrimmer         | https://github.com/IAMCCS/IAMCCS-nodes                    | 355ced604934d0cdcf71396808d07b5624b00004 |                                                                          |

## nodes.lock Entries

Append these lines to `serverless-comfy/nodes.lock` (sorted by URL):

```
https://github.com/Fannovel16/ComfyUI-Frame-Interpolation.git 26545cc2dd95bc3d27f056016300673bdeee78f5
https://github.com/IAMCCS/IAMCCS-nodes.git 355ced604934d0cdcf71396808d07b5624b00004
https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git 4ee72c065db22c9d96c2427954dc69e7b908444b
https://github.com/chflame163/ComfyUI_LayerStyle.git 64f976fec8492ea4930c0e30c32369573189b23d
https://github.com/cubiq/ComfyUI_essentials.git 9d9f4bedfc9f0321c19faf71855e228c93bd0dc9
https://github.com/kijai/ComfyUI-KJNodes.git 4d46ac107c33ed8a3d181b8776ede66498583380
https://github.com/pythongosssss/ComfyUI-Custom-Scripts.git 609f3afaa74b2f88ef9ce8d939626065e3247469
https://github.com/rgthree/rgthree-comfy.git 6b76ee6f2c5a007710b5a16f97c94330d6ecc871
https://github.com/yolain/ComfyUI-Easy-Use.git 595e0738a9e3f8d0d9c4d875461b2d2c9e7559c7
```

## Manual TODOs

1. Verify download URL for model `wan2.2_i2v_high_noise_14B_Q5_K_M.gguf` (confidence: unknown)
2. Verify download URL for model `wan2.2_i2v_low_noise_14B_Q5_K_M.gguf` (confidence: unknown)
3. Verify download URL for model `wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors` (confidence: unknown)
4. Run `--validate workflows/<name>` to confirm all port bindings are correct
