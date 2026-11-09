"""Settings: non-secret defaults from config.yaml; env / .env (prefix REFS_) override them; secrets
and machine paths come from env / .env only. The catalog descriptor (non-secret data) is catalog.yaml."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import Field, TypeAdapter
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)

from refsrag.descriptor import Catalog

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CATALOG_FILE = PROJECT_ROOT / "catalog.yaml"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_prefix="REFS_",
        extra="ignore",
        yaml_file=PROJECT_ROOT / "config.yaml",
    )

    library_root: Path | None = None
    content_lake_dir: Path | None = None
    bucket: str
    region: str
    public_prefix: str
    base_url: str
    # Read from env / .env explicitly (pydantic-settings does not export .env); None -> boto3's default chain.
    aws_access_key_id: str | None = Field(default=None, validation_alias="AWS_ACCESS_KEY_ID")
    aws_secret_access_key: str | None = Field(default=None, validation_alias="AWS_SECRET_ACCESS_KEY")
    featherless_api_key: str | None = Field(default=None, validation_alias="FEATHERLESS_API_KEY")

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # Priority, highest first: explicit kwargs, env, .env, config.yaml.
        return (init_settings, env_settings, dotenv_settings, YamlConfigSettingsSource(settings_cls))

    def require_library_root(self) -> Path:
        if self.library_root is None or not self.library_root.is_dir():
            raise RuntimeError("REFS_LIBRARY_ROOT is unset or not a directory (see .env.example)")
        return self.library_root

    def require_content_lake_dir(self) -> Path:
        if self.content_lake_dir is None or not (self.content_lake_dir / "pyproject.toml").is_file():
            raise RuntimeError("REFS_CONTENT_LAKE_DIR is unset or not the content lake checkout")
        return self.content_lake_dir


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]  # required fields come from config.yaml


def load_catalog(path: Path = CATALOG_FILE) -> Catalog:
    """The catalog descriptor, validated by pydantic against the ``descriptor`` dataclasses (types,
    literals and their cross-field rules); an unknown key is rejected, as the index readers do."""
    return TypeAdapter(Catalog).validate_python(yaml.safe_load(path.read_text()), extra="forbid")
