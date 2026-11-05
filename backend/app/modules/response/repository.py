"""Response-owned transactional state, separate from replaceable pipeline outputs.

All state mutations pass through command(): state, idempotency result and audit
append commit together. External effects must never run inside that transaction.
The local chain detects corruption, not a database administrator rewriting history.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Callable, Iterator

from app.timeutil import now_iso


class ControlError(Exception):
    status_code = 400


class Missing(ControlError):
    status_code = 404


class Conflict(ControlError):
    status_code = 409


class Forbidden(ControlError):
    status_code = 403


class Unavailable(ControlError):
    status_code = 503


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


KINDS = frozenset({
    "policy", "principal", "session", "incident", "restriction", "approval", "operation",
    "quarantine", "artifact", "validation", "implementation", "contract", "evidence", "health", "flow", "review", "selection", "notification", "message_hold", "recovery",
})


class Transaction:
    def __init__(self, conn: sqlite3.Connection, workspace: str):
        self.conn, self.workspace = conn, workspace

    def get(self, kind: str, identifier: str, *, required: bool = True) -> dict | None:
        self._kind(kind)
        row = self.conn.execute(
            "SELECT data FROM response_records WHERE workspace=? AND kind=? AND record_id=?",
            (self.workspace, kind, identifier),
        ).fetchone()
        if row:
            return json.loads(row[0])
        if required:
            raise Missing(f"{kind} not found")
        return None

    def list(self, kind: str, *, filters: dict | None = None) -> list[dict]:
        self._kind(kind)
        rows = self.conn.execute(
            "SELECT data FROM response_records WHERE workspace=? AND kind=? ORDER BY record_id",
            (self.workspace, kind),
        ).fetchall()
        return [doc for (raw,) in rows if (doc := json.loads(raw)) is not None
                and all(doc.get(k) == v for k, v in (filters or {}).items())]

    def insert(self, kind: str, identifier: str, data: dict) -> dict:
        self._kind(kind)
        doc = {**data, "revision": 1}
        try:
            self.conn.execute(
                "INSERT INTO response_records(workspace,kind,record_id,data) VALUES (?,?,?,?)",
                (self.workspace, kind, identifier, canonical(doc)),
            )
        except sqlite3.IntegrityError as exc:
            raise Conflict(f"{kind} already exists") from exc
        return doc

    def update(self, kind: str, identifier: str, data: dict, expected_revision: int) -> dict:
        old = self.get(kind, identifier)
        if old["revision"] != expected_revision:
            raise Conflict("record revision changed; reload before retrying")
        doc = {**data, "revision": expected_revision + 1}
        self.conn.execute(
            "UPDATE response_records SET data=? WHERE workspace=? AND kind=? AND record_id=?",
            (canonical(doc), self.workspace, kind, identifier),
        )
        return doc

    @staticmethod
    def _kind(kind: str) -> None:
        if kind not in KINDS:
            raise ValueError("unknown response record kind")


class ResponseRepository:
    def __init__(self, path: str = ":memory:", workspace: str = "default", *, max_record_bytes: int = 262144):
        if not workspace or len(workspace) > 128:
            raise ValueError("invalid workspace")
        self.workspace = workspace
        self.path = path
        self.durable = path != ":memory:"
        self.max_record_bytes = max_record_bytes
        self._lock = threading.RLock()
        if self.durable:
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, timeout=5, isolation_level=None, check_same_thread=False)
        self._conn.execute("PRAGMA busy_timeout=5000")
        self._conn.execute("PRAGMA foreign_keys=ON")
        if self.durable:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=FULL")
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS response_records (
                workspace TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL,
                data TEXT NOT NULL, PRIMARY KEY(workspace,kind,record_id));
            CREATE TABLE IF NOT EXISTS response_commands (
                workspace TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
                request_key TEXT NOT NULL, request_hash TEXT NOT NULL, result TEXT NOT NULL,
                PRIMARY KEY(workspace,actor,action,request_key));
            CREATE TABLE IF NOT EXISTS response_audit (
                workspace TEXT NOT NULL, sequence INTEGER NOT NULL, event TEXT NOT NULL,
                event_hash TEXT NOT NULL, PRIMARY KEY(workspace,sequence));
            CREATE TABLE IF NOT EXISTS response_heads (
                workspace TEXT PRIMARY KEY, sequence INTEGER NOT NULL, event_hash TEXT NOT NULL);
            CREATE TRIGGER IF NOT EXISTS response_audit_no_update BEFORE UPDATE ON response_audit
                BEGIN SELECT RAISE(ABORT, 'response audit is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS response_audit_no_delete BEFORE DELETE ON response_audit
                BEGIN SELECT RAISE(ABORT, 'response audit is append-only'); END;
        """)
        if not self.verify_audit()["valid"]:
            self.close()
            raise Unavailable("response audit failed integrity verification")

    @contextmanager
    def read(self) -> Iterator[Transaction]:
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                yield Transaction(self._conn, self.workspace)
                self._conn.execute("COMMIT")
            except BaseException:
                if self._conn.in_transaction:
                    self._conn.execute("ROLLBACK")
                raise

    def get(self, kind: str, identifier: str) -> dict:
        with self.read() as tx:
            return tx.get(kind, identifier)

    def list(self, kind: str, **filters) -> list[dict]:
        with self.read() as tx:
            return tx.list(kind, filters=filters)

    def completed_command(self, actor: str, key: str, action: str, payload: dict) -> dict | None:
        """Read a historical idempotent result before rechecking mutable subjects.

        This never authorizes a new effect. Callers must dispatch effects only
        through command() and return this result solely as a previous outcome.
        """
        with self.read():
            self._check_head()
            row = self._conn.execute(
                "SELECT request_hash,result FROM response_commands WHERE workspace=? AND actor=? AND action=? AND request_key=?",
                (self.workspace, actor, action, key)).fetchone()
            if not row:
                return None
            if row[0] != digest(payload):
                raise Conflict("idempotency key already used for a different request")
            return json.loads(row[1])

    def command(self, actor: str, key: str, action: str, payload: dict,
                apply: Callable[[Transaction], dict]) -> dict:
        if not actor or len(actor) > 128 or not key or len(key) > 128 or not action or len(action) > 128:
            raise ValueError("actor, idempotency key and action must be bounded identifiers")
        if len(canonical(payload).encode()) > self.max_record_bytes:
            raise ValueError("response command exceeds size budget")
        request_hash = digest(payload)
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                self._check_head()
                previous = self._conn.execute(
                    "SELECT request_hash,result FROM response_commands WHERE workspace=? AND actor=? AND action=? AND request_key=?",
                    (self.workspace, actor, action, key),
                ).fetchone()
                if previous:
                    if previous[0] != request_hash:
                        raise Conflict("idempotency key already used for a different request")
                    result = json.loads(previous[1])
                else:
                    result = apply(Transaction(self._conn, self.workspace))
                    encoded = canonical(result)
                    if len(encoded.encode()) > self.max_record_bytes:
                        raise ValueError("response result exceeds size budget")
                    self._append(actor, action, key, request_hash, digest(result))
                    self._conn.execute(
                        "INSERT INTO response_commands VALUES (?,?,?,?,?,?)",
                        (self.workspace, actor, action, key, request_hash, encoded),
                    )
                self._conn.execute("COMMIT")
                return result
            except BaseException:
                if self._conn.in_transaction:
                    self._conn.execute("ROLLBACK")
                raise

    def _check_head(self) -> None:
        tail = self._conn.execute(
            "SELECT sequence,event_hash FROM response_audit WHERE workspace=? ORDER BY sequence DESC LIMIT 1",
            (self.workspace,),
        ).fetchone()
        head = self._conn.execute(
            "SELECT sequence,event_hash FROM response_heads WHERE workspace=?", (self.workspace,),
        ).fetchone()
        if tail != head:
            raise Unavailable("response audit head mismatch; reconciliation required")

    def _append(self, actor: str, action: str, key: str, request_hash: str, result_hash: str) -> None:
        head = self._conn.execute(
            "SELECT sequence,event_hash FROM response_heads WHERE workspace=?", (self.workspace,),
        ).fetchone()
        sequence, previous_hash = (head[0] + 1, head[1]) if head else (1, "0" * 64)
        event = {"workspace": self.workspace, "sequence": sequence, "actor": actor,
                 "action": action, "request_key": key, "request_hash": request_hash,
                 "result_hash": result_hash, "recorded_at": now_iso(), "previous_hash": previous_hash}
        event_hash = digest(event)
        self._conn.execute("INSERT INTO response_audit VALUES (?,?,?,?)",
                           (self.workspace, sequence, canonical(event), event_hash))
        self._conn.execute(
            "INSERT INTO response_heads VALUES (?,?,?) ON CONFLICT(workspace) DO UPDATE SET sequence=excluded.sequence,event_hash=excluded.event_hash",
            (self.workspace, sequence, event_hash),
        )

    def audit(self, after: int = 0, limit: int = 100) -> list[dict]:
        if after < 0 or not 1 <= limit <= 500:
            raise ValueError("invalid audit page")
        with self._lock:
            return [{**json.loads(raw), "event_hash": hashed} for raw, hashed in self._conn.execute(
                "SELECT event,event_hash FROM response_audit WHERE workspace=? AND sequence>? ORDER BY sequence LIMIT ?",
                (self.workspace, after, limit),
            ).fetchall()]

    def verify_audit(self) -> dict:
        with self.read():
            previous, expected = "0" * 64, 1
            rows = self._conn.execute(
                "SELECT sequence,event,event_hash FROM response_audit WHERE workspace=? ORDER BY sequence",
                (self.workspace,),
            ).fetchall()
            try:
                for sequence, raw, hashed in rows:
                    event = json.loads(raw)
                    if (sequence != expected or event.get("sequence") != sequence or
                            event.get("workspace") != self.workspace or event.get("previous_hash") != previous
                            or digest(event) != hashed):
                        return {"valid": False, "failed_sequence": sequence}
                    previous, expected = hashed, expected + 1
                self._check_head()
            except (ValueError, TypeError, Unavailable):
                return {"valid": False, "failed_sequence": expected}
            return {"valid": True, "events": len(rows), "head_hash": previous,
                    "assurance": "local hash chain; no independent production anchor"}

    def close(self) -> None:
        with self._lock:
            self._conn.close()
