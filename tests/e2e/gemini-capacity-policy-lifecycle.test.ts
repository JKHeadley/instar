// safe-fs-allow: test file - SafeFsExecutor used for tmpdir cleanup.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiCliIntelligenceProvider } from '../../src/core/GeminiCliIntelligenceProvider.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import { resetGeminiCapacityPolicyForTests } from '../../src/providers/adapters/gemini-cli/observability/geminiCapacityPolicy.js';

describe('Gemini capacity policy lifecycle (E2E)', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetGeminiCapacityPolicyForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-capacity-e2e-'));
  });

  afterEach(() => {
    resetGeminiCapacityPolicyForTests();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/gemini-capacity-policy-lifecycle.test.ts:cleanup' });
  });

  it('the live Gemini provider records quota deferral and the next call does not respawn Gemini', async () => {
    const countFile = path.join(tmpDir, 'count');
    const bin = path.join(tmpDir, 'fake-gemini');
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const countFile = ${JSON.stringify(countFile)};
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(n + 1));
process.stderr.write('TerminalQuotaError: QUOTA_EXHAUSTED. Your quota will reset after 2h0m0s.');
process.exit(1);
`);
    fs.chmodSync(bin, 0o755);

    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const provider = new GeminiCliIntelligenceProvider({
      geminiPath: bin,
      capacityPolicy: { quotaStateFile: quotaFile },
    });
    await expect(provider.evaluate('p', { timeoutMs: 10_000 })).rejects.toThrow(/deferring|quota|exhausted/i);
    await expect(provider.evaluate('p', { timeoutMs: 10_000 })).rejects.toThrow(/deferred|retry after/i);
    // First evaluate spawns Gemini twice (flash exhausts → switch to pro → pro
    // exhausts → genuine account-wide defer). Second evaluate is refused locally
    // by the gate, so the count stays at 2 — Gemini is NOT respawned again.
    expect(fs.readFileSync(countFile, 'utf8')).toBe('2');

    const written = JSON.parse(fs.readFileSync(quotaFile, 'utf8')) as {
      source: string;
      model: string;
      fiveHourPercent: number;
      blockedUntil: string;
      recommendation: string;
      scope: string;
    };
    expect(written.source).toBe('gemini-cli-capacity');
    // Last model confirmed exhausted; account-scoped (every known model is out).
    expect(written.model).toBe('gemini-2.5-pro');
    expect(written.fiveHourPercent).toBe(100);
    expect(written.recommendation).toBe('stop');
    expect(written.scope).toBe('account');
    expect(new Date(written.blockedUntil).getTime()).toBeGreaterThan(Date.now());

    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 60, critical: 80, shutdown: 95 },
    });
    expect(tracker.shouldSpawnSession('low')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('5-hour rate limit'),
    });
  });

  it('the live Gemini provider applies fallbackModel to the spawned retry argv', async () => {
    const countFile = path.join(tmpDir, 'count');
    const argvFile = path.join(tmpDir, 'argv.jsonl');
    const bin = path.join(tmpDir, 'fake-gemini');
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs');
const countFile = ${JSON.stringify(countFile)};
const argvFile = ${JSON.stringify(argvFile)};
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(n + 1));
fs.appendFileSync(argvFile, JSON.stringify(process.argv.slice(2)) + '\\n');
if (n === 0) {
  process.stderr.write('Error: 429 resource exhausted, retry after 1s');
  process.exit(1);
}
process.stdout.write('OK_WITH_FALLBACK');
`);
    fs.chmodSync(bin, 0o755);

    const provider = new GeminiCliIntelligenceProvider({
      geminiPath: bin,
      capacityPolicy: {
        maxImmediateRetries: 1,
        immediateRetryMaxMs: 2_000,
        fallbackModel: 'gemini-2.5-flash',
      },
    });
    const result = await provider.evaluate('p', { model: 'gemini-2.5-pro', timeoutMs: 10_000 });

    expect(result).toBe('OK_WITH_FALLBACK');
    const argvLines = fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(argvLines).toHaveLength(2);
    expect(argvLines[0]).toContain('gemini-2.5-pro');
    expect(argvLines[1]).toContain('gemini-2.5-flash');
  });
});
