import test from "node:test";
import assert from "node:assert/strict";
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";

const SCREENS = [
  "overview",
  "discussions",
  "workspace-plan",
  "workspace-plan-ownership",
  "workspace-plan-proposals",
  "workspace-plan-alerts",
  "join-requests",
  "profile-settings",
];
const THEMES = ["dark", "light"];

test("Phase 0 baseline screenshot suite verification", async (t) => {
  const screenshotsDir = join(process.cwd(), "test", "screenshots");

  for (const screen of SCREENS) {
    for (const theme of THEMES) {
      await t.test(`Screenshot baseline for ${screen} (${theme})`, async () => {
        const file = join(screenshotsDir, `${screen}-${theme}.png`);
        let fileStat;
        try {
          fileStat = await stat(file);
        } catch {
          assert.fail(`Missing required baseline screenshot: ${screen}-${theme}.png`);
        }

        // Must be non-empty image (> 5KB)
        assert.ok(
          fileStat.size > 5000,
          `Screenshot ${screen}-${theme}.png is too small (${fileStat.size} bytes)`,
        );

        // Verify PNG magic header bytes: 89 50 4E 47 0D 0A 1A 0A
        const buf = await readFile(file);
        const isPng =
          buf[0] === 0x89 &&
          buf[1] === 0x50 &&
          buf[2] === 0x4e &&
          buf[3] === 0x47 &&
          buf[4] === 0x0d &&
          buf[5] === 0x0a &&
          buf[6] === 0x1a &&
          buf[7] === 0x0a;
        assert.ok(isPng, `File ${screen}-${theme}.png is not a valid PNG`);

        // Check PNG dimensions from IHDR chunk (starts at offset 16: width at 16, height at 20)
        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        assert.ok(
          width >= 800,
          `Expected width >= 800, got ${width} for ${screen}-${theme}.png`,
        );
        assert.ok(
          height >= 600,
          `Expected height >= 600, got ${height} for ${screen}-${theme}.png`,
        );
      });
    }
  }
});
