import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { RECORDING_OUTAGE_TEXT } from '../../src/messaging/telegram-origin/TelegramOriginOutageNotifier.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { telegramFetch } from '../../src/messaging/telegram-egress.js';
import { migrateSecrets } from '../../src/core/SecretMigrator.js';
import { compileOriginWorker, compileOriginConfigWorker, temporaryState } from '../helpers/telegramOriginStore.js';
import { waitForOriginDisplayReady } from '../helpers/telegramOriginReady.js';

let worker: URL, configWorker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); configWorker = await compileOriginConfigWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
async function harness(enabled: boolean) {
  const stateDir = temporaryState(); await mkdir(path.join(stateDir, 'state'), { recursive: true });
  const config = { projectDir: stateDir, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
    messaging: [{ type: 'telegram', enabled: true, config: { token: '123:notice-http', chatId: '-100123',
      messageOrigin: { outageNotice: { enabled } } } }] };
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
  await writeFile(path.join(stateDir, 'state/agent-attention-topic.json'), '7848');
  migrateSecrets(path.join(stateDir, 'config.json'), stateDir);
  let lifecycle: OriginSessionLifecycle | undefined;
  const boot = await bootTelegramOrigin({ config: config as never, token: '123:notice-http', noticeOwner: true,
    workerUrl: worker, configWorkerUrl: configWorker, holdsLease: () => true, isSessionLive: () => true, attachSessionLifecycle: value => { lifecycle = value; },
    diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
  let stopped = false;
  cleanup.push(async () => { if (stopped) await expect(boot.close()).rejects.toMatchObject({ code: 'origin-store-unavailable' }); else await boot.close(); });
  const token = await lifecycle!.issue({ sessionId: 'fixture-session', harnessId: 'codex-cli', projectDir: stateDir, configuredModel: 'configured-model' });
  const network = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    expect(body.text).toContain(RECORDING_OUTAGE_TEXT); expect(String(body.message_thread_id)).toBe('7848');
    return new Response(JSON.stringify({ ok: true, result: { message_id: 31, chat: { id: -100123 }, message_thread_id: 7848 } }));
  });
  vi.stubGlobal('fetch', network);
  const app = express(); app.use(express.json());
  app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer fixture-auth') { res.sendStatus(401); return; } next(); });
  app.use(createRoutes({ config, telegramOrigin: boot.runtime, sessionManager: { clearInjectionTracker: () => undefined },
    telegram: { sendToTopic: async (topic: number, text: string) => {
      const response = await telegramFetch('https://api.telegram.org/bot123:notice-http/sendMessage', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100123', message_thread_id: topic, text }) });
      return { messageId: ((await response.json()) as any).result.message_id, timestamp: new Date().toISOString() };
    } } } as never));
  await waitForOriginDisplayReady(boot.runtime, { chatId: '-100123', topicId: '42' });
  await vi.waitFor(() => {
    expect(boot.runtime.options.getAlertPolicy('operator-attention-hub')).toMatchObject({ authorized: true, optedOut: !enabled });
    if (enabled) expect(boot.runtime.notifier.getState('operator-attention-hub').notificationOutcome).toBe('reserved');
  }, { timeout: 12_500, interval: 50 });
  const failRecording = async () => { await boot.runtime.store.close(); await boot.runtime.spool.close(); stopped = true; };
  const send = () => request(app).post('/telegram/reply/42').set('Authorization', 'Bearer fixture-auth')
    .set('X-Instar-Origin-Session', token).send({ text: 'This ordinary answer must remain held while recording is unavailable.',
      metadata: { outageNotice: { enabled: true }, alertDestinationId: 'attacker-selected-hub' } });
  return { ...boot, app, send, network, failRecording };
}
describe('outage notification through authenticated reply HTTP', () => {
  it('holds the original HTTP reply and sends only the recorded notice to the configured operator hub', async () => {
    const h = await harness(true); await h.failRecording();
    const response = await h.send();
    expect(response.status).toBe(409); expect(response.body.reason).toBe('all-durable-recording-sinks-unavailable');
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-attention-hub')).toMatchObject({
      notificationOutcome: 'accepted', notificationAttempted: true }));
    expect(h.network).toHaveBeenCalledOnce();
  });
  it('does not let request metadata override the configured notification opt-out', async () => {
    const h = await harness(false);
    expect(h.runtime.options.getAlertPolicy('operator-attention-hub')?.optedOut).toBe(true);
    await h.failRecording(); const response = await h.send(); expect(response.status).toBe(409);
    expect(h.runtime.notifier.getState('operator-attention-hub').notificationAttempted).toBe(false);
    expect(h.network).not.toHaveBeenCalled();
  });
});
