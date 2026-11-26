import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { withLocalHistoryExchange } from '../../src/import/LocalHistoryExchange.js';
import { sqliteRegistrySize } from '../../src/core/SqliteRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const privateIt = it.skipIf(process.platform === 'win32' || !process.getuid);
const dirs: string[] = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-exchange-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'local history exchange test' }); });

privateIt('refuses a second private allocation until the first exchange finishes disposal, then admits it', async () => {
  const dir = tmp();
  const baseline = sqliteRegistrySize();
  let dispose!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const first = withLocalHistoryExchange(dir, async () => {
    entered();
    await new Promise<void>(resolve => { dispose = resolve; });
    return 'drained';
  });
  await ready;
  expect(sqliteRegistrySize()).toBe(baseline + 1);
  const allocate = vi.fn(async () => 'allocated');
  expect(await withLocalHistoryExchange(dir, allocate)).toEqual({ accepted: false });
  expect(allocate).not.toHaveBeenCalled();
  // A separate state directory has independent resources.
  expect(await withLocalHistoryExchange(tmp(), async () => 'other')).toEqual({ accepted: true, value: 'other' });
  dispose();
  expect(await first).toEqual({ accepted: true, value: 'drained' });
  expect(sqliteRegistrySize()).toBe(baseline);
  expect(await withLocalHistoryExchange(dir, allocate)).toEqual({ accepted: true, value: 'allocated' });
});

privateIt('releases on callback failure and never mistakes a callback SQLITE_BUSY for admission refusal', async () => {
  const dir = tmp();
  const failure = Object.assign(new Error('synthetic callback failure'), { code: 'SQLITE_BUSY' });
  await expect(withLocalHistoryExchange(dir, async () => { throw failure; })).rejects.toBe(failure);
  expect(await withLocalHistoryExchange(dir, async () => 'retry')).toEqual({ accepted: true, value: 'retry' });
});

privateIt('refuses a redirected private namespace before invoking any allocation', async () => {
  const dir = tmp();
  const outside = tmp();
  fs.symlinkSync(outside, path.join(dir, 'local-history-upload'));
  const allocate = vi.fn(async () => undefined);
  await expect(withLocalHistoryExchange(dir, allocate)).rejects.toThrow();
  expect(allocate).not.toHaveBeenCalled();
  expect(fs.readdirSync(outside)).toEqual([]);
});

privateIt('refuses a namespace readable by other users before allocation', async () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'local-history-upload'), { mode: 0o755 });
  fs.chmodSync(path.join(dir, 'local-history-upload'), 0o755);
  const allocate = vi.fn(async () => undefined);
  await expect(withLocalHistoryExchange(dir, allocate)).rejects.toThrow();
  expect(allocate).not.toHaveBeenCalled();
});

privateIt.each(['', '-wal', '-shm', '-journal', 'hardlink'])('refuses redirected database material %s without touching its target', async kind => {
  const dir = tmp();
  const directory = path.join(dir, 'local-history-upload');
  fs.mkdirSync(directory, { mode: 0o700 });
  const target = path.join(tmp(), 'unrelated');
  fs.writeFileSync(target, 'leave this file alone');
  const candidate = path.join(directory, 'exchange-lock.sqlite' + (kind === 'hardlink' ? '' : kind));
  if (kind === 'hardlink') fs.linkSync(target, candidate);
  else fs.symlinkSync(target, candidate);
  const allocate = vi.fn(async () => undefined);
  await expect(withLocalHistoryExchange(dir, allocate)).rejects.toThrow();
  expect(allocate).not.toHaveBeenCalled();
  expect(fs.readFileSync(target, 'utf8')).toBe('leave this file alone');
});

privateIt('holds across processes and recovers only after the actual owner process exits', async () => {
  const dir = tmp();
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../dist/import/LocalHistoryExchange.js')).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { withLocalHistoryExchange } from ${JSON.stringify(moduleUrl)};
    await withLocalHistoryExchange(process.argv[1], async () => {
      process.send('held');
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    });
  `, dir], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: process.env.PATH } });
  const exited = once(child, 'exit');
  try {
    const [ready] = await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('exchange child exited before admission'); })]);
    expect(ready).toBe('held');
    const allocate = vi.fn(async () => undefined);
    expect(await withLocalHistoryExchange(dir, allocate)).toEqual({ accepted: false });
    expect(allocate).not.toHaveBeenCalled();
    child.kill('SIGKILL');
    await exited;
    expect(await withLocalHistoryExchange(dir, async () => 'recovered')).toEqual({ accepted: true, value: 'recovered' });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});
