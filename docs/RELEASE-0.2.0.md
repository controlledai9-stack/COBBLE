# Cobble 0.2.0 — development test build

Built and checked on 24 October 2026 by ChatGPT/Codex.

## Download and first test

Installer: `release/Cobble-Setup-0.2.0-x64.exe` (231,211,290 bytes).

SHA-256: `8a8fb6ea3d8c7fd9ef1b503e4d5b503f6e3a4b1ef8f714631c8e3ed1b1087471`.

This development installer is unsigned. It includes Electron/Node, app libraries, portable Git, the offline speech engine/model, editor VSIX and hook relay, licenses, and the Windows C++ runtime installer. No separate developer tools or model downloads are required for the installed app. A user's IDE and coding service are independently installed products.

1. Install, create your profile, then create a team with a required starting plan and select its project folder.
2. In Teams, add work areas, assign all co-owners and any reviewers, and record dependencies. Save the agreed public shapes from the current code.
3. Start hosting; invite another device using the full pinned address and code, approve it, and select that member's local copy of the project.
4. Verify normal co-owner changes remain quiet. Use an explicit test constraint such as `Do not modify \`legacy/\`` in a disposable repository to check author/owner scope alerts. Check dependent-area recipients for a public API change.
5. Mark a plan piece complete explicitly. File saves and agent turn endings do not mark tasks complete.
6. In a disposable Git repo, commit to a personal branch and propose its exact commit for main. Have each member vote. A missing vote stays pending; any No blocks approval under the current provisional unanimity rule. With all Yes, the owner can review a local merge from a clean main checkout. Cobble does not push it.
7. Preview a revert before confirming it. Cobble refuses overlapping/stale edits. Test this with disposable files before using it on valuable work.
8. Connect the IDE and optionally enable its supported coding-agent hooks. Start a fresh agent session if needed. Check disconnected/connected states and that saved-file observation remains truthful.
9. Try the mic, stop recording, review the transcript and recipient, then Send. Check permission denial/cancel and private versus team messages.

## Automated evidence

| Check | Result |
| --- | --- |
| TypeScript typecheck | Passed |
| Core test suite | 30 passed, 0 failed |
| LAN workflow simulation | Five and eight logical clients on this computer; targeted notices, shared ownership, private sync, retry/dedup, completion, voting and reconnection passed |
| Git integration tests | Actual bundled Git: exact approved merge, dirty/stale/voter blockers, conflict recovery and pre-existing-merge preservation passed |
| Revert tests | Unrelated edit preservation, overlap/stale refusal, outside-workspace junction protection and observer-baseline preservation passed |
| Contract tests | Canonical public shapes, overload grouping, private/body/formatting changes, routes and dependencies passed |
| Agent tests | Hook preservation/idempotence and quoting, authenticated context/turn events, diff fallback and separate IDE truth passed |
| Desktop workflow | Rendered profile, required plan, work areas, completion, votes, actual merge, chat, saved diff, reverse-patch preview, IDE auth and companion poses passed |
| Packaged executable | Same isolated workflows passed using included Git, VSIX and relay; fresh nonce marker verified |
| Packaged offline voice | Official sample transcribed by included CPU engine and multilingual model without network access |
| Runtime integrity | Voice artifacts and 376 extracted Git files verified; signed Microsoft runtime checked |
| Installer build | NSIS x64 build completed; external publishing was not performed |

The smoke profile is isolated under ignored `.cobble/`; it does not populate the user's profile. The desktop test uses synthetic IDE bridge events, not a real editor session. Packaged execution validates the unpacked installer payload; it does not prove the installer ran successfully on a clean Windows machine.

## Remaining work and boundaries

- Teammate-owned native window adapter: only the assignment in `docs/GEMINI-HANDOFF.md`. ChatGPT has not implemented its reserved files. Logical IDE pairing works independently; native editor-window attachment is still pending that adapter.
- Artist-owned normal, idle and dragging images. Current placeholder exposes controls and the three lifecycle states; final character presentation remains pending.
- Real editor/agent compatibility, microphone hardware, separate-device LAN/firewall behavior and a clean Windows install still need manual validation.
- Release signing, owner credential-management UI, richer semantic plan analysis and host failover remain further work. Current semantic detection deliberately favors quiet uncertainty over speculative accusations.
- Main voting currently requires all Yes; the user has not chosen unanimity versus majority after all members vote. This build does not enforce server branch protection against Git clients outside Cobble.
- Public-shape analysis is limited to implemented JS/TS declarations, simple routes and table forms. It cannot prove every architectural effect or infer every dependency.

See `README.md` for setup and current behavior, `docs/architecture.md` for implemented boundaries, and the full build specification for the target product.
