// safe-fs-allow: test file - SafeFsExecutor used for tmpdir cleanup.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GeminiCliIntelligenceProvider } from '../../src/core/GeminiCliIntelligenceProvider.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
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

    const provider = new GeminiCliIntelligenceProvider({ geminiPath: bin });
    await expect(provider.evaluate('p', { timeoutMs: 10_000 })).rejects.toThrow(/deferring|quota/i);
    await expect(provider.evaluate('p', { timeoutMs: 10_000 })).rejects.toThrow(/deferred|retry after/i);
    expect(fs.readFileSync(countFile, 'utf8')).toBe('1');
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
