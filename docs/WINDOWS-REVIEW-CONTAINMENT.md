# Windows review-worker containment

Source 0.4.14 extends the [Windows resource guardian](WINDOWS-REVIEW-GUARD.md) with a standard Windows AppContainer for the existing trusted **preflight-only** worker. No model is selected, downloaded, executed or enabled. Human evaluation remains pending at the user's request. Alerts, votes, plan authority and automatic background behavior are unchanged.

## Execution contract

The app verifies the worker and guardian SHA-256 manifests. Guardian manifest v2 identifies `windows-appcontainer-preflight`; the packet protocol stays at version 1. Missing, corrupt or unsupported containment fails closed with uncertainty, with no fallback to an unrestricted Windows worker. Non-Windows source runs remain explicitly `process-only`.

The guardian creates or reuses one registered, per-user profile, `ControlledAI.Cobble.Review.Preflight.v2`, through supported Windows APIs. It supplies an empty capability list together with the atomic Job Object and standard-pipe handle attributes. The child starts suspended. Before resuming, the guardian verifies its actual token: AppContainer enabled, the expected package SID, zero capabilities and membership in the resource-limited job. It refuses a profile that has a configured loopback exemption; it never removes exemptions or changes firewall rules.

Only the Windows/profile/temp settings needed for startup, the Electron helper-mode flag and a one-thread libuv setting enter the child environment. Provider tokens, Node options, PATH, database credentials and the private report authentication key do not. The executable and worker paths are absolute, staged and verified; Node preserves those paths without resolving private ancestors. Its existing permission flags, disabled dynamic code generation, bounded pipes and freshness checks remain active.

The existing 256 MiB committed-memory cap, one-process limit, CPU rate/quota, below-normal priority, cancellation and kill-on-job-close behavior remain in force. The parent deadline includes staging; the guardian also bounds preparation and watches parent death during it, then independently watches the resumed worker. Timeout, failed staging or invalid accounting never becomes a semantic judgment.

## File access and storage

The guardian grants the container read/execute access only to its own staged public runtime and bundled worker files. It does not change project, source, user-profile or unrelated application permissions. Source/plan excerpts travel through bounded pipes; they are not written into these staging areas.

Runtime staging copies the selected existing executable and an explicit list of required Electron/Windows runtime assets. It excludes application archives, credentials and arbitrary neighboring files. Streaming hashes verify originals and staged files. The per-user cache under `%LOCALAPPDATA%\Cobble\ReviewRuntimeV2` allows two slots, each at most 512 MiB/64 files. Marker checks and reparse-point rejection restrict eviction to this component's flat cache folders. A per-user maintenance mutex and held read leases protect active entries; inability to reclaim a slot fails closed. Warm runs still verify runtime hashes, so future whole-feature performance measurements must include this I/O.

Each request creates a new private control directory and a read-only worker subdirectory. Protected ACLs deny the package writes, deletion, permission changes and ownership changes to staged files. OWNER RIGHTS removes implicit owner permission-changing rights. Accounting is preopened before the child starts, in a directory held against rename/deletion. The child cannot access that report. After exit the guardian writes OS accounting in an HMAC-SHA256 envelope using a fresh 32-byte key known only to the parent/guardian. The parent validates authentication, exact schema, exit status and expected limits. Wrong-key, changed-payload and replayed reports cannot supply accepted proof.

The supervisor removes per-request control files after completion; a crash may leave bounded executable/metadata remnants in the temporary directory. The profile and bounded public runtime cache persist for reuse. No administrator access, SDK download, persistent service or paid account is needed by installed users. The native helper is compiled during development and bundled; supported Windows 10/11 supplies its .NET Framework runtime.

## Scope and limitations

This is a **standard AppContainer**, not LPAC, a VM or a hermetic filesystem allowlist. Windows exposes baseline resources granted to application packages and the container's own writable storage/registry. Existing broad ACL grants can make a file readable. Zero capabilities restrict ordinary network access under Windows isolation policy; this delivery does not claim resistance to an OS vulnerability or altered host security policy. Loopback TCP/UDP and generated private-file denial are tested directly below.

The trusted bundled preflight does not execute repository snippets. A future native model/runtime requires its own provenance, tokenizer/context budgets, containment tests and memory/performance profile. The present memory limits must not silently grow to accommodate a model. No inference quality, detection accuracy or reference-laptop benchmark is claimed.

## Verification

The native boundary test uses a compiled C# fixture, independently of Node permissions. Outside containment it reads a generated private canary and reaches local TCP and UDP listeners. Inside containment it cannot read/write that canary, change/delete the staged worker, write a staged runtime asset, change its ACL, read control accounting or inherit the report key. It can read the intended worker/runtime files. Bounded TCP attempts fail and neither listener receives contained traffic. The canary contents and original ACL remain unchanged. Tests also reject an incorrect report key and modified signed payload.

Existing native tests exercise Node and Electron helper execution, tightened memory/CPU/wall limits, missing/tampered artifacts, native descendant denial, abrupt guardian death and detached-parent crash cleanup. Desktop and packaged smoke require actual `windows-appcontainer` OS proof, not file presence. The clean-install script recognizes v2 for 0.4.14 and preserves the older 0.4.12/0.4.13 contracts.

Validation completed: type checking and production build passed; all **216 tests** passed in the full two-process run (163 seconds), with no skipped tests. Source desktop smoke and packaged smoke passed, including authenticated AppContainer accounting. Both packaged shutdown scenarios, companion drag checks at 100/125/150% zoom and offline sample transcription passed. Included voice/Git/redist integrity checks passed. The clean-install PowerShell script parsed successfully; a genuine clean installation was not run.

The packaged tiny preflight reported peak worker committed memory of 21,258,240 bytes. This excludes the guardian, cache I/O and full app; it is not a model/reference-device benchmark. The local unsigned installer is `release/Cobble-Setup-0.4.14-x64.exe` (236,764,290 bytes), SHA-256 `e996dff27f3689e3a695066ab460d767d29f215cb071a4052b7854a2610bcc6c`. Checksum and validation JSON are stored alongside it. No installer binary is committed or published. Genuine human labels, representative corpus expansion, semantic model integration, live provider turns, clean Windows installation, physical microphone/cross-city/reference-device tests remain open.

## Primary references

- [Microsoft: AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)
- [Microsoft: implementing an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
- [Microsoft: supported profile creation](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createappcontainerprofile)
- [Microsoft: process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
- [Microsoft: configured network-isolation exemptions](https://learn.microsoft.com/en-us/windows/win32/api/netfw/nf-netfw-networkisolationgetappcontainerconfig)
