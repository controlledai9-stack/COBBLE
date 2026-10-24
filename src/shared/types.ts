export type Availability = "available" | "focused" | "away";
export type CompanionMode = "normal" | "idle" | "dragging";
export type Classification = "covered" | "required" | "uncertain" | "extra";
export type Tab = "Home" | "Chats" | "Teams" | "Invites" | "Profile";
export interface Profile {
  id: string;
  name: string;
  email: string;
  avatar: string;
  availability: Availability;
  speak: boolean;
}
export interface PlanItem {
  id: string;
  kind: "goal" | "feature" | "constraint" | "milestone";
  title: string;
  text: string;
  start: number;
  end: number;
}
export interface Team {
  id: string;
  name: string;
  code: string;
  ownerId: string;
  version: number;
  plan: string;
  items: PlanItem[];
  workspace: string;
  createdAt: string;
  graph?: PlanGraph;
}
export interface ModulePlan {
  id: string;
  name: string;
  ownerId?: string;
  ownerIds?: string[];
  pathGlob: string;
  planItemIds: string[];
  reviewerIds?: string[];
}
export interface ContractPlan {
  id: string;
  moduleId: string;
  path: string;
  name: string;
  kind: "function" | "interface" | "type" | "class" | "table" | "endpoint";
  signature: string;
  version: number;
}
export interface PlanGraph {
  version: number;
  modules: ModulePlan[];
  contracts: ContractPlan[];
  dependencies: { from: string; to: string; source?: "manual" | "observed" }[];
}
export interface ImpactFinding {
  type: "ownership" | "contract" | "new_entity";
  target: string;
  moduleId?: string;
  explanation: string;
}
export interface RevertPreview {
  activityId: string;
  token: string;
  files: { path: string; patch: string; canApply: boolean; reason?: string }[];
}
export interface Member {
  id: string;
  name: string;
  availability: Availability;
  role: "owner" | "member";
}
export interface WorkCompletion {
  id: string;
  teamId: string;
  itemId: string;
  itemTitle: string;
  planVersion: number;
  authorId: string;
  authorName: string;
  note: string;
  createdAt: string;
}
export interface MainProposal {
  id: string;
  teamId: string;
  title: string;
  authorId: string;
  authorName: string;
  sourceRef: string;
  sourceSha: string;
  targetRef: string;
  baseSha: string;
  planVersion: number;
  electorate: { id: string; name: string }[];
  membershipEpoch: number;
  policy: "unanimous" | "majority";
  votes: { memberId: string; choice: "yes" | "no"; createdAt: string }[];
  status: "open" | "approved" | "rejected" | "stale" | "integrated";
  createdAt: string;
  integratedSha?: string;
  staleReason?: string;
}
export interface AgentPayload {
  module: string;
  files_changed: string[];
  new_entities: { type: string; name: string; details: string }[];
  contract_changes: { entity: string; old_shape: string; new_shape: string }[];
  deviation_from_plan: boolean;
  deviation_reason: string;
  rich_explanation: string;
  severity_self_assessment: "info" | "soft" | "hard";
}
export interface Change {
  path: string;
  before: string | null;
  after: string | null;
}
export interface Assessment {
  classification: Classification;
  confidence: "high" | "low";
  explanation: string;
  planItemIds: string[];
  alert: boolean;
}
export interface Activity extends Assessment {
  id: string;
  teamId: string;
  authorId: string;
  authorName: string;
  source: "diff" | "agent";
  paths: string[];
  fingerprint: string;
  planVersion: number;
  createdAt: string;
  resolution: "kept" | "dismissed" | "reverted" | null;
  moduleIds?: string[];
  impactedMemberIds?: string[];
  findings?: ImpactFinding[];
  resolutionNote?: string;
  agentName?: string;
  agentExplanation?: string;
}
export interface ChatMessage {
  id: string;
  teamId: string;
  senderId: string;
  recipientId: string | null;
  content: string;
  sentVia: "text" | "voice";
  createdAt: string;
  state: "local" | "queued" | "sent" | "delivered";
  deliveredTo?: string[];
}
export interface IdeStatus {
  state: "disconnected" | "files" | "linked" | "lost";
  editor?: string;
  workspace?: string;
  lastSeen?: string;
  focused?: boolean;
  agent?: string;
  agentLastSeen?: string;
  processId?: number;
  workspaceName?: string;
}
export interface JoinRequest {
  id: string;
  name: string;
  deviceId: string;
  state: "pending" | "accepted" | "declined";
  createdAt: string;
}
export interface AppState {
  profile: Profile | null;
  teams: Team[];
  activeTeamId: string | null;
  members: Member[];
  activities: Activity[];
  messages: ChatMessage[];
  invites: JoinRequest[];
  ide: IdeStatus;
  paused: boolean;
  watching: boolean;
  companion: { mode: CompanionMode; availability: Availability };
  network: {
    role: "local" | "host" | "client";
    state: string;
    address?: string;
  };
  coverage: string[];
  planHistory: { version: number; source: string; createdAt: string }[];
  notifications: {
    id: string;
    title: string;
    detail: string;
    createdAt: string;
  }[];
  completions: WorkCompletion[];
  proposals: MainProposal[];
}
export interface VoiceDraft {
  type: "dm" | "broadcast" | "unrecognized" | "ambiguous";
  recipientId?: string;
  content: string;
}
export type Action =
  | {
      type: "profile";
      name: string;
      email: string;
      avatar?: string;
      speak?: boolean;
    }
  | { type: "createTeam"; name: string; plan: string; workspace?: string }
  | { type: "selectTeam"; teamId: string }
  | {
      type: "updatePlan";
      teamId: string;
      expectedVersion: number;
      plan: string;
    }
  | { type: "availability"; value: Availability }
  | { type: "pause"; paused: boolean }
  | {
      type: "send";
      recipientId: string | null;
      content: string;
      sentVia: "text" | "voice";
    }
  | { type: "resolve"; activityId: string; resolution: "kept" | "dismissed" }
  | { type: "observe" }
  | { type: "host" }
  | { type: "join"; address: string; code: string }
  | { type: "decideJoin"; requestId: string; accept: boolean };
export type ExtendedAction =
  | Action
  | { type: "completeWork"; itemId: string; note: string }
  | { type: "proposeMain"; title: string; sourceRef: string }
  | { type: "voteMain"; proposalId: string; choice: "yes" | "no" }
  | {
      type: "configureModule";
      name: string;
      pathGlob: string;
      ownerId?: string;
      ownerIds?: string[];
      planItemIds: string[];
      moduleId?: string;
      reviewerIds?: string[];
      dependsOn?: string[];
    }
  | { type: "captureContracts"; moduleId: string }
  | { type: "revokeMember"; memberId: string }
  | { type: "rotateCode" }
  | { type: "acknowledgeNotice"; id: string }
  | {
      type: "amendFromActivity";
      activityId: string;
      text: string;
      expectedVersion: number;
    };
export interface DesktopApi {
  state(): Promise<AppState>;
  action(action: ExtendedAction): Promise<AppState>;
  chooseWorkspace(): Promise<string | null>;
  onChange(callback: (state: AppState) => void): () => void;
  open(tab?: Tab, startVoice?: boolean): Promise<void>;
  companion(
    command:
      | "show"
      | "hide"
      | "interact"
      | "drag-start"
      | "drag-move"
      | "drag-end"
      | "menu-open"
      | "menu-close"
      | "pointer-on"
      | "pointer-off",
    point?: { x: number; y: number },
  ): Promise<void>;
  pairing(): Promise<{ port: number; token: string; workspace: string }>;
  transcribe(audio: ArrayBuffer): Promise<string>;
  bindWorkspace(): Promise<void>;
  report(): Promise<string>;
  artwork(): Promise<Partial<Record<CompanionMode, string>>>;
  copyPairing(): Promise<void>;
  connectIde(): Promise<string>;
  installAgent(agent: "claude" | "cursor", remove?: boolean): Promise<void>;
  previewRevert(activityId: string): Promise<RevertPreview>;
  applyRevert(activityId: string, token: string): Promise<void>;
  integrateMain(proposalId: string): Promise<void>;
  onCompanion(callback: (mode: CompanionMode) => void): () => void;
  onNavigate(callback: (tab: Tab, startVoice: boolean) => void): () => void;
}
