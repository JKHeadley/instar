import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('dev preflight CLI', () => {
  it('runs from dist/cli.js and exits clean on the current tree', { timeout: 180000 }, () => {
    const cli = path.join(process.cwd(), 'dist', 'cli.js');
    if (!fs.existsSync(cli)) {
      return;
    }

    // A full repository run deliberately exercises self-disable fixtures.
    // Give this nested preflight its own empty host-test ledger so those
    // fixture events cannot masquerade as a real host-wide disable pattern.
    const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-preflight-ledger-'));
    let output: string;
    try {
      output = execFileSync(process.execPath, [cli, 'dev:preflight'], {
        cwd: process.cwd(),
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180000,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          INSTAR_HOST_TEST_BASE_DIR: ledgerDir,
        },
      });
    } finally {
      SafeFsExecutor.safeRmSync(ledgerDir, {
        recursive: true,
        force: true,
        operation: 'tests/e2e/dev-preflight-cli.test.ts:cleanup',
      });
    }

    expect(output).toContain('Instar dev preflight');
    expect(output).toContain('Preflight complete: no blocking failures.');
  });
});
