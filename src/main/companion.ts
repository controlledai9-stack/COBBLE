import type { CompanionMode } from "../shared/types";

type Point = { x: number; y: number };
type DragBounds = Point & { width?: number; height?: number };

export function clampCompanionBounds(
  bounds: Point & { width: number; height: number },
  area: Point & { width: number; height: number },
) {
  return {
    ...bounds,
    x: Math.round(
      Math.max(
        area.x,
        Math.min(bounds.x, area.x + Math.max(0, area.width - bounds.width)),
      ),
    ),
    y: Math.round(
      Math.max(
        area.y,
        Math.min(bounds.y, area.y + Math.max(0, area.height - bounds.height)),
      ),
    ),
  };
}

/** Both the cursor and window positions come from Electron, in screen DIP. */
export class CompanionDrag {
  private origin: {
    grab: Point;
    last: Point;
    size?: { width: number; height: number };
  } | null = null;

  get active() {
    return this.origin !== null;
  }

  start(cursor: Point, window: DragBounds, grab?: Point) {
    if (![cursor.x, cursor.y, window.x, window.y].every(Number.isFinite))
      return;
    this.origin = {
      // Use the pointer-down hit point when available. Sampling the cursor
      // later, after IPC delivery, can anchor a different spot on the robot.
      grab:
        grab && [grab.x, grab.y].every(Number.isFinite)
          ? { ...grab }
          : { x: cursor.x - window.x, y: cursor.y - window.y },
      last: { ...window },
      size:
        typeof window.width === "number" &&
        typeof window.height === "number" &&
        Number.isFinite(window.width) &&
        Number.isFinite(window.height) &&
        window.width > 0 &&
        window.height > 0
          ? { width: window.width, height: window.height }
          : undefined,
    };
  }

  move(cursor: Point, grab?: Point): DragBounds | null {
    const origin = this.origin;
    if (!origin || ![cursor.x, cursor.y].every(Number.isFinite)) return null;
    if (grab && [grab.x, grab.y].every(Number.isFinite))
      origin.grab = { ...grab };
    const next = {
      x: Math.round(cursor.x - origin.grab.x),
      y: Math.round(cursor.y - origin.grab.y),
    };
    // Moving the window can generate more pointer events without moving the
    // physical mouse. Those events must never move the window again.
    if (next.x === origin.last.x && next.y === origin.last.y) return null;
    origin.last = next;
    // Preserve the full original rectangle. On Windows fractional scaling,
    // setPosition can round and reuse a different width/height on every move.
    // A bottom/right-aligned avatar would then drift inside its growing window.
    return { ...next, ...origin.size };
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
