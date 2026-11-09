"""Settings precedence: init kwargs > env > .env > config.yaml."""

from __future__ import annotations

from pathlib import Path

import pytest

from refsrag.settings import CATALOG_FILE, Settings, load_catalog

YAML = "bucket: yaml-bucket\nregion: yaml-region\npublic_prefix: p/\nbase_url: https://yaml.test/\n"


@pytest.fixture
def files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A tmp project dir with config.yaml; the yaml path is resolved from model_config at call time."""
    (tmp_path / "config.yaml").write_text(YAML)
    monkeypatch.setitem(Settings.model_config, "yaml_file", tmp_path / "config.yaml")
    for name in ("REFS_BUCKET", "REFS_REGION", "REFS_BASE_URL"):
        monkeypatch.delenv(name, raising=False)
    return tmp_path


def _load(root: Path) -> Settings:
    return Settings(_env_file=root / ".env")  # type: ignore[call-arg]


def test_yaml_is_the_default(files: Path) -> None:
    s = _load(files)
    assert (s.bucket, s.region) == ("yaml-bucket", "yaml-region")


def test_dotenv_overrides_yaml(files: Path) -> None:
    (files / ".env").write_text("REFS_BUCKET=dotenv-bucket\nREFS_REGION=dotenv-region\n")
    s = _load(files)
    assert (s.bucket, s.region, s.base_url) == ("dotenv-bucket", "dotenv-region", "https://yaml.test/")


def test_env_overrides_dotenv_and_yaml(files: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    (files / ".env").write_text("REFS_BUCKET=dotenv-bucket\nREFS_REGION=dotenv-region\n")
    monkeypatch.setenv("REFS_BUCKET", "env-bucket")
    s = _load(files)
    assert (s.bucket, s.region) == ("env-bucket", "dotenv-region")


def test_init_kwargs_override_env(files: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("REFS_BUCKET", "env-bucket")
    assert Settings(_env_file=files / ".env", bucket="init-bucket").bucket == "init-bucket"  # type: ignore[call-arg]


def test_the_shipped_catalog_descriptor_is_valid() -> None:
    catalog = load_catalog()
    assert catalog.key == "refs" and list(catalog.kinds) == ["outfit", "pose"]
    assert {f.op for f in catalog.filters} >= {"eq", "lte", "in"}


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ("max_k: 4", "max_k: 0"),  # max_k must be at least 1
        ("media: image", "media: video"),  # not a media type
        ("    op: eq", "    op: lte"),  # lte on a boolean
        ("nudity: true", "nudity: true\nnudtiy: true"),  # a typo is an unknown key
        ("  outfit: [category]", "  face: [category]"),  # result fields of an unknown kind
    ],
)
def test_invalid_catalog_descriptors_are_rejected(tmp_path: Path, change: str, message: str) -> None:
    text = CATALOG_FILE.read_text()
    assert change in text
    (tmp_path / "catalog.yaml").write_text(text.replace(change, message, 1))
    with pytest.raises(ValueError):
        load_catalog(tmp_path / "catalog.yaml")
