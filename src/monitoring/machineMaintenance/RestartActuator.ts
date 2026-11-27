/**
 * The restart actuator (docs/specs/machine-self-maintenance.md, Part C "The privilege, per
 * OS" and Part D "Dispatch outcome"). CMT-1199.
 *
 * The ONLY code in instar that holds a machine-restart command line; a source test fails
 * the build if any other file under src/ names one. Every dispatch goes through the host
 * store's `claimRung`, which writes the attempt to the ledger as `unknown` before the
 * command runs, so a crash at any point leaves the safe reading.
 *
 * It refuses outright, before touching the ledger, when the real command would run inside
 * a test process (VITEST, CI) or a throwaway agent. Tests drive it with an injected spawner.
 *
 * Outcome, exactly as the spec defines it:
 *  - `refused`: shown to be before dispatch. The process could not start, or sudo refused
 *    and `sudo -n -l` no longer lists the exact line. The OS was asked for nothing.
 *  - `accepted`: the command exited 0.
 *  - `unknown`: everything else: a timeout, a signal, a lost result, a nonzero exit from the
 *    shutdown command itself. A timeout never means cancelled.
 *
 * No caller exists in this build: enrolment (CMT-1200) installs the sudoers rule and the
 * operator's Restart now wires the first caller.
 */

import { execFile } from 'node:child_process';
import type { HostMaintenanceStore, DispatchOutcome } from './HostMaintenanceStore.js';

export type RestartPlatform = 'darwin' | 'linux' | 'wsl';

/** Exact command lines. The sudoers rule grants exactly these and nothing else. */
export const RESTART_COMMANDS: Record<RestartPlatform, Record<1 | 2, { command: string; args: string[] }>> = {
  darwin: {
    1: { command: 'sudo', args: ['-n', '/sbin/shutdown', '-r', 'now'] },
    2: { command: 'sudo', args: ['-n', '/sbin/reboot', '-q'] },
  },
  linux: {
    1: { command: 'sudo', args: ['-n', '/usr/bin/systemctl', 'reboot'] },
    2: { command: 'sudo', args: ['-n', '/usr/bin/systemctl', 'reboot', '--force'] },
  },
  wsl: {
    // A WSL `reboot` restarts only the VM: the Windows path restarts the machine.
    1: { command: '/mnt/c/Windows/System32/shutdown.exe', args: ['/r', '/t', '30'] },
    2: { command: '/mnt/c/Windows/System32/shutdown.exe', args: ['/r', '/f', '/t', '0'] },
  },
};

/** The sudoers line for a platform: the privileged part of each rung, in rung order. */
export function sudoersLines(platform: Exclude<RestartPlatform, 'wsl'>): string[] {
  return ([1, 2] as const).map((r) => RESTART_COMMANDS[platform][r].args.slice(1).join(' '));
}

export interface SpawnResult {
  /** The process started. False: it never ran (ENOENT, EACCES, spawn failure). */
  spawned: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

export type CommandSpawner = (command: string, args: string[], timeoutMs: number) => Promise<SpawnResult>;

/**
 * The real spawner. Started synchronously (execFile forks before returning), so the
 * claimRung lock is held through the start of the command.
 */
export function realSpawner(command: string, args: string[], timeoutMs: number): { started: Promise<SpawnResult> } {
  let resolve!: (r: SpawnResult) => void;
  const started = new Promise<SpawnResult>((r) => { resolve = r; });
  try {
    const child = execFile(command, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err) => {
      if (!err) { resolve({ spawned: true, exitCode: 0, signal: null, timedOut: false }); return; }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string; code?: unknown };
      if (typeof e.code === 'string' && !/^\d+$/.test(e.code)) { resolve({ spawned: false, exitCode: null, signal: null, timedOut: false }); return; }
      resolve({ spawned: true, exitCode: typeof e.code === 'number' ? e.code : null, signal: e.signal ?? null, timedOut: e.killed === true });
    });
    if (!child.pid) { /* spawn error arrives through the callback */ }
  } catch {
    resolve({ spawned: false, exitCode: null, signal: null, timedOut: false });
  }
  return { started };
}

export interface RestartActuatorDeps {
  store: HostMaintenanceStore;
  platform: RestartPlatform;
  agent: string;
  readBootAt: () => Promise<number | null>;
  /** Off switch, S1 and S2, read live inside claimRung. Returns the refusal reason or null. */
  freshCheck: () => string | null;
  isThrowaway: () => boolean;
  /** `sudo -n -l` output, for telling a sudo refusal (nothing asked of the OS) from a failed restart. Null: unread. */
  sudoList?: () => Promise<string | null>;
  /** Injected in tests. Absent: the real spawner, which a test process may never reach. */
  spawn?: CommandSpawner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type DispatchResult =
  | { dispatched: true; outcome: DispatchOutcome }
  | { dispatched: false; reason: string };

export class RestartActuator {
  constructor(private readonly deps: RestartActuatorDeps) {}

  /** Why the real command may not run in this process, or null. */
  realCommandBlocked(): string | null {
    if (this.deps.spawn) return null;
    const env = this.deps.env ?? process.env;
    if (env.VITEST || env.CI) return 'test-process';
    try { if (this.deps.isThrowaway()) return 'throwaway'; } catch { return 'throwaway-unread'; } // @silent-fallback-ok — unreadable reads as a refusal
    return null;
  }

  async dispatch(input: { episodeId: string; generation: number; rung: 1 | 2 }): Promise<DispatchResult> {
    const blocked = this.realCommandBlocked();
    if (blocked) return { dispatched: false, reason: blocked };
    const bootAt = await this.deps.readBootAt();
    if (bootAt === null) return { dispatched: false, reason: 'boot-unread' };
    const { command, args } = RESTART_COMMANDS[this.deps.platform][input.rung];
    const timeoutMs = this.deps.timeoutMs ?? 60_000;
    let pending: Promise<SpawnResult> | null = null;
    const claim = this.deps.store.claimRung({
      episodeId: input.episodeId, generation: input.generation, rung: input.rung, currentBootAt: bootAt, by: this.deps.agent,
      fresh: this.deps.freshCheck,
      spawn: () => {
        pending = this.deps.spawn ? this.deps.spawn(command, args, timeoutMs) : realSpawner(command, args, timeoutMs).started;
      },
    });
    if (!claim.ok) return { dispatched: false, reason: claim.reason };
    let result: SpawnResult;
    try { result = await (pending as Promise<SpawnResult> | null ?? Promise.resolve({ spawned: false, exitCode: null, signal: null, timedOut: false })); }
    catch { result = { spawned: true, exitCode: null, signal: null, timedOut: false }; } // @silent-fallback-ok — a lost result is unknown
    const outcome = await this.classify(result, args);
    this.deps.store.recordDispatch({ episodeId: input.episodeId, generation: input.generation, rung: input.rung, outcome, by: this.deps.agent });
    return { dispatched: true, outcome };
  }

  private async classify(r: SpawnResult, args: string[]): Promise<DispatchOutcome> {
    if (!r.spawned) return 'refused';
    if (r.exitCode === 0 && !r.timedOut && !r.signal) return 'accepted';
    if (r.timedOut || r.signal || r.exitCode === null) return 'unknown';
    // Nonzero exit. Through sudo, a refusal is proven only when the exact line is no longer granted.
    if (this.deps.platform === 'wsl' || !this.deps.sudoList) return 'unknown';
    let listing: string | null = null;
    try { listing = await this.deps.sudoList(); } catch { listing = null; } // @silent-fallback-ok — unread keeps unknown
    if (listing === null) return 'unknown';
    const line = args.slice(1).join(' ');
    return listing.includes(line) ? 'unknown' : 'refused';
  }
}
