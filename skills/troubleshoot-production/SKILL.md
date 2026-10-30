---
name: troubleshoot-production
description: >
  Use when the person reports that a scene, storyboard, shot, frame or clip looks wrong or a task
  seems stuck - "the top disappears between shots", "she never jumps", "the doll is life-size", "the
  gown is the wrong colour", "the act is not shown", "the clip is square", "the storyboard agent said
  it fixed it but nothing changed", "the frame replacement is stuck", "why did this shot fail" - and
  asks to find the cause and fix it in this workspace. Produces a root cause (which layer is wrong)
  and the smallest fix applied at that layer, verified. Do NOT invoke for writing a new storyboard or
  shot list from scratch, shooting a scene, designing a character, or prompt writing.
agentType: workspace,worker
---

# Troubleshoot a production (scenes, storyboards, shot lists, frames, clips)

## The one rule: fix the layer that is wrong, never the one that shows it

A production is a chain; each layer is built from the one above it:

`scene_list.md` (beats, looks, camera) -> designs (characters, outfits, places) -> storyboard
`shotlist.md` (shot lines) -> frames / takes -> clip task briefs -> clips -> assembly.

A defect seen in a clip is usually written in a layer above it. A fix applied below the faulty layer
comes back on the next run. Find the FIRST layer that is wrong, fix it there, then redo only what is
built from it.

## 1. Preflight: pin the defect down

- Name the scene, the shot (`s<scene>-<nn>`) or clip, and the symptom in one sentence. If the person
  did not say which, ask in one line; never guess a shot.
- Read the facts before judging (coordinator: `task_info`, `inspect`, `workspace_log`, `read`,
  `render_info`; worker: `read_artifact`):
  - the scene's row(s) in `scene_list.md` (beat text, the looks column, camera, continuity);
  - the shot block in the storyboard's `shotlist.md` (Action, Camera, Movement, Motion, Dialogue,
    Wardrobe, Outfits, Visible, Contact, Sex act / position, LoRAs, Transition, Duration);
  - for a clip: its task brief (`task_info`) and the render record (`render_info`: prompt, LoRAs,
    width / height, inputs).
- Never trust an agent's reply that it "updated" or "fixed" something: re-read the artifact. A reply
  without a tool result behind it changed nothing.

## 2. Find the faulty layer (symptom -> where to look -> what it means)

| Symptom | Check | Faulty layer if... |
|---|---|---|
| A garment vanishes between shots; an undressing is never shown | the beat's looks column vs its action ("unties her top") | the row lists only the later look -> **scene list** (a beat lists the look AT its start; a look-changing beat lists both) |
| | the shots of that beat | no shot wears the earlier look, or no `Motion:` beat performs the change -> **storyboard** |
| An action never happens (she never jumps); the clip is a still | the shot's `Motion:` | a beat holds one pose for the whole shot ("0-4 s hangs airborne") -> **storyboard** (motion is the action in progress) |
| | a `continue` clip whose next keyframe is a different moment | a continuation only knows where it starts -> **clip planning**: make it its own cut, or split the action into beats |
| A clip morphs / cuts inside itself | `Transition: continue` + a changed `Camera:` + `Movement:` | the move cannot reach the new framing (hold, drift, handheld) -> it is a **cut** (planner rule; `shoot-clip` shoots it as a cut) |
| A small character (doll, pet, creature) is person-sized | the character design's words; the shot's `Pose:` / `Visible:` | the size is not stated, or the shot pictures it as a full figure beside its holder -> **design / storyboard** ("a small doll in her arms", upper body) |
| Wrong colour of a garment / gown | `render_info` prompt vs the outfit design's colours | the prompt names another colour ("golden ballgown" vs a pink design) -> **prompt / plan**, not the render |
| | strong coloured light in the shot | warm light tints pale fabric -> **shot lines**: state "stays <colour> under the <light>" |
| The explicit act or the contact is not shown | `Sex act:`, `Sex position:`, `Contact:`, `LoRAs:` of the shot; `render_info` LoRAs | lines missing -> **storyboard**; lines present, act LoRAs not loaded -> **render** (report); both fine -> a render miss: replace the frame |
| A first-person (POV) body is drawn in the wrong order | `POV:` posture, `Visible:` extent, `Wardrobe:` | lines fine -> render miss: replace the frame with "Describe what's wrong" |
| A clip is square / the wrong orientation | `render_info` width / height vs the start frame | a size not taken from the frame -> **platform**: report it, do not patch per clip |
| `write_shot` refused a shot | the refusal text | it names the rule; e.g. a touched thing is plain words ("on bin lid", never "bin (lid)") |
| A storyboard / frame job looks stuck | the job's step and the renderer's phase / progress | 20+ minutes of rendering and checking is normal; stuck = no progress and no render in flight |
| An agent says it fixed something, nothing changed | re-read `shotlist.md` / the artifact | no tool was called -> re-send the request naming the exact tools and asking to quote each result |
| A re-run changed more than asked | diff the artifact before vs after | the instruction was not followed -> restore it from the old text (step 3.2), say what changed |

## 3. Fix at that layer (smallest fix, in this order)

1. **Run mode first.** Before anything that resets dependents, the person switches the workspace to
   **Manual** (the header switch); then reset tasks wait ("Paused") until run, and nothing re-shoots
   on its own. You cannot switch it: ask, and wait.
2. **Scene list** (`create_scenes` or the task that produced `scene_list`). A re-run REWRITES the
   whole file, even when told "change nothing else" (live: a one-row look fix restructured every
   scene and dropped three beats). So:
   - BEFORE the re-run, `read` the current file and keep its full text (it is the restore source).
   - Re-run with `reset_task` (`cascade: false`) and `instructions` that carry the COMPLETE corrected
     file between BEGIN / END markers and say "write exactly this, byte for byte, in one file write;
     do not edit, re-plan or apply any rule to it" - never a description of the change.
   - AFTER it, `read` the new file and compare it line by line with the text you sent; any other
     difference: run it again the same way, or stop and tell the person. Only then touch what is
     built from it.
3. **Storyboard** (one scene): a storyboard reads the scene list when it drafts, so after a scene-list
   fix it must draft again. Unfinished: `reset_task` it with `cascade: false` (start over) and
   `instructions` naming the shots to fix and why. Finished: the person uses "Re-run from here" (all
   its clips are reset and wait) or, for ONE frame, "Replace frame" in the studio. The storyboard's
   linked designs are fixed at creation: a look added later is drawn from words (`:none` + garments),
   not from its outfit design - say so; recreating the storyboard is the person's decision.
4. **One shot only** (worker in the storyboard task, or the person's "Fix with agent"): read the
   current entry, change only its faulty lines with `write_shot`, then `plan_shot` for that shot, then
   `draft_storyboard` with no arguments. Never rename or renumber a shot. Quote each tool result.
5. **One frame of a finished storyboard**: the person's "Replace frame" -> "Describe what's wrong"
   with ONE concrete sentence of what must be visible ("his penis penetrates her from behind; his
   groin against her buttocks"). It keeps the frame and repairs only what the note names. Not
   available to an agent: ask the person.
6. **Any other text artifact** (a shot list, a design plan, a brief): the same rule as the scene
   list - keep the old text before a re-run, send the complete corrected text, compare after.
7. **Clips**: fix the brief, not the clip - a pending clip task with `modify_task` (prompt), a
   finished one with `reset_task` (`cascade: false`, `instructions`). A clip that cannot be planned
   right because its shot is wrong goes back to step 4.

Never delete a task or artifact to "start clean" unless the person asks; never reset with
`cascade: true` without telling the person how many tasks it resets.

## 4. Verify, then report

- Re-read every artifact you changed (the row, the shot block, the brief) and check the new frames /
  clips against the symptom: look at them (`agent_oneshot` with a vision agent: "Does shot s3-02 show
  her top coming off? yes/no + why").
- Reply in this shape: **Symptom** (one line) - **Root cause** (the layer and the line that was
  wrong) - **Fix** (what you changed, with the tool results) - **Still open** (anything only the
  person can do: run mode, Replace frame, recreating a storyboard).
