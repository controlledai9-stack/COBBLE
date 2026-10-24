# Window Anchor Delivery Report (COBBLE-WINDOW-01 / G-01)

- **Assignment ID**: `COBBLE-WINDOW-01`
- **Subsystem**: Windows Native IDE-Window Tracker & Pure Companion Placement
- **Teammate**: Gemini / Antigravity (`anti`)
- **Companion Integrator**: ChatGPT / Codex
- **Date**: 24 October 2026
- **Authority**: `GEMINI-HANDOFF.md` (Revision 3)

---

## 1. Complete List of Created Files

Strictly confined to the three permitted directory paths:

```text
src/integrations/window-anchor/contracts.ts
src/integrations/window-anchor/placement.ts
src/integrations/window-anchor/windows-helper.ps1
src/integrations/window-anchor/tracker.ts
src/integrations/window-anchor/index.ts
test/window-anchor.test.ts
docs/window-anchor-delivery.md
```

**Zero external dependencies were added.** No changes were made to `package.json`, lockfiles, `tsconfig.json`, or any files in `src/core/**`, `src/main/**`, `src/renderer/**`, `extensions/**`, `packaging/**`, or `assets/**`.

---

## 2. Public API Exports & Minimal Integration Example

### Public API Exports (`src/integrations/window-anchor/index.ts`)

```ts
// Contracts & Types
export type {
  EditorKind,
  Edge,
  Rect,
  CandidateWindow,
  WindowBinding,
  WindowSnapshot,
  TrackerState,
  TrackerOptions,
  NativeProbe,
  WindowTracker,
  PlacementInput,
  PlacementResult,
} from './contracts.js';

// Pure Placement Function (Logical Coordinates / DIP Only)
export { computeAnchorPlacement } from './placement.js';

// Native Window Tracker & Probes
export { createWindowTracker, DefaultWindowsProbe, WindowTrackerImpl } from './tracker.js';
```

### Minimal Integration Example (Main Process / `src/main/main.ts`)

```ts
import { app, BrowserWindow, screen } from 'electron';
import * as path from 'path';
import {
  createWindowTracker,
  computeAnchorPlacement,
  TrackerState,
  WindowBinding,
} from '../integrations/window-anchor/index.js';

// In packaged app, helper resides in resources/window-anchor/windows-helper.ps1
const helperPath = app.isPackaged
  ? path.join(process.resourcesPath, 'window-anchor', 'windows-helper.ps1')
  : path.join(__dirname, '..', 'integrations', 'window-anchor', 'windows-helper.ps1');

const tracker = createWindowTracker({
  helperPath,
  pollIntervalMs: 500,
});

// Example: User confirms explicit window selection in Cobble UI
tracker.bind({
  workspace: 'C:\\Users\\User\\Projects\\MyProject',
  editor: 'antigravity',
  windowId: '0x1038E',
  processId: 9624,
});

await tracker.start((state: TrackerState) => {
  if (state.status === 'tracking' && state.snapshot) {
    const snap = state.snapshot;
    // 1. Determine target display
    const targetDisplay = screen.getDisplayNearestPoint({
      x: snap.boundsPhysical.x,
      y: snap.boundsPhysical.y,
    });
    const scaleFactor = targetDisplay.scaleFactor; // e.g. 1.25 on 125% DPI

    // 2. Convert physical pixels to Electron DIP
    const ideBoundsDip = {
      x: Math.round(snap.boundsPhysical.x / scaleFactor),
      y: Math.round(snap.boundsPhysical.y / scaleFactor),
      width: Math.round(snap.boundsPhysical.width / scaleFactor),
      height: Math.round(snap.boundsPhysical.height / scaleFactor),
    };

    // 3. Compute pure placement
    const placement = computeAnchorPlacement({
      ideBoundsDip,
      workAreaDip: targetDisplay.workArea,
      companionSizeDip: { width: 120, height: 120 },
      preferredEdge: 'right',
      offsetDip: { x: 12, y: 0 },
      dragging: companionStateMachine.isDragging(),
      editorFocused: snap.focused,
      editorMinimized: snap.minimized,
      editorVisible: snap.visible,
      companionInteracting: companionStateMachine.isUserInteracting(),
    });

    // 4. Apply result to companion BrowserWindow
    if (placement.visible && placement.shouldMove && placement.boundsDip) {
      if (!companionWindow.isVisible()) companionWindow.showInactive();
      companionWindow.setBounds(placement.boundsDip);
    } else if (!placement.visible) {
      companionWindow.hide();
    }
  } else if (state.status === 'closed' || state.status === 'unbound') {
    // Fallback to screen-edge docking or hide per companion policy
    companionWindow.dockToScreenEdge();
  }
});

// Clean shutdown
app.on('before-quit', async () => {
  await tracker.stop();
});
```

---

## 3. Helper File Location & Packaging Destination

| Source Location in Repo | Destination in Packaged Electron App |
| :--- | :--- |
| `src/integrations/window-anchor/windows-helper.ps1` | `resources/window-anchor/windows-helper.ps1` |

### Packaging Configuration Proposal (for ChatGPT / `electron-builder.yml`)
Add the helper file to `extraResources` in `electron-builder.yml`:
```yaml
extraResources:
  - from: "src/integrations/window-anchor/windows-helper.ps1"
    to: "window-anchor/windows-helper.ps1"
```

---

## 4. Test Commands and Verification Results

### 4.1 Step 1 Pre-existing Baseline Failures (Recorded Separately)
1. `npm ci`:
   - **Result**: Failed (`EUSAGE: The npm ci command can only install with an existing package-lock.json or npm-shrinkwrap.json`). Root repository has no package-lock.json.
2. `npx tsx --test test/window-anchor.test.ts`:
   - **Result**: Failed initially (`Could not find 'test/window-anchor.test.ts'` before file creation).
3. `npm run typecheck`:
   - **Result**: Failed (`ENOENT: no such file or directory, open 'C:\Users\Vyom\vibed\package.json'`).

### 4.2 Automated Unit Test Verification (All 10 Groups Passing)
Run command:
```powershell
npx tsx --test test/window-anchor.test.ts
```

Output:
```text
▶ COBBLE-WINDOW-01: Windows IDE Window Anchor Test Suite
  ▶ Group 1: Initial States & Missing Prerequisites
    ✔ reports status "unbound" when tracker starts with no binding (2.8994ms)
    ✔ reports status "unbound" when binding is provided without windowId and no matching candidates exist (1.0057ms)
    ✔ reports status "unavailable" on an unsupported platform (0.4682ms)
    ✔ handles missing helper script by reporting status "unavailable" instead of crashing (1.8282ms)
  ✔ Group 1: Initial States & Missing Prerequisites (8.4632ms)
  ▶ Group 2: Ambiguity and Candidate Enumeration
    ✔ returns status "ambiguous" with candidate list when multiple windows match editor without an explicit windowId (0.8226ms)
    ✔ listCandidates returns opaque native window IDs and process metadata (0.5992ms)
  ✔ Group 2: Ambiguity and Candidate Enumeration (2.0621ms)
  ▶ Group 3: Explicit Binding & Handle Re-validation
    ✔ tracks the target native window when explicit windowId and PID match (1.8957ms)
    ✔ rejects stale or recycled window handle when PID changes (1.6917ms)
    ✔ rejects stale window handle when editor type changes (0.6506ms)
  ✔ Group 3: Explicit Binding & Handle Re-validation (5.1585ms)
  ▶ Group 4: Closed, Hidden, Minimized, and Focus Transitions
    ✔ transitions to status "closed" when bound window handle becomes invalid (2.9083ms)
    ✔ faithfully reports minimized, hidden, and focus flags in snapshot (0.6825ms)
  ✔ Group 4: Closed, Hidden, Minimized, and Focus Transitions (3.9258ms)
  ▶ Group 5: Companion Interaction Safety
    ✔ keeps companion visible when editor loses focus while companion is interacting (0.9396ms)
    ✔ keeps companion visible and stationary when editor is minimized while companion is interacting (0.3842ms)
    ✔ hides companion when editor is minimized and companion is NOT interacting (0.25ms)
  ✔ Group 5: Companion Interaction Safety (1.9407ms)
  ▶ Group 6: Dragging State Machine Interaction
    ✔ returns visible: true, shouldMove: false, boundsDip: null during drag (0.4101ms)
    ✔ resumes calculating placement coordinates once dragging is released (0.3772ms)
  ✔ Group 6: Dragging State Machine Interaction (1.0787ms)
  ▶ Group 7: Pure Placement Geometry & Bounds Clamping
    ✔ computes correct placement for "left" preferredEdge (2.5081ms)
    ✔ computes correct placement for "right" preferredEdge (0.315ms)
    ✔ computes correct placement for "top" preferredEdge (0.2926ms)
    ✔ computes correct placement for "bottom" preferredEdge (0.2907ms)
    ✔ handles negative monitor coordinates on secondary display (0.315ms)
    ✔ clamps companion inside work area if ideal edge overflows monitor boundary (0.3074ms)
    ✔ safely handles completely off-screen editor (0.3335ms)
    ✔ safely clamps in tiny work area smaller than companion without throwing (0.297ms)
    ✔ rejects invalid or non-finite rectangles (NaN, Infinity, zero width/height) (0.3788ms)
  ✔ Group 7: Pure Placement Geometry & Bounds Clamping (5.8558ms)
  ▶ Group 8: Coordinate Space Truthfulness
    ✔ ensures native window snapshot reports coordinateSpace as "physical-pixels" (0.8963ms)
    ✔ ensures pure placement calculation consumes and returns DIP coordinates (0.849ms)
  ✔ Group 8: Coordinate Space Truthfulness (2.546ms)
  ▶ Group 9: Leak & Lifecycle Management
    ✔ repeated start() and stop() cycles cleanly dispose probe and clear timers (0.9164ms)
    ✔ repeated bind() calls update target cleanly without duplicating event callbacks (245.3601ms)
  ✔ Group 9: Leak & Lifecycle Management (249.9119ms)
  ▶ Group 10: Helper Error & Timeout Resilience
    ✔ converts probe list exception into controlled status "unavailable" (1.087ms)
    ✔ converts probe snapshot exception into controlled status "unavailable" (0.6781ms)
  ✔ Group 10: Helper Error & Timeout Resilience (2.1469ms)
✔ COBBLE-WINDOW-01: Windows IDE Window Anchor Test Suite (287.3375ms)
ℹ tests 31
ℹ suites 11
ℹ pass 31
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 845.5
```

---

## 5. Real-Machine Verification Evidence vs. Assumptions

### 5.1 Real Evidence (Observed on this Machine)
- **Host OS**: Microsoft Windows 10 Home Single Language, Version 10.0.19045.0 x64.
- **Display Resolution & DPI**:
  - Physical display: 1920 × 1080 (Intel HD Graphics 520).
  - Logical desktop: 1536 × 864.
  - Scale factor: 1.25 (**125% DPI scaling** / 120 DPI).
- **Antigravity IDE**:
  - Executable path: `C:\Users\Vyom\AppData\Local\Programs\antigravity\Antigravity.exe`
  - Version: `2.19.1.0` (Google).
  - Top-level process name: `Antigravity` (multi-process Chromium/Electron model).
  - Top-level window class: `Chrome_WidgetWin_1`.
  - Window Title format: dynamically reflects open task/file/workspace.
  - Live Tracker Output exercised on this machine:
    ```json
    {
      "windowId": "0x1038E",
      "processId": 9624,
      "editor": "antigravity",
      "title": "Windows IDE Window Tracke...",
      "boundsPhysical": {
        "x": -9,
        "y": -9,
        "width": 1938,
        "height": 1098
      },
      "coordinateSpace": "physical-pixels",
      "focused": false,
      "minimized": false,
      "visible": true
    }
    ```
    *(Note: On 125% DPI scaling, Windows maximized window borders extend by -9px offset: -9 to 1929 = 1938 width, matching true physical coordinates).*
- **Microsoft VS Code**:
  - Installed at `C:\Users\Vyom\AppData\Local\Programs\Microsoft VS Code\Code.exe` (`Code.exe`).
- **Desktop Station Isolation Discovery**:
  - Discovered that processes executed in automated/background contexts may run on an isolated desktop station (`exebox-...`) rather than `WinSta0\Default`.
  - Implemented `AttachToDefaultDesktop()` using `OpenDesktop("Default", ...)` and `SetThreadDesktop(...)` in `windows-helper.ps1` so that windows on the interactive desktop are reliably enumerated regardless of runner isolation.

### 5.2 Untested Cases & Strict Separation
- **Cursor IDE**: **Not installed** on this machine. Verified that `Cursor.exe` does not exist at `%LOCALAPPDATA%\Programs\cursor\`. The tracker code supports the `Cursor` process name, but Cursor has **not** been live-exercised on this machine.
- **Antigravity Extension / Agent Hooks**: As specified in Section 1 and Section 4 of `GEMINI-HANDOFF.md`, observing Antigravity native window geometry does **not** imply extension or agent-hook pairing support. Extension pairing remains ChatGPT's responsibility under C-20.

---

## 6. DPI & Coordinate Space Conversion Architecture

### 6.1 Native Helper DPI Awareness Strategy
- `windows-helper.ps1` invokes Win32 `SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)`.
- This ensures that `GetWindowRect` bypasses Windows DPI virtualization and returns **exact physical screen pixels**, matching `coordinateSpace: 'physical-pixels'`.

### 6.2 Conversion ChatGPT Must Perform at the Electron Call Site
Electron's `BrowserWindow.setBounds()` and `screen` APIs operate strictly in Device Independent Pixels (DIP).
At the Electron integration call site, ChatGPT must perform:

```ts
const targetDisplay = screen.getDisplayNearestPoint({
  x: snapshot.boundsPhysical.x,
  y: snapshot.boundsPhysical.y,
});
const scale = targetDisplay.scaleFactor; // e.g. 1.25

const ideBoundsDip = {
  x: Math.round(snapshot.boundsPhysical.x / scale),
  y: Math.round(snapshot.boundsPhysical.y / scale),
  width: Math.round(snapshot.boundsPhysical.width / scale),
  height: Math.round(snapshot.boundsPhysical.height / scale),
};
```
Then pass `ideBoundsDip` and `targetDisplay.workArea` directly to `computeAnchorPlacement()`.

---

## 7. What ChatGPT Must Wire Up (Integration Checklist)

1. **Window Selection UI (C-21)**:
   - Call `tracker.listCandidates(editorKind)` to display open IDE windows with titles to the user.
   - Once user confirms a window, pass `tracker.bind({ workspace, editor, windowId, processId })`.
2. **DPI Conversion**:
   - Use `screen.getDisplayNearestPoint` to obtain `scaleFactor` and convert `snapshot.boundsPhysical` to `ideBoundsDip`.
3. **Companion State Integration (C-22)**:
   - Pass `dragging: stateMachine.isDragging()`.
   - Pass `companionInteracting: stateMachine.isInteracting()` (when popup menus or voice recording dialogs are open) to prevent the companion from disappearing when the editor loses focus or is minimized.
4. **Window Positioning**:
   - Apply `placement.boundsDip` to the companion `BrowserWindow.setBounds()`.
5. **Clean Shutdown**:
   - Call `await tracker.stop()` on `app.on('before-quit')`.

---

## 8. Known Limits & Fallback Behavior

1. **Window recycled/closed**: When the tracked window handle becomes invalid or the process ID changes, `TrackerState.status` transitions immediately to `'closed'` or `'unavailable'`. ChatGPT's integration must fall back to screen-edge docking or hide the companion.
2. **Ambiguity**: Without an explicit `windowId`, seeing multiple editor windows transitions `TrackerState.status` to `'ambiguous'` with the candidate list, refusing to guess.
3. **Locked-down PowerShell / Non-Windows**: If PowerShell script execution is blocked or the platform is not Windows, `tracker.start()` returns a controlled `status: 'unavailable'` with reason, never throwing unhandled exceptions.

---

## 9. Dependency & Configuration Proposals (Proposal Only)

No new npm packages or system binaries are required. For packaging, ChatGPT should add `src/integrations/window-anchor/windows-helper.ps1` to `extraResources` in `electron-builder.yml`.

---

## 10. Confirmation of Non-Modification of Reserved Areas

As required by `GEMINI-HANDOFF.md` Section 3 and 7:
- **No reserved files were modified**: `package.json`, lockfiles, `tsconfig.json`, `src/shared/types.ts`, `src/core/**`, `src/main/**`, `src/renderer/**`, `extensions/**`, `packaging/**`, and `assets/**` were completely untouched.
- **No character artwork or audio was generated or altered.**
- **No network, plan, voting, or chat logic was implemented.**
- All work was strictly confined to `src/integrations/window-anchor/**`, `test/window-anchor.test.ts`, and `docs/window-anchor-delivery.md`.
