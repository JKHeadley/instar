// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

it('documents the accepted risk with two real process-dependent test files', () => {
  const root = os.tmpdir();
  const dir = fs.mkdtempSync(path.join(root, 'neighbours-'));
  const file = path.join(dir, 'resource');
  const fixture = (name: string) => pathToFileURL(path.resolve('tests/fixtures/local-verify-first-part-neighbours', name + '.mjs')).href;
  const run = (names: string[]) => spawnSync(process.execPath, ['--input-type=module', '-e', names.map((n) => `await import(${JSON.stringify(fixture(n))});`).join('\n')],
    { env: { ...process.env, FIRST_PART_NEIGHBOUR_FILE: file }, encoding: 'utf8' });
  try {
    const together = run(['a', 'b']);
    const first = run(['a']); const rest = run(['b']);
    expect(together.status).toBe(0); expect(first.status).toBe(0);
    expect(rest.status).not.toBe(0); expect(rest.stderr).toContain('AssertionError');
  } finally { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'firstPartNeighbours.test.ts' }); }
});
