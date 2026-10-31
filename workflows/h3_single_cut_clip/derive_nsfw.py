"""Derive h3_*_nsfw bundles from the SFW h3_single_cut_clip / h3_multishot_clip / h3_clip_continuation bundles.

The NSFW variant = the SFW graph + the skin-realism (0.5) and anatomy (0.6) LoRAs baked into the
Power Lora Loader, their model entries, and the NSFW wording. Re-run after every change to either
SFW bundle (the e2e-test.ts of the NSFW bundles are hand-written and not touched):

    python3 workflows/h3_single_cut_clip/derive_nsfw.py workflows
"""
import json
import pathlib
import re
import sys

LIB = pathlib.Path(sys.argv[1])
LORA_NODE = {"h3_single_cut_clip": "674", "h3_multishot_clip": "674", "h3_clip_continuation": "our_loras"}
BAKED = {
    "lora_2": {"on": True, "lora": "PlagueKind-tiddies-realismslider.safetensors", "strength": 0.5},
    "lora_3": {"on": True, "lora": "MysticXXX_MMH3-V3.safetensors", "strength": 0.6},
}
MODELS = """
  # CivitAI blocks datacenter IPs, so the two CivitAI-sourced NSFW LoRAs come from the model-cache mirror.
  - name: PlagueKind-tiddies-realismslider
    type: lora
    files:
      - url: https://s3.us-east-1.amazonaws.com/auteur-model-cache-20260905193718168400000001/public/lora/PlagueKind-tiddies-realismslider.safetensors
        filename: PlagueKind-tiddies-realismslider.safetensors
        sha256: e5c8c275af58663a664ad2922cc10a248bff70b941043375d2c82d9cc55b7030

  - name: MysticXXX_MMH3-V3
    type: lora
    files:
      - url: https://s3.us-east-1.amazonaws.com/auteur-model-cache-20260905193718168400000001/public/lora/MysticXXX_MMH3-V3.safetensors
        filename: MysticXXX_MMH3-V3.safetensors
        sha256: 99307e313784cbea7d9ee2a56ecb8794272f1024737985b824eca8c5c619a0b6
"""


def must_replace(text: str, old: str, new: str) -> str:
    if old not in text:
        raise SystemExit(f"not found: {old[:70]!r}")
    return text.replace(old, new)


for base, node in LORA_NODE.items():
    src, dst = LIB / base, LIB / f"{base}_nsfw"
    dst.mkdir(exist_ok=True)
    graph = json.loads((src / "workflow.json").read_text())
    graph[node]["inputs"].update(BAKED)
    (dst / "workflow.json").write_text(json.dumps(graph, indent=2, ensure_ascii=False) + "\n")

    y = (src / "workflow.yaml").read_text()
    for name in LORA_NODE:
        y = re.sub(rf"\b{name}\b(?!_nsfw)", f"{name}_nsfw", y)
    head_start, head_end = y.index("# ─── Source"), y.index("# ─── Custom Nodes")
    y = (y[:head_start] + "# ─── Source ───────────────────────────────────────────────────────────────────\n"
         f"# NSFW variant of {base}: the same graph and ports with a skin-realism and an anatomy\n"
         "# LoRA baked into the Power Lora Loader next to the LightX2V turbo LoRA. Generated from the SFW\n"
         f"# bundle by h3_single_cut_clip/derive_nsfw.py - change {base} and re-run it, never edit\n"
         f"# this bundle by hand. Sources and node notes: see {base}.\n"
         "#\n" + y[head_end:])
    y = must_replace(y, "url: workflow.json\n",
                     "  NSFW variant: a skin-realism (0.5) and an anatomy (0.6) LoRA are baked in next to the turbo\n"
                     "  LoRA; the four LoRA ports take act / detail adapters from the workspace catalog.\nurl: workflow.json\n")
    y = must_replace(y, "the\n  # always-on LightX2V turbo distillation (lora_1, 0.7) needs no port",
                     "the\n  # always-on LightX2V turbo distillation (lora_1, 0.7), skin-realism slider (lora_2, 0.5) and anatomy\n"
                     "  # LoRA (lora_3, MysticXXX 0.6) need no port")
    y = y.replace("Appended after the always-on turbo LoRA baked into the workflow.",
                  "Appended after the three always-on LoRAs baked into the workflow (turbo, realism slider, anatomy).")
    y = y.replace("(style, character or motion adapter trained for MiniMax H3)", "(act or detail adapter trained for MiniMax H3)")
    y = y.replace("Never select the turbo LoRA here", "Never select the three baked-in LoRAs here")
    y = y.replace("Stacks on top of the turbo LoRA", "Stacks on top of the baked-in LoRAs")
    y = must_replace(y, "  LoRAs: the LightX2V turbo LoRA (0.7) is baked in - do not select it on a port.",
                     "  LoRAs: three are always on and baked into the graph - the LightX2V turbo distillation (0.7),\n"
                     "  a skin-realism slider (0.5) and an anatomy LoRA (0.6). Do not select them on a port.")
    y = y.replace("take style / character adapters", "take act / detail adapters")
    y = must_replace(y, "\n  - name: rife49\n", MODELS + "\n  - name: rife49\n")
    y = must_replace(y, "\nmodel_family: minimaxh3\n", "\nmodel_family: minimaxh3\ncontent: nsfw\n")
    (dst / "workflow.yaml").write_text(y)
    print("wrote", dst)
