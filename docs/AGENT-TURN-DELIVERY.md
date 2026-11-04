# Durable agent receipts and Gemini CLI integration

4 November 2026. Source 0.4.8. The source portion of milestone 4 is implemented. Live provider/version verification remains pending: Claude Code, Cursor CLI and Gemini CLI were not available on this machine's command path. Tests execute the real Windows PowerShell relay against documented payload fixtures and Cobble's authenticated bridge; they do not call a provider model.

## Provider contracts and identity

| Provider | Installed project hooks | Identity and context behavior |
|---|---|---|
| Claude Code | UserPromptSubmit, PostToolUse, Stop, SessionEnd | Uses native `prompt_id` when present. Plan context is returned at prompt submission. Older payloads without native identity remain partial. |
| Cursor | sessionStart, beforeSubmitPrompt, postToolUse, afterAgentResponse, stop, sessionEnd | Uses `conversation_id` and native `generation_id`. Session-start context injection is supported; beforeSubmitPrompt records a boundary but its documented output does not provide context injection. Aborted/error stop status maps to cancellation. |
| Gemini CLI | BeforeAgent, AfterTool, AfterAgent, SessionEnd | Uses session/timestamp data to persist an explicitly session-local inferred turn token. BeforeAgent receives plan context. This does not assert a provider-native prompt ID. |

Contracts were checked against the official [Gemini hook reference](https://geminicli.com/docs/hooks/reference/), [Gemini configuration guidance](https://geminicli.com/docs/hooks/), [Claude hook reference](https://code.claude.com/docs/en/hooks) and [Cursor hook reference](https://cursor.com/docs/hooks). These describe payloads, not a claim that every released CLI version supports them. Claude failure/cancellation events can be represented by the protocol, but the installer does not add newer failure-hook names to an unverified older Claude installation.

Gemini CLI is separate from Antigravity, Gemini's website and Jules. This feature does not add adapters to those products or install/sign into a coding service. All Cobble changes use the existing bundled application runtime and Windows PowerShell; there is no new required package, paid API, account or server for Cobble itself.

## Implemented pipeline

The loopback bridge still requires its pairing token and the selected canonical workspace. Protocol 1 events carry stable event/session IDs, an optional turn ID, identity quality, sequence and occurrence time. Recognized providers/events and bounded fields are validated before linkage state changes. Unsupported protocols and expired/future ordering data are rejected.

Local SQLite receipt and turn tables persist across restart (additive migration 5). Re-delivery of an event is idempotent; reuse of its ID with changed content is rejected. A terminal turn cannot be reopened by a late context/write/complete event. Newer prompt contexts supersede an older open turn in the same session. Independent sessions retain independent active leases; closing one does not close the others. Replayed/delayed contexts do not invent current agent activity.

Completion/cancellation/end checkpoints can remain pending while paused, during host handover or integration, or after an I/O failure. Capturing an immutable evidence batch and marking its receipt captured happen in the same SQLite transaction. A retry after that commit cannot consume later edits. No-change checkpoints also complete their receipt. Restart/resume drains pending checkpoints conservatively; today's saved files cannot be reconstructed as an old turn's original state.

The local evidence trigger retains event and turn linkage plus `turn_boundary`, `partial`, `delayed` or `overlapping` coverage. A turn boundary is not proof that one agent authored every file in a mixed working directory. The new protocol therefore records actual saved diffs without assigning the assistant's explanation to the whole diff. Existing ID-less hooks remain a compatibility fallback with partial attribution; they do not gain protocol-1 retry guarantees.

Assistant declarations and event identity never approve scope, change the plan, vote, merge, revert, or independently establish unnecessary work. Existing path policies, approved exceptions, quiet uncertainty, targeted notification audiences and unanimous exact-commit main votes retain authority. Native event IDs and raw hook packets are not added to shared activities or teammate-host handover snapshots.

## Relay delivery and bounds

The PowerShell relay persists session mapping and a bounded outbox beside the app's pairing file, separated by workspace. It stores no pairing token in its queued payloads. Exact retries reuse recorded identity. Current context requests take priority over a small backlog. Successful event-ID acknowledgements remove queued records; retries use the current pairing credentials. Queue draining happens on later hook invocations, not through a separate always-running helper.

This is transport recovery while valid pairing information exists. Cobble removes its pairing file on normal shutdown, so hooks fired after closure fall back to ordinary saved-file observation on the next app start. They cannot reconstruct every offline prompt. A changed selected workspace is not silently paired to the old hook.

Bounds: 128 queued payloads and 128 session files per workspace, 64 recent identities per session, 1 MB maximum stdin, 4,000 prompt characters, 12,000 assistant-message characters, four delivery attempts per invocation with two-second request timeouts and a bounded delivery window. Payloads older than seven days are not replayed; old local state is cleaned after eight days. Capacity exhaustion falls back to saved-file monitoring rather than bypassing authentication or controlling an agent loop.

SQLite has bounds of 20,000 receipts, 4,000 retained turns, 128 pending checkpoints and 64 recently active open turns per local team. Completed old receipts/turns are pruned after eight days; pending source checkpoints are preserved. Provider prompts are hashed rather than stored in receipt rows. The relay outbox temporarily holds bounded prompt/response text locally until acknowledgement or expiry. It never reads provider transcripts, tool arguments or credentials. Completed checkpoint receipts discard their pending assistant text.

Encrypted backup includes these device-local tables. Offline recovery cancels pending hook replay and interrupts open turns. Deleting a team cascades its SQLite receipts/turns; project hook settings and their workspace-local relay state have their own remove/expiry lifecycle. The new `.gemini` configuration directory is excluded from code observation.

## Existing UI and handoff for Vyom

The existing coding-agent panel now includes **Enable Gemini CLI**, using `window.cobble.installAgent("gemini", remove?)`. Installation preserves unrelated settings and registered hooks; repeated installation is idempotent, and removal targets Cobble-owned commands. Gemini hooks disabled in existing settings stay disabled and diagnostics report that fact.

Optional app-state diagnostics are available as `agentTracking`:

```ts
{
  protocolVersion: 1,
  activeTurns: number,
  pendingCheckpoints: number,
  receipts: number,
  coverage: "saved_checkpoints_at_hook_boundaries"
}
```

No mascot redesign or new verdict UI is required. Do not label a configured hook as verified, a received completion as a semantic review, or a saved checkpoint as exclusive per-turn authorship. Cursor users need a fresh session to receive refreshed session-start plan context. Unknown/missing provider identity should remain visibly partial.

## Live verification still required

On a machine with the chosen existing CLI/account:

1. Pull source 0.4.8, run Cobble, select the project and enable that provider's hooks. Record the exact provider version and OS.
2. Start a fresh provider session in that project. For Gemini, inspect its hook panel/normal trust flow if required. Confirm that the starting plan reaches the context hook; do not treat the enable button as proof.
3. Ask for a tiny saved edit. Confirm a saved-diff activity and inspect the local evidence trigger: native Claude/Cursor IDs when supplied, session-local/partial Gemini identity. Repeat a prompt with identical text; it must remain a distinct turn where native IDs/timestamps distinguish it.
4. Cancel a turn that has already saved an edit. Confirm the saved file is eventually observed, with no invented successful completion or automatic agent continuation.
5. Pause Cobble, complete another prompt, then resume. Confirm pending receipts drain without attaching old text to new unrelated edits.
6. Use two sessions; completing one must leave the other session active. Close Cobble and reopen it after another saved edit; offline source changes should be observed without claiming exact offline turn history.
7. Change the plan and start the provider context hook again (a fresh Cursor session). Confirm the new revision is used. Remove Cobble hooks and confirm unrelated hooks/settings remain intact.

Do not mark the real-turn/version gate passed until these results are recorded. Provider-specific approval or authentication is governed by that provider, not silently bypassed by Cobble.

## Automated validation

Tests cover authenticated workspace boundaries, native and inferred identity, changed-ID rejection, retry deduplication, ordering/terminal guards, independent sessions, cancellation, delayed activity leases, atomic capture rollback, pending restart, recovery/deletion, hook preservation/removal, and actual PowerShell-to-bridge delivery with Gemini/Claude/Cursor fixtures and a retained failed-authentication retry. These fixtures do not replace the live checklist above.

Passed: `npm run check` (type checking, 176 tests and source build), desktop smoke and both shutdown scenarios. Final review added the delayed/replayed-context activity guard; all 13 affected hook/diagnostic tests, type checking, the source build and desktop smoke were rerun successfully. Shutdown assertions passed despite existing closing-handler/GPU log noise during teardown. No provider credentials were used and no provider model was invoked.

No independent semantic reviewer, new installer, cross-provider cloud integration or live provider accuracy claim is included in this source delivery.
