import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramOriginRuntime } from '../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { telegramFetch } from '../../src/messaging/telegram-egress.js';
import { DegradationReporter } from '../../src/monitoring/DegradationReporter.js';
import { compileStallableOriginWorker, temporaryState } from '../helpers/telegramOriginStore.js';

// Incident 2026-09-26: after a reboot one slow origin-store request latched the
// worker dead and every reply held with execution-admission-unavailable until a
// manual server restart. The reply path must hold during the stall and deliver
// again once the worker recovers — same process, same runtime, same store.
let worker: URL;
const runtimes: TelegramOriginRuntime[] = [];
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
beforeAll(async () => { worker = await compileStallableOriginWorker(); });
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function harness() {
  const stateDir = temporaryState(), botToken = `123:${randomUUID()}`;
  let lifecycle: OriginSessionLifecycle | undefined;
  const network = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 27, chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
  });
  vi.stubGlobal('fetch', network);
  const runtime = await TelegramOriginRuntime.open({
    storage: { stateDir, agentId: 'echo', requestTimeoutMs: 200, stallTimeoutMs: 800, restart: { baseDelayMs: 50, maxDelayMs: 200, maxAttempts: 3, healthyWindowMs: 1 } },
    workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
    signingKey: { privateKey, keyId: 'studio-1', keyEpoch: 1 }, bot: { token: botToken, accountId: 'bot-1', chatId: '-100123' },
    isSessionLive: () => true, attachSessionLifecycle: l => { lifecycle = l; }, display: () => ({}),
    authorize: () => true, diagnoseUnknown: async () => undefined, alertDestinations: () => [],
    getAlertPolicy: () => null, onNoticeState: () => undefined,
  });
  runtimes.push(runtime);
  const sessionToken = await lifecycle!.issue({ sessionId: 'source-session', harnessId: 'codex-cli',
    projectDir: process.cwd(), configuredModel: 'gpt-6-astra' });
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer agent-test') { res.sendStatus(401); return; } next(); });
  app.use(createRoutes({ config: { authToken: 'agent-test', stateDir, port: 0, projectName: 'echo',
    messaging: [{ type: 'telegram', enabled: true, config: { token: botToken, chatId: '-100123', lifelineTopicId: 7848 } }] },
    telegramOrigin: runtime, verifyDashboardOperatorSession: (proof: string) => proof === 'operator-test',
    telegram: { sendToTopic: async (topicId: number, text: string) => {
      const response = await telegramFetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100123', message_thread_id: topicId, text }),
      });
      const json = await response.json() as { result: { message_id: number } };
      return { messageId: json.result.message_id, timestamp: new Date().toISOString() };
    } }, sessionManager: { clearInjectionTracker: () => undefined },
  } as never));
  const reply = (text: string) => request(app).post('/telegram/reply/42')
    .set('Authorization', 'Bearer agent-test').set('X-Instar-Origin-Session', sessionToken).send({ text });
  return { app, runtime, network, stateDir, reply };
}

describe('Telegram reply path across an origin worker stall', () => {
  it('holds during the stall and delivers again after automatic recovery, with no server restart', async () => {
    const report = vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined);
    const h = await harness();
    const store = h.runtime.store;
    expect((await h.reply('Before the stall.')).status).toBe(200);
    expect(h.network).toHaveBeenCalledTimes(1);

    fs.writeFileSync(path.join(h.stateDir, 'origin-worker-stall-ms'), '60000');
    const held = await h.reply('During the stall.');
    expect(held.status).toBe(409);
    expect(held.body).toMatchObject({ error: 'telegram-origin-held', retryable: false });
    // Fail-closed: nothing reached Telegram while the worker was stuck.
    expect(h.network).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(store.health()).toMatchObject({ state: 'ready', generation: 2 }), { timeout: 5000 });
    // The same store object recovered in place — no runtime reopen, no process restart.
    expect(h.runtime.store).toBe(store);

    const after = await h.reply('After recovery.');
    expect(after.status).toBe(200);
    expect(h.network).toHaveBeenCalledTimes(2);
    expect(JSON.parse(h.network.mock.calls[1][1].body as string).text).toContain('After recovery.');

    const status = await request(h.app).get('/telegram/origins/status')
      .set('Authorization', 'Bearer agent-test').set('X-Instar-Operator-Session', 'operator-test');
    expect(status.status).toBe(200);
    expect(status.body.storage.store).toMatchObject({ state: 'ready', restarts: 1, downSince: null });
    expect(status.body.storage.store.lastFailure.reason).toMatch(/^request-stalled/);
    expect(report.mock.calls.filter(([event]) => event.feature === 'telegram-origin.store-worker')).toHaveLength(1);
  });

  it('the recovery tick replaces only a store that has given up, never one mid-restart', async () => {
    vi.spyOn(DegradationReporter.getInstance(), 'report').mockImplementation(() => undefined);
    const h = await harness();
    const store = h.runtime.store;
    vi.spyOn(store, 'health').mockReturnValue({ ...store.health(), state: 'restarting' });
    vi.spyOn(store, 'needsReplacement').mockReturnValue(false);
    await h.runtime.recoverHeld();
    expect(h.runtime.store).toBe(store);
    vi.spyOn(store, 'needsReplacement').mockReturnValue(true);
    await h.runtime.recoverHeld();
    expect(h.runtime.store).not.toBe(store);
    expect(h.runtime.store.isUnavailable()).toBe(false);
    await store.close();
  });
});
