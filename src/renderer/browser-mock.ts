import type {
  AppState,
  DesktopApi,
  ExtendedAction as Action,
  Profile,
  PlanItem,
  Member,
  Activity,
  ChatMessage,
  IdeStatus,
  HostingState,
} from "../shared/types";

export function createBrowserMockApi(): DesktopApi {
  const profile: Profile = {
    id: "demo-user",
    name: "Demo User",
    email: "demo@example.com",
    avatar: "",
    availability: "available",
    speak: false,
  };

  const planItems: PlanItem[] = [
    {
      id: "item-1",
      kind: "goal",
      title: "Demo Collaboration Hub",
      text: "Demo Collaboration Hub",
      start: 0,
      end: 23,
    },
    {
      id: "item-2",
      kind: "feature",
      title: "Real-time plan synchronization and drift detection",
      text: "Real-time plan synchronization and drift detection",
      start: 24,
      end: 74,
    },
    {
      id: "item-3",
      kind: "feature",
      title: "Local-first conflict observation across editor workspaces",
      text: "Local-first conflict observation across editor workspaces",
      start: 75,
      end: 137,
    },
    {
      id: "item-4",
      kind: "feature",
      title: "Calmer peer review with multi-agent assistance",
      text: "Calmer peer review with multi-agent assistance",
      start: 138,
      end: 185,
    },
  ];

  const members: Member[] = [
    {
      id: "demo-user",
      name: "Demo User",
      availability: "available",
      role: "owner",
    },
  ];

  const activities = [
    {
      id: "act-1",
      teamId: "team-demo",
      authorId: "demo-user",
      authorName: "Demo User",
      source: "diff",
      classification: "covered",
      confidence: "high",
      explanation: "Refined Apple continuous squircle design tokens and generous spacing",
      planItemIds: ["item-1"],
      paths: ["src/renderer/styles.css"],
      fingerprint: "demo-fp",
      planVersion: 1,
      createdAt: new Date().toISOString(),
    },
  ] as unknown as Activity[];

  const messages: ChatMessage[] = [
    {
      id: "msg-1",
      teamId: "team-demo",
      senderId: "demo-user",
      recipientId: null,
      content: "Cobble UI is live with continuous squircles and generous whitespace.",
      sentVia: "text",
      createdAt: new Date().toISOString(),
      state: "delivered",
    },
  ];

  const ide: IdeStatus = {
    state: "linked",
    editor: "Visual Studio Code",
    connections: [
      {
        id: "conn-1",
        editor: "Visual Studio Code",
        focused: true,
        lastSeen: new Date().toISOString(),
      },
    ],
  };

  const hosting: HostingState = {
    available: true,
    phase: "local",
    fenced: false,
    hostId: "demo-user",
    epoch: 1,
    automatic: true,
    allowThisDevice: true,
    advertisedAddress: "127.0.0.1:4040",
    candidates: [],
    reason: "Local host active",
  };

  let mockState: AppState = {
    profile,
    teams: [
      {
        id: "team-demo",
        name: "Demo Workspace",
        code: "DEMO-01",
        version: 1,
        ownerId: "demo-user",
        plan: "# Demo Collaboration Hub\n- Real-time plan synchronization and drift detection\n- Local-first conflict observation across editor workspaces\n- Calmer peer review with multi-agent assistance",
        items: planItems,
        workspace: "c:/dev/demo-workspace",
        createdAt: new Date().toISOString(),
        graph: {
          version: 1,
          modules: [
            {
              id: "mod-1",
              name: "Backend Core",
              pathGlob: "src/backend/**/*.ts",
              ownerIds: ["demo-user"],
              planItemIds: ["item-1"],
            },
            {
              id: "mod-2",
              name: "Sync & Network Protocol",
              pathGlob: "src/core/network/**/*.ts",
              ownerIds: ["demo-user"],
              planItemIds: ["item-2"],
            },
            {
              id: "mod-3",
              name: "Desktop UI & Theme Engine",
              pathGlob: "src/renderer/**/*.tsx",
              ownerIds: ["demo-user"],
              planItemIds: ["item-3"],
            },
          ],
          contracts: [],
          dependencies: [],
        },
      },
    ],
    activeTeamId: "team-demo",
    members,
    activities,
    messages,
    invites: [],
    ide,
    hosting,
    paused: false,
    watching: false,
    companion: { mode: "normal", visible: true, talking: false, anchorEdge: "right" },
    network: { mode: "local", peers: [] },
    coverage: { observedFiles: 10, ignoredFiles: 0 },
    planHistory: [],
    outOfPlan: [],
    mergeRequests: [],
    completedWork: [],
  } as unknown as AppState;

  const listeners = new Set<(s: AppState) => void>();
  const navListeners = new Set<(tab: any, voice?: boolean) => void>();

  const broadcast = () => {
    listeners.forEach((fn) => fn(mockState));
  };

  return {
    state: async () => mockState,
    action: async (action: Action) => {
      if (action.type === "profile") {
        mockState = {
          ...mockState,
          profile: {
            id: mockState.profile?.id ?? "demo-user",
            name: action.name,
            email: action.email,
            avatar: action.avatar ?? "",
            availability: mockState.profile?.availability ?? "available",
            speak: action.speak ?? false,
          },
        };
      } else if (action.type === "selectTeam") {
        mockState = { ...mockState, activeTeamId: action.teamId };
      } else if (action.type === "send") {
        const newMsg: ChatMessage = {
          id: `msg-${Date.now()}`,
          teamId: mockState.activeTeamId ?? "team-demo",
          senderId: mockState.profile?.id ?? "demo-user",
          recipientId: action.recipientId,
          content: action.content,
          sentVia: action.sentVia,
          createdAt: new Date().toISOString(),
          state: "delivered",
        };
        mockState = { ...mockState, messages: [...mockState.messages, newMsg] };
      }
      broadcast();
      return mockState;
    },
    onChange: (cb: (state: AppState) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onNavigate: (cb: (tab: any, voice?: boolean) => void) => {
      navListeners.add(cb);
      return () => navListeners.delete(cb);
    },
    chooseWorkspace: async () => "c:/dev/demo-workspace",
    detectIdes: async () => [
      {
        id: "vscode",
        name: "Visual Studio Code",
        running: true,
        integration: true,
      },
    ],
    connectIde: async () => "Visual Studio Code",
    previewRevert: async () => null,
    report: async () => "# Cobble Session Report\nApple HIG desktop UI active.",
    transcribe: async () => "Voice transcription preview",
    chatWindow: async () => ({ visible: true, minimized: false }),
    onChatWindowState: () => () => {},
    companion: async () => {},
    maintenance: async () => ({
      days: 30,
      cutoff: new Date().toISOString(),
      databaseBytes: 1024,
      activities: 1,
      messages: 1,
      queued: 0,
      revertBatches: 0,
      eligibleBatches: 0,
      eligibleBytes: 0,
    }),
    createBackup: async () => null,
    restoreBackupCopy: async () => null,
    pruneLocalHistory: async () => null,
    integrationDiagnostics: async () => ({
      platform: "browser",
      available: true,
      editors: [],
      limitations: [],
    }),
  } as unknown as DesktopApi;
}
