"""Writes the REPL job files of the new-pose pipeline into the mannequin workspace (images are never committed).

  python3 build_jobs.py base [slug ...]            4 seeds of each pose's frontal base view (krea2_base_realism_nsfw)
  python3 build_jobs.py turns <chosen.json>        camera turns of each chosen base (qwen_image_camera_turn)
  python3 build_jobs.py fallback <slug:view> ...   seeded t2i of a view the turn could not make (base seed)
  python3 build_jobs.py lineart <views.json>       library-style line art of each view (qwen_image_multi_edit, Picture 2
                                                   = a library line-art sample; style experiment winner, see README)

chosen.json: {slug: {"seed": <int>, "file": "<slug>/base_s<seed>.png"}}; views.json: {slug: {view: "<file>"}}
(examples in templates/). Every file path is relative to $POSE_GEN_WORKSPACE (the host side of the job dir that
run.sh mounts into the REPL), where the job JSONs are written and the images land. Never commit images.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from poses import POSE_BY_SLUG, POSES, TURNS

WORKSPACE = Path(os.environ["POSE_GEN_WORKSPACE"])  # host path of the job dir the REPL sees (see README)
T2I, TURN, EDIT, GPU = "krea2_base_realism_nsfw", "qwen_image_camera_turn", "qwen_image_multi_edit", "l40s"
# Library line-art samples given to the edit as Picture 2 (copied into WORKSPACE/style/): duo/P009, full_body_sexy/P031.
STYLE_REF = {True: "style/lib_solo_line.png", False: "style/lib_P009_line.png"}
LINEART_SEED = 22  # the experiment's winning seed (no furniture drawn, like the library)


def lineart_prompt(solo: bool) -> str:
    who = "the figure" if solo else "the two figures"
    return (f"Redraw {who} of Picture 1 exactly in their pose, position, proportions and camera angle as a clean black line "
            "drawing on a pure white background, in the drawing style of Picture 2: articulated mannequin figures drawn with "
            "clean outlines, segment contours, circles at the joints and thin construction lines on the faceless heads. No "
            f"shading, no grey fill, no furniture, no wall, no floor, no background - only {who}. Do not change the pose of any limb.")


def t2i(slug: str, view: str, seed: int, file: str) -> dict:
    return {"params": {"prompt_positive": POSE_BY_SLUG[slug].prompt(view), "prompt_negative": "", "width": 1152,
                       "height": 1536, "steps": 6, "cfg": 1.0, "seed": seed}, "file": file}


def write(name: str, wf: str, jobs: list[dict]) -> None:
    (WORKSPACE / name).write_text(json.dumps({"wf": wf, "gpu": GPU, "jobs": jobs}, indent=1))
    print(f"{name}: {len(jobs)} jobs")


def main() -> None:
    mode, args = sys.argv[1], sys.argv[2:]
    if mode == "base":
        slugs = args or [p.slug for p in POSES]
        jobs = []
        for slug in slugs:
            (WORKSPACE / slug).mkdir(parents=True, exist_ok=True)
            jobs += [t2i(slug, "front", s, f"{slug}/base_s{s}.png") for s in POSE_BY_SLUG[slug].seeds]
        write("jobs_base.json", T2I, jobs)
    elif mode == "turns":
        chosen = json.loads(Path(args[0]).read_text())
        jobs = [{"inputs": {"source_image": c["file"]},
                 "params": {"prompt_positive": prompt, "longest_edge": 1536, "steps": 8, "cfg": 1, "seed": c["seed"]},
                 "file": f"{slug}/turn_{view}.png"}
                for slug, c in chosen.items() for view, prompt in TURNS.items()]
        write("jobs_turns.json", TURN, jobs)
    elif mode == "fallback":
        chosen = json.loads((WORKSPACE / "chosen.json").read_text())
        jobs = []
        for item in args:
            slug, view = item.split(":")
            jobs.append(t2i(slug, view, chosen[slug]["seed"], f"{slug}/t2i_{view}.png"))
        write("jobs_fallback.json", T2I, jobs)
    elif mode == "lineart":
        views = json.loads(Path(args[0]).read_text())  # {slug: {view: "<file of the chosen view render>"}}
        jobs = [{"inputs": {"reference_image_1": file, "reference_image_2": STYLE_REF[POSE_BY_SLUG[slug].solo]},
                 "params": {"prompt_positive": lineart_prompt(POSE_BY_SLUG[slug].solo),
                            "prompt_negative": "shading, grey fill, colour, photo, 3D render, gradient, texture",
                            "steps": 8, "cfg": 1, "seed": LINEART_SEED},
                 "file": f"{slug}/line_{view}.png"}
                for slug, per_view in views.items() for view, file in per_view.items()]
        write("jobs_lineart.json", EDIT, jobs)
    else:
        sys.exit(f"unknown mode {mode}")


if __name__ == "__main__":
    main()
