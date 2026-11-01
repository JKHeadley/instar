import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { classifyCodexLoginStatus, CodexLoginStatusChecker, CLI_LOGIN_STATUS_TEXT_MAX_BYTES, type CliRunResult } from '../../src/core/CliLoginStatus.js';

/**
 * The Codex CLI's own login check (spec skill-driven-signin-repair). A "signed in" answer is
 * trusted only after a canary PROVED the check can say "not logged in" (operator correction
 * 2026-09-25: a check that cannot fail proves nothing).
 */
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'CliLoginStatus.test cleanup' }); });

const SIGNED_IN: CliRunResult = { code: 0, stdout: 'Logged in using ChatGPT\n', stderr: '' };
const SIGNED_OUT: CliRunResult = { code: 1, stdout: 'Not logged in\n', stderr: '' };

describe('classifyCodexLoginStatus', () => {
  it('reads the real CLI wording on both sides', () => {
    expect(classifyCodexLoginStatus(SIGNED_IN)).toBe('signed-in');
    expect(classifyCodexLoginStatus(SIGNED_OUT)).toBe('signed-out');
    // "Not logged in" wins even if the exit code were 0.
    expect(classifyCodexLoginStatus({ code: 0, stdout: 'Not logged in', stderr: '' })).toBe('signed-out');
  });

  it('never guesses: an error, a non-zero "logged in", or unknown text is unavailable', () => {
    expect(classifyCodexLoginStatus({ code: 2, stdout: 'Logged in using ChatGPT', stderr: '' })).toBe('unavailable');
    expect(classifyCodexLoginStatus({ code: null, stdout: '', stderr: 'spawn codex ENOENT' })).toBe('unavailable');
    expect(classifyCodexLoginStatus({ code: 0, stdout: 'something else', stderr: '' })).toBe('unavailable');
  });
});

describe('CodexLoginStatusChecker', () => {
  function scratch(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-login-status-')); dirs.push(dir); return dir;
  }

  it('runs the canary against an EMPTY config home first, then trusts per-account answers', async () => {
    const homes: string[] = [];
    const run = vi.fn(async (env: Record<string, string>) => {
      homes.push(env.CODEX_HOME);
      // The canary home is empty ⇒ signed out; the real account home is signed in.
      return env.CODEX_HOME.includes('instar-codex-login-canary-') ? SIGNED_OUT : SIGNED_IN;
    });
    const checker = new CodexLoginStatusChecker({ run, scratchDir: scratch() });
    expect(await checker.check('/accounts/codex-a')).toBe('signed-in');
    expect(await checker.check('/accounts/codex-b')).toBe('signed-in');
    // One canary per process, then one call per check.
    expect(run).toHaveBeenCalledTimes(3);
    expect(homes[0]).toContain('instar-codex-login-canary-');
    expect(fs.existsSync(homes[0])).toBe(false); // canary home cleaned up
    expect(homes.slice(1)).toEqual(['/accounts/codex-a', '/accounts/codex-b']);
  });

  it('when the canary cannot fail (says signed in for an empty home), every verdict is unavailable', async () => {
    const run = vi.fn(async () => SIGNED_IN);
    const checker = new CodexLoginStatusChecker({ run, scratchDir: scratch() });
    expect(await checker.proven()).toBe(false);
    expect(await checker.check('/accounts/codex-a')).toBe('unavailable');
    expect(run).toHaveBeenCalledTimes(1); // never asks about a real account
  });

  it('reports a real signed-out account and treats a throwing runner as no signal', async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls++;
      if (calls === 1) return SIGNED_OUT; // canary
      if (calls === 2) return SIGNED_OUT;
      throw new Error('boom');
    });
    const checker = new CodexLoginStatusChecker({ run, scratchDir: scratch() });
    expect(await checker.check('/accounts/codex-a')).toBe('signed-out');
    expect(await checker.check('/accounts/codex-a')).toBe('unavailable');
  });

  it('refuses a relative or empty config home without running anything', async () => {
    const run = vi.fn(async () => SIGNED_OUT);
    const checker = new CodexLoginStatusChecker({ run, scratchDir: scratch() });
    expect(await checker.check('')).toBe('unavailable');
    expect(await checker.check('relative/home')).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
  });

  it('a FAILED canary is retried after the backoff; a passed one is kept', async () => {
    let now = 0;
    let canaryWorks = false;
    const run = vi.fn(async (env: Record<string, string>) => env.CODEX_HOME.includes('instar-codex-login-canary-')
      ? (canaryWorks ? SIGNED_OUT : { code: null, stdout: '', stderr: 'timeout' }) : SIGNED_IN);
    const checker = new CodexLoginStatusChecker({ run, scratchDir: scratch(), canaryRetryMs: 60_000, now: () => now });
    expect(await checker.check('/accounts/a')).toBe('unavailable');
    canaryWorks = true;
    now = 30_000;
    expect(await checker.check('/accounts/a')).toBe('unavailable'); // still inside the backoff
    now = 61_000;
    expect(await checker.check('/accounts/a')).toBe('signed-in'); // retried and proven
    const canaryRuns = () => run.mock.calls.filter((c) => String(c[0].CODEX_HOME).includes('canary')).length;
    const before = canaryRuns();
    now = 10 * 60_000;
    await checker.check('/accounts/a');
    expect(canaryRuns()).toBe(before); // a pass is not re-run
  });

  it('checkWithText returns the verdict plus the CLI status lines from ONE run; check() is unchanged', async () => {
    const run = vi.fn(async (env: Record<string, string>) => env.CODEX_HOME.includes('instar-codex-login-canary-')
      ? SIGNED_OUT
      : { code: 1, stdout: 'Not logged in\n\n', stderr: 'Error: device limit reached for this account\n' });
    const checker = new CodexLoginStatusChecker({ run, scratchDir: scratch() });
    expect(await checker.checkWithText('/accounts/a')).toEqual({
      verdict: 'signed-out',
      text: 'Not logged in\nError: device limit reached for this account',
    });
    expect(run).toHaveBeenCalledTimes(2); // canary + one run
    expect(await checker.check('/accounts/a')).toBe('signed-out');
    expect(run).toHaveBeenCalledTimes(3); // check() is one run too
  });

  it('checkWithText keeps the canary gating and yields empty text when it cannot speak', async () => {
    const unproven = new CodexLoginStatusChecker({ run: vi.fn(async () => SIGNED_IN), scratchDir: scratch() });
    expect(await unproven.checkWithText('/accounts/a')).toEqual({ verdict: 'unavailable', text: '' });
    const run = vi.fn(async () => SIGNED_OUT);
    const checker = new CodexLoginStatusChecker({ run, scratchDir: scratch() });
    expect(await checker.checkWithText('relative')).toEqual({ verdict: 'unavailable', text: '' });
    expect(run).not.toHaveBeenCalled();
    let calls = 0;
    const throwing = new CodexLoginStatusChecker({ scratchDir: scratch(), run: vi.fn(async () => {
      if (++calls === 1) return SIGNED_OUT; throw new Error('boom');
    }) });
    expect(await throwing.checkWithText('/accounts/a')).toEqual({ verdict: 'unavailable', text: '' });
  });

  it('checkWithText caps the status text at 2 KiB', async () => {
    const run = vi.fn(async (env: Record<string, string>) => env.CODEX_HOME.includes('instar-codex-login-canary-')
      ? SIGNED_OUT : { code: 0, stdout: `Logged in using ChatGPT ${'z'.repeat(5000)}`, stderr: 'w'.repeat(3000) });
    const checker = new CodexLoginStatusChecker({ run, scratchDir: scratch() });
    const out = await checker.checkWithText('/accounts/a');
    expect(out.verdict).toBe('signed-in');
    expect(Buffer.byteLength(out.text, 'utf8')).toBe(CLI_LOGIN_STATUS_TEXT_MAX_BYTES);
    expect(out.text.startsWith('Logged in using ChatGPT')).toBe(true);
  });
});
