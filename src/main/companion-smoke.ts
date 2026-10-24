import assert from "node:assert/strict";
import { screen, type BrowserWindow } from "electron";

/** Isolated test profile only. No physical mouse input or user windows are changed. */
export async function runCompanionSmoke(companion: BrowserWindow) {
  const js = (source: string) =>
    companion.webContents.executeJavaScript(source);
  const settle = async () => {
    await js("window.cobble.state()");
    await new Promise((resolve) => setTimeout(resolve, 40));
  };
  const command = (name: string, point?: { x: number; y: number }) =>
    js(
      `window.cobble.companion(${JSON.stringify(name)}, ${JSON.stringify(point)})`,
    );
  const realCursor = screen.getCursorScreenPoint;
  let cursor = { x: 400, y: 300 };
  screen.getCursorScreenPoint = () => ({ ...cursor });
  try {
    await settle();
    await command("menu-close");
    companion.setBounds({ x: 100, y: 100, width: 160, height: 110 });
    await command("drag-start");
    for (let i = 0; i < 12; i++) {
      await command("drag-move", { x: 10000 + i * 100, y: -10000 });
    }
    assert.deepEqual(
      companion.getPosition(),
      [100, 100],
      "renderer offsets cannot move a stationary native cursor",
    );
    cursor = { x: 440, y: 325 };
    await command("drag-move");
    assert.deepEqual(companion.getPosition(), [140, 125]);
    for (let i = 0; i < 12; i++) await command("drag-move");
    assert.deepEqual(
      companion.getPosition(),
      [140, 125],
      "window movement events cannot accumulate drift",
    );
    await command("drag-end");
    cursor = { x: 800, y: 700 };
    await command("drag-move", { x: 50000, y: 50000 });
    assert.deepEqual(
      companion.getPosition(),
      [140, 125],
      "late moves after release must be ignored",
    );

    await command("menu-close");
    companion.setBounds({ x: 100, y: 100, width: 160, height: 110 });
    const before = companion.getBounds();
    await command("drag-start");
    let firstSize: number[] | undefined;
    for (let i = 0; i < 40; i++) {
      cursor = { ...cursor, y: cursor.y - 1 };
      await command("drag-move");
      const bounds = companion.getBounds();
      const size = [bounds.width, bounds.height];
      firstSize ??= size;
      assert.deepEqual(
        size,
        firstSize,
        "repeated moves must not grow the native Windows window",
      );
      assert.ok(
        Math.abs(bounds.width - before.width) <= 1 &&
          Math.abs(bounds.height - before.height) <= 1,
      );
    }
    await command("drag-end");

    // Exercise the actual React handlers. Offscreen Windows has no physical
    // pointer capture, so only that DOM facility is simulated here.
    await js(`(() => {
      const button = document.querySelector('.companion-placeholder');
      const captured = new Set();
      button.setPointerCapture = id => captured.add(id);
      button.hasPointerCapture = id => captured.has(id);
      button.releasePointerCapture = id => {
        captured.delete(id);
        button.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles:true, pointerId:id }));
      };
      window.reviewPointer = (type, extra = {}) => button.dispatchEvent(new PointerEvent(type, {
        bubbles:true, pointerId:1, pointerType:'mouse', isPrimary:true,
        button:0, buttons:1, screenX:400, screenY:300, clientX:30, clientY:30, ...extra
      }));
    })()`);
    const pose = () =>
      js("document.querySelector('.companion-host').className");
    const facePoint = () =>
      js(`(() => {
      const matrix = document.querySelector('.pebble-avatar').getScreenCTM();
      const point = new DOMPoint(106,86).matrixTransform(matrix);
      return {x:point.x,y:point.y};
    })()`);
    for (const zoom of [1, 1.25, 1.5]) {
      companion.webContents.setZoomFactor(zoom);
      await command("menu-close");
      companion.setBounds({ x: 100, y: 100, width: 160, height: 110 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const grabbed = await facePoint();
      cursor = { x: 100 + grabbed.x * zoom, y: 100 + grabbed.y * zoom };
      await js(
        `window.reviewPointer('pointerdown', {clientX:${grabbed.x},clientY:${grabbed.y},screenX:${cursor.x},screenY:${cursor.y}})`,
      );
      await settle();
      cursor = { ...cursor, y: cursor.y - 40 };
      await js(
        `window.reviewPointer('pointermove', {screenX:${cursor.x},screenY:${cursor.y}})`,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      const assertGrab = async (label: string) => {
        const point = await facePoint();
        const [x, y] = companion.getPosition();
        assert.ok(
          // Windows converts integer window coordinates through display scale;
          // allow two DIP of raster rounding, never accumulating displacement.
          Math.abs(x + point.x * zoom - cursor.x) <= 2,
          `${label}: face must not drift sideways at zoom ${zoom}: ${JSON.stringify({ x, y, point, cursor, pose: await pose(), bounds: companion.getBounds(), size: companion.getContentSize(), geometry: await js("({w:innerWidth,h:innerHeight,dpr:devicePixelRatio,rect:document.querySelector('.pebble-avatar').getBoundingClientRect().toJSON()})") })}`,
        );
        assert.ok(
          Math.abs(y + point.y * zoom - cursor.y) <= 2,
          `${label}: grabbed face must follow cursor vertically at zoom ${zoom}`,
        );
      };
      await assertGrab("vertical drag and existing hanging transform");
      // Native sampling continues while held, without relying on a backlog of
      // window-relative pointermove events. The grabbed graphic point is fixed.
      cursor = { x: cursor.x + 60, y: cursor.y };
      await new Promise((resolve) => setTimeout(resolve, 100));
      await assertGrab("horizontal drag");
      await js("window.reviewPointer('pointerup', {buttons:0})");
      await settle();
      const released = companion.getPosition();
      cursor = { x: cursor.x + 100, y: cursor.y + 100 };
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(
        companion.getPosition(),
        released,
        "native sampling must stop on release",
      );
    }
    companion.webContents.setZoomFactor(1);
    for (const ending of [
      "pointercancel",
      "lostpointercapture",
      "buttons-released",
      "blur",
    ]) {
      await js("window.reviewPointer('pointerdown')");
      await settle();
      assert.match(await pose(), /pose-dragging/);
      if (ending === "buttons-released")
        await js("window.reviewPointer('pointermove', {buttons:0})");
      else if (ending === "blur")
        await js("window.dispatchEvent(new Event('blur'))");
      else await js(`window.reviewPointer(${JSON.stringify(ending)})`);
      await settle();
      assert.match(
        await pose(),
        /pose-normal/,
        `${ending} must end the press even below the drag threshold`,
      );
      const stopped = companion.getPosition();
      cursor = { x: cursor.x + 50, y: cursor.y + 50 };
      await js(
        "window.reviewPointer('pointermove', {screenX:9000, screenY:9000})",
      );
      await settle();
      assert.deepEqual(
        companion.getPosition(),
        stopped,
        `${ending} must prevent continued wandering`,
      );
    }
    await js("window.reviewPointer('pointerdown', {button:2, buttons:2})");
    await settle();
    assert.match(
      await pose(),
      /pose-normal/,
      "right click must not start a drag",
    );

    await js("window.reviewPointer('pointerdown')");
    await js("window.reviewPointer('pointerup', {buttons:0})");
    await settle();
    assert.equal(
      await js("!!document.querySelector('.companion-menu')"),
      true,
      "an ordinary click still opens the existing menu",
    );
    assert.match(await pose(), /pose-normal/);
    const resting = companion.getPosition();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.deepEqual(
      companion.getPosition(),
      resting,
      "the animated robot must not move the desktop window at rest",
    );
    console.log(
      "COBBLE_COMPANION_OK: stationary cursor, face follows vertical/horizontal drag at 100/125/150% zoom, pose transforms preserve grab point, release/cancel/lost capture/blur, click menu, animations at rest",
    );
  } finally {
    screen.getCursorScreenPoint = realCursor;
    await command("drag-end");
  }
}
