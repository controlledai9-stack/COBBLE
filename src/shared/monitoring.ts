export const COVERAGE_BASELINE_NOTE =
  "Saved text files only; unsaved buffers are not observed.";
export const COVERAGE_NO_WORKSPACE_NOTE =
  "Choose a workspace to start watching saved changes.";

/** Coverage entries describing real monitoring limits: everything except the two informational notes above. */
export function coverageLimits(coverage: readonly string[]): string[] {
  return coverage.filter(
    (note) =>
      note !== COVERAGE_BASELINE_NOTE && note !== COVERAGE_NO_WORKSPACE_NOTE,
  );
}
