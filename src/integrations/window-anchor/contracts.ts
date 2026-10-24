/**
 * Frozen Adapter API for Cobble (COBBLE-WINDOW-01 / G-01)
 * Defined per GEMINI-HANDOFF.md Section 5.
 * 
 * NOTE: Do NOT import Electron at module load.
 */

export type EditorKind = 'vscode' | 'cursor' | 'antigravity';
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CandidateWindow {
  windowId: string;       // opaque native handle encoded without numeric precision loss
  processId: number;
  editor: EditorKind;
  title: string;          // local selection aid; never logged/sent to a server
}

export interface WindowBinding {
  workspace: string;      // canonical local folder, provided by the caller
  editor: EditorKind;
  windowId?: string;      // explicit, user-confirmed selection if available
  processId?: number;     // a hint; extension-host PID may not own the native window
  workspaceName?: string; // optional hint only
}

export interface WindowSnapshot extends CandidateWindow {
  boundsPhysical: Rect;
  coordinateSpace: 'physical-pixels';
  focused: boolean;
  minimized: boolean;
  visible: boolean;
  observedAt: number;     // epoch milliseconds
}

export interface TrackerState {
  status: 'unbound' | 'tracking' | 'ambiguous' | 'unavailable' | 'closed';
  snapshot: WindowSnapshot | null;
  candidates?: CandidateWindow[];
  reason?: string;
}

/**
 * Internal probe abstraction to allow testing tracker state transitions
 * without depending on live native processes or OS handles.
 */
export interface NativeProbe {
  isSupportedPlatform(): boolean;
  listCandidates(editor: EditorKind): Promise<CandidateWindow[]>;
  getSnapshot(windowId: string, processId?: number, editor?: EditorKind): Promise<WindowSnapshot | null>;
  dispose(): Promise<void>;
}

export interface TrackerOptions {
  helperPath?: string;    // absolute packaged helper location supplied by caller
  pollIntervalMs?: number;
  probe?: NativeProbe;    // injectable probe for deterministic tests
}

export interface WindowTracker {
  listCandidates(editor: EditorKind): Promise<CandidateWindow[]>;
  bind(binding: WindowBinding | null): void;
  start(onChange: (state: TrackerState) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface PlacementInput {
  ideBoundsDip: Rect;     // caller converts native physical pixels to Electron DIP
  workAreaDip: Rect;      // corresponding display work area, same coordinate system
  companionSizeDip: { width: number; height: number };
  preferredEdge: Edge;
  offsetDip: { x: number; y: number };
  dragging: boolean;
  editorFocused: boolean;
  editorMinimized: boolean;
  editorVisible: boolean;
  companionInteracting: boolean;
}

export interface PlacementResult {
  visible: boolean;
  shouldMove: boolean;
  boundsDip: Rect | null;
  reason?: string;
}
