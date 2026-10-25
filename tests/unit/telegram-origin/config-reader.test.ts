import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OriginConfigReader } from '../../../src/messaging/telegram-origin/OriginConfigReader.js';
import { migrateSecrets } from '../../../src/core/SecretMigrator.js';
import { compileOriginConfigWorker, temporaryState } from '../../helpers/telegramOriginStore.js';

const control = vi.hoisted(() => ({ path: '', release: null as (() => void) | null, started: 0, workers: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(async (...args: Parameters<typeof stat>) => {
    if (String(args[0]) === control.path) {
      control.started++;
      if (control.started === 1) await new Promise<void>(resolve => { control.release = resolve; });
    }
    return (actual.stat as any)(...args);
  }) };
});
vi.mock('node:worker_threads', async importOriginal => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(...args: ConstructorParameters<typeof actual.Worker>) { control.workers++; super(...args); }
  } };
});
let worker: URL;
beforeAll(async () => { worker = await compileOriginConfigWorker(); });
const readers: OriginConfigReader[] = [];
afterEach(() => { control.release?.(); for (const reader of readers.splice(0)) reader.close(); control.path = ''; });
describe('config reader owns actual source work beyond caller timeout', () => {
  it('fences a late stat, starts no late vault worker, and admits a fresh read only after that source settles', async () => {
    const stateDir = temporaryState(); await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const filename = path.join(stateDir, 'config.json');
    await writeFile(filename, JSON.stringify({ messaging: [{ type: 'telegram', enabled: true,
      config: { token: '123:fixture', chatId: '-100123' } }] }));
    migrateSecrets(filename, stateDir);
    control.path = filename; control.started = 0; control.workers = 0;
    const reader = new OriginConfigReader(stateDir, worker); readers.push(reader);
    const first = reader.read();
    await expect(first).rejects.toThrow('origin-config-reader-timeout');
    const retryWhileBlocked = reader.read(); expect(retryWhileBlocked).toBe(first);
    await expect(retryWhileBlocked).rejects.toThrow('origin-config-reader-timeout');
    expect(control.started).toBe(1); expect(control.workers).toBe(0);
    control.release!();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(control.workers).toBe(0);
    const next = await reader.read();
    expect(next.config.messaging[0].config.chatId).toBe('-100123');
    expect(control.started).toBe(2); expect(control.workers).toBe(1);
  });
});
