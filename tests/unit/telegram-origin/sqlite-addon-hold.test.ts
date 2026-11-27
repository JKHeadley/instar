/**
 * A store worker's exit must never unload the SQLite addon while that worker's
 * final garbage collection still runs the addon's clean-up (2026-11-08: the
 * store-retention test process died with SIGSEGV right after its heaviest store
 * closed; Local Verify read the 16 tests that never ran as failures and the
 * dead process as an unhandled error). OriginStore now has the parent thread
 * load the addon once and keep it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { compileOriginWorker } from '../../helpers/telegramOriginStore.js';

let worker: URL, probe: string, stateRoot: string;
beforeAll(async () => {
  worker = await compileOriginWorker();
  probe = path.resolve('.vitest/telegram-origin-tests', randomUUID(), 'originStoreAddonProbe.mjs');
  await build({ entryPoints: [path.resolve('tests/helpers/originStoreAddonProbe.ts')], outfile: probe, bundle: true, platform: 'node',
    format: 'esm', packages: 'external', logLevel: 'silent' });
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-origin-addon-'));
}, 30_000);
afterAll(() => {
  if (stateRoot) SafeFsExecutor.safeRmSync(stateRoot, { recursive: true, force: true, operation: 'tests/unit/telegram-origin/sqlite-addon-hold.test.ts:cleanup' });
});

function runProbe(cycles: number) {
  const run = spawnSync(process.execPath, [probe, worker.href, stateRoot, String(cycles)], { encoding: 'utf8', timeout: 90_000, env: process.env });
  const line = run.stdout.trim().split('\n').at(-1) ?? '';
  return { status: run.status, signal: run.signal, stderr: run.stderr, result: line.startsWith('{') ? JSON.parse(line) as { addonsAfterFirstOpen: string[]; cycles: number } : null };
}

describe('the SQLite addon outlives every store worker', () => {
  it('the parent thread holds the addon once the first store opens', () => {
    const { status, signal, result, stderr } = runProbe(1);
    expect({ status, signal }, stderr).toEqual({ status: 0, signal: null });
    expect(result?.addonsAfterFirstOpen).toContain('better_sqlite3.node');
  }, 120_000);

  it('a process survives repeated heavy stores opening and closing', () => {
    // Before the fix this died with SIGSEGV in most runs within a few cycles.
    const { status, signal, result, stderr } = runProbe(12);
    expect({ status, signal }, stderr).toEqual({ status: 0, signal: null });
    expect(result?.cycles).toBe(12);
  }, 120_000);

  it('an addon that cannot load is left for the worker to report, never thrown here', async () => {
    vi.resetModules();
    const { holdSqliteAddonForWorkers } = await import('../../../src/messaging/telegram-origin/OriginStore.js');
    expect(holdSqliteAddonForWorkers(() => { throw new Error('no native binary'); })).toBe(false);
    let opened = 0;
    expect(holdSqliteAddonForWorkers(() => { opened++; return { close: () => undefined }; })).toBe(true);
    expect(holdSqliteAddonForWorkers(() => { opened++; return { close: () => undefined }; })).toBe(true);
    expect(opened).toBe(1);
  });
});
