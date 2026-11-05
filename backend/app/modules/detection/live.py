"""Live guard: detection while the run is happening, and containment before harm.

Batch detection explains what went wrong after the fact. The live guard sees every event
as it is emitted, re-evaluates all rules and agent risk, and, in `contain` mode, pauses an
agent once its risk reaches `pause_at`. The agent runner asks `gate()` before every action,
so a paused agent's later actions are denied *before they execute* (a real gateway
denial, recorded as `blocked`, never a post-hoc claim).

Hijack tripwire: an agent that has just ingested untrusted content (an email, a web page, a planted
message; SG-012's notion of exposure) and then attempts an out-of-policy action is stopped *before
that first action runs*, instead of after risk builds up. This is what stops a prompt-injected AI
agent before the leak, not one step late.

The runner only needs this duck-typed interface: start(run_id, agents), gate(agent_id, event_type,
target, action=..., resource=..., payload=...), observe(raw_event). Nothing else in the simulator
depends on detection.
"""
from __future__ import annotations

from types import SimpleNamespace

from app.modules.collector.normalizer import collect
from app.modules.detection.advanced_rules import _ingests, out_of_policy, provenance_marked
from app.modules.detection.assurance_rules import sender_verified
from app.modules.detection.risk import assess
from app.modules.detection.rules import run_rules
from app.modules.simulator.world import EXTERNAL_PREFIX, RESTRICTED_RESOURCES
from app.schemas import Agent, Containment, DetectionRule, LiveDetection, LiveReport, NormalizedEvent, RawEvent, Run
from app.timeutil import now_iso, parse_iso

# Rules whose verdict can only be judged once the run is over (they compare whole-run behaviour).
END_OF_RUN_RULES = {"SG-010"}


class LiveGuard:
    def __init__(self, rules: list[DetectionRule], mode: str = "contain", pause_at: float = 0.6):
        self.rules = [r for r in rules if r.rule_id not in END_OF_RUN_RULES]
        self.mode = mode
        self.pause_at = pause_at
        self.run_id = ""
        self.agents: list[Agent] = []
        self.roles: dict[str, str] = {}
        self.events: list[NormalizedEvent] = []
        self.seen: set[tuple[str, tuple[str, ...]]] = set()
        self.detections: list[LiveDetection] = []
        self.paused: dict[str, Containment] = {}
        self.held: dict[str, Containment] = {}  # egress-only holds
        self.restricted = set(next((r.params.get("restricted_resources", []) for r in rules if r.rule_id == "SG-001"),
                                   RESTRICTED_RESOURCES))
        self.registry: dict[str, Agent] = {}
        hijack = next((r for r in rules if r.rule_id == "SG-012"), None)
        self.hijack_params = dict(hijack.params) if hijack else {}
        self.exposure_steps = int(self.hijack_params.get("max_steps", 5))
        self.exposed: dict[str, dict] = {}  # agent -> {"left": steps, "source": what it ingested}
        self.sends: dict[str, NormalizedEvent] = {}  # message_id -> send event (to verify claimed senders)
        self.tainted_msgs: dict[str, str] = {}  # message_id sent by an exposed agent -> original untrusted source
        self.quarantined: list[dict] = []  # untrusted inputs withheld from an agent before it read them
        self.response = None  # optional persistent authority; these dicts then become report projections

    # ---------------------------------------------------------------- runner interface
    def start(self, run_id: str, agents: list[Agent]) -> None:
        self.run_id, self.agents = run_id, agents
        self.roles = {a.agent_id: a.role for a in agents}
        self.registry = {a.agent_id: a for a in agents}

    def gate(self, agent_id: str, event_type: str | None = None, target: str | None = None, *, action: str | None = None,
             resource: str | None = None, payload: dict | None = None, sequence: int = 0, timestamp: str = "") -> str | None:
        """Called BEFORE an action executes. A reason means: deny it."""
        if self.mode != "contain":
            return None
        if self.response:
            reason = self.response.gate_event(agent_id, event_type, target, action=action, resource=resource, payload=payload)
            if reason:
                projection = self.paused.get(agent_id) or self.held.get(agent_id)
                if projection:
                    projection.blocked_actions += 1
                return reason
        if not self.response and agent_id in self.paused:
            c = self.paused[agent_id]
            c.blocked_actions += 1
            return f"agent paused by live detection at event #{c.paused_at_sequence} (risk {c.risk:.0%})"
        hold = self.held.get(agent_id)
        if not self.response and hold and event_type == "data_transfer" and (target or "").startswith(EXTERNAL_PREFIX):
            hold.blocked_actions += 1
            return (f"egress held since event #{hold.paused_at_sequence}: agent received restricted data it may not hold "
                    f"(need-to-know)")
        if payload and payload.get("claimed_sender") and not sender_verified(payload, agent_id, self.sends, self.roles):
            if self.response:
                from app.modules.response.messages import MessageReview
                MessageReview(self.response.control).hold(self.run_id, agent_id, resource, payload)
            # Impersonated sender (SG-026): withhold the item so the agent never acts on it. The agent isn't at fault.
            self.quarantined.append({"agent_id": agent_id, "resource": resource, "claimed_sender": payload["claimed_sender"],
                                     "sequence": sequence})
            return (f"quarantined before delivery: claims to be from {payload['claimed_sender']} but the broker has no "
                    f"such message (impersonated sender)")
        exposure = self.exposed.get(agent_id)
        if exposure and self.hijack_params and event_type:
            pending = SimpleNamespace(agent_id=agent_id, event_type=event_type, action=action or "", target=target,
                                      resource=resource, payload=payload or {}, status="success")
            if out_of_policy(pending, self.registry, self.hijack_params):
                what = f"{action or event_type} {resource or target or ''}".strip()
                self.paused[agent_id] = Containment(
                    agent_id=agent_id, role=self.roles.get(agent_id), paused_at_sequence=sequence, paused_at=timestamp,
                    risk=1.0, blocked_actions=1, trigger="hijack_tripwire",
                    explanation=f"tried {what} right after ingesting untrusted content ({exposure['source']}): likely "
                                f"prompt injection, stopped before it ran")
                if self.response:
                    self.response.contain(self.paused[agent_id])
                return f"blocked before execution: out-of-policy action right after untrusted input ({exposure['source']})"
        return None

    def observe(self, raw: RawEvent) -> None:
        normalized = collect([raw.model_dump(mode="json")], run_id=self.run_id, agents=self.agents).events
        if not normalized:
            return
        event = normalized[0]
        self.events.append(event)
        self._track_exposure(event)
        self._hold_egress(event)
        alerts = run_rules(self.run_id, self.events, self.agents, self.rules)
        for al in alerts:
            key = (al.rule_id, tuple(sorted(al.agent_ids)))
            if key in self.seen:
                continue
            self.seen.add(key)
            self.detections.append(LiveDetection(
                sequence=event.sequence, timestamp=event.timestamp, event_id=event.event_id, rule_id=al.rule_id,
                rule_name=al.rule_name, severity=al.severity, agent_ids=al.agent_ids, reason=al.reason))
        # Re-assess after every event: anomaly evidence can raise risk even before any alert fires.
        if self.mode == "contain":
            for v in assess(self.run_id, self.events, self.agents, alerts, self.rules):
                if v.risk >= self.pause_at and v.agent_id not in self.paused:
                    self.paused[v.agent_id] = Containment(
                        agent_id=v.agent_id, role=v.role, paused_at_sequence=event.sequence, paused_at=event.timestamp,
                        risk=v.risk, explanation=v.best_explanation, trigger="risk")
                    if self.response:
                        self.response.contain(self.paused[v.agent_id])

    def replay(self, timeline: list[dict]) -> list[dict]:
        """Stream a recorded timeline through the guard as if it were happening now.

        Each event is gated before it 'executes' (denied if its agent is already contained) and observed after,
        exactly as the agent runner does live. Returns the timeline as it would have unfolded under the guard.
        """
        out = []
        for raw in timeline:
            e = dict(raw)
            reason = self.gate(e["agent_id"], e.get("event_type"), e.get("target"), action=e.get("action"),
                               resource=e.get("resource"), payload=e.get("payload"), sequence=e.get("sequence") or 0,
                               timestamp=e.get("timestamp") or "")
            if reason:
                e.update(status="denied", gateway_decision="blocked",
                         payload={**(e.get("payload") or {}), "quarantined": True, "gateway_reason": reason})
            self.observe(RawEvent.model_validate(e))
            out.append(e)
        return out

    def _track_exposure(self, e: NormalizedEvent) -> None:
        """Mirror SG-012's window: an agent stays 'exposed' for a few of its own steps after untrusted input."""
        if not self.hijack_params:
            return
        ex = self.exposed.get(e.agent_id)
        if ex:
            ex["left"] -= 1
            if ex["left"] <= 0:
                self.exposed.pop(e.agent_id, None)
        mid = e.payload.get("message_id")
        if e.event_type == "message" and e.action != "receive" and e.status == "success" and mid:
            self.sends[mid] = e
            if ex and ex.get("relay", True):  # an exposed agent's message carries the taint onward (worm-style spread)
                self.tainted_msgs[mid] = ex["source"]
        elif e.event_type == "message" and e.action == "receive" and mid in self.tainted_msgs:
            self.exposed[e.agent_id] = {"left": self.exposure_steps,
                                        "source": f"a message relaying {self.tainted_msgs[mid]}"}
        if e.status == "success" and _ingests(e, self.hijack_params):
            self.exposed[e.agent_id] = {"left": self.exposure_steps, "source": e.resource or e.event_type,
                                        "relay": provenance_marked(e, self.hijack_params)}

    def _hold_egress(self, e: NormalizedEvent) -> None:
        """Targeted containment: an agent handed restricted data it isn't permitted to hold may keep working,
        but may not send anything outside until a human reviews it. Stops the leak itself, not just what follows."""
        if self.mode != "contain" or e.event_type != "message" or e.action == "receive" or e.status != "success":
            return
        ref, target = e.payload.get("data_ref"), e.target
        recipient = self.registry.get(target or "")
        if ref in self.restricted and recipient and ref not in recipient.permissions and target not in self.held:
            self.held[target] = Containment(agent_id=target, role=recipient.role, scope="egress", trigger="need_to_know",
                                            paused_at_sequence=e.sequence,
                                            paused_at=e.timestamp, risk=0.0,
                                            explanation=f"received {ref} from {e.agent_id} without permission to hold it")
            if self.response:
                self.response.contain(self.held[target])

    # ---------------------------------------------------------------- results
    def report(self, run: Run) -> LiveReport:
        labels = set(run.labels.malicious_agent_ids)
        bad_events = set(run.labels.malicious_event_ids)
        by_id = {e.event_id: e for e in self.events}
        first_bad = {}
        for e in self.events:
            if e.event_id in bad_events:
                first_bad.setdefault(e.agent_id, e)
        first_seen = {}
        for d in self.detections:
            for aid in d.agent_ids:
                first_seen.setdefault(aid, d)
        latencies_events, latencies_s = [], []
        for aid, start in first_bad.items():
            d = first_seen.get(aid)
            if d:
                latencies_events.append(max(0, d.sequence - start.sequence))
                latencies_s.append(max(0.0, (parse_iso(d.timestamp) - parse_iso(start.timestamp)).total_seconds()))
        attack = [by_id[eid] for eid in bad_events if eid in by_id]
        stopped_by_pause = [e for e in attack if e.payload.get("quarantined")]
        completed = [e for e in attack if e.status == "success"]
        paused_innocent = sorted(set(self.paused) - labels)
        leaked = [e for e in attack if e.event_type == "data_transfer" and e.status == "success"
                  and (e.target or "").startswith(EXTERNAL_PREFIX)]
        metrics = {
            "held_egress": len(self.held),
            "data_left_the_system": bool(leaked),
            "malicious_agents": len(labels),
            "detected_live": len(labels & set(first_seen)),
            "paused_malicious": len(labels & set(self.paused)),
            "paused_innocent": len(paused_innocent),
            "mean_latency_events": round(sum(latencies_events) / len(latencies_events), 2) if latencies_events else None,
            "mean_latency_s": round(sum(latencies_s) / len(latencies_s), 2) if latencies_s else None,
            "attack_actions": len(attack),
            "attack_actions_completed": len(completed),
            "attack_actions_blocked_by_pause": len(stopped_by_pause),
            "quarantined_inputs": len(self.quarantined),
            "stopped_before_first_harm": sum(1 for c in self.paused.values() if c.trigger == "hijack_tripwire"),
            "blocked_actions_total": sum(c.blocked_actions for c in [*self.paused.values(), *self.held.values()]),
        }
        return LiveReport(run_id=self.run_id, mode=self.mode, pause_at=self.pause_at, events_processed=len(self.events),
                          detections=self.detections, containment=[*self.held.values(), *self.paused.values()], metrics=metrics,
                          created_at=now_iso())
