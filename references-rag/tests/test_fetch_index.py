"""``query.fetch_index`` against a local HTTP server: sha256 verification, original bytes, safe paths,
atomic install and the lost-race case."""

from __future__ import annotations

import functools
import hashlib
import http.server
import json
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from refsrag import query
from refsrag.query import fetch_index


class _Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


@pytest.fixture
def site(tmp_path: Path) -> Iterator[tuple[Path, str]]:
    """(served directory, its base URL)."""
    root = tmp_path / "site"
    root.mkdir()
    handler = functools.partial(_Quiet, directory=str(root))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield root, f"http://127.0.0.1:{server.server_port}/"
    server.shutdown()
    server.server_close()


def _publish(root: Path, files: list[str], version: str = "v1") -> bytes:
    """Write ``<version>/index.json`` (odd spacing on purpose: it must survive byte for byte) and its
    files, plus latest.json. Returns the index bytes."""
    (root / version).mkdir(parents=True, exist_ok=True)
    raw = json.dumps({"index_version": version, "files": files}, indent=3).encode()
    (root / version / "index.json").write_bytes(raw)
    for rel in files:
        (root / version / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / version / rel).write_bytes(b"data:" + rel.encode())
    latest = {
        "index_version": version,
        "path": f"{version}/index.json",
        "sha256": hashlib.sha256(raw).hexdigest(),
    }
    (root / "latest.json").write_text(json.dumps(latest))
    return raw


def test_downloads_once_with_the_original_index_bytes(site: tuple[Path, str], tmp_path: Path) -> None:
    root, url = site
    raw = _publish(root, ["vectors/a.f32"])
    cache = tmp_path / "cache"
    target = fetch_index(url + "latest.json", cache)
    assert target == cache / "v1"
    assert (target / "index.json").read_bytes() == raw  # not re-serialised
    assert (target / "vectors" / "a.f32").read_bytes() == b"data:vectors/a.f32"
    assert [p.name for p in cache.iterdir()] == ["v1"]  # no temp directory left
    (root / "v1" / "vectors" / "a.f32").unlink()  # a second call must not download again
    assert fetch_index(url + "latest.json", cache) == target


def test_index_url_without_latest_is_not_verified(site: tuple[Path, str], tmp_path: Path) -> None:
    root, url = site
    raw = _publish(root, [])
    (root / "latest.json").unlink()
    assert (fetch_index(url + "v1/index.json", tmp_path / "c") / "index.json").read_bytes() == raw


def test_sha256_mismatch_is_rejected_and_leaves_nothing(site: tuple[Path, str], tmp_path: Path) -> None:
    root, url = site
    _publish(root, [])
    (root / "v1" / "index.json").write_text(json.dumps({"index_version": "v1", "files": []}))  # tampered
    cache = tmp_path / "cache"
    with pytest.raises(ValueError, match="sha256"):
        fetch_index(url + "latest.json", cache)
    assert not cache.exists() or list(cache.iterdir()) == []


@pytest.mark.parametrize("bad", ["../evil.bin", "/etc/passwd", "a/../../b", "\\evil"])
def test_unsafe_file_entries_are_rejected(site: tuple[Path, str], tmp_path: Path, bad: str) -> None:
    root, url = site
    raw = json.dumps({"index_version": "v1", "files": [bad]}).encode()
    (root / "v1").mkdir()
    (root / "v1" / "index.json").write_bytes(raw)
    cache = tmp_path / "cache"
    with pytest.raises(ValueError, match="unsafe"):
        fetch_index(url + "v1/index.json", cache)
    assert not (tmp_path / "evil.bin").exists()
    assert list(cache.iterdir()) == []  # the temp directory was cleaned up


def test_unsafe_version_is_rejected(site: tuple[Path, str], tmp_path: Path) -> None:
    root, url = site
    (root / "v1").mkdir()
    (root / "v1" / "index.json").write_text(json.dumps({"index_version": "../x", "files": []}))
    with pytest.raises(ValueError, match="unsafe"):
        fetch_index(url + "v1/index.json", tmp_path / "cache")


def test_a_target_that_appears_meanwhile_wins(
    site: tuple[Path, str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root, url = site
    _publish(root, ["m.bin"])
    cache = tmp_path / "cache"
    real_get = query._get

    def racing_get(address: str) -> bytes:
        if address.endswith("m.bin"):  # another process finishes the same version while we download
            (cache / "v1").mkdir(parents=True)
            (cache / "v1" / "index.json").write_text("{}")
            (cache / "v1" / "other.bin").write_bytes(b"theirs")
        return real_get(address)

    monkeypatch.setattr(query, "_get", racing_get)
    target = fetch_index(url + "latest.json", cache)
    assert (target / "other.bin").read_bytes() == b"theirs" and not (target / "m.bin").exists()
    assert [p.name for p in cache.iterdir()] == ["v1"]  # our temp copy was discarded
