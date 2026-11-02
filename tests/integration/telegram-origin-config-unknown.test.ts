/**
 * A standby whose config read fails (Mama PC 2026-11-02: a starved event loop
 * pushed the reader past its 2 s deadline) must refuse an issues-group send as
 * "config could not be read" (retryable, before anything is sent), never as
 * "this process has no issuesChatId", and must route normally once reads recover.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { OriginConfigUnavailableError } from '../../src/messaging/telegram-origin/types.js';
import { migrateSecrets } from '../../src/core/SecretMigrator.js';
import { compileOriginWorker, compileOriginConfigWorker, temporaryState } from '../helpers/telegramOriginStore.js';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { isPreDispatchRefusal } from '../../src/messaging/telegram-origin/OriginLegacy.js';

let worker: URL, configWorker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); configWorker = await compileOriginConfigWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); }, 30_000);

const ISSUES_TOPIC = 10_000_000_005;
async function waitFor<T>(probe: () => T | undefined, timeoutMs = 45_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

describe('telegram origin: unreadable config is unknown, not missing', () => {
  it('refuses issues-group sends with a retryable config-unavailable reason, then recovers', async () => {
    const stateDir = temporaryState(); await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const config = { projectDir: stateDir, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
      messaging: [{ type: 'telegram', enabled: true, config: { token: '123:standby', chatId: '-100123', issuesChatId: '-100999' } }] };
    const configPath = path.join(stateDir, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    migrateSecrets(configPath, stateDir);
    const goodBytes = (await import('node:fs')).readFileSync(configPath, 'utf8');
    const boot = await bootTelegramOrigin({ config: config as never, token: '123:standby', noticeOwner: false,
      workerUrl: worker, configWorkerUrl: configWorker, holdsLease: () => false, isSessionLive: () => true,
      diagnoseUnknown: async () => undefined, onNoticeState: () => undefined, skipRetention: true } as never);
    cleanup.push(() => boot.close());
    const options = boot.runtime.service.options;
    const send = () => options.wireParams!({ chat_id: '-100123', message_thread_id: ISSUES_TOPIC, text: 'hello' });

    // Healthy read: translated into the issues group's own thread.
    expect(send()).toMatchObject({ chat_id: '-100999', message_thread_id: 5 });

    // The config becomes unreadable (a failed read, as a timed-out one does).
    await writeFile(configPath, '{ not json');
    const refusal = await waitFor(() => { try { send(); return undefined; } catch (error) { return error; } });
    expect((refusal as Error).message).not.toMatch(/issues-chat-not-configured/);
    expect(refusal).toBeInstanceOf(OriginConfigUnavailableError);
    expect((refusal as OriginConfigUnavailableError).reason).toBe('origin-config-unparseable');
    expect(() => options.display({ accountId: '123', chatId: '-100999', topicId: '5' })).toThrow(OriginConfigUnavailableError);

    // Through the real reply route: a retryable 503 whose exact body the
    // recovery import accepts as proof that nothing was sent.
    const app = express(); app.use(express.json());
    app.use(createRoutes({ config, telegramOrigin: boot.runtime, sessionManager: { clearInjectionTracker: () => undefined },
      telegram: { sendToTopic: async () => { throw new Error('must not send while config is unreadable'); } } } as never));
    const response = await request(app).post(`/telegram/reply/${ISSUES_TOPIC}`).send({ text: 'A note for the bug topic.' });
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: 'origin-config-unavailable', reason: 'origin-config-unparseable', retryable: true });
    expect(isPreDispatchRefusal(response.status, response.text)).toBe(true);

    // Reads recover: the same send routes again, still never to the main group.
    await writeFile(configPath, goodBytes);
    const routed = await waitFor(() => { try { return send(); } catch { return undefined; } });
    expect(routed).toMatchObject({ chat_id: '-100999', message_thread_id: 5 });
  }, 150_000);
});
