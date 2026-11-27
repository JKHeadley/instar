/**
 * A held formatted reply survives the production origin boot/restart path.
 * Only the remote Bot API, tone verdict and send-policy verdict are fixtures;
 * the adapter, AgentServer routes, config observers, capacity refusal proof,
 * durable origin store, recovery and App history projection remain real.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { recordRecoveredSessionDelivery } from '../../src/messaging/telegram-origin/SessionDeliveryReporter.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import { allowSlowOriginRecording, compileOriginConfigWorker, compileOriginWorker } from '../helpers/telegramOriginStore.js';
import { waitForOriginDisplayReady } from '../helpers/telegramOriginReady.js';

let worker: URL, configWorker: URL;
beforeAll(async () => {
  worker = await compileOriginWorker();
  configWorker = await compileOriginConfigWorker();
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}, 30_000);

describe('held Telegram formatting across the production lifecycle', () => {
  it('retries the sealed Telegram HTML after restart and exposes original Markdown once through the App history route', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'telegram-held-format-'));
    cleanup.push(() => SafeFsExecutor.safeRm(root, { recursive: true, force: true,
      operation: 'test:telegram-held-format-lifecycle:cleanup' }));
    const stateDir = path.join(root, '.instar');
    await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const token = '123:held-format-lifecycle-fixture';
    const telegramConfig = { token, chatId: '-100123', lifelineTopicId: 7848 };
    const config = { projectName: 'held-format-lifecycle', projectDir: root, stateDir,
      port: 0, authToken: 'held-format-auth', dashboardPin: '654321',
      messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });

    const network = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`https://api.telegram.org/bot${token}/sendMessage`);
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({ chat_id: '-100123', message_thread_id: 42, parse_mode: 'HTML' });
      expect(body.text).toContain('<i>read</i>');
      expect(body.text).toMatch(/<b>(?:&quot;|")approve GitHub reads(?:&quot;|")<\/b>/);
      return new Response(JSON.stringify({ ok: true,
        result: { message_id: 147438, chat: { id: -100123 }, message_thread_id: 42 } }));
    });
    // App requests use supertest, so this stub can only stand in for Telegram.
    vi.stubGlobal('fetch', network);

    const start = async () => {
      const telegram = new TelegramAdapter(telegramConfig, stateDir, { suppressLifelineAutoCreate: true });
      const boot = await bootTelegramOrigin({ config: config as never, token,
        workerUrl: worker, configWorkerUrl: configWorker, noticeOwner: true,
        holdsLease: () => true, isSessionLive: () => false,
        attachSessionLifecycle: () => undefined, diagnoseUnknown: async () => undefined,
        onNoticeState: () => undefined,
        // Same callback and recorder used by startServer; no fake history write.
        onRecoveredMessage: entry => recordRecoveredSessionDelivery(entry, telegram) });
      allowSlowOriginRecording(boot.runtime.service);
      boot.runtime.attachSendPolicy({ review: async () => ({ ok: true }),
        authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) });
      const server = new AgentServer({ config: config as never, state: new StateManager(stateDir),
        sessionManager: createMockSessionManager() as never, telegram, telegramOrigin: boot.runtime,
        messagingToneGate: { review: async () => ({ pass: true, latencyMs: 0 }) } as never });
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        try { await server.stop(); }
        finally { try { await telegram.stop(); } finally { await boot.close(); } }
      };
      cleanup.push(close);
      await waitForOriginDisplayReady(boot.runtime, { chatId: '-100123', topicId: '42' });
      await vi.waitFor(async () => expect(await boot.runtime.service.options.authorize({
        accountId: '123', destination: { chatId: '-100123' },
      } as never)).toBe(true), { timeout: 20_000, interval: 100 });
      return { boot, telegram, server, close };
    };
    let running = await start();
    const auth = (test: request.Test) => test.set('Authorization', 'Bearer held-format-auth')
      .set('X-Instar-AgentId', 'held-format-lifecycle');
    const text = 'The GitHub *read* action is ready. Reply **"approve GitHub reads"**.';
    const body = { text };
    running.boot.runtime.service.registerAutomationProducer('held-format-lifecycle');
    const automation = running.boot.runtime.service.issueAutomationReply('held-format-lifecycle', 42, body);
    const capacity = vi.spyOn(running.boot.runtime.service.options.capacity!, 'reserveExplained')
      .mockResolvedValueOnce({ grant: null, refusal: { cause: 'rate-window-full', leaseFreshness: null } });
    const held = await auth(request(running.server.getApp()).post('/telegram/reply/42'))
      .set('X-Instar-Origin-Automation', automation).send(body);
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({ reason: 'credential-capacity-unavailable' });
    expect(network).not.toHaveBeenCalled();
    capacity.mockRestore();
    const original = (await running.boot.runtime.store.listOrigins()).records[0];
    expect(original).toBeDefined();
    expect(original.children[0]).toMatchObject({ state: 'queued', attempts: 0 });
    const refusal = original.attempts.find(attempt => attempt.reason === 'credential-capacity-unavailable');
    expect(refusal).toMatchObject({ outcome: 'known-failed' });
    expect(Number.isSafeInteger(refusal?.nextAttemptAt)).toBe(true);
    const operationId = original.operation!.operationId;
    const before = await auth(request(running.server.getApp()).get('/telegram/topics/42/messages'));
    expect(before.status).toBe(200);
    expect(before.body.messages).toEqual([]);

    await running.close();
    running = await start();
    const restored = await running.boot.runtime.store.getOperation(operationId);
    expect(restored?.record.originId).toBe(original.record.originId);
    expect(restored?.operation?.deadlineAt).toBe(original.operation?.deadlineAt);
    expect(restored?.attempts).toEqual(original.attempts);
    // Respect the actual persisted local-refusal pacing across restart. No
    // fake wall clock, direct store rewrite or recovery-budget override.
    const waitMs = Math.max(0, refusal!.nextAttemptAt! - Date.now() + 10);
    expect(waitMs).toBeLessThanOrEqual(31_000);
    if (waitMs) await delay(waitMs);
    await waitForOriginDisplayReady(running.boot.runtime, { chatId: '-100123', topicId: '42' });
    expect(await running.boot.runtime.recoverHeld()).toEqual({ processed: 1, recovered: 1 });
    expect(network).toHaveBeenCalledOnce();
    const after = await auth(request(running.server.getApp()).get('/telegram/topics/42/messages'));
    expect(after.status).toBe(200);
    expect(after.body.messages).toHaveLength(1);
    expect(after.body.messages[0]).toMatchObject({ messageId: 147438, text, fromUser: false, provenance: 'automation' });
    expect(after.body.messages[0].text).not.toMatch(/<\/?(?:i|b)>/);
    expect((await running.boot.runtime.store.getOperation(operationId))?.operation?.state).toBe('accepted');

    expect(await running.boot.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    const repeated = await auth(request(running.server.getApp()).get('/telegram/topics/42/messages'));
    expect(repeated.status).toBe(200);
    expect(repeated.body.messages).toHaveLength(1);
    expect(repeated.body.messages[0].text).toBe(text);
    expect(network).toHaveBeenCalledOnce();
  }, 180_000);
});
