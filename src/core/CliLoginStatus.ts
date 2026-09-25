/**
 * The Codex CLI's OWN login check, against one account's config home (spec
 * skill-driven-signin-repair, "Pool health from the CLI's own login status").
 *
 * `CODEX_HOME=<home> codex login status` prints "Logged in using ChatGPT" (exit 0) or
 * "Not logged in" (exit 1). This module turns that into a closed verdict and never
 * guesses: anything it cannot classify is `unavailable`, which the caller treats as
 * "no signal" (the prior status is kept; the account is not eligible as a helper seat).
 *
 * A "signed-in" verdict is meaningful only if the check has been PROVEN able to fail
 * (operator correction 2026-09-25, from measured evidence: Claude's `claude auth status`
 * reports `loggedIn: true` for sessions that have expired, so a check that cannot say
 * "no" proves nothing). So before the first real read, the checker runs a canary against
 * an empty, freshly-made config home. Only when the CLI answers "Not logged in" there
 * does it trust its "Logged in" answers; otherwise every verdict is `unavailable`.
 *
 * What the canary proves, and what it does not: it proves the CLI can say "Not logged in" (when
 * credentials are absent). It does NOT prove the CLI detects a revoked or expired token whose
 * auth.json is still present — so a "signed-in" verdict is never used alone: the helper-seat pick
 * pairs it with a live authenticated read, and the needs-reauth rule requires the live read to be
 * refused as well.
 *
 * Claude deliberately has NO equivalent here: `claude auth status` only proves a
 * credential file exists. Claude's login health comes from the authenticated OAuth
 * usage read the quota poller already makes.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export type CliLoginVerdict = 'signed-in' | 'signed-out' | 'unavailable';

export interface CliRunResult { code: number | null; stdout: string; stderr: string }
export type CliRunner = (env: Record<string, string>, timeoutMs: number) => Promise<CliRunResult>;

export interface CodexLoginStatusCheckerOptions {
  /** Injected for tests; defaults to running `codex login status`. */
  run?: CliRunner;
  timeoutMs?: number;
  /** Directory the canary's empty config home is created under (default: os.tmpdir()). */
  scratchDir?: string;
  /** A FAILED canary (timeout, missing binary) is retried after this long; a passed one is kept. */
  canaryRetryMs?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Classify one `codex login status` result. Exported for tests. */
export function classifyCodexLoginStatus(result: CliRunResult): CliLoginVerdict {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (/\bnot logged in\b/.test(text)) return 'signed-out';
  if (result.code === 0 && /\blogged in\b/.test(text)) return 'signed-in';
  return 'unavailable';
}

function defaultRunner(env: Record<string, string>, timeoutMs: number): Promise<CliRunResult> {
  return new Promise((resolve) => {
    execFile('codex', ['login', 'status'], { env: { ...process.env, ...env }, timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? Number((error as unknown as { code: number }).code) : (error ? null : 0);
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      });
  });
}

export class CodexLoginStatusChecker {
  private readonly run: CliRunner;
  private readonly timeoutMs: number;
  private readonly scratchDir: string;
  private canary: Promise<boolean> | null = null;
  private canaryFailedAt: number | null = null;
  private readonly canaryRetryMs: number;
  private readonly now: () => number;

  constructor(options: CodexLoginStatusCheckerOptions = {}) {
    this.run = options.run ?? defaultRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.scratchDir = options.scratchDir ?? os.tmpdir();
    this.canaryRetryMs = Math.max(0, options.canaryRetryMs ?? 10 * 60_000);
    this.now = options.now ?? Date.now;
  }

  /**
   * True once the canary proved the check says "Not logged in" for an empty home. A pass is kept
   * for the process; a failure (a boot-time timeout, say) is retried after `canaryRetryMs`, so one
   * bad moment never disables the check until restart.
   */
  async proven(): Promise<boolean> {
    if (this.canaryFailedAt !== null && this.now() - this.canaryFailedAt >= this.canaryRetryMs) {
      this.canary = null;
      this.canaryFailedAt = null;
    }
    if (!this.canary) {
      this.canary = this.runCanary();
      const passed = await this.canary;
      if (!passed) this.canaryFailedAt = this.now();
      return passed;
    }
    return this.canary;
  }

  async check(codexHome: string): Promise<CliLoginVerdict> {
    if (!codexHome || !path.isAbsolute(codexHome)) return 'unavailable';
    if (!(await this.proven())) return 'unavailable';
    try {
      return classifyCodexLoginStatus(await this.run({ CODEX_HOME: codexHome }, this.timeoutMs));
    } catch {
      return 'unavailable'; // @silent-fallback-ok — unrunnable check = no signal; caller keeps the prior status
    }
  }

  private async runCanary(): Promise<boolean> {
    let dir: string | null = null;
    try {
      dir = fs.mkdtempSync(path.join(this.scratchDir, 'instar-codex-login-canary-'));
      return classifyCodexLoginStatus(await this.run({ CODEX_HOME: dir }, this.timeoutMs)) === 'signed-out';
    } catch {
      return false; // @silent-fallback-ok — an unprovable check yields `unavailable` verdicts, never trust
    } finally {
      if (dir) {
        try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'codex login-status canary cleanup' }); }
        catch { /* best effort — an empty temp dir */ }
      }
    }
  }
}
