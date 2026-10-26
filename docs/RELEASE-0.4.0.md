# Cobble 0.4.0 — Windows development installer

Built and verified locally on 26 October 2026 by ChatGPT/Codex.

## Artifact

- Installer: `release/Cobble-Setup-0.4.0-x64.exe`
- Size: **231,308,733 bytes** (about 220.6 MiB).
- SHA-256: `c2571b1e65ad0e8823463c4dad3f7422bff898f56afbe7f72cf944a6d328413c`
- Windows x64 NSIS installer; machine-wide installation with a selectable folder.
- Unsigned development build. Windows file properties identify the application
  as Cobble 0.4.0 rather than Electron. A custom application icon remains pending.
- Application source: `1545dd1`; subsequent packaging changes enable correct
  executable metadata without signing and add packaged companion/relay checks.

The installer and checksum are local build outputs, excluded from Git. No binary
was uploaded to the repository or published as a GitHub Release. A copy is also
saved under the original checkout's `release` directory for convenient testing.

## Included components

Electron/Node, bundled application libraries, portable Git, offline CPU speech
engine and DLLs, the default multilingual speech model, editor VSIX, agent hook
relay, licenses/notices and the signed Microsoft C++ runtime installer. The NSIS
installation automatically runs the bundled Microsoft runtime installer and
handles its success/newer-runtime/reboot outcomes. No end-user Node, npm, Git,
Python, FFmpeg or model download is required. The user's editor and coding
service remain separately installed products.

The executable includes teammate-relay mode through `Cobble.exe --relay-server`;
it does not require a separately installed Node runtime. No public relay or
provider account is configured. Internet access still requires a reachable
teammate endpoint; an installer cannot bypass a blocked router/ISP.

## Verification of this payload

| Check | Result |
| --- | --- |
| Production build and bundled editor extension | Passed |
| Packaged voice/Git integrity | 19 voice/model/notice files and 376 Git files verified; bundled Git executes |
| Bundled Microsoft runtime | Valid Microsoft Corporation signature before packaging |
| Packaged desktop workflow | Passed: profile, required plan, work areas, completion, votes, actual Git merge, chat, saved diff/revert, synthetic IDE authentication and poses |
| Packaged companion | Passed: stationary cursor, vertical/horizontal drag at 100/125/150% page zoom, pose transforms, cancellation/release/blur, click menu and animations at rest |
| Packaged shutdown | Passed: main-window close, app quit and close during active voice processing; windows/tray/services/database closed and ports released |
| Packaged offline voice | Included CPU engine/model transcribed the pinned official sample without downloading voice files |
| Packaged relay | Executable relay mode started without desktop windows and released its port |
| Executable identity | ProductName/FileDescription Cobble, FileVersion 0.4.0, ProductVersion 0.4.0.0 |
| Installer | NSIS build and 7-Zip archive integrity test passed; size, SHA-256 and unsigned status recorded |

Before packaging, the unchanged application source passed typecheck, all 101
tests and production build. This packaging pass repeated the build and tests
against the unpacked app payload produced for the installer. Shutdown diagnostics
include expected canceled-voice/closing-IPC messages and Electron GPU teardown
messages; the three shutdown assertions passed.

## What this build does and does not contain

Includes the current IDE discovery, companion movement/shutdown fixes,
teammate-hosted internet transport and approved safe-handover backend. The new
hosting panel remains assigned to Vyom and is not mounted in this build. A built
installer does not make the unfinished UI accessible or complete the product.
See `VYOM-HOSTING-UI-INTEGRATION.md` for his exact assignment.

Still required before a public release: clean-Windows install/upgrade/uninstall,
physical mouse and microphone testing, real editor compatibility, Windows display
scaling on actual monitors and separately routed teammate connections. Automated
page-zoom checks do not replace physical multi-monitor/DPI testing. Packaged
execution checks the unpacked installer payload; it does not prove the installer
has run successfully on a clean Windows machine. No clean VM installation or
public cross-city test is claimed. Planned host transfer is not crash failover.

## First manual test

1. Run the installer and confirm Cobble 0.4.0 in Profile or the window title.
2. Create a profile and a team with a starting plan; choose a disposable project.
3. Drag the mascot straight up, sideways and between monitors; release and reopen
   its menu. Close the main app and confirm the mascot/tray disappear as well.
4. Record a short voice note, stop, check the transcript/recipient and explicitly
   send. Also test cancel and microphone-permission denial.
5. With another laptop, check joining/approval, private chat, scoped notices,
   completion and every-member voting. Use disposable Git branches for merge tests.
6. Test installation and removal on a clean Windows machine before distribution;
   keep existing user data backed up while testing upgrades.
