import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  computeAnchorPlacement,
  createWindowTracker,
  DefaultWindowsProbe,
  CandidateWindow,
  EditorKind,
  NativeProbe,
  PlacementInput,
  TrackerState,
  WindowBinding,
  WindowSnapshot,
} from '../src/integrations/window-anchor/index.js';

/**
 * Deterministic fake probe for unit testing all state transitions,
 * platform limits, ambiguity, handle reuse, and timeouts without live OS handles.
 */
class FakeNativeProbe implements NativeProbe {
  public supported = true;
  public candidates: CandidateWindow[] = [];
  public snapshots: Map<string, WindowSnapshot | null> = new Map();
  public disposeCount = 0;
  public throwOnList = false;
  public throwOnSnapshot = false;

  public isSupportedPlatform(): boolean {
    return this.supported;
  }

  public async listCandidates(editor: EditorKind): Promise<CandidateWindow[]> {
    if (this.throwOnList) {
      throw new Error('Simulated listCandidates error');
    }
    return this.candidates.filter((c) => c.editor === editor);
  }

  public async getSnapshot(
    windowId: string,
    processId?: number,
    editor?: EditorKind
  ): Promise<WindowSnapshot | null> {
    if (this.throwOnSnapshot) {
      throw new Error('Simulated getSnapshot error');
    }
    const snap = this.snapshots.get(windowId);
    if (!snap) return null;
    return snap;
  }

  public async dispose(): Promise<void> {
    this.disposeCount++;
  }
}

describe('COBBLE-WINDOW-01: Windows IDE Window Anchor Test Suite', () => {
  // --------------------------------------------------------------------------
  // Group 1: No binding, no matching editor, unsupported platform, missing helper
  // --------------------------------------------------------------------------
  describe('Group 1: Initial States & Missing Prerequisites', () => {
    it('reports status "unbound" when tracker starts with no binding', async () => {
      const probe = new FakeNativeProbe();
      const tracker = createWindowTracker({ probe });
      const states: TrackerState[] = [];

      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      assert.equal(states[0].status, 'unbound');
      assert.equal(states[0].snapshot, null);
    });

    it('reports status "unbound" when binding is provided without windowId and no matching candidates exist', async () => {
      const probe = new FakeNativeProbe();
      const tracker = createWindowTracker({ probe });
      tracker.bind({ workspace: 'C:\\test', editor: 'vscode' });

      const states: TrackerState[] = [];
      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      assert.equal(states[0].status, 'unbound');
      assert.match(states[0].reason || '', /No candidate windows found/i);
    });

    it('reports status "unavailable" on an unsupported platform', async () => {
      const probe = new FakeNativeProbe();
      probe.supported = false; // Simulate Linux or macOS
      const tracker = createWindowTracker({ probe });

      const states: TrackerState[] = [];
      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      assert.equal(states[0].status, 'unavailable');
      assert.match(states[0].reason || '', /Unsupported platform/i);
    });

    it('handles missing helper script by reporting status "unavailable" instead of crashing', async () => {
      // Point DefaultWindowsProbe to a non-existent path
      const missingPath = 'C:\\non-existent-directory\\missing-helper.ps1';
      const realProbe = new DefaultWindowsProbe(missingPath);
      const tracker = createWindowTracker({ probe: realProbe });
      tracker.bind({ workspace: 'C:\\test', editor: 'antigravity', windowId: '0x1234' });

      const states: TrackerState[] = [];
      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      assert.equal(states[0].status, 'unavailable');
      assert.match(states[0].reason || '', /helper/i);
    });
  });

  // --------------------------------------------------------------------------
  // Group 2: Multiple candidate windows with similar titles => ambiguous
  // --------------------------------------------------------------------------
  describe('Group 2: Ambiguity and Candidate Enumeration', () => {
    it('returns status "ambiguous" with candidate list when multiple windows match editor without an explicit windowId', async () => {
      const probe = new FakeNativeProbe();
      probe.candidates = [
        {
          windowId: '0x1001',
          processId: 5001,
          editor: 'antigravity',
          title: 'Project Alpha - Cobble [Antigravity]',
        },
        {
          windowId: '0x1002',
          processId: 5002,
          editor: 'antigravity',
          title: 'Project Beta - Cobble [Antigravity]',
        },
      ];

      const tracker = createWindowTracker({ probe });
      tracker.bind({ workspace: 'C:\\projects\\alpha', editor: 'antigravity' });

      const states: TrackerState[] = [];
      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      const lastState = states[states.length - 1];
      assert.equal(lastState.status, 'ambiguous');
      assert.equal(lastState.snapshot, null);
      assert.equal(lastState.candidates?.length, 2);
      assert.equal(lastState.candidates![0].windowId, '0x1001');
      assert.equal(lastState.candidates![1].windowId, '0x1002');
    });

    it('listCandidates returns opaque native window IDs and process metadata', async () => {
      const probe = new FakeNativeProbe();
      probe.candidates = [
        {
          windowId: '0xDEADBEEF0',
          processId: 9624,
          editor: 'vscode',
          title: 'Cobble - Visual Studio Code',
        },
      ];

      const tracker = createWindowTracker({ probe });
      const candidates = await tracker.listCandidates('vscode');

      assert.equal(candidates.length, 1);
      assert.equal(candidates[0].windowId, '0xDEADBEEF0');
      assert.equal(candidates[0].processId, 9624);
      assert.equal(candidates[0].editor, 'vscode');
    });
  });

  // --------------------------------------------------------------------------
  // Group 3: Explicit binding follows target window; rejects handle reuse/mismatch
  // --------------------------------------------------------------------------
  describe('Group 3: Explicit Binding & Handle Re-validation', () => {
    it('tracks the target native window when explicit windowId and PID match', async () => {
      const probe = new FakeNativeProbe();
      probe.snapshots.set('0x2001', {
        windowId: '0x2001',
        processId: 4200,
        editor: 'antigravity',
        title: 'Antigravity IDE Window',
        boundsPhysical: { x: 100, y: 100, width: 1200, height: 800 },
        coordinateSpace: 'physical-pixels',
        focused: true,
        minimized: false,
        visible: true,
        observedAt: Date.now(),
      });

      const tracker = createWindowTracker({ probe });
      tracker.bind({
        workspace: 'C:\\app',
        editor: 'antigravity',
        windowId: '0x2001',
        processId: 4200,
      });

      const states: TrackerState[] = [];
      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      const state = states[0];
      assert.equal(state.status, 'tracking');
      assert.ok(state.snapshot);
      assert.equal(state.snapshot.windowId, '0x2001');
      assert.equal(state.snapshot.processId, 4200);
      assert.equal(state.snapshot.coordinateSpace, 'physical-pixels');
    });

    it('rejects stale or recycled window handle when PID changes', async () => {
      const probe = new FakeNativeProbe();
      // Handle 0x2001 was recycled by OS and now belongs to PID 9999 (different process)
      probe.snapshots.set('0x2001', {
        windowId: '0x2001',
        processId: 9999,
        editor: 'antigravity',
        title: 'Unrelated Process Window',
        boundsPhysical: { x: 0, y: 0, width: 800, height: 600 },
        coordinateSpace: 'physical-pixels',
        focused: false,
        minimized: false,
        visible: true,
        observedAt: Date.now(),
      });

      const tracker = createWindowTracker({ probe });
      tracker.bind({
        workspace: 'C:\\app',
        editor: 'antigravity',
        windowId: '0x2001',
        processId: 4200, // Expected PID was 4200
      });

      const states: TrackerState[] = [];
      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      const state = states[0];
      assert.equal(state.status, 'unavailable');
      assert.equal(state.snapshot, null);
      assert.match(state.reason || '', /recycled/i);
    });

    it('rejects stale window handle when editor type changes', async () => {
      const probe = new FakeNativeProbe();
      probe.snapshots.set('0x3001', {
        windowId: '0x3001',
        processId: 8000,
        editor: 'cursor', // Snapshot reports cursor
        title: 'Cursor Window',
        boundsPhysical: { x: 0, y: 0, width: 800, height: 600 },
        coordinateSpace: 'physical-pixels',
        focused: false,
        minimized: false,
        visible: true,
        observedAt: Date.now(),
      });

      const tracker = createWindowTracker({ probe });
      tracker.bind({
        workspace: 'C:\\app',
        editor: 'vscode', // Binding expected vscode
        windowId: '0x3001',
      });

      const states: TrackerState[] = [];
      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      assert.equal(states[0].status, 'unavailable');
      assert.match(states[0].reason || '', /editor changed/i);
    });
  });

  // --------------------------------------------------------------------------
  // Group 4: Closed, hidden, minimized, and unfocused states
  // --------------------------------------------------------------------------
  describe('Group 4: Closed, Hidden, Minimized, and Focus Transitions', () => {
    it('transitions to status "closed" when bound window handle becomes invalid', async () => {
      const probe = new FakeNativeProbe();
      probe.snapshots.set('0x4001', null); // null represents destroyed window

      const tracker = createWindowTracker({ probe });
      tracker.bind({
        workspace: 'C:\\app',
        editor: 'antigravity',
        windowId: '0x4001',
      });

      const states: TrackerState[] = [];
      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      assert.equal(states[0].status, 'closed');
      assert.equal(states[0].snapshot, null);
    });

    it('faithfully reports minimized, hidden, and focus flags in snapshot', async () => {
      const probe = new FakeNativeProbe();
      probe.snapshots.set('0x4002', {
        windowId: '0x4002',
        processId: 4400,
        editor: 'vscode',
        title: 'Minimized VS Code',
        boundsPhysical: { x: -32000, y: -32000, width: 160, height: 28 },
        coordinateSpace: 'physical-pixels',
        focused: false,
        minimized: true,
        visible: false,
        observedAt: Date.now(),
      });

      const tracker = createWindowTracker({ probe });
      tracker.bind({
        workspace: 'C:\\app',
        editor: 'vscode',
        windowId: '0x4002',
      });

      const states: TrackerState[] = [];
      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      assert.equal(states[0].status, 'tracking');
      assert.equal(states[0].snapshot?.minimized, true);
      assert.equal(states[0].snapshot?.visible, false);
      assert.equal(states[0].snapshot?.focused, false);
    });
  });

  // --------------------------------------------------------------------------
  // Group 5: Interacting with Cobble does not cause companion to disappear
  // --------------------------------------------------------------------------
  describe('Group 5: Companion Interaction Safety', () => {
    const baseInput: PlacementInput = {
      ideBoundsDip: { x: 100, y: 100, width: 1200, height: 800 },
      workAreaDip: { x: 0, y: 0, width: 1920, height: 1080 },
      companionSizeDip: { width: 120, height: 120 },
      preferredEdge: 'right',
      offsetDip: { x: 0, y: 0 },
      dragging: false,
      editorFocused: false, // Editor lost focus to Cobble's popup menu
      editorMinimized: false,
      editorVisible: true,
      companionInteracting: true, // User interacting with Cobble menu
    };

    it('keeps companion visible when editor loses focus while companion is interacting', () => {
      const result = computeAnchorPlacement(baseInput);
      assert.equal(result.visible, true);
      assert.equal(result.shouldMove, true);
      assert.ok(result.boundsDip);
    });

    it('keeps companion visible and stationary when editor is minimized while companion is interacting', () => {
      const input: PlacementInput = {
        ...baseInput,
        editorMinimized: true,
        companionInteracting: true,
      };
      const result = computeAnchorPlacement(input);
      assert.equal(result.visible, true);
      assert.equal(result.shouldMove, false);
      assert.equal(result.boundsDip, null);
      assert.match(result.reason || '', /companion interaction is active/i);
    });

    it('hides companion when editor is minimized and companion is NOT interacting', () => {
      const input: PlacementInput = {
        ...baseInput,
        editorMinimized: true,
        companionInteracting: false,
      };
      const result = computeAnchorPlacement(input);
      assert.equal(result.visible, false);
      assert.equal(result.shouldMove, false);
      assert.equal(result.boundsDip, null);
    });
  });

  // --------------------------------------------------------------------------
  // Group 6: Dragging state returns shouldMove: false; release resumes placement
  // --------------------------------------------------------------------------
  describe('Group 6: Dragging State Machine Interaction', () => {
    const baseInput: PlacementInput = {
      ideBoundsDip: { x: 200, y: 200, width: 1000, height: 700 },
      workAreaDip: { x: 0, y: 0, width: 1920, height: 1080 },
      companionSizeDip: { width: 80, height: 80 },
      preferredEdge: 'right',
      offsetDip: { x: 10, y: 20 },
      dragging: true,
      editorFocused: true,
      editorMinimized: false,
      editorVisible: true,
      companionInteracting: false,
    };

    it('returns visible: true, shouldMove: false, boundsDip: null during drag', () => {
      const result = computeAnchorPlacement(baseInput);
      assert.equal(result.visible, true);
      assert.equal(result.shouldMove, false);
      assert.equal(result.boundsDip, null);
      assert.match(result.reason || '', /drag/i);
    });

    it('resumes calculating placement coordinates once dragging is released', () => {
      const releasedInput: PlacementInput = {
        ...baseInput,
        dragging: false,
      };
      const result = computeAnchorPlacement(releasedInput);
      assert.equal(result.visible, true);
      assert.equal(result.shouldMove, true);
      assert.ok(result.boundsDip);
      // Right edge: x = ide.x + ide.width + offset.x = 200 + 1000 + 10 = 1210
      assert.equal(result.boundsDip.x, 1210);
      assert.equal(result.boundsDip.y, 220);
    });
  });

  // --------------------------------------------------------------------------
  // Group 7: Pure Placement Geometry, Edges, Off-screen, Work-area Clamping
  // --------------------------------------------------------------------------
  describe('Group 7: Pure Placement Geometry & Bounds Clamping', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
    const ide = { x: 500, y: 200, width: 800, height: 600 };
    const companion = { width: 100, height: 100 };
    const zeroOffset = { x: 0, y: 0 };

    it('computes correct placement for "left" preferredEdge', () => {
      const res = computeAnchorPlacement({
        ideBoundsDip: ide,
        workAreaDip: workArea,
        companionSizeDip: companion,
        preferredEdge: 'left',
        offsetDip: zeroOffset,
        dragging: false,
        editorFocused: true,
        editorMinimized: false,
        editorVisible: true,
        companionInteracting: false,
      });
      assert.equal(res.visible, true);
      assert.equal(res.shouldMove, true);
      // left: ide.x - companion.width = 500 - 100 = 400
      assert.deepEqual(res.boundsDip, { x: 400, y: 200, width: 100, height: 100 });
    });

    it('computes correct placement for "right" preferredEdge', () => {
      const res = computeAnchorPlacement({
        ideBoundsDip: ide,
        workAreaDip: workArea,
        companionSizeDip: companion,
        preferredEdge: 'right',
        offsetDip: zeroOffset,
        dragging: false,
        editorFocused: true,
        editorMinimized: false,
        editorVisible: true,
        companionInteracting: false,
      });
      // right: ide.x + ide.width = 500 + 800 = 1300
      assert.deepEqual(res.boundsDip, { x: 1300, y: 200, width: 100, height: 100 });
    });

    it('computes correct placement for "top" preferredEdge', () => {
      const res = computeAnchorPlacement({
        ideBoundsDip: ide,
        workAreaDip: workArea,
        companionSizeDip: companion,
        preferredEdge: 'top',
        offsetDip: zeroOffset,
        dragging: false,
        editorFocused: true,
        editorMinimized: false,
        editorVisible: true,
        companionInteracting: false,
      });
      // top: ide.y - companion.height = 200 - 100 = 100
      assert.deepEqual(res.boundsDip, { x: 500, y: 100, width: 100, height: 100 });
    });

    it('computes correct placement for "bottom" preferredEdge', () => {
      const res = computeAnchorPlacement({
        ideBoundsDip: ide,
        workAreaDip: workArea,
        companionSizeDip: companion,
        preferredEdge: 'bottom',
        offsetDip: zeroOffset,
        dragging: false,
        editorFocused: true,
        editorMinimized: false,
        editorVisible: true,
        companionInteracting: false,
      });
      // bottom: ide.y + ide.height = 200 + 600 = 800
      assert.deepEqual(res.boundsDip, { x: 500, y: 800, width: 100, height: 100 });
    });

    it('handles negative monitor coordinates on secondary display', () => {
      const negativeWorkArea = { x: -1920, y: 0, width: 1920, height: 1080 };
      const negativeIde = { x: -1000, y: 100, width: 800, height: 600 };
      const res = computeAnchorPlacement({
        ideBoundsDip: negativeIde,
        workAreaDip: negativeWorkArea,
        companionSizeDip: companion,
        preferredEdge: 'left',
        offsetDip: zeroOffset,
        dragging: false,
        editorFocused: true,
        editorMinimized: false,
        editorVisible: true,
        companionInteracting: false,
      });
      // -1000 - 100 = -1100
      assert.equal(res.visible, true);
      assert.equal(res.boundsDip?.x, -1100);
      assert.equal(res.boundsDip?.y, 100);
    });

    it('clamps companion inside work area if ideal edge overflows monitor boundary', () => {
      const nearRightEdgeIde = { x: 1850, y: 100, width: 200, height: 400 };
      const res = computeAnchorPlacement({
        ideBoundsDip: nearRightEdgeIde,
        workAreaDip: workArea, // width: 1920
        companionSizeDip: companion, // width: 100
        preferredEdge: 'right', // ideal x = 1850 + 200 = 2050 (overflows 1920)
        offsetDip: zeroOffset,
        dragging: false,
        editorFocused: true,
        editorMinimized: false,
        editorVisible: true,
        companionInteracting: false,
      });
      assert.equal(res.visible, true);
      // Max clamped X: 1920 - 100 = 1820
      assert.equal(res.boundsDip?.x, 1820);
    });

    it('safely handles completely off-screen editor', () => {
      const offScreenIde = { x: 5000, y: 5000, width: 800, height: 600 };
      const res = computeAnchorPlacement({
        ideBoundsDip: offScreenIde,
        workAreaDip: workArea,
        companionSizeDip: companion,
        preferredEdge: 'right',
        offsetDip: zeroOffset,
        dragging: false,
        editorFocused: false,
        editorMinimized: false,
        editorVisible: true,
        companionInteracting: false,
      });
      assert.equal(res.visible, false);
      assert.equal(res.shouldMove, false);
      assert.equal(res.boundsDip, null);
    });

    it('safely clamps in tiny work area smaller than companion without throwing', () => {
      const tinyWorkArea = { x: 10, y: 10, width: 50, height: 50 };
      const smallIde = { x: 10, y: 10, width: 30, height: 30 };
      const res = computeAnchorPlacement({
        ideBoundsDip: smallIde,
        workAreaDip: tinyWorkArea,
        companionSizeDip: { width: 100, height: 100 },
        preferredEdge: 'right',
        offsetDip: zeroOffset,
        dragging: false,
        editorFocused: true,
        editorMinimized: false,
        editorVisible: true,
        companionInteracting: false,
      });
      assert.equal(res.visible, true);
      assert.equal(res.boundsDip?.x, 10);
      assert.equal(res.boundsDip?.y, 10);
    });

    it('rejects invalid or non-finite rectangles (NaN, Infinity, zero width/height)', () => {
      const invalidInput: PlacementInput = {
        ideBoundsDip: { x: NaN, y: 0, width: 100, height: 100 },
        workAreaDip: workArea,
        companionSizeDip: companion,
        preferredEdge: 'left',
        offsetDip: zeroOffset,
        dragging: false,
        editorFocused: true,
        editorMinimized: false,
        editorVisible: true,
        companionInteracting: false,
      };
      const res = computeAnchorPlacement(invalidInput);
      assert.equal(res.visible, false);
      assert.equal(res.shouldMove, false);
      assert.equal(res.boundsDip, null);
      assert.match(res.reason || '', /invalid/i);
    });
  });

  // --------------------------------------------------------------------------
  // Group 8: Coordinate space truthfulness (physical vs DIP)
  // --------------------------------------------------------------------------
  describe('Group 8: Coordinate Space Truthfulness', () => {
    it('ensures native window snapshot reports coordinateSpace as "physical-pixels"', async () => {
      const probe = new FakeNativeProbe();
      probe.snapshots.set('0x8001', {
        windowId: '0x8001',
        processId: 1000,
        editor: 'vscode',
        title: 'VS Code',
        boundsPhysical: { x: 1920, y: 0, width: 1920, height: 1080 },
        coordinateSpace: 'physical-pixels',
        focused: true,
        minimized: false,
        visible: true,
        observedAt: Date.now(),
      });

      const tracker = createWindowTracker({ probe });
      tracker.bind({
        workspace: 'C:\\app',
        editor: 'vscode',
        windowId: '0x8001',
      });

      let observedSpace = '';
      await tracker.start((s) => {
        if (s.snapshot) observedSpace = s.snapshot.coordinateSpace;
      });
      await tracker.stop();

      assert.equal(observedSpace, 'physical-pixels');
    });

    it('ensures pure placement calculation consumes and returns DIP coordinates', () => {
      const dipIde = { x: 100, y: 100, width: 800, height: 600 };
      const dipWorkArea = { x: 0, y: 0, width: 1536, height: 864 };
      const res = computeAnchorPlacement({
        ideBoundsDip: dipIde,
        workAreaDip: dipWorkArea,
        companionSizeDip: { width: 100, height: 100 },
        preferredEdge: 'right',
        offsetDip: { x: 0, y: 0 },
        dragging: false,
        editorFocused: true,
        editorMinimized: false,
        editorVisible: true,
        companionInteracting: false,
      });
      assert.ok(res.boundsDip);
      assert.equal(res.boundsDip.x, 900);
      assert.equal(res.boundsDip.y, 100);
      assert.equal(res.boundsDip.width, 100);
      assert.equal(res.boundsDip.height, 100);
    });
  });

  // --------------------------------------------------------------------------
  // Group 9: Leak & Lifecycle checks (repeated start/stop and rebind)
  // --------------------------------------------------------------------------
  describe('Group 9: Leak & Lifecycle Management', () => {
    it('repeated start() and stop() cycles cleanly dispose probe and clear timers', async () => {
      const probe = new FakeNativeProbe();
      const tracker = createWindowTracker({ probe, pollIntervalMs: 50 });

      for (let i = 0; i < 5; i++) {
        let callCount = 0;
        await tracker.start(() => callCount++);
        await tracker.stop();
      }

      assert.equal(probe.disposeCount, 5);
    });

    it('repeated bind() calls update target cleanly without duplicating event callbacks', async () => {
      const probe = new FakeNativeProbe();
      probe.snapshots.set('0x9001', {
        windowId: '0x9001',
        processId: 101,
        editor: 'antigravity',
        title: 'Win 1',
        boundsPhysical: { x: 0, y: 0, width: 500, height: 500 },
        coordinateSpace: 'physical-pixels',
        focused: true,
        minimized: false,
        visible: true,
        observedAt: Date.now(),
      });
      probe.snapshots.set('0x9002', {
        windowId: '0x9002',
        processId: 102,
        editor: 'antigravity',
        title: 'Win 2',
        boundsPhysical: { x: 100, y: 100, width: 500, height: 500 },
        coordinateSpace: 'physical-pixels',
        focused: true,
        minimized: false,
        visible: true,
        observedAt: Date.now(),
      });

      const tracker = createWindowTracker({ probe, pollIntervalMs: 50 });
      const observedIds: string[] = [];

      await tracker.start((s) => {
        if (s.snapshot) observedIds.push(s.snapshot.windowId);
      });

      tracker.bind({ workspace: 'C:\\1', editor: 'antigravity', windowId: '0x9001' });
      await new Promise((r) => setTimeout(r, 60));
      tracker.bind({ workspace: 'C:\\2', editor: 'antigravity', windowId: '0x9002' });
      await new Promise((r) => setTimeout(r, 60));
      tracker.bind(null);
      await new Promise((r) => setTimeout(r, 60));

      await tracker.stop();

      // Should have tracked 0x9001 and 0x9002 across rebinds
      assert.ok(observedIds.includes('0x9001'));
      assert.ok(observedIds.includes('0x9002'));
    });
  });

  // --------------------------------------------------------------------------
  // Group 10: Helper error and timeout containment
  // --------------------------------------------------------------------------
  describe('Group 10: Helper Error & Timeout Resilience', () => {
    it('converts probe list exception into controlled status "unavailable"', async () => {
      const probe = new FakeNativeProbe();
      probe.throwOnList = true;

      const tracker = createWindowTracker({ probe });
      tracker.bind({ workspace: 'C:\\app', editor: 'antigravity' });

      const states: TrackerState[] = [];
      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      assert.equal(states[0].status, 'unavailable');
      assert.match(states[0].reason || '', /Simulated listCandidates error/i);
    });

    it('converts probe snapshot exception into controlled status "unavailable"', async () => {
      const probe = new FakeNativeProbe();
      probe.throwOnSnapshot = true;

      const tracker = createWindowTracker({ probe });
      tracker.bind({ workspace: 'C:\\app', editor: 'vscode', windowId: '0xERR' });

      const states: TrackerState[] = [];
      await tracker.start((s) => states.push(s));
      await tracker.stop();

      assert.ok(states.length > 0);
      assert.equal(states[0].status, 'unavailable');
      assert.match(states[0].reason || '', /Simulated getSnapshot error/i);
    });
  });
});
