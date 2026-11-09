import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { OriginConfigReader } from '../../../src/messaging/telegram-origin/OriginConfigReader.js';
import { migrateSecrets } from '../../../src/core/SecretMigrator.js';
import { compileOriginConfigWorker, temporaryState } from '../../helpers/telegramOriginStore.js';

const control = vi.hoisted(() => ({ path: '', release: null as (() => void) | null, started: 0, reads: 0, workers: 0 }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(async (...args: Parameters<typeof readFile>) => {
    if (String(args[0]) === control.path) control.reads++;
    return (actual.readFile as any)(...args);
  }), stat: vi.fn(async (...args: Parameters<typeof stat>) => {
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
// The timed-out reads below are forced by the blocked stat, not by the clock, so the budget only
// needs to be long enough for a read that should succeed, worker start included, on a loaded host.
const BUDGET_MS = 2_000;
const readers: OriginConfigReader[] = [];
afterEach(() => { control.release?.(); for (const reader of readers.splice(0)) reader.close(); control.path = ''; });
describe('config reader owns actual source work beyond caller timeout', () => {
  it('fences a late stat, starts no late vault worker, and admits a fresh read only after that source settles', async () => {
    const stateDir = temporaryState(); await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const filename = path.join(stateDir, 'config.json');
    await writeFile(filename, JSON.stringify({ messaging: [{ type: 'telegram', enabled: true,
      config: { token: '123:fixture', chatId: '-100123' } }] }));
    migrateSecrets(filename, stateDir);
    control.path = filename; control.started = 0; control.reads = 0; control.workers = 0;
    const reader = new OriginConfigReader(stateDir, worker, BUDGET_MS); readers.push(reader);
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
    // The source poller also stats config.json on its own cadence, so stat
    // counts vary with host scheduling. A single byte read proves one fresh
    // source attempt made it past the cancelled stat.
    expect(control.reads).toBe(1); expect(control.workers).toBe(1);
  }, 15_000);
  it('gives a read 10 seconds by default, so a saturated host is not read as a config failure', () => {
    const reader = new OriginConfigReader(temporaryState(), worker); readers.push(reader);
    expect(reader.readBudgetMs).toBe(10_000);
  });
  it('keeps the revision through a timed-out read and revokes on a real refusal', async () => {
    const stateDir = temporaryState(); await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const filename = path.join(stateDir, 'config.json');
    await writeFile(filename, JSON.stringify({ messaging: [] }));
    const reader = new OriginConfigReader(stateDir, worker, BUDGET_MS); readers.push(reader);
    const invalidated = vi.fn(); reader.onInvalidated(invalidated);
    const good = await reader.read();
    await new Promise(resolve => setTimeout(resolve, 30));
    // The read stalls past its budget: nothing was learned about the source.
    control.path = filename; control.started = 0;
    await expect(reader.read()).rejects.toThrow('origin-config-reader-timeout');
    expect(reader.revision).toBe(good.revision);
    expect(invalidated).not.toHaveBeenCalled();
    control.release!(); control.path = '';
    await new Promise(resolve => setTimeout(resolve, 30));
    expect((await reader.read()).config.messaging).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 30));
    // A source that cannot be parsed is a real refusal and revokes at once.
    await writeFile(filename, '{ not json');
    await expect(reader.read()).rejects.toThrow();
    expect(reader.revision).toBeGreaterThan(good.revision);
    expect(invalidated).toHaveBeenCalled();
  }, 15_000);
});
