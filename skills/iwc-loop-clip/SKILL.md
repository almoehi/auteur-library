---
name: iwc-loop-clip
description: >
  Use when the task prompt says "Load and use skill: iwc-loop-clip", or asks to render ONE
  loopable cam-style clip of an iWantClips episode from its finished storyboard: the storyboard
  frame of the clip's anchor beat is the start AND end frame of h3_loop_clip_nsfw, plus the
  character's face view and the outfit picture as references; seam check and a looped preview.
  Do NOT invoke for planning (iwc-play-preproduction), scheduling the clip tasks
  (iwc-schedule-loops), storyboards (storyboard-scene), scene clips of the film pipeline
  (shoot-clip) or joining clips with the episode audio.
agentType: worker
---

# Loop clip: render one seamless cam-style loop

One render with `wf_h3_loop_clip_nsfw`: the workflow pins the start frame (`ref0`) as the LAST
frame too, so the clip loops when copies are concatenated. Read `workflow-calling-conventions`
(`load_skill`) and `get_workflow_instructions` of `wf_h3_loop_clip_nsfw` once. Prompts come from
`prompt-writer-minimaxh3` via `draft_prompt` (pass `prompt_ids`, never typed text).

## 1. Preflight

Fields: `clip` (the clip number N), `storyboard` (default `storyboard_scene_<N>`), `character`
(default `character_vesper`), `outfit` (the outfit design key; `none` for a nude clip),
`location` (the location design key), `plan` (default `visual_plan`), `inputs` (default
`episode_inputs`).
1. `task_failed(reason)` if the tool `wf_h3_loop_clip_nsfw` is missing ("load the
   h3_loop_clip_nsfw workflow").
2. `artifact_index`: the storyboard artifact must be finished (approved); else
   `task_failed("<storyboard> is not finished yet - finish it in the design studio and retry")`.
3. `read_artifact` the storyboard: `design.json` (`published.outputs`: entries of group `frame`
   with `file`, `shot`, `edits`, `revision`) and `shotlist.md`.
4. The anchor frame: the shot whose `Beat:` line is `N.1` (normally the only shot, `frame_1.png`).
   Take the published frame whose `shot` is that shot id. Keep its shot block (the `## <shot id>`
   section: `Action`, `Body pose`, `Pose`, `Contact`, `Camera`, `Frame`, `Lighting`, `Audio`,
   `LoRAs`) and the frame's `edits` trail. No shot with `Beat: N.1`: `task_failed` naming it.
5. `read_artifact` the character design (`design.json` `published.outputs`: the view `face`, file
   `view_face.<ext>`) and the outfit design (`full_body_shot.<ext>`, or its published view that
   matches the anchor's body pose / camera, e.g. `view_front`). A nude clip: no outfit picture.
6. `read_artifact` `visual_plan.json`: clip N's `action`, `kink_focus`, `reinforcement`,
   `items`, `furniture_use`, `start` / `end`, `loop_seconds`.

## 2. Render

1. **Prompt**: `draft_prompt` for `wf_h3_loop_clip_nsfw` with `duration_seconds` = the plan's
   `loop_seconds` and `context` = the shot block verbatim (Action, Body pose, Contact, Camera, plus
   Frame / Lighting / Audio), the frame's `edits` trail ("the frame was edited: <edits> - keep
   those changes"), and the clip's `action` / `kink_focus` / `reinforcement` / `items` /
   `furniture_use` from the plan, with these locks:
   - one continuous take from a locked-off webcam at the shot's `Camera:` framing and angle, no
     camera move, no zoom, no cut;
   - she starts in the anchor of Picture 1 (the shot's `Body pose:` and `Contact:`) and ends in
     EXACTLY that pose, contact and framing, every garment back as at the start;
   - the act-free anchor: an act of the plan's `action` (a hand inside the panties, a toy in use)
     STARTS after the opening (about 15 %) and ENDS before the return (about 80 %); items are back
     where the `Contact:` puts them at the end;
   - no dialogue: her lips stay closed or part only for soft breaths; sound = soft breathing and
     the shot's `Audio:` room tone, no music, no speech;
   - large readable body motions, the reveal / touch in the middle of the clip;
   - the furniture contact stays physical and consistent (she kneels / lies / sits on the same
     piece through the loop and is back on it at the end);
   - the kink focus: its motions and outfit cue are the clip's main action, not an afterthought;
     play to the camera angle (open and close the knees above a low lens, lean into a high one).
   `image_inputs`: `ref0` = `artifact://<storyboard>/<anchor frame file>` (Picture 1, start = end
   frame), `ref1` = `artifact://<character>/view_face.<ext>` (Picture 2, identity; else her
   `full_body_shot`), `ref2` = the outfit picture (Picture 3; omit for a nude clip). One
   `review_prompt` against the shot block and the plan's action; one `enhance_prompt` only on a
   significant gap.
2. **Render**: `wf_h3_loop_clip_nsfw` with `ref0` / `ref1` [/ `ref2`] as above, `prompt_ids`,
   `duration_seconds`, LoRAs: the shot's `LoRAs:` names that belong to the minimaxh3 family plus an
   act LoRA from `lora_index` only when the plan's action has an act. Never pass width / height
   (the anchor's shape decides). Outputs → `/workspace/<artifact id>/clip<N>.mp4`
   (`output_video`) and `clip<N>_audio.flac` (`output_audio`).
3. **Seam check** (sandbox, ffmpeg): `get_video_info`, then extract the first and the last frame
   and compare them (`ffmpeg -i first.png -i last.png -lavfi ssim -f null -`). Build a preview of
   three copies with the duplicated last frame dropped (`clip<N>_loop3.mp4`). Write
   `clip<N>_seam.txt`: duration, fps, SSIM first-vs-last, verdict (`seamless` at SSIM ≥ 0.90,
   else `visible seam`), the anchor frame used (file, shot, revision).
4. **Retry once** on a visible seam or a render failure: new `draft_prompt` with the finding in
   `context` (e.g. "she ended kneeling lower than she started"), fresh seed, files named
   `clip<N>-r2.*`. Keep the first take. Never a third render.

## 3. Reply

Workflow, anchor frame (file, shot, revision), duration, seam verdict and SSIM, retries, files.
Then `task_complete`.
