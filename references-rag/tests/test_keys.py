from refsrag import keys


def test_key_layers() -> None:
    ref = keys.asset_ref_key("library/refs", "/outfits/sexy/SXY-0001.png")
    assert ref == "library/refs/assets/outfits/sexy/SXY-0001.png"
    assert keys.s3_key("public", ref) == "public/library/refs/assets/outfits/sexy/SXY-0001.png"
    assert (
        keys.url("https://cdn.test/public", ref)
        == "https://cdn.test/public/library/refs/assets/outfits/sexy/SXY-0001.png"
    )
    assert keys.rag_ref_key("library/refs/", "v2", "index.json") == "library/refs/rag/v2/index.json"
    assert keys.latest_ref_key("library/refs/") == "library/refs/rag/latest.json"


def test_asset_s3_key_composes_both_layers() -> None:
    assert (
        keys.asset_s3_key("public", "library/refs", "/outfits/sexy/SXY-0001.png")
        == "public/library/refs/assets/outfits/sexy/SXY-0001.png"
    )
