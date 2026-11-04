# Windows review-worker resource guard

Source 0.4.13. This adds independent Windows resource and lifetime controls to the existing trusted preflight worker. It does not add a model, native model inference, a security container or new alerts.

## Execution contract

On Windows, Electron configures `ReviewSupervisor` with the built `review-guard.exe` and its SHA-256 sidecar. The supervisor verifies both worker and guardian artifacts before launch or cache reuse. A missing, corrupt or unsupported configured guard returns uncertainty; it never silently falls back to unguarded execution. Non-Windows source execution remains explicitly `process-only`, with no Windows enforcement claim.

The guardian creates a private unnamed Windows Job Object. It uses the Windows 10 `PROC_THREAD_ATTRIBUTE_JOB_LIST` creation attribute to assign the suspended worker atomically, verifies membership, then resumes its initial thread. Only the three intended standard-I/O pipe handles are inherited; the job handle is not inherited. This closes the orphan/race window that exists when a child is started before job assignment. No administrator privileges, firewall rules, persistent service, account access or user permissions changes are needed.

The preflight uses these fixed maxima; internal test settings may only tighten relevant bounds:

| Control | Enforcement / limitation |
|---|---|
| Committed memory | OS job/process limit of 256 MiB; not a total RSS, file-mapping, GPU or machine-RAM cap |
| Process count | One active process in the job; ordinary native descendant creation is denied |
| CPU rate | Hard job rate of min(100%, 2 / reported logical-processor count), in Windows job units; not a core-affinity or thread-count guarantee |
| CPU budget | Five seconds of user-mode CPU quota plus independent sampling of total user + kernel CPU every at most 250 ms; quota/sampling granularity can allow overshoot |
| Priority | Below normal for the worker |
| Wall watchdogs | Parent supervisor initiates termination at 20 seconds including guardian startup; guardian independently watches worker lifetime after resume |
| Lifetime | Closing the final job handle kills the worker; guardian also watches a handle to the parent process and terminates on parent death |
| Existing restrictions | Node permission flags, exact worker-file read permission, denied writes/subprocesses/worker threads/addons, disabled dynamic code generation, bounded pipes and sanitized environment remain active |

The guardian forwards bytes and does not interpret repository text. It is a small trusted native-interop executable, not a configurable shell runner. On Windows the helper is compiled during the build using the system compiler and shipped with the app; installed users need no compiler or SDK. Its CLR dependency is the .NET Framework 4.x runtime provided by supported Windows 10/11 desktop systems. The helper itself sits outside the child's job; its small trusted pipe bridge must be included in future whole-feature resource benchmarks.

After the child exits, the trusted guardian queries Windows job accounting and writes a small private temporary report. The supervisor validates its schema, exit code, job membership and expected limits before marking a successful outcome `resourceGuard: windows-job`. Fields include peak committed memory, user/kernel CPU, process cap, CPU rate, PID and termination cause. Worker-reported RSS/CPU remain separately named soft telemetry. Post-exit OS counters are historical for that execution, including on a cached result; they are not live-process metrics.

The temporary directory is created by the supervisor and removed after completion. It holds accounting metadata only; source text stays in bounded pipes. Artifact/profile identity participates in cache keys. Freshness is rechecked after asynchronous guard verification and before launch/cache acceptance; closing or cancelling during report collection cannot accept a late result.

## What this does not isolate

A Job Object is not a filesystem/network security boundary, an AppContainer or protection against malicious native code. No claim is made that all process-creation mechanisms or external services can be contained by a process-count cap alone. The preflight executable is trusted bundled code and never evaluates repository snippets. A selected native inference runtime still requires its own verified isolation, tokenizer/context budgeting, model provenance and full resource benchmarks before enabling it. The 256 MiB preflight profile must not be silently enlarged to load a model.

This implementation follows Microsoft's [atomic job-assignment guidance](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812), [job memory accounting semantics](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information) and [CPU rate controls](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information).

## Verification and remaining gates

Native tests launch both real Node and Electron helper workers, using paths with spaces. The same 128 MiB allocation succeeds with the 256 MiB profile and fails under a tightened 96 MiB committed-memory limit. A CPU-bound worker and an idle worker are stopped without trusting worker usage reports. A native C# fixture cannot spawn its own descendant, independently of Node's permission system. Missing/modified artifacts and invalid bounds fail closed. Abrupt guardian termination kills its child. Parent-crash testing uses a detached guardian to exercise the explicit parent watcher rather than relying on Node's own child cleanup.

The first parent-crash test depended on a final report even when an inherited outer job could kill the guardian itself. The corrected test separates that mechanism and proves explicit parent-watch termination; it did not weaken production cleanup. Windows' coarse user-time quota prompted the added independent 250 ms CPU sampling rather than a relaxed CPU test.

Desktop and packaged smoke require real guardian execution and OS proof, not just file presence. The clean-install handoff checks guardian integrity and packaged proof for versions 0.4.13 onward while preserving compatibility with 0.4.12.

Validation: type checking, the build and source desktop smoke passed. All 215 tests passed in the final two-process full-suite run (116 seconds), including seven native Windows enforcement groups. The final NSIS package passed actual Windows-job preflight execution, both shutdown scenarios, companion drag checks and offline sample transcription. Included runtime verification passed. The clean-install PowerShell script parsed successfully but was not executed on a clean machine.

The first packaged smoke correctly rejected a checkpoint with another saved-file event still pending. Diagnostics identified `pending_saved_files`: the test had waited for any event rather than the target file. It now subscribes before writing and waits for the exact target save. Production freshness conditions remain strict; a source-free diagnostic identifies why a backend review was invalidated. Both subsequent packaged checks retained the `model_not_configured` and `windows-job` assertions and passed.

Final packaged proof records version 0.4.13 and peak worker committed memory of 21,884,928 bytes for the tiny preflight. This is not total feature RSS or an inference/reference-laptop benchmark. The local installer is `release/Cobble-Setup-0.4.13-x64.exe` (236,757,980 bytes); it remains unsigned and out of Git. Its checksum is saved alongside it. No binary was published to the repository.

 Genuine human evaluation, representative corpus expansion, semantic model selection/inference, filesystem/network containment, live provider turns, clean Windows installation and physical-device benchmarks remain open. The user explicitly left human review pending. Semantic review stays disabled and production notifications/votes/plan authority are unchanged.
