import type { BrowserWindow } from "electron";
import { app } from "electron";
import type { CobbleService } from "../core/service";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
export async function runSmoke(
  main: BrowserWindow,
  companion: BrowserWindow,
  service: CobbleService,
) {
  const errors: string[] = [];
  main.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const wait = async (condition: string) => {
    const start = Date.now();
    while (!(await main.webContents.executeJavaScript(condition))) {
      if (Date.now() - start > 8000)
        throw new Error(`UI wait failed: ${condition}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  await wait('!!document.querySelector(".welcome-card")');
  assert.equal(
    await main.webContents.executeJavaScript(
      'document.querySelectorAll(".welcome-card input[required]").length',
    ),
    1,
  );
  await main.webContents.executeJavaScript(
    `window.cobble.action({type:'profile',name:'Aarya',email:''})`,
  );
  await wait('!!document.querySelector(".sidebar")');
  await wait('!!document.querySelector("textarea[required]")');
  await wait('document.body.innerText.includes("Detected apps")');
  assert.equal(
    await main.webContents.executeJavaScript(
      'Array.from(document.querySelectorAll("button")).some(b => b.innerText.includes("Choose project folder"))',
    ),
    true,
  );
  assert.equal(
    await main.webContents.executeJavaScript(
      'document.querySelector("textarea[required]").checkValidity()',
    ),
    false,
  );
  const root = join(process.cwd(), ".cobble");
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(join(tmpdir(), "cobble-desktop-smoke-"));
  const git = async (...args: string[]) =>
    (
      await promisify(execFile)(service.gitBinary, ["-C", workspace, ...args], {
        windowsHide: true,
      })
    ).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Cobble Smoke");
  await git("config", "user.email", "smoke@cobble.local");
  await git("config", "core.autocrlf", "false");
  await git("config", "core.hooksPath", join(workspace, ".git", "hooks"));
  await writeFile(
    join(workspace, "api.ts"),
    "export function getUsers(limit: number): string[] { return []; }\n",
  );
  await git("add", ".");
  await git("commit", "-m", "initial");
  await git("checkout", "-b", "feature/backend");
  await writeFile(
    join(workspace, "api.ts"),
    'export function getUsers(limit: number): string[] { return ["ready"]; }\n',
  );
  await git("commit", "-am", "backend ready");
  await git("checkout", "main");
  await service.action({
    type: "createTeam",
    name: "Weekend builders",
    plan: "# A calmer way to build\n- Build shared tasks and team chat\n- Keep everything local\n- Do not modify `legacy/`",
    workspace,
  });
  await main.webContents.executeJavaScript(
    `document.querySelectorAll('nav button')[2].click()`,
  );
  await wait('document.body.innerText.includes("The core plan")');
  assert.equal(
    await main.webContents.executeJavaScript(
      'document.querySelectorAll(".plan-items > div").length',
    ),
    4,
  );
  assert.equal(
    await main.webContents.executeJavaScript(
      'document.querySelectorAll("nav button").length',
    ),
    4,
  );
  const fill = async (selector: string, value: string) =>
    main.webContents.executeJavaScript(
      `(()=>{const element=document.querySelector(${JSON.stringify(selector)});const proto=element.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  await fill(
    'form[aria-label="Configure work area"] input[placeholder="Backend"]',
    "Backend",
  );
  await fill(
    'form[aria-label="Configure work area"] input[placeholder="src/backend/**"]',
    "**/*.ts",
  );
  await main.webContents.executeJavaScript(
    `document.querySelector('form[aria-label="Configure work area"] fieldset input').click()`,
  );
  await main.webContents.executeJavaScript(
    `document.querySelector('form[aria-label="Configure work area"]').requestSubmit()`,
  );
  await wait(
    "window.cobble.state().then(s=>s.teams[0].graph?.modules.length===1)",
  );
  await service.action({
    type: "captureContracts",
    moduleId: service.activeTeam()!.graph!.modules[0].id,
  });
  assert.equal(service.activeTeam()!.graph!.contracts.length, 1);
  await main.webContents.executeJavaScript(
    `document.querySelectorAll('nav button')[2].click()`,
  );
  await wait(
    "!!document.querySelector('form[aria-label=\"Mark completed work\"]')",
  );
  await fill(
    'form[aria-label="Mark completed work"] select',
    service.activeTeam()!.items[1].id,
  );
  await fill(
    'form[aria-label="Mark completed work"] input',
    "Task board is ready",
  );
  await main.webContents.executeJavaScript(
    `document.querySelector('form[aria-label="Mark completed work"]').requestSubmit()`,
  );
  await wait("window.cobble.state().then(s=>s.completions.length===1)");
  await fill(
    'form[aria-label="Propose main integration"] input[placeholder="Backend login endpoints"]',
    "Backend ready",
  );
  await fill(
    'form[aria-label="Propose main integration"] input[placeholder="feature/backend-login"]',
    "feature/backend",
  );
  await main.webContents.executeJavaScript(
    `document.querySelector('form[aria-label="Propose main integration"]').requestSubmit()`,
  );
  await wait("window.cobble.state().then(s=>s.proposals.length===1)");
  const proposal = service.state().proposals[0];
  assert.equal(proposal.votes.length, 0);
  await main.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Yes, approve this commit')).click()`,
  );
  await wait(
    'window.cobble.state().then(s=>s.proposals[0].status==="approved")',
  );
  await service.integrateMain(proposal.id);
  assert.equal(service.state().proposals[0].status, "integrated");
  assert.match(await readFile(join(workspace, "api.ts"), "utf8"), /ready/);
  await service.observe();
  await main.webContents.executeJavaScript(
    `window.cobble.action({type:'send',recipientId:null,content:'Starting with the shared task board.',sentVia:'text'})`,
  );
  await main.webContents.executeJavaScript(
    `document.querySelectorAll('nav button')[1].click()`,
  );
  await wait('!!document.querySelector(".bubble")');
  assert.equal(
    await main.webContents.executeJavaScript(
      'document.querySelector(".bubble p").innerText',
    ),
    "Starting with the shared task board.",
  );
  // Test an actual controlled React textarea and submit, rather than only IPC.
  await main.webContents.executeJavaScript(
    `(() => { const input=document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'The next step is ready.'); input.dispatchEvent(new Event('input',{bubbles:true})); })()`,
  );
  await wait('!document.querySelector(".composer button:last-child").disabled');
  await main.webContents.executeJavaScript(
    `document.querySelector('.composer').requestSubmit()`,
  );
  await wait('document.querySelectorAll(".bubble").length === 2');
  assert.equal(service.state().messages.length, 2);
  await mkdir(join(workspace, "legacy"));
  await writeFile(
    join(workspace, "legacy", "old.ts"),
    "export const changed = true;",
  );
  await service.observe();
  assert.equal(service.state().activities[0].alert, true);
  await main.webContents.executeJavaScript(
    `document.querySelectorAll('nav button')[0].click()`,
  );
  await wait('!!document.querySelector(".needs-review")');
  await main.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Review revert')).click()`,
  );
  await wait('!!document.querySelector(".review-dialog")');
  assert.match(
    await main.webContents.executeJavaScript(
      'document.querySelector(".review-dialog pre").innerText',
    ),
    /legacy\/old.ts/,
  );
  await main.webContents.executeJavaScript(
    `document.querySelector('.review-dialog .section-title button').click()`,
  );
  const bad = await fetch(`http://127.0.0.1:${service.bridge.port}/ide`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "heartbeat", workspace }),
  });
  assert.equal(bad.status, 401);
  const paired = await fetch(`http://127.0.0.1:${service.bridge.port}/ide`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.bridge.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "heartbeat",
      workspace,
      editor: "Smoke-test IDE",
      focused: true,
    }),
  });
  assert.equal(paired.status, 200);
  await wait("/IDE (linked|connected)/.test(document.body.innerText)");
  await main.webContents.executeJavaScript(
    `document.querySelectorAll('nav button')[2].click()`,
  );
  const second = await fetch(`http://127.0.0.1:${service.bridge.port}/ide`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${service.bridge.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      type: "heartbeat",
      workspace,
      editor: "Second IDE",
      sessionId: "second-smoke",
    }),
  });
  assert.equal(second.status, 200);
  await wait(
    'document.body.innerText.includes("Verified project connections:") && document.body.innerText.includes("Second IDE")',
  );
  assert.equal(service.bridge.current.connections?.length, 2);
  await writeFile(
    join(root, "smoke-ides.png"),
    (await main.webContents.capturePage()).toPNG(),
  );
  await main.webContents.executeJavaScript(
    `document.querySelectorAll('nav button')[0].click()`,
  );
  await companion.webContents.executeJavaScript(
    `window.cobble.companion('drag-start')`,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    await companion.webContents.executeJavaScript(
      '!!document.querySelector(".pose-dragging")',
    ),
    true,
  );
  await companion.webContents.executeJavaScript(
    `window.cobble.companion('drag-end')`,
  );
  assert.equal(
    await main.webContents.executeJavaScript(
      "document.documentElement.scrollWidth > innerWidth",
    ),
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await writeFile(
    join(root, "smoke-home.png"),
    (await main.webContents.capturePage()).toPNG(),
  );
  await main.webContents.executeJavaScript(
    `document.querySelectorAll('nav button')[2].click()`,
  );
  await wait('!!document.querySelector(".plan-items")');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await writeFile(
    join(root, "smoke-plan.png"),
    (await main.webContents.capturePage()).toPNG(),
  );
  const maintenance = await main.webContents.executeJavaScript(
    "window.cobble.maintenance()",
  );
  assert.ok(maintenance.databaseBytes > 0);
  assert.ok(maintenance.activities > 0);
  const archive = join(root, `desktop-backup-${process.pid}.cobblebackup`);
  const recovery = join(root, `desktop-recovered-${process.pid}.sqlite`);
  await service.createBackup(archive);
  await service.restoreBackupCopy(archive, recovery);
  const recovered = new DatabaseSync(recovery, { readOnly: true });
  try {
    assert.equal(
      recovered
        .prepare("SELECT value FROM settings WHERE key=?")
        .get(`restored-offline:${service.activeTeam()!.id}`)?.value,
      "true",
    );
  } finally {
    recovered.close();
  }
  if (errors.length) throw new Error(`Renderer errors: ${errors.join("; ")}`);
  if (app.isPackaged) {
    const runtime = JSON.parse(
      await readFile(
        join(process.resourcesPath, "voice", "runtime.json"),
        "utf8",
      ),
    );
    assert.equal(runtime.model.name, "Whisper tiny multilingual");
    const vsix = await readFile(
      join(process.resourcesPath, "integrations", "cobble-workspace.vsix"),
    );
    assert.ok(vsix.length > 1000);
    assert.match(await git("--version"), /git version/);
    assert.ok(
      (
        await readFile(
          join(process.resourcesPath, "integrations", "agent-relay.ps1"),
        )
      ).length > 1000,
    );
    await writeFile(
      join(root, "packaged-smoke.json"),
      JSON.stringify({ runId: process.env.COBBLE_SMOKE_ID, success: true }),
    );
  }
  console.log(
    "COBBLE_SMOKE_OK: profile, plan, work areas, completion, votes, actual Git merge, chat, saved diff, revert preview, IDE auth, companion poses, screenshots",
  );
}
