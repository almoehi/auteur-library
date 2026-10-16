---
name: storyboard-quality-check
description: >
  Trigger when tasked with quality-checking the rendered storyboard keyframes for a
  scene — e.g. "run QC on scene 2 storyboard", "quality check the keyframes for scene 3".
  Runs automated image checks (grayscale, exposure) and VLM visual review (character
  identity, location accuracy, costume, content alignment) on all keyframes for one scene.
  Outputs a structured QC report JSON. Blocks proceeding to shooting if critical failures exist.
  Do NOT invoke for rendering, shooting, or assembly tasks.
agentType: worker
---

# Storyboard Quality Check

## What this skill produces

`scene{X}_storyboard_qc.json` — a per-frame quality report with:
- Pass/fail verdict per check per frame
- Overall scene verdict: PASS / FAIL_CRITICAL / FAIL_WARNING / NEEDS_REVIEW
- Specific failure descriptions and recommended actions

---

## Phase 1 — Read artifacts

1. Read `scene{X}_storyboard` artifact (the rendered PNG keyframes)
2. Read `scene{X}_shot_prompts` artifact (the pre-written T2I prompts — to compare against)
3. Read `visual_bible` artifact (character and location reference anchors)

For each image file in the storyboard artifact: use `sandbox_fetch(url="artifact://<artifactId>/<fileKey>", ...)`
(never a copied URL) to download a local copy to `/tmp/qc_scene{X}/`.

---

## Phase 2 — Automated checks (Python via sandbox_python)

Run the following checks for ALL frames in one Python call:

```python
import cv2, numpy as np, json, os, glob

results = {}
frames_dir = '/tmp/qc_sceneX/'

for img_path in sorted(glob.glob(f'{frames_dir}/*.png')):
    frame_id = os.path.basename(img_path).replace('.png', '')
    img = cv2.imread(img_path)
    h, w = img.shape[:2]

    checks = {}

    # F-01: Grayscale detection
    r, g, b = img[:,:,2], img[:,:,1], img[:,:,0]
    rg_std = float(np.std(r.astype(int) - g.astype(int)))
    gb_std = float(np.std(g.astype(int) - b.astype(int)))
    is_grayscale = rg_std < 8 and gb_std < 8
    checks['F01_grayscale'] = {
        'passed': not is_grayscale,
        'severity': 'critical',
        'rg_std': rg_std, 'gb_std': gb_std
    }

    # F-05: Exposure / luminance check
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    L = lab[:,:,0]
    mean_L = float(np.mean(L))
    std_L = float(np.std(L))
    # Flag: too dark (<40) or too bright (>200) or no variance (<10)
    exposure_ok = 40 < mean_L < 200 and std_L > 10
    checks['F05_exposure'] = {
        'passed': exposure_ok,
        'severity': 'high',
        'mean_L': mean_L, 'std_L': std_L
    }

    # File integrity
    checks['file_valid'] = {
        'passed': img is not None and h > 0 and w > 0,
        'severity': 'critical',
        'dims': f'{w}x{h}'
    }

    results[frame_id] = checks

print(json.dumps(results, indent=2))
```

---

## Phase 3 — VLM visual review (per frame)

For each frame that PASSED automated checks: use `read_artifact` with the image URL
and perform VLM review. Check:

**F-02 Location accuracy:**
> "Does this image show [LOCATION_ANCHOR description from visual_bible]?
> Specifically: is this a [era]-period [location type] with [key feature 1] and [key feature 2]?
> Answer: PASS or FAIL + one-sentence reason."

**F-03 Character identity:**
> "Is the person in this image consistent with: [CHARACTER_ANCHOR from visual_bible]?
> Check specifically: hair length/style, clothing type, clothing color.
> Answer: PASS or FAIL + one-sentence reason."

**F-04 Costume consistency:**
> "Does the character's clothing match: [costume description from visual_bible]?
> The character should be wearing [costume_key]. NOT [forbidden costume].
> Answer: PASS or FAIL + one-sentence reason."

**F-06 Content alignment:**
> "Shot description: [summary from shot_prompts for this frame].
> Does this image depict that content? Answer: PASS or FAIL + one-sentence reason."

**F-07 People count:**
> "The shot lists these characters: [Characters line]. Count the people visible. Does the count
> match? Exception: in a POV shot the POV character is the camera and appears as hands or
> forearms only. Answer: PASS or FAIL + one-sentence reason."

**F-08 Location and furniture:**
> "The shot text names this place and these objects / furniture: [Location + Action/Blocking].
> Are they present, and is nothing contradicting the text shown (a car that a frame edit
> removed, a missing bed)? Answer: PASS or FAIL + one-sentence reason."

**F-09 Outfits visible:**
> "Each visible character should wear the look in the shot's Outfits line: [Outfits]. Is it
> visible (and nude only where the line says nude)? Answer: PASS or FAIL + one-sentence reason."

**F-10 Single moment:**
> "Is this ONE continuous instant - no panels, split screen, collage, repeated figures or several
> stages of an action? Answer: PASS or FAIL + one-sentence reason."

**F-11 Act matches (only when the workspace's `contentPolicy.nudity` is `allowed` and the shot
has an `Act:` line):**
> "The shot's act: [Act text]. Does the image show exactly that act - who does what to whom, the
> positions and contact points? Answer: PASS or FAIL + one-sentence reason."

A check the vision model refuses, answers emptily or with something that is neither PASS nor
FAIL is **UNCHECKED**, with the reason. UNCHECKED is never a pass: a person must review that
frame (a take check in the studio may return the same `unchecked` verdict).

For frames that FAILED automated checks: skip VLM review (already critical fail).

---

## Phase 4 — Assemble QC report

```json
{
  "scene_id": "scene2",
  "overall_verdict": "PASS | FAIL_CRITICAL | FAIL_WARNING | NEEDS_REVIEW",
  "critical_failures": [],
  "warnings": [],
  "frames": {
    "s2_01": {
      "F01_grayscale": {"passed": true, "severity": "critical"},
      "F05_exposure": {"passed": true, "severity": "high", "mean_L": 112.3},
      "F02_location": {"passed": true, "severity": "critical", "reason": "Period hotel room visible"},
      "F03_character": {"passed": false, "severity": "critical", "reason": "Character wearing summer dress, not traveling clothes"},
      "F04_costume": {"passed": false, "severity": "high", "reason": "White dress visible, expected dark traveling clothes"},
      "F06_content": {"passed": true, "severity": "medium", "reason": "Wife at window as described"},
      "F07_people": {"passed": true, "severity": "high", "reason": "2 people, as listed"},
      "F11_act": {"passed": null, "verdict": "unchecked", "severity": "high", "reason": "vision model refused"}
    }
  },
  "recommended_action": "Re-render frames: s2_01 (F03 costume failure)"
}
```

Overall verdict rules:
- FAIL_CRITICAL: any frame has F01 or F02 or F03 failure
- FAIL_WARNING: any frame has an F04, F05, F06, F07, F08, F09, F10 or F11 failure but no critical failures
- NEEDS_REVIEW: no failure, but any check is UNCHECKED (list the frames); a person must review them, never reported as PASS
- PASS: all frames pass all checks (none unchecked)

Write the report to `scene{X}_storyboard_qc.json` via sandbox.

---

## Completion contract

Call `task_complete` after writing the JSON. Include in summary:
- Total frames checked
- Overall verdict
- Count of critical failures, if any
- List of frame IDs that need re-render

**Do NOT suppress or hide failures.** The QC report is a gate for the shooting phase.
A FAIL_CRITICAL verdict will block the shoot task from starting.
