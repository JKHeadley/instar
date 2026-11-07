/**
 * Executor-run confined commands (docs/specs/feedback-triage-and-execution.md §4 step 4,
 * "Executor-run commands"): tests at base and head, the lint gate, and the canary's probes run
 * inside the session workspace through Anthropic's sandbox runtime (`@anthropic-ai/sandbox-runtime`,
 * exactly pinned) with the one confinement policy and a scrubbed environment.
 *
 * Refuse-if-unenforceable: when the runtime cannot be resolved, or its version is not the pinned
 * one, `available()` says so and the executor refuses to start (`profile-unenforceable`).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { CONFINED_OUTPUT_CAP_BYTES, SANDBOX_RUNTIME_PACKAGE, SANDBOX_RUNTIME_VERSION, type SandboxRuntimeSettings } from './executePolicy.js';

export interface ConfinedCommand {
  /** A shell command string (run as `sh -c` inside the sandbox). Built only by trusted code. */
  command: string;
  cwd: string;
  settings: SandboxRuntimeSettings;
  env: Record<string, string>;
  timeoutMs: number;
}

export interface ConfinedResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputCapped: boolean;
}

export interface ConfinedRunner {
  available(): { ok: true; version: string } | { ok: false; reason: string };
  run(command: ConfinedCommand): Promise<ConfinedResult>;
}

/** Locate the pinned sandbox runtime's CLI; null when it is not installed or not the pinned version. */
export function resolveSandboxRuntime(fromDir?: string): { cli: string; version: string } | { error: string } {
  try {
    const req = createRequire(fromDir ? path.join(fromDir, 'noop.js') : import.meta.url);
    const pkgPath = req.resolve(`${SANDBOX_RUNTIME_PACKAGE}/package.json`);
    // RULE 3: EXEMPT — reads the installed package's own manifest (a stable data contract), not a provider's state.
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    if (pkg.version !== SANDBOX_RUNTIME_VERSION) return { error: `sandbox-runtime-version-mismatch:${String(pkg.version)}` };
    const cli = path.join(path.dirname(pkgPath), 'dist', 'cli.js');
    if (!fs.existsSync(cli)) return { error: 'sandbox-runtime-cli-missing' };
    return { cli, version: pkg.version };
  } catch {
    return { error: 'sandbox-runtime-not-installed' }; // @silent-fallback-ok: refuse-if-unenforceable — the caller maps this to profile-unenforceable
  }
}

export class SandboxRuntimeRunner implements ConfinedRunner {
  constructor(private readonly opts: { settingsDir: string; nodePath?: string; resolve?: () => ReturnType<typeof resolveSandboxRuntime> }) {}

  available(): { ok: true; version: string } | { ok: false; reason: string } {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return { ok: false, reason: `unsupported-platform:${process.platform}` };
    const resolved = (this.opts.resolve ?? resolveSandboxRuntime)();
    return 'error' in resolved ? { ok: false, reason: resolved.error } : { ok: true, version: resolved.version };
  }

  async run(command: ConfinedCommand): Promise<ConfinedResult> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') throw new Error(`profile-unenforceable: unsupported-platform:${process.platform}`);
    const resolved = (this.opts.resolve ?? resolveSandboxRuntime)();
    if ('error' in resolved) throw new Error(`profile-unenforceable: ${resolved.error}`);
    fs.mkdirSync(this.opts.settingsDir, { recursive: true, mode: 0o700 });
    const settingsFile = path.join(this.opts.settingsDir, `srt-${randomUUID()}.json`);
    fs.writeFileSync(settingsFile, JSON.stringify(command.settings), { mode: 0o600, flag: 'wx' });
    // The runtime puts its own unix sockets under ITS TMPDIR, and a long attempt temp path exceeds
    // the socket-path limit (found by the canary: every command failed to start). The runtime
    // gets a short system temp; the wrapped command still gets the attempt's TMPDIR.
    const inner = command.env.TMPDIR ? `export TMPDIR=${shellQuote(command.env.TMPDIR)}; ${command.command}` : command.command;
    const outerEnv = { ...command.env, TMPDIR: shortTmpDir() };
    try {
      return await runCapped(this.opts.nodePath ?? process.execPath, [resolved.cli, '--settings', settingsFile, '-c', inner], { ...command, env: outerEnv });
    } finally {
      // The settings file is a trusted, agent-owned scratch file outside every confined tree.
      try { fs.writeFileSync(settingsFile, ''); } catch { /* @silent-fallback-ok: an emptied/unremovable scratch file holds no secret */ }
    }
  }
}

function shellQuote(value: string): string { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

/** A short temp directory for the runtime's own sockets (unix socket paths are length-limited). */
export function shortTmpDir(): string {
  for (const candidate of ['/tmp', '/private/tmp']) {
    try { if (fs.statSync(candidate).isDirectory()) return candidate; } catch { /* @silent-fallback-ok: try the next candidate */ }
  }
  return os.tmpdir();
}

/** Spawn with a wall-clock timeout and an output cap. Never throws on a non-zero exit.
 * A descendant can retain stdout/stderr after the direct child exits, even if it leaves
 * the original process group. Limit paths settle independently of the `close` event.
 */
export function runCapped(bin: string, args: string[], command: Pick<ConfinedCommand, 'cwd' | 'env' | 'timeoutMs'>): Promise<ConfinedResult> {
  return new Promise((resolve) => {
    const group = process.platform !== 'win32';
    const child = spawn(bin, args, { cwd: command.cwd, env: command.env, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
    const killTree = () => {
      if (group && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* @silent-fallback-ok: group may have exited; try direct child */ }
      }
      child.kill('SIGKILL');
    };
    let stdout = '';
    let stderr = '';
    let size = 0;
    let capped = false;
    let timedOut = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr, timedOut, outputCapped: capped });
    };
    const stopAtLimit = () => {
      killTree();
      // A detached descendant may have escaped the direct child's process group while
      // retaining these pipes. Do not wait for its exit to return a bounded result.
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(null, 'SIGKILL');
    };
    const take = (which: 'out' | 'err') => (chunk: Buffer) => {
      if (capped) return;
      size += chunk.length;
      if (size > CONFINED_OUTPUT_CAP_BYTES) { capped = true; stopAtLimit(); return; }
      if (which === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));
    timer = setTimeout(() => { timedOut = true; stopAtLimit(); }, Math.max(1, command.timeoutMs));
    child.on('error', (error) => {
      stderr += `\n[spawn error: ${error.message}]`;
      settle(null, null);
    });
    child.on('close', (code, signal) => {
      settle(code, signal ?? null);
    });
  });
}

/** Total bytes under `dir` (lstat; links are not followed). Bounded by `limit` for an early stop.
 *  Asynchronous on purpose: it walks a whole repository on every executor tick (see buildChangeSet). */
export async function treeBytes(dir: string, limit: number = Number.MAX_SAFE_INTEGER): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total <= limit) {
    const current = stack.pop()!;
    let names: string[] = [];
    try { names = await fs.promises.readdir(current); } catch { continue; } // @silent-fallback-ok: an unreadable or vanished directory adds nothing to the measured size
    for (const name of names) {
      const full = path.join(current, name);
      let st: fs.Stats;
      try { st = await fs.promises.lstat(full); } catch { continue; } // @silent-fallback-ok: vanished between readdir and lstat
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (name !== 'node_modules') stack.push(full); continue; }
      total += st.size;
    }
  }
  return total;
}
