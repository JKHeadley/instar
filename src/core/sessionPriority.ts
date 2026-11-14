/**
 * Session scheduling priority — C3 of docs/specs/trustworthy-machine-load-and-mesh-floor.md
 * (carried from P2 into the P3 cut, as the P2 release note said).
 *
 * Sessions, the test runners they start and their helper subprocesses run at
 * `nice 5`; the agent server and lifeline stay at normal priority, so under CPU
 * overload the processes that watch, route and recover keep getting scheduled.
 *
 * Mechanism: rather than editing the spawn argv of every framework (each spawn
 * site is pinned by tests and differs per framework), each new session's tmux pane
 * process GROUP is reniced once, shortly after it starts (`renice 5 -g <pgid>`;
 * the absolute form, so it is idempotent). Processes the session forks afterwards
 * inherit the priority. Works on macOS, Linux and WSL; any failure is counted and
 * logged, never fatal. Each pane process is reniced at most once (no retry loop).
 */

import { execFile } from 'node:child_process';

export const SESSION_NICE = 5;

export interface SessionPriorityDeps {
  /** True when the priority change should be applied (admission enforced). */
  active: () => boolean;
  tmuxPath: string;
  /** Running session tmux names on this agent. */
  runningSessions: () => string[];
  /** Injected for tests: run a command, resolve stdout. */
  run?: (file: string, args: string[]) => Promise<string>;
  log?: (line: string) => void;
}

function defaultRun(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5_000, encoding: 'utf-8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export class SessionPriorityLowerer {
  /** tmux session name → pane pid already lowered (a respawned session gets a new pid). */
  private readonly lowered = new Map<string, number>();
  private readonly counters = { lowered: 0, failed: 0 };
  private running = false;
  private readonly run: (file: string, args: string[]) => Promise<string>;

  constructor(private readonly d: SessionPriorityDeps) {
    this.run = d.run ?? defaultRun;
  }

  /** One pass (every 15 s). Never throws; overlapping passes are skipped. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let names: string[] = [];
      try { names = this.d.runningSessions(); } catch { names = []; /* @silent-fallback-ok — no session list: nothing to lower this pass */ }
      const live = new Set(names);
      for (const k of [...this.lowered.keys()]) if (!live.has(k)) this.lowered.delete(k);
      if (!this.d.active()) return;
      for (const name of names) {
        let pid: number;
        try {
          const out = await this.run(this.d.tmuxPath, ['display-message', '-p', '-t', `=${name}:`, '#{pane_pid}']);
          pid = Number.parseInt(out.trim(), 10);
        } catch { continue; /* @silent-fallback-ok — the session ended between list and read; next pass */ }
        if (!Number.isInteger(pid) || pid <= 1 || this.lowered.get(name) === pid) continue;
        try {
          // The pane process leads its own process group (tmux starts it as a session leader).
          await this.run('renice', [String(SESSION_NICE), '-g', String(pid)]);
          this.lowered.set(name, pid);
          this.counters.lowered += 1;
        } catch (err) {
          this.counters.failed += 1;
          this.lowered.set(name, pid); // do not retry every 15 s
          this.d.log?.(`could not lower priority of ${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  status(): { active: boolean; nice: number; lowered: number; failed: number; tracked: number } {
    let active = false;
    try { active = this.d.active(); } catch { active = false; /* @silent-fallback-ok — unreadable gate reads as inactive */ }
    return { active, nice: SESSION_NICE, ...this.counters, tracked: this.lowered.size };
  }
}

// ── Process-wide handle, reported inside GET /work-admission ──
let activeLowerer: SessionPriorityLowerer | null = null;
export function setActiveSessionPriorityLowerer(l: SessionPriorityLowerer | null): void { activeLowerer = l; }
export function getActiveSessionPriorityLowerer(): SessionPriorityLowerer | null { return activeLowerer; }
