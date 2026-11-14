import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { OriginConfigReader } from '../../src/messaging/telegram-origin/OriginConfigReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
}, 30_000);

async function boot() {
  const root = await mkdtemp('/tmp/origin-config-read-');
  cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-config-read:cleanup' }); });
  const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
  const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
    messaging: [{ type: 'telegram', enabled: true, config: { token: '123:read-fixture', chatId: '-100123', lifelineTopicId: 7848 } }] };
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
  const started = await bootTelegramOrigin({ config: config as never, token: '123:read-fixture', noticeOwner: true, workerUrl: worker,
    holdsLease: () => true, isSessionLive: () => true, attachSessionLifecycle: () => undefined,
    diagnoseUnknown: vi.fn(async () => undefined), onNoticeState: vi.fn() });
  cleanup.push(() => started.close());
  const authorize = () => started.runtime.service.options.authorize({ accountId: '123', destination: { chatId: '-100123' } } as never);
  await vi.waitFor(async () => expect(await authorize()).toBe(true), { timeout: 20_000, interval: 100 });
  return { authorize };
}

describe('a config read that fails, on the production boot path', () => {
  it('keeps sending through a read that only ran out of time', async () => {
    const { authorize } = await boot();
    const read = vi.spyOn(OriginConfigReader.prototype, 'read').mockRejectedValue(new Error('origin-config-reader-timeout'));
    await vi.waitFor(() => expect(read).toHaveBeenCalled(), { timeout: 15_000, interval: 50 });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await authorize()).toBe(true);
  }, 60_000);
  it('stops sending at once when the source refuses', async () => {
    const { authorize } = await boot();
    const read = vi.spyOn(OriginConfigReader.prototype, 'read').mockRejectedValue(new Error('origin-config-size'));
    await vi.waitFor(() => expect(read).toHaveBeenCalled(), { timeout: 15_000, interval: 50 });
    // "At once" means without waiting out the 30 second bound on a kept snapshot (the next test),
    // not within two seconds of wall time: on a loaded machine one authorize() round trip can
    // itself take longer than that, and this test failed two unrelated changes on it
    // (2026-11-13 19:42Z and 2026-11-14 05:52Z). 20 s stays well inside the 30 s bound.
    await vi.waitFor(async () => expect(await authorize()).toBe(false), { timeout: 20_000, interval: 50 });
  }, 60_000);
  it('stops sending once the kept snapshot passes its 30 second bound', async () => {
    const { authorize } = await boot();
    vi.spyOn(OriginConfigReader.prototype, 'read').mockRejectedValue(new Error('origin-config-reader-timeout'));
    await vi.waitFor(async () => expect(await authorize()).toBe(false), { timeout: 45_000, interval: 500 });
  }, 90_000);
});
