"""Fixed local Linux Docker boundary for bounded JSON component contracts.

No client-supplied commands, mounts, image tags, environment or Docker options.
Only a server-reviewed image ID/digest is accepted; availability never enables
host execution. Docker daemon/host administration remain trusted prerequisites.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import shutil
import uuid

from app.modules.response.adapters.process import run_bounded
from app.modules.response.artifacts import ArtifactStore
from app.modules.response.repository import Conflict, Unavailable, canonical, digest


@dataclass(frozen=True)
class DockerBudget:
    seconds: int = 10
    output_bytes: int = 65536
    memory_mb: int = 128
    pids: int = 32

    def __post_init__(self):
        if not (1 <= self.seconds <= 60 and 1024 <= self.output_bytes <= 262144
                and 64 <= self.memory_mb <= 512 and 8 <= self.pids <= 64):
            raise ValueError("unsupported validator budget")


class DockerJsonExecutor:
    def __init__(self, artifacts: ArtifactStore, staging_root: str | Path, image: str,
                 *, workspace: str, budget: DockerBudget | None = None):
        if not re.fullmatch(r"(?:[a-zA-Z0-9./_-]+@)?sha256:[a-f0-9]{64}", image):
            raise ValueError("validator requires a pinned image digest or immutable local image ID")
        configured = Path(staging_root).absolute()
        if configured.is_symlink() or "," in str(configured):
            raise ValueError("unsafe validator staging root")
        configured.mkdir(parents=True, exist_ok=True)
        self.root = configured.resolve()
        if self.root == artifacts.root or artifacts.root.is_relative_to(self.root):
            raise ValueError("validator staging must not contain the artifact store")
        self.artifacts, self.image = artifacts, image
        self.workspace_label = digest({"workspace": workspace})
        self.budget = budget or DockerBudget()
        self.executable = shutil.which("docker")
        if not self.executable:
            raise Unavailable("Docker executable unavailable; candidate remains held")

    def _docker(self, *args, data=None, timeout=15, max_output=65536):
        # DOCKER_HOST/context may be configured by the trusted operator, never
        # by a candidate. No application secrets are passed to the container.
        env = {k: v for k, v in os.environ.items() if k in {
            "PATH", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOME", "DOCKER_HOST",
            "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"}}
        return run_bounded([self.executable, *args], cwd=self.root, env=env,
                           data=data, timeout=timeout, max_output=max_output)

    def preflight(self) -> dict:
        daemon = self._docker("info", "--format", "{{.OSType}}")
        if daemon.code or daemon.stdout.strip() != b"linux":
            raise Unavailable("supported Linux Docker engine unavailable; candidate remains held")
        security = self._docker("info", "--format", "{{json .SecurityOptions}}")
        if security.code or b"name=seccomp,profile=builtin" not in security.stdout:
            raise Unavailable("reviewed built-in seccomp profile unavailable; candidate remains held")
        image = self._docker("image", "inspect", self.image, "--format", "{{.Id}}")
        if image.code or not re.fullmatch(rb"sha256:[a-f0-9]{64}", image.stdout.strip()):
            raise Unavailable("reviewed validator image unavailable; no automatic pull or host fallback")
        return {"engine": "linux-docker", "image_id": image.stdout.decode().strip()}

    @contextmanager
    def _materialize(self, artifact_id):
        files = self.artifacts.read(artifact_id)
        stage = self.root / uuid.uuid4().hex
        stage.mkdir()
        try:
            stage.chmod(0o755)
            for name, content in files.items():
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
                target.chmod(0o444)
            yield stage
        finally:
            # Only our checked, generated direct child may be recursively removed.
            if stage.is_symlink() or stage.resolve().parent != self.root or not re.fullmatch(r"[a-f0-9]{32}", stage.name):
                raise Unavailable("validator staging cleanup requires reconciliation")
            def writable_and_retry(function, path, _):
                os.chmod(path, 0o700)
                function(path)
            shutil.rmtree(stage, onerror=writable_and_retry)

    @staticmethod
    def _name(operation_id):
        if not re.fullmatch(r"val-[a-f0-9]{32}", operation_id):
            raise ValueError("invalid validator operation identity")
        return "swarmguard-" + operation_id

    def _inspect(self, name):
        result = self._docker("container", "inspect", name)
        if result.code:
            # Distinguish daemon failure from authoritative object absence.
            listing = self._docker("container", "ls", "-a", "--filter", "name=^/" + name + "$", "--format", "{{.Names}}")
            if listing.code or listing.stdout.strip():
                raise Unavailable("cannot determine validator container state")
            return None
        try:
            return json.loads(result.stdout)[0]
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise Unavailable("invalid Docker inspection result") from exc

    def cleanup(self, operation_id):
        name = self._name(operation_id)
        info = self._inspect(name)
        if info:
            labels = info.get("Config", {}).get("Labels") or {}
            if (labels.get("swarmguard.workspace") != self.workspace_label
                    or labels.get("swarmguard.operation") != operation_id):
                raise Conflict("refusing to remove an unrelated container")
            removed = self._docker("container", "rm", "--force", name)
            if removed.code or self._inspect(name) is not None:
                raise Unavailable("validator teardown is unverified")
        return {"container_absent": True, "operation_id": operation_id}

    def invoke(self, artifact_id: str, module: str, function: str, args: list, kwargs: dict,
               *, operation_id: str) -> dict:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*", module):
            raise ValueError("invalid component module")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", function) or not isinstance(args, list) or not isinstance(kwargs, dict):
            raise ValueError("invalid JSON component invocation")
        envelope = canonical({"module": module, "function": function, "args": args, "kwargs": kwargs}).encode()
        if len(envelope) > 65536:
            raise ValueError("test input exceeds budget")
        name = self._name(operation_id)
        identity = self.preflight()
        if self._inspect(name) is not None:
            raise Conflict("validator operation already exists; reconcile it instead of replaying")
        with self._materialize(artifact_id) as source:
            try:
                # Create separately so admission/inspection precedes any execution.
                created = self._docker("create", "--name", name, "--label", "swarmguard.workspace=" + self.workspace_label,
                    "--label", "swarmguard.operation=" + operation_id, "--network", "none", "--read-only",
                    "--user", "65532:65532", "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true",
                    "--memory", f"{self.budget.memory_mb}m", "--memory-swap", f"{self.budget.memory_mb}m",
                    "--cpus", "0.5", "--pids-limit", str(self.budget.pids), "--ulimit", "nofile=64:64",
                    "--ulimit", "core=0:0", "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
                    "--shm-size", "8m", "--log-driver", "none", "--no-healthcheck", "--restart", "no",
                    "--mount", f"type=bind,source={source},target=/candidate,readonly",
                    "--workdir", "/tmp", "--env", "HOME=/tmp", "--interactive", identity["image_id"])
                if created.code:
                    raise Unavailable("validator container creation failed")
                info = self._inspect(name)
                host = (info or {}).get("HostConfig", {})
                mounts = (info or {}).get("Mounts", [])
                if (not info or info.get("Image") != identity["image_id"]
                        or host.get("NetworkMode") != "none" or not host.get("ReadonlyRootfs")
                        or host.get("Privileged") or host.get("CapDrop") != ["ALL"]
                        or "no-new-privileges=true" not in host.get("SecurityOpt", [])
                        or host.get("Memory") != self.budget.memory_mb * 1024 * 1024
                        or host.get("MemorySwap") != self.budget.memory_mb * 1024 * 1024
                        or host.get("PidsLimit") != self.budget.pids or host.get("NanoCpus") != 500000000
                        or len(mounts) != 1 or mounts[0].get("Destination") != "/candidate" or mounts[0].get("RW")
                        or info.get("Config", {}).get("User") != "65532:65532"):
                    raise Unavailable("validator effective profile did not match admission")
                result = self._docker("start", "--attach", "--interactive", name, data=envelope,
                    timeout=self.budget.seconds, max_output=self.budget.output_bytes)
                final = self._inspect(name)
                if not final or final["State"].get("Running") or final["State"].get("Status") != "exited":
                    raise Unavailable("validator final exit state is unverified")
                if result.code != final["State"]["ExitCode"]:
                    raise Unavailable("validator attachment and daemon exit state disagree")
                return {**identity, "operation_id": operation_id, "artifact_id": artifact_id,
                    "exit_code": final["State"]["ExitCode"], "oom_killed": final["State"].get("OOMKilled", False),
                    "stdout": result.stdout.decode("utf-8", errors="replace"),
                    "stderr": result.stderr.decode("utf-8", errors="replace"), "scope": "local_linux_docker"}
            finally:
                # Killing a Docker CLI does not kill its container. Always use the
                # daemon to remove it and confirm absence, including timeout/flood.
                self.cleanup(operation_id)
