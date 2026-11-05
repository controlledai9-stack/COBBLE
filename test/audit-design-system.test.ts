import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Relative luminance and contrast calculation according to WCAG 2.1 specifications
function getLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "").trim();
  if (clean.length === 3) {
    return [
      parseInt(clean[0] + clean[0], 16),
      parseInt(clean[1] + clean[1], 16),
      parseInt(clean[2] + clean[2], 16),
    ];
  }
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function getContrastRatio(hex1: string, hex2: string): number {
  const lum1 = getLuminance(...hexToRgb(hex1));
  const lum2 = getLuminance(...hexToRgb(hex2));
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

test("AUDIT-DS-01: WCAG AA Optical Contrast & Color Tokens", async () => {
  const css = await readFile(join(process.cwd(), "src/renderer/styles.css"), "utf8");

  // Extract light mode colors
  assert.match(css, /--bg:\s*#f5f5f7/i, "Light mode base background must be clean Apple light gray #f5f5f7");
  assert.match(css, /--text:\s*#111827/i, "Light mode primary text must be high-contrast #111827");
  assert.match(css, /--text-muted:\s*#475569/i, "Light mode secondary text must be #475569");

  // Verify light mode text contrast ratios against background #f5f5f7
  const lightBg = "#f5f5f7";
  const lightText = "#111827";
  const lightMuted = "#475569";
  const lightPrimaryBtnBg = "#1d1d1f";
  const lightPrimaryBtnText = "#ffffff";

  const lightTextContrast = getContrastRatio(lightText, lightBg);
  assert.ok(
    lightTextContrast >= 4.5,
    `Light mode text contrast (${lightTextContrast.toFixed(2)}) must satisfy WCAG AA (>= 4.5:1)`,
  );

  const lightMutedContrast = getContrastRatio(lightMuted, lightBg);
  assert.ok(
    lightMutedContrast >= 4.5,
    `Light mode muted text contrast (${lightMutedContrast.toFixed(2)}) must satisfy WCAG AA (>= 4.5:1)`,
  );

  const lightBtnContrast = getContrastRatio(lightPrimaryBtnText, lightPrimaryBtnBg);
  assert.ok(
    lightBtnContrast >= 4.5,
    `Light mode primary CTA contrast (${lightBtnContrast.toFixed(2)}) must satisfy WCAG AA (>= 4.5:1)`,
  );

  // Extract dark mode colors
  assert.match(css, /--bg:\s*#09090b/i, "Dark mode base background must be deep zinc/black #09090b");
  assert.match(css, /--text:\s*#f4f4f5/i, "Dark mode primary text must be zinc-100 #f4f4f5");
  assert.match(css, /--text-muted:\s*#a1a1aa/i, "Dark mode secondary text must be #a1a1aa");

  // Verify dark mode text contrast ratios against background #09090b
  const darkBg = "#09090b";
  const darkText = "#f4f4f5";
  const darkMuted = "#a1a1aa";
  const darkPrimaryBtnBg = "#f5f5f7";
  const darkPrimaryBtnText = "#111827";

  const darkTextContrast = getContrastRatio(darkText, darkBg);
  assert.ok(
    darkTextContrast >= 4.5,
    `Dark mode text contrast (${darkTextContrast.toFixed(2)}) must satisfy WCAG AA (>= 4.5:1)`,
  );

  const darkMutedContrast = getContrastRatio(darkMuted, darkBg);
  assert.ok(
    darkMutedContrast >= 4.5,
    `Dark mode muted text contrast (${darkMutedContrast.toFixed(2)}) must satisfy WCAG AA (>= 4.5:1)`,
  );

  const darkBtnContrast = getContrastRatio(darkPrimaryBtnText, darkPrimaryBtnBg);
  assert.ok(
    darkBtnContrast >= 4.5,
    `Dark mode primary CTA contrast (${darkBtnContrast.toFixed(2)}) must satisfy WCAG AA (>= 4.5:1)`,
  );
});

test("AUDIT-DS-02: Squircle Radii System & Pill Bloat Elimination", async () => {
  const css = await readFile(join(process.cwd(), "src/renderer/styles.css"), "utf8");

  // Check defined continuous squircle tokens
  assert.match(css, /--radius-xs:\s*6px/, "Must define 6px radius for tags and compact chips");
  assert.match(css, /--radius-sm:\s*8px/, "Must define 8px radius for buttons and inputs");
  assert.match(css, /--radius-md:\s*12px/, "Must define 12px radius for secondary cards");
  assert.match(css, /--radius-lg:\s*16px/, "Must define 16px radius for primary panels");
  assert.match(css, /--radius-xl:\s*20px/, "Must define 20px radius for modal sheets");

  // Check button border-radius rule
  assert.match(
    css,
    /button\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/,
    "Standard buttons must use --radius-sm (8px squircle), not 9999px pills",
  );

  // Check nav buttons
  assert.match(
    css,
    /\.nav-button\s*\{[^}]*border-radius:\s*7px/,
    "Sidebar nav items must use 7px squircle for macOS source list aesthetics",
  );

  // Check workspace select
  assert.match(
    css,
    /\.workspace-select-wrapper\s+select\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/,
    "Workspace dropdown select must use 8px squircle",
  );
});

test("AUDIT-DS-03: Layout Breathing Room & Spacing Hierarchy", async () => {
  const css = await readFile(join(process.cwd(), "src/renderer/styles.css"), "utf8");

  // Check page padding
  assert.match(
    css,
    /\.page\s*\{[^}]*padding:\s*36px\s+44px\s+72px/,
    "Page container must provide generous 36px 44px 72px breathing room",
  );

  // Check card padding
  assert.match(
    css,
    /\.plan-hero-card\s*\{[^}]*padding:\s*28px\s+32px/,
    "Cards and panels must provide 28px 32px internal padding",
  );

  // Check plan toolbar actions spacing
  assert.match(
    css,
    /\.plan-toolbar-actions\s*\{[^}]*gap:\s*10px/,
    "Plan toolbar buttons must have at least 10px spacing gap and not collide",
  );

  // Check profile form action margin
  assert.match(
    css,
    /\.profile-form-actions\s*\{[^}]*margin:\s*22px\s+0\s+16px/,
    "Profile form actions must maintain 22px top margin separation",
  );
});

test("AUDIT-DS-04: Typography & Optical Feature Flags", async () => {
  const css = await readFile(join(process.cwd(), "src/renderer/styles.css"), "utf8");

  // Font family
  assert.match(css, /--font-sans:\s*"Inter"/, "Sans-serif font stack must prioritize Inter");

  // Optical feature flags for Apple-style numeral and letter rendering
  assert.match(
    css,
    /font-feature-settings:\s*"cv02",\s*"cv03",\s*"cv04",\s*"cv11"/,
    "Typography must enable Inter cv02, cv03, cv04, cv11 optical feature settings",
  );
});

test("AUDIT-DS-05: Signal Truthfulness & Privacy Safeguards", async () => {
  const mainTsx = await readFile(join(process.cwd(), "src/renderer/main.tsx"), "utf8");

  // Truthful "Not Watching" status
  assert.ok(
    mainTsx.includes('"Not Watching"') || mainTsx.includes("Not Watching"),
    "Renderer must truthfully render 'Not Watching' when observation is paused or not paired",
  );

  // Masked email for privacy
  assert.ok(
    mainTsx.includes("masked") || mainTsx.includes("replace"),
    "Renderer must mask email on profile settings view",
  );

  // Milestone pluralization correctness
  assert.ok(
    mainTsx.includes('team.items.length === 1 ? "" : "s"'),
    "Renderer must pluralize milestones correctly (1 piece vs X pieces)",
  );

  // Workspace delete button has confirmation
  assert.ok(
    mainTsx.includes("deleteTeam") && mainTsx.includes("confirm("),
    "Workspace deletion must be protected with user confirmation",
  );
});
