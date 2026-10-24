# Verify the current Pebble drag fix

The corrected development build is **0.2.1**. The earlier fixes were pushed to `codex/fix-companion-movement` in PR #2, while `main` and `codex/window-anchor` initially still had older code. The 0.2.0 installer also predates these fixes.

Do not infer the running executable's code version from the fact that Git was pulled. Source must be rebuilt and the old app must be closed first. The app window title and Profile settings now display the actual package version.

## Update the source

After PR #2 is merged into `codex/window-anchor`, run from a clean or safely saved checkout:

```powershell
git fetch origin
git switch codex/window-anchor
git pull --ff-only
git log -1 --oneline
node -p "require('./package.json').version"
npm ci
npm run build
npm start
```

The version command and the running app must show **0.2.1**. Do not launch an old installer, a different checkout's `dist` directory, or an old `release/win-unpacked/Cobble.exe`. A fresh checkout also needs `npm run prepare:runtime` for offline voice/Git resources before using those features or building a self-contained package.

## Sandbox versus the real desktop

"Claude sandbox" is not a precise runtime description. Claude Code can launch a real Windows Electron app, while a browser preview, a Linux/headless session, an injected-input tool, or an isolated desktop can expose different cursor/display behavior. Record the actual OS, visible app type, Git commit, and app version. Do not claim a browser preview is equivalent to native Windows dragging.

For a real drag check, open the Electron desktop app on the same interactive Windows desktop as the mouse. Check:

- Grab the face and drag straight up/down; there should be no accumulating sideways shift.
- Drag left/right, release, then move the mouse without holding the button. Pebble must stay put.
- Open/close the menu repeatedly; the collapsed robot must return to the same anchor.
- Try the actual Windows display scaling and each monitor used by the teammate.
- Close the main app with X. Both the app and Pebble must exit.

The fix locks the original complete window rectangle, uses the native cursor with the actual grabbed artwork point, preserves the teammate's menu anchor, and ends the drag on release/cancel/focus loss. The latest artwork and animation files are retained unchanged from `codex/window-anchor`.

## Diagnostic checks

```powershell
npm run typecheck
npm test
npm run test:companion
npm run test:shutdown
```

The companion check uses real Electron window geometry with simulated cursor/capture. It verifies stationary-cursor safety, fixed window dimensions, face alignment at several page zoom levels, menu-anchor stability and release handling. It does not substitute for the physical mouse/display check above. If a sandbox still fails, send the commit, app version, OS, display scale and whether input is a physical mouse or injected preview input.
