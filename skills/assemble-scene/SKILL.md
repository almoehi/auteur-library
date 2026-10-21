---
name: assemble-scene
description: >
  Use when the task prompt says "Load and use skill: assemble-scene", or tasks you with joining
  the rendered clips of one scene into a single scene video — e.g. "assemble scene 2", "stitch the
  clips of scene 3", "render the final cut of scene 1" (a direct user request is turned into the
  `assemble_scene<N>` task by the coordinator skill shoot-scene-task). Produces
  one mp4 with all clips back to back in clip order (ffmpeg in the sandbox, no transitions).
  Do NOT invoke for rendering or shooting clips (shoot-clip), planning a scene
  (shoot-scene-task), quality checks, or full-film assembly.
agentType: worker
---

# Assemble Scene

Joins the finished clips of ONE scene, in task order, into the canonical `scene<N>_assembled.mp4`. No transitions, no trimming, no rendering.

## 1. Preflight

- The task prompt lists the clips in order (`artifact://<artifactId>/<file>`, planned durations) and the canonical output file.
- `read_artifact` each clip's artifact: approved and the video file present.
- Any clip missing or unapproved, or a clip with no video stream / zero duration -> `task_failed(reason)` naming it. Never assemble a subset.

## 2. Fetch and probe

- `sandbox_fetch(url="artifact://<id>/<file>")` each clip into `/tmp/assemble_scene<N>/` (never a copied presigned URL).
- `ffprobe` each: codec, size, fps, pixel format, audio presence / sample rate, duration.

## 3. Concatenate (task order, not file-name order)

- All clips share codec, resolution, fps, pixel format and audio layout (or none has audio): concat demuxer, stream copy.
  ```bash
  printf "file '%s'\n" /tmp/assemble_scene<N>/clip1.mp4 … > list.txt
  ffmpeg -f concat -safe 0 -i list.txt -c copy scene<N>_assembled.mp4
  ```
- They differ: normalize and re-encode only then.
  - First clip's resolution and fps (scale with letterbox / pad, no stretching); `-c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p`.
  - Audio `aac` at a common sample rate; `anullsrc` silence for clips without audio when any clip has audio.
  - Concat filter (`-filter_complex concat=n=<K>:v=1:a=<0|1>`) or normalized intermediates + demuxer.

## 4. Verify and deliver

- Probe the result: video stream present; duration ≈ sum of clip durations (±1 s); intended resolution / fps.
- Failure -> retry once with the re-encode route; still failing -> `task_failed` with the error.
- Write to the declared output path, exactly `scene<N>_assembled.mp4`.
- `task_complete`: 1-3 lines — total duration and route (copy / re-encode), not the per-clip list ("Concise replies and task/artifact URIs" in `workflow-calling-conventions`).
