import React, { useState, useEffect } from "react";
import type {
  AppState,
  ExtendedAction,
  HostingCandidate,
  HostingState,
} from "../shared/types";
import "./hosting-panel.css";

export interface HostingPanelProps {
  state: AppState;
  act: (action: ExtendedAction) => Promise<boolean>;
  busy: boolean;
}

export function HostingPanel({
  state,
  act,
  busy,
}: HostingPanelProps): React.JSX.Element {
  const hosting: HostingState | undefined = state.hosting;
  const team = state.teams.find((t) => t.id === state.activeTeamId) ?? state.teams[0];
  const profile = state.profile;

  // Local form state for candidacy configuration
  const [allowDevice, setAllowDevice] = useState<boolean>(
    Boolean(hosting?.allowThisDevice),
  );
  const [address, setAddress] = useState<string>(
    hosting?.advertisedAddress || "",
  );
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error" | "info";
    message: string;
  } | null>(null);

  // Synchronize local form state with incoming state updates when not saving
  useEffect(() => {
    if (hosting && !isSaving) {
      setAllowDevice(Boolean(hosting.allowThisDevice));
      setAddress(hosting.advertisedAddress || "");
    }
  }, [hosting?.allowThisDevice, hosting?.advertisedAddress, isSaving]);

  // If hosting subsystem is unavailable on this backend
  if (!hosting || !hosting.available) {
    return (
      <section
        className="cobble-hosting-panel cobble-hosting-unavailable"
        aria-labelledby="hosting-panel-title"
      >
        <header className="cobble-hosting-header">
          <div className="cobble-hosting-title-group">
            <h2 id="hosting-panel-title">Team Hosting Coordination</h2>
            <p className="cobble-hosting-subtitle">
              Decentralized host election & peer relay
            </p>
          </div>
        </header>
        <div
          className="cobble-hosting-card cobble-hosting-notice-card"
          role="status"
          aria-live="polite"
        >
          <div className="cobble-hosting-notice-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <div className="cobble-hosting-notice-content">
            <h3 className="cobble-hosting-notice-title">Hosting Subsystem Unavailable</h3>
            <p className="cobble-hosting-muted">
              Live host migration is not active on this backend version or network configuration.
              Teammate connections and local collaboration remain functional.
            </p>
          </div>
        </div>
      </section>
    );
  }

  const isManager = Boolean(team && profile && team.ownerId === profile.id);
  const isCurrentHost = Boolean(hosting.hostId && profile && hosting.hostId === profile.id);
  const managerMember = team
    ? state.members.find((m) => m.id === team.ownerId)
    : undefined;
  const managerName = managerMember
    ? managerMember.name
    : team?.ownerId === profile?.id
      ? profile?.name || "You"
      : "Unknown Manager";

  const hostMember = hosting.hostId
    ? state.members.find((m) => m.id === hosting.hostId)
    : undefined;
  const hostDisplayName = hosting.hostId
    ? hostMember
      ? hostMember.name
      : isCurrentHost
        ? `${profile?.name || "This Laptop"} (You)`
        : hosting.hostId
    : "Local Creator (Initial Host)";

  const isTransitioning =
    hosting.phase === "preparing" || hosting.phase === "committing";
  const isFenced = Boolean(hosting.fenced);

  // Disable candidacy configuration when busy, fenced, transitioning, or if actively hosting
  const isCandidacyDisabled =
    busy || isSaving || isFenced || isTransitioning || (isCurrentHost && hosting.phase === "hosting");

  // Disable automatic evaluation button when busy, fenced, transitioning, or already evaluating
  const isEvalDisabled =
    busy || isEvaluating || isFenced || isTransitioning || hosting.phase === "evaluating";

  const handleSaveCandidacy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isCandidacyDisabled) return;
    setIsSaving(true);
    setFeedback(null);
    try {
      const cleanAddress = address.trim();
      const success = await act({
        type: "configureHosting",
        allow: allowDevice,
        address: cleanAddress.length > 0 ? cleanAddress : undefined,
      });
      if (success) {
        setFeedback({
          type: "success",
          message: allowDevice
            ? "Candidacy settings saved. This laptop is now eligible to host."
            : "Candidacy settings saved. This laptop has opted out of hosting.",
        });
      } else {
        setFeedback({
          type: "error",
          message: "Failed to update hosting candidacy settings.",
        });
      }
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleEvaluate = async () => {
    if (isEvalDisabled) return;
    setIsEvaluating(true);
    setFeedback(null);
    try {
      const success = await act({ type: "evaluateHosting" });
      if (success) {
        setFeedback({
          type: "info",
          message: "Host evaluation initiated. Probing candidates across peers.",
        });
      } else {
        setFeedback({
          type: "error",
          message: "Evaluation request could not be processed.",
        });
      }
    } catch (err) {
      setFeedback({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsEvaluating(false);
    }
  };

  // Phase metadata badge helper
  const getPhaseMeta = (phase: HostingState["phase"]) => {
    switch (phase) {
      case "local":
        return { label: "Local Authority", tone: "neutral", desc: "Running on initial session host" };
      case "collecting":
        return { label: "Collecting Reports", tone: "info", desc: "Gathering peer capacity hints" };
      case "evaluating":
        return { label: "Evaluating Candidates", tone: "warning", desc: "Ranking verified peer nodes" };
      case "preparing":
        return { label: "Preparing Transfer", tone: "active", desc: "Transferring state snapshot" };
      case "committing":
        return { label: "Committing Route", tone: "active", desc: "Verifying peer acknowledgements" };
      case "hosting":
        return { label: "Delegated Host", tone: "success", desc: "This device is serving team traffic" };
      case "following":
        return { label: "Connected Client", tone: "info", desc: "Following authoritative peer host" };
      case "blocked":
        return { label: "Migration Blocked", tone: "danger", desc: "Handover halted or on hold" };
      default:
        return { label: phase, tone: "neutral", desc: "Unknown state" };
    }
  };

  const phaseMeta = getPhaseMeta(hosting.phase);

  return (
    <section
      className="cobble-hosting-panel"
      aria-labelledby="hosting-panel-title"
    >
      {/* Header */}
      <header className="cobble-hosting-header">
        <div className="cobble-hosting-title-group">
          <div className="cobble-hosting-badge-row">
            <span className="cobble-hosting-pill cobble-pill-blueprint">Decentralized Relay</span>
            <span className={`cobble-hosting-pill cobble-pill-${phaseMeta.tone}`}>
              {phaseMeta.label}
            </span>
          </div>
          <h2 id="hosting-panel-title">Team Hosting & Relays</h2>
          <p className="cobble-hosting-subtitle">
            Dynamic host election based on hardware capacity and verified HTTPS reachability.
          </p>
        </div>
      </header>

      {/* Authority Overview: Host vs Manager Separation */}
      <div className="cobble-hosting-authority-grid">
        {/* Current Host Card */}
        <div className="cobble-hosting-card cobble-authority-card">
          <div className="cobble-authority-header">
            <span className="cobble-authority-type">Current Active Host</span>
            {isCurrentHost && (
              <span className="cobble-tag cobble-tag-amber">This Device</span>
            )}
          </div>
          <div className="cobble-authority-name" title={hosting.hostId || undefined}>
            {hostDisplayName}
          </div>
          <div className="cobble-authority-details">
            <span className="cobble-detail-item">
              <strong className="cobble-detail-label">Epoch:</strong> #{hosting.epoch}
            </span>
            <span className="cobble-detail-item">
              <strong className="cobble-detail-label">Endpoint:</strong>{" "}
              {hosting.advertisedAddress ? (
                <code>{hosting.advertisedAddress}</code>
              ) : (
                <span className="cobble-muted">LAN Discovery</span>
              )}
            </span>
          </div>
          <p className="cobble-authority-footnote">
            Serves active peer sockets and routes shared team edits.
          </p>
        </div>

        {/* Team Manager Card */}
        <div className="cobble-hosting-card cobble-authority-card">
          <div className="cobble-authority-header">
            <span className="cobble-authority-type">Team Manager</span>
            {isManager && (
              <span className="cobble-tag cobble-tag-periwinkle">You</span>
            )}
          </div>
          <div className="cobble-authority-name">
            {managerName}
            {isManager && " (You)"}
          </div>
          <div className="cobble-authority-details">
            <span className="cobble-detail-item">
              <strong className="cobble-detail-label">Authority:</strong> Git Integrator & Membership
            </span>
            <span className="cobble-detail-item">
              <strong className="cobble-detail-label">Role:</strong>{" "}
              {isCurrentHost ? "Manager & Host" : "Manager (Client Node)"}
            </span>
          </div>
          <p className="cobble-authority-footnote">
            Hosting authority never grants Git manager permissions.
          </p>
        </div>
      </div>

      {/* Non-dismissible Fencing Warning Notice */}
      {isFenced && (
        <div
          className="cobble-hosting-alert-banner cobble-alert-warning"
          role="alert"
          aria-live="assertive"
        >
          <div className="cobble-alert-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div className="cobble-alert-body">
            <strong>Shared writes temporarily queued (Fenced)</strong>
            <p>
              Hosting election or failover state is fenced. Edits and votes are queued safely
              in local memory and will be sent automatically once hosting stabilizes.
            </p>
          </div>
        </div>
      )}

      {/* Non-dismissible Migration Progress (Preparing / Committing) without fake ETAs */}
      {isTransitioning && (
        <div
          className="cobble-hosting-alert-banner cobble-alert-transferring"
          role="status"
          aria-live="polite"
        >
          <div className="cobble-transfer-progress-rail" aria-hidden="true">
            <div className="cobble-transfer-progress-bar" />
          </div>
          <div className="cobble-alert-body">
            <strong>
              {hosting.phase === "preparing"
                ? "State transfer in progress: bounded history handover"
                : "Committing host migration: awaiting peer route acknowledgements"}
            </strong>
            <p>
              Please keep Cobble open and connected. No shared edits will be lost.
              (State transfer does not use fake timers or forced resets).
            </p>
          </div>
        </div>
      )}

      {/* Phase & Reason Status Region */}
      <div
        className={`cobble-hosting-status-box cobble-status-${phaseMeta.tone}`}
        role="status"
        aria-live="polite"
      >
        <div className="cobble-status-header">
          <span className="cobble-status-indicator" aria-hidden="true" />
          <span className="cobble-status-phase-label">
            Phase: <strong>{phaseMeta.label}</strong>
          </span>
          <span className="cobble-status-epoch">Epoch #{hosting.epoch}</span>
        </div>
        <p className="cobble-status-reason">
          <strong>Backend Status:</strong>{" "}
          {hosting.reason || phaseMeta.desc}
        </p>
      </div>

      {/* Feedback banner for user actions */}
      {feedback && (
        <div
          className={`cobble-hosting-feedback cobble-feedback-${feedback.type}`}
          role="status"
          aria-live="polite"
        >
          <span>{feedback.message}</span>
          <button
            type="button"
            className="cobble-feedback-dismiss"
            onClick={() => setFeedback(null)}
            aria-label="Dismiss message"
          >
            ×
          </button>
        </div>
      )}

      {/* Candidacy Configuration Form */}
      <section
        className="cobble-hosting-card cobble-candidacy-card"
        aria-labelledby="candidacy-section-title"
      >
        <form onSubmit={(e) => void handleSaveCandidacy(e)}>
          <fieldset
            disabled={isCandidacyDisabled}
            className="cobble-hosting-fieldset"
          >
            <legend id="candidacy-section-title" className="cobble-card-title">
              Local Laptop Candidacy Settings
            </legend>
            <p className="cobble-card-desc">
              Opting in makes this computer eligible to host the team if the team manager
              initiates host evaluation.
            </p>

            {/* Trust and Resource Disclosure Banner */}
            <div className="cobble-disclosure-box">
              <div className="cobble-disclosure-item">
                <span className="cobble-disclosure-icon" aria-hidden="true">⚡</span>
                <p>
                  <strong>Resource use:</strong> Hosting uses local memory and CPU threads to maintain
                  peer sockets and broadcast plan updates.
                </p>
              </div>
              <div className="cobble-disclosure-item">
                <span className="cobble-disclosure-icon" aria-hidden="true">🔒</span>
                <p>
                  <strong>Security & Privacy:</strong> The host laptop relays team traffic and private team
                  messages. Only opt in on a trusted, secure device.
                </p>
              </div>
            </div>

            {/* Checkbox: Allow this laptop to host */}
            <div className="cobble-form-group">
              <label className="cobble-checkbox-label">
                <input
                  type="checkbox"
                  checked={allowDevice}
                  disabled={isCandidacyDisabled}
                  onChange={(e) => setAllowDevice(e.target.checked)}
                />
                <span className="cobble-checkbox-text">
                  <strong>Allow this laptop to host</strong>
                  <small className="cobble-muted">
                    Report hardware capacity hints and participate in candidate elections.
                  </small>
                </span>
              </label>
            </div>

            {/* Advertised HTTPS Address Input */}
            <div className="cobble-form-group">
              <label
                htmlFor="cobble-advertised-address"
                className="cobble-input-label"
              >
                Advertised HTTPS Address & Port (Optional)
              </label>
              <input
                id="cobble-advertised-address"
                type="text"
                className="cobble-input-text"
                placeholder="https://laptop.example.com:8443 (leave blank for local LAN)"
                value={address}
                disabled={isCandidacyDisabled}
                onChange={(e) => setAddress(e.target.value)}
                aria-describedby="address-help-text"
              />
              <p id="address-help-text" className="cobble-input-hint">
                Leave blank for automatic local area network (LAN) discovery. For remote
                or cross-network teammates, provide a reachable certificate-pinned HTTPS origin.
                Cobble does not rely on third-party cloud fallbacks.
              </p>
            </div>

            {/* Active Host Guard Notice */}
            {isCurrentHost && hosting.phase === "hosting" && (
              <p className="cobble-host-locked-note">
                ⓘ This laptop is currently the authoritative host. Candidacy settings cannot
                be altered until hosting is delegated to another teammate.
              </p>
            )}

            {/* Form Actions */}
            <div className="cobble-form-actions">
              <button
                type="submit"
                className="cobble-button-primary"
                disabled={isCandidacyDisabled}
              >
                {isSaving ? "Saving Settings..." : "Save Candidacy Settings"}
              </button>
            </div>
          </fieldset>
        </form>
      </section>

      {/* Manager-Only Evaluation Action */}
      <section
        className="cobble-hosting-card cobble-manager-card"
        aria-labelledby="manager-section-title"
      >
        <div className="cobble-manager-header">
          <div className="cobble-manager-title-row">
            <h3 id="manager-section-title" className="cobble-card-title">
              Automatic Host Evaluation
            </h3>
            {isManager ? (
              <span className="cobble-tag cobble-tag-amber">Manager Control</span>
            ) : (
              <span className="cobble-tag cobble-tag-muted">Manager Only</span>
            )}
          </div>
          <p className="cobble-card-desc">
            The team manager initiates evaluation when all teammates are online. The backend
            probes candidate hardware metrics and verified HTTPS reachability, migrating to
            a candidate only if it improves capacity score by ≥20%.
          </p>
        </div>

        {isManager ? (
          <div className="cobble-manager-action-box">
            <button
              type="button"
              className="cobble-button-accent"
              onClick={() => void handleEvaluate()}
              disabled={isEvalDisabled}
              aria-describedby="eval-rules-desc"
            >
              {isEvaluating ? (
                "Evaluating Candidates..."
              ) : (
                "Team ready — choose host automatically"
              )}
            </button>
            <p id="eval-rules-desc" className="cobble-manager-rules-text">
              Requires all approved teammates to be online for fresh probes and route
              acknowledgements. A 5-minute cooldown is enforced between transfers.
            </p>
          </div>
        ) : (
          <div className="cobble-manager-restricted-box">
            <p className="cobble-muted">
              Only team manager <strong>{managerName}</strong> can initiate automatic host evaluation.
              Your laptop will report its capacity hints automatically if opted in.
            </p>
          </div>
        )}
      </section>

      {/* Candidates Roster */}
      <section
        className="cobble-hosting-card cobble-candidates-card"
        aria-labelledby="candidates-roster-title"
      >
        <div className="cobble-candidates-header">
          <h3 id="candidates-roster-title" className="cobble-card-title">
            Reported Candidate Laptops ({hosting.candidates.length})
          </h3>
          <p className="cobble-card-desc">
            Capacity summaries and peer-verified reachability. Transfers are handled automatically
            by the ranking backend; manual forced transfers are not supported.
          </p>
        </div>

        {hosting.candidates.length === 0 ? (
          <div className="cobble-candidates-empty">
            <p className="cobble-muted">
              No teammate candidates have reported capacity yet.
              Teammates must opt in and be connected to the team session.
            </p>
          </div>
        ) : (
          <div className="cobble-candidates-grid" role="list">
            {hosting.candidates.map((c: HostingCandidate) => {
              const isCandidateMe = c.memberId === profile?.id;
              const isCandidateCurrentHost = c.memberId === hosting.hostId;
              const freeGb = (c.freeMemoryMB / 1024).toFixed(1);
              const totalGb = (c.memoryMB / 1024).toFixed(1);
              const memoryPercent = c.memoryMB > 0
                ? Math.round((c.freeMemoryMB / c.memoryMB) * 100)
                : 0;

              return (
                <article
                  key={c.memberId}
                  className={`cobble-candidate-item ${
                    isCandidateCurrentHost ? "cobble-candidate-current-host" : ""
                  }`}
                  role="listitem"
                >
                  <header className="cobble-candidate-header">
                    <div className="cobble-candidate-name-col">
                      <h4 className="cobble-candidate-name">
                        {c.name}
                        {isCandidateMe && (
                          <span className="cobble-inline-badge">You</span>
                        )}
                      </h4>
                      {isCandidateCurrentHost && (
                        <span className="cobble-candidate-host-tag">
                          Active Host
                        </span>
                      )}
                    </div>
                    <div className="cobble-candidate-score-badge">
                      <span className="cobble-candidate-score-label">Score</span>
                      <span className="cobble-candidate-score-val">
                        {c.score > 0 ? c.score.toFixed(1) : "0"}
                      </span>
                    </div>
                  </header>

                  {/* Hardware & Capacity Summary */}
                  <div className="cobble-candidate-specs">
                    <div className="cobble-spec-chip" title="Logical CPU threads">
                      <span className="cobble-spec-icon" aria-hidden="true">⚙</span>
                      <span>{c.cpuThreads} Threads</span>
                    </div>
                    <div
                      className="cobble-spec-chip"
                      title={`${c.freeMemoryMB} MB free of ${c.memoryMB} MB total`}
                    >
                      <span className="cobble-spec-icon" aria-hidden="true">💾</span>
                      <span>
                        {freeGb} GB Free / {totalGb} GB ({memoryPercent}%)
                      </span>
                    </div>
                  </div>

                  {/* Verification Flags */}
                  <div className="cobble-candidate-flags">
                    <span
                      className={`cobble-status-flag ${
                        c.willing ? "flag-success" : "flag-muted"
                      }`}
                    >
                      {c.willing ? "✓ Opted In" : "✗ Opted Out"}
                    </span>
                    <span
                      className={`cobble-status-flag ${
                        c.reachable ? "flag-success" : "flag-danger"
                      }`}
                    >
                      {c.reachable ? "✓ HTTPS Reachable" : "✗ Unreachable"}
                    </span>
                  </div>

                  {/* Backend Assessment Reason */}
                  <div className="cobble-candidate-reason">
                    <span className="cobble-reason-label">Backend Evaluation:</span>
                    <span className="cobble-reason-text">
                      {c.reason || "Awaiting verification report."}
                    </span>
                  </div>

                  {/* Timestamp */}
                  <footer className="cobble-candidate-footer">
                    <time
                      dateTime={c.reportedAt}
                      className="cobble-candidate-time"
                    >
                      Reported: {new Date(c.reportedAt).toLocaleTimeString()}
                    </time>
                  </footer>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* Diagnostics & Technical Details (Collapsible) */}
      <details className="cobble-hosting-card cobble-diagnostics-card">
        <summary className="cobble-diagnostics-summary">
          <span>Diagnostics & Routing Protocol Details</span>
          <span className="cobble-diagnostics-hint">Click to inspect</span>
        </summary>
        <div className="cobble-diagnostics-content">
          <dl className="cobble-diagnostics-list">
            <dt>Hosting Subsystem Available</dt>
            <dd>{hosting.available ? "Yes (Active)" : "No"}</dd>

            <dt>Protocol Epoch</dt>
            <dd>#{hosting.epoch}</dd>

            <dt>Automatic Mode</dt>
            <dd>{hosting.automatic ? "Enabled" : "Manual / On Demand"}</dd>

            <dt>Fencing Lock</dt>
            <dd>{hosting.fenced ? "Active (Writes Queued)" : "None (Clear)"}</dd>

            <dt>Host Member ID</dt>
            <dd><code>{hosting.hostId || "null (Initial creator)"}</code></dd>

            <dt>Advertised Address</dt>
            <dd>
              <code>{hosting.advertisedAddress || "None (LAN auto-discovery)"}</code>
            </dd>

            <dt>Active Team ID</dt>
            <dd><code>{state.activeTeamId || "None"}</code></dd>
          </dl>
          <p className="cobble-diagnostics-disclaimer">
            Sensitive security tokens, shared credentials, and private keys are withheld
            from diagnostic presentation.
          </p>
        </div>
      </details>
    </section>
  );
}
