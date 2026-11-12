# Two-PC test: shared team room and lent agents

This test checks the multi-user Agent Team on two real computers:

1. Both people's Cobbles share their agents and runs (the **Team room**).
2. A teammate can write into your run, and your planner reacts.
3. Your planner gives a coding task to your teammate's **lent** agent. The work travels through a shared GitHub repo and comes back merged into your run.

It takes about 45 minutes. Each person uses their own agents and pays for their own use.

**Roles in this guide**

| | **PC A: you (owner)** | **PC B: teammate** |
|---|---|---|
| Cobble | Hosts the workspace and starts the run | Joins the workspace |
| Agents | Claude Code (planner) | Codex, or a free model in Ollama (the lent coder) |

---

## 1. Before you start (both PCs)

- [ ] Windows, **Node.js 24.13+** and **Git** are installed.
- [ ] Both PCs are on the **same Wi-Fi or LAN**. For different networks, use "Host online" instead; it is not covered here.
- [ ] **A test repository on GitHub** that both of you can push to:
  - PC A creates a new **private** repo, for example `cobble-two-pc-test`, with a small Node project.
    - A `package.json` containing `"scripts": { "test": "node --test" }`.
    - `src/index.js` and one test in `test/`.
  - PC A adds PC B's GitHub account under **Settings → Collaborators**. PC B accepts the invitation.
  - Both PCs clone the repo: `git clone https://github.com/<owner>/cobble-two-pc-test`
  - Both PCs check that pushing works **once in a terminal**, so Git has your sign-in. Cobble never asks for passwords. Inside the clone:
    ```bash
    git commit --allow-empty -m "push test" && git push
    ```
- [ ] **Agents**
  - PC A: Claude Code is installed and signed in. The `claude` command works in a terminal.
  - PC B, one of these:
    - **Codex** CLI installed and signed in (`codex` works).
    - **Free option:** Ollama running with a coding model (`ollama pull qwen3-coder`). Then in Cobble's terminal: `npm run cli -- --data <data folder>\cobble.sqlite team model free ollama qwen3-coder`.

## 2. Get the test build of Cobble (both PCs)

```bash
git clone https://github.com/controlledai9-stack/COBBLE
```
```bash
cd COBBLE
```
```bash
git checkout claude/agent-team
```
```bash
npm install
```
```bash
npm run prepare:runtime
```
```bash
npm run build
```

Start it with a **separate test data folder**, so your real Cobble data is not touched:

```bash
npm start -- --user-data-dir=C:\cobble-2pc
```

Windows Firewall may ask about Node/Electron on PC A. Allow it on **Private networks**.

## 3. Connect the two Cobbles

| Step | Who | What to do | Expected result |
|---|---|---|---|
| 3.1 | A | Create your profile. Then use **Create New / Join a Workspace → Create**: any name, a short plan (for example "Add slugify and truncate helpers with tests"), and **your clone** of the test repo as the project folder. | The app opens on **Agent Team**. |
| 3.2 | A | Open **Workspace & Plan → Workspace & Hosting → Host on LAN**. Copy the **address** and the **join code** and send them to B. | Hosting is on, and an address like `https://192.168.x.x:port/#…` is shown. |
| 3.3 | B | Create your profile. Then use **Create New / Join a Workspace → Join**, paste the address and code, and press **Request to join**. | The request is sent, and B waits for A's approval. |
| 3.4 | A | Open **Join Requests** and approve B. | B now sees the workspace and its plan. |
| 3.5 | B | Open **Workspace & Plan → Workspace & Hosting** and choose **your clone** of the test repo as your local project folder. | The project folder is set. |

## 4. Agents and the Team room

| Step | Who | What to do | Expected result |
|---|---|---|---|
| 4.1 | A | **Agent Team → Roles**: set Planner to **Claude**. Press **Detect again**. | Claude shows as Installed. |
| 4.2 | B | **Agent Team**: press **Detect again**. | Codex (or Free / local model) shows as Installed. |
| 4.3 | Both | Look at the **Team room** card under the Team Chat. | It says "Shared with your teammates" and lists both people with their ready agents. |
| 4.4 | B | Team room → **Lend my agents to teammates** → tick **Codex** (or Free model). | — |
| 4.5 | A | Team room → **Use a teammate's agent** → **coder** → choose "B's Codex". Then press **Detect again**. | In the Roles table, coder shows **Teammate**, and "Teammate" shows as Installed under Agent availability. |

✅ **Check 1, shared roster:** both Team rooms list both members, and A can pick B's lent agent.

## 5. Run a goal across both PCs

| Step | Who | What to do | Expected result |
|---|---|---|---|
| 5.1 | A | Scroll to **Start a run → Advanced** and set the test command to `npm test`. | — |
| 5.2 | A | In the **Team Chat**, type: *"Add a slugify function to src/index.js with tests in test/. No dependencies."* and press **Start**. | Your message appears. Within about a minute the planner replies and posts a hand-off like **"@teammate T1 (coder): …"**. |
| 5.3 | A | Open the repo on GitHub → **Branches**. | A new branch **`cobble/<run>/T1`** appears: the task's starting point. |
| 5.4 | B | Team room → **Teammates' runs**: select A's run. | A's goal, the planner's reply and the hand-off are visible. |
| 5.5 | B | Watch the run. Nothing to press. | B's Codex works on the task on PC B. Then the GitHub branch gets a commit **"T1: work by a lent codex"**. |
| 5.6 | A | Watch the Team Chat. | **"T1: `npm test` passed"** (from Cobble), **"Done with T1: …"**, then the planner's summary. The run ends as **Done**. |

✅ **Check 2, lent task:** the commit is on `cobble/<run>/T1`. A's run branch (`team/<run>` on PC A) contains the new code, and `main` on GitHub is unchanged.

## 6. Teammate message (during a run)

Start a second short run on A, for example *"Add a truncate function with tests"*. While it is running:

| Step | Who | What to do | Expected result |
|---|---|---|---|
| 6.1 | B | Team room → select the run → type *"Please make truncate cut at a word boundary"* → **Send**. | — |
| 6.2 | A | Watch the Team Chat. | B's message appears with **B's name**. Shortly after, the planner replies and takes it into account. |

✅ **Check 3, teammate message:** the planner reacted to B's message.

## 7. Safety checks (quick)

- [ ] On B, there is **no Approve button** for A's run. Only A gets approval and sign-in cards.
- [ ] B's Codex ran **sandboxed**. On PC B, Codex had no full access, even if B gave their own coder role full access.
- [ ] Nothing was pushed to `main`. Only `cobble/…` branches were created.
- [ ] If B creates a `.env` file in their clone, it never appears on GitHub (optional test).

## 8. What to send back

Fill this in and share screenshots of A's Team Chat and B's Team room:

| Check | Pass / Fail | Notes (time taken, errors) |
|---|---|---|
| 1. Shared roster | | |
| 2. Lent task merged | | |
| 3. Teammate message | | |
| 4. Safety checks | | |

If something fails, also note:
- the error text shown in the app;
- on PC A, the output of `npm run cli -- --data C:\cobble-2pc\cobble.sqlite team status`;
- on PC A, the output of `npm run cli -- --data C:\cobble-2pc\cobble.sqlite team chat`.

Run these CLI commands only after closing Cobble on that PC.

## Troubleshooting

| Problem | Fix |
|---|---|
| B can't join ("could not connect") | Same Wi-Fi? Allow Cobble/Electron through Windows Firewall on PC A (Private network). Try the address exactly as copied, including the `#…` part. |
| Team room says "Only on this computer" | Hosting was stopped, or B isn't connected yet. Re-open Workspace & Hosting on A. |
| A can't choose B's agent | B must tick it under **Lend my agents** while connected. Then A presses **Detect again**. |
| Task pauses with a **sign in** card about Git | Push from that PC once in a terminal (step 1), then press **Done** on the card. |
| "The workspace needs a shared Git remote named origin" | The project folder must be the clone of the GitHub repo (`git remote -v` shows `origin`). |
| B's Codex reports a failure but the check passed | Expected sometimes: the planner can accept work when Cobble's own check passed. |
| Nothing happens on B | B's Cobble must stay open and connected. Lent tasks run only while it is running. |

## Clean up

- Delete the `cobble/*` branches on GitHub (Branches page).
- Stop hosting on A, and close both apps.
- Delete the `C:\cobble-2pc` folders if you don't need them.
