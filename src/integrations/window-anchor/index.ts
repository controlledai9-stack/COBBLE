/**
 * Cobble Window Anchor Integration (COBBLE-WINDOW-01 / G-01)
 * 
 * Exports the frozen adapter API, pure placement function, and native window tracker.
 */

export * from './contracts.js';
export { computeAnchorPlacement } from './placement.js';
export { createWindowTracker, DefaultWindowsProbe, WindowTrackerImpl } from './tracker.js';
