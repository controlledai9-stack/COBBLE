# Cobble 0.4.2 — integrated UI

Windows x64 development build, 27 October 2026. Integrates Vyom's `b94d7c1` UI over the 0.4.1 backend; see [integration details](UI-INTEGRATION-0.4.2.md).

## Validation

- `npm run check`: typecheck, **116 tests passed**, production build passed.
- Final packaged renderer assets and main entry compared byte-for-byte with the completed build.
- `npm run test:packaged`: profile, starting plan, work areas, completion, unanimous voting and actual Git merge, messages, saved diff/revert, IDE pairing, mounted hosting dialog, both themes, native mini-chat send/minimize/reopen/redirect, secure backup recovery and maintenance IPC passed.
- `npm run test:companion -- --packaged`: grab-point anchoring, vertical/horizontal movement at 100/125/150% zoom, release/cancel/lost capture/blur, click menu and stationary behavior passed.
- `npm run test:shutdown -- --packaged --voice`: main close, app quit and close with active transcription all exited, persisted data and released ports, including the mini-chat window. Active transcription is deliberately aborted during shutdown; Electron logs the expected AbortError and compositor shutdown diagnostics.
- `npm run test:relay -- --packaged`: standalone relay starts without desktop UI and releases its port.
- Packaged runtime verified (19 voice files and 376 portable Git files). Bundled CPU engine/model transcribed the official sample offline.

## Package and limits

Local installer: `release/Cobble-Setup-0.4.2-x64.exe` (231,328,701 bytes). NSIS archive integrity check passed; the copied installer checksum was verified. The binary is excluded from Git.

SHA-256: `1e9ea76a971080ad4ee1970181d740175d5421806733cfb01038c05f379d7a7d`.

The installer includes Electron/Node, portable Git, offline voice runtime/model, editor integration and Microsoft C++ runtime installer. End users need no separate developer dependency setup.

The development installer is unsigned and uses the default application icon. Clean Windows VM installation, physical microphone capture, real cross-city networks and different physical display configurations remain manual release checks. Planned host handover does not provide crash failover. Backup and maintenance settings presentation is still pending.
