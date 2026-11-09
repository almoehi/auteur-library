---
name: iwc-loop-clip
description: >
  Use when the task prompt says "Load and use skill: iwc-loop-clip", or asks to render the loop
  VARIANTS of one iWantClips episode clip from its finished storyboard: the storyboard frame of
  the clip's marked anchor beat is the start AND end frame of every variant (h3_loop_clip_nsfw),
  with the character's face view, the outfit picture and the set's empty plate as references;
  per-variant cut / camera-drift / anchor-return / motion checks, a joined preview and a summary.
  Do NOT invoke for planning (iwc-play-preproduction), scheduling the clip tasks
  (iwc-schedule-loops), storyboards (storyboard-scene), scene clips of the film pipeline
  (shoot-clip) or joining clips with the episode audio.
agentType: worker
---

# Loop clip: render the variants of one anchor

A clip is a SET of short variants (the plan's `variants[]`, each `variant_seconds` long on
playback, default 3 × 11 s). Each is one render of `wf_h3_loop_clip_nsfw`: the workflow pins the start frame (`ref0`)
as the LAST frame too, and every variant uses the same anchor frame, so they join seamlessly in
any order and repeat over the clip's span of the audio. Read `workflow-calling-conventions`
(`load_skill`) and `get_workflow_instructions` of `wf_h3_loop_clip_nsfw` once. Prompts come from
`prompt-writer-minimaxh3` via `draft_prompt` (pass `prompt_ids`, never typed text).

Why variants (the v1 pilot): 25 s loops cut away mid-clip into a different room, or the model
slowly pushed the camera in, and the action was a busy montage. A spike of 12 s variants, each ONE
slow gesture in place, with the set's empty plate as an extra reference and explicit tempo and
fixed-camera wording, had no cuts; the key-pendant variant kept the background stable (mean
motion 5.4) and returned to the anchor (first / last mean abs diff 2.1). A hip roll and a lean-in
toward the lens failed (the camera pushed in; ended off the anchor, diff 11.5). The template in
section 2 is that spike's prompt.

**Slow motion** (cost test, 2026-11-09): every variant is rendered SHORT at a natural tempo and
played 1.5× slower - `duration_seconds` = `variant_seconds` / 1.5 (one decimal: 11 → 7.3) with
`fps` = 32 (the graph's RIFE 2× makes 48 frames per rendered second; 32 fps plays them 1.5×
slower), so a 7.3 s render plays 10.9 s. Same look, calmer motion, a steadier room, about 0.54×
the cost of a full-length render (with the workspace's 6 steps). The prompt's phase seconds are
on the RENDER clock (0-7.3 s), and the tempo line asks for a calm natural tempo (the slow motion
does the slowing; "slow, languid" on top of it turns sluggish).

The footage is 16:9 landscape from a FIXED camera on a tripod: at most a very slow, subtle push
in or out; never handheld-style movement, shake, pan, orbit, zoom jumps or reframing.

## 1. Preflight

Fields: `clip` (the clip number N), `variants` (count; default the plan's), `variant_seconds`
(playback seconds; default the plan's, 10-12), `storyboard` (default `storyboard_scene_<N>`), `character` (default
`character_vesper`), `outfit` (the outfit design key; `none` for a nude clip), `location` (the
location design key), `plan` (default `visual_plan`), `inputs` (default `episode_inputs`).
1. `task_failed(reason)` if the tool `wf_h3_loop_clip_nsfw` is missing ("load the
   h3_loop_clip_nsfw workflow").
2. `artifact_index`: the storyboard artifact must be finished (approved); else
   `task_failed("<storyboard> is not finished yet - finish it in the design studio and retry")`.
3. `read_artifact` the storyboard: `design.json` (`notes`; `published.outputs`: entries of group
   `frame` with `file`, `shot`, `edits`, `revision`) and `shotlist.md`.
4. **The anchor beat**: the storyboard `notes` (= scene N's Summary; else read `scene_list.md`
   of artifact `scene_list`, scene N's Summary) START with `Loop anchor: beat N.k.` - that `N.k`
   is the anchor beat. It is NOT always `N.1` (an outfit-change beat `N.1` can come first). No
   marker: `task_failed("scene N's Summary names no anchor beat (Loop anchor: beat N.k)")`.
5. **The anchor frame**: the shots of `shotlist.md` whose `Beat:` line is exactly `N.k`; take the
   LAST of them in shot order (never blindly the first shot or `frame_1`), and its published frame
   (the `frame` output whose `shot` is that shot id). Keep its shot block (the `## <shot id>`
   section: `Action`, `Body pose`, `Pose`, `Contact`, `Camera`, `Frame`, `Lighting`, `Audio`,
   `LoRAs`) and the frame's `edits` trail. No shot with that beat or no published frame for it:
   `task_failed` naming it.
6. `read_artifact` the character design (`published.outputs`: the view `face`, file
   `view_face.<ext>`), the outfit design (`full_body_shot.<ext>`, or its published view that
   matches the anchor's body pose / camera, e.g. `view_front`; none for a nude clip) and the
   location design: the EMPTY PLATE of the clip's set - its `full_body_shot.<ext>` (main picture)
   for a set with `view: main`, else the published view named by the set's `view`.
7. `read_artifact` `visual_plan.json`: clip N's `variants[]` (id, mood, gesture, phases),
   `anchor_pose`, `anchor_contact`, `kink_focus`, `items`, `furniture_use`, `start` / `end`,
   `cycles`; the set (`sets[]` of its `set_id`: description, light) and the outfit description.
   Fewer variants in the plan than the `variants` field: render the plan's; more: the first
   `variants`.

## 2. The prompt (one per variant)

**References** (Pictures are numbered over the refs supplied, without gaps):
`ref0` = `artifact://<storyboard>/<anchor frame file>` (Picture 1: start = end frame), `ref1` =
`artifact://<character>/view_face.<ext>` (Picture 2: identity), `ref2` = the outfit picture
(Picture 3), `ref3` = the set's empty plate (Picture 4). A nude clip has no outfit picture: the
plate moves to `ref2` (Picture 3) and every "<Picture 4>" below becomes "<Picture 3>".

**The template** (the spike's proven structure; fill the `<…>` from the shot block and the plan,
keep every other word):

```
subject_definitions:
<Picture 1> is the start frame and also the end frame of the video: <the anchor in one sentence: Body pose, Contact, hands, gaze - from the shot block and the plan's anchor_pose>.
<Picture 2> is the face and identity reference of <Subject 1> (S1), Vesper: <age, hair, eyes, one face detail>.
<Picture 3> is the outfit reference of <Subject 1>: <the outfit's garments>, a wide black velvet choker, a small silver KEY pendant on a thin silver chain (a key, never a cross), violet nail polish.
<Picture 4> is the empty set: <the room, its stage furniture, the key light and its side, the colour accents and their side>.

summary:
[keyframe completion] One continuous take from a fixed camera on a tripod in <the room>, 16:9 landscape. Vesper performs ONE slow, <mood>, seductive gesture in place and returns exactly to the pose of <Picture 1>.

retention_analysis:
A fixed camera on a tripod: no handheld movement, no shake, no pan, no zoom, no cut; at most a very slow, subtle push in or out. The framing of <Picture 1> is kept for the whole video. The background is the room of <Picture 4> the whole time: <the furniture and lights> stay where they are in <Picture 1>. She stays at the same distance from the camera. Her face, hair, outfit, the wide black velvet choker, the small silver key pendant on its thin silver chain and the violet nails stay as in <Picture 2> and <Picture 3>.

detailed_description:
Style: photorealistic 16:9 landscape footage, <the lighting line of the shot>, intimate and nocturnal. Every movement is smooth and continuous at a calm natural tempo, like a private cam show for one viewer; she holds eye contact and smiles playfully; nothing is jerky or busy.
[Shot 1] For the target video, at 0.00 seconds, <Picture 1> is fully referenced. <phase 1: "0-1 s: …">. <phase 2: "1-5 s: …">. <phase 3: "5-7.3 s: … exactly as in <Picture 1>, eyes on the lens.">

overall_soundscape:
Quiet room tone, her soft slow breathing close to the microphone, no speech, no music.

non_diegetic_music:
None.
```

The `[Shot 1]` phases are the variant's `phases` with their seconds converted to the render clock
(the plan's playback seconds ÷ 1.5, one decimal; the last phase ends at the render duration),
each gesture in calm, natural tempo words; the last phase ends in the exact anchor pose of Picture 1 (hands, head, gaze, straps).

**Drafting**: `draft_prompt` for `wf_h3_loop_clip_nsfw` with `duration_seconds` = the render
duration (`variant_seconds` / 1.5), `image_inputs` as above, and `context` = the filled template (as the structure
to keep) plus the shot block verbatim, the frame's `edits` trail ("the frame was edited: <edits> -
keep those changes") and these locks VERBATIM:
- "a fixed camera on a tripod: no handheld movement, no shake, no pan, no zoom, no cut; at most a
  very slow, subtle push in or out"
- "the background is the room of <Picture 4> the whole time"
- "ONE gesture in place at a calm natural tempo; she stays at the same distance from the camera; she never leans
  toward the lens"
- "she ends in exactly the pose of <Picture 1>, every strap and garment as at the start"
- "a wide black velvet choker, a small silver KEY pendant on a thin silver chain (never a
  cross), violet nail polish"
- "no speech: her lips stay closed or part only for soft breaths; no music"
One `review_prompt` against the template: the drafted prompt keeps the six sections, the
`[keyframe completion]` tag, the timestamped phases and every lock above; a missing lock or
section is a significant gap: one `enhance_prompt` naming it.

## 3. Render and check (per variant k, in order)

1. **Render**: `wf_h3_loop_clip_nsfw` with `ref0`-`ref3` as above, `prompt_ids`,
   `duration_seconds` = `variant_seconds` / 1.5 (one decimal), `fps` = 32 (slow motion; never
   48), no `steps` (the workspace profile sets 6), LoRAs: only the shot's `LoRAs:` names that belong to
   the minimaxh3 family (a variant has no act: no act LoRA). Never pass width / height (the
   anchor's 16:9 shape decides). Outputs → `/workspace/<artifact id>/clip<N>_v<k>.mp4`
   (`output_video`) and `clip<N>_v<k>_audio.flac` (`output_audio`). The variants are independent:
   submit them one after another, then collect.
2. **Checks** (sandbox; ffmpeg + python3 with numpy - `pip install numpy` if the import fails).
   Save this as `/tmp/loopcheck.py` once and run `python3 /tmp/loopcheck.py <video>` per take:

```python
import json, subprocess, sys, tempfile, pathlib
import numpy as np

video = sys.argv[1]
d = pathlib.Path(tempfile.mkdtemp())
subprocess.run(
    [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        video,
        "-vf",
        "fps=4,scale=360:-2,format=gray",
        str(d / "f_%04d.pgm"),
    ],
    check=True,
)


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
fl = float(np.abs(A[0] - A[-1]).mean())
r = {
    "frames_4fps": len(A),
    "max_bg_jump": round(max(step), 1),
    "jump_at_s": round((step.index(max(step)) + 1) / 4, 2),
    "max_bg_vs_first": round(max(drift), 1),
    "drift_at_s": round(drift.index(max(drift)) / 4, 2),
    "first_last_diff": round(fl, 1),
    "mean_motion": round(float(np.mean(motion)), 1),
    "max_motion": round(max(motion), 1),
}
r.update(
    cut=r["max_bg_jump"] > 25,
    camera_moved=r["max_bg_vs_first"] > 30,
    off_anchor=fl > 6,
    busy=r["mean_motion"] > 12,
)
print(json.dumps(r))
```

   Plus the SSIM of the first vs the last frame (full size):
   `ffmpeg -v error -y -i <video> -vf "select=eq(n\,0)" -frames:v 1 /tmp/first.png`,
   `ffmpeg -v error -y -sseof -0.1 -i <video> -update 1 /tmp/last.png`, then
   `ffmpeg -i /tmp/first.png -i /tmp/last.png -lavfi ssim -f null - 2>&1 | grep -o "All:[0-9.]*"`.
   The checks and thresholds:
   - (a) **cut / jump**: background bands (top 18 % and the outer 12 % columns, grey, 360 px
     wide, 4 fps) frame-to-frame mean abs diff step > 25 = a cut. FAIL.
   - (b) **camera drift**: the bands vs the first frame > 30 = the camera moved (push-in, pan,
     reframing). FAIL - unless the variant's gesture itself crosses a band (a hand up through her
     hair into the top band, an arm at the frame edge): look at the frames around `drift_at_s`
     (`describe_image`) and, only when her body is what changed the band, note "band occluded by
     the gesture" instead of failing. A cut is never excused.
   - (c) **end on the anchor**: first vs last frame mean abs diff ≤ 6 (spike: 2.1 good, 11.5 bad)
     AND SSIM ≥ 0.90. FAIL otherwise.
   - (d) **motion**: the mean frame-to-frame diff is reported (spike: ~5 good, > 14 too busy);
     above 12 = WARN (named in the summary, no retry on its own).
   Write `clip<N>_v<k>_checks.txt`: duration, fps (`get_video_info`), the JSON line, SSIM, the
   verdict per check (pass / FAIL / WARN / occluded), the anchor frame used (file, shot, beat,
   revision) and the prompt id.
3. **Retry once per variant** on a failed check (a, b or c) or a render failure: a new
   `draft_prompt` with the finding named in `context` ("the camera pushed in at 6 s: keep the
   framing of <Picture 1> fixed" / "she ended with her hand higher than at the start" / "a cut
   to another room at 4.5 s"), a fresh seed, files `clip<N>_v<k>-r2.*` with their own checks
   file. Keep BOTH takes. Never a third render of a variant. The variant's take is the one that
   passes; both pass or both fail: the one with fewer failed checks, then the lower
   `first_last_diff`.

## 4. Preview and summary

1. **Preview** `clip<N>_variants_preview.mp4`: the chosen takes of all variants concatenated in
   order (v1, v2, …), the duplicated join frame dropped (the last frame of every variant but the
   final one), video only:
   `ffmpeg -i v1.mp4 -i v2.mp4 -i v3.mp4 -filter_complex "[0:v]trim=end_frame=<n1-1>,setpts=PTS-STARTPTS[a];[1:v]trim=end_frame=<n2-1>,setpts=PTS-STARTPTS[b];[2:v]setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0[v]" -map "[v]" -c:v libx264 -crf 18 -pix_fmt yuv420p clip<N>_variants_preview.mp4`
   (`n_k` = the frame count: `ffprobe -v error -count_frames -select_streams v:0 -show_entries
   stream=nb_read_frames -of csv=p=0 v<k>.mp4`; `trim=end_frame=<n-1>` keeps all but the last). Also compute each join (last frame of
   v_k vs first frame of v_k+1, grey 360 px, mean abs diff; ≤ 6 is clean) for the summary.
2. **Summary** `clip<N>_summary.md`: the anchor (beat, shot, frame file, revision), the refs
   used, the coverage line (`<variants> × <variant_seconds> s = <cycle> s per cycle; <cycles>
   cycles cover <start>-<end>`), and a table per variant: id | mood | gesture | seconds | cut |
   drift | first-last diff / SSIM | mean motion | retries | chosen take; then the joins.

## 5. Reply

Workflow, anchor (beat, shot, frame, revision), per variant one line (gesture, checks, retries,
chosen take), the joins, files. Then `task_complete`.
