# Technical release 0.4.12

4 November 2026. This is a tested, self-contained **zero-semantic-model** Windows build plus network reliability fixes. It does not complete the optional semantic-review roadmap. The user explicitly chose to leave genuine human evaluation pending while technical work proceeds; that is not permission to invent labels or enable unevaluated model alerts.

## Delivered code

- Relay ownership now includes every upgraded socket, including rejected upgrades. Rejection flushes the HTTP error and destroys the socket; relay shutdown terminates and waits for tracked sockets. Repeated `close()` calls share the same completion promise.
- Every network exchange has a 12-second absolute deadline covering relay establishment, TCP/TLS and response completion, in addition to the existing four-second inactivity timeout. Traffic cannot keep an operation alive indefinitely by trickling bytes. Disconnect aborts pending operations; all deadline timers/listeners and per-request agents are cleaned up. Each relocation hop has its own deadline, with the existing redirect limit preserved. Internal tests can tighten, never increase, the default bound.
- The half-open rejected-upgrade regression fails against the original relay and passes against the fixed source. Silent TLS, continuous response data, stalled relay upgrades, disconnect cancellation and accepted-connection shutdown have deterministic regression coverage. Historical intermittent test failures are not claimed to have one proven cause; this release fixes a reproduced leak and bounds individual calls. Current relay regression/workflow runs pass.
- Existing certificate pinning, authorization-before-body checks, targeted notices, co-ownership policy, manager authority and unanimous exact-commit main approval remain intact.
- Desktop/packaged smoke now launches the actual configured review worker against a current saved checkpoint, verifies `model_not_configured` and confirms semantic review remains disabled. Packaged success records bind a unique run ID, version and worker result, so an old package/result cannot be mistaken for this release.
- Review tests now wait for the real file watcher to be ready and report the saved file before starting a stable preflight. A new integration test changes source during an active review and requires stale cancellation. Production freshness checks were not weakened to make a test pass.
- Runtime verification now also checks the included Microsoft redistributable signature before packaging and against packaged resources.

Node documents that [HTTP connection shutdown excludes upgraded protocols](https://nodejs.org/download/release/v24.13.0/docs/api/http.html#servercloseallconnections) and that [request timeout events alone do not abort requests](https://nodejs.org/download/release/v24.13.0/docs/api/http.html#httprequesturl-options-callback). Explicit socket ownership and abort/deadline handling implement those responsibilities here.

## Verification on this machine

| Check | Result and limits |
|---|---|
| Type checking / production build | Passed |
| Complete automated suite | All 208 tests passed; two concurrent test processes, 138 seconds |
| Source desktop workflow | Passed, including real preflight helper execution |
| Packaged desktop workflow | Passed: profile, plan, areas, completion, votes, real Git merge, chat, saved changes/revert, IDE auth, hosting, themes, companion chat and secure backup |
| Packaged worker | Current version 0.4.12, valid artifact sidecar and actual helper execution; returns uncertainty because no semantic model is configured |
| Paths with spaces | Real Node and Electron helper execution passed with worker files in a path containing spaces |
| Packaged companion | Passed stationary-cursor, vertical/horizontal face drag at 100/125/150% zoom, grab-point preservation, release/cancel/lost capture/blur and click-menu checks; artwork unchanged |
| Packaged shutdown | Main-close and app-quit both exited, saved data and released ports |
| Voice | Packaged CPU engine transcribed the supplied official sample offline; no microphone recording was made |
| Bundled runtime integrity | Voice: 19 files; Git: 376 files, included Git executed successfully; Microsoft C++ runtime signature valid |
| Installed editor compatibility | Included VSIX installed/listed successfully in a temporary Visual Studio Code profile; not a real provider turn |
| Clean installer handoff | PowerShell script parsed successfully; not executed on this host |

The first full run passed 206 of 207 tests and exposed a review test starting before watcher readiness. After synchronizing that setup and adding real-edit cancellation coverage, all 208 passed. No source freshness guard or existing relay-test timeout was relaxed. Shutdown smoke may log rejected IPC calls while windows close; both processes still exited and port/persistence checks passed.

The installed app contains Electron/Node, compiled application code, the trusted preflight worker and sidecar, MinGit, Whisper CPU binaries, multilingual speech model, license notices, Microsoft C++ redistributable, editor VSIX and agent relay. It does not require users to install Node, Python, Git, a compiler, an inference server or a speech model. The speech model is not a plan-review language model. This is an unsigned NSIS installer; signing remains separate release work.

## Local artifacts

- `release/Cobble-Setup-0.4.12-x64.exe` — 236,750,554 bytes (about 237 MB).
- SHA-256: `352b059fef9655765d637383f3c925f34ebb90d84dc12986172b6b27af822064`.
- `release/Cobble-Setup-0.4.12-x64.exe.sha256` — checksum sidecar.
- `release/win-unpacked/` — the packaged application used in the checks.
- `release/test-clean-install.ps1` — copy of the source test handoff.

These generated artifacts stay out of Git. No installer was uploaded into the source repository and no public binary release was published.

## Clean Windows handoff

Windows Sandbox is unavailable on this machine. A fresh installation with missing developer runtimes and disconnected external networking cannot therefore be claimed from the current-host tests.

Copy the installer and [the test script](../scripts/test-clean-install.ps1) into a disposable clean Windows VM or dedicated test machine. Disconnect its external networking, open an elevated PowerShell, then run:

```powershell
.\test-clean-install.ps1 -InstallerPath .\Cobble-Setup-0.4.12-x64.exe -ExpectedVersion 0.4.12
```

This script installs the actual NSIS package in a new test directory, verifies installed voice/Git/worker files and the Microsoft runtime signature, runs the installed app's smoke workflow using only included dependencies, and saves version/run-bound JSON and logs. It refuses a pre-existing Cobble installation and existing output folder; it leaves its test installation for inspection. It does not authenticate reviewer identities or independently prove the operator chose a clean/offline machine. It is an optional release test, not a setup step required of app users. Do not run it on the development host as a substitute for a clean-machine check.

## Still incomplete

1. Expand representative evaluation data and obtain/adjudicate real independent human judgments. The current 63 synthetic cases still have zero genuine human reviews; the 300 reviewed-case / 10 representative-repository gate is unmet.
2. Select and benchmark a free local semantic model, implement its native inference/runtime isolation and measured resource controls, then validate shadow review before author suggestions or wider alerts. The existing worker remains preflight-only. These dependent features are not claimed finished because a package now exists.
3. Verify genuine Claude/Cursor/Gemini turns. No provider CLI/account-backed turn is available on this machine; VS Code extension installation and synthetic relay tests cannot replace it.
4. Execute the clean Windows installer check and physical microphone/reference-laptop/multi-device/cross-city tests. Current local peer tests do not establish real router/ISP reachability or 8 GB laptop performance.

No new subscription, mandatory hosted service, model download, automatic semantic alert or background inference process was enabled.
