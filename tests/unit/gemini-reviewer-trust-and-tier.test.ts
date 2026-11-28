/**
 * gemini cross-model reviewer — the trusted-folder refusal and the tier cut-off.
 *
 * Measured 2026-11-07 on gemini CLI 0.67.0: every gemini review degraded with
 * the generic reason `error`. Two causes, reproduced:
 *   1. a headless run outside a trusted folder exits 55 ("Gemini CLI is not
 *      running in a trusted directory ... use `--skip-trust`");
 *   2. with `--skip-trust`, auth fails with exit 1 and an `IneligibleTierError`
 *      (reasonCode UNSUPPORTED_CLIENT) — an account/tier problem.
 *
 * These tests drive the REAL chain: geminiReviewer.review → the factory →
 * GeminiCliIntelligenceProvider → a fake `gemini` script that records its argv
 * and replays the measured stderr. Only the factory's binary DETECTION is
 * replaced (pointed at the fake); the options the reviewer passes are recorded.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const factoryCalls: Array<Record<string, unknown>> = [];
let fakeGeminiPath = '';

vi.mock('../../src/core/intelligenceProviderFactory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/intelligenceProviderFactory.js')>();
  return {
    ...actual,
    buildIntelligenceProvider: (options: Record<string, unknown> = {}) => {
      factoryCalls.push(options);
      return actual.buildIntelligenceProvider({ ...options, binaryPath: fakeGeminiPath } as never);
    },
  };
});

const { SUPPORTED_REVIEWER_FRAMEWORKS, classifyGeminiReviewFailure } = await import(
  '../../src/core/crossModelReviewer.js'
);
const { GeminiCliIntelligenceProvider } = await import('../../src/core/GeminiCliIntelligenceProvider.js');

const geminiEntry = SUPPORTED_REVIEWER_FRAMEWORKS.find((f) => f.id === 'gemini-cli')!;

// The measured stderr shapes (gemini 0.67.0, 2026-11-07), trimmed.
const TIER_STDERR =
  "Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals. " +
  'To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google\n' +
  "  ineligibleTiers: [ { reasonCode: 'UNSUPPORTED_CLIENT', tierId: 'free-tier' } ]";
const UNTRUSTED_STDERR =
  'Gemini CLI is not running in a trusted directory. To proceed, either use `--skip-trust`, set the ' +
  '`GEMINI_CLI_TRUST_WORKSPACE=true` environment variable, or trust this directory in interactive mode.';

let tmpDir: string;
let argvLog: string;

/** Write a fake gemini that logs each argv (one line per call) then runs `body`. */
function writeFakeGemini(body: string): void {
  fakeGeminiPath = path.join(tmpDir, 'gemini');
  fs.writeFileSync(
    fakeGeminiPath,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${argvLog}"\n${body}\n`,
    { mode: 0o755 },
  );
}

/** Stage a stderr payload in a file so the fake can replay it byte-for-byte. */
function stderrFile(name: string, text: string): string {
  const f = path.join(tmpDir, name);
  fs.writeFileSync(f, text + '\n');
  return f;
}

function loggedCalls(): string[] {
  return fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf-8').trim().split('\n') : [];
}

async function review() {
  return geminiEntry.review({
    promptText: 'PROMPT',
    timeoutMs: 10_000,
    detectionOverride: { available: true, framework: 'gemini-cli', model: 'gemini-2.5-pro' },
  });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-trust-tier-'));
  argvLog = path.join(tmpDir, 'argv.log');
  factoryCalls.length = 0;
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/gemini-reviewer-trust-and-tier.test.ts tmpdir cleanup',
  });
});

describe('gemini reviewer — invocation', () => {
  it('passes --skip-trust on the gemini call (scoped via the factory option)', async () => {
    writeFakeGemini("echo 'Verdict: CLEAN'");
    const r = await review();
    expect(r.status).toBe('ok');
    expect(factoryCalls).toEqual([{ framework: 'gemini-cli', geminiSkipTrust: true }]);
    const calls = loggedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].split(' ')[0]).toBe('--skip-trust');
    expect(calls[0]).toContain('--approval-mode default -p PROMPT');
  });

  it('an old CLI that rejects the flag is retried ONCE without it (no regression on gemini < 0.40)', async () => {
    // Measured on gemini 0.35.0: `Unknown arguments: skip-trust, skipTrust`, exit 1.
    writeFakeGemini(
      'case "$1" in --skip-trust) echo "Unknown arguments: skip-trust, skipTrust" >&2; exit 1;; esac\n' +
        "echo 'Verdict: CLEAN'",
    );
    const r = await review();
    expect(r.status).toBe('ok');
    const calls = loggedCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0].startsWith('--skip-trust')).toBe(true);
    expect(calls[1]).not.toContain('--skip-trust');
  });

  it('a provider without the option keeps the exact old argv (other gemini callers unchanged)', async () => {
    writeFakeGemini("echo 'ok'");
    const p = new GeminiCliIntelligenceProvider({ geminiPath: fakeGeminiPath });
    await p.evaluate('hello', { model: 'capable' });
    const calls = loggedCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('--skip-trust');
    expect(calls[0].startsWith('-m ')).toBe(true);
  });
});

describe('gemini reviewer — named degraded reasons', () => {
  it('exit 55 (untrusted folder) degrades as gemini-untrusted-folder, not error', async () => {
    // The measured exit-55 stderr carried the tier error FIRST and the trust
    // message after the 600-char slice — exit 55 must still win.
    const tier = stderrFile('tier.txt', TIER_STDERR);
    const untrusted = stderrFile('untrusted.txt', UNTRUSTED_STDERR);
    writeFakeGemini(`cat "${tier}" >&2; cat "${untrusted}" >&2; exit 55`);
    const r = await review();
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('gemini-untrusted-folder');
    expect(r.flag).toBe('cross-model-review: gemini-cli:gemini-2.5-pro (degraded: gemini-untrusted-folder)');
    expect(r.crossFamily).toBe(true);
  });

  it('IneligibleTierError (UNSUPPORTED_CLIENT) degrades as gemini-tier-unsupported, not error', async () => {
    writeFakeGemini(`cat "${stderrFile('tier.txt', TIER_STDERR)}" >&2; exit 1`);
    const r = await review();
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('gemini-tier-unsupported');
    expect(r.flag).toBe('cross-model-review: gemini-cli:gemini-2.5-pro (degraded: gemini-tier-unsupported)');
  });

  it('an unrelated non-zero exit still degrades as error (everything else unchanged)', async () => {
    writeFakeGemini('echo "something else broke" >&2; exit 3');
    const r = await review();
    expect(r.status).toBe('degraded');
    expect(r.reason).toBe('error');
  });

  it('classifyGeminiReviewFailure keeps the shared mapping for timeouts and rate limits', () => {
    expect(classifyGeminiReviewFailure(new Error('Command timed out after 120000ms'))).toBe('timeout');
    expect(classifyGeminiReviewFailure(new Error('429 Too Many Requests'))).toBe('rate-limited');
    expect(classifyGeminiReviewFailure(new Error('Gemini CLI exited 1 — boom'))).toBe('error');
  });
});
