# Cobble 0.4.1 — backend recovery and reliability development build

Built locally on 26 October 2026. Implements the scoped points 4–8 plan in
`BACKEND-4-8-PLAN.md`; detailed contracts/limits are in `BACKEND-4-8-DELIVERY.md`.

## Local installer

- `release/Cobble-Setup-0.4.1-x64.exe`
- **231,314,138 bytes** (about 220.6 MiB).
- SHA-256: `152e02ef09d3bda83b39d4a5691abf6355b2f18c7004d0a53576ecb3f763ba90`
- Unsigned Windows x64 NSIS development installer. Windows identifies the app as
  Cobble 0.4.1. The custom application icon remains separate artwork work.
- A verified copy and checksum are saved in the original checkout's `release`
  folder. No installer was committed to Git or published as a public release.

Includes Electron/Node, bundled application libraries, portable Git, offline
CPU speech engine/DLLs, multilingual model, editor VSIX, hook relay, notices and
the signed Microsoft C++ runtime installer. Installation prepares the included
runtime. End users do not install development packages or download speech models.
No provider account, paid service or public relay was introduced.

## Included backend changes

- Explicit same-team/current-epoch refreshed-invitation recovery for approved
  members, plus durable pending-request recovery after planned host transfer.
- Work-area and positive path/glob plan mapping, improved identifier matching,
  quiet supporting/unknown work and quiet conditional restrictions. This is not
  general semantic reasoning or proof that every scoped detail is necessary.
- Real local editor/extension and hook configuration diagnostics, with installed
  capability clearly separated from live IDE/agent linkage.
- Consistent encrypted backups, validated separate offline recovery copies,
  explicit resolved-source-batch maintenance, and shutdown waiting for backups.
- Faster bounded history catch-up and batched passive receipts behind substantive
  queued work. A lost receipt acknowledgement retains retry IDs without duplicates.

## Verification

| Check | Result |
| --- | --- |
| `npm run check` | Typecheck, **112 tests**, production build passed |
| Real editor CLI compatibility | Included VSIX installed/listed in isolated profiles for Cursor 3.24.18 and VS Code 1.143.0; personal profiles untouched |
| Four-peer soak | 500 history entries, 126 active seconds, 305 new messages, 11 host and 21 peer/store restarts passed |
| Eight-peer soak | 2,000 history entries, 180 active seconds, 740 new messages, 26 host and 51 peer/store restarts; private filtering/dedup and final queue drain passed |
| Source desktop workflow | Passed, including real Windows secure-storage backup/recovery and maintenance IPC |
| Packaged workflow | Passed with bundled Git/VSIX and encrypted backup/offline recovery |
| Packaged companion | Native-window geometry checks at 100/125/150% page zoom, cancellation/release/blur and click/menu behavior passed |
| Packaged shutdown | Main-close, app-quit and close during voice processing passed; ports and data cleanup verified |
| Packaged offline voice | Included engine/model transcribed the pinned official sample |
| Packaged relay | Executable relay mode starts without desktop windows and releases its port |
| Packaged resource integrity | 19 voice/model/notice files and 376 Git files verified; bundled Git executes |
| Installer archive | 7-Zip NSIS integrity test passed; size/hash and unsigned status recorded |

Initial larger soak runs exposed receipt-backlog starvation; the queue behavior
was corrected rather than increasing the failing timeout. Shutdown emits expected
canceled-voice/closing-IPC diagnostics and Electron GPU teardown messages while
all three checks pass. Stress results use logical peers on this computer, not
physical devices. RSS measurements in the delivery report do not establish
long-term leak-free behavior.

## Remaining presentation and release work

Backend/preload/native-dialog entry points are available, but the new hosting,
reconnect, backup and maintenance settings presentation has not been added in
this pass. Vyom's existing hosting-panel assignment remains separate. Restoring
a backup produces an offline SQLite copy and does not switch the running app's
database. Backups require the original Windows account/device; portable
cross-device disaster recovery is not implemented.

Real GUI pairing/agent turns, other editor versions, physical microphone/mouse,
multi-monitor Windows scaling, clean install/upgrade/uninstall, multi-hour soak
and separately routed laptop networking remain manual release checks. Packaged
execution tests the unpacked installer payload, not an installation in a clean
Windows VM. Crash failover and interrupted-merge reconciliation remain separate
backlog items. The existing manager/private-message trust boundary is unchanged.
