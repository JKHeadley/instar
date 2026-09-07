import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { telegramFetch } from '../../src/messaging/telegram-egress.js';
import { postOriginAutomationReply } from '../../src/messaging/telegram-origin/OriginAutomationReply.js';
import { OriginAuthorCall } from '../../src/messaging/telegram-origin/OriginAutomationAuthor.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { admission, compileOriginWorker } from '../helpers/telegramOriginStore.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import express from 'express';
import { PendingRelayStore } from '../../src/messaging/pending-relay-store.js';
import type { AddressInfo } from 'node:net';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
describe('Telegram origin production bootstrap', () => {
  it('loads real config/identity authorities, attaches session lifecycle, and records a hidden internal reply through HTTP', async () => {
    const root = await mkdtemp('/tmp/origin-boot-');
    cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-production-boot:cleanup' }); });
    const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
      liveTest: { demo: { telegramBotToken: '456:demo-fixture', telegramChatId: '-100456' } },
      messaging: [{ type: 'telegram', enabled: true, config: { token: '123:fixture', chatId: '-100123', lifelineTopicId: 7848,
        messageOrigin: { display: { enabled: false } } } }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
    const legacyQueue = PendingRelayStore.open('echo', stateDir);
    const legacyPreparedAt = Date.now() - 7 * 60 * 60_000;
    legacyQueue.enqueue({ delivery_id: 'before-upgrade', topic_id: 42, text: 'Expired earlier answer', text_hash: 'fixture',
      attempted_at: new Date(legacyPreparedAt).toISOString(), http_code: 0 });
    legacyQueue.close();
    let lifecycle: OriginSessionLifecycle | undefined;
    const boot = await bootTelegramOrigin({ config: config as never, token: '123:fixture', noticeOwner: true,
      workerUrl: worker, holdsLease: () => true, isSessionLive: () => true,
      attachSessionLifecycle: value => { lifecycle = value; },
      diagnoseUnknown: vi.fn(async () => undefined), onNoticeState: vi.fn() });
    cleanup.push(() => boot.close());
    expect(lifecycle).toBeDefined();
    const initialStatus = await boot.runtime.status();
    expect(initialStatus.activation.complete).toBe(false);
    expect(initialStatus.activation.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ obligation: 'storage-readers', state: 'ready' }),
      expect.objectContaining({ obligation: 'bot-writers', state: 'ready' }),
      expect.objectContaining({ obligation: 'installed-scripts', state: 'held' }),
      expect.objectContaining({ obligation: 'sender-census', state: 'unknown' }),
      expect.objectContaining({ obligation: 'send-policy', state: 'held' }),
    ]));
    const imported = await boot.runtime.store.getOperation('legacy:before-upgrade');
    expect(imported?.operation).toMatchObject({ state: 'expired', preparedAt: legacyPreparedAt,
      deadlineAt: legacyPreparedAt + 6 * 60 * 60_000 });
    expect(JSON.parse(imported!.record.envelopeJson)).toMatchObject({ producerKind: 'imported-legacy', machine: { status: 'unknown' } });
    const sessionToken = await lifecycle!.issue({ sessionId: 'native-session', harnessId: 'codex-cli', projectDir: root, configuredModel: 'selected-model' });
    expect(boot.runtime.sessions.verify(sessionToken).ok).toBe(true);
    const app = express(); app.use(express.json());
    app.use((req, res, next) => { if (req.get('Authorization') !== 'Bearer fixture-auth') { res.sendStatus(401); return; } next(); });
    app.use(createRoutes({ config, telegramOrigin: boot.runtime, sessionManager: { clearInjectionTracker: () => undefined },
      telegram: { sendToTopic: async (topicId: number, text: string) => {
        const response = await telegramFetch('https://api.telegram.org/bot123:fixture/sendMessage', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100123', message_thread_id: topicId, text }) });
        return { messageId: ((await response.json()) as any).result.message_id, timestamp: new Date().toISOString() };
      } } } as never));
    // The actual route factory attaches the shared production policy; the
    // independent boot refresh must observe that attachment before readiness.
    await vi.waitFor(async () => expect((await boot.runtime.status()).activation.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ obligation: 'send-policy', state: 'ready', reason: 'send-policy-authority-attached' }),
    ])), { timeout: 7000, interval: 100 });
    const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const updateText = 'The generated update includes the completed work and the detailed verification results.';
    const nativeFetch = globalThis.fetch, wire = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.text).toBe(updateText);
      const rows = (await boot.runtime.store.listOrigins()).records.filter(item => item.operation?.operationId !== 'legacy:before-upgrade');
      expect(rows).toHaveLength(1); expect(rows[0].attempts[0].phase).toBe('dispatched');
      expect(rows[0].acceptanceVerification).toMatchObject({ verifierMachineId: boot.runtime.options.identity.originMachineId,
        keyStatusAtAcceptance: 'active', envelopeDigest: rows[0].record.envelopeDigest });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: -100123 }, message_thread_id: 77 } }));
    });
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => String(url).startsWith('https://api.telegram.org/') ? wire(url, init) : nativeFetch(url, init));
    const authorCall = new OriginAuthorCall(); authorCall.options({}).onModel!({ model: 'author-model', framework: 'codex-cli' });
    const response = await postOriginAutomationReply({ service: boot.runtime.service, port: (server.address() as AddressInfo).port,
      authToken: 'fixture-auth', producerId: 'presence-proxy', topicId: 77,
      body: { text: updateText }, author: authorCall.snapshot(), logicalSendId: 'presence:0' });
    expect(response.status).toBe(200); expect(wire).toHaveBeenCalledOnce();
    const replay = await postOriginAutomationReply({ service: boot.runtime.service, port: (server.address() as AddressInfo).port,
      authToken: 'fixture-auth', producerId: 'presence-proxy', topicId: 77,
      body: { text: updateText }, author: authorCall.snapshot(), logicalSendId: 'presence:0' });
    expect(replay.status).toBe(200); expect(wire).toHaveBeenCalledOnce();
    const row = (await boot.runtime.store.listOrigins()).records.find(item => item.operation?.operationId !== 'legacy:before-upgrade')!;
    expect(JSON.parse(row.record.envelopeJson)).toMatchObject({ model: { value: 'author-model', status: 'configured' }, display: { enabled: false } });
    expect(row.operation?.state).toBe('accepted');
    const duplicate = await postOriginAutomationReply({ service: boot.runtime.service, port: (server.address() as AddressInfo).port,
      authToken: 'fixture-auth', producerId: 'presence-proxy', topicId: 77,
      body: { text: updateText }, author: authorCall.snapshot(), logicalSendId: 'presence:1' });
    expect(duplicate.status).toBe(200); expect(await duplicate.json()).toMatchObject({ suppressedDuplicate: true });
    expect(wire).toHaveBeenCalledOnce();
    expect(boot.runtime.auditVerification(row).currentVerification).toMatchObject({ signatureValid: true,
      keyStatus: 'active', signedDuringKnownValidity: 'valid', verificationBeforeRevocation: 'not-revoked' });
    wire.mockImplementation(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (url.endsWith('/pinChatMessage')) {
        expect(body.message_id).toBe(43);
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      expect(body.text).toContain('Hey Justin, echo here');
      const records = (await boot.runtime.store.listOrigins()).records;
      const greeting = records.find(item => JSON.parse(item.record.envelopeJson).producerId === 'setup-wizard');
      expect(greeting?.attempts[0].phase).toBe('dispatched');
      expect(JSON.parse(greeting!.record.envelopeJson)).toMatchObject({
        producerKind: 'server-automation', model: { status: 'not-applicable' },
        destination: { chatId: '-100123', topicId: '7848' },
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 43, chat: { id: -100123 }, message_thread_id: 7848 } }));
    });
    const greetingResponse = await nativeFetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/telegram/setup/greeting`, {
      method: 'POST', headers: { Authorization: 'Bearer fixture-auth', 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: 'echo', userName: 'Justin', autonomy: 'proactive' }),
    });
    expect(greetingResponse.status).toBe(200);
    expect(await greetingResponse.json()).toMatchObject({ messageId: 43 });
    expect(wire).toHaveBeenCalledTimes(3);
    const normalAuthorize = boot.runtime.service.options.authorize;
    boot.runtime.service.options.authorize = () => false;
    await expect(telegramFetch('https://api.telegram.org/bot456:demo-fixture/sendMessage', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100456', message_thread_id: 44, text: 'Demo probe' }) }))
      .rejects.toMatchObject({ reason: 'destination-not-authorized' });
    expect(wire).toHaveBeenCalledTimes(3);
    boot.runtime.service.options.authorize = normalAuthorize;
    wire.mockImplementation(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.telegram.org/bot456:demo-fixture/sendMessage');
      expect(JSON.parse(init.body as string).text).toBe('Demo probe');
      return new Response(JSON.stringify({ ok: true, result: { message_id: 44, chat: { id: -100456 }, message_thread_id: 44 } }));
    });
    expect((await boot.runtime.recoverHeld()).recovered).toBe(1);
    const demoRow = (await boot.runtime.store.listOrigins({ accountId: '456', chatId: '-100456', messageId: '44' })).records[0];
    expect(JSON.parse(demoRow.record.envelopeJson)).toMatchObject({ producerId: 'telegram-demo', model: { status: 'unknown' } });
    expect(demoRow.operation?.state).toBe('accepted');
    await lifecycle!.revoke('native-session'); expect(boot.runtime.sessions.verify(sessionToken).ok).toBe(false);
    // The real five-second enrollment tick already ran retention. Advance the
    // explicit maintenance clock beyond its minute brake for this new fixture.
    const now = Date.now() + 60_001, old = admission('retained-past-hot-window', now - 31 * 24 * 60 * 60_000);
    await boot.runtime.store.admit(old);
    await boot.runtime.maintainRetention(now);
    expect((await boot.runtime.status()).retention).toMatchObject({ succeededAt: now, unavailable: false });
    const retained = await boot.runtime.store.getOrigin(old.record.originId);
    expect(retained?.record).toEqual(old.record); expect(retained?.operation?.state).toBe('expired');
    expect((await boot.runtime.store.getChild(old.children[0].childId))?.materializations).toEqual([]);
    expect((await boot.runtime.store.getOrigin(row.record.originId))?.attempts[0].receiptJson).toBe(row.attempts[0].receiptJson);
    expect((await boot.runtime.store.archive({ before: Date.now() + 1000 })).archived).toBeGreaterThan(0);
    const historical = JSON.parse(row.record.envelopeJson);
    new MachineIdentityManager(stateDir).removeLocalIdentity();
    expect(await boot.runtime.options.authorizeOrigin!(historical)).toBe(false);
    const afterLeave = (await boot.runtime.store.getOrigin(row.record.originId))!;
    expect(afterLeave.record.envelopeJson).toBe(row.record.envelopeJson);
    expect(afterLeave.acceptanceVerification).toEqual(row.acceptanceVerification);
    expect(boot.runtime.auditVerification(afterLeave).currentVerification).toMatchObject({ signatureValid: true,
      acceptedVerifiedAt: row.acceptanceVerification!.verifiedAt });
  });
});
