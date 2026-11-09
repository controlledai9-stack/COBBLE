import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildReviewGuard } from "./build-review-guard.mjs";
await buildReviewGuard();
await build({
  entryPoints: ["src/core/review/worker.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/review-worker.cjs",
});
await writeFile(
  "dist/review-worker.cjs.manifest.json",
  JSON.stringify({
    protocolVersion: 1,
    mode: "preflight-only",
    sha256: createHash("sha256")
      .update(await readFile("dist/review-worker.cjs"))
      .digest("hex"),
  }),
);
await build({
  entryPoints: ["src/main/main.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist/main/main.cjs",
});
await build({
  entryPoints: ["src/main/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  outfile: "dist/main/preload.cjs",
});
await build({
  entryPoints: ["src/internet/entry.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/relay.cjs",
});
await copyFile("node_modules/ws/LICENSE", "dist/main/ws-LICENSE.txt");
await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/cli.cjs",
  banner: { js: "#!/usr/bin/env node" },
});
await viteBuild({
  root: "src/renderer",
  base: "./",
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
});
await build({
  entryPoints: ["extensions/vscode/src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  outfile: "extensions/vscode/dist/extension.cjs",
});
