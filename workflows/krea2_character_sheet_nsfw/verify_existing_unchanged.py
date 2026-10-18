"""Proves the POV column only ADDS to a character-sheet graph: compares the workflow.json of a git revision (default
HEAD) with the working tree for both bundles. Every node of the old graph must be identical in the new one, except the
final sheet switch (the one node whose inputs now point at the stitched-on POV column). Prints the additions.

  python3 verify_existing_unchanged.py [git-rev]        (run from anywhere; exit 1 on any other change)
"""
import json
import subprocess
import sys
from pathlib import Path

REV = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
ROOT = Path(__file__).resolve().parent.parent
bad = 0
for bundle in ("krea2_character_sheet_nsfw", "krea2_character_sheet"):
    old = json.loads(subprocess.check_output(["git", "show", f"{REV}:workflows/{bundle}/workflow.json"], cwd=ROOT))
    new = json.loads((ROOT / bundle / "workflow.json").read_text())
    changed = sorted(k for k in old if k in new and old[k] != new[k])
    removed = sorted(k for k in old if k not in new)
    added = sorted((k for k in new if k not in old), key=int)
    sheet_switch = [k for k in changed if new[k]["class_type"] == "ComfySwitchNode" and "ImageStitch" in new[new[k]["inputs"]["on_false"][0]]["class_type"]]
    print(f"{bundle}: {len(old)} -> {len(new)} nodes; removed {removed}; changed {changed}; added {len(added)}")
    kinds: dict[str, int] = {}
    for k in added:
        kinds[new[k]["class_type"]] = kinds.get(new[k]["class_type"], 0) + 1
    print("  added by class:", kinds, "ids", added[0], "..", added[-1])
    # the only change allowed: the final sheet switch (feeds SaveImage 9000)
    final = new["9000"]["inputs"]["images"][0]
    if removed or changed != [final] or sheet_switch != [final]:
        bad += 1
        print("  UNEXPECTED difference")
    else:
        print(f"  OK: all {len(old) - 1} other existing nodes identical; only node {final} (final sheet switch) re-wired to the POV column")
sys.exit(1 if bad else 0)
