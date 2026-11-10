# pose_gen - adding a new pose to the reference library

Generates a new library pose: grey mannequin renders, then line art and depth maps in the library's style, in the
library's camera views. Only the scripts are committed here. **Images are never committed** (NSFW content): they
live in the job dir and in a scratch dir until a person has reviewed them.

Origin: `PLAN_POSE_CATALOG_ADOPTION.md` section 4.6 L2 (video-harness `knowledgebase/`); first used 2026-11-10 for
"edge of surface", "oral, kneeling" and "kneeling oral to the viewer".

## Files

| File | Runs | Does |
|---|---|---|
| `poses.py` | host | THE pose specs (`PoseSpec`): catalog position, roles, extra limb detail, the support (furniture), the camera text per view. Prompts are built limb by limb from the server pose catalog |
| `build_jobs.py` | host | Writes a stage's job JSON into the job dir: `base`, `turns`, `fallback`, `lineart` |
| `run.sh` | host | Copies `run_jobs.ts`, `harness.cjs` and the two library style samples into the job dir, fixes the REPL bridge, runs ONE job file in the `harness` container |
| `run_jobs.ts` | REPL (container) | load -> provision -> run the jobs (at most `INFLIGHT` in flight) -> download -> teardown in `finally` |
| `harness.cjs` | REPL | S3 staging of input images (copied from video-harness `toolchain/mannequin-sheet`) |
| `judge.py` | host | The vision gate: the relabel audit's method (`../jobs/relabel_v5/audit.py` + `review.py`), majority of 3 votes, with the furniture "above" exception |
| `extract.py` | host | Library-style depth (Depth Anything V2, support kept, library value range and background) + the cleaned line art of the style edit, same 3:4 crop |
| `fidelity.py` | host | Flags line art that drifted from the render (silhouette IoU < 0.6) |
| `sheet.py` | host | Contact sheet per pose: one row per view (mannequin, line art, depth) + a library row |
| `templates/` | - | One-job examples of every stage (worked example: edge of surface, seed 11) and the `chosen.json` / `views.json` shapes |

The authority for every position is `../jobs/relabel_v5/pose_catalog.json`, exported from video-harness
`src/design/pose-catalog.ts` by `../jobs/relabel_v5/export_pose_catalog.mts`. Re-export it whenever the server
catalog changes; never hand-edit it.

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
4. **Camera turns**: write `chosen.json` (see `templates/`), then `build_jobs.py turns chosen.json` and
   `run.sh jobs_turns.json`.
   - The turns use `qwen_image_camera_turn` with the LoRA grammar `<sks> <azimuth> <elevation> <distance>`:
     side = `right side view`, diag = `front-right quarter view`, back = `back view`, high = `front view
     high-angle shot`, low = `front view low-angle shot`, all `eye-level` / `wide shot` unless named.
   - `medium shot` breaks a duo into single figures; keep `wide shot`.
5. **Fallbacks**: for a view the turn could not make (usually `low`; also a base that came out in profile), run
   `build_jobs.py fallback <slug>:<view> ...` and then `run.sh jobs_fallback.json`. This is a seeded t2i with the
   pose text plus `camera[view]`, using the base seed. Gate every fallback with `judge.py` like a base.
6. **Name the views by what the camera actually sees** (the library convention):
   - `front` faces the camera, `side` is the profile, `diag` the three-quarter view;
   - `high` / `low` look from above / below, `back` from behind.
   - A turn can land elsewhere than its name: label the result, not the request. Write `views.json`.
7. **Line art (style edit)**: `build_jobs.py lineart views.json`, then `run.sh jobs_lineart.json 4`.
   - `qwen_image_multi_edit`: Picture 1 = the render, Picture 2 = a library line-art sample (duo:
     `duo/seated_back_facing/pair60_P009_front`, solo: `solo/full_body_sexy/kneeling_all_fours/full_sexy_P031_front`).
   - It redraws the figures as the library's articulated mannequin drawing: construction lines, joint circles,
     segment contours, no furniture. Seed 22 dropped the furniture best in the experiment.
8. **Extract**: `extract.py <parts dir> <view>=<render>,<line art> ...`.
   - Depth: the figures AND the support (bria-rmbg mask) are normalised to 0.5..1.0 (white = near), over the
     library background: about 0.2 flat in the upper half, rising to about 0.5 at the bottom. This range was
     measured on 12 library samples.
   - Both images use one crop (figures + support, 3:4) and are scaled to 900x1200.
9. **Check the line art**: `fidelity.py <parts dir>` flags a view whose line art left the render's silhouette.
   Redo a flagged view's style edit with another seed, or drop the view.
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
- **"above" at hip-height furniture.** The catalog's `above` is non-blocking only when one person is seated on
  the furniture and the other STANDS (user decision); `judge.py` applies that, and it is what let edge of surface
  pass.
  - "Kneeling between legs" (seated man on a bed edge, kneeling woman) is NOT covered by the exception. It fails
    only on `above` (the judge answers "neither"), while every support holds 3/3. It needs a user decision before
    it can pass.
- **Solo poses defined by an absent partner** (`cowgirl`: "astride person A's hips") fail the gate: the support
  cannot hold without the partner. Such a solo item needs a catalog-level decision first.
- **The low view is weak.** `low-angle shot` usually stays near eye level, so expect a t2i fallback. The
  fallback's "as a lying person sees her" draws that person into a solo picture, so describe only the camera.
  Even with the worm's-eye wording, the edge-of-surface fallback failed the gate (a view from behind him).
- **A frontal base for a face-to-face duo** puts one partner's back to the camera. A profile base is what the
  model tends to give for oral poses; a front three-quarter fallback gets her front.
- **The style edit drifts** on views far from the library sample: on a top-down view it redrew the library
  reference instead of our figures (silhouette IoU 0.35). It also sometimes draws the counter despite the
  instruction. Always run `fidelity.py` and look at the sheet.
- **The depth mask must keep the support.** People-only masks (u2net_human_seg, birefnet) drop the counter or
  bed; bria-rmbg keeps it.
- **Tinted skin.** Some seeds render a beige or skin-tone figure; reject them by eye.
