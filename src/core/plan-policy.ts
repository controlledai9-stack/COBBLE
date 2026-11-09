import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import { hasPlanCondition, requiredText } from "./plan";
import type { Store } from "./store";
import type {
  PlanItem,
  PlanGraph,
  PlanException,
  PlanExceptionRequest,
  Team,
} from "../shared/types";

const directive =
  /(?:do not|must not|never)\s+(?:create|add|modify|edit|change)\s+(?:files?\s+(?:in|under|at)\s+)?`([^`]+)`/i;
const simple = new RegExp(`^${directive.source}[.!]?$`, "i");
export function pathBoundary(item: PlanItem) {
  if (item.kind !== "constraint") return null;
  const match = item.text.match(directive);
  return match
    ? {
        path: match[1],
        simple: !hasPlanCondition(item.text) && simple.test(item.title.trim()),
      }
    : null;
}
export function policyPathMatches(path: string, reference: string) {
  const p = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const r = reference
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (!r || r.split("/").includes("..")) return false;
  try {
    return p === r || p.startsWith(`${r}/`) || matchesGlob(p, r);
  } catch {
    return false;
  }
}
export interface PolicyEvaluation {
  authorId?: string;
  membershipEpoch?: number;
  now?: number;
  observedAt?: string;
  observedPlanVersion?: number;
  observedMembershipEpoch?: number;
}
function eligible(team: Team, e: PlanException): boolean {
  return (
    !!e &&
    typeof e === "object" &&
    !e.restoredInactive &&
    team.graph?.exceptionPolicyVersion === 1 &&
    e.approvedBy === team.ownerId &&
    typeof e.id === "string" &&
    typeof e.requirementId === "string" &&
    Array.isArray(e.authorIds) &&
    e.authorIds.every((id) => typeof id === "string") &&
    Array.isArray(e.paths) &&
    e.paths.every((path) => typeof path === "string") &&
    (!e.revokedAt || Number.isFinite(Date.parse(e.revokedAt))) &&
    Number.isFinite(Date.parse(e.approvedAt)) &&
    Number.isFinite(Date.parse(e.expiresAt)) &&
    Date.parse(e.expiresAt) > Date.parse(e.approvedAt)
  );
}
export function activeExceptionIds(
  team: Team,
  membershipEpoch = 0,
  now = Date.now(),
): string[] {
  return (team.graph?.exceptions ?? [])
    .filter(
      (e) =>
        eligible(team, e) &&
        !e.revokedAt &&
        e.planVersion === team.version &&
        e.membershipEpoch === membershipEpoch &&
        Date.parse(e.approvedAt) <= now &&
        now < Date.parse(e.expiresAt),
    )
    .map((e) => e.id)
    .sort();
}
export function exceptionPolicyKey(
  team: Team,
  membershipEpoch = 0,
  now = Date.now(),
) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: team.graph?.exceptionPolicyVersion ?? 0,
        active: activeExceptionIds(team, membershipEpoch, now),
      }),
    )
    .digest("hex");
}
export function exceptionCoverage(
  team: Team,
  requirementId: string,
  path: string,
  context: PolicyEvaluation,
): "approved" | "historical" | "none" {
  if (!context.authorId) return "none";
  const now = context.now ?? Date.now();
  const observed = context.observedAt ? Date.parse(context.observedAt) : now;
  if (!Number.isFinite(observed) || observed > now + 30_000) return "none";
  let historical = false;
  const normalize = (value: string) => value.replaceAll("\\", "/");
  for (const e of team.graph?.exceptions ?? []) {
    if (
      !eligible(team, e) ||
      e.requirementId !== requirementId ||
      !e.authorIds.includes(context.authorId) ||
      !e.paths.some((p) => normalize(p) === normalize(path))
    )
      continue;
    const began = Date.parse(e.approvedAt),
      ended = Math.min(
        Date.parse(e.expiresAt),
        e.revokedAt ? Date.parse(e.revokedAt) : Infinity,
      );
    if (!(began <= observed && observed < ended)) continue;
    if (
      e.planVersion !== (context.observedPlanVersion ?? team.version) ||
      e.membershipEpoch !==
        (context.observedMembershipEpoch ?? context.membershipEpoch ?? 0)
    )
      continue;
    if (
      e.planVersion === team.version &&
      e.membershipEpoch === (context.membershipEpoch ?? 0) &&
      !e.revokedAt &&
      began <= now &&
      now < ended
    )
      return "approved";
    historical = true;
  }
  return historical ? "historical" : "none";
}

export function currentExceptionAgreement(
  store: Store,
  teamId: string,
  approvedBy: string,
  plan: number,
  graph: number,
) {
  const team = store.team(teamId);
  if (approvedBy !== team.ownerId)
    throw new Error("Only the team manager can approve plan exceptions");
  if (team.version !== plan || (team.graph?.version ?? 0) !== graph)
    throw new Error(
      "The plan or agreements changed; refresh before changing exceptions",
    );
  return team;
}
function exactPath(value: unknown): string {
  const path = requiredText(value, "Exception file path", 240).replaceAll(
    "\\",
    "/",
  );
  if (
    path !== path.trim() ||
    path.startsWith("/") ||
    /[:*?\[\]{}!\x00-\x1f]/.test(path) ||
    path.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error(
      "Choose exact relative file paths without globs or traversal",
    );
  return path;
}
export function preparePlanException(
  store: Store,
  teamId: string,
  approvedBy: string,
  id: string,
  request: PlanExceptionRequest,
  now = Date.now(),
) {
  const team = currentExceptionAgreement(
    store,
    teamId,
    approvedBy,
    request.expectedPlanVersion,
    request.expectedGraphVersion,
  );
  requiredText(id, "Exception ID", 100);
  const item = team.items.find((item) => item.id === request.requirementId);
  const boundary = item && pathBoundary(item);
  if (!item || !boundary?.simple)
    throw new Error(
      "Choose a current supported, unconditional forbidden-path requirement",
    );
  if (
    !Array.isArray(request.paths) ||
    request.paths.length < 1 ||
    request.paths.length > 20
  )
    throw new Error("Choose 1 to 20 exact file paths");
  const paths = [...new Set(request.paths.map(exactPath))];
  if (paths.some((path) => !policyPathMatches(path, boundary.path)))
    throw new Error(
      "Exception paths must lie inside the selected requirement boundary",
    );
  const members = new Set(store.members(teamId).map((member) => member.id));
  if (
    !Array.isArray(request.authorIds) ||
    request.authorIds.length < 1 ||
    request.authorIds.length > 20 ||
    request.authorIds.some((id) => typeof id !== "string" || !members.has(id))
  )
    throw new Error("Choose current approved authors for the exception");
  if (
    typeof request.expiresAt !== "string" ||
    !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(request.expiresAt)
  )
    throw new Error(
      "Choose an explicit ISO expiry time including its timezone",
    );
  const expires = Date.parse(request.expiresAt);
  if (
    !Number.isFinite(expires) ||
    expires <= now ||
    expires > now + 30 * 86400000
  )
    throw new Error(
      "Exception expiry must be in the future and within 30 days",
    );
  const existing = (team.graph?.exceptions ?? []).filter(
    (e) => e.planVersion === team.version,
  );
  if ((team.graph?.exceptions ?? []).some((e) => e.id === id))
    throw new Error("Exception ID already exists");
  if (existing.length >= 50)
    throw new Error(
      "This team's exception history reached its limit; review the core plan before adding more",
    );
  const record: PlanException = {
    id,
    requirementId: item.id,
    planVersion: team.version,
    membershipEpoch: store.setting(`membershipEpoch:${teamId}`, 0),
    authorIds: [...new Set(request.authorIds)],
    paths,
    reason: requiredText(request.reason, "Exception reason", 1000).trim(),
    approvedBy,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(expires).toISOString(),
  };
  if (
    Buffer.byteLength(
      JSON.stringify({
        ...team,
        graph: { ...team.graph, exceptions: [...existing, record] },
      }),
    ) >
    512 * 1024
  )
    throw new Error("Shared exception agreements exceed their size limit");
  return { team, record };
}
export function approvePlanException(
  store: Store,
  teamId: string,
  approvedBy: string,
  id: string,
  request: PlanExceptionRequest,
  now = Date.now(),
): PlanException {
  return store.transaction(() => {
    const { team, record } = preparePlanException(
      store,
      teamId,
      approvedBy,
      id,
      request,
      now,
    );
    const graph: PlanGraph = team.graph ?? {
      version: 0,
      modules: [],
      contracts: [],
      dependencies: [],
    };
    store.putTeam({
      ...team,
      graph: {
        ...graph,
        version: graph.version + 1,
        exceptionPolicyVersion: 1,
        exceptions: [
          ...(graph.exceptions ?? []).filter(
            (e) => e.planVersion === team.version,
          ),
          record,
        ],
      },
    });
    store.appendSync(teamId, "plan-exception", {
      id: `exception-approved:${id}`,
      action: "approved",
      record,
    });
    return record;
  });
}
export function revokePlanException(
  store: Store,
  teamId: string,
  approvedBy: string,
  id: string,
  plan: number,
  graphVersion: number,
  now = Date.now(),
) {
  return store.transaction(() => {
    const team = currentExceptionAgreement(
      store,
      teamId,
      approvedBy,
      plan,
      graphVersion,
    );
    const record = team.graph?.exceptions?.find((record) => record.id === id);
    if (!record) throw new Error("Exception not found");
    if (record.revokedAt) return;
    const revoked = { ...record, revokedAt: new Date(now).toISOString() };
    store.putTeam({
      ...team,
      graph: {
        ...team.graph!,
        version: team.graph!.version + 1,
        exceptions: team.graph!.exceptions!.map((e) =>
          e.id === id ? revoked : e,
        ),
      },
    });
    store.appendSync(teamId, "plan-exception", {
      id: `exception-revoked:${id}`,
      action: "revoked",
      record: revoked,
    });
  });
}
