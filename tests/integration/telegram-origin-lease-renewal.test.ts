import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { createRoutes } from '../../src/server/routes.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { originLeaseDependencyFixture } from '../helpers/originLeaseDependency.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('HTTP origin sends depend on the real renewed lease', () => {
  it.each([undefined, false])('preserves lease authority beyond 60s with renewal flag %s', async enabled => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const clock = { value: Date.now() }, lease = await originLeaseDependencyFixture({ enabled, clock });
    cleanup.push(lease.close);
    const telegramConfig = { token: '123:lease-http-fixture', chatId: '-100123', messageOrigin: { display: { enabled: false } } };
    const config = { projectDir: lease.root, stateDir: lease.stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
      messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
    await writeFile(path.join(lease.stateDir, 'config.json'), JSON.stringify(config));
    let lifecycle: OriginSessionLifecycle | undefined;
    const boot = await bootTelegramOrigin({ config: config as never, token: telegramConfig.token, workerUrl: worker,
      noticeOwner: true, holdsLease: () => lease.coordinator.holdsLease(), isSessionLive: () => true,
      attachSessionLifecycle: value => { lifecycle = value; }, diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
    cleanup.push(() => boot.close());
    const token = await lifecycle!.issue({ sessionId: 'session', harnessId: 'codex-cli', projectDir: lease.root, configuredModel: 'fixture-model' });
    const telegram = new TelegramAdapter(telegramConfig, lease.stateDir, { suppressLifelineAutoCreate: true });
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer fixture-auth') { res.sendStatus(401); return; } next(); });
    app.use(createRoutes({ config, telegramOrigin: boot.runtime, telegram, sessionManager: { clearInjectionTracker: () => undefined } } as never));
    // Boot/session setup writes machine evidence watched by the independent
    // config authority. Let its real refresh settle before advancing only the
    // lease clock; otherwise that unrelated startup invalidation masks the
    // decision boundary this HTTP test is exercising.
    await new Promise(resolve => setTimeout(resolve, 5500));
    expect(boot.runtime.options.display({ chatId: '-100123', topicId: '42' } as never).agent?.enabled).toBe(false);
    const wire = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 10, chat: { id: -100123 }, message_thread_id: 42 } })));
    vi.stubGlobal('fetch', wire);
    for (const step of [30_000, 30_000, 10_000]) { clock.value += step; await vi.advanceTimersByTimeAsync(step); }
    const response = await request(app).post('/telegram/reply/42').set('Authorization', 'Bearer fixture-auth')
      .set('X-Instar-Origin-Session', token).send({ text: 'The result remains governed by the actual serving lease.' });
    if (enabled === false) {
      expect(lease.coordinator.holdsLease()).toBe(false); expect(response.status, JSON.stringify(response.body)).toBe(409); expect(wire).not.toHaveBeenCalled();
      const held = (await boot.runtime.store.listOrigins()).records;
      expect(held).toHaveLength(1); expect(held[0].operation?.state).not.toBe('accepted');
      expect(held[0].attempts.some(attempt => attempt.phase === 'dispatched')).toBe(false);
    } else {
      expect(lease.coordinator.holdsLease()).toBe(true); expect(response.status, JSON.stringify(response.body)).toBe(200); expect(wire).toHaveBeenCalledOnce();
      expect(lease.lc.currentEpoch()).toBe(1);
      expect((await boot.runtime.store.listOrigins()).records[0].operation?.state).toBe('accepted');
    }
  });
});
