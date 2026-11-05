"""Git preservation and reviewed salvage without candidate hooks or filters.

Only server-configured local repositories are accepted. Candidate source is read
from immutable Git blobs into content-addressed snapshots. This adapter does not
claim to sandbox code or authorize promotion; the response service owns admission.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import uuid

from app.modules.response.adapters.process import run_bounded
from app.modules.response.artifacts import ArtifactStore
from app.modules.response.repository import Conflict, Forbidden, Unavailable


class GitQuarantineAdapter:
    def __init__(self, repository: str | Path, worktree_root: str | Path, artifacts: ArtifactStore,
                 *, trusted_ref: str = "refs/heads/main"):
        self.repository = Path(repository).resolve(strict=True)
        configured = Path(worktree_root).absolute()
        if configured.is_symlink():
            raise ValueError("worktree root cannot be a symlink")
        self.root = configured.resolve()
        if self.repository == self.root or self.repository.is_relative_to(self.root):
            raise ValueError("worktree root cannot contain the trusted repository")
        self.root.mkdir(parents=True, exist_ok=True)
        self.control = self.root / "_control"
        self.control.mkdir(exist_ok=True)
        self.hooks = self.control / "empty-hooks"
        self.hooks.mkdir(exist_ok=True)
        self.attributes = self.control / "empty-attributes"
        self.attributes.write_bytes(b"")
        self.artifacts, self.trusted_ref = artifacts, self._ref(trusted_ref)
        self.git = shutil.which("git")
        if not self.git:
            raise Unavailable("Git executable unavailable")
        top = Path(self._git("rev-parse", "--show-toplevel").decode().strip()).resolve()
        if top != self.repository:
            raise Forbidden("configured path is not the trusted repository root")
        self.hash_size = 64 if self._git("rev-parse", "--show-object-format").strip() == b"sha256" else 40
        self.common = Path(self._git('rev-parse', '--path-format=absolute', '--git-common-dir').decode().strip()).resolve()

    @staticmethod
    def _ref(value):
        if (not re.fullmatch(r"refs/heads/[A-Za-z0-9_./-]+", value) or ".." in value or
                value.endswith(("/", ".", ".lock")) or "//" in value):
            raise ValueError("invalid managed Git ref")
        return value

    @staticmethod
    def _incident(value):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
            raise ValueError("invalid quarantine identifier")
        return value

    def _environment(self, extra=None):
        env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "TEMP", "TMP") if k in os.environ}
        env.update({"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
                    "GIT_TERMINAL_PROMPT": "0", "GIT_NO_REPLACE_OBJECTS": "1"})
        env.update(extra or {})
        return env

    def _git(self, *arguments, data=None, extra_env=None, accepted=(0,), cwd=None):
        location = ['-C', str(self.repository)]
        if cwd is not None:
            worktree = Path(cwd).resolve()
            marker = worktree / '.git'
            if worktree.parent != self.root or marker.is_symlink() or not marker.is_file() or marker.stat().st_size > 4096:
                raise Forbidden('managed Git worktree metadata is unavailable')
            content = marker.read_text(encoding='utf-8').strip()
            if not content.startswith('gitdir: '):
                raise Forbidden('managed Git worktree metadata is invalid')
            metadata = Path(content.removeprefix('gitdir: '))
            metadata = worktree / metadata if not metadata.is_absolute() else metadata
            if metadata.is_symlink():
                raise Forbidden('managed Git metadata cannot be a link')
            metadata = metadata.resolve()
            if metadata.parent != (self.common / 'worktrees').resolve():
                raise Forbidden('managed Git metadata points outside the configured repository')
            backlink = metadata / 'gitdir'
            if (backlink.is_symlink() or not backlink.is_file() or backlink.stat().st_size > 4096
                    or Path(backlink.read_text(encoding='utf-8').strip()).resolve() != marker.resolve()):
                raise Forbidden('managed Git metadata does not belong to this worktree')
            # These operations only inspect HEAD or populate the private index.
            # Bare mode avoids Git's internal chdir to a long Windows worktree;
            # candidate bytes are materialized independently from verified blobs.
            if arguments[:1] not in {('read-tree',), ('rev-parse',)}:
                raise Forbidden('unsupported managed worktree metadata operation')
            location = ['--git-dir=' + str(metadata), '--bare']
        result = run_bounded([self.git, "-c", f"core.hooksPath={self.hooks}", "-c", "core.fsmonitor=false",
            '-c', 'core.longpaths=true',
            "-c", f"core.attributesFile={self.attributes}", "-c", "core.quotePath=true",
            *location, *arguments],
            # Windows CreateProcess rejects a long cwd even when Git itself can
            # handle the path. Let the bounded Git process perform its own -C.
            cwd=self.repository.anchor, env=self._environment(extra_env), data=data)
        if result.code not in accepted:
            raise Conflict("managed Git operation failed; inspect restricted operational evidence")
        return result.stdout

    def commit(self, sha: str) -> str:
        if not re.fullmatch(r"[a-f0-9]{" + str(self.hash_size) + r"}", sha):
            raise ValueError("exact full commit SHA required")
        if self._git("cat-file", "-t", sha).strip() != b"commit":
            raise ValueError("object is not a commit")
        return sha

    def target(self) -> str:
        return self._git("rev-parse", "--verify", self.trusted_ref).decode().strip()

    def snapshot(self, sha: str) -> dict:
        sha = self.commit(sha)
        tree = self._git("ls-tree", "-r", "-z", "--full-tree", sha)
        files, modes, total = {}, {}, 0
        for entry in tree.split(b"\0"):
            if not entry:
                continue
            if len(files) >= self.artifacts.max_files:
                raise ValueError("candidate file count exceeds snapshot budget")
            metadata, raw_name = entry.split(b"\t", 1)
            mode, kind, oid = metadata.split(b" ")
            if mode not in {b"100644", b"100755"} or kind != b"blob":
                raise Forbidden("symlinks and submodules require unsupported materialization; candidate held")
            name = raw_name.decode("utf-8", errors="strict")
            self.artifacts.validate_path(name)
            object_id = oid.decode("ascii")
            if not re.fullmatch(r"[a-f0-9]{" + str(self.hash_size) + "}", object_id):
                raise Conflict("invalid Git blob identity")
            size = int(self._git("cat-file", "-s", object_id).strip())
            total += size
            if size > self.artifacts.max_file_bytes or total > self.artifacts.max_bytes:
                raise ValueError("candidate blob size exceeds snapshot budget")
            content = self._git("cat-file", "blob", object_id)
            if len(content) != size:
                raise Conflict("Git blob materialization size changed")
            if content.startswith(b"version https://git-lfs.github.com/spec/v1"):
                raise Forbidden("LFS input is unresolved; candidate held")
            files[name] = content
            modes[name] = mode.decode("ascii")
        return self.artifacts.capture(files, file_modes=modes)

    def _preserve_ref(self, ref, commit):
        ref = self._ref(ref)
        existing = self._git("rev-parse", "--verify", ref, accepted=(0, 128)).decode().strip()
        if existing:
            if existing != commit:
                raise Conflict("quarantine/salvage ref already has another identity")
            return
        self._git("update-ref", ref, commit, "0" * self.hash_size)

    def _path(self, name):
        path = self.root / name
        if path.is_symlink() or path.resolve().parent != self.root:
            raise Forbidden("managed worktree path escapes configured root")
        return path

    def create(self, incident_id: str, base_sha: str, candidate_sha: str) -> dict:
        incident_id = self._incident(incident_id)
        base, candidate = self.commit(base_sha), self.commit(candidate_sha)
        self._git("merge-base", "--is-ancestor", base, self.target())
        self._git("merge-base", "--is-ancestor", base, candidate)
        snapshot = self.snapshot(candidate)
        ref = f"refs/heads/quarantine/{incident_id}"
        self._preserve_ref(ref, candidate)
        path = self._path("quarantine-" + incident_id)
        if not path.exists():
            # No checkout means no smudge filters; files are copied from exact
            # verified blobs, never from an untrusted mutable working directory.
            self._git("worktree", "add", "--no-checkout", str(path), ref.removeprefix("refs/heads/"))
            self._git("read-tree", candidate, cwd=path)
            for name, content in self.artifacts.read(snapshot["artifact_id"]).items():
                target = path / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
        else:
            self._verify_worktree(path, candidate, snapshot["artifact_id"])
        return {"incident_id": incident_id, "base_commit": base, "candidate_commit": candidate,
                "branch_ref": ref, "artifact_id": snapshot["artifact_id"], "manifest": snapshot["manifest"],
                "worktree": path.name, "trust_state": "quarantined"}

    def _verify_worktree(self, path, candidate, artifact_id):
        if self._git("rev-parse", "HEAD", cwd=path).decode().strip() != candidate:
            raise Conflict("managed worktree identity changed")
        expected = self.artifacts.read(artifact_id)
        seen, examined = set(), 0
        for folder, directories, files in os.walk(path, followlinks=False):
            examined += len(directories) + len(files)
            if examined > self.artifacts.max_files * 17 + 1:
                raise Conflict("managed worktree exceeds its directory budget")
            for name in directories:
                if (Path(folder) / name).is_symlink():
                    raise Conflict("managed worktree contains an unreviewed link")
            for name in files:
                relative = (Path(folder) / name).relative_to(path).as_posix()
                if relative != ".git":
                    seen.add(relative)
                if len(seen) > self.artifacts.max_files:
                    raise Conflict("managed worktree exceeds its file budget")
        if seen != set(expected):
            raise Conflict("managed worktree contains unreviewed files")
        for name, data in expected.items():
            actual = path / name
            if actual.is_symlink() or not actual.resolve().is_relative_to(path) or actual.stat().st_size != len(data):
                raise Conflict("managed worktree was modified; preserve it for review")
            with actual.open("rb") as stream:
                if stream.read(len(data) + 1) != data:
                    raise Conflict("managed worktree was modified; preserve it for review")

    def diff(self, base_sha: str, candidate_sha: str) -> bytes:
        return self._git("diff", "--no-ext-diff", "--no-textconv", "--binary", self.commit(base_sha), self.commit(candidate_sha), "--")

    def describe(self, base_sha: str, candidate_sha: str) -> dict:
        base, candidate = self.commit(base_sha), self.commit(candidate_sha)
        metadata = self._git("show", "--no-patch", "--format=%an%x00%ae%x00%aI", candidate).decode("utf-8").strip().split("\0")
        if len(metadata) != 3 or any(len(field) > 512 for field in metadata):
            raise Conflict("candidate authorship metadata exceeds its evidence budget")
        changed = self._git("diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", base, candidate, "--")
        paths = [name.decode("utf-8") for name in changed.split(b"\0") if name]
        if len(paths) > self.artifacts.max_files * 2 or any(len(path) > 240 for path in paths):
            raise Conflict("changeset evidence exceeds its path budget")
        return {"author": {"name": metadata[0], "email": metadata[1], "authored_at": metadata[2]},
                "affected_paths": paths, "base_commit": base, "candidate_commit": candidate}

    def salvage(self, incident_id: str, base_sha: str, candidate_sha: str,
                reviewed_files: dict[str, bytes | str], *, deleted_paths: list[str] | None = None,
                reviewed_modes: dict[str, str] | None = None) -> dict:
        """Construct a NEW candidate from human-reviewed file/hunk outcomes.

        No automatic claim that selected code is safe. The new SHA must receive
        its own independent checks and review before any promotion.
        """
        incident_id = self._incident(incident_id)
        base, candidate = self.commit(base_sha), self.commit(candidate_sha)
        changed = {p.decode("utf-8") for p in self._git("diff", "--no-ext-diff", "--no-textconv",
            "--name-only", "-z", base, candidate, "--").split(b"\0") if p}
        selected = {p: value.encode() if isinstance(value, str) else value for p, value in reviewed_files.items()}
        deleted_paths = deleted_paths or []
        if not (set(selected) | set(deleted_paths)) <= changed or set(selected) & set(deleted_paths):
            raise Forbidden("salvage selection must refer to changed candidate paths")
        if selected:
            self.artifacts._manifest(selected, reviewed_modes)  # portable paths, modes and byte budgets
        for name in deleted_paths:
            self.artifacts.validate_path(name)
        index = self.control / ("index-" + uuid.uuid4().hex)
        environment = {"GIT_INDEX_FILE": str(index), "GIT_AUTHOR_NAME": "SwarmGuard Review",
                       "GIT_AUTHOR_EMAIL": "review@swarmguard.invalid", "GIT_COMMITTER_NAME": "SwarmGuard Review",
                       "GIT_COMMITTER_EMAIL": "review@swarmguard.invalid"}
        # Stable metadata makes retries of the same reviewed selection reproducible.
        timestamp = int(self._git("show", "-s", "--format=%ct", base).strip()) + 1
        environment.update({"GIT_AUTHOR_DATE": f"@{timestamp} +0000", "GIT_COMMITTER_DATE": f"@{timestamp} +0000"})
        try:
            self._git("read-tree", base, extra_env=environment)
            for name, content in sorted(selected.items()):
                blob = self._git("hash-object", "-w", "--stdin", "--no-filters", data=content).decode().strip()
                previous = self._git("ls-tree", base, "--", name).split(b" ", 1)[0]
                mode = (reviewed_modes or {}).get(name, "100755" if previous == b"100755" else "100644")
                self._git("update-index", "--add", "--cacheinfo", f"{mode},{blob},{name}", extra_env=environment)
            for name in deleted_paths:
                self._git("update-index", "--force-remove", "--", name, extra_env=environment)
            tree = self._git("write-tree", extra_env=environment).decode().strip()
            commit = self._git("commit-tree", tree, "-p", base, data=f"Reviewed salvage for {incident_id}\n".encode(),
                               extra_env=environment).decode().strip()
            snapshot = self.snapshot(commit)
            ref = f"refs/heads/salvage/{incident_id}"
            self._preserve_ref(ref, commit)
            return {"candidate_commit": commit, "base_commit": base, "source_candidate": candidate,
                    "branch_ref": ref, "artifact_id": snapshot["artifact_id"], "trust_state": "quarantined"}
        finally:
            if index.exists():
                index.unlink()
            lock = Path(str(index) + ".lock")
            if lock.exists():
                lock.unlink()

    def promote(self, candidate_sha: str, expected_target: str, expected_artifact: str) -> dict:
        """Conditional local effect; service must already reserve exact-action approval."""
        candidate, target = self.commit(candidate_sha), self.commit(expected_target)
        if self.target() != target:
            raise Conflict("trusted target advanced; rebuild and revalidate the combined result")
        self._git("merge-base", "--is-ancestor", target, candidate)
        if self.snapshot(candidate)["artifact_id"] != expected_artifact:
            raise Conflict("candidate does not match the approved artifact")
        worktrees = self._git("worktree", "list", "--porcelain").decode()
        if f"branch {self.trusted_ref}\n" in worktrees:
            raise Conflict("promotion cannot leave a checked-out trusted worktree inconsistent")
        self._git("update-ref", self.trusted_ref, candidate, target)
        if self.target() != candidate:
            raise Conflict("promotion readback requires reconciliation")
        return {"previous_commit": target, "candidate_commit": candidate, "artifact_id": expected_artifact,
                "verified": True, "scope": "local_git_ref"}

    def remove_worktree(self, incident_id: str) -> None:
        path = self._path("quarantine-" + self._incident(incident_id))
        if path.exists():
            listing = self._git("worktree", "list", "--porcelain").decode()
            if f"worktree {path.as_posix()}\n" not in listing.replace("\\", "/"):
                raise Forbidden("path is not a registered managed worktree")
            # Only this checked, configured child may be recursively removed by Git.
            self._git("worktree", "remove", "--force", str(path))
