"""Content-addressed candidate snapshots. This is preservation, not a sandbox.

Candidates are copied as bytes; mutable worktrees and their .git metadata are
never executable snapshot references. The configured root belongs to the trusted
service. A host administrator remains outside this local store's threat boundary.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid
from pathlib import Path, PurePosixPath

from app.modules.response.repository import Conflict, Missing, digest, canonical


class ArtifactStore:
    def __init__(self, root: str | Path, *, max_files: int = 64, max_bytes: int = 1048576,
                 max_file_bytes: int = 262144):
        configured = Path(root).absolute()
        if configured.is_symlink():
            raise ValueError("artifact root cannot be a symlink")
        configured.mkdir(parents=True, exist_ok=True)
        self.root = configured.resolve()
        self.max_files, self.max_bytes, self.max_file_bytes = max_files, max_bytes, max_file_bytes
        self.staging = self.root / "staging"
        self.objects = self.root / "objects"
        for child in (self.staging, self.objects):
            if child.is_symlink():
                raise ValueError("artifact storage directories cannot be symlinks")
            child.mkdir(exist_ok=True)

    @staticmethod
    def validate_path(name: str) -> str:
        if not isinstance(name, str) or not 1 <= len(name) <= 240 or not re.fullmatch(r"[A-Za-z0-9_./-]+", name):
            raise ValueError("candidate contains an unsupported path")
        path = PurePosixPath(name)
        parts = name.split("/")
        devices = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
        if (path.is_absolute() or str(path) != name or len(parts) > 16 or
                any(p in {"", ".", ".."} or p.endswith(".") or p.casefold() == ".git" or
                    p.split(".")[0].casefold() in devices for p in parts)):
            raise ValueError("candidate path is unsafe or not portable")
        return name

    def _manifest(self, files: dict[str, bytes]) -> dict:
        if not files or len(files) > self.max_files:
            raise ValueError("candidate file count exceeds budget")
        aliases, total, entries = set(), 0, []
        for name, content in sorted(files.items()):
            self.validate_path(name)
            alias = name.casefold()
            if alias in aliases:
                raise ValueError("candidate contains case-aliased paths")
            if any(alias.startswith(old + "/") or old.startswith(alias + "/") for old in aliases):
                raise ValueError("candidate contains conflicting file and directory paths")
            aliases.add(alias)
            if not isinstance(content, bytes) or len(content) > self.max_file_bytes:
                raise ValueError("candidate file exceeds size budget")
            total += len(content)
            if total > self.max_bytes:
                raise ValueError("candidate expanded size exceeds budget")
            entries.append({"path": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()})
        return {"version": 1, "files": entries, "total_bytes": total}

    def capture(self, files: dict[str, bytes | str]) -> dict:
        raw = {name: value.encode("utf-8") if isinstance(value, str) else value for name, value in files.items()}
        manifest = self._manifest(raw)
        artifact_id = "sha256-" + digest(manifest)
        final = self._object(artifact_id)
        if final.exists():
            if self.read(artifact_id) != raw:
                raise Conflict("existing artifact snapshot differs from its identity")
            return {"artifact_id": artifact_id, "manifest": manifest}
        stage = self.staging / uuid.uuid4().hex
        stage.mkdir()
        try:
            source = stage / "files"
            source.mkdir()
            for name, content in raw.items():
                target = source / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as stream:
                    stream.write(content)
                    stream.flush()
                    os.fsync(stream.fileno())
            with (stage / "manifest.json").open("x", encoding="utf-8") as stream:
                stream.write(canonical(manifest))
                stream.flush()
                os.fsync(stream.fileno())
            try:
                stage.rename(final)
            except OSError:
                if not final.exists() or self.read(artifact_id) != raw:
                    raise
            return {"artifact_id": artifact_id, "manifest": manifest}
        finally:
            if stage.exists():
                self._remove_stage(stage)

    def _object(self, artifact_id: str) -> Path:
        if not re.fullmatch(r"sha256-[a-f0-9]{64}", artifact_id):
            raise ValueError("invalid artifact identity")
        result = self.objects / artifact_id
        if result.is_symlink() or result.resolve().parent != self.objects.resolve():
            raise ValueError("artifact path escapes configured storage")
        return result

    def read(self, artifact_id: str) -> dict[str, bytes]:
        """Return the exact verified bytes, not a mutable path to run later."""
        folder = self._object(artifact_id)
        if not folder.is_dir():
            raise Missing("artifact not found")
        manifest_path, source = folder / "manifest.json", folder / "files"
        if manifest_path.is_symlink() or source.is_symlink() or not source.is_dir():
            raise Conflict("artifact layout has been changed")
        if not manifest_path.is_file() or manifest_path.stat().st_size > 65536:
            raise Conflict("artifact manifest is missing or exceeds budget")
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            if digest(manifest) != artifact_id.removeprefix("sha256-"):
                raise Conflict("artifact manifest identity mismatch")
            content = {}
            total = 0
            # Bound expansion without recursively following links. Directory count
            # is bounded too, since empty directories otherwise evade file quotas.
            pending, examined = [source], 0
            while pending:
                parent = pending.pop()
                for path in parent.iterdir():
                    examined += 1
                    if examined > self.max_files * 17:
                        raise Conflict("artifact directory count exceeds budget")
                    if path.is_symlink() or path.resolve().is_relative_to(source.resolve()) is False:
                        raise Conflict("artifact contains a link or path escape")
                    name = path.relative_to(source).as_posix()
                    self.validate_path(name)
                    if path.is_dir():
                        pending.append(path)
                    elif path.is_file():
                        if len(content) >= self.max_files or path.stat().st_size > self.max_file_bytes:
                            raise Conflict("artifact size exceeds budget")
                        # A bounded read also handles a file growing after stat().
                        with path.open("rb") as stream:
                            data = stream.read(self.max_file_bytes + 1)
                        total += len(data)
                        if len(data) > self.max_file_bytes or total > self.max_bytes:
                            raise Conflict("artifact size exceeds budget")
                        content[name] = data
                    else:
                        raise Conflict("artifact contains a non-regular file")
            if self._manifest(content) != manifest:
                raise Conflict("artifact bytes do not match their reviewed identity")
            return content
        except (ValueError, OSError, TypeError) as exc:
            raise Conflict("artifact cannot be materialized safely") from exc

    def _remove_stage(self, path: Path) -> None:
        # Recursive cleanup is restricted to this service's generated staging dir.
        resolved = path.resolve()
        if path.is_symlink() or resolved.parent != self.staging.resolve() or not re.fullmatch(r"[a-f0-9]{32}", path.name):
            raise ValueError("refusing cleanup outside artifact staging directory")
        shutil.rmtree(resolved)
