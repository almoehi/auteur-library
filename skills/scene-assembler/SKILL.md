---
name: scene-assembler
description: >
  Trigger when tasked with concatenating the rendered video clips for a single scene
  into a scene-level MP4 — e.g. "assemble scene 2 clips", "concatenate clips for scene 3".
  Reads the approved clip artifact for a scene, concatenates all clips in shot order
  using ffmpeg, verifies the output, and saves the assembled scene video.
  Do NOT invoke for rendering, shooting, quality checking, or full-film assembly.
agentType: worker
---

# Scene Assembler

## What this skill produces

`scene{X}_final.mp4` — a single concatenated video containing all approved clips for
the scene, in shot order.

---

## Phase 1 — Read clip artifact

Read `scene{X}_clips` artifact to get all clip URLs and their shot order.
Use `get_artifact_url` for each clip file to get download URLs.

Download all clips to sandbox: `/tmp/assembly_scene{X}/`

Verify each clip before assembly:
```bash
ffprobe -v error -show_entries stream=duration,codec_type \
  -of default=noprint_wrappers=1 /tmp/assembly_sceneX/clip.mp4
```

If any clip fails ffprobe (duration 0 or missing video stream): skip it and log a warning.
Only assemble clips that have valid video streams.

---

## Phase 2 — Concatenate in shot order

Create ffmpeg concat manifest:
```bash
# Write concat list
for f in /tmp/assembly_sceneX/scene{X}_clip*.mp4; do
  echo "file '$f'" >> /tmp/assembly_sceneX/concat.txt
done

# Concatenate (re-encode to ensure consistent stream parameters)
ffmpeg -f concat -safe 0 -i /tmp/assembly_sceneX/concat.txt \
  -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p \
  /tmp/assembly_sceneX/scene{X}_final.mp4
```

Clips must be assembled in SHOT ID order (s{X}-01, s{X}-02, ...), not filename order
if those differ.

---

## Phase 3 — Verify output

```bash
ffprobe -v error -show_entries \
  stream=duration,codec_type,width,height \
  -of json /tmp/assembly_sceneX/scene{X}_final.mp4
```

Checks:
1. Video stream exists
2. Duration > 0
3. Duration ≈ sum of input clip durations (within ± 1 second)
4. Resolution consistent with input clips

If verification fails: log the error, attempt re-encode with relaxed parameters, then
call `task_complete` with failure summary if it still fails.

---

## Completion contract

Call `task_complete` with:
- Scene ID
- Number of clips assembled
- Total assembled duration in seconds
- Output filename
- Any clips that were skipped with reason
