import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanionDrag, clampCompanionBounds } from "../src/main/companion";

test("window-generated pointer events cannot move a stationary cursor drag", () => {
  const drag = new CompanionDrag();
  drag.start({ x: 600, y: 400 }, { x: 550, y: 350 });
  for (let i = 0; i < 100; i++) {
    assert.equal(drag.move({ x: 600, y: 400 }), null);
  }
  assert.deepEqual(drag.move({ x: 640, y: 420 }), { x: 590, y: 370 });
  for (let i = 0; i < 100; i++) {
    assert.equal(drag.move({ x: 640, y: 420 }), null);
  }
});

test("movement is anchored to the press in DIP, without accumulated drift", () => {
  const drag = new CompanionDrag();
  drag.start({ x: -900.5, y: 200.5 }, { x: -950, y: 150 });
  assert.deepEqual(drag.move({ x: -800.5, y: 250.5 }), { x: -850, y: 200 });
  assert.deepEqual(drag.move({ x: -920.5, y: 190.5 }), { x: -970, y: 140 });
  assert.deepEqual(drag.move({ x: -900.5, y: 200.5 }), { x: -950, y: 150 });
});

test("released drags ignore delayed move events and a new press gets a fresh anchor", () => {
  const drag = new CompanionDrag();
  assert.equal(drag.move({ x: 100, y: 100 }), null);
  drag.start({ x: 100, y: 100 }, { x: 50, y: 50 });
  drag.stop();
  assert.equal(drag.active, false);
  assert.equal(drag.move({ x: 10000, y: -10000 }), null);
  drag.start({ x: 300, y: 200 }, { x: 500, y: 300 });
  assert.deepEqual(drag.move({ x: 310, y: 190 }), { x: 510, y: 290 });
});

test("invalid native samples do not corrupt the drag anchor", () => {
  const drag = new CompanionDrag();
  drag.start({ x: NaN, y: 100 }, { x: 50, y: 50 });
  assert.equal(drag.active, false);
  drag.start({ x: 100, y: 100 }, { x: 50, y: 50 });
  assert.equal(drag.move({ x: Infinity, y: 200 }), null);
  assert.deepEqual(drag.move({ x: 110, y: 120 }), { x: 60, y: 70 });
});

test("the grabbed face point survives delayed IPC instead of sampling a new grab spot", () => {
  const drag = new CompanionDrag();
  // The native cursor has already moved when the pointer-down IPC is handled.
  drag.start({ x: 230, y: 120 }, { x: 100, y: 100 }, { x: 117, y: 37 });
  assert.deepEqual(drag.move({ x: 217, y: 107 }), { x: 100, y: 70 });
  assert.deepEqual(drag.move({ x: 217, y: 77 }), { x: 100, y: 40 });
  assert.deepEqual(drag.move({ x: 247, y: 77 }), { x: 130, y: 40 });
});

test("an existing pose transform can change without moving the grabbed pixel away from the cursor", () => {
  const drag = new CompanionDrag();
  drag.start({ x: 217, y: 137 }, { x: 100, y: 100 }, { x: 117, y: 37 });
  const cursor = { x: 217, y: 107 };
  for (const grab of [
    { x: 117, y: 37 },
    { x: 115, y: 33 },
    { x: 114, y: 30 },
  ]) {
    const position = drag.move(cursor, grab)!;
    assert.equal(position.x + grab.x, cursor.x);
    assert.equal(position.y + grab.y, cursor.y);
  }
  assert.equal(drag.move(cursor, { x: 114, y: 30 }), null);
  drag.stop();
  assert.equal(drag.move({ x: 500, y: 500 }, { x: 114, y: 30 }), null);
});

test("repeated moves preserve the original window dimensions instead of accumulating rounding growth", () => {
  const drag = new CompanionDrag();
  drag.start(
    { x: 217, y: 137 },
    { x: 100, y: 100, width: 160, height: 110 },
    { x: 117, y: 37 },
  );
  for (let i = 1; i <= 100; i++) {
    const next = drag.move({ x: 217, y: 137 - i })!;
    assert.equal(next.width, 160);
    assert.equal(next.height, 110);
    assert.equal(next.x, 100);
    assert.equal(next.y, 100 - i);
  }
});

test("a position saved by the old runaway drag is restored into a current monitor", () => {
  assert.deepEqual(
    clampCompanionBounds(
      { x: 11200, y: -9900, width: 160, height: 110 },
      { x: 0, y: 0, width: 1920, height: 1040 },
    ),
    { x: 1760, y: 0, width: 160, height: 110 },
  );
  assert.deepEqual(
    clampCompanionBounds(
      { x: -1600, y: 250, width: 160, height: 110 },
      { x: -1920, y: 0, width: 1920, height: 1040 },
    ),
    { x: -1600, y: 250, width: 160, height: 110 },
  );
});
