# Plan P7: using reference picks in production

Status: **draft v3 for review** (2026-11-09). P7.1 is done, the P7.0 spikes are done (section 6), and P7.2–P7.5 are refined from their results. Parent plan: `PLAN_REFERENCE_RECOMMENDER.md` (P0–P6 done).

## 1. Goal

`recommend_references` returns pose and outfit picks as public URLs today. Nothing in production can use them yet. P7 makes a pick usable in three places:

1. **Outfit designs.** A library flat-lay is the garment reference when an outfit design is generated.
2. **Shot poses.** A library pose (line art + depth, best view) is the pose reference of a storyboard shot.
3. **Agents.** The planning and storyboard skills know when to ask the recommender and how to attach a pick.

## 2. What exists today

| Need | State |
|---|---|
| Design reference images | `create_design start:"references"` and `seed_takes` accept only **approved workspace `artifact://` images whose files are `filestore:` objects** (`resolveDesignReferences`, `workspace-agent.ts:8903`). No URL is accepted. |
| URL → artifact | No server path. `create_artifact` has no source URL; `/api/import-user-artifact` accepts only this workspace's upload slots; `sandbox_fetch` works but costs uploads and a manual approve. |
| Cross-bucket copy | The library lives in the **model-cache bucket** (public-read). `S3Client.copyObject` copies within ONE bucket only (`s3-client.ts:128`). Same credentials, so a cross-bucket `CopyObject` is possible but unbuilt. |
| Garment reference in renders | The role `garment` exists (`capabilities.ts:299`). `flux2_image_edit[_nsfw]` has an optional `garment_reference_image` port. **Nothing produces a garment reference**, and the outfit `generate` role allows 1 image (the character). |
| Pose control in renders | **No ControlNet, depth, openpose or line-art port in any workflow.** The `pose-transfer` capability exists: `qwen_image_pose_transfer` takes `subject_image` + a scene-free `pose_image`. The take renderer's pose-transfer repair route renders its own pose reference (`stepPoseRef`, `engine-repair.ts:809`). |
| Binding an extra picture into a shot | Precedent: the position anchor, a synthetic design key `anchor:<shotId>` resolved in `refOf()`, with a fixed slot and prompt line (`shot-binding.ts:166,285,2047`). Take-renderer refs must be `filestore:` refs (`take-render-io.ts:180`). |
| Where poses and outfits are decided | The `storyboard-scene` skill writes `Body pose:` / `Sex position:` / `Outfits:` / `Wardrobe:` lines (`shotlist.ts`). The `plan-designs` skill writes one outfit design per wardrobe row (`design_plan.json`, `seed_takes`). |
| Pose identity | Library poses carry `sex_positions` with the exact `explicit-acts` names, the join key to the text pose catalog (`pose-catalog.ts`). |

## 3. Design

### 3.1 Library import: one server function, idempotent per workspace

`importLibraryReference(workspace, catalog, itemId, angle?)` makes the pick a workspace artifact.

- **Copy.** A server-side cross-bucket `CopyObject` from the model-cache bucket into the workspace file store: outfit image, or pose line art + depth for the chosen view. It is a new `copyObjectFrom(srcBucket, srcKey)` beside `copyObject`, with the same credentials. There is no upload through the agent and no oplog payload.
- **Artifact.**
  - id `ref-<catalog>-<item>[-<angle>]`;
  - files `image.png` (and `depth.png` for a pose);
  - metadata: catalog, item id, title, view, `why`, source URL;
  - status **approved**: the user's prior approval is the workspace's content policy, and the library is curated.
- **Idempotent.** A KV map `(workspace, catalog, item, angle) → artifact id` returns the existing artifact on repeat imports.
- **Entry points:**
  - the worker tool **`use_reference({catalog, id, angle?})`**, which returns `{artifact, files}`;
  - the coordinator / HTTP equivalent (`/api/use-reference`) for the web studio's "use this" button.
- **Gating** is the same as the recommender: the library configured and nudity `allowed` for this catalog.

### 3.2 Outfits: the garment reference in outfit generation

- **Optional `garment_reference` on the outfit design kind.** It's an `artifact://` image; a design attribute, written by `create_design` or `write_design`.
- **The outfit `generate` role accepts 2 images:** character (subject) + garment (role `garment`). `bindReferenceSlots()` routes it to the `garment_reference_image` port.
  - Workflows without a garment port fall back to the text attributes. The garment slot is dropped first, as other optional references are.
- **The planner skill** (`plan-designs`): for each wardrobe row, call the recommender with the row's description and the scene's kink and roleplay context. Attach the top outfit via `use_reference` when it fits, recorded on the design plan entry. The user can swap it in the studio.
- **The finish describe step** keeps writing `description.garments` from the result image. Wardrobe logic stays text-based and unchanged.

### 3.3 Poses: a pose reference per shot

- **Shot line `Pose reference: <artifact ref>`** (optional), parsed in `shotlist.ts` next to `Body pose:`.
  - The `storyboard-scene` skill: for a shot with a `Body pose:` or `Sex position:`, call the recommender with the shot's action and act, then `use_reference` on the pick whose `sex_positions` / support matches the shot. Name the view that matches the shot's `Camera:` direction (the pick's views carry the angle).
- **Binding:**
  - A synthetic key `pose:<shotId>` resolves in `refOf()` to the imported line art. This follows the position-anchor pattern.
  - It's used only by workflows that declare a pose input, so it is never a plain extra picture in a compose (spike S1 decides whether line art helps or hurts compose).
- **Routes, chosen by the spikes:**
  - **(a) Pose-transfer route.** After the compose render, `qwen_image_pose_transfer` with `pose_image` = the imported line art for shots whose pose check fails, or always for act shots. Cheapest to build: the repair route already does this with a rendered pose reference.
  - **(b) Depth-control route.** A new library workflow (krea2 or flux depth ControlNet) with a `pose-control` capability and a `depth` port fed by the imported depth map. Strongest control, but it needs a new ComfyUI bundle, models and a capability.
- **Character views:** the `pose` view role may take the pose reference too (via the repose workflow's `scene_image`). That's a later extension.

### 3.4 Catalog generalisation first (from the review)

The final review recommends generalising before more consumers bind to the current shape. P7 consumes the recommender through its API, so the generalisation comes first (P7.1). Its scope:
- a `catalog` descriptor in the index;
- a `catalog_index` tool;
- `search_catalog {catalog, …}`, with `recommend_references` kept as an alias for one release.

**Stage A (Python) done 2026-11-09:** index schema 2 with the `catalog` descriptor (`catalog.yaml`), generic
items (`attrs`, `media`), generic filters and result shape, per-catalog keys; index v4 published to
`library/refs/rag/latest.s2.json` (`latest.json` stays on v3 for the deployed schema-1 reader). The contract
is in `references-rag/README.md` ("Index schema 2"); v4 rankings equal v3's (`eval/compare_v3_v4.py`).
Review fixes (same day): publish never moves `latest.json` for schema ≥ 2; a new catalog builds from a
descriptor yaml + items jsonl (`refs index build --catalog --items`, README "Adding a catalog"); the
`decider` status, default `k` (min(3, max_k)), integer-like kind keys, null `depth`/`view` and
`Catalog.describe()` are pinned for both ports; v4 fixtures regenerated (index unchanged).
**Stage B (TypeScript) done 2026-11-09** (video-harness `229-design-studio` `18ef2efba`):
- `spec.catalogs: [{key, description, nudity}]`, a per-workspace allow list like `spec.loras`;
- the generic core and `CatalogIndexAgent`;
- `catalog_index` + `search_catalog` (with a `describe` mode), and `recommend_references` as a deprecated alias;
- the nudity gate trusts the catalog's own descriptor; a `nudity: true` catalog is listed and searchable only when the workspace allows nudity;
- the sha256 check, hard result bounds, and catalog tools also for text-output tasks;
- parity tests on the v4 fixtures.

## 4. Phases (refined after the spikes)

| Phase | Scope | Exit criteria |
|---|---|---|
| ~~P7.0 Spikes~~ | **Done**: see section 6 | Met |
| ~~P7.1 Catalog generalisation~~ | **Done** (3.4) | Met |
| ~~P7.2 Library import~~ | **Done** (video-harness `229-p7-library-import`): `S3Client.copyObjectFrom`; `WorkspaceAgent.importLibraryReference` (the caller looks the item up: the worker for `use_reference({catalog, id, angle?, why?})`, the ephemeral `WorkspaceReadAgent` for `POST /api/use-reference`); KV idempotency on the resolved angle; key `ref-<catalog>-<item>[-<angle>]-<hash8>`; `libraryReference` metadata incl. `why`; the same exposure / nudity gate as `search_catalog`; auto-approved artifacts; failures discard everything; tests | Met |
| ~~P7.3 Outfits~~ | **Built** 2026-11-09 (video-harness `229-p7-outfits`, skills `p7-outfits-skills`): `garment_reference` attribute on the outfit kind (validated like a design reference); generate role with 2 images (character + garment → the port declared `reference_role: garment`, `garment-reference.ts`); text fallback for workflows without the port (logged once); S2 prompt rules in `designPromptIdeaOf()`; `plan-designs` attaches catalog picks per wardrobe row; the pick shows in the design's attributes. The web studio's own Generate does not bind the garment yet | Exit criterion (garment fidelity on 10 outfits ≥ S2) still to be measured live (P7.5) |
| **P7.4 Poses, route (a)** (3–4 days) | `Pose reference:` shot line; a `pose:<shotId>` binding; route (a): `qwen_image_pose_transfer` with the imported **line art** as `pose_image`, on pose-check failure (repair) and optionally first-pass for single-person pose shots. **Solo poses only**: the `storyboard-scene` skill searches with `filters: {solo: true}` for shots with one person in frame; two-person shots keep today's text route. View choice: deterministic, from the shot's `Camera:` direction (front / side / diag / high / low), not from a model judgement. Pose check judged on support + limbs only (S1: the camera question is unreliable) | On solo act and pose shots, pose-check pass rate ≥ today's rendered-reference route with half the renders |
| **P7.4b Depth route for two-person shots** (2–3 days; S5 gate **met**) | Register the RefControl depth LoRA in the model cache (folder `loras`, `flux2_klein_9b_refcontrol_depth.safetensors`, sha256 `d627631d…bb8d`, strength 1.0). A `depth-pose` capability / binding on `flux2_image_edit_nsfw`: the imported depth view goes to `subject_image` (Figure 1) and the character to the second image port. That port is declared `reference_role: garment`, so the binding overrides the role; it does not reuse garment semantics. Prompt templates per S5 (solo / duo; always append `Pose: <library title>`; describe the man in text). It is a **keyframe route**, not a repair: framing and background follow the depth map. Use it for two-person pose and act shots (route (a) fails there); solo shots keep route (a). Choose the view from the image's angle tag, never from the view text. Stricter duo pose check (the judge is lenient on floor-level duo poses) | Duo act shots pass support + limbs + identity at ≥ the S5 rate (10/10 with title prompts) |
| **P7.5 Evaluation** (1–2 days) | A/B on a real NSFW episode with vs without references (pose-check pass rate, repairs, garment fidelity, render cost) | A report; per-workspace defaults |

Remaining: about 10–14 dev-days for P7.2–P7.5 including P7.4b.

## 5. Risks and open questions

- **Line art as a pose input is untested.** `qwen_image_pose_transfer` asks for a "scene-free neutral figure". The library's faceless line-art mannequins fit that description, but the duo poses' occlusion may confuse it. S1 decides.
- **Garment flat-lay → worn outfit fidelity:** `flux2_image_edit`'s garment port is optional and unused today. S2 decides whether it beats text.
- **Auto-approval:** decided. Imported library references and user uploads are approved automatically.
- **Cost.** Every import is one S3 copy per file, which is cheap. Route (a) adds one pose-transfer render per shot when used always; using it on repair only keeps today's cost.
- **Duo poses** depict two people. Binding one to a shot requires the shot's people to match the pose's roles (`sex_positions` role order). The catalog's role rules (`explicit-acts`) apply.
- **Decided:** P7.1 went first, and it is done.
- **Open:** the Featherless query instruction in `index_build.py` still names poses and outfits. A new catalog needs its own query instruction, so move it into the catalog descriptor (which re-embeds refs on the next build) when the second catalog arrives.

## 6. Spike results (P7.0, 2026-11-09)

- **S3, cross-bucket copy: GO.**
  - Both the app (`Auteur-app-svc`) and the local / dev credentials can `CopyObject` from the model-cache bucket into the fileshare bucket. It takes 130–530 ms per file, and size, content type and cache headers are preserved.
  - `s3-lite-client` supports a source bucket, but keep our raw request so the check for a 200 response with an error body stays.
- **S4, ControlNet availability.** No ControlNet exists in any bundle or in the model cache.
  - The cheapest depth route is the Flux.2 klein **RefControl depth LoRA** on the existing flux2 nodes, with no new custom nodes.
  - `qwen_image_pose_transfer` is Qwen-Image-Edit 2511 + the AnyPose LoRA, with no ControlNet.
- **S1, pose renders** (8 library poses, 2 characters, Modal l40s; judged by the decision model with images; pass = support, limbs, identity and single person all ≥ 0.5):
  - **(a) line art as `pose_image`: 6/6 solo pass.** It matches or beats today's rendered-reference route (c), 2/3, at half the renders.
  - **Duo poses fail, 0/2:** pose transfer copies both figures, so the subject appears twice.
  - **(b) depth as `pose_image`: 2/3.** It once rewrote body and clothing. NO-GO.
  - **(d) klein + RefControl depth LoRA: 3/3.** It re-composes the scene (framing and background follow the depth map). Promising; validate on duo and explicit poses (S5).
  - **The camera-view question in the judge is unreliable,** so P7.4 uses support + limbs.
- **S2, garment renders** (6 outfits; `flux2_image_edit` with `garment_reference_image` vs text only):
  - garment image: mean fidelity 1.85 / 3, "same garment" 4/6;
  - text only: 1.34, 0/6;
  - identity kept everywhere.
  - Failure modes: the original top sometimes stays under the garment, and shoes and stockings get dropped. Fix with the prompt rules in P7.3.
- **Artifacts:**
  - `scratchpad/p7-spikes/s12/` (driver, judge, scores, contact sheets);
  - `scratchpad/p7-spikes/s34/NOTES.md`.
- **S5, depth-LoRA validation** (P7.4b gate; 18 renders, about $2):
  - Setup: RefControl depth LoRA on `flux2_image_edit_nsfw`, library depth view as Figure 1, character as Figure 2, strength 1.0. 10 poses: 4 duo, 2 explicit solo, 4 other solo.
  - **Gate met:** base prompt 9/10 by the judge and 8/10 by eye. With `Pose: <library title>` added to duo prompts, all 5 duo renders pass, so 10/10.
  - Every duo render shows exactly one woman and one man; the woman is never duplicated, which was route (a)'s failure.
  - Failure modes:
    - without the title, a lying or partly hidden man falls back to an upright "posing couple";
    - a lying duo pose can turn the woman's face away (identity 0.65).
  - The negative controls fail as they should. The duo judge is lenient on floor-level duo poses: missionary against a cowgirl reference passed.
  - Strength 0.8 vs 1.0: no difference, so use 1.0.
  - Artifacts: `scratchpad/p7-spikes/s5/` (NOTES.md, contact sheets `S5_*_overview.png`).
