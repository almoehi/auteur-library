import pytest

from refsrag import keys


def test_key_layers() -> None:
    ref = keys.asset_ref_key("refs", "/outfits/sexy/SXY-0001.png")
    assert ref == "library/refs/assets/outfits/sexy/SXY-0001.png"
    assert keys.s3_key("public", ref) == "public/library/refs/assets/outfits/sexy/SXY-0001.png"
    assert (
        keys.url("https://cdn.test/public", ref)
        == "https://cdn.test/public/library/refs/assets/outfits/sexy/SXY-0001.png"
    )
    assert keys.rag_ref_key("refs", "v2", "index.json") == "library/refs/rag/v2/index.json"
    assert keys.latest_ref_key("refs") == "library/refs/rag/latest.json"
    assert keys.schema_latest_ref_key("refs", 2) == "library/refs/rag/latest.s2.json"
    assert keys.asset_manifest_ref_key("faces") == "library/faces/assets/manifest.json"


@pytest.mark.parametrize("bad", ["", "Refs", "a/b", "../x", "-x"])
def test_catalog_key_is_one_path_segment(bad: str) -> None:
    with pytest.raises(ValueError, match="path segment"):
        keys.catalog_root(bad)


def test_pointer_names() -> None:
    assert keys.is_pointer("https://x.test/library/refs/rag/latest.json")
    assert keys.is_pointer("https://x.test/library/refs/rag/latest.s2.json")
    assert not keys.is_pointer("https://x.test/library/refs/rag/v4/index.json")
    assert not keys.is_pointer("https://x.test/notlatest.json")


def test_asset_s3_key_composes_both_layers() -> None:
    assert (
        keys.asset_s3_key("public", "refs", "/outfits/sexy/SXY-0001.png")
        == "public/library/refs/assets/outfits/sexy/SXY-0001.png"
    )
