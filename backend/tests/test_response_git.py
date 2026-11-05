from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from app.modules.response.adapters.git import GitQuarantineAdapter
from app.modules.response.adapters.process import run_bounded
from app.modules.response.artifacts import ArtifactStore
from app.modules.response.repository import Conflict, Forbidden, Unavailable


def git(root, *args, data=None):
    result = subprocess.run([shutil.which("git"), *args], cwd=root, input=data, capture_output=True, check=True)
    return result.stdout.decode().strip()


@pytest.fixture
def repository(tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    git(root, "init", "--initial-branch=main")
    git(root, "config", "user.name", "Test reviewer")
    git(root, "config", "user.email", "reviewer@example.invalid")
    (root / "solution.py").write_bytes(b"def score(xs):\n    return sum(xs)\n")
    (root / "contract.txt").write_text("score(numbers) -> number", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-m", "trusted base")
    base = git(root, "rev-parse", "HEAD")
    git(root, "switch", "-c", "candidate")
    (root / "solution.py").write_bytes(b"def score(xs):\n    return sum(xs) + 1\n\ndef leak():\n    return 'synthetic prohibited transfer'\n")
    git(root, "add", ".")
    git(root, "commit", "-m", "useful change and synthetic malicious addition")
    candidate = git(root, "rev-parse", "HEAD")
    store = ArtifactStore(tmp_path / "artifacts")
    adapter = GitQuarantineAdapter(root, tmp_path / "worktrees", store)
    return root, adapter, base, candidate


def test_real_quarantine_preserves_exact_commit_and_does_not_change_source(repository):
    root, adapter, base, candidate = repository
    before = (root / "solution.py").read_bytes()
    record = adapter.create("inc-one", base, candidate)
    assert record["trust_state"] == "quarantined"
    assert git(root, "rev-parse", record["branch_ref"]) == candidate
    assert (root / "solution.py").read_bytes() == before
    assert (adapter.root / record["worktree"] / "solution.py").read_bytes() == before
    assert adapter.create("inc-one", base, candidate) == record
    assert b"synthetic prohibited" in adapter.diff(base, candidate)


def test_candidate_recovers_after_worktree_removal(repository):
    root, adapter, base, candidate = repository
    record = adapter.create("inc-recover", base, candidate)
    adapter.remove_worktree("inc-recover")
    assert not (adapter.root / record["worktree"]).exists()
    assert git(root, "rev-parse", record["branch_ref"]) == candidate
    assert adapter.artifacts.read(record["artifact_id"])["solution.py"]
    assert adapter.create("inc-recover", base, candidate)["candidate_commit"] == candidate


def test_managed_worktree_supports_long_workspace_paths(repository, tmp_path):
    root, original, base, candidate = repository
    managed = tmp_path / ('workspace-' + 'a' * 64) / 'worktrees' / ('repository-' + 'b' * 64)
    adapter = GitQuarantineAdapter(root, managed, original.artifacts)
    identifier = 'incident-' + 'c' * 32
    assert len(str(managed / ('quarantine-' + identifier) / '.git')) > 260
    record = adapter.create(identifier, base, candidate)
    assert (managed / record['worktree'] / 'solution.py').read_bytes() == (root / 'solution.py').read_bytes()
    assert adapter.create(identifier, base, candidate)['artifact_id'] == record['artifact_id']
    adapter.remove_worktree(identifier)
    assert not (managed / record['worktree']).exists()


def test_worktree_cannot_borrow_another_registered_metadata_directory(repository):
    _, adapter, base, candidate = repository
    first = adapter.create('first', base, candidate)
    second = adapter.create('second', base, candidate)
    marker = adapter.root / first['worktree'] / '.git'
    marker.unlink()  # Windows marks Git's original pointer file hidden.
    marker.write_bytes((adapter.root / second['worktree'] / '.git').read_bytes())
    with pytest.raises(Forbidden, match='does not belong'):
        adapter.create('first', base, candidate)


def test_manual_reviewed_hunks_form_new_candidate_on_trusted_base(repository):
    root, adapter, base, candidate = repository
    reviewed = b"def score(xs):\n    return sum(xs) + 1\n"
    record = adapter.salvage("inc-salvage", base, candidate, {"solution.py": reviewed})
    assert record["candidate_commit"] != candidate
    assert record["trust_state"] == "quarantined"
    assert git(root, "rev-parse", record["candidate_commit"] + "^") == base
    assert adapter.artifacts.read(record["artifact_id"])["solution.py"] == reviewed
    assert git(root, "rev-parse", "main") == base
    assert adapter.salvage("inc-salvage", base, candidate, {"solution.py": reviewed}) == record


def test_promotion_is_bound_to_target_and_materialized_artifact(repository):
    root, adapter, base, candidate = repository
    record = adapter.salvage("inc-publish", base, candidate, {"solution.py": b"def score(xs):\n    return sum(xs) + 1\n"})
    with pytest.raises(Conflict, match="artifact"):
        adapter.promote(record["candidate_commit"], base, "sha256-" + "0" * 64)
    assert git(root, "rev-parse", "main") == base
    result = adapter.promote(record["candidate_commit"], base, record["artifact_id"])
    assert result["verified"] and result["scope"] == "local_git_ref"
    assert git(root, "rev-parse", "main") == record["candidate_commit"]
    with pytest.raises(Conflict, match="advanced"):
        adapter.promote(candidate, base, adapter.snapshot(candidate)["artifact_id"])


def test_checked_out_trusted_target_is_not_changed_inconsistently(repository):
    root, adapter, base, candidate = repository
    record = adapter.snapshot(candidate)
    git(root, "switch", "main")
    with pytest.raises(Conflict, match="checked-out"):
        adapter.promote(candidate, base, record["artifact_id"])
    assert git(root, "rev-parse", "main") == base


def test_hooks_filters_and_external_diff_are_not_executed(repository, tmp_path):
    root, adapter, base, candidate = repository
    marker = tmp_path / "must-not-exist"
    hook = root / ".git" / "hooks" / "post-checkout"
    hook.write_text(f'#!/bin/sh\necho unsafe > "{marker.as_posix()}"\n', encoding="utf-8")
    hook.chmod(0o755)
    (root / ".gitattributes").write_text("*.py filter=trap\n", encoding="utf-8")
    git(root, "add", ".gitattributes")
    git(root, "commit", "-m", "candidate filter attributes")
    candidate = git(root, "rev-parse", "HEAD")
    git(root, "config", "filter.trap.smudge", f'echo unsafe > "{marker.as_posix()}"')
    git(root, "config", "diff.external", f'echo unsafe > "{marker.as_posix()}"')
    adapter.create("inc-hooks", base, candidate)
    adapter.diff(base, candidate)
    assert not marker.exists()


def test_modified_quarantine_worktree_is_held_for_review(repository):
    _, adapter, base, candidate = repository
    record = adapter.create("inc-modified", base, candidate)
    (adapter.root / record["worktree"] / "solution.py").write_text("changed", encoding="utf-8")
    with pytest.raises(Conflict, match="modified"):
        adapter.create("inc-modified", base, candidate)


def test_invalid_ids_refs_and_unrelated_salvage_paths_are_rejected(repository):
    _, adapter, base, candidate = repository
    with pytest.raises(ValueError):
        adapter.create("../escape", base, candidate)
    with pytest.raises(ValueError):
        adapter.snapshot("HEAD; arbitrary command")
    with pytest.raises(Forbidden, match="changed"):
        adapter.salvage("inc-extra", base, candidate, {"unrelated.py": b"not a reviewed candidate change"})


def test_extra_worktree_files_cannot_be_treated_as_reviewed_source(repository):
    _, adapter, base, candidate = repository
    record = adapter.create("inc-extra-file", base, candidate)
    (adapter.root / record["worktree"] / "unreviewed.py").write_text("must not run", encoding="utf-8")
    with pytest.raises(Conflict, match="unreviewed"):
        adapter.create("inc-extra-file", base, candidate)


def test_reviewed_executable_mode_is_retained_in_new_candidate(repository):
    _, adapter, base, candidate = repository
    result = adapter.salvage("inc-mode", base, candidate, {"solution.py": b"print('reviewed')"},
                             reviewed_modes={"solution.py": "100755"})
    manifest = adapter.snapshot(result["candidate_commit"])["manifest"]
    assert next(entry for entry in manifest["files"] if entry["path"] == "solution.py")["mode"] == "100755"


def test_unresolved_lfs_is_held_instead_of_fetching(repository):
    root, adapter, _, _ = repository
    (root / "large.dat").write_text("version https://git-lfs.github.com/spec/v1\noid sha256:123\n", encoding="utf-8")
    git(root, "add", "large.dat")
    git(root, "commit", "-m", "unresolved external material")
    with pytest.raises(Forbidden, match="LFS"):
        adapter.snapshot(git(root, "rev-parse", "HEAD"))


def test_executable_mode_changes_candidate_identity(tmp_path):
    store = ArtifactStore(tmp_path)
    plain = store.capture({"script.py": "print('test')"})
    executable = store.capture({"script.py": "print('test')"}, file_modes={"script.py": "100755"})
    assert plain["artifact_id"] != executable["artifact_id"]
    assert store.read(executable["artifact_id"]) == {"script.py": b"print('test')"}


def test_bounded_process_rejects_output_flood_and_timeout(tmp_path):
    import os
    with pytest.raises(Unavailable, match="budget"):
        run_bounded([sys.executable, "-c", "print('x' * 10000)"], cwd=tmp_path,
                    env=dict(os.environ), max_output=1024)
    with pytest.raises(Unavailable, match="deadline"):
        run_bounded([sys.executable, "-c", "import time; time.sleep(2)"], cwd=tmp_path,
                    env=dict(os.environ), timeout=0.05)
