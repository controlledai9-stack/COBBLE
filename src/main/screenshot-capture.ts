import type { BrowserWindow } from "electron";
import type { CobbleService } from "../core/service";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export async function runScreenshotCapture(
  main: BrowserWindow,
  service: CobbleService,
) {
  const outputDir = join(process.cwd(), "test", "screenshots");
  await mkdir(outputDir, { recursive: true });

  const wait = async (condition: string, timeoutMs = 15000) => {
    const start = Date.now();
    while (true) {
      try {
        const res = await main.webContents.executeJavaScript(condition);
        if (res) return;
      } catch (err) {
        console.error(`[wait error on ${condition}]:`, err);
      }
      if (Date.now() - start > timeoutMs)
        throw new Error(`Wait timed out: ${condition}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  // Wait for initial load
  await wait('!!document.querySelector(".welcome-card, .sidebar")');

  // If welcome card is visible, complete profile setup through renderer action
  const hasWelcome = await main.webContents.executeJavaScript(
    '!!document.querySelector(".welcome-card")',
  );
  if (hasWelcome) {
    await main.webContents.executeJavaScript(`
      window.cobble.action({
        type: "profile",
        name: "Demo User",
        email: "demo@example.com",
        speak: false
      })
    `);
  }

  await wait('!!document.querySelector(".sidebar")');

  // Ensure demo team exists and is active
  const teamCount = await main.webContents.executeJavaScript(
    'document.querySelectorAll(".workspace-select-wrapper option:not([disabled])").length',
  );
  if (teamCount === 0) {
    const plan = `# Demo Collaboration Hub\\n- Real-time plan synchronization and drift detection\\n- Local-first conflict observation across editor workspaces\\n- Calmer peer review with multi-agent assistance`;
    await main.webContents.executeJavaScript(`
      (async () => {
        await window.cobble.action({
          type: "createTeam",
          name: "Demo Workspace",
          plan: "${plan}",
          workspace: ""
        });
        const st = await window.cobble.state();
        if (st.teams.length > 0) {
          await window.cobble.action({ type: "selectTeam", teamId: st.teams[0].id });
        }
      })()
    `);
    await wait('document.querySelectorAll(".workspace-select-wrapper option:not([disabled])").length > 0');
    await wait('document.querySelector(".topbar span")?.textContent === "Demo Workspace"');
    await new Promise((r) => setTimeout(r, 600));
  } else {
    await main.webContents.executeJavaScript(`
      (async () => {
        const st = await window.cobble.state();
        if (st.teams.length > 0 && (!st.activeTeamId || st.activeTeamId !== st.teams[0].id)) {
          await window.cobble.action({ type: "selectTeam", teamId: st.teams[0].id });
        }
      })()
    `);
    await wait('document.querySelector(".topbar span")?.textContent === "Demo Workspace"');
  }

  const tabs = [
    { name: "overview", readyCheck: '!!document.querySelector(".status-grid")' },
    { name: "discussions", readyCheck: '!!document.querySelector(".main-full-chat")' },
    { name: "workspace-plan", readyCheck: '!!document.querySelector(".plan-toolbar")' },
    { name: "join-requests", readyCheck: '!!document.querySelector(".panel h2")' },
    { name: "profile-settings", readyCheck: '!!document.querySelector(".profile-form-actions")' },
  ];

  const themes = ["dark", "light"] as const;

  for (const theme of themes) {
    // Set theme directly through React hook
    await wait('typeof window.__setCobbleTheme === "function"');
    await main.webContents.executeJavaScript(`
      window.__setCobbleTheme("${theme}");
    `);
    await wait(`document.documentElement.getAttribute("data-theme") === "${theme}"`);
    await new Promise((r) => setTimeout(r, 450));

    // Capture each tab
    const tabIndices = [0, 1, 2, 3, 4];
    for (const idx of tabIndices) {
      const tabMeta = tabs[idx];
      if (idx === 4) {
        // Profile mini button
        await main.webContents.executeJavaScript(`
          document.querySelector("button.profile-mini")?.click();
        `);
        await wait('document.querySelector("button.profile-mini")?.classList.contains("selected")');
      } else {
        await main.webContents.executeJavaScript(`
          document.querySelectorAll("nav button.nav-button")[${idx}]?.click();
        `);
        await wait(`document.querySelectorAll("nav button.nav-button")[${idx}]?.classList.contains("selected")`);
      }

      await wait(tabMeta.readyCheck);
      await new Promise((r) => setTimeout(r, 350));
      const image = await main.webContents.capturePage();
      const filename = `${tabMeta.name}-${theme}.png`;
      const filePath = join(outputDir, filename);
      await writeFile(filePath, image.toPNG());
      console.log(`[Screenshots] Captured ${filename} (${image.getSize().width}x${image.getSize().height})`);

      // If workspace-plan, capture the subtabs
      if (idx === 2) {
        const subtabs = [
          { name: "workspace-plan-ownership", btnIndex: 1, check: '!!document.querySelector(".ownership-map-view")' },
          { name: "workspace-plan-proposals", btnIndex: 2, check: '!!document.querySelector(".proposal-vote-view")' },
          { name: "workspace-plan-alerts", btnIndex: 3, check: '!!document.querySelector(".alert-triage-panel")' },
        ];
        for (const sub of subtabs) {
          await main.webContents.executeJavaScript(`
            document.querySelectorAll(".teams-segmented-control button.segmented-btn")[${sub.btnIndex}]?.click();
          `);
          await wait(sub.check);
          await new Promise((r) => setTimeout(r, 300));
          const subImg = await main.webContents.capturePage();
          const subFile = `${sub.name}-${theme}.png`;
          await writeFile(join(outputDir, subFile), subImg.toPNG());
          console.log(`[Screenshots] Captured subtab ${subFile} (${subImg.getSize().width}x${subImg.getSize().height})`);
        }
        // Restore to first subtab
        await main.webContents.executeJavaScript(`
          document.querySelectorAll(".teams-segmented-control button.segmented-btn")[0]?.click();
        `);
        await wait('!!document.querySelector(".plan-toolbar")');
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  console.log(`[Screenshots] All 10 baseline screenshots saved to ${outputDir}`);
}
