import { test } from "node:test";
import assert from "node:assert/strict";
import { CompanionDrag } from "../src/main/companion";

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
