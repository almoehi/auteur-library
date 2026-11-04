---
name: assemble-episode
description: >
  Use when the task prompt says "Load and use skill: assemble-episode": joins the finished scene
  videos of ONE micro-drama episode, in the given order, into the episode's single vertical video
  (`episode_<n>.mp4`, levelled audio, no transitions). The tasks are created by the coordinator
  skill assemble-episodes. Do NOT invoke for joining the clips of one scene (assemble-scene),
  shooting clips (shoot-clip), or planning scenes or episodes.
agentType: worker
---

# Assemble Episode

Joins the scene videos of ONE episode into the canonical output file the task names
(`episode_<n>.mp4`). The scene videos are the outputs of the scene assembly tasks
(`<name>_assembled.mp4`); this task only puts them back to back.

## 1. Preflight

- The task prompt lists the scene videos in order (`artifact://<artifactId>/<file>`) and the
  output file. Never reorder, add or drop a scene.
- `read_artifact` each: approved and the video file present. Any missing or unapproved ->
  `task_failed(reason)` naming it. Never assemble a subset.

## 2. Join

Load skill `assemble-scene` and follow its sections 2-4 exactly, with the scene videos as its
clips (task order), work folder `/tmp/assemble_episode<n>/` and the task's output file
(`episode_<n>.mp4`) as the output name. The same tool (`assemble_scene_audio`), the same
re-encode route for scene videos that differ in size or frame rate, the same verification
(duration = sum of the scene videos ±1 s, vertical size kept, loudness audit).

## 3. Complete

`task_complete` in 1-3 lines: episode number, total duration, route (copy / re-encode).
