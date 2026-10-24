import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  CandidateWindow,
  EditorKind,
  NativeProbe,
  TrackerOptions,
  TrackerState,
  WindowBinding,
  WindowSnapshot,
  WindowTracker,
} from './contracts.js';

export class DefaultWindowsProbe implements NativeProbe {
  private helperPath: string;
  private child: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private pendingResolvers: Array<{
    resolve: (data: any) => void;
    reject: (err: Error) => void;
    timeoutId: NodeJS.Timeout;
  }> = [];
  private isReady = false;
  private readyPromise: Promise<void> | null = null;
  private isDisposed = false;

  constructor(helperPath?: string) {
    if (helperPath) {
      this.helperPath = helperPath;
    } else {
      // Default to windows-helper.ps1 in the same directory
      try {
        const currentDir = path.dirname(fileURLToPath(import.meta.url));
        this.helperPath = path.join(currentDir, 'windows-helper.ps1');
      } catch {
        this.helperPath = path.join(process.cwd(), 'src', 'integrations', 'window-anchor', 'windows-helper.ps1');
      }
    }
  }

  public isSupportedPlatform(): boolean {
    return process.platform === 'win32';
  }

  private async ensureProcess(): Promise<void> {
    if (this.isDisposed) {
      throw new Error('Native probe is disposed');
    }
    if (!this.isSupportedPlatform()) {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
    if (!fs.existsSync(this.helperPath)) {
      throw new Error(`Native helper script not found at ${this.helperPath}`);
    }
    if (this.child && !this.child.killed && this.isReady) {
      return;
    }
    if (this.readyPromise) {
      return this.readyPromise;
    }

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const initTimeout = setTimeout(() => {
        reject(new Error('Timeout waiting for native helper to start'));
      }, 5000);

      try {
        // Spawn hidden, long-lived powershell process without creating a console window
        this.child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.helperPath],
          {
            windowsHide: true,
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );

        this.child.on('error', (err) => {
          clearTimeout(initTimeout);
          this.cleanupProcess();
          reject(err);
        });

        this.child.on('exit', (code) => {
          clearTimeout(initTimeout);
          this.cleanupProcess();
          // Flush pending requests with error
          const pending = this.pendingResolvers.splice(0);
          for (const p of pending) {
            clearTimeout(p.timeoutId);
            p.reject(new Error(`Helper process exited with code ${code}`));
          }
        });

        if (this.child.stdout) {
          this.rl = readline.createInterface({
            input: this.child.stdout,
            crlfDelay: Infinity,
          });

          this.rl.on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
              const msg = JSON.parse(trimmed);
              if (msg.type === 'ready' && !this.isReady) {
                this.isReady = true;
                clearTimeout(initTimeout);
                resolve();
                return;
              }

              const next = this.pendingResolvers.shift();
              if (next) {
                clearTimeout(next.timeoutId);
                next.resolve(msg);
              }
            } catch (err) {
              // Ignore non-JSON output (e.g. debug banners)
            }
          });
        }
      } catch (err) {
        clearTimeout(initTimeout);
        reject(err);
      }
    });

    return this.readyPromise;
  }

  private async sendCommand(cmd: Record<string, unknown>, timeoutMs = 2500): Promise<any> {
    await this.ensureProcess();
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error('Helper stdin is unavailable');
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const idx = this.pendingResolvers.findIndex((p) => p.timeoutId === timeoutId);
        if (idx !== -1) {
          this.pendingResolvers.splice(idx, 1);
        }
        reject(new Error('Helper command timed out'));
      }, timeoutMs);

      this.pendingResolvers.push({ resolve, reject, timeoutId });
      const payload = JSON.stringify(cmd) + '\n';
      this.child!.stdin!.write(payload, 'utf8');
    });
  }

  public async listCandidates(editor: EditorKind): Promise<CandidateWindow[]> {
    const res = await this.sendCommand({ cmd: 'list', editor });
    if (res && res.type === 'candidates' && Array.isArray(res.candidates)) {
      return res.candidates.map((c: any) => ({
        windowId: String(c.windowId),
        processId: Number(c.processId),
        editor,
        title: String(c.title || ''),
      }));
    }
    return [];
  }

  public async getSnapshot(
    windowId: string,
    processId?: number,
    editor: EditorKind = 'antigravity'
  ): Promise<WindowSnapshot | null> {
    const res = await this.sendCommand({
      cmd: 'inspect',
      windowId,
      expectedPid: processId || 0,
      editor,
    });

    if (!res || res.type !== 'snapshot' || !res.found) {
      return null;
    }

    const raw = res;
    return {
      windowId: String(raw.windowId),
      processId: Number(raw.processId),
      editor: (raw.editor as EditorKind) || editor,
      title: String(raw.title || ''),
      boundsPhysical: {
        x: Number(raw.boundsPhysical.x),
        y: Number(raw.boundsPhysical.y),
        width: Number(raw.boundsPhysical.width),
        height: Number(raw.boundsPhysical.height),
      },
      coordinateSpace: 'physical-pixels',
      focused: Boolean(raw.focused),
      minimized: Boolean(raw.minimized),
      visible: Boolean(raw.visible),
      observedAt: Date.now(),
    };
  }

  private cleanupProcess(): void {
    this.isReady = false;
    this.readyPromise = null;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.child) {
      try {
        if (!this.child.killed) {
          this.child.kill();
        }
      } catch {}
      this.child = null;
    }
  }

  public async dispose(): Promise<void> {
    this.isDisposed = true;
    if (this.child && !this.child.killed && this.child.stdin && !this.child.stdin.destroyed) {
      try {
        this.child.stdin.write('{"cmd":"exit"}\n', 'utf8');
      } catch {}
    }
    this.cleanupProcess();
  }
}

export class WindowTrackerImpl implements WindowTracker {
  private probe: NativeProbe;
  private currentBinding: WindowBinding | null = null;
  private pollIntervalMs: number;
  private pollTimer: NodeJS.Timeout | null = null;
  private onChangeCallback: ((state: TrackerState) => void) | null = null;
  private isRunning = false;
  private isPolling = false;
  private needsRepoll = false;

  constructor(options: TrackerOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.probe = options.probe ?? new DefaultWindowsProbe(options.helperPath);
  }

  public async listCandidates(editor: EditorKind): Promise<CandidateWindow[]> {
    if (!this.probe.isSupportedPlatform()) {
      return [];
    }
    return this.probe.listCandidates(editor);
  }

  public bind(binding: WindowBinding | null): void {
    this.currentBinding = binding ? { ...binding } : null;
    if (this.isRunning) {
      if (this.isPolling) {
        this.needsRepoll = true;
      } else {
        void this.pollOnce();
      }
    }
  }

  public async start(onChange: (state: TrackerState) => void): Promise<void> {
    if (this.isRunning) {
      this.onChangeCallback = onChange;
      return;
    }

    this.isRunning = true;
    this.onChangeCallback = onChange;

    if (!this.probe.isSupportedPlatform()) {
      this.emitState({
        status: 'unavailable',
        snapshot: null,
        reason: `Unsupported platform: ${process.platform}`,
      });
      return;
    }

    // Run initial observation immediately
    await this.pollOnce();

    // Schedule regular polling
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);
  }

  public async stop(): Promise<void> {
    this.isRunning = false;
    this.needsRepoll = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.onChangeCallback = null;
    await this.probe.dispose();
  }

  private emitState(state: TrackerState): void {
    if (this.isRunning && this.onChangeCallback) {
      this.onChangeCallback(state);
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.isRunning || this.isPolling) {
      if (this.isPolling) this.needsRepoll = true;
      return;
    }
    this.isPolling = true;

    try {
      if (!this.probe.isSupportedPlatform()) {
        this.emitState({
          status: 'unavailable',
          snapshot: null,
          reason: `Unsupported platform: ${process.platform}`,
        });
        return;
      }

      if (!this.currentBinding) {
        this.emitState({
          status: 'unbound',
          snapshot: null,
          reason: 'No window binding configured',
        });
        return;
      }

      const { editor, windowId, processId } = this.currentBinding;

      // Case A: No explicit windowId provided
      if (!windowId) {
        let candidates: CandidateWindow[] = [];
        try {
          candidates = await this.probe.listCandidates(editor);
        } catch (err: any) {
          this.emitState({
            status: 'unavailable',
            snapshot: null,
            reason: err?.message || 'Failed to enumerate candidate windows',
          });
          return;
        }

        if (candidates.length === 0) {
          this.emitState({
            status: 'unbound',
            snapshot: null,
            reason: `No candidate windows found for editor '${editor}'`,
          });
          return;
        }

        // Without an explicit selection, 1 or more candidates are ambiguous
        this.emitState({
          status: 'ambiguous',
          snapshot: null,
          candidates,
          reason: `Found ${candidates.length} candidate window(s); explicit user confirmation required`,
        });
        return;
      }

      // Case B: Explicit windowId provided -> query and re-validate
      let snapshot: WindowSnapshot | null = null;
      try {
        snapshot = await this.probe.getSnapshot(windowId, processId, editor);
      } catch (err: any) {
        this.emitState({
          status: 'unavailable',
          snapshot: null,
          reason: err?.message || 'Error querying native window snapshot',
        });
        return;
      }

      if (!snapshot) {
        this.emitState({
          status: 'closed',
          snapshot: null,
          reason: 'Bound native window is closed or handle has been invalidated',
        });
        return;
      }

      // Strict validation: verify editor matches
      if (snapshot.editor !== editor) {
        this.emitState({
          status: 'unavailable',
          snapshot: null,
          reason: `Window handle recycled; editor changed from ${editor} to ${snapshot.editor}`,
        });
        return;
      }

      // If a process ID hint was specified and the snapshot has a different processId, handle was recycled
      if (processId && snapshot.processId !== processId) {
        this.emitState({
          status: 'unavailable',
          snapshot: null,
          reason: `Window handle recycled; PID changed from ${processId} to ${snapshot.processId}`,
        });
        return;
      }

      // Valid tracking state
      this.emitState({
        status: 'tracking',
        snapshot,
      });
    } catch (err: any) {
      this.emitState({
        status: 'unavailable',
        snapshot: null,
        reason: err?.message || 'Unexpected tracker error',
      });
    } finally {
      this.isPolling = false;
      if (this.needsRepoll && this.isRunning) {
        this.needsRepoll = false;
        // Schedule next turn
        setImmediate(() => {
          if (this.isRunning) void this.pollOnce();
        });
      }
    }
  }
}

export function createWindowTracker(options?: TrackerOptions): WindowTracker {
  return new WindowTrackerImpl(options);
}
