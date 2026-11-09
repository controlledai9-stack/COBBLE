# Editor detection and project connections

The team setup separates **Project folder** (your source code directory) from
**Detected apps** (editor/application discovery). Choosing a folder never claims
that an IDE is connected.

On Windows, Cobble scans known installation locations, PATH, and running process
executable paths every 15 seconds. Refresh apps runs the same scan immediately.
Running editors in custom/portable locations can be discovered too. It does not
read window titles, documents, prompts, or process command lines. Discovery uses
Windows' included PowerShell; no extra end-user package is required.

With a team project selected, running compatible editors receive the bundled
Cobble VSIX automatically, once per installation per Cobble run. Editors that
are merely installed are not launched. **Open project / connect** explicitly
opens the selected project in that editor and retries failed setup. A failed
setup stays visible and is not retried every 15 seconds. A newly opened editor
is discovered and prepared without replacing existing editor connections.

VS Code, VS Code Insiders, Cursor, Windsurf, VSCodium and compatible Antigravity
installations are candidates for the VS Code extension bridge. Compatibility is
checked against the actual installation's CLI layout; vendor builds may reject
the VSIX, in which case the error is displayed. Versioned VS Code resource
directories use the current bin launcher. An editor may require a window reload
to activate a newly installed/updated extension.

Running ChatGPT, Claude, Codex, IntelliJ IDEA, WebStorm, PyCharm, Android Studio,
Visual Studio and Zed are recognized as apps without a direct integration here.
Their project files can still be monitored after saving. Detection does not
mean Cobble can read those apps' conversations or unsaved buffers. Unknown
editors also work through the selected project folder's saved-file watcher.

**Verified project connections** come only from authenticated bridge heartbeats
for the selected team's actual project directory. Each extension window has a
unique session ID, including two windows of the same editor. Closing a window,
changing its workspace, disconnecting it, or missing heartbeats removes only
that session; another live session keeps the aggregate connection active.
Connections expire after 15 seconds without a heartbeat (checked every 3 seconds).
Changing teams resets sessions and rotates the local pairing token.

Automatic detection and installation do not move the mascot or change artwork.
Discovery timers stop and in-flight discovery/install subprocesses are aborted
when Cobble quits.

Validation: `npm run check`, `npm run test:desktop`,
`npm run test:shutdown`. Discovery and session regression tests are in
`test/ide-discovery.test.ts` and `test/ide-connections.test.ts`.
