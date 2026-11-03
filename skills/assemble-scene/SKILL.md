---
name: assemble-scene
description: >
  Use when the task prompt says "Load and use skill: assemble-scene", or tasks you with joining
  the rendered clips of one scene into a single scene video — e.g. "assemble scene 2", "stitch the
  clips of scene 3", "render the final cut of scene 1" (a direct user request is turned into the
  assembly task by the coordinator skill shoot-scene-task). Produces
  one mp4 with all clips back to back in clip order and levelled audio (the `assemble_scene_audio` tool, no transitions).
  Do NOT invoke for rendering or shooting clips (shoot-clip), planning a scene
  (shoot-scene-task), quality checks, or full-film assembly.
agentType: worker
---

# Assemble Scene

Joins the finished clips of ONE scene, in task order, into the canonical output file the task names (`<name>_assembled.mp4`, e.g. `scene3_v2_assembled.mp4`; the examples below write it `scene<N>_assembled.mp4`). No transitions, no trimming, no rendering; the audio is levelled by the server's recipe (`assemble_scene_audio`), never by hand-composed ffmpeg.

## 1. Preflight

- The task prompt lists the clips in order (`artifact://<artifactId>/<file>`, planned durations) and the canonical output file.
- `read_artifact` each clip's artifact: approved and the video file present.
- Any clip missing or unapproved -> `task_failed(reason)` naming it. Never assemble a subset.

## 2. Fetch and probe

- `sandbox_fetch(url="artifact://<id>/<file>")` each clip into `/tmp/assemble_scene<N>/` (never a copied presigned URL).
- `ffprobe` each: codec, size, fps, pixel format, audio presence / sample rate, duration.
- A clip with no video stream or zero duration -> `task_failed(reason)` naming it (nothing is written yet).

## 3. Level the audio and concatenate (task order, not file-name order)

- ONE call does the audio levelling and the join - never hand-written ffmpeg for them: `assemble_scene_audio(clips=[<sandbox paths in task order>], output_path="/tmp/assemble_scene<N>/scene<N>_assembled.mp4")`. The server's recipe: every clip is gain-matched to -23 LUFS (boost capped at +15 dB, a silent clip is left alone, a clip without audio gets a silent track), video streams are copied untouched, the clips are concatenated, then the whole scene is normalised once to -16 LUFS / -1.5 dBTP.
- The result is `{ok, outputPath, integratedLufs, truePeakDb, clips: [{path, hasAudio, measuredLufs, gainDb}], warnings}`; `integratedLufs` / `truePeakDb` are MEASURED on the finished file.
- `ok: false` -> read the error. A concat failure naming codec / size / frame rate means the clips differ: re-encode ONLY the differing clips' video to the first clip's resolution and fps first (`ffmpeg -y -nostdin ... -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p`, scaled with letterbox / pad, no stretching), then call the tool again on the normalized files. Any other error -> `task_failed` with it.
- Always `ffmpeg -y -nostdin …` for any ffmpeg call you do make: sandbox stdin is closed, so without `-y` an existing output makes ffmpeg exit at once ("Not overwriting - exiting") instead of writing the file.

## 4. Verify and deliver

- Probe the result: video stream present; duration ≈ sum of clip durations (±1 s); intended resolution / fps.
- Audio audit from the tool result: `integratedLufs` within 1 LU of -16 and `truePeakDb` at most -1.5; a `null` loudness (silent scene) or a clip whose `measuredLufs` was `null` / below -60 is reported in the task result (the clip has no usable audio) - not fixed here.
- A command that exited 0 and wrote the output succeeded: probe the file instead of re-running it. Failure (non-zero exit, timeout, bad probe) -> retry once with the re-encode route; still failing -> `task_failed` with the error (nothing written yet).
- Only after verification passes, write the result to the declared output path, exactly the task's output file name (the tool writes its `output_path` only on success; pass the work path, then move / write it to the declared name once verified).
- `task_complete`: 1-3 lines — total duration and route (copy / re-encode), not the per-clip list ("Concise replies and task/artifact URIs" in `workflow-calling-conventions`).
