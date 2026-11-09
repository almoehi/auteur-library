"""Offline tests: the split, the text cleaning and the age filter run on synthetic data, no lake."""

from __future__ import annotations

from refsrag.lake import clean_text, split_of
from refsrag.text import is_age_coded, is_english


def test_split_is_deterministic_and_about_20_percent() -> None:
    ids = [f"clip-{i}" for i in range(10_000)]
    first = [split_of(i) for i in ids]
    assert first == [split_of(i) for i in ids]
    assert 0.18 < first.count("heldout") / len(ids) < 0.22


def test_text_helpers() -> None:
    assert clean_text("<p>Spit &amp;  Jeans</p>\n<br>x") == "Spit & Jeans x"
    assert is_english("hello") and not is_english("こんにちは")


def test_age_codes() -> None:
    coded = [
        "18-19 Years Old",
        "Teen",
        "barely legal babe",
        "she is 17 years old",
        "teenage girl",
        "teenager",
        "16-year-old",
        "just turned 18",
        "barely 18",
        "lolita",
        "jailbait",
    ]
    clean = ["Schoolgirl Fantasy 18+", "College Girl", "18+ only", "Top 10 feet", "10 minutes", "19 inch"]
    assert all(map(is_age_coded, coded))
    assert not any(map(is_age_coded, clean))
