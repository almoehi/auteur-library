"""Text helpers shared across modules."""

from __future__ import annotations

import re

# Hiragana, katakana, CJK ideographs, full-width forms: our text is English only.
NON_ENGLISH = re.compile(r"[　-ヿ㐀-䶿一-鿿＀-￯]")


def is_english(s: str) -> bool:
    return NON_ENGLISH.search(s) is None


# Categories or text that code a person's age as young ("18-19 Years Old", "teen", "barely legal").
# Such clips never enter the eval set and such categories never become lexicon concepts. The adult
# roleplay looks ("Schoolgirl Fantasy 18+", college) are not age codes and stay.
AGE_CODED = re.compile(
    r"\b1[0-9]\s*-\s*1[0-9]\b"  # "18-19"
    r"|\b1[0-7][\s-]*(?:yo|y/o|years?)\b"  # "17 years", "16-year-old"
    r"|\bteen\w*"  # teen, teens, teenage, teenager
    r"|\bbarely (?:18|legal)\b|\bjust turned 18\b|\bunderage\b|\blolit\w*|\bjailbait\b",
    re.IGNORECASE,
)


def is_age_coded(s: str) -> bool:
    return AGE_CODED.search(s) is not None
