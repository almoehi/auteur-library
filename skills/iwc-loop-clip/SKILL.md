---
name: iwc-loop-clip
description: >
  Use when the task prompt says "Load and use skill: iwc-loop-clip", or asks to render the montage
  CLIPS of one look of an iWantClips episode from its finished storyboard: each clip starts on its
  still's storyboard frame (h3_single_cut_clip_nsfw, slow motion: 7.3 s rendered, played 10.9 s),
  with the character's face view, the outfit picture and the set's empty plate as references; ONE
  in-place gesture per clip from the plan; per-clip cut / camera-drift / motion checks, one retry,
  a clip list and a summary. Do NOT invoke for planning (iwc-play-preproduction), scheduling the
  look tasks (iwc-schedule-loops), storyboards (storyboard-scene), scene clips of the film
  pipeline (shoot-clip) or editing the montage with the episode audio (post-production).
agentType: worker
---

# Montage clips: render the clips of one look

A look is one camera set-up of the montage. Its clips are listed in the visual plan (`clips` with
`look` = this look): each has a slot on the audio, a STILL (one frame of the look's storyboard) and
ONE gesture with its `prompt_line`. Every clip is one render of `wf_h3_single_cut_clip_nsfw`:
the still's frame is the start frame (`ref0`), and the clip may END anywhere - the montage cuts
hard to the next clip, so no clip returns to its start pose. Read `workflow-calling-conventions`
(`load_skill`) and `get_workflow_instructions` of `wf_h3_single_cut_clip_nsfw` once. Prompts come
from `prompt-writer-minimaxh3` via `draft_prompt` (pass `prompt_ids`, never typed text).

**Slow motion** (cost test 2026-11-09): every clip is rendered SHORT at a calm natural tempo and
played 1.5× slower: `duration_seconds` = 7.3 with `fps` = 32 (the graph's RIFE 2× makes 48 frames
per rendered second; 32 fps plays them 1.5× slower), so it plays 10.9 s. Same look, calmer motion,
a steadier room, about 0.54× the cost of a full-length render (the workspace profile sets 6
steps). The prompt's seconds are on the RENDER clock (0-7.3 s); the tempo line asks for a calm
natural tempo (the slow motion does the slowing - "slow, languid" on top turns sluggish).

**What the pilots taught** (built into the template): ONE gesture in place per clip; nothing toward
or away from the lens (a lean-in or a hip roll toward the lens made the model push the camera in);
the set's empty plate as an extra reference and explicit fixed-camera wording keep the room
stable; face, choker, key pendant and violet nails are named in every prompt.

The footage is 16:9 landscape from a FIXED camera on a tripod: at most a very slow, subtle push in
or out; never handheld-style movement, shake, pan, orbit, zoom jumps or reframing.

## 1. Preflight

Fields: `look` (the look id), `scene` (N), `storyboard` (default `storyboard_scene_<N>`),
`character` (default `character_vesper`), `outfit` (the outfit design key; `none` for a nude
look), `location` (the location design key), `plan` (default `visual_plan`), `inputs` (default
`episode_inputs`).
1. `task_failed(reason)` if the tool `wf_h3_single_cut_clip_nsfw` is missing.
2. `artifact_index`: the storyboard artifact must be finished (approved); else
   `task_failed("<storyboard> is not finished yet - finish it in the design studio and retry")`.
3. `read_artifact` `visual_plan.json`: `looks[<look>]` (`camera`, `body_pose`, `anchor_contact`,
   `outfit_id`, `set_id`, `items`, `stills` with `id`, `beat`, `hands`, `face`), the look's set
   (`sets[]`: description, light), the outfit description, `tempo`, and the clips whose `look` is
   this look (in plan order; with a `pilot` block whose `look` is this look: only its `clips`).
4. `read_artifact` the storyboard: `design.json` (`notes`; `published.outputs`: entries of group
   `frame` with `file`, `shot`, `edits`, `revision`) and `shotlist.md`.
5. **The still frames**: the storyboard `notes` (= scene N's Summary) START with `Montage stills:
   beats N.a-N.b.` Still k of the look (its `beat` = k) is beat `N.(a+k-1)`. For each still: the
   shots of `shotlist.md` whose `Beat:` line is exactly that beat; take the LAST of them in shot
   order and its published frame (the `frame` output whose `shot` is that shot id). Keep its shot
   block (`Action`, `Body pose`, `Contact`, `Camera`, `Frame`, `Lighting`, `LoRAs`) and the
   frame's `edits` trail. No marker, or a still without a shot or a published frame:
   `task_failed` naming it (never fall back to another still's frame).
6. `read_artifact` the character design (`view_face.<ext>`), the outfit design
   (`full_body_shot.<ext>`, or its published view matching the look's pose; none for a nude look)
   and the location design: the EMPTY PLATE of the look's set (`full_body_shot.<ext>` for `view:
   main`, else the published view named by the set's `view`).

## 2. The prompt (one per clip)

**References** (numbered over the refs supplied, without gaps): `ref0` = the clip's still frame
(`artifact://<storyboard>/<frame file>`, Picture 1: the start frame), `ref1` =
`artifact://<character>/view_face.<ext>` (Picture 2), `ref2` = the outfit picture (Picture 3),
`ref3` = the set's empty plate (Picture 4). A nude look has no outfit picture: the plate moves to
`ref2` (Picture 3) and every "<Picture 4>" below becomes "<Picture 3>".

**The template** (fill the `<…>`, keep every other word):

```
subject_definitions:
<Picture 1> is the start frame of the video: <the still in one sentence: body pose, contact, hands, gaze - from the shot block and the still's hands / face>.
<Picture 2> is the face and identity reference of <Subject 1> (S1), Vesper: <age, hair, eyes, one face detail>.
<Picture 3> is the outfit reference of <Subject 1>: <the outfit's garments>, a wide black velvet choker, a small silver KEY pendant on a thin silver chain (a key, never a cross), violet nail polish.
<Picture 4> is the empty set: <the room, its stage furniture, the key light and its side, the colour accents and their side>.

summary:
[keyframe completion] One continuous take from a fixed camera on a tripod in <the room>, 16:9 landscape, framed <the look's camera line>. Vesper performs ONE <gesture name> in place.

retention_analysis:
A fixed camera on a tripod: no handheld movement, no shake, no pan, no zoom, no cut; at most a very slow, subtle push in or out. The framing of <Picture 1> is kept for the whole video. The background is the room of <Picture 4> the whole time: <the furniture and lights> stay where they are in <Picture 1>. She stays at the same distance from the camera and in the same body pose. Her face, hair, outfit, the wide black velvet choker, the small silver key pendant on its thin silver chain and the violet nails stay as in <Picture 2> and <Picture 3>.

detailed_description:
Style: photorealistic 16:9 landscape footage, <the lighting line of the shot>, intimate and nocturnal. Every movement is smooth and continuous at a calm natural tempo, like a private cam show for one viewer; she holds eye contact; nothing is jerky or busy.
[Shot 1] For the target video, at 0.00 seconds, <Picture 1> is fully referenced. 0-1 s: she holds the pose of <Picture 1>, <the still's face>. 1-6 s: <the clip's prompt_line, its tempo words made calm and natural>. 6-7.3 s: she settles, still in the same body pose and place, eyes on the lens.

overall_soundscape:
Quiet room tone, her soft breathing close to the microphone, no speech, no music.

non_diegetic_music:
None.
```

**Drafting**: `draft_prompt` for `wf_h3_single_cut_clip_nsfw` with `duration_seconds` = 7.3,
`image_inputs` as above, and `context` = the filled template (as the structure to keep) plus the
shot block verbatim, the frame's `edits` trail ("the frame was edited: <edits> - keep those
changes") and these locks VERBATIM:
- "a fixed camera on a tripod: no handheld movement, no shake, no pan, no zoom, no cut; at most a
  very slow, subtle push in or out"
- "the background is the room of <Picture 4> the whole time"
- "ONE gesture in place at a calm natural tempo; she stays in the same body pose at the same
  distance from the camera; she never leans toward the lens"
- "a wide black velvet choker, a small silver KEY pendant on a thin silver chain (never a cross),
  violet nail polish"
- "no speech: her lips stay closed or part only for soft breaths and the gesture's sounds; no
  music"
One `review_prompt` against the template: the drafted prompt keeps the six sections, the
`[keyframe completion]` tag, the timestamped phases, the gesture and every lock; a missing lock or
section is a significant gap: one `enhance_prompt` naming it.

## 3. Render and check (per clip, in plan order)

1. **Render**: `wf_h3_single_cut_clip_nsfw` with `ref0`-`ref3` as above, `prompt_ids`,
   `duration_seconds` = 7.3, `fps` = 32 (slow motion; never 48), `seed` = the clip's `seed`, no
   `steps` (the workspace profile sets 6), LoRAs: only the shot's `LoRAs:` names of the
   minimaxh3 family (no act LoRA). Never pass width / height (the still's 16:9 shape decides).
   Outputs → `/workspace/<artifact id>/<clip id>.mp4` (`output_video`); the audio output is not
   kept. The clips are independent: submit them one after another, then collect.
2. **Checks** (sandbox; ffmpeg + python3 with numpy - `pip install numpy` if the import fails).
   Save this as `/tmp/clipcheck.py` once and run `python3 /tmp/clipcheck.py <video>` per take:

```python
import json, subprocess, sys, tempfile, pathlib
import numpy as np

video = sys.argv[1]
d = pathlib.Path(tempfile.mkdtemp())
subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", video, "-vf",
                "fps=4,scale=360:-2,format=gray", str(d / "f_%04d.pgm")], check=True)


def pgm(p):
    b = p.read_bytes()
    parts = b.split(maxsplit=4)
    w, h = int(parts[1]), int(parts[2])
    return np.frombuffer(parts[4][-w * h :], np.uint8).reshape(h, w).astype(np.float32)


A = [pgm(p) for p in sorted(d.glob("f_*.pgm"))]
H, W = A[0].shape
m = np.zeros((H, W), bool)
m[: int(H * 0.18), :] = True
m[:, : int(W * 0.12)] = True
m[:, int(W * 0.88) :] = True
step = [float(np.abs(A[i] - A[i - 1])[m].mean()) for i in range(1, len(A))]
drift = [float(np.abs(a - A[0])[m].mean()) for a in A]
motion = [float(np.abs(A[i] - A[i - 1]).mean()) for i in range(1, len(A))]
r = {
    "frames_4fps": len(A),
    "seconds": round(len(A) / 4, 1),
    "max_bg_jump": round(max(step), 1),
    "jump_at_s": round((step.index(max(step)) + 1) / 4, 2),
    "max_bg_vs_first": round(max(drift), 1),
    "drift_at_s": round(drift.index(max(drift)) / 4, 2),
    "mean_motion": round(float(np.mean(motion)), 1),
    "max_motion": round(max(motion), 1),
}
r.update(cut=r["max_bg_jump"] > 25, camera_moved=r["max_bg_vs_first"] > 30, busy=r["mean_motion"] > 12)
print(json.dumps(r))
```

   The checks and thresholds:
   - (a) **cut / jump**: background bands (top 18 % and the outer 12 % columns, grey, 360 px
     wide, 4 fps) frame-to-frame mean abs diff step > 25 = a cut. FAIL.
   - (b) **camera drift**: the bands vs the first frame > 30 = the camera moved. FAIL - unless the
     gesture itself crosses a band (a hand up through her hair into the top band; at a close
     framing her head or hair fills the band): look at the frames around `drift_at_s`
     (`describe_image`) and, only when her body changed the band, note "band occluded by the
     gesture" instead of failing. A cut is never excused.
   - (c) **length**: `get_video_info` duration 10.5-11.3 s and fps 32; else FAIL (a wrong
     duration or fps setting).
   - (d) **motion**: the mean frame-to-frame diff is reported (target: the plan's
     `tempo.motion_energy`, about 7-9); above 12 = WARN (named in the summary, no retry on its
     own).
   Write `<clip id>_checks.txt`: duration, fps, the JSON line, the verdict per check (pass / FAIL /
   WARN / occluded), the still used (still id, beat, shot, frame file, revision), the gesture and
   the prompt id.
3. **Retry once per clip** on a failed check (a, b or c) or a render failure: a new `draft_prompt`
   with the finding named in `context` ("the camera pushed in at 4 s: keep the framing of <Picture
   1> fixed" / "a cut to another room at 4.5 s"), seed + 1000, files `<clip id>-r2.*` with their
   own checks file. Keep BOTH takes. Never a third render. The clip's take is the one that passes;
   both pass or both fail: the one with fewer failed checks, then the lower `mean_motion`
   distance to the motion target.

## 4. Clip list and summary

1. **`look<N>_clips.json`** (for post-production; write with one `sandbox_exec` python3 snippet):
   one entry per clip in plan order - `id`, `slot` (`start`, `end` from the plan), `still`
   (id, beat, frame file), `gesture`, `file` (the chosen take), `takes` (all files), `checks`
   (the chosen take's JSON line and verdicts), `pass` (true / false).
2. **`look<N>_summary.md`**: the look (id, camera line, body pose), the stills (id, beat, shot,
   frame file, revision), the refs used, and a table per clip: id | slot | still | gesture | cut
   | drift | seconds | mean motion | retries | chosen take | pass; then the pass rate (first try
   and after the retry) and the mean motion.

## 5. Reply

Workflow, look, the stills (beat, shot, frame), per clip one line (gesture, checks, retries,
chosen take), the pass rate, files. Then `task_complete`.
