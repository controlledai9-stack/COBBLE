import type { CompanionMode } from "../shared/types";
export class CompanionMachine {
  mode: CompanionMode = "normal";
  lastInteraction = Date.now();
  constructor(readonly idleAfter = 45_000) {}
  interact(now = Date.now()) {
    this.mode = "normal";
    this.lastInteraction = now;
    return this.mode;
  }
  dragStart(now = Date.now()) {
    this.mode = "dragging";
    this.lastInteraction = now;
    return this.mode;
  }
  dragEnd(now = Date.now()) {
    return this.interact(now);
  }
  tick(now = Date.now()) {
    if (
      this.mode !== "dragging" &&
      now - this.lastInteraction >= this.idleAfter
    )
      this.mode = "idle";
    return this.mode;
  }
}
export function dockToEdge(
  bounds: { x: number; y: number; width: number; height: number },
  area: { x: number; y: number; width: number; height: number },
) {
  const x = Math.max(
    area.x,
    Math.min(bounds.x, area.x + area.width - bounds.width),
  );
  const y = Math.max(
    area.y,
    Math.min(bounds.y, area.y + area.height - bounds.height),
  );
  const candidates = [
    { x: area.x + 6, y },
    { x: area.x + area.width - bounds.width - 6, y },
    { x, y: area.y + 6 },
    { x, y: area.y + area.height - bounds.height - 6 },
  ];
  return candidates.sort(
    (a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y),
  )[0];
}
