# pose_gen - adding a new pose to the reference library

Generates a new library pose: grey mannequin renders, then line art and depth maps in the library's style, in the
library's camera views. Only the scripts are committed here. **Images are never committed** (NSFW content): they
live in the job dir and in a scratch dir until a person has reviewed them.

Origin: `PLAN_POSE_CATALOG_ADOPTION.md` section 4.6 L2 (video-harness `knowledgebase/`). It was first used on
2026-11-10 for "edge of surface", "against the wall", "against the wall from behind" (a proposed position), "oral,
kneeling", "oral, between the knees" and the solo "kneeling oral to the viewer". "Solo astride" was dropped: its
position (cowgirl, "astride person A's hips") cannot hold without the partner.

The solo "kneeling oral to the viewer" is usable only for the moment BEFORE contact: video-harness S1 refuses
single-person references on contact shots.

## Files

| File | Runs | Does |
|---|---|---|
| `poses.py` | host | THE pose specs (`PoseSpec`): catalog position, roles, extra limb detail, the support (furniture), the camera text per view. Prompts are built limb by limb from the server pose catalog |
| `build_jobs.py` | host | Writes a stage's job JSON into the job dir: `base`, `turns`, `fallback`, `lineart` |
| `run.sh` | host | Copies `run_jobs.ts`, `harness.cjs` and the two library style samples into the job dir, fixes the REPL bridge, runs ONE job file in the `harness` container |
| `run_jobs.ts` | REPL (container) | load -> provision -> run the jobs (at most `INFLIGHT` in flight) -> download -> teardown in `finally` |
| `harness.cjs` | REPL | S3 staging of input images (copied from video-harness `toolchain/mannequin-sheet`) |
| `judge.py` | host | The vision gate. Base renders are checked against the catalog definition (the relabel audit's method, `../jobs/relabel_v5/audit.py` + `review.py`, with the furniture "above" exception). Views use `--same-as <base>`: the same pose as the accepted base? Both are a majority of 3 votes |
| `extract.py` | host | Library-style depth (Depth Anything V2, support kept, library value range and background) + the cleaned line art of the style edit, same 3:4 crop |
| `fidelity.py` | host | Flags line art that drifted from the render (silhouette IoU < 0.6) |
| `sheet.py` | host | Contact sheet per pose: one row per view (mannequin, line art, depth) + a library row |
| `templates/` | - | One-job examples of every stage (worked example: edge of surface, seed 11) and the `chosen.json` / `views.json` shapes |

The authority for every position is `../jobs/relabel_v5/pose_catalog.json`, exported from video-harness
`src/design/pose-catalog.ts` by `../jobs/relabel_v5/export_pose_catalog.mts`. Re-export it whenever the server
catalog changes; never hand-edit it.

A position the server catalog does not have yet goes into `../jobs/relabel_v5/proposed_positions.json`, in the same
shape. The export appends it marked `"proposed": true`. The library audit ignores proposed entries; pose_gen uses
them, so `judge.py` asks for them with `include_proposed`. Example: `against the wall from behind`. It is NOT the
catalog's `standing from behind`, which needs her bent forward at the hips. Add a proposed position to the server
catalog before indexing items tagged with it.

## Prerequisites

- The fat-image container `harness` is running (video-harness `release/run.sh`). It holds the S3 and compute
  credentials; nothing here holds any.
- The bundles `krea2_base_realism_nsfw`, `qwen_image_camera_turn` and `qwen_image_multi_edit` are in video-harness
  `release/workflows/`, which the container mounts as `/work/workflows`.
- Environment:
  - `POSE_GEN_WORKSPACE`: the HOST job dir. It must be below `release/workflows`, e.g.
    `<video-harness>/release/workflows/_mannequin/pose_gen`, so the container sees it (default container path
    `/work/workflows/_mannequin/pose_gen`; set `POSE_GEN_DIR` if yours differs).
  - `REFS_LIBRARY_ROOT`: the `nsfw-poses-references` checkout (the style samples are read from it).
  - `FEATHERLESS_API_KEY`: the vision judge. Source it in a subshell (`set -a; . <video-harness>/video-harness/.env; set +a`) and never print it.
- Host Python through `uv run --no-project --with ...` (isolated; see each script's docstring).
- Run ONE REPL job at a time: concurrent REPL scripts break the bridge patch.
- Before any Modal CLI call, pin the dev workspace credentials (video-harness root `CLAUDE.md`, "cloud resources").

## Pipeline

1. **Define the pose** in `poses.py`:
   - `position` is a catalog name; the prompt takes the catalog's ESSENTIAL supports with your role names ("the
     man" / "the woman").
     - A solo pose keeps only the supports about her own body.
     - Catalog details (hands, the other foot) are left out on purpose: `extra` states them, so the two cannot
       contradict each other.
   - `extra` adds limb-level detail: where the weight is, the feet, the knees, the hands, who faces whom.
     State negatives positively ("both of his feet flat on the floor, both legs straight"). A vague sentence
     drifts: in the first spike he raised his own knee into her lap.
   - `furniture` describes the support the pose needs, or `""` for the bare floor.
   - `camera[view]` is the camera text per view. It is used for the base view (`front`) and for any t2i fallback.
2. **Base renders**: `build_jobs.py base <slug>` writes 4 seeds of the front view, then `run.sh jobs_base.json`.
3. **Gate**: `judge.py <slug> <job dir>/<slug>/base_s*.png`.
   - Each vote is a blind facts call (postures, who is above) plus a per-support check.
   - The code decides; the model only answers. A render passes on a majority of 3 votes.
   - Pick a passing seed (and the best-looking one among them). If none passes, fix the prompt, don't continue.
   - A person may OVERRIDE a judge false negative after looking at the seeds. Record the verdict in the pose's
     `chosen.json` entry (`"verdict"`, the job notes). Example: "against the wall" seed 7301, read as "seated" by
     the judge.
   - Where the support makes it impossible, the base view is not `front`: give the spec no `front` camera, and the
     base renders the `side` view. Example: the wall occludes the couple in "against the wall from behind".
4. **Camera turns**: write `chosen.json` (see `templates/`), then `build_jobs.py turns chosen.json` and
   `run.sh jobs_turns.json`.
   - The default turns are side, diag, back and high. Low goes straight to the t2i fallback, because the low-angle
     turn never left eye level. Choose turns per pose with `"turns"` (e.g. `side_left`, `diag_left`).
   - The turns use `qwen_image_camera_turn` with the LoRA grammar `<sks> <azimuth> <elevation> <distance>`:
     side = `right side view`, diag = `front-right quarter view`, back = `back view`, high = `front view
     high-angle shot`, low = `front view low-angle shot`, all `eye-level` / `wide shot` unless named.
   - `medium shot` breaks a duo into single figures; keep `wide shot`.
5. **Fallbacks**: for a view the turn could not make (usually `low`; also a base that came out in profile), run
   `build_jobs.py fallback <slug>:<view> ...` and then `run.sh jobs_fallback.json`. This is a seeded t2i with the
   pose text plus `camera[view]`, using the base seed. Gate every fallback with `judge.py` like a base.
6. **Gate the views and name them by what the camera actually sees.**
   `judge.py <slug> --same-as <accepted base> <view>.png ...` passes a view when it shows the same pose as the
   base: same people, support, limbs and contact (majority of 3). Look at every view yourself as well: the judge
   passed a "between the knees" low view in which she faced away from him.
   The library convention for names:
   - `front` faces the camera, `side` is the profile, `diag` the three-quarter view;
   - `high` / `low` look from above / below, `back` from behind.
   - A turn can land elsewhere than its name: label the result, not the request. Write `views.json`.
7. **Line art (style edit)**: `build_jobs.py lineart views.json`, then `run.sh jobs_lineart.json 4`.
   - `qwen_image_multi_edit`: Picture 1 = the render, Picture 2 = a library line-art sample (duo:
     `duo/seated_back_facing/pair60_P009_front`, solo: `solo/full_body_sexy/kneeling_all_fours/full_sexy_P031_front`).
   - It redraws the figures as the library's articulated mannequin drawing: construction lines, joint circles,
     segment contours, no furniture. Seed 22 dropped the furniture best in the experiment.
8. **Extract**: `extract.py <parts dir> <view>=<render>,<line art> ...`.
   - Depth: the figures AND the support are normalised to 0.5..1.0 (white = near), over the library background:
     about 0.2 flat in the upper half, rising to about 0.5 at the bottom. This range was measured on 12 library
     samples.
   - The support is the bria-rmbg mask (it keeps a counter or a bed) plus every near region above the feet line
     that touches it. That adds a wall panel, which bria drops as background.
   - `<view>=<render>,plain` extracts PLAIN line art instead (controlnet_aux; not the library style). It is the
     fallback for top-down views, which the style edit cannot do.
   - Both images use one crop (figures + support, 3:4) and are scaled to 900x1200.
9. **Check the line art**: `fidelity.py <parts dir>` flags a view whose line art left the render's silhouette.
   - The score is the better of two references, people only and people + support, because the edit sometimes
     draws the counter too.
   - Redo a flagged view with another seed (`views.json` value `{"file": ..., "seed": 33}`), at most 3 tries.
     After that, use the plain fallback or drop the view.
   - The check does not apply to plain line art, which traces the render itself: its thin open lines do not fill
     into a silhouette.
10. **Contact sheet**: `sheet.py rows.json <parts dir> <out.png> "<title>"`. Rows are views; a row without images
    names a view that could not be made. Add the library row. A person reviews the sheet before anything else
    happens.
11. **Into the library** (only after review; the user decides when to publish):
    - Copy each view as `pose_pngs/<folder>/<prefix>_<P-number>_<angle>.png` and
      `pose_depth/<folder>/<same name>`. Folder examples: `duo/<category>`, `solo/full_body_sexy/<category>`.
      Add one row per view to `pose_pngs/catalog.csv`: `file, folder, series_ja, category_ja, pose_number,
      pose_name_ja, angle`. Use the next free P-number of the series.
    - The id becomes `<series>/<P-number>`; `solo` follows the series (`duo` = two people).
    - Angles are `front, high, low, side, diag`. **`back` is NOT a library angle yet**: `catalog.py` `Angle` and
      the server's `poseViewAngleOf()` need the S5 change of the plan first. Until then, leave back views out.
    - Labels: run the `pose_vision` labelling job for the new ids (`LABELING.md`: `uv run refs jobs make
      pose_vision`, agents, `collect`). Then make sure `sex_positions` is exactly the position the pose was built
      from (and only positions the gate confirmed), and that `typical_acts` holds the act (e.g. `blowjob` for an
      oral item).
    - Rebuild the index: `uv run refs index build <version>` (local, `data/index/<version>`).
    - Upload and publish only when the user says so: `uv run refs upload-assets`, then
      `uv run refs index publish <version>`, then refresh the video-harness fixtures.

## Costs observed (2026-11-10, Modal L40S, shared app)

Separating your own cost from others' on the shared app is not possible after the fact. Modal bills per hour per
app, and other workspaces render there too: the 02:00 UTC hour of 2026-11-10 showed $5.19 with other users' batches
in it. Budget with the per-job figure below and count your jobs.

- About $0.05-0.08 per GPU job including cold starts. The endpoint scales down after 2 s idle, so `run_jobs.ts`
  stages inputs first and polls every second to reuse warm containers.
- A full pose takes about 16 jobs: 4 base renders, 5 turns, 1-2 fallbacks and 6 style edits. That is about $1
  per pose.
- The judge (Featherless) is about $0.01 per vote, so about $0.04 per gated render.
- Tear-down: `run_jobs.ts` tears the endpoint down, but Modal containers can linger while something pings the
  endpoint. Afterwards, list containers (`modal container list`) and stop only the ones whose start time matches
  your run.

## Known pitfalls

- **Judge noise.** The same render flips between calls, so the gate is a majority of 3 votes; one vote proves
  nothing. The judge also misreads postures: a woman with one knee raised against a wall was read as "seated".
  None of the 4 "against the wall" seeds passed.
- **"above" at furniture.** The catalog's `above` is not judged where the vertical order is set by sitting,
  kneeling or standing at furniture: one person seated on the support and the other standing or kneeling (user
  decision, `judge.py` `structural()`). Without this, "edge of surface" and "between the knees" always failed: the
  judge answers "neither" there.
- **Judge false negatives and positives.** It read "against the wall" as "seated" (a human override released it).
  It read the same "between the knees" render once as "kneeling", every support holding, and once as "squatting".
  It passed a low view in which she faced away from him. The gate is a filter, not a verdict: the contact sheet
  review decides.
- **Solo poses defined by an absent partner** (`cowgirl`: "astride person A's hips") fail the gate: the support
  cannot hold without the partner. "Solo astride" was dropped for this reason.
- **Turns that land elsewhere.** A side turn of a profile base often lands behind one partner (label it `back`). A
  turn can also land behind the wall and show only the panel, or put the kneeling partner beside the knees instead
  of between them. Gate every view.
- **The low view is weak.** `low-angle shot` usually stays near eye level, so expect a t2i fallback. The
  fallback's "as a lying person sees her" draws that person into a solo picture, so describe only the camera.
  Even with the worm's-eye wording, the edge-of-surface fallback failed the gate (a view from behind him).
- **A frontal base for a face-to-face duo** puts one partner's back to the camera. A profile base is what the
  model tends to give for oral poses; a front three-quarter fallback gets her front.
- **The style edit cannot do top-down views**: it redraws the library reference (the seated P009 couple) instead
  of our figures. This happened on edge-of-surface high with seeds 22 and 33, and on between-the-knees high. Use
  the plain fallback there.
  - It also sometimes draws the counter despite the instruction (harmless: `fidelity.py` scores against the
    support too).
  - Always run `fidelity.py` and look at the sheet.
- **The depth mask must keep the support.** People-only masks (u2net_human_seg, birefnet) drop the counter or
  bed; bria-rmbg keeps it, but drops a wall panel, hence the near-region union.
  - The union can leave small stray bands at the frame edges, where they touch the figures (seen on the wall's
    top edge and beside the bed). Review the depth column.
- **Tinted skin.** Some seeds render a beige or skin-tone figure; reject them by eye.
