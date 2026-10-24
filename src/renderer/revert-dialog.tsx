import type { RevertPreview } from "../shared/types";
import { useState } from "react";
export function RevertDialog({
  preview,
  close,
  onError,
}: {
  preview: RevertPreview;
  close: () => void;
  onError: (error: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const applicable = preview.files.every((f) => f.canApply);
  return (
    <div className="review-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="revert-title"
        className="panel review-dialog"
      >
        <div className="section-title">
          <h2 id="revert-title">Review the exact changes to revert</h2>
          <button className="secondary" disabled={busy} onClick={close}>
            Close
          </button>
        </div>
        <p className="small">
          Only this saved batch is proposed for reversal. Earlier work and
          non-overlapping later edits are preserved. Review every patch: a saved
          batch can contain both agent and manual edits.
        </p>
        {preview.files.map((f) => (
          <div key={f.path}>
            <h3>{f.path}</h3>
            {f.reason && <p className="error">{f.reason}</p>}
            <pre>{f.patch}</pre>
          </div>
        ))}
        <button
          disabled={!applicable || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await window.cobble.applyRevert(
                preview.activityId,
                preview.token,
              );
              close();
            } catch (error) {
              onError(error instanceof Error ? error.message : String(error));
            } finally {
              setBusy(false);
            }
          }}
        >
          Continue to revert confirmation
        </button>
        {!applicable && (
          <p className="small">
            Some edits overlap or are unavailable. Use the IDE diff to resolve
            those files manually.
          </p>
        )}
      </section>
    </div>
  );
}
