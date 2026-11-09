# Plan P7: using reference picks in production

Status: **draft for review** (2026-11-09). Parent plan: `PLAN_REFERENCE_RECOMMENDER.md` (P0–P6 done).

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
Stage B: the TypeScript port reads `latest.s2.json`.

## 4. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **P7.0 Spikes** (2–3 days) | **S1:** pose transfer with library line art and with depth vs today's rendered pose reference, 10 act and pose shots, judged. **S2:** outfit generation with `garment_reference_image` = library flat-lay vs text only, 10 outfits, judged for fidelity. **S3:** cross-bucket `CopyObject` model-cache → fileshare with the app credentials (permissions, latency). **S4:** krea2 or flux depth ControlNet availability on the compute images (decides route b). | Go / no-go per route; chosen pose route |
| **P7.1 Catalog generalisation** (5–6 days) | The review's design: descriptor in index v3 (Python first), generic TS core, `CatalogIndexAgent`, `catalog_index` + `search_catalog`, alias, per-catalog content gate, result-size budget | Parity tests green; alias returns the v2 shape |
| **P7.2 Library import** (2 days) | `copyObjectFrom`, `importLibraryReference`, `use_reference` tool + HTTP endpoint, KV idempotency, artifact metadata, gating, tests | A pick becomes an approved artifact in less than 2 s, re-import is free |
| **P7.3 Outfits** (2–3 days) | `garment_reference` attribute, generate role with 2 images, slot binding + fallback, `plan-designs` skill, studio display | S2-quality outfits from the plan without manual steps |
| **P7.4 Poses** (3–5 days) | `Pose reference:` line, `pose:<shotId>` binding, route (a) in the take renderer, `storyboard-scene` skill; route (b) only if S1/S4 favour it | Pose-check pass rate on act shots ≥ the S1 result |
| **P7.5 Evaluation** (1–2 days) | A/B on a real NSFW episode: with vs without references (pose-check pass rate, repairs, render cost) | A report; defaults on/off per workspace setting |

Total: about 15–20 dev-days, or 10–12 without route (b).

## 5. Risks and open questions

- **Line art as a pose input is untested.** `qwen_image_pose_transfer` asks for a "scene-free neutral figure". The library's faceless line-art mannequins fit that description, but the duo poses' occlusion may confuse it. S1 decides.
- **Garment flat-lay → worn outfit fidelity:** `flux2_image_edit`'s garment port is optional and unused today. S2 decides whether it beats text.
- **Auto-approval of imported references.** Library items are curated and gated by the content policy. Approving them automatically skips a human step; the alternative is "pending" plus an approve click in the studio.
- **Cost.** Every import is one S3 copy per file, which is cheap. Route (a) adds one pose-transfer render per shot when used always; using it on repair only keeps today's cost.
- **Duo poses** depict two people. Binding one to a shot requires the shot's people to match the pose's roles (`sex_positions` role order). The catalog's role rules (`explicit-acts`) apply.
- **Question for you:** should P7.1 (catalog generalisation) gate P7.2–P7.4, as proposed, or run in parallel on the current tool?
