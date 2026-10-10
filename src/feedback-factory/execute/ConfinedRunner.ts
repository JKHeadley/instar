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

/** Spawn with a wall-clock timeout (SIGKILL on expiry) and an output cap. Never throws on a non-zero exit. */
export function runCapped(bin: string, args: string[], command: Pick<ConfinedCommand, 'cwd' | 'env' | 'timeoutMs'>): Promise<ConfinedResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: command.cwd, env: command.env, stdio: ['ignore', 'pipe', 'pipe'], detached: false });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let capped = false;
    let timedOut = false;
    const take = (which: 'out' | 'err') => (chunk: Buffer) => {
      if (capped) return;
      size += chunk.length;
      if (size > CONFINED_OUTPUT_CAP_BYTES) { capped = true; child.kill('SIGKILL'); return; }
      if (which === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', take('out'));
    child.stderr?.on('data', take('err'));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.max(1, command.timeoutMs));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, stdout, stderr: `${stderr}\n[spawn error: ${error.message}]`, timedOut, outputCapped: capped });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal: signal ?? null, stdout, stderr, timedOut, outputCapped: capped });
    });
  });
}

/** Total bytes under `dir` (lstat; links are not followed). Bounded by `limit` for an early stop. */
export function treeBytes(dir: string, limit: number = Number.MAX_SAFE_INTEGER): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0 && total <= limit) {
    const current = stack.pop()!;
    let names: string[] = [];
    try { names = fs.readdirSync(current); } catch { continue; } // @silent-fallback-ok: an unreadable or vanished directory adds nothing to the measured size
    for (const name of names) {
      const full = path.join(current, name);
      let st: fs.Stats;
      try { st = fs.lstatSync(full); } catch { continue; } // @silent-fallback-ok: vanished between readdir and lstat
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) { if (name !== 'node_modules') stack.push(full); continue; }
      total += st.size;
    }
  }
  return total;
}
