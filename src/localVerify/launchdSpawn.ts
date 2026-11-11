/**
 * Start the local-verify run child as its own launchd job with `ProcessType Interactive`
 * (macOS only), so the run and its test lanes use the performance cores.
 *
 * Why: everything descended from a launchd job that has no `ProcessType`, which includes
 * the shared tmux server the agent server runs in, is scheduled at priority 20 and kept on
 * the efficiency cores. Measured 2026-11-10 on a 16-core Mac Studio:
 *   - the four efficiency cores were fully busy while the twelve performance cores sat near 30%;
 *   - a fixed CPU loop took 12.6 s from a session and 1.2 s from an Interactive launchd job.
 * The verify lanes shared those four cores with every session's work. When the sessions
 * got busy, every lane hit its deadline, so `main` could not go green and the merge queue
 * held (2026-11-11, 02:11Z onward). `nice`, `taskpolicy`, `launchctl submit` and
 * `launchctl asuser` do not lift this; a bootstrapped job with `ProcessType Interactive`
 * does, and its children inherit it.
 *
 * The contract matches the plain detached spawn:
 *   - The job's process is the leader of its own process group (pid === pgid), because
 *     launchd starts each job in a new session. A tiny `/bin/sh` prelude records the pid,
 *     then `exec`s the command, so the recorded pid is the command itself.
 *   - Output is appended to `logFile`.
 *   - `exited` resolves with the command's exit status (or the signal that ended it), read
 *     from launchd after the process is gone. The job is then booted out and its plist removed.
 * Any failure before the process has started throws, and the caller falls back to the plain
 * spawn. A failure after it started never re-spawns, so a run is never started twice.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ChildHandle } from './LocalVerifyService.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

const rm = (p: string) => SafeFsExecutor.safeRmSync(p, { force: true, operation: 'local-verify:launchd-job-file' });

export interface LaunchdSpawnSeams {
  /** Run launchctl synchronously; returns stdout, throws on a non-zero exit. */
  launchctl(args: string[]): string;
  /** Block for `ms` (only used while waiting up to `pidWaitMs` for the pid file). */
  sleepSync(ms: number): void;
  isAlive(pid: number): boolean;
  uid(): number;
  now(): number;
  /** Poll timer for the exit watch (unref'd in production). */
  every(ms: number, fn: () => void): { stop(): void };
}

export interface LaunchdSpawnOpts {
  /** Directory for the job's plist and pid file (created if missing). */
  dir: string;
  /** Label prefix, unique per agent (e.g. `ai.instar.lv-run.<hash>`). */
  labelPrefix: string;
  cwd: string;
  /** How long to wait for the started process to record its pid (default 3000 ms). */
  pidWaitMs?: number;
  /** Exit-watch poll interval (default 1000 ms). */
  pollMs?: number;
  seams?: Partial<LaunchdSpawnSeams>;
}

export function realLaunchdSeams(): LaunchdSpawnSeams {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  return {
    launchctl: (args) => execFileSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }),
    sleepSync: (ms) => { Atomics.wait(sab, 0, 0, ms); },
    isAlive: (pid) => {
      try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
    },
    uid: () => process.getuid?.() ?? 0,
    now: () => Date.now(),
    every: (ms, fn) => {
      const t = setInterval(fn, ms);
      t.unref();
      return { stop: () => clearInterval(t) };
    },
  };
}

/** A label prefix unique to this agent's state directory. */
export function launchdLabelPrefix(stateDir: string): string {
  return `ai.instar.lv-run.${crypto.createHash('sha256').update(stateDir).digest('hex').slice(0, 10)}`;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The job's plist. Exported for tests. */
export function buildPlist(i: { label: string; programArgs: string[]; env: Record<string, string>; logFile: string; cwd: string }): string {
  const arr = i.programArgs.map((a) => `<string>${xml(a)}</string>`).join('');
  const env = Object.entries(i.env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict>'
    + `<key>Label</key><string>${xml(i.label)}</string>`
    + '<key>ProcessType</key><string>Interactive</string>'
    + `<key>ProgramArguments</key><array>${arr}</array>`
    + `<key>EnvironmentVariables</key><dict>${env}</dict>`
    + `<key>WorkingDirectory</key><string>${xml(i.cwd)}</string>`
    + `<key>StandardOutPath</key><string>${xml(i.logFile)}</string>`
    + `<key>StandardErrorPath</key><string>${xml(i.logFile)}</string>`
    + '<key>RunAtLoad</key><true/>'
    + '<key>AbandonProcessGroup</key><true/>'
    + '</dict></plist>\n';
}

const SIGNALS: Record<string, string> = { 'Killed: 9': 'SIGKILL', 'Terminated: 15': 'SIGTERM', 'Interrupt: 2': 'SIGINT', 'Hangup: 1': 'SIGHUP' };

/** Parse `launchctl print` for how the job's process ended. Exported for tests. */
export function parseExit(print: string): { status: number | null; signal: string | null } {
  const sig = /last terminating signal = ([^\n]+)/.exec(print)?.[1]?.trim();
  if (sig) return { status: null, signal: SIGNALS[sig] ?? sig };
  const code = /last exit code = (-?\d+)/.exec(print)?.[1];
  return code !== undefined ? { status: Number(code), signal: null } : { status: null, signal: null };
}

/** Boot out jobs under this prefix that are no longer running (left over from a server that stopped mid-run). */
export function sweepStale(prefix: string, dir: string, s: LaunchdSpawnSeams): number {
  let n = 0;
  let list = '';
  try { list = s.launchctl(['list']); } catch { return 0; } // @silent-fallback-ok: a sweep is housekeeping only
  for (const line of list.split('\n')) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (!label?.startsWith(prefix + '.') || pid !== '-') continue;
    try { s.launchctl(['bootout', `gui/${s.uid()}/${label}`]); n++; } catch { /* @silent-fallback-ok: already gone */ }
    for (const ext of ['.plist', '.pid']) rm(path.join(dir, label + ext));
  }
  return n;
}

export function spawnViaLaunchd(
  a: { command: string; args: string[]; env: NodeJS.ProcessEnv; logFile: string },
  opts: LaunchdSpawnOpts,
): ChildHandle {
  const s: LaunchdSpawnSeams = { ...realLaunchdSeams(), ...opts.seams };
  fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  sweepStale(opts.labelPrefix, opts.dir, s);
  const label = `${opts.labelPrefix}.${s.now()}.${crypto.randomBytes(3).toString('hex')}`;
  const plistPath = path.join(opts.dir, label + '.plist');
  const pidPath = path.join(opts.dir, label + '.pid');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(a.env)) if (typeof v === 'string') env[k] = v;
  // `$0` is the pid file; `exec "$@"` keeps the recorded pid as the command's own.
  const programArgs = ['/bin/sh', '-c', 'echo $$ > "$0" && exec "$@"', pidPath, a.command, ...a.args];
  fs.writeFileSync(plistPath, buildPlist({ label, programArgs, env, logFile: a.logFile, cwd: opts.cwd }), { mode: 0o600 });
  const domain = `gui/${s.uid()}`;
  const cleanup = () => {
    try { s.launchctl(['bootout', `${domain}/${label}`]); } catch { /* @silent-fallback-ok: already gone */ }
    rm(plistPath);
    rm(pidPath);
  };
  try {
    s.launchctl(['bootstrap', domain, plistPath]);
  } catch (e) {
    rm(plistPath);
    throw new Error(`launchctl bootstrap failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  // Wait for the started process to record its pid.
  const deadline = s.now() + (opts.pidWaitMs ?? 3000);
  let pid = 0;
  for (;;) {
    try { pid = Number(fs.readFileSync(pidPath, 'utf8').trim()); } catch { pid = 0; } // @silent-fallback-ok: not written yet
    if (pid > 0 || s.now() >= deadline) break;
    s.sleepSync(25);
  }
  if (!(pid > 0)) {
    // Started (or not) without a pid we can track: stop it and let the caller use the plain spawn.
    cleanup();
    throw new Error('launchd job recorded no pid');
  }
  const exited = new Promise<{ status: number | null; signal: string | null }>((resolve) => {
    const timer = s.every(opts.pollMs ?? 1000, () => {
      if (s.isAlive(pid)) return;
      timer.stop();
      let print = '';
      try { print = s.launchctl(['print', `${domain}/${label}`]); } catch { /* @silent-fallback-ok: unknown exit */ }
      cleanup();
      resolve(parseExit(print));
    });
  });
  return { pid, exited };
}
