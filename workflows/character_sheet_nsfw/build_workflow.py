"""Generates workflow.json of character_sheet_nsfw - the single source of the graph.

Run from anywhere: python3 build_workflow.py  (stdlib only; reads templates.json next to it).

The graph re-poses one character (port character_image) into the 15 mannequin pose templates of
the chosen gender with Krea 2 Identity Edit (two-reference mode: image 1 = template, image 2 =
character), one sampler chain per sheet slot, and lays the panels out as one sheet. Every gender /
background choice is a lazy core ComfySwitchNode, so only the chosen template set is downloaded and
each slot is sampled once.

Sheet layout (each group 1280x1080, 16 px gutters between groups -> 3872x2176; white gutters on the
grey background, black ones with white_background):
  row 1: full body front|side|back | 2x2 poses | standing pose
  row 2: front portrait | female: looking-up portraits side|front, male: expressions 2x2
                        | female: expressions 2x2,           male: lying side over lying top
"""
import json
from pathlib import Path

HERE = Path(__file__).parent
TEMPLATES = json.loads((HERE / "templates.json").read_text())

# Output sizes keep each template's aspect ratio at ~1.2-1.5 MP (the identity edit degrades above ~2 MP).
FULL, WIDE, PORTRAIT, STRIP = (768, 1920), (1216, 1024), (912, 1536), (1904, 800)

PRONOUNS = {
    "female": {"subject": "woman", "he": "she", "him": "her", "his": "her", "He": "She", "His": "Her"},
    "male": {"subject": "man", "he": "he", "him": "him", "his": "his", "He": "He", "His": "His"},
}
# Profile panels turn the face to the camera unless the head is pinned (spike 2026-10-14).
PROFILE_HEAD = (
    "{His} head and face are also in exact profile, turned the same way as {his} body: {he} looks straight ahead, "
    "not at the camera; only one eye and the side of {his} face are visible."
)
BACK_HEAD = (
    "{His} head faces straight away from the camera like the rest of {his} body, not turned over {his} shoulder: "
    "only the back of {his} head and {his} hair are visible, {his} face cannot be seen at all."
)
# The white-background sentence once left the mannequin's grey arms on lying_top.
NO_MANNEQUIN = (
    "Every part of {his} body, both arms and hands included, is real skin like the rest of {him}; no grey mannequin "
    "parts remain."
)

# name -> (size, what the template shows, restated so the edit keeps it)
PANELS = {
    "fullbody_front": (FULL, "{He} stands upright facing the camera, arms hanging at {his} sides, neutral expression, the whole body from head to toes in frame."),
    "fullbody_side": (FULL, "{He} stands upright in exact left profile, the whole body from head to toes in frame. " + PROFILE_HEAD),
    "fullbody_back": (FULL, "{He} stands upright with {his} back to the camera, the whole body from head to heels in frame. " + BACK_HEAD),
    "portrait_front_wide": (WIDE, "Head-and-shoulders portrait facing the camera squarely, neutral relaxed expression, lips closed, eyes looking into the camera."),
    "expr_smile": (WIDE, "{He} smiles warmly with {his} mouth open and the upper teeth visible, looking into the camera."),
    "expr_frightened": (WIDE, "{His} expression is frightened: eyes wide open, eyebrows raised and drawn together, mouth slightly open."),
    "expr_pleasure": (WIDE, "{His} expression is intense pleasure: head tilted slightly back, eyes rolled upward under half-closed eyelids, lips parted in an open-mouthed smile."),
    # female
    "crawl_side": (WIDE, "{He} is on {his} hands and knees in exact side profile, head raised looking forward, the whole body from head to feet in frame."),
    "crawl_back": (WIDE, "{He} is on {his} hands and knees seen from straight behind, {his} head turned back over {his} right shoulder so {his} face looks directly into the camera."),
    "sit_open": (WIDE, "{He} reclines on {his} bent forearms facing the camera, knees drawn up and spread wide, looking directly into the camera."),
    "cowgirl": (WIDE, "{He} kneels upright straddling with {his} knees spread wide, hands on {his} thighs, facing the camera."),
    "pose_hand_on_hip": (WIDE, "{He} stands facing the camera with {his} weight on one leg, one hand on {his} hip, the whole body from head to toes in frame."),
    "portrait_up_side": (PORTRAIT, "{He} is in left side profile, seen from above, chin lifted and face tilted up, eyes looking up, mouth open, slightly frightened. " + PROFILE_HEAD),
    "portrait_up_front": (PORTRAIT, "Seen from above, {he} tilts {his} head back and looks up into the camera, mouth open, slightly frightened."),
    "expr_mouth_open": (WIDE, "{He} holds {his} mouth wide open, jaw dropped, teeth and tongue visible, eyes looking into the camera."),
    # male
    "kneel_side": (WIDE, "{He} kneels upright on both knees in exact side profile, arms hanging at {his} sides, the whole body from head to knees and feet in frame. " + PROFILE_HEAD),
    "kneel_back": (WIDE, "{He} kneels upright on both knees with {his} back to the camera: thighs vertical, hips and upper body held upright directly above the knees, not sitting back on {his} heels. {He} looks back over {his} right shoulder, {his} face turned toward the camera, eyes looking into the lens."),
    "sit_pose": (WIDE, "{He} is seated upright in empty space at a three-quarter angle, thighs level, knees bent at a right angle, hands on {his} thighs, face turned toward the camera; there is no chair, stool or furniture anywhere."),
    "plank": (WIDE, "{He} is face down in exact side profile, propped up on straight arms, hips lowered close to the floor, legs extended behind, head in line with the torso looking forward and slightly down, not at the camera."),
    "pose_hands_on_hips": (WIDE, "{He} stands facing the camera, feet shoulder-width apart, both hands on {his} hips with the elbows out, confident neutral expression, the whole body from head to toes in frame."),
    "expr_strained": (WIDE, "{He} looks physically exhausted and strained, not angry: eyebrows raised and pulled together, eyes half closed, mouth hanging open as {he} gasps for breath, head tipped slightly back."),
    "lying_side": (STRIP, "{He} lies flat on {his} back on the floor in exact side profile, body stretched out in one straight horizontal line, face pointing up at the ceiling, not at the camera, the whole body from head to feet in frame."),
    "lying_top": (STRIP, "Seen from directly overhead, {he} lies flat on {his} back on the floor, body stretched out in one straight horizontal line, arms along {his} sides, face looking straight up into the camera, the whole body from head to feet in frame. " + NO_MANNEQUIN),
}

# Sheet slots: (female panel, male panel). The layout below addresses slots by index.
SLOTS = [
    ("fullbody_front", "fullbody_front"),
    ("fullbody_side", "fullbody_side"),
    ("fullbody_back", "fullbody_back"),
    ("crawl_side", "kneel_side"),
    ("crawl_back", "kneel_back"),
    ("sit_open", "sit_pose"),
    ("cowgirl", "plank"),
    ("pose_hand_on_hip", "pose_hands_on_hips"),
    ("portrait_front_wide", "portrait_front_wide"),
    ("portrait_up_side", "expr_smile"),
    ("portrait_up_front", "expr_frightened"),
    ("expr_smile", "expr_strained"),
    ("expr_frightened", "expr_pleasure"),
    ("expr_mouth_open", "lying_side"),
    ("expr_pleasure", "lying_top"),
]
# Krea2EditModelPatch pull of the person (ref_boost) and of the template (ref_boost_a); `identity` = whether the
# identity_prompt sentence is appended.
TUNED = {"ref_boost": 4.0, "ref_boost_a": 2.5, "identity": True}
PANEL_TUNE = {
    # Looked back over the shoulder unless the template pulls harder and the face-feature sentence is left out.
    "fullbody_back": {"ref_boost": 2.0, "ref_boost_a": 5.0, "identity": False},
    # Sat back on the heels instead of kneeling upright as the template does.
    "kneel_back": {"ref_boost": 2.0, "ref_boost_a": 5.0},
}


def tune_of(panel: str) -> dict:
    return {**TUNED, **PANEL_TUNE.get(panel, {})}


EDIT_PROMPT = (
    "Replace the grey mannequin in image 1 with the {subject} from image 2. Keep the exact pose, body position, camera "
    "angle, framing and facial expression of the mannequin in image 1. {keep} {He} is nude as in image 2, with "
    "realistic skin texture and soft even studio lighting."
)
# Keep in sync with the identity_prompt default in workflow.yaml.
DEFAULT_IDENTITY = (
    "Preserve the exact facial identity, hairstyle, hair colour, eye colour, skin tone and body build of the person in image 2."
)
GREY_BACKGROUND = "Keep the plain grey studio background of image 1."
WHITE_BACKGROUND = (
    "Replace the grey studio background of image 1 with a pure white seamless studio background: plain white "
    "(#FFFFFF) everywhere behind the figure, no grey, no gradient, no vignette, only a faint soft contact shadow."
)

GROUP_W, GROUP_H, GUTTER = 1280, 1080, 16

graph: dict = {}


def node(node_id: int, class_type: str, **inputs) -> list:
    graph[str(node_id)] = {"class_type": class_type, "inputs": inputs}
    return [str(node_id), 0]


def switch(node_id: int, on_male: list, on_female: list) -> list:
    return node(node_id, "ComfySwitchNode", switch=IS_MALE, on_false=on_female, on_true=on_male)


def edit_prompt(panel: str, gender: str) -> str:
    p = PRONOUNS[gender]
    return EDIT_PROMPT.format(keep=PANELS[panel][1].format(**p), **p)


# ── shared: models, character, settings ─────────────────────────────────────
node(1, "UNETLoader", unet_name="krea2_raw_bf16.safetensors", weight_dtype="default")
node(2, "CLIPLoader", clip_name="qwen3vl_4b_bf16.safetensors", type="krea2", device="default")
VAE = node(3, "VAELoader", vae_name="wan21_vae_fp32.safetensors")
lora_chain = [
    (10, "krea2_turbo_lora_rank_64_bf16.safetensors", 1.0),
    (11, "krea2filterbypass.safetensors", 1.0),
    (12, "Krea2-realism-V1.safetensors", 1.0),
    (13, "KNPV4.1_pre.safetensors", 0.9),
    (14, "krea2_identity_edit_v1_2.safetensors", 1.0),
]
model = ["1", 0]
for nid, name, strength in lora_chain:
    model = node(nid, "LoraLoaderModelOnly", lora_name=name, strength_model=strength, model=model)
CHARACTER = node(21, "LoadImage", image="character_image.png")
CHARACTER_LATENT = node(23, "VAEEncode", pixels=CHARACTER, vae=VAE)

GENDER = node(60, "PrimitiveString", value="female")
IS_MALE = node(61, "StringCompare", string_a=GENDER, string_b="male", mode="Equal", case_sensitive=False)
WHITE = node(62, "PrimitiveBoolean", value=False)
IDENTITY = node(63, "PrimitiveStringMultiline", value=DEFAULT_IDENTITY)
BACKGROUND = node(
    66, "ComfySwitchNode", switch=WHITE,
    on_false=node(64, "PrimitiveStringMultiline", value=GREY_BACKGROUND),
    on_true=node(65, "PrimitiveStringMultiline", value=WHITE_BACKGROUND),
)
SUFFIX = node(67, "StringConcatenate", string_a=IDENTITY, string_b=BACKGROUND, delimiter=" ")
SEED = node(68, "PrimitiveInt", value=0)
STEPS = node(69, "PrimitiveInt", value=10)


# ── one sampler chain per slot ──────────────────────────────────────────────
def suffix_of(tune: dict) -> list:
    """What follows a panel's instruction: identity sentence + background, or the background alone."""
    return SUFFIX if tune["identity"] else BACKGROUND


def gendered(base: int, female, male, primitive: str) -> list:
    """A constant that differs by gender: two primitives + a switch (ids base..base+2)."""
    return switch(base + 2, node(base + 1, primitive, value=male), node(base, primitive, value=female))


def slot_chain(i: int, female: str, male: str) -> list:
    b = 1000 + i * 100
    template = switch(
        b + 3,
        node(b + 2, "Image Load", image_path=TEMPLATES["male"][male], RGBA="false", filename_text_extension="true"),
        node(b + 1, "Image Load", image_path=TEMPLATES["female"][female], RGBA="false", filename_text_extension="true"),
    )
    tf, tm = tune_of(female), tune_of(male)
    body = gendered(b + 4, edit_prompt(female, "female"), edit_prompt(male, "male"), "PrimitiveStringMultiline")
    suffix = suffix_of(tf) if tf["identity"] == tm["identity"] else switch(b + 33, suffix_of(tm), suffix_of(tf))
    prompt = node(b + 7, "StringConcatenate", string_a=body, string_b=suffix, delimiter=" ")
    (fw, fh), (mw, mh) = PANELS[female][0], PANELS[male][0]
    width = fw if fw == mw else gendered(b + 10, fw, mw, "PrimitiveInt")
    height = fh if fh == mh else gendered(b + 13, fh, mh, "PrimitiveInt")
    latent = node(b + 21, "EmptySD3LatentImage", width=width, height=height, batch_size=1)
    boosts = {
        key: tf[key] if tf[key] == tm[key] else gendered(base, tf[key], tm[key], "PrimitiveFloat")
        for key, base in (("ref_boost", b + 10 + 6), ("ref_boost_a", b + 30))
    }
    patched = node(
        b + 22, "Krea2EditModelPatch", model=model, vae=VAE, fit_mode="fit", target_latent=latent,
        source_image=template, source_latent=node(b + 20, "VAEEncode", pixels=template, vae=VAE),
        source_image_b=CHARACTER, source_latent_b=CHARACTER_LATENT, **boosts,
    )
    positive = node(
        b + 23, "Krea2EditGroundedEncode", clip=["2", 0], prompt=prompt, image=template, image_b=CHARACTER,
        grounding_px=768, system_prompt="",
    )
    # cfg 1 never evaluates the negative branch; a zeroed positive avoids a second grounded encode.
    negative = node(b + 24, "ConditioningZeroOut", conditioning=positive)
    samples = node(
        b + 25, "KSampler", seed=SEED, steps=STEPS, cfg=1.0, sampler_name="euler", scheduler="simple", denoise=1.0,
        model=patched, positive=positive, negative=negative, latent_image=latent,
    )
    return node(b + 26, "VAEDecode", samples=samples, vae=VAE)


PANEL_IMAGES = [slot_chain(i, f, m) for i, (f, m) in enumerate(SLOTS)]

# ── layout ──────────────────────────────────────────────────────────────────
_next_id = 3000


def _id() -> int:
    global _next_id
    _next_id += 1
    return _next_id


def fit(image: list, w: int, h: int) -> list:
    """Scale to cover w x h, then centre-crop (compose_sheet.py's fit)."""
    return node(_id(), "ImageResize+", image=image, width=w, height=h, interpolation="lanczos",
                method="fill / crop", condition="always", multiple_of=0)


def stitch(a: list, b: list, direction: str, gap: int = 0, gap_color: str = "white") -> list:
    return node(_id(), "ImageStitch", image1=a, image2=b, direction=direction, match_image_size=False,
                spacing_width=gap, spacing_color=gap_color)


def row(slots: list[int], w: int = GROUP_W, h: int = GROUP_H) -> list:
    widths = [w // len(slots)] * len(slots)
    widths[-1] += w - sum(widths)
    out = fit(PANEL_IMAGES[slots[0]], widths[0], h)
    for s, cw in zip(slots[1:], widths[1:]):
        out = stitch(out, fit(PANEL_IMAGES[s], cw, h), "right")
    return out


def grid(slots: list[int]) -> list:
    return stitch(row(slots[:2], h=GROUP_H // 2), row(slots[2:], h=GROUP_H // 2), "down")


# Gutter-free groups, built once; only the gutter stitches depend on the gutter colour.
STACK_H = (GROUP_H - GUTTER) // 2
FULLBODY_ROW, POSES, STANDING = row([0, 1, 2]), grid([3, 4, 5, 6]), fit(PANEL_IMAGES[7], GROUP_W, GROUP_H)
PORTRAIT_FRONT = fit(PANEL_IMAGES[8], GROUP_W, GROUP_H)
FEMALE_TAIL = (row([9, 10]), grid([11, 12, 13, 14]))
MALE_TAIL = (grid([9, 10, 11, 12]), (fit(PANEL_IMAGES[13], GROUP_W, STACK_H), fit(PANEL_IMAGES[14], GROUP_W, STACK_H)))


def sheet(gap_color: str) -> list:
    """The groups joined by GUTTER-wide gutters of gap_color."""
    def beside(groups: list[list]) -> list:
        out = groups[0]
        for g in groups[1:]:
            out = stitch(out, g, "right", GUTTER, gap_color)
        return out

    lying_stack = stitch(*MALE_TAIL[1], "down", GUTTER, gap_color)
    tail = switch(_id(), beside([MALE_TAIL[0], lying_stack]), beside(list(FEMALE_TAIL)))
    return stitch(beside([FULLBODY_ROW, POSES, STANDING]), beside([PORTRAIT_FRONT, tail]), "down", GUTTER, gap_color)


# White gutters vanish on white panels: black gutters there, white ones on grey.
SHEET = node(_id(), "ComfySwitchNode", switch=WHITE, on_false=sheet("white"), on_true=sheet("black"))

# ── outputs (node ids are the yaml's output bindings) ────────────────────────
node(9000, "SaveImage", filename_prefix="charsheet", images=SHEET)
node(9001, "SaveImage", filename_prefix="charsheet_front", images=PANEL_IMAGES[0])
node(9002, "SaveImage", filename_prefix="charsheet_side", images=PANEL_IMAGES[1])
node(9003, "SaveImage", filename_prefix="charsheet_back", images=PANEL_IMAGES[2])
node(9004, "SaveImage", filename_prefix="charsheet_portrait", images=PANEL_IMAGES[8])

(HERE / "workflow.json").write_text(json.dumps(graph, indent=2) + "\n")
print(f"workflow.json: {len(graph)} nodes")
