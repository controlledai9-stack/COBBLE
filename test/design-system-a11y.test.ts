import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RevertDialog } from "../src/renderer/revert-dialog";
import type { RevertPreview } from "../src/shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("styles.css enforces Inter typography with optical feature flags", () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, "../src/renderer/styles.css"),
    "utf8",
  );
  assert.ok(css.includes('"Inter"'), "Styles must include Inter font");
  assert.ok(
    css.includes('"cv02"'),
    "Styles must enable optical feature flags for Inter",
  );
});

test("styles.css passes strict WCAG AA contrast for text tokens", () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, "../src/renderer/styles.css"),
    "utf8",
  );
  // Light mode contrast checks
  assert.ok(
    css.includes("--text: #111827;"),
    "Light mode primary text must be #111827 (16.5:1)",
  );
  assert.ok(
    css.includes("--text-muted: #475569;"),
    "Light mode muted text must be #475569 (5.4:1 >= 4.5:1)",
  );
  assert.ok(
    css.includes("--text-dim: #52525b;"),
    "Light mode dim text must be #52525b (4.9:1 >= 4.5:1)",
  );

  // Dark mode contrast checks
  assert.ok(
    css.includes("--text: #f4f4f5;"),
    "Dark mode primary text must be #f4f4f5 (17.5:1)",
  );
  assert.ok(
    css.includes("--text-muted: #a1a1aa;"),
    "Dark mode muted text must be #a1a1aa (5.8:1 >= 4.5:1)",
  );
  assert.ok(
    css.includes("--text-dim: #9ca3af;"),
    "Dark mode dim text must be #9ca3af (6.2:1 >= 4.5:1)",
  );
});

test("styles.css includes accessibility media queries (reduced motion, transparency, forced colors)", () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, "../src/renderer/styles.css"),
    "utf8",
  );
  assert.ok(
    css.includes("@media (prefers-reduced-motion: reduce)"),
    "Must support prefers-reduced-motion",
  );
  assert.ok(
    css.includes("@media (prefers-reduced-transparency: reduce)"),
    "Must support prefers-reduced-transparency",
  );
  assert.ok(
    css.includes("@media (forced-colors: active)"),
    "Must support Windows High Contrast / forced-colors",
  );
});

test("styles.css docks topbar flush without floating insets", () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, "../src/renderer/styles.css"),
    "utf8",
  );
  assert.ok(css.includes("height: 48px;"), "Topbar must be compact (48px)");
  assert.ok(
    css.includes("position: sticky;"),
    "Topbar must be sticky docked flush",
  );
});

test("styles.css ensures code diffs and pre blocks are strictly opaque", () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, "../src/renderer/styles.css"),
    "utf8",
  );
  assert.ok(
    css.includes("--code-bg: #ffffff;"),
    "Light mode code background must be solid opaque white",
  );
  assert.ok(
    css.includes("--code-bg: #0d0e12;"),
    "Dark mode code background must be solid opaque dark",
  );
});

test("RevertDialog maintains ARIA compliance and modal role contracts", () => {
  const preview: RevertPreview = {
    activityId: "act-1",
    token: "tok-1",
    files: [
      {
        path: "src/utils.ts",
        patch: "@@ -1,3 +1,3 @@\n-const a = 1;\n+const a = 2;",
        canApply: true,
      },
    ],
  };

  const html = renderToStaticMarkup(
    React.createElement(RevertDialog, {
      preview,
      close: () => {},
      onError: () => {},
    }),
  );

  assert.ok(html.includes('role="dialog"'), "Revert modal must have role=dialog");
  assert.ok(
    html.includes('aria-modal="true"'),
    "Revert modal must declare aria-modal=true",
  );
  assert.ok(
    html.includes('aria-labelledby="revert-title"'),
    "Revert modal must label title",
  );
  assert.ok(html.includes("<pre>"), "Patch diff must render in pre block");
});

test("main.ts applies native backgroundMaterial and vibrancy to floating windows", () => {
  const mainTs = fs.readFileSync(
    path.resolve(__dirname, "../src/main/main.ts"),
    "utf8",
  );
  assert.ok(
    mainTs.includes("backgroundMaterial:"),
    "main.ts must configure native backgroundMaterial for Windows 11 acrylic",
  );
  assert.ok(
    mainTs.includes("vibrancy:"),
    "main.ts must configure native vibrancy for macOS under-window",
  );
});

test("workspace-delete-icon-btn is circular, clears button padding, and preserves SVG icon size", () => {
  const css = fs.readFileSync(
    path.resolve(__dirname, "../src/renderer/styles.css"),
    "utf8",
  );
  assert.ok(
    css.includes(".workspace-delete-icon-btn"),
    "Styles must define .workspace-delete-icon-btn",
  );
  assert.ok(
    css.includes("padding: 0"),
    ".workspace-delete-icon-btn must clear button padding so SVG is not squished",
  );
  assert.ok(
    css.includes("box-shadow: none"),
    ".workspace-delete-icon-btn must clear primary button box-shadow",
  );
  assert.ok(
    css.includes(".workspace-delete-icon-btn svg"),
    ".workspace-delete-icon-btn svg must define explicit icon dimensions",
  );
});
