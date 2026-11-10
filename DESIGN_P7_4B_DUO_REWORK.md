# Design note: rework of the duo pose route (P7.4b)

Status: proposal for review (2026-11-09). Builds on `PLAN_REFERENCE_RECOMMENDER_P7.md` P7.4b, on the live e2e check of
the same day, and on video-harness `knowledgebase/PLAN_TWO_STAGE_ACT_ROUTE.md` (the staging route).

## 1. What the live check showed

Workspace `p7e2e-mw9uqdo9@1`, shot s1-02 (Ava and Max, doggy style, a modern apartment), pose P041 side view.

- **The pose is right in all 5 renders.** The stricter duo pose item passed on every one: P(different) 0.05–0.13.
  The independent judge gave support ≥ 0.99. This is the part the depth LoRA is for, and it works.
- **Everything around the pose fails.** All 5 takes were rejected:

| Failing item | Why | Can the current route ever pass it? |
|---|---|---|
| `no-composite` (decisive: "plain studio backdrop", P = 1.0) | The depth map's flat background becomes a studio wall. The place exists only as words in the prompt, and the words lose. | No |
| `setting-kept`, `placement` | Same cause: no apartment, no bed or floor of a room | No |
| `act` | Only the RefControl LoRA is loaded and the prompt has no act phrase, so there is no penetration | No |
| `identity-2` (Max) | Max is described in words only. Only Ava's picture is bound (2 image ports). | Rarely |
| `outfit-character_max` (c5) | The nude look binds Ava's clothed character picture, and her t-shirt and shorts moved onto Max | Sometimes |
| `gaze-*` | The fixed prompt states no gaze | Sometimes |

- **Repairs could not help.** A route-(b) repair is a plain re-render: same binding, same prompt, new seed. It can't fix
  any of these, so 2 of the 5 renders were wasted. The act miss never reached the act repair.

Root cause: route (b) renders the **final frame** from a depth map, one woman's picture and words. A final frame
needs the place, both identities, the wardrobe and the act. The route has no input for most of them, and no
repair route can add them afterwards. Adapting the checklist would only let wrong frames pass.

## 2. Proposal: the depth render becomes stage A of the existing two-stage act route

The staging route already splits a third-person act shot into two stages:

- **Stage A:** cheap drafts with generic people that get the act, the poses and the camera right, rendered on a crop
  of the location plate.
- **Stage B:** composes the real people onto the best draft. The draft is Picture 1, and the stage-B prompt says
  "keep the composition, camera, framing, poses, body positions and contact … replace the people … keep the room and
  the lighting".

The depth render is a better stage-A draft for exactly the hard part, the arrangement. So:

1. **Stage A from the depth map.** For a shot with a duo `Pose reference:`, the stage-A drafts come from
   `flux2_image_edit_nsfw`:
   - Figure 1: the depth view.
   - Figure 2: the **location plate crop** the staging route already makes, not the woman's picture.
   - LoRAs: RefControl depth 1.0 plus the staging route's act LoRAs.
   - Prompt: generic people ("a woman and a man"), the act phrase, `Pose: <title>`, and "in the place of Figure 2".
2. **Stage A is checked on staging only,** as today, plus the stricter `pose-reference` item as a decisive gate. A
   draft that loses the pose is not chosen.
3. **Stage B unchanged.** The real identities of both people, with their outfit or nude look, are composed onto
   the chosen draft by the normal compose route:
   - the normal prompt writer;
   - the shot's `LoRAs:` line;
   - the full frame checklist, including `pose-reference`;
   - the normal repair routes (identity masked-inpaint, act or contact inpaint, garment action-edit).

**What this fixes:**

| Bug from the e2e | After the rework |
|---|---|
| 2. Checklist not adapted | No adaptation needed. Stage B is a normal frame with a real room, both people pictured and the act LoRAs loaded. |
| 3. Placement routed to a seed re-render | `rerenderDepthKeyframe` is removed. Repairs of stage-B takes use the normal routes, and re-staging uses the staging-repair path. |
| 4. Clothed picture leaks in nude shots | Stage A binds no person picture. Stage B binds the outfit or nude look as every compose does. |
| 5. Raw cue in the prompt ("wearing bare skin (nude)") | The depth prompt has generic people only. `manWordsOf` and `outfitWordsOf` are removed. |
| 6. The `LoRAs:` line was ignored | Stage B loads it. |

**Cost per shot:** stage A is 1 round of depth drafts (the staging budget, `draftsPerRound`), then about 2 stage-B
composes. Today's route spent 5 renders and passed nothing. The plain staging route with text-only drafts costs the same,
so the depth map costs nothing extra.

## 3. The open question, decided by a spike first (S6)

Does RefControl take the **place** from Figure 2 while the depth map fixes the bodies? The library depth maps carry
a gradient background, which may still force a studio wall. The spike tests that question and, as a fallback,
whether stage B alone can fix the room.

S6 setup: 4 duo poses (P041, P022, P030, P049) × 1 apartment plate, Modal l40s. About 24 renders, about $3.

| Variant | Stage A | Measure |
|---|---|---|
| V1 | Depth map as is, plate as Figure 2, act LoRA | Room visible (no backdrop), pose kept, act visible |
| V2 | Depth background flattened to "far" (the people's mask from the line art, the rest set to the far value), plate as Figure 2, act LoRA | Same |
| V3 | Best of V1 / V2 → stage B with Ava and Max (the existing stage-B binding and prompt) | Full checklist pass, `pose-reference` pass, identity-1 and identity-2 |

**Gate:** at least 3 of 4 poses give a stage-B take that passes the full checklist, with the pose kept.

**If the place never comes through in stage A,** the fallback is:
- stage B binds the location picture beside the draft;
- the keep line says "keep the composition … replace the backdrop with the room of Picture N".

If that fails too, duo pose attachment stays off and the duo route is shelved. Solo route (a) and garment picks are
unaffected either way.

## 4. Build, after S6 passes (about 2–3 dev days)

- **`design/pose-reference.ts`:** the duo decision returns a `StagingSpec` (reason `depth-pose`) with the depth
  view, the depth workflow and the RefControl LoRA instead of a compose route.
  - Drop `personPictureOf`, `manWordsOf` and `outfitWordsOf`.
  - The prompt template becomes generic people + act + `Pose: <title>` + place.
- **`take-render-spec.ts`:** a duo pose reference forces the staging route for that shot, even when
  `spec.keyframes.stagingDrafts` is off; the pose reference is itself the opt-in. A first-person shot keeps
  skipping (as today).
- **`engine-staging.ts`:**
  - The draft request is the depth binding: depth, plate crop, LoRAs. It is not text-to-image or plate-edit.
  - A refused or missing plate crop falls back to the depth map with a neutral room in words, not to text-only
    drafts, since the pose is the point.
  - `pose-reference` is added to the stage-A checklist.
- **`engine-repair.ts`:** remove `rerenderDepthKeyframe` and its branch in `stepRevise`. A stage-B take that fails
  the pose is re-staged (the existing staging repair), and other findings use their normal routes.
- **`take-render-engine.ts`:** remove the fixed-prompt shortcut in `advancePrompt`. Stage B uses the deterministic
  stage-B template as today.
- **`shot-checklist.ts`:** keep `poseReferenceItems` (stage A and stage B). There is nothing else to adapt.
- **Tests:**
  - the decision vectors;
  - the stage-A binding;
  - the fallback without a plate;
  - no `rerenderDepthKeyframe`;
  - the stage-B checklist equals a normal staged shot plus `pose-reference`.
- **Library:** no change to `flux2_image_edit_nsfw` (it keeps `depth-pose`). `storyboard-scene` attaches duo poses
  again only after the live re-check passes.

**Exit (live re-check, about 10 renders):**
- s1-02 again, plus one more duo act shot.
- Each needs a passing take within the normal staging budget, with the pose item passed.
- Renders per passing take must be ≤ the plain staging route.

## 5. Until then (independent of the rework)

- **Push auteur-library main now, with duo attachment off.** `storyboard-scene` attaches `Pose reference:` only to
  shots with one person in frame (`filters: {solo: true}`). The `depth-pose` capability stays; it is inert without a
  duo reference.
- On video-harness, a one-line guard makes `depthRouteOf` return a skip ("the duo route is being reworked").
  Without it, a shot whose agent still names a duo reference by hand would take the failing route. The guard
  goes away with the rework.
- Delete the e2e fixture `public/e2e-fixtures/p7-e2e/` in the model-cache bucket.

## 6. Not in scope (found by the e2e, pre-existing)

- **User-imported artifacts store the presigned upload URL, not a `filestore:` ref.** They can't be seed takes or
  references (`importUserArtifact`).
- **`withProductionFormat` drops attribute rows that have no `label`,** so admission then reports "attribute scene is
  required".
- **Design agents loop on `draft_prompt` while the prompt writer is down.** They need a fallback that writes the
  prompt themselves.
- **Route (a) `first-pass` adds a render with no effect** when the drafts already pass the pose check (the A/B
  position bias). This is input for P7.5: `repair` stays the default.

## 7. S6 result (2026-11-09; 45 renders, about $5.6)

**Gate met: 3 of 4 poses.** P041, P022 (with the 9:16 draft) and P030 each gave a stage-B take that passes the real frame
checklist. P049 passed only borderline, with the plain-sentence wording.
Notes: `scratchpad/p7-spikes/s6/NOTES.md`.

- **Stage A works.** With the plate as Figure 2 the room comes through: same room 0.99–1.00, studio backdrop ≤ 0.02.
  The pose is kept and the couple is right. **Build V2:** flatten the depth background to the far value and pad the map to 9:16
  with it. With an unpadded 3:4 map, stage B crops the feet and V1 gets a black edge bar.
- **Stage B works for room, people and pose.** All 15 takes kept the room. `no-composite` and both identities passed,
  and `pose-reference` passed everywhere (P(different) 0.01–0.06).
- **Two problems remain, both outside the depth route:**
  - **Clothing leak in nude shots.** Stage B and the act repair bind the character's clothed full-body picture for
    a nude look. The t-shirt leaked into 3 takes, and the act repair rebuilt people clothed or added a third figure.
    This is now part of the build (nude-look picture rule for stage B and the repair).
  - **Weak act on P041 and P049** (stage-B act 0.44–0.56). SNOFS is already in the graph, plain-sentence wording barely helps,
    and the act repair failed because of the clothing bug above. Re-test after the nude-look fix.
- Take pass rate 4 of 15. The exit criterion in section 4 (renders per passing take ≤ the plain staging route) is open
  until the nude-look fix and the act re-test.
