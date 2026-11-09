from __future__ import annotations

from refsrag.index_build import concept_focus, label_concepts, label_lexicon


def test_label_aliases_phrase_and_rare_single_words_only() -> None:
    lex = label_lexicon(
        [
            "label:archetype:office_secretary",
            "label:focus:back",
            "label:position:doggy style",
            "label:footwear:none",
        ],
        common={"back"},
    )
    assert (
        lex["office secretary"]
        == lex["office"]
        == lex["secretary"]
        == {"label:archetype:office_secretary": 0.8}
    )
    assert "back" not in lex  # a common word never stands alone, even as a whole term
    assert "doggy style" in lex and "doggy" not in lex and "style" not in lex  # positions: phrase only
    assert not any("none" in k for k in lex)


def test_label_focus_concepts_present_their_own_part() -> None:
    assert label_concepts(["label:focus:feet_soles"])["label:focus:feet_soles"]["focus"] == {
        "feet_soles": 1.0
    }


def test_concept_focus_is_the_lift_over_the_average_pose() -> None:
    def pose(concepts: dict[str, float], focus: dict[str, float]) -> dict[str, object]:
        return {"kind": "pose", "concepts": concepts, "views": [{"focus": focus}]}

    items = [
        pose({"feet": 1.0}, {"feet_soles": 0.9, "chest": 0.2}),
        pose({"feet": 1.0}, {"feet_soles": 0.8, "chest": 0.3}),
        pose({}, {"chest": 0.9}),
        pose({}, {"chest": 0.8}),
    ]
    focus = concept_focus(items, ["feet", "rare"])
    assert focus["feet"] == {"feet_soles": 1.0}  # chest is below the average pose's, so it is no lift
    assert "rare" not in focus  # no pose serves it
