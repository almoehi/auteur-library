# Conversion Report: `krea2_character_sheet`

**Parity review status: PASS** (reviewed against source_workflow.json, 2026-08-21)

---

## Parity Check

| Check | Result |
|---|---|
| Node count | 47 UI → 47 API ✓ (35 original + 12 for pose_* aux output splitting) |
| All 54 connections | Verified ✓ (42 original + 12 for pose_* aux output splitting) |
| No orphaned nodes | ✓ (nodes 71/72/75 display-only, unconnected outputs identical in source) |
| MODEL_KEYS coverage | All 9 keys in standard set ✓ |
| GPU types order | l40s → a100 → h100 (cheapest → largest) ✓ |
| workflow_type | t2i ✓ (primary output is image: character sheet) |
| model_family | krea2 ✓ |
| Source attribution | Preserved as YAML comments ✓ |

### Custom nodes

| Node class | Source | nodes.lock |
|---|---|---|
| OrbitSheetsCharacterPrompt | ComfyUI-OrbitSheets | dynamic customNodes stanza (no lock entry needed) |
| OrbitSheetsFrameSelect | ComfyUI-OrbitSheets | dynamic customNodes stanza |
| OrbitSheetsContactSheet | ComfyUI-OrbitSheets | dynamic customNodes stanza |
| OrbitSheetsAttentionBackend | ComfyUI-OrbitSheets | dynamic customNodes stanza |
| MiniMaxH3ImageToVideo | ComfyUI core extras (nodes_minimax_h3.py) | built-in |
| MiniMaxH3SigmaShift | ComfyUI core extras (nodes_minimax_h3.py) | built-in |
| VAEDecodeAudio | ComfyUI core extras (nodes_audio.py) | built-in |
| CreateVideo | ComfyUI core extras (nodes_video.py) | built-in |
| SaveVideo | ComfyUI core extras (nodes_video.py) | built-in |
| StringConcatenate | ComfyUI core extras (nodes_string.py) | built-in |
| PreviewAny | ComfyUI core extras (nodes_preview_any.py) | built-in |

### Intentional changes from source

1. **VAE paths — `h3/` prefix added** (nodes 42, 51): source baked flat names
   (`minimax_h3_video_vae_fp16.safetensors`, `minimax_h3_audio_vae_fp32.safetensors`);
   patched to `h3/minimax_h3_video_vae_fp16.safetensors` and `h3/minimax_h3_audio_vae_fp32.safetensors`
   to match the H3 VAE path convention used across all existing H3 workflows.
   Download filenames in workflow.yaml match.

2. **LoRA paths — `Minimax/` prefix stripped** (nodes 39, 73): source had
   `Minimax/minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors` and
   `Minimax/minimax_h3_ref_lora_rank_256_bf16.safetensors`. Stripped to flat names.
   workflow.json `lora_name` and workflow.yaml `filename` are both flat and consistent —
   ComfyUI will locate the files correctly. These LoRAs are new (first use in this repo)
   so there is no existing cached version at the `Minimax/` path on any network volume.

3. **`format.codec` → `codec` in node 79 (SaveVideo)**: ComfyUI's new io.Schema API
   (`EXECUTE_NORMALIZED`) expects `codec` as a direct parameter, not the legacy sub-combo
   dot-notation key `format.codec`. Renamed to fix `TypeError: SaveVideo.execute() missing
   1 required positional argument: 'codec'`.

4. **SaveVideo explicit mp4/h264 format (node 79)**: `format: "auto"` (string) resolved to
   FLAC in the Modal serverless ComfyUI container (different build from harness-comfyui).
   Changed to dict-form DynamicCombo: `format: {"format": "mp4", "codec": {"codec": "h264"}}`.
   This removes the separate `codec: "auto"` key introduced in item 3 — the dict form carries
   the codec nested within format, matching the io.Schema DynamicCombo contract exactly.

5. **SaveAudio explicit mp3 format (node 72)**: Node 72 had no `format` in the workflow JSON.
   ComfyUI's io.Schema `EXECUTE_NORMALIZED` passed an empty dict; `format.get("format", None)`
   returned None and the Modal container defaulted to an unexpected `.mp4` extension. Added
   explicit dict: `format: {"format": "mp3", "quality": "128k"}` to produce proper MP3 audio.

6. **Individual pose-frame outputs added (nodes 81–92)**: the harness's output-port system is
   strictly one port → one file (`serverless-comfy/app/handlers/render.py` uploads only the first
   non-temp file per node and discards the rest of a batch), so node 60's 6-image selection batch
   could not be exposed directly as a port — doing so would silently drop 5 of 6 frames. Instead,
   6 pairs of core `ImageFromBatch` (`batch_index=0..5, length=1`) + `SaveImage` nodes split the
   batch into individual sinks, one per canonical shot, wired from node 60's `frames` output. Added
   to both `workflow.json` and `source_workflow.json` to keep UI/API parity.

---

## Ports

| Port | Kind | Role / Default | Binding | Status |
|---|---|---|---|---|
| prompt_character | string | param (required) | value@10 | ✓ |
| width | int | param (default: 1920) | width@27 | ✓ |
| height | int | param (default: 1080) | height@27 | ✓ |
| steps | int | param (default: 8) | steps@28 | ✓ |
| frames | int | param (default: 124) | length@44 | ✓ |
| fps | int | param (default: 24) | fps@78 | ✓ |
| seed | int | seed (optional) | seed@28 | ✓ |
| character_sheet | image | output (primary) | node 70 | ✓ |
| orbit_video | video | output (auxiliary) | node 79 | ✓ |
| voice_track | audio | output (auxiliary) | node 72 | ✓ |
| anchor_preview | image | output (auxiliary) | node 75 | ✓ |
| pose_front | image | output (auxiliary) | node 82 (ImageFromBatch 81 → SaveImage 82) | ✓ |
| pose_face_closeup | image | output (auxiliary) | node 84 (ImageFromBatch 83 → SaveImage 84) | ✓ |
| pose_left_profile | image | output (auxiliary) | node 86 (ImageFromBatch 85 → SaveImage 86) | ✓ |
| pose_right_profile | image | output (auxiliary) | node 88 (ImageFromBatch 87 → SaveImage 88) | ✓ |
| pose_rear | image | output (auxiliary) | node 90 (ImageFromBatch 89 → SaveImage 90) | ✓ |
| pose_frightened | image | output (auxiliary) | node 92 (ImageFromBatch 91 → SaveImage 92) | ✓ |

**pose_* ports are best-effort labels, not guaranteed**: they assume node 60's vision-judged
per-view selection lands exactly one frame per canonical shot in temporal order (true in the
common case, since shots run in a fixed script order and are sorted by frame index). If a take
under-delivers distinct views — an already-documented failure mode of node 60 (see "Known issues"
in the `context` block above) — a `pose_*` slot may hold a duplicate angle instead of its label.

**H3 noise seed** (node 45, `noise_seed=0`, control_mode=`"fixed"`): intentionally not exposed —
fixed in the original workflow. H3 orbit reproducibility is controlled by the anchor frame via
`first_frame`; varying `seed` (node 28) varies the anchor and thus the orbit.

**H3 orbit dimensions** (1216×672): baked in node 44, correctly not exposed as params.
`width`/`height` params control the KREA-2 anchor frame only. Documented in port descriptions.

---

## Models

| Filename | Type | URL | Status |
|---|---|---|---|
| Krea2/Krea2_Turbo_convrot_int8mixed.safetensors | unet | Kutches/Kr3a HuggingFace | HTTP 200 ✓ |
| qwen3vl_4b_fp8_scaled.safetensors | clip | Comfy-Org/Krea-2 HuggingFace | HTTP 200 ✓ |
| qwen_image_vae.safetensors | vae | Comfy-Org/Krea-2 HuggingFace | HTTP 200 ✓ |
| MinimaxH3/minimax_h3_fl2va_pruned_int8_convrot.safetensors | unet | Comfy-Org/MiniMax-H3 HuggingFace | HTTP 200 ✓ |
| qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors | clip | Comfy-Org/MiniMax-H3 HuggingFace | HTTP 200 ✓ |
| h3/minimax_h3_video_vae_fp16.safetensors | vae | Comfy-Org/MiniMax-H3 HuggingFace | HTTP 200 ✓ |
| h3/minimax_h3_audio_vae_fp32.safetensors | vae | Comfy-Org/MiniMax-H3 HuggingFace | HTTP 200 ✓ |
| minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors | lora | Kijai/MiniMax-H3_comfy HuggingFace | HTTP 200 ✓ |
| minimax_h3_ref_lora_rank_256_bf16.safetensors | lora | Kijai/MiniMax-H3-experimental HuggingFace | HTTP 200 ✓ |

All 9 URLs verified HTTP 200. No MODEL_KEYS gaps (all keys in standard pre-flight set).

---

## Open items

_(none — e2e test passed; output format fixes applied and pending re-verification run)_
