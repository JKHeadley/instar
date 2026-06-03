import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

describe('dev preflight CLI', () => {
  it('runs from dist/cli.js and exits clean on the current tree', { timeout: 180000 }, () => {
    const cli = path.join(process.cwd(), 'dist', 'cli.js');
    if (!fs.existsSync(cli)) {
      return;
    }

    const output = execFileSync(process.execPath, [cli, 'dev:preflight'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
    });

    expect(output).toContain('Instar dev preflight');
    expect(output).toContain('Preflight complete: no blocking failures.');
  });
});
