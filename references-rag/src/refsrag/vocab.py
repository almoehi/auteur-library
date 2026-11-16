"""Fixed controlled vocabularies of the vision labels, as types.

Kink / scenario concepts are NOT here: they are mined from the content lake into vocab.yaml and
lexicon.json (mine_lexicon.py), so they can change without touching code or re-reading images.
Sex positions and acts are the exact names of auteur-library ``skills/explicit-acts/SKILL.md``.
``SexPosition`` mirrors the two-person nsfw entries of the server pose catalog
(jobs/relabel_v5/pose_catalog.json) plus the two-person "both" entries that are sexual positions (spooning,
lying on top). The SFW and the non-sexual "both" poses (lying side by side facing, head in lap, prone
massage) carry no sex position: they are found through their text, support and mood, and mapped to their
catalog entry by ``pose_gen/catalog_position_map.json``. Solo catalog entries are not labels
(``sex_positions`` is duo only).
"""

from __future__ import annotations

from typing import Final, Literal, get_args

OutfitArchetype = Literal[
    "schoolgirl_adjacent", "office_secretary", "nurse_like", "maid_like", "cosplay_like",
    "girl_next_door", "date_night", "boudoir", "bridal", "fetishwear", "dominatrix", "athleisure",
    "beach", "party_club", "cozy_home", "casual_street", "elegant_evening",
]  # fmt: skip
OutfitBodyPart = Literal["legs", "feet", "chest", "butt", "waist", "back", "thighs", "arms"]
Footwear = Literal[
    "heels", "stockings", "pantyhose", "socks", "sandals", "sneakers", "boots", "flats", "none",
]  # fmt: skip
Season = Literal["spring", "summer", "autumn", "winter", "any"]

PoseSupport = Literal[
    "standing", "sitting", "kneeling", "all_fours", "lying_back", "lying_front", "lying_side",
    "squatting", "bridge", "bent_over",
]  # fmt: skip
FocusPart = Literal[
    "feet_soles", "feet", "legs", "thighs", "butt", "crotch", "chest", "back", "armpits", "face",
    "hands", "belly",
]  # fmt: skip
Mood = Literal["cute", "playful", "seductive", "submissive", "dominant", "explicit", "relaxed"]

SexPosition = Literal[
    "missionary", "legs on shoulders", "prone bone", "spooning", "lying on back", "lying on side", "69",
    "doggy style", "kneeling upright from behind", "kneeling", "kneeling between legs", "cowgirl",
    "reverse cowgirl", "squatting", "face sitting", "lotus", "lap sitting", "chair facing",
    "reverse chair", "scissoring", "standing face to face", "standing carry", "against the wall",
    "standing one leg raised", "edge of surface", "bent over surface", "standing from behind",
    "against the wall from behind", "kneeling behind bent over", "standing over seated", "lying on top",
]  # fmt: skip
SexAct = Literal[
    "vaginal penetration", "anal penetration", "double penetration", "blowjob", "deepthroat",
    "cunnilingus", "69", "rimming", "handjob", "fingering", "titjob", "footjob", "masturbation",
]  # fmt: skip

OUTFIT_ARCHETYPES: Final = get_args(OutfitArchetype)
OUTFIT_BODY_PARTS: Final = get_args(OutfitBodyPart)
FOOTWEAR: Final = get_args(Footwear)
SEASONS: Final = get_args(Season)
POSE_SUPPORTS: Final = get_args(PoseSupport)
FOCUS_PARTS: Final = get_args(FocusPart)
MOODS: Final = get_args(Mood)
SEX_POSITIONS: Final = get_args(SexPosition)
SEX_ACTS: Final = get_args(SexAct)
