/**
 * native-conversation-base §3a — Tier 3, feature is alive on the production init
 * path (`bootTelegramOrigin` + `createRoutes`, mirroring server.ts), on ONE machine
 * (the author is the execution owner). A session's acknowledgment and its reply,
 * recovered more than 300 s after it was written, are BOTH sent: the newer
 * acknowledgment never ends the reply. The reply carries the late first line,
 * is marked once, and the session is told once, with the original draft age.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import type { TelegramOriginRecord } from '../../src/messaging/telegram-origin/types.js';

const MIN = 60_000;
let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.unstubAllGlobals(); }
}, 30_000);

describe('held replies are ended only for a cause (production init path, one machine)', () => {
  it('an acknowledgment and a reply recovered after 300 s are both sent; the reply is marked late once and its session is told once', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'origin-causal-retire-e2e-'));
    cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-causal-retire-e2e:cleanup' }); });
    const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
      messaging: [{ type: 'telegram', enabled: true, config: { token: '123:causal-fixture', chatId: '-100123', lifelineTopicId: 7848 } }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
    const sent: Array<{ text: string; messageId: number }> = [];
    let nextMessageId = 500;
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (!String(url).startsWith('https://api.telegram.org/')) return realFetch(url, init);
      const body = JSON.parse(init.body as string) as { text: string; message_thread_id?: number };
      const messageId = nextMessageId++;
      sent.push({ text: body.text, messageId });
      return new Response(JSON.stringify({ ok: true, result: { message_id: messageId, date: Math.floor(Date.now() / 1000), chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
    }));
    const boot = await bootTelegramOrigin({ config: config as never, token: '123:causal-fixture', noticeOwner: true, workerUrl: worker,
      holdsLease: () => true, isSessionLive: () => true, diagnoseUnknown: vi.fn(async () => undefined), onNoticeState: vi.fn(),
      // No machine identity exists in this fixture home; production verifies the attestation against it.
      authorizeOrigin: async () => true });
    cleanup.push(() => boot.close());
    const runtime = boot.runtime;
    runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) });
    // The server wires the session-line injector (server.ts); here it records what the session sees.
    const lines: string[] = [];
    runtime.options.injectSessionLine = (_binding, text) => { lines.push(text); return true; };
    await vi.waitFor(() => { runtime.service.options.display({ accountId: '123', chatId: '-100123', topicId: '42' }); }, { timeout: 20_000, interval: 100 });

    const app = express(); app.use(express.json());
    const routeCtx = { startTime: new Date(), sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }) },
      state: { getJobState: () => null, getSession: () => null }, scheduler: null, telegram: null };
    app.use(createRoutes({ ...routeCtx, config: config as never, telegramOrigin: runtime, verifyDashboardOperatorSession: (proof: string | undefined) => proof === 'operator' } as never));
    const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // A session reply written 20 minutes ago that never left (Telegram was unreachable):
    // durably admitted and queued, exactly what recovery finds after an outage.
    const svc = runtime.service;
    const seed = svc.runAsAutomation('telegram-server', () => svc.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'seed' } }));
    const session = { ...seed.record, producerKind: 'session', producerId: 'session', sessionId: 'session-1', sessionIncarnation: 'incarnation-1',
      harnessId: 'claude-code', harnessName: 'Claude Code' } as TelegramOriginRecord;
    const realNow = svc.options.now;
    svc.options.now = () => Date.now() - 20 * MIN - 30_000;
    const reply = svc.runAsRecordedProducer(session, () => svc.prepareBot({ method: 'sendMessage', accountId: '123',
      params: { chat_id: '-100123', message_thread_id: 42, text: 'Here is the full answer you asked for.' } }));
    svc.options.now = realNow;
    await svc.admit(reply);
    // The same session's acknowledgment, sent now: newer than the reply's draft time.
    await svc.runAsRecordedProducer(session, () => svc.sendBot({ method: 'sendMessage', accountId: '123',
      params: { chat_id: '-100123', message_thread_id: 42, text: 'Got it, looking into this now.' } }, (async (request: { body: string }) => {
      const r = await fetch('https://api.telegram.org/bot123:causal-fixture/sendMessage', { method: 'POST', body: request.body }); return r;
    }) as never));
    expect(sent.map(s => s.text)).toEqual([expect.stringContaining('Got it, looking into this now.')]);

    await runtime.recoverHeld();
    expect(sent).toHaveLength(2);
    expect(sent[1].text).toMatch(/^Late reply, written more than 20 minutes ago and held up in delivery\. It answers an earlier message:\n\nHere is the full answer you asked for\./);
    // The original is superseded by its marked replacement, which was accepted.
    const original = await runtime.store.getOperation(reply.record.operationId);
    expect(original?.operation?.state).toBe('superseded');
    const successorId = (original?.operation?.holdDetail as { supersededBy: string }).supersededBy;
    expect((await runtime.store.getOperation(successorId))?.operation).toMatchObject({ state: 'accepted', firstPreparedAt: reply.admission.preparedAt });
    // The session is told once, about the id it was given, with the original draft age.
    expect(lines).toEqual([expect.stringMatching(new RegExp(`^Your reply \`${reply.record.operationId}\` was delivered 20 minutes after you wrote it\\. It carries a first line telling the user it is late\\.`))]);

    // A second pass sends nothing more and tells nobody again.
    await runtime.recoverHeld();
    expect(sent).toHaveLength(2);
    expect(lines).toHaveLength(1);

    // Alive: the status read carries the review counters (200, not 503) and the reply text route answers.
    const status = await fetch(`${url}/telegram/origins/status`, { headers: { Authorization: 'Bearer fixture-auth', 'X-Instar-Operator-Session': 'operator' } });
    expect(status.status).toBe(200);
    expect((await status.json() as { heldReplies: Record<string, number> }).heldReplies).toMatchObject({ lateDeliveries: 1, lateUnmarked: 0, neverHandedBack: 0 });
    const text = await fetch(`${url}/telegram/origins/operations/${reply.record.operationId}/text`, { headers: { Authorization: 'Bearer fixture-auth' } });
    expect(text.status).toBe(200);
    expect(await text.json()).toMatchObject({ operationId: reply.record.operationId, text: 'Here is the full answer you asked for.' });
  }, 60_000);
});
