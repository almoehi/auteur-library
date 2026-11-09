"""Typed records the labelling agent jobs must return. ``jobs.collect`` validates every output with
these models; an invalid batch is re-queued."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from refsrag.catalog import Angle
from refsrag.text import NON_ENGLISH
from refsrag.vocab import (
    FocusPart,
    Footwear,
    Mood,
    OutfitArchetype,
    OutfitBodyPart,
    PoseSupport,
    Season,
    SexAct,
    SexPosition,
)

Weight = Annotated[float, Field(ge=0.0, le=1.0)]


class Record(BaseModel):
    """Base of every job record: strict keys, English-only text."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")  # the cache key: the input the record was made from

    @model_validator(mode="before")
    @classmethod
    def _english_only(cls, data: Any) -> Any:
        if NON_ENGLISH.search(repr(data)):
            raise ValueError("non-English text in a label record")
        return data


class OutfitVision(Record):
    description_en: str = Field(min_length=20)
    garments: list[str] = Field(min_length=1)
    colors: list[str]
    materials: list[str]
    archetypes: dict[OutfitArchetype, Weight]
    exposure: int = Field(ge=0, le=3)  # 0 covered street wear .. 3 lingerie / swimwear
    accentuated: dict[OutfitBodyPart, Weight]
    footwear: Footwear
    season: Season
    confidence: Weight
    notes: str = ""


class PoseViewVision(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    focus: dict[FocusPart, Weight]  # how prominently each body part is presented to this camera
    view: str = Field(min_length=5)  # what the camera actually sees, e.g. "rear view, soles toward camera"


class PoseVision(Record):
    name_en: str = Field(min_length=3)
    description_en: str = Field(min_length=20)
    support: PoseSupport  # duo: the female figure's
    mood: dict[Mood, Weight]
    views: dict[Angle, PoseViewVision]
    sex_positions: list[SexPosition]  # duo only; exact explicit-acts names
    typical_acts: list[SexAct]
    confidence: Weight
    notes: str = ""

    @field_validator("views")
    @classmethod
    def _some_views(cls, v: dict[Angle, PoseViewVision]) -> dict[Angle, PoseViewVision]:
        if not v:
            raise ValueError("a pose needs at least one labelled view")
        return v


class ConceptAffinity(Record):
    """How typically an item is used for each mined concept (keys checked against vocab.yaml)."""

    concepts: dict[str, Weight]


ConceptType = Literal["kink", "roleplay", "act", "garment", "body_focus"]


class ConceptDef(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    name: str = Field(pattern=r"^[a-z][a-z0-9_]{2,40}$")  # snake_case, e.g. foot_fetish
    type: ConceptType
    description: str = Field(min_length=10)
    categories: list[str] = Field(min_length=1)  # member iWantClips category names, verbatim


class ConceptGrouping(Record):
    """Output of ``lexicon_concepts``: the category pool grouped into visual concepts."""

    concepts: list[ConceptDef] = Field(min_length=10)
    dropped: list[str]  # categories with nothing a pose or outfit could show

    @field_validator("concepts")
    @classmethod
    def _unique_names(cls, v: list[ConceptDef]) -> list[ConceptDef]:
        names = [c.name for c in v]
        if len(names) != len(set(names)):
            raise ValueError("duplicate concept names")
        return v


class AliasSelection(Record):
    """Output of ``alias_filter`` for one concept (``id`` = the concept name): kept aliases -> weight."""

    aliases: dict[str, Weight]


class EvalGrades(Record):
    """Output of ``eval_grade`` for one eval context (``id``): pooled item id -> relevance 0..3."""

    grades: dict[str, Annotated[int, Field(ge=0, le=3)]]
