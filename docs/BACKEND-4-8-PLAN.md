# Backend work plan: points 4–8

26 October 2026. ChatGPT owns backend, contracts, tests and documentation.
Vyom's existing renderer assignment remains separate. Preserve local edits.

1. **Old connection recovery.** Add an explicit refreshed-invitation action for
   an approved member. Validate the new pinned endpoint, team identity, membership
   and nondecreasing host epoch before replacing a saved connection. Preserve
   queued IDs and credentials on failed recovery. A reachable connected teammate
   can share the current full invitation. Do not claim offline host discovery or
   contact an external directory. Explain when a fresh invitation is required.
2. **Plan assessment.** Match saved paths to agreed work areas and their actual
   source-linked plan pieces. Improve word boundaries/camel-case matching and
   recognize supporting work, with evidence-based explanations. Explicit path
   exclusions remain reviewable conflicts; missing matches and agent claims
   alone never prove extra work. Add adversarial/noise regression cases.
3. **Integration compatibility.** Provide truthful local capability diagnostics
   and a repeatable supported-editor/agent test matrix. Probe installed tools
   without launching idle editors, rewriting unrelated hooks or inventing
   support for Gemini/Jules. Real installed-editor and remote-agent checks can
   only be reported as passed when actually available and exercised.
4. **Backup and maintenance.** Add consistent, authenticated encrypted database
   backups using this device's secret adapter, bounded restore validation and
   recovery into a separate offline database. Never overwrite a running database
   or automatically resurrect a restored team server. Restored copies need an
   authoritative reconnect before hosting. Expose backend/desktop entry points;
   final settings UI remains separate. Maintenance reports usage and only removes
   explicitly requested old resolved local revert batches. Keep messages, votes,
   active changes, plan history, sync cursors and retry/dedup records intact.
5. **Reliability.** Exercise repeated reconnects, queued events, larger histories,
   backup round trips/corruption, maintenance exclusions and restart. Add an
   opt-in configurable soak command with recorded duration and event counts.
   Run meaningful local coverage now; do not describe a short run as an overnight
   or real multi-device/network validation.

Delivery: focused tests, full typecheck/core/build checks, desktop regression,
updated integration contracts and evidence. Rebuild the development installer
after integration if source changes require it. Keep no-provider/no-paid-service
policy, trusted-host private-message scope and quiet uncertainty. Points 1–3 from
the earlier backlog (merge crash recovery, real physical networking, exhaustive
handover crashes) are not silently included or marked complete.
