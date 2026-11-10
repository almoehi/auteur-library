"""New library poses (PLAN_POSE_CATALOG_ADOPTION.md 4.6 L2): one spec per pose, prompts built limb by limb from
the server pose catalog (`../jobs/relabel_v5/pose_catalog.json`, the one authority; re-export it with
`jobs/relabel_v5/export_pose_catalog.mts` when the server catalog changes) plus pose-specific detail.

Every ESSENTIAL catalog support sentence is rendered with the role names of the pose ("the man" / "the woman"); a solo pose
keeps only the supports about her own body and names the absent partner as unseen. The camera text is separate,
so the same pose text drives the base view and any seeded t2i fallback view.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

HERE = Path(__file__).resolve().parent
CATALOG = {e["name"]: e for e in json.loads((HERE.parent / "jobs" / "relabel_v5" / "pose_catalog.json").read_text())["entries"]}

Role = Literal["a", "b"]
ViewName = Literal["front", "side", "diag", "high", "low", "back"]

DUO_LOOK = (
    "Studio 3D render of two smooth matte light-grey adult mannequin figures, a female mannequin and a male mannequin, "
    "athletic adult proportions, completely bald, no hair, no clothing, each figure made of one uniform pale grey material "
    "with a sculpted but featureless face in the same grey material, no skin colour, no skin texture. "
    "Plain seamless neutral mid-grey studio background, soft even diffuse lighting, soft contact shadow on the floor, "
    "sharp focus, clean product-photography look, no text, no labels."
)
SOLO_LOOK = (
    "Studio 3D render of one smooth matte light-grey adult female mannequin figure, athletic adult proportions, completely "
    "bald, no hair, no clothing, the whole figure made of one uniform pale grey material with a sculpted but featureless "
    "face in the same grey material, no skin colour, no skin texture. She is alone: no other person, no partner, no body "
    "parts of anyone else in the picture. Plain seamless neutral mid-grey studio background, soft even diffuse lighting, "
    "soft contact shadow on the floor, sharp focus, clean product-photography look, no text, no labels, no props."
)


@dataclass(frozen=True)
class PoseSpec:
    slug: str
    title: str
    position: str  # catalog name = the `sex_positions` tag
    series: Literal["duo", "full_body_sexy"]
    roles: dict[Role, str]  # role -> "the man" / "the woman"; a solo pose maps only her role
    extra: str  # pose-specific limb detail beyond the catalog supports
    furniture: str  # the support the pose needs ("" = floor only); kept in the depth map
    camera: dict[ViewName, str]  # camera text of the base view and of a t2i fallback per view
    acts: tuple[str, ...] = ()
    seeds: tuple[int, ...] = (11, 7301, 4242, 90210)
    solo: bool = field(init=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "solo", self.series != "duo")

    def pose_text(self) -> str:
        entry = CATALOG[self.position]
        names = dict(self.roles)
        sentences = []
        for s in entry["supports"]:
            if not s["essential"]:
                continue  # details (hands, the other foot) come from `extra`, which may place them differently
            roles_named = {p.split(":")[0].lower() for p in s["parts"]}
            if self.solo and not roles_named <= set(names):
                continue  # about the absent partner
            text = s["sentence"]
            for role, label in (("a", names.get("a")), ("b", names.get("b"))):
                if label:
                    text = text.replace(f"person {role.upper()}'s", f"{label}'s").replace(f"person {role.upper()}", label)
            sentences.append(text[0].upper() + text[1:] + ".")
        return " ".join(sentences) + " " + self.extra

    def prompt(self, view: ViewName) -> str:
        look = SOLO_LOOK if self.solo else DUO_LOOK
        surface = f" {self.furniture}" if self.furniture else ""
        return f"{self.camera[view]} {self.pose_text()}{surface} {look}"


FRAMING = "The whole of both figures from head to feet is in frame and centred."
SOLO_FRAMING = "The whole figure from head to knees and feet is in frame and centred."

POSES: tuple[PoseSpec, ...] = (
    PoseSpec(
        slug="edge_of_surface",
        title="Sitting on the edge of a counter, he stands between her open thighs",
        position="edge of surface",
        series="duo",
        roles={"a": "the man", "b": "the woman"},
        extra=(
            "Her lower legs hang down and wrap around the backs of his thighs, her feet crossed behind his legs, off the floor. "
            "Her hands rest on his shoulders. Both of his feet are flat on the floor, both of his legs straight; nobody "
            "raises a knee. His hips are at the counter edge, pressed against her crotch, his hands on her waist."
        ),
        furniture="The surface she sits on is a plain rectangular counter block of the same matte grey material, about hip height.",
        camera={
            "front": "Frontal full-body view at eye level, the camera directly in front of the woman and the counter, behind the man, "
            f"slightly off-centre so that her face, chest, open thighs and both knees on either side of his hips are visible. {FRAMING}",
            "low": "Worm's-eye low-angle view: the camera lies on the floor in front of the counter, pointing steeply up at the couple, "
            f"the underside of the counter top edge and of their chins visible, strong upward perspective. {FRAMING}",
            "high": f"High-angle full-body view from above and in front, looking down at the couple. {FRAMING}",
            "side": f"Exact side profile view of the couple at eye level. {FRAMING}",
            "diag": f"Three-quarter view at eye level, 45 degrees between front and side. {FRAMING}",
            "back": f"View from behind the counter at eye level: the woman's back toward the camera, the man facing the camera. {FRAMING}",
        },
    ),
    PoseSpec(
        slug="against_the_wall",
        title="Against the wall, her knee raised at his hip, he presses against her front",
        position="against the wall",
        series="duo",
        roles={"a": "the man", "b": "the woman"},
        extra=(
            "Her raised knee is bent and lifted up to the height of his hip, her thigh against his side. Her other leg is straight "
            "with the foot flat on the floor. His hand holds her lifted thigh under the knee; his other hand rests on the wall "
            "beside her shoulder. Both of his feet are flat on the floor. Her arms are around his neck."
        ),
        furniture="Behind her is a plain flat vertical wall panel of the same matte grey material, standing on the floor.",
        camera={
            "front": "Frontal full-body view at eye level, the camera facing the wall and the woman's front from slightly to the man's "
            f"side, so that her face, chest, raised knee at his hip and his hand on her thigh are visible beside him. {FRAMING}",
            "low": "Worm's-eye low-angle view: the camera lies on the floor a few steps from the couple, pointing steeply up, "
            f"the underside of their chins visible, strong upward perspective, the wall beside them. {FRAMING}",
            "high": f"High-angle full-body view from above and in front, looking down at the couple. {FRAMING}",
            "side": f"Exact side profile view of the couple and the wall at eye level. {FRAMING}",
            "diag": f"Three-quarter view at eye level. {FRAMING}",
            "back": f"View from behind the man at eye level, his back toward the camera, the woman against the wall beyond him. {FRAMING}",
        },
    ),
    PoseSpec(
        # PROPOSED position (../jobs/relabel_v5/proposed_positions.json): not the catalog's `standing from behind`,
        # which needs her bent forward at the hips. The camera cannot face the couple (the wall is there), so the
        # base view is the profile and there is no `front` view.
        slug="against_the_wall_from_behind",
        title="Facing the wall, chest pressed to it, arms raised, he stands pressed against her back",
        position="against the wall from behind",
        series="duo",
        roles={"a": "the man", "b": "the woman"},
        extra=(
            "She stands upright on both feet close to the wall, facing it, legs slightly apart. Both of her arms are raised "
            "high and spread wide above her head, both palms flat on the wall. Her chest and breasts are pressed flat against "
            "the wall. Her back is arched, her hips pushed back toward him. He stands upright on both feet right behind her, "
            "his chest against her back, his hips pressed against her buttocks, his hands holding her hips. Nobody kneels, "
            "nobody bends forward at the hips."
        ),
        furniture="The wall is a plain flat vertical wall panel of the same matte grey material, standing on the floor.",
        camera={
            "front": "",  # impossible: the camera would stand inside the wall
            "side": "Exact side profile view at eye level: the wall panel seen edge-on at one side of the picture, the woman "
            f"pressed against it facing it, the man right behind her, both in profile. {FRAMING}",
            "low": "Worm's-eye low-angle view from the side: the camera lies on the floor a few steps away, pointing steeply "
            f"up at the couple and the wall, strong upward perspective. {FRAMING}",
            "high": f"High-angle view from above and to the side, looking down at the couple against the wall. {FRAMING}",
            "diag": f"Three-quarter view from behind the man at eye level, the wall beyond the couple. {FRAMING}",
            "back": f"View from directly behind the man at eye level, his back toward the camera, the wall beyond them. {FRAMING}",
        },
    ),
    PoseSpec(
        slug="oral_kneeling",
        title="Kneeling on the floor, face at his hips, he stands in front of her",
        position="kneeling",
        series="duo",
        roles={"a": "the woman", "b": "the man"},
        acts=("blowjob",),
        extra=(
            "She kneels upright on both knees on the floor, her thighs vertical, her face at the height of his hips, close to his "
            "groin, her hands on the fronts of his thighs. He stands upright on both feet right in front of her, facing her, his "
            "hands resting on her head."
        ),
        furniture="",
        camera={
            "front": "Front three-quarter view at the height of the standing man's hips: the camera faces the kneeling woman's front "
            "from 45 degrees to her right, so that her face, chest and both knees face the camera and her face at his hips is "
            f"visible beside his hip; he is seen from his side. {FRAMING}",
            "low": "Worm's-eye low-angle view: the camera lies on the floor beside her knees, pointing steeply up at the pair, the "
            f"underside of the man's chin visible, strong upward perspective. {FRAMING}",
            "high": f"High-angle view from above, as the standing man sees her: looking down at the kneeling woman. {FRAMING}",
            "side": f"Exact side profile view of the pair at hip height. {FRAMING}",
            "diag": f"Three-quarter view at hip height. {FRAMING}",
            "back": f"View from behind the kneeling woman, her back toward the camera, the man facing the camera. {FRAMING}",
        },
    ),
    PoseSpec(
        slug="oral_between_knees",
        title="Kneeling between the knees of a man sitting on the edge of a bed",
        position="kneeling between legs",
        series="duo",
        roles={"a": "the woman", "b": "the man"},
        acts=("blowjob",),
        extra=(
            "He sits upright on the edge of a low bed, both feet flat on the floor, his knees wide apart, his hands resting on the "
            "bed beside his hips. She kneels upright on both knees on the floor between his knees, facing him, her face at his "
            "lap, her hands on his thighs."
        ),
        furniture="He sits on a plain low rectangular bed block of the same matte grey material, about knee height.",
        camera={
            "front": "Frontal full-body view at eye level, the camera facing the man's front and the bed edge, the kneeling woman "
            f"between his knees with her back toward the camera, slightly off-centre so that her face at his lap is visible. {FRAMING}",
            "low": "Worm's-eye low-angle view: the camera lies on the floor a few steps in front of the bed, pointing up at the "
            f"pair, the underside of the man's chin visible, strong upward perspective. {FRAMING}",
            "high": f"High-angle view from above and in front, looking down at the pair. {FRAMING}",
            "side": f"Exact side profile view of the pair and the bed edge at seated eye level. {FRAMING}",
            "diag": f"Three-quarter view at seated eye level. {FRAMING}",
            "back": f"View from the woman's front side: the woman faces the camera, the man's back beyond her. {FRAMING}",
        },
    ),
    PoseSpec(
        # Usable only for the moment BEFORE contact: video-harness S1 refuses single-person references on contact shots.
        slug="solo_kneeling_oral",
        title="Kneeling, leaning slightly forward, head at lap height, mouth open, hands forward",
        position="kneeling",
        series="full_body_sexy",
        roles={"a": "the woman"},
        acts=("blowjob",),
        extra=(
            "She kneels upright on both knees on the floor, then leans her upper body slightly forward from the hips, her head at the "
            "height of a seated person's lap in front of her, her mouth open, looking straight ahead. Both arms reach forward, "
            "both hands held forward at waist height as if resting on the thighs of an unseen seated person in front of her."
        ),
        furniture="",
        camera={
            "front": f"Frontal full-body view at the height of her head, the camera directly in front of her, facing her. {SOLO_FRAMING}",
            # Camera words only: "as a lying person sees her" drew that person into the picture (2026-11-10).
            "low": "Worm's-eye low-angle view: the camera lies on the floor in front of her knees, pointing steeply up at her, "
            f"the underside of her chin visible, strong upward perspective, nobody else in the picture. {SOLO_FRAMING}",
            "high": f"High-angle view from above and in front, as a seated person in front of her looks down at her face. {SOLO_FRAMING}",
            "side": f"Exact side profile view at the height of her head. {SOLO_FRAMING}",
            "diag": f"Three-quarter view at the height of her head. {SOLO_FRAMING}",
            "back": f"View from directly behind her, her back toward the camera. {SOLO_FRAMING}",
        },
    ),
)
POSE_BY_SLUG = {p.slug: p for p in POSES}

# Camera turns (qwen_image_camera_turn, LoRA grammar '<sks> <azimuth> <elevation> <distance>') from the base view.
# Keys are REQUEST names; label each result by what the camera actually sees (README step 6).
TURNS: dict[str, str] = {
    "side": "<sks> right side view eye-level shot wide shot",
    "side_left": "<sks> left side view eye-level shot wide shot",
    "diag_left": "<sks> front-left quarter view eye-level shot wide shot",
    "diag": "<sks> front-right quarter view eye-level shot wide shot",
    "back": "<sks> back view eye-level shot wide shot",
    "high": "<sks> front view high-angle shot wide shot",
    "low": "<sks> front view low-angle shot wide shot",
}
