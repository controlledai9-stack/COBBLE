import type { CompanionMode } from "../shared/types";

type Point = { x: number; y: number };

/** Both the cursor and window positions come from Electron, in screen DIP. */
export class CompanionDrag {
  private origin: { cursor: Point; window: Point; last: Point } | null = null;

  get active() {
    return this.origin !== null;
  }

  start(cursor: Point, window: Point) {
    if (![cursor.x, cursor.y, window.x, window.y].every(Number.isFinite))
      return;
    this.origin = {
      cursor: { ...cursor },
      window: { ...window },
      last: { ...window },
    };
  }

  move(cursor: Point): Point | null {
    const origin = this.origin;
    if (!origin || ![cursor.x, cursor.y].every(Number.isFinite)) return null;
    const next = {
      x: Math.round(origin.window.x + cursor.x - origin.cursor.x),
      y: Math.round(origin.window.y + cursor.y - origin.cursor.y),
    };
    // Moving the window can generate more pointer events without moving the
    // physical mouse. Those events must never move the window again.
    if (next.x === origin.last.x && next.y === origin.last.y) return null;
    origin.last = next;
    return next;
  }

  stop() {
    this.origin = null;
  }
}

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
