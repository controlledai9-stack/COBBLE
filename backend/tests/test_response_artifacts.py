import json

import pytest

from app.modules.response.artifacts import ArtifactStore
from app.modules.response.repository import Conflict


def test_snapshot_is_reproducible_and_includes_tests_and_manifest(tmp_path):
    store = ArtifactStore(tmp_path / "artifacts")
    files = {"solution.py": b"print('safe')\r\n", "tests/test_solution.py": b"assert True\n"}
    one = store.capture(files)
    assert store.capture(dict(reversed(list(files.items())))) == one
    assert store.read(one["artifact_id"]) == files
    assert store.capture({**files, "solution.py": b"print('safe')\n"})["artifact_id"] != one["artifact_id"]
    assert list(store.staging.iterdir()) == []


@pytest.mark.parametrize("path", ["../escape", "/root", "C:/file", "a/../file", "a//file", "a/./file",
    ".git/config", "repo/.GIT/config", "CON.txt", "a/NUL", "name.", "a\\file", "a:b", "a\x00b"])
def test_unsafe_and_platform_aliased_paths_are_rejected(tmp_path, path):
    store = ArtifactStore(tmp_path / "artifacts")
    with pytest.raises(ValueError):
        store.capture({path: "data"})
    assert list(store.objects.iterdir()) == []


def test_case_aliases_and_size_budgets(tmp_path):
    store = ArtifactStore(tmp_path, max_files=2, max_bytes=6, max_file_bytes=4)
    for files in ({"a.py": "x", "A.py": "y"}, {"a": "12345"}, {"a": "1234", "b": "1234"},
                  {"a": "", "b": "", "c": ""}, {"a": "x", "a/b": "y"}):
        with pytest.raises(ValueError):
            store.capture(files)


def test_modified_snapshot_cannot_be_used_or_replaced_silently(tmp_path):
    store = ArtifactStore(tmp_path)
    artifact = store.capture({"solution.py": "safe"})["artifact_id"]
    (store.objects / artifact / "files" / "solution.py").write_text("changed", encoding="utf-8")
    with pytest.raises(Conflict, match="bytes"):
        store.read(artifact)
    with pytest.raises(Conflict):
        store.capture({"solution.py": "safe"})


def test_added_file_and_manifest_tamper_are_rejected(tmp_path):
    store = ArtifactStore(tmp_path)
    artifact = store.capture({"a": "safe"})["artifact_id"]
    (store.objects / artifact / "files" / "hidden").write_text("surprise")
    with pytest.raises(Conflict):
        store.read(artifact)
    other = store.capture({"b": "safe"})["artifact_id"]
    (store.objects / other / "manifest.json").write_text(json.dumps({"version": 999}))
    with pytest.raises(Conflict, match="identity"):
        store.read(other)


def test_no_arbitrary_artifact_path_or_git_metadata(tmp_path):
    store = ArtifactStore(tmp_path)
    for value in ("../other", "/some/host/path", "sha256-" + "f" * 63):
        with pytest.raises(ValueError):
            store.read(value)


def test_read_returns_frozen_bytes_not_live_worktree_reference(tmp_path):
    store = ArtifactStore(tmp_path / "store")
    worktree = tmp_path / "worktree.py"
    worktree.write_bytes(b"original")
    artifact = store.capture({"solution.py": worktree.read_bytes()})["artifact_id"]
    frozen = store.read(artifact)
    worktree.write_bytes(b"malicious replacement")
    assert frozen["solution.py"] == b"original"
    assert store.read(artifact) == frozen
