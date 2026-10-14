---
name: assemble-scene
description: >
  Use when the task prompt says "Load and use skill: assemble-scene", or tasks you with joining
  the rendered clips of one scene into a single scene video — e.g. "assemble scene 2". Produces
  one mp4 with all clips back to back in clip order (ffmpeg in the sandbox, no transitions).
  Do NOT invoke for rendering or shooting clips (shoot-clip), planning a scene
  (shoot-scene-task), quality checks, or full-film assembly.
agentType: worker
---

# Assemble Scene

Joins the finished clips of ONE scene, in clip order, into the canonical file named in the task
(`scene<N>_assembled.mp4`). No transitions, no trimming, no new rendering.

## 1. Preflight

The task prompt lists the clips in order (`artifact://<artifactId>/<file>`, with their planned
durations) and the canonical output file. For every clip: `read_artifact` its artifact, confirm it
is approved and the video file is present. Any clip missing or not approved -> assemble nothing
and `task_complete` with a summary starting `BLOCKED:` naming it. Never assemble a subset.

## 2. Fetch and probe

`sandbox_fetch(url="artifact://<id>/<file>", ...)` each clip into `/tmp/assemble_scene<N>/`
(never copy or retype a presigned URL). Probe each with `ffprobe` (codec, width, height, fps,
pixel format, audio stream presence / sample rate, duration). A clip with no video stream or
zero duration -> `BLOCKED:`.

## 3. Concatenate

Order is the clip order of the task, not file-name order.

- **All clips share codec, resolution, fps, pixel format and audio layout** (or none has
  audio): concat demuxer with stream copy, no re-encode.

  ```bash
  printf "file '%s'\n" /tmp/assemble_scene<N>/clip1.mp4 … > list.txt
  ffmpeg -f concat -safe 0 -i list.txt -c copy scene<N>_assembled.mp4
  ```

- **They differ** (resolution, fps, codec, pixel format, some clips with audio and some without):
  normalize and re-encode only then. Target the first clip's resolution and fps (scale with
  letterbox / pad, no stretching), `-c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p`; audio
  `aac` at a common sample rate, silent audio (`anullsrc`) for clips without it when any clip has
  audio. Use the concat filter (`-filter_complex concat=n=<K>:v=1:a=<0|1>`) or normalized
  intermediates + the demuxer.

Say in the summary which route was used and why.

## 4. Verify and deliver

Probe the result: video stream exists, duration ≈ the sum of the clip durations (±1 s), the
resolution / fps as intended. A failure -> retry once with the re-encode route; still failing ->
`task_complete` with a failure summary.

Write the file to the task's declared output path (the artifact's file `scene<N>_assembled.mp4`,
exactly this canonical name).

## 5. Complete

`task_complete` with a short summary (at most ~10 lines): the clips in order with their measured
durations, the total duration, the route (copy / re-encode), the output file name.
