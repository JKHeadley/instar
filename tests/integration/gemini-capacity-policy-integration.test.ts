// safe-fs-allow: test file - SafeFsExecutor used for tmpdir cleanup.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createGeminiCliAdapter } from '../../src/providers/adapters/gemini-cli/index.js';
import { CapabilityFlag } from '../../src/providers/capabilities.js';
import type { OneShotCompletion } from '../../src/providers/primitives/transport/oneShotCompletion.js';
import { QuotaError } from '../../src/providers/errors.js';
import { resetGeminiCapacityPolicyForTests } from '../../src/providers/adapters/gemini-cli/observability/geminiCapacityPolicy.js';

describe('gemini capacity policy integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetGeminiCapacityPolicyForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-capacity-int-'));
  });

  afterEach(() => {
    resetGeminiCapacityPolicyForTests();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/gemini-capacity-policy-integration.test.ts:cleanup' });
  });

  function fakeGemini(scriptBody: string): string {
    const bin = path.join(tmpDir, 'fake-gemini');
    fs.writeFileSync(bin, `#!/usr/bin/env node\n${scriptBody}\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  it('retries a short Gemini capacity failure and then succeeds', async () => {
    const countFile = path.join(tmpDir, 'count');
    const bin = fakeGemini(`
const fs = require('fs');
const countFile = ${JSON.stringify(countFile)};
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(n + 1));
if (n === 0) {
  process.stderr.write('Error: 429 resource exhausted, retry after 1s');
  process.exit(1);
}
process.stdout.write('OK_AFTER_RETRY');
`);
    const adapter = createGeminiCliAdapter({
      geminiPath: bin,
      capacityPolicy: { maxImmediateRetries: 1, immediateRetryMaxMs: 2_000 },
    });
    const oneShot = adapter.primitive(CapabilityFlag.OneShotCompletion) as OneShotCompletion;
    const result = await oneShot.evaluate('p', { timeoutMs: 10_000 });
    expect(result.text).toBe('OK_AFTER_RETRY');
    expect(fs.readFileSync(countFile, 'utf8')).toBe('2');
  });

  it('applies fallbackModel to the spawned retry argv', async () => {
    const countFile = path.join(tmpDir, 'count');
    const argvFile = path.join(tmpDir, 'argv.jsonl');
    const bin = fakeGemini(`
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
    const adapter = createGeminiCliAdapter({
      geminiPath: bin,
      capacityPolicy: {
        maxImmediateRetries: 1,
        immediateRetryMaxMs: 2_000,
        fallbackModel: 'gemini-2.5-flash',
      },
    });
    const oneShot = adapter.primitive(CapabilityFlag.OneShotCompletion) as OneShotCompletion;
    const result = await oneShot.evaluate('p', { model: 'gemini-2.5-pro', timeoutMs: 10_000 });

    expect(result.text).toBe('OK_WITH_FALLBACK');
    const argvLines = fs.readFileSync(argvFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(argvLines).toHaveLength(2);
    expect(argvLines[0]).toContain('gemini-2.5-pro');
    expect(argvLines[1]).toContain('gemini-2.5-flash');
  });

  it('defers after a long quota reset and refuses the next call locally', async () => {
    const countFile = path.join(tmpDir, 'count');
    const quotaFile = path.join(tmpDir, 'quota-state.json');
    const bin = fakeGemini(`
const fs = require('fs');
const countFile = ${JSON.stringify(countFile)};
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(n + 1));
process.stderr.write('TerminalQuotaError: QUOTA_EXHAUSTED. Your quota will reset after 2h0m0s.');
process.exit(1);
`);
    const adapter = createGeminiCliAdapter({
      geminiPath: bin,
      capacityPolicy: { quotaStateFile: quotaFile },
    });
    const oneShot = adapter.primitive(CapabilityFlag.OneShotCompletion) as OneShotCompletion;
    await expect(oneShot.evaluate('p', { timeoutMs: 10_000 })).rejects.toBeInstanceOf(QuotaError);
    await expect(oneShot.evaluate('p', { timeoutMs: 10_000 })).rejects.toBeInstanceOf(QuotaError);
    // The FIRST evaluate now spawns Gemini three times — flash exhausts, the
    // policy switches to pro (separate quota), pro ALSO exhausts → switches to
    // gemini-3.1-pro-preview, which ALSO exhausts → only then a genuine
    // account-wide deferral. The SECOND evaluate is still refused locally by the
    // gate (no further spawn), so the count stays at 3.
    expect(fs.readFileSync(countFile, 'utf8')).toBe('3');

    const state = JSON.parse(fs.readFileSync(quotaFile, 'utf8')) as {
      source: string;
      fiveHourPercent: number;
      model: string;
      recommendation: string;
      scope: string;
    };
    expect(state.source).toBe('gemini-cli-capacity');
    expect(state.fiveHourPercent).toBe(100);
    // The stop-state records the last model confirmed exhausted
    // (gemini-3.1-pro-preview) and is account-scoped — written only once EVERY
    // known model is exhausted.
    expect(state.model).toBe('gemini-3.1-pro-preview');
    expect(state.recommendation).toBe('stop');
    expect(state.scope).toBe('account');
  });
});
