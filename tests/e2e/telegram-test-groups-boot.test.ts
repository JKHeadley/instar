// docs/specs/telegram-test-groups.md — the production boot path. The broker only sees
// what the boot driver wrapper forwards, so this drives the real bootTelegramOrigin with
// a fake Web K page layer injected through the webKDriverFactory seam, and the real routes.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import type { TelegramWebKDriver } from '../../src/messaging/telegram-origin/TelegramWebKDriver.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 30_000);
const ACCOUNT = '7812716706';
const BOT = { username: 'instar_pr2760_livetest_bot', userId: '8000000001' };

async function boot(withGrant: boolean) {
  const root = await mkdtemp('/tmp/tg-test-groups-boot-');
  cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:tg-test-groups-boot:cleanup' }); });
  const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
  const userDataDir = path.join(root, 'browser-profiles', 'operator-telegram'); await mkdir(userDataDir, { recursive: true });
  const build = { buildId: 'fixture', criticalAssets: ['a-1.js', 'b-1.js', 'c-1.js'],
    assetDigests: { 'a-1.js': '1'.repeat(64), 'b-1.js': '2'.repeat(64), 'c-1.js': '3'.repeat(64) } };
  await writeFile(path.join(stateDir, 'state', 'playwright-profiles.json'), JSON.stringify({ version: 1, profiles: [{
    id: 'operator-telegram', userDataDir, description: 'operator Telegram', isDefault: false, createdAt: new Date().toISOString(),
    accounts: [{ service: 'telegram', identity: 'operator', owner: 'operator' }], executionOwner: 'telegram-origin-broker',
    telegramBroker: { accountId: ACCOUNT, accountNumber: 1, executablePath: '/fixture/chrome', supportedBuilds: [build],
      exclusiveEnrollment: { version: 1, checkedAt: Date.now(), retiredPids: [], proofDigest: 'a'.repeat(64) } } }] }));
  const messageOrigin = withGrant ? { testGroups: { profileId: 'operator-telegram', accountId: ACCOUNT, bots: [BOT],
    decisionRef: '[source: telegram 134088/123456 2026-11-08]', expiresAt: new Date(Date.now() + 86_400_000).toISOString() } } : undefined;
  const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
    messaging: [{ type: 'telegram', enabled: true, config: { token: '123:boot-fixture', chatId: '-100123', lifelineTopicId: 7848,
      ...(messageOrigin ? { messageOrigin } : {}) } }] };
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
  await writeFile(path.join(stateDir, 'identity.json'), JSON.stringify({ privateKey: Buffer.alloc(32, 1).toString('base64'), publicKey: Buffer.alloc(32, 2).toString('base64') }));
  const chats = new Map<string, string>();
  const page = {
    canary: vi.fn(async () => ({ transport: 'web-k' as const, buildId: 'fixture', accountId: ACCOUNT, supported: true })),
    readSnapshot: async () => ({ text: '', accountId: ACCOUNT }), resolvePeer: async () => ({}), invoke: async () => null,
    close: async () => undefined,
    listTestGroups: vi.fn(async (input: { channelId?: string }) => ({ ok: true, complete: true,
      groups: [...chats].map(([channelId, title]) => ({ channelId, title, date: Math.floor(Date.now() / 1000) })),
      ...(input.channelId ? { requested: { present: chats.has(input.channelId) } } : {}) })),
    createTestGroup: vi.fn(async (input: { title: string }) => { chats.set('4242', input.title); return { ok: true, channelId: '4242' }; }),
    deleteTestGroup: vi.fn(async (input: { channelId: string }) => { chats.delete(input.channelId); return { ok: true, outcome: 'deleted' }; }),
  };
  let lifecycle: OriginSessionLifecycle | undefined;
  const booted = await bootTelegramOrigin({ config: config as never, token: '123:boot-fixture', noticeOwner: true, workerUrl: worker,
    holdsLease: () => true, isSessionLive: () => true, attachSessionLifecycle: value => { lifecycle = value; },
    diagnoseUnknown: vi.fn(async () => undefined), onNoticeState: vi.fn(),
    webKDriverFactory: () => page as unknown as TelegramWebKDriver });
  cleanup.push(() => booted.close());
  const token = await lifecycle!.issue({ sessionId: 'proof-session', harnessId: 'claude-code', projectDir: root, configuredModel: 'claude-opus-5-5' });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer agent-test') { res.sendStatus(401); return; } next(); });
  app.use(createRoutes({ state: { getSession: () => undefined }, config: { ...config, authToken: 'agent-test' },
    telegramOrigin: booted.runtime, sessionManager: { clearInjectionTracker: () => undefined } } as never));
  const call = (method: 'get' | 'post', url: string) => request(app)[method](url).set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', token);
  return { booted, page, call, chats };
}

describe('Telegram test groups on the production boot path', () => {
  it('wires a test-groups capability whose broker reaches the page methods through the boot wrapper', async () => {
    const h = await boot(true);
    const entry = h.booted.runtime.browsers.get('operator-telegram');
    expect(entry?.testGroups).toBeDefined();
    // The config snapshot is read asynchronously after boot; wait until the grant is live.
    await vi.waitFor(async () => {
      const created = await h.call('post', '/telegram/browser/operator-telegram/test-groups').send({ title: 'Instar test - boot proof', bot: BOT.username });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ channelId: '4242', chatId: '-1004242' });
    }, { timeout: 20_000, interval: 6000 });
    expect(h.page.createTestGroup).toHaveBeenCalledOnce();
    expect(typeof h.page.canary.mock.calls[0]?.[0]).toBe('number');
    await new Promise(resolve => setTimeout(resolve, 5100));
    const deleted = await h.call('post', '/telegram/browser/operator-telegram/test-groups/4242/delete').send({});
    expect(deleted.body).toEqual({ channelId: '4242', state: 'deleted' });
    expect(h.page.deleteTestGroup).toHaveBeenCalledOnce();
  }, 60_000);
  it('without a grant, create is refused while list still answers', async () => {
    const h = await boot(false);
    await vi.waitFor(async () => {
      const listed = await h.call('get', '/telegram/browser/operator-telegram/test-groups');
      expect(listed.status).toBe(200);
    }, { timeout: 20_000, interval: 6000 });
    const created = await h.call('post', '/telegram/browser/operator-telegram/test-groups').send({ title: 'Instar test - no grant', bot: BOT.username });
    expect(created.status).toBe(403);
    expect(h.page.createTestGroup).not.toHaveBeenCalled();
  }, 60_000);
});
