# Review of Vio's window adapter and robot assets

Reviewed by ChatGPT/Codex on 24 October 2026. Scope: merged PR #1, implementation commit `dcfe19d`, local main `204489d`. This is a source, test, failure-case and rendered-asset review. It is not a personal assessment of the contributor.

## Verdict

Keep the architecture and most of the implementation. It is a useful adapter foundation, but it is not ready to activate in the installed app. Correct the request protocol, startup/lifecycle races, focus policy and DPI guidance before integration. The robot files are three static SVG illustrations, not delivered animations. Their final use remains a product/artist decision.

No implementation or artwork files were changed during this review. Diagnostic scripts and fixture helpers are isolated under ignored `.cobble/window-anchor-review/`. This report records the findings; implementation fixes are still pending.

## Checks performed

| Check | Result and limit |
| --- | --- |
| Complete test suite | 61 passed: 30 existing core tests plus 31 new adapter tests |
| TypeScript typecheck | Passed |
| Application production build | Passed; the adapter is not imported by the app yet, so this is not packaged-adapter evidence |
| Additional failure-case probes | Reproduced response mismatch after timeout, stale state after unbind, timer creation after stop during startup, early-helper-exit startup hang, and a terminal disposed native probe |
| Real Windows helper startup | Started and returned an empty VS Code candidate list in this execution context; no live editor attachment was established here |
| Visual inspection | Rendered all three original SVG files in hidden Electron, at large and 96 × 110 px image-box sizes |
| Native API/DPI claims | Compared with official Electron and Microsoft documentation linked below |
| Changeset audit | Ten added files; no edits to core/main/renderer/build configuration or dependencies |

The passing suite does not contradict the failures below: its helper-error tests use immediately throwing fake probes rather than actual startup exits, delayed responses or a hung helper. Its DPI test supplies its own physical-pixel label; it does not independently measure native DPI behavior. Its restart test uses a fake probe that does not become disposed.

## Findings, ordered by priority

### R1 — High: a timed-out response can satisfy the wrong request

Location: `src/integrations/window-anchor/tracker.ts:117`, `:145` and the helper's request/response protocol.

`sendCommand` queues resolvers in FIFO order. A timeout removes a resolver, but the helper can still return its response later. The stdout handler gives that old response to the next pending request. There is no request ID or generation check. The helper also supports multiple externally requested enumerations alongside tracking polls.

Reproduction: a hidden fixture helper delays reply A by 250 ms. Request A is given a 50 ms timeout using the existing internal timeout argument; request B is then submitted. A times out, but B resolves with `{ "type": "reply", "marker": "first" }`, the reply to A. The production 2,500 ms timeout uses the same code path. This can yield missing/incorrect snapshots; snapshot responses for different windows in one editor process can be especially difficult to distinguish using PID/editor alone.

Required fix (Vio): add echoed request IDs and validate response type/shape/identity, or make a timeout invalidate the complete helper session before any next command can use it. Reject all affected pending requests on a session failure. Add tests for late replies, concurrent list/inspect calls, unexpected message types and helper restart. Drain stderr with a bounded diagnostic buffer so an undrained pipe cannot stall the process.

### R2 — High: a result from an old binding is emitted after unbind or switching projects

Location: `src/integrations/window-anchor/tracker.ts:337` through `:418`.

Polling saves the current binding, awaits a native request, then emits the result without confirming that the binding is still current. `needsRepoll` eventually requests another observation, but does not suppress the obsolete one.

Reproduction: begin a deferred snapshot for window `0xA`, call `bind(null)`, then resolve the old snapshot. The emitted sequence is `tracking(0xA)` followed by `unbound`. A caller applying each result could move or show Cobble beside the window it has just disconnected from. Switching to another team/window has the same race.

Required fix (Vio): increment a binding/run generation on bind, stop and start; discard all results whose generation has changed across an await, including errors and candidate lists. Test A-to-B, A-to-null, and stop/start while a request is pending.

### R3 — High: helper exit before ready leaves startup pending indefinitely

Location: `src/integrations/window-anchor/tracker.ts:65` through `:99`.

The helper exit handler clears the five-second initialization timeout and cleans up the process, but never rejects the initialization promise. The pending-command queue is still empty because `sendCommand` is awaiting initialization. `tracker.start()` can therefore stay pending rather than returning an unavailable state.

Reproduction: point the probe at an isolated PowerShell fixture containing `exit 0`. The child is cleaned up, yet the list/start operation is still pending after 6,000 ms, beyond its 5,000 ms startup timeout.

Required fix (Vio): settle initialization exactly once on ready, spawn error, pre-ready exit, startup timeout and disposal. Timeout must kill/clear the failed child/session. Cover early exit, no-ready output, late-ready output, execution-policy failure and disposal during startup with actual helper-process tests.

### R4 — Medium: stopping during startup can leave a timer; restarting the native tracker fails

Location: `src/integrations/window-anchor/tracker.ts:224`, `:286` through `:302`.

`start()` unconditionally installs its interval after awaiting its first poll. If `stop()` runs during that await, the interval is created after stop has already attempted to clear it. A deferred-probe reproduction confirms a non-null timer after stop/start completion. Even though polling returns early when stopped, the timer can retain work/resources and keep a process alive.

Separately, `stop()` permanently disposes `DefaultWindowsProbe`. `start()` reuses that same probe. Calling the real native probe after disposal returns `Native probe is disposed`; repeated successful tracking with the real default probe is therefore not covered by the fake-probe restart test.

Required fix (Vio): guard interval creation by the current running generation, await/cancel pending work safely, and define reusable stop/start behavior consistently with the delivery claims. Recreate the owned native probe after a stop, or explicitly define a terminal tracker and adjust the advertised API/tests. Test real-default-probe restart as well as interleaved start/stop calls.

### R5 — Medium: focus input is ignored, allowing Cobble over unrelated applications

Location: `src/integrations/window-anchor/placement.ts:35` through `:154`.

`editorFocused` is accepted but never read. With a visible, non-minimized, unfocused editor, no drag and no companion interaction, placement still returns `visible: true` and `shouldMove: true`. Cobble's existing companion is always on top, so applying that result can leave the robot floating over a different foreground app. The handoff explicitly required avoiding this by default.

Required fix (Vio): return a nonintrusive hide/dock result when the editor is unfocused, while preserving active companion interaction and dragging. ChatGPT must apply the agreed caller policy and interaction flags. Test switching from the editor to another app, from the editor to Cobble controls, and returning to the editor. Define behavior for the recording UI as well as the quick menu.

### R6 — Medium: mixed-DPI integration advice can select the wrong monitor and position

Location: `docs/window-anchor-delivery.md:92` through `:103`, repeated at `:297` through `:307`.

The example feeds physical native coordinates into display selection and divides absolute x/y coordinates by one display scale. Absolute desktop positions cannot generally be converted that way across monitors with different scales and origins. A negative-coordinate geometry unit test is not a mixed-DPI native conversion test.

Required fix (Vio, report; ChatGPT, actual integration): replace the example with Electron's physical-to-DIP conversion, such as `screen.screenToDipRect(null, snapshot.boundsPhysical)`, then select the corresponding display using the converted rectangle. Validate the actual installed Electron version and monitor-spanning behavior. Use tests/manual evidence for a secondary display at a nonzero origin, negative-coordinate displays, 100%/125%/150% scales and changing display scale. Electron documents these conversion methods in its [screen API](https://www.electronjs.org/docs/latest/api/screen#screenscreentodiprectwindow-rect-windows).

### R7 — Medium: helper silently assumes native initialization and DPI calls succeeded

Location: `src/integrations/window-anchor/windows-helper.ps1:7`, `:83` through `:93`, and `:276`.

Desktop and DPI calls return success flags, but these are ignored; exceptions are swallowed. `GetWindowRect` failure is also ignored. The helper can label bounds as physical even when DPI initialization was unsuccessful. This is a source-level failure-path concern, not a measured incorrect DPI result on this machine.

The report additionally claims that `OpenDesktop("Default")` works regardless of window-station isolation. Microsoft specifies that the named desktop must belong to the current window station. Opening a same-named desktop does not establish a cross-station guarantee. The initial desktop handle is also not explicitly released; it currently lasts with the helper process rather than leaking per poll.

Required fix (Vio): check return values and actual DPI context, report controlled diagnostic failure if guarantees cannot be met, validate rectangles before emitting a found snapshot, and document desktop access limits. Reduce desktop access rights to those needed and manage handle lifetime explicitly. Microsoft references: [SetProcessDpiAwarenessContext](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext), [OpenDesktopW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-opendesktopw), and [GetWindowRect](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowrect).

### R8 — Documentation: delivery claims do not match the final changeset

Location: `docs/window-anchor-delivery.md:12`, `:164` onward and `:349`.

The report lists seven source/report/test files and says no character art was generated or altered. The merge includes ten files, including `cobble_normal.svg`, `cobble_hover.svg` and `cobble_peep.svg`. Their addition is verifiable; their authorship/provenance cannot be inferred from the SVGs. They are within the allowed directory tree but outside the assigned no-art task. This needs an accurate report and user/artist decision, rather than silently treating the images as approved final assets.

The recorded baseline also includes commands run from `C:\Users\Vyom\vibed` with missing package/lock files, while Cobble's original uploaded commit includes both. These may be notes from the wrong directory or an incomplete copy, and should not be presented as verified failures of the shared repository.

Required fix (Vio): list all delivered assets and their source/approval status, correct baseline context, separate simulated tests from native evidence, and remove guarantees not supported by a checked return value or real test.

## Robot artwork and animation assessment

Files inspected: `cobble_normal.svg` (220 × 260), `cobble_hover.svg` (220 × 270), and `cobble_peep.svg` (240 × 200).

What is good:

- Consistent white/grey body, blue eyes and antenna make the poses recognizable as the same robot.
- Transparent vector assets scale cleanly. No external images, fonts, executable scripts or external resource references were found in these three SVGs.
- The normal pose reads as friendly; the thruster hover pose reads as airborne; peep gives a plausible starting idea for resting at a horizontal edge.

What needs work if the user/artist elects to use them:

- There are no SVG animation elements, CSS keyframes, animation timelines or runtime pose bindings in this addition. This is not an animation delivery. Animation was previously deferred, so absence alone is not a failed requirement.
- The intended product states are **normal/chatting**, **idle at an edge**, and **dragging/hanging**. The supplied names are normal, hover and peep. Hovering with thrusters does not depict being held or hanging; no unambiguous dragging state is supplied.
- Viewboxes and character anchors differ. In the same 96 × 110 image box, peep is substantially shorter and its head sits lower than the normal/hover heads. Switching assets without consistent anchors/padding will change apparent size/position.
- Peep includes a painted horizontal blue line. It does not align automatically with an actual screen/editor edge, and does not directly fit left/right edge placement. Treat the line as a mockup aid or design proper per-edge positioning/variants.
- Thin detached limb details and the small antenna cube lose clarity at actual widget sizes. The 96 × 110 rendering shows this; visual quality at the final smaller interactive footprint needs artist review.
- There is no blink, mouth/talking, mic-active, loading, alert or drag transition in these files. These may remain deferred; do not advertise them as delivered behavior.

The app still loads optional `assets/companion/{normal,idle,dragging}.png`. These nested SVGs are not used or shipped by the existing application build. That integration was explicitly ChatGPT-owned; its absence is not a violation by the adapter contributor. Artwork does not establish an IDE connection.

## What he did well technically

- Stayed within the permitted adapter/test/report directory boundaries; no unrelated core changes or new dependencies.
- Kept native observation and pure placement separate, with no Electron import at module load.
- Used a hidden long-lived PowerShell helper and JSON input rather than interpolating titles/workspace names into shell commands.
- Required explicit window selection, even with just one candidate, rather than guessing a project from its title.
- Represented handles as strings and rechecked editor/PID when provided. The integrator should always supply the selected native PID alongside its handle; the optional PID is not automatic identity pinning.
- Suspended movement during drag and retained interaction during minimized/hidden editor states.
- Covered useful geometry, invalid-input, negative-origin, no-binding, ambiguous-selection and immediate-error cases with deterministic tests.
- Reported that Cursor was not live-tested and kept native window detection separate from authenticated IDE/agent pairing.

The inspected source does not contain screenshot/keylogging/clipboard capture, remote messaging, downloads or arbitrary shell-string evaluation. It reads native window/process metadata and launches the local helper. This observation is limited to this changeset; it is not a universal security certification.

## Ownership and next steps

| Owner | Next work |
| --- | --- |
| Vio | Fix R1–R5 and R7 in the reserved adapter files; correct R6/R8 documentation; add regression tests for the reproduced failures |
| ChatGPT | Review returned fixes; wire explicit selection to authenticated workspace state; use correct physical/DIP conversion; connect focus/menu/record/drag states and shutdown; package helper and rebuild installer |
| User/artist | Decide whether these robot sketches are wanted; approve consistent normal/idle/hanging assets before final visual integration |
| Both developers | Test native binding and recovery on real VS Code/Cursor/Antigravity installs and mixed-scale displays; record exact tested versions and unsupported cases |

Recommended acceptance gate: the 61 existing tests stay green, new regressions demonstrate fixes to the failure cases, no stale result is applied after a bind/run generation change, every helper operation settles within a bounded time, and a real packaged run follows the selected editor without remaining over unrelated apps.

## Local reproduction evidence

Run from the repository root on Windows:

```powershell
npx tsx .cobble/window-anchor-review/checks.ts
```

These diagnostic files are intentionally ignored/local; share them separately if needed. Current recorded output:

```json
{
  "unfocusedPlacement": { "visible": true, "shouldMove": true },
  "statesAfterUnbind": [
    { "status": "tracking", "windowId": "0xA" },
    { "status": "unbound" }
  ],
  "timerCreatedAfterStopDuringStart": true,
  "exitBeforeReady": "still pending after 6000ms (startup timeout is 5000ms)",
  "earlyExitChildCleanedUp": true,
  "firstRequest": "Helper command timed out",
  "secondRequest": { "type": "reply", "marker": "first" },
  "realHelper": { "candidates": 0, "ids": [] },
  "realProbeAfterDispose": "Native probe is disposed"
}
```

Rendered preview: `.cobble/window-anchor-review/assets.png`. Diagnostic source, original fixture helpers and complete output are in the same directory. No real editor window was moved or rebound during the review.
