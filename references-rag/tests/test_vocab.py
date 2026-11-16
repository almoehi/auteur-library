"""The SexPosition vocabulary stays aligned with the server pose catalog (jobs/relabel_v5/pose_catalog.json)."""

import json

from refsrag.settings import PROJECT_ROOT
from refsrag.vocab import SEX_POSITIONS

# "both" catalog entries that are not sexual positions: they carry no sex position label.
NON_SEXUAL_BOTH = {"prone massage"}


def _two_person_entries() -> list[dict[str, str]]:
    path = PROJECT_ROOT / "jobs/relabel_v5/pose_catalog.json"
    return [e for e in json.loads(path.read_text())["entries"] if e["people"] == 2]


def test_every_sex_position_is_a_catalog_entry() -> None:
    names = {e["name"] for e in _two_person_entries()}
    assert set(SEX_POSITIONS) <= names


def test_every_sexual_two_person_catalog_entry_is_a_sex_position() -> None:
    sexual = {e["name"] for e in _two_person_entries() if e["content"] != "sfw"} - NON_SEXUAL_BOTH
    assert sexual <= set(SEX_POSITIONS)
