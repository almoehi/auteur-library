from __future__ import annotations

from typing import Any

import pytest

from refsrag import mine_lexicon as ml


@pytest.fixture(autouse=True)
def _all_in(monkeypatch: pytest.MonkeyPatch) -> None:
    # Pin the split: ids starting with "h" are held out, everything else is mined.
    monkeypatch.setattr(ml, "split_of", lambda clip_id: "heldout" if clip_id.startswith("h") else "mine")


def _clip(cid: str, cats: list[str], title: str, desc: str = "", **kw: Any) -> dict[str, Any]:
    return {"clip_id": cid, "categories": cats, "title": title, "description": desc, "keywords": [], **kw}


def _corpus() -> list[dict[str, Any]]:
    feet = [
        _clip(f"m{i}", ["Foot Fetish"], f"Pretty soles tease {i}", "wrinkled soles and toes")
        for i in range(20)
    ]
    other = [_clip(f"o{i}", ["JOI"], f"Stroke countdown {i}", "edge for me") for i in range(40)]
    return feet + other


def test_candidates_rank_concept_specific_ngrams_first() -> None:
    cands = ml.alias_candidates({"foot_fetish": ["Foot Fetish"]}, _corpus(), top_k=10)["foot_fetish"]
    aliases = [c.alias for c in cands]
    assert {"soles", "toes", "wrinkled soles"} <= set(aliases)
    assert not {"stroke", "countdown"} & set(aliases)  # the other concept's words score below
    assert all(c.concept_docs >= ml.MIN_CONCEPT_DOCS for c in cands)
    assert "and" not in aliases  # stopwords never stand alone


def test_build_lexicon_adds_category_names_and_drops_age_codes() -> None:
    lex = ml.build_lexicon(
        {"joi_tease": ["Jerk Off Instruction-JOI"]}, {"joi_tease": {"countdown": 0.8, "teen joi": 1.0}}
    )
    assert lex["jerk off instruction"] == {"joi_tease": 1.0}
    assert lex["joi"] == {"joi_tease": 1.0}
    assert lex["countdown"] == {"joi_tease": 0.8}
    assert "teen joi" not in lex


def test_validate_scores_heldout_clips_from_title_and_description_only() -> None:
    clips = [
        _clip("h1", ["Foot Fetish"], "Soles for you"),
        _clip("h2", ["Foot Fetish"], "Just a tease", keywords=["soles"]),  # keywords are ignored
        _clip("h3", ["JOI"], "My soles, your countdown"),
        _clip("m1", ["Foot Fetish"], "Soles"),  # mined split: not scored
    ]
    report = ml.validate({"soles": {"foot_fetish": 1.0}}, {"foot_fetish": ["Foot Fetish"]}, clips)
    s = report.per_concept["foot_fetish"]
    assert (report.clips, s.support, s.predicted, s.hits) == (3, 2, 2, 1)
    assert (s.precision, s.recall) == (0.5, 0.5)


def test_category_pool_excludes_age_coded_and_orders_by_videos() -> None:
    cats = [
        {"name": "Foot Fetish", "video_count": 10, "description": "feet"},
        {"name": "18-19 Years Old", "video_count": 99, "description": "x"},
        {"name": "JOI", "video_count": 20, "description": "joi"},
    ]
    pool = ml.category_pool(cats, _corpus())
    assert [c.name for c in pool] == ["JOI", "Foot Fetish"]
    assert pool[1].sample_titles


def test_rounds_are_merged_not_replaced() -> None:
    merged = ml.merge_selections(
        {
            "cosplay#r1": {"costume": 1.0, "anime": 0.5},
            "cosplay#r2": {"anime": 0.8, "miko": 0.7},
            "boots": {"boots": 1.0},
        }
    )
    assert merged == {"cosplay": {"costume": 1.0, "anime": 0.8, "miko": 0.7}, "boots": {"boots": 1.0}}


def test_category_names_belong_only_to_their_concepts() -> None:
    lex = ml.build_lexicon(
        {"ass_worship": ["Ass Worship"], "goddess": ["Goddess Worship"]},
        {"goddess": {"ass worship": 1.0, "divine": 0.8}, "ass_worship": {"booty": 0.9}},
    )
    assert lex["ass worship"] == {"ass_worship": 1.0}
    assert lex["divine"] == {"goddess": 0.8}


def test_category_parts_skip_stopwords() -> None:
    assert ml.category_alias_parts("Jerk Off Instruction-JOI") == [
        "Jerk Off Instruction-JOI",
        "Jerk Off Instruction",
        "JOI",
    ]
    assert "On" not in ml.category_alias_parts("Strap-On")


def test_common_words_by_document_share() -> None:
    clips = [_clip(f"m{i}", [], "back again", "and her feet" if i < 2 else "") for i in range(10)]
    assert ml.common_words(clips, share=0.5) == {"back", "again"}
    assert "feet" in ml.common_words(clips, share=0.1)
