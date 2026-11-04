---
name: assemble-episodes
description: >
  Trigger when the user wants the episode videos of a micro-drama cut — e.g. "cut the episodes",
  "assemble episode 3", "make the episode videos", "export episodes 1-4". Schedules, with ONE
  `create_episode_tasks` call, one task per episode that joins the episode's scene videos into
  `episode_<n>.mp4`. Do NOT invoke for shooting or assembling a single scene (shoot-scene-task),
  storyboards, or adapting the story into episodes (adapt-microdrama).
agentType: workspace
---

# Assemble Episodes

Coordinator skill. The episodes come from the `Episode` column of the approved `scene_list`
(written by `run-preproduction` for an adopted micro-drama brief). The server reads it, groups the
scenes and writes every task brief; you never `create_task` an episode cut yourself.

## 1. Preflight

- `artifact_index`: `scene_list` exists and is approved. Missing -> create nothing; say:
  "Cannot cut episodes: there is no approved scene list yet. Run pre-production first."
- Episodes: the ones the user names ("episode 3", "episodes 1-4"); none named -> all.

## 2. Create

ONE call:

```
create_episode_tasks({ episodes: [<the named episode numbers>] })   // omit `episodes` for all
```

The server, per episode: needs every scene of it shot and assembled (`shoot-scene-task`), uses
the newest live assembly of each scene, creates `assemble_episode_<n>` (worker skill
`assemble-episode`, output `episode_<n>.mp4`); an existing one is skipped. An episode with a scene
not yet assembled is NOT created - nothing partial.

## 3. Reply

Concise (see "Concise replies and task/artifact URIs" in `workflow-calling-conventions`): the
created tasks as `task://<id>`, the skipped ones in one line, and for each refused episode the
scenes to shoot first ("Episode 4 needs scenes 9 and 10 shot and assembled first - say
"shoot scene 9" to start."). No `Episode` column -> relay the server's error: the story is not an
episode brief, so there are no episodes to cut.
