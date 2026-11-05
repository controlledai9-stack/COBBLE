"""Trusted mediation of the simulator's declared virtual effects.

Persistent policy is authoritative; LiveGuard supplies structured signals. A
recorded simulation event never becomes a verified execution receipt. Real tool
bodies are admitted before invocation and their bounded local outcomes retained.
"""
from __future__ import annotations

from collections import Counter

from app.modules.response.control import ResponseControl, identifier
from app.modules.response.mediation import ADMITTED_RUNTIME
from app.modules.response.repository import Conflict, Forbidden, digest
from app.schemas import Agent, AuthorizationRequest, PrincipalRegistration, SessionRegistration
from app.timeutil import now_iso


RUNTIME_CAPABILITIES = ["resource.read", "resource.write", "message.send", "network.external", "code.execute", "artifact.consume"]
TOOLS = {
    "read_file": ("resource.read", "read"), "write_file": ("resource.write", "write"),
    "delete_file": ("resource.write", "delete"), "list_files": ("resource.read", "list"),
    "query_database": ("resource.read", "query"), "insert_database": ("resource.write", "insert"),
    "update_database": ("resource.write", "update"), "delete_database": ("resource.write", "delete"),
    "send_message": ("message.send", "send"), "read_inbox": ("resource.read", "receive"),
    "access_external": ("network.external", "upload"), "admin_operation": ("deployment.production", "admin"),
}


class ResponseRuntime:
    def __init__(self, control: ResponseControl, *, quarantine_service=None, recovery_id=None, component_dependencies=None):
        self.control, self.repository = control, control.repository
        self.run_id = ""
        self.agents: dict[str, Agent] = {}
        self.principals: dict[str, str] = {}
        self.runner = None
        self._quarantine_service = quarantine_service
        self.recovery_id = recovery_id
        self._configured_dependencies = component_dependencies

    def quarantine_service(self):
        if self._quarantine_service is None:
            from app.modules.response.api import get_quarantine_service
            self._quarantine_service = get_quarantine_service(self.control)
        return self._quarantine_service

    def capture_generated(self, agent, files):
        if self.agents.get(agent.agent_id) is not agent:
            raise Forbidden('generated capture requires the registered runtime producer')
        from app.modules.response.generated import GeneratedArtifacts
        service = GeneratedArtifacts(self.quarantine_service())
        return service.capture(self.run_id, agent.agent_id, files, actor=f'runtime:{self.run_id}',
            key=digest({'agent_id': agent.agent_id, 'files': files}))

    def invoke_component(self, agent, contract_id, args, kwargs):
        """Use the dedicated component executor, not the virtual-effect wrapper."""
        from app.modules.response.components import ComponentService
        from app.modules.response.repository import ControlError
        from app.modules.simulator.tools import ToolResult
        if self.agents.get(agent.agent_id) is not agent:
            raise Forbidden('component caller is not the registered runtime agent')
        call_id = identifier('dependency-call')
        try:
            session = self.repository.get('session', self.run_id)
            spec = session.get('component_dependencies', {}).get(agent.role, {}).get(contract_id)
            if spec is None:
                raise Forbidden('component is not declared for this runtime role')
            request = {**spec, 'run_id': self.run_id, 'agent_id': agent.agent_id, 'args': args, 'kwargs': kwargs}
            result = ComponentService(self.quarantine_service()).invoke(contract_id, request,
                actor=f'runtime:{self.run_id}', key=call_id)
            success = result['state'] in {'succeeded', 'development_stub'}
            if success:
                def handoff(tx):
                    current_session, principal = self.control._principal(tx, self.run_id, agent.agent_id)
                    if not self.control.context_current(current_session, principal, agent.agent_id):
                        raise Forbidden('component recipient context changed before output handoff')
                    if current_session.get('dependency_digest') != session.get('dependency_digest'):
                        raise Forbidden('component dependency declaration changed before output handoff')
                    if result['state'] == 'succeeded':
                        decision = self.control._authorize(tx, AuthorizationRequest.model_validate(result['action']))
                    else:
                        decision = self.control._authorize(tx, AuthorizationRequest(run_id=self.run_id,
                            agent_id=agent.agent_id, capability='resource.read', resource='contract:' + contract_id,
                            execution_context=spec['execution_context']))
                    if decision.decision != 'allow':
                        raise Forbidden('current recipient policy holds component output')
                    self._merge_flow(tx, 'principal', principal['principal_id'], [], unknown=True)
                    return {'call_id': call_id, 'operation_id': result.get('operation_id'),
                        'contract_id': contract_id, 'output_lineage': 'unreviewed-component-output',
                        'effect_verified': result.get('verification_status') == 'verified', 'mock': result.get('mock', False)}
                self.repository.command(f'runtime:{self.run_id}', call_id, 'component.output_handoff',
                    {'call_id': call_id, 'operation_id': result.get('operation_id'), 'contract_id': contract_id}, handoff)
            event = self.runner.emit(agent, 'tool_call', 'invoke_component', resource='contract:' + contract_id,
                status='success' if success else 'failed', pregated=(None,),
                payload={'contract_id': contract_id, 'component_operation_id': result.get('operation_id'),
                    'component_state': result['state'], 'mock': result.get('mock', False)})
            return ToolResult('invoke_component', success, data={
                'result': result.get('result'), 'state': result['state'], 'artifact_id': result.get('artifact_id'),
                'implementation_id': result.get('implementation_id'), 'operation_id': result.get('operation_id'),
                'mock': result.get('mock', False), 'output_lineage': 'unreviewed-component-output'} if success else None,
                error=None if success else 'component result is failed, held or inconclusive; inspect its operation',
                gateway_decision='allow', event_id=event.event_id)
        except ControlError as exc:
            # An external executor may already have an uncertain effect; this
            # refusal never claims that execution was independently prevented.
            event = self.runner.emit(agent, 'tool_call', 'invoke_component', resource='contract:' + contract_id,
                status='failed', pregated=(None,), payload={'contract_id': contract_id,
                    'component_error': type(exc).__name__, 'effect_prevention_verified': False})
            return ToolResult('invoke_component', False, error=str(exc), event_id=event.event_id)

    def start(self, run_id: str, agents: list[Agent], config) -> None:
        if self.run_id:
            raise Conflict("runtime controller cannot be reused for another run")
        import json
        from pydantic import TypeAdapter, ValidationError
        from app.config import get_settings
        from app.schemas import ControlId, RuntimeDependency
        from app.modules.response.repository import Unavailable, canonical
        raw = self._configured_dependencies
        if raw is None:
            raw = get_settings().response_component_dependencies
        try:
            raw = json.loads(raw) if isinstance(raw, str) else raw
            if len(canonical(raw).encode()) > 65536 or len(raw) > 5:
                raise ValueError('dependency catalog exceeds budget')
            parsed = TypeAdapter(dict[ControlId, dict[ControlId, RuntimeDependency]]).validate_python(raw)
            if set(parsed) - {'planner', 'analyst', 'coder', 'researcher', 'reviewer'} or any(len(values) > 16 for values in parsed.values()):
                raise ValueError('unsupported dependency roles or count')
            dependencies = {role: {cid: item.model_dump() for cid, item in entries.items()} for role, entries in parsed.items()}
        except (ValueError, TypeError, ValidationError) as exc:
            raise Unavailable('server component dependency catalog is invalid') from exc
        occurrences = Counter()
        assignments = {}
        for agent in agents:
            occurrences[agent.role] += 1
            # Identities derive from trusted simulator slots, never model text or
            # request-supplied role aliases. They deliberately survive new run IDs.
            principal_id = f"simulator:{agent.role}:{occurrences[agent.role]}"
            self.control.register_principal(PrincipalRegistration(principal_id=principal_id,
                capabilities=RUNTIME_CAPABILITIES), actor="runtime-registrar", key=principal_id)
            assignments[agent.agent_id] = principal_id
        self.control.register_session(SessionRegistration(run_id=run_id, agents=assignments,
            live_guard=config.live_guard, gateway_mode=config.gateway_mode), actor="runtime-registrar", key=run_id)
        self.run_id, self.agents, self.principals = run_id, {a.agent_id: a for a in agents}, assignments
        def bind_dependencies(tx):
            session = tx.get('session', run_id)
            return tx.update('session', run_id, {**session, 'component_dependencies': dependencies,
                'dependency_digest': digest(dependencies)}, session['revision'])
        self.repository.command('runtime-registrar', run_id, 'session.dependencies',
            {'run_id': run_id, 'component_dependencies': dependencies}, bind_dependencies)
        if config.user_task:
            def unknown_context(tx):
                for pid in assignments.values():
                    self._merge_flow(tx, "principal", pid, [], unknown=True)
                return {"run_id": run_id, "input_context": "untrusted"}
            self.repository.command("runtime-registrar", run_id, "context.untrusted", {"run_id": run_id}, unknown_context)

    def bind(self, runner) -> None:
        if runner.run_id != self.run_id:
            raise Forbidden("runtime belongs to another run")
        self.runner = runner

    def _flow_id(self, kind: str, subject: str) -> str:
        return digest({"kind": kind, "subject": subject, **({"run": self.run_id} if kind == "resource" else {})})

    def _flow(self, tx, kind, subject):
        return tx.get("flow", self._flow_id(kind, subject), required=False) or {"sources": [], "unknown": False}

    def _merge_flow(self, tx, kind, subject, sources, unknown=False):
        fid = self._flow_id(kind, subject)
        old = tx.get("flow", fid, required=False)
        combined = sorted(set(sources) | set((old or {}).get("sources", [])))
        doc = {"subject": subject, "kind": kind, "sources": combined[:64],
               "unknown": unknown or len(combined) > 64 or bool((old or {}).get("unknown")),
               **({"run_id": self.run_id} if kind == "resource" else {})}
        if old:
            return tx.update("flow", fid, doc, old["revision"])
        return tx.insert("flow", fid, doc)

    def _information_flow(self, tx, request, *, sensitive=False, known=True, update=False):
        principal_id = self.principals[request.agent_id]
        actor = self._flow(tx, "principal", principal_id)
        resource = self._flow(tx, "resource", request.resource or "")
        sources = set(actor["sources"]) | set(resource["sources"])
        unknown = actor["unknown"] or resource["unknown"]
        if sensitive and request.resource:
            sources.add(request.resource)
        if request.capability == "resource.read":
            # Do not let a public-looking copied file erase the original ACL.
            if any(source not in self.agents[request.agent_id].permissions for source in resource["sources"]):
                return "resource contains data outside this agent's permissions"
            if resource["unknown"]:
                return "resource lineage is unknown; trusted review required"
            if update and (sources or unknown or not known):
                self._merge_flow(tx, "principal", principal_id, sources, unknown or not known)
        if request.capability == "resource.write" and update and (sources or unknown):
            self._merge_flow(tx, "resource", request.resource or "", sources, unknown)
        if request.capability == "network.external":
            if sources or unknown or not known:
                return "external transfer held by sensitivity or unknown-lineage policy"
        if request.capability == "message.send":
            recipient = self.agents.get(request.target or "")
            if recipient is None:
                return "recipient is not registered in this run"
            if unknown or not known or any(source not in recipient.permissions for source in sources):
                return "message held: recipient cannot consume this sensitivity/lineage context"
            if update and sources:
                self._merge_flow(tx, "principal", self.principals[recipient.agent_id], sources)
        return None

    def _request(self, registry, tool_name, agent, args):
        if tool_name not in TOOLS or self.agents.get(agent.agent_id) is not agent:
            raise Forbidden("tool or runtime identity is not registered")
        capability, action = TOOLS[tool_name]
        resource, target, sensitive, known = None, None, False, True
        if tool_name in {"read_file", "write_file", "delete_file"}:
            from app.modules.response.artifacts import ArtifactStore
            ArtifactStore.validate_path(args["path"])
            resource = registry.env.fs.normalize_path(args["path"])
            file = registry.env.fs.get_file(resource)
            sensitive = bool(file and file.is_restricted) or registry.env.gateway.is_protected(resource, None)
            known = file is not None or tool_name == "write_file"
        elif tool_name == "list_files":
            resource = registry.env.fs.normalize_path(args.get("prefix") or "repo")
        elif "database" in tool_name:
            table = args["table"].strip()
            resource = f"data/{table}"
            sensitive = registry.env.db.is_restricted(table)
            known = table in registry.env.db._tables or tool_name == "insert_database"
        elif tool_name == "send_message":
            recipient = registry.runner.get_agent_by_id(args["recipient_id"])
            target = recipient.agent_id if recipient else args["recipient_id"]
        elif tool_name == "read_inbox":
            resource = f"inbox/{agent.agent_id}"
        elif tool_name == "access_external":
            target, resource = args["target"], args.get("resource")
            known = bool(resource and registry.env.fs.has_file(resource))
        elif tool_name == "admin_operation":
            resource = args.get("target") or f"system/{args['operation']}"
        baseline = registry.env.gateway.check(agent, resource=resource, target=target)
        baseline_allowed = baseline.decision not in {"blocked", "would_block"}
        if sensitive and resource and not any(resource == p or resource.startswith(p.rstrip("/") + "/") for p in agent.permissions):
            baseline_allowed = False
        if tool_name == "access_external" and target not in registry.env.gateway.allowlist:
            baseline_allowed = False
        request = AuthorizationRequest(run_id=self.run_id, agent_id=agent.agent_id, capability=capability,
            resource=resource, target=target, parameters={"tool": tool_name, "action": action,
                "arguments_hash": digest(args)})
        return request, baseline_allowed, sensitive, known, action

    def execute_tool(self, registry, tool_name, agent, args, effect):
        from app.modules.simulator.tools import ToolResult

        request, baseline, sensitive, known, action_name = self._request(registry, tool_name, agent, args)
        key = identifier("call")

        def admit(tx):
            decision = self.control._authorize(tx, request, baseline_allowed=baseline)
            reason = self._information_flow(tx, request, sensitive=sensitive, known=known)
            principal_id = self.principals[agent.agent_id]
            if self.control.pending_operation(tx, principal_id):
                reason = "a prior effect is in flight or requires reconciliation"
            permitted = decision.decision == "allow" and reason is None
            if self.control.profile.mode == "monitor":
                # Monitor cannot authorize code, administrative or unknown tools.
                permitted = (decision.decision in {"allow", "deny"} and baseline and
                             reason != "a prior effect is in flight or requires reconciliation" and request.capability in
                             {"resource.read", "resource.write", "message.send", "network.external"})
                session, principal = self.control._principal(tx, self.run_id, agent.agent_id)
                policy = tx.get('policy', 'active')
                permitted = (permitted and self.control.context_current(session, principal, agent.agent_id)
                    and session['policy_epoch'] == policy['epoch'] and policy['integrity'] == 'trusted')
            oid = identifier("op")
            if permitted:
                self._information_flow(tx, request, sensitive=sensitive, known=known, update=True)
            return tx.insert("operation", oid, {"operation_id": oid, "run_id": self.run_id,
                "principal_id": principal_id,
                "executor_id": f"runtime:{self.run_id}", "action": request.model_dump(),
                "decision": decision.model_dump(), "reason": reason or decision.reason,
                "state": "admitted" if permitted else "denied", "fence": decision.principal_revision,
                "policy_epoch": decision.policy_epoch, "verification_status": "unverified",
                "effect_scope": "local_virtual_tool", "created_at": now_iso()})

        op = self.repository.command(f"runtime:{self.run_id}", key, "runtime.admit", request.model_dump(), admit)
        if op["state"] == "denied":
            self._finish(op, "denied", success=False, callback_invoked=False)
            event = registry.runner.emit(agent, "message" if tool_name == "send_message" else
                "data_transfer" if tool_name == "access_external" else "resource_access", action_name,
                resource=request.resource, target=request.target, status="denied", gateway_decision="blocked",
                payload={"response_operation_id": op["operation_id"], "gateway_reason": op["reason"]},
                pregated=(op["reason"],))
            return ToolResult(tool_name=tool_name, success=False, error=op["reason"],
                              gateway_decision="blocked", event_id=event.event_id)
        token = ADMITTED_RUNTIME.set(self)
        try:
            result = effect()
        except BaseException:
            self._finish(op, "reconciliation_required", success=False, callback_invoked=True, verified=False)
            raise
        finally:
            ADMITTED_RUNTIME.reset(token)
        state = "succeeded" if result.success else "denied" if result.gateway_decision == "blocked" else "failed"
        self._finish(op, state, success=result.success, callback_invoked=True, event_id=result.event_id)
        return result

    def observe_event(self, event):
        """Conservatively label admitted scripted reads; never assert an effect."""
        if (ADMITTED_RUNTIME.get() is self or event.status != "success" or event.event_type != "resource_access"
                or event.action not in {"read", "query"} or event.agent_id not in self.principals):
            return
        resource = event.resource or ""
        request = AuthorizationRequest(run_id=self.run_id, agent_id=event.agent_id,
            capability="resource.read", resource=resource)
        sensitive = self.runner.gateway.is_protected(resource, None)

        def label(tx):
            # An internal simulated request is only evidence of possible context.
            # Conservatism here must not be reported as a verified read/prevention.
            self._information_flow(tx, request, sensitive=sensitive, update=True)
            return {"event_id": event.event_id, "run_id": self.run_id, "effect_verified": False}
        self.repository.command(f"runtime:{self.run_id}", event.event_id, "context.observation",
            {"agent_id": event.agent_id, "resource": resource, "event_id": event.event_id}, label)

    def _finish(self, op, state, *, success, callback_invoked, verified=True, event_id=None):
        def apply(tx):
            current = tx.get("operation", op["operation_id"])
            if current["state"] not in {"admitted", "denied"}:
                raise Conflict("runtime operation already has an outcome")
            return tx.update("operation", op["operation_id"], {**current, "state": state,
                "success": success, "callback_invoked": callback_invoked, "event_id": event_id,
                "verification_status": "local_executor" if verified else "unverified",
                "completed_at": now_iso(), "prevention_verified": state == "denied" and not callback_invoked},
                current["revision"])
        self.repository.command(f"runtime:{self.run_id}", op["operation_id"], "runtime.receipt",
            {"state": state, "success": success, "callback_invoked": callback_invoked,
             "verified": verified, "event_id": event_id}, apply)

    def gate_event(self, agent_id, event_type=None, target=None, *, action=None, resource=None, **_):
        """Gate legacy simulated requests; these are NOT execution receipts."""
        if ADMITTED_RUNTIME.get() is self:
            return None
        if event_type == "observation":
            return None
        if event_type == "message":
            capability = "resource.read" if action == "receive" else "message.send"
        elif event_type == "data_transfer":
            capability = "network.external"
        elif event_type == "resource_access":
            capability = "resource.read" if action in {"read", "query", "list", "access"} else "resource.write"
        elif event_type in {"task", "tool_call"}:
            capability = "code.execute" if resource in {"tool/code_exec", "tool/shell"} else "resource.read"
        else:
            return "unknown controlled event type"
        agent = self.agents.get(agent_id)
        if not agent:
            return "unregistered runtime identity"
        req = AuthorizationRequest(run_id=self.run_id, agent_id=agent_id, capability=capability,
                                   resource=resource, target=target)
        baseline = self.runner.gateway.check(agent, resource=resource, target=target)
        with self.repository.read() as tx:
            session, principal = self.control._principal(tx, self.run_id, agent_id)
            policy = tx.get('policy', 'active')
            if (not self.control.context_current(session, principal, agent_id)
                    or session['policy_epoch'] != policy['epoch'] or policy['integrity'] != 'trusted'):
                return 'runtime session/context or policy fence is no longer current'
            decision = self.control._authorize(tx, req, baseline_allowed=baseline.decision not in {"blocked", "would_block"})
            reason = self._information_flow(tx, req, known=bool(resource) if capability == "network.external" else True)
        if self.control.profile.mode != "enforce":
            return None
        return reason or (decision.reason if decision.decision != "allow" else None)

    def contain(self, containment) -> None:
        agent_id = containment.agent_id
        if agent_id not in self.principals:
            raise Forbidden("detector signal names an unregistered actor")
        scope = ["network.external"] if containment.scope == "egress" else RUNTIME_CAPABILITIES
        signal = {"run_id": self.run_id, "agent_id": agent_id, "scope": scope,
                  "trigger": containment.trigger, "reason": containment.explanation[:2000]}
        sid = digest(signal)

        def apply(tx):
            _, principal = self.control._principal(tx, self.run_id, agent_id)
            iid, rid = "inc-" + sid[:32], "rst-" + sid[:32]
            tx.insert("incident", iid, {"incident_id": iid, "run_id": self.run_id, "status": "open",
                "phase": "restricted", "severity": "high", "reason": signal["reason"],
                "owner": "security-review", "opened_at": now_iso(), "signal_hash": sid,
                "evidence_summary": {"sequence": containment.paused_at_sequence, "trigger": containment.trigger}})
            tx.update("principal", principal["principal_id"], principal, principal["revision"])
            from app.modules.response.notifications import notify
            notify(tx, rid, 'egress_hold' if containment.scope == 'egress' else 'agent_paused', self.run_id, agent_id)
            return tx.insert("restriction", rid, {"restriction_id": rid, "incident_id": iid,
                "principal_id": principal["principal_id"], "run_id": self.run_id, "agent_id": agent_id,
                "capabilities": scope, "resource": None, "state": "active", "reason": signal["reason"],
                "requires_clean_context": containment.trigger == "hijack_tripwire", "created_at": now_iso()})
        self.repository.command("live-detector", sid, "signal.contain", signal, apply)

    def report(self):
        return self.report_for(self.control, self.run_id)

    @staticmethod
    def report_for(control, run_id):
        control.repository.get("session", run_id)
        all_operations = control.repository.list("operation", run_id=run_id)
        operations = [op for op in all_operations if op.get("effect_scope") == "local_virtual_tool"]
        return {"run_id": run_id, "scope": "local_virtual_tools", "mode": control.profile.mode,
            "operations": operations, "counts": dict(Counter(o["state"] for o in operations)),
            "verified_preventions": sum(bool(o.get("prevention_verified")) for o in operations),
            "other_operation_counts": dict(Counter(op["executor_id"] for op in all_operations
                if op.get("effect_scope") != "local_virtual_tool")),
            "limitations": ["simulated events are not effect receipts", "no production network/deployment adapter"]}
