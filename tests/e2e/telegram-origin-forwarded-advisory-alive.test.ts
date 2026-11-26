/**
 * native-conversation-forwarded-advisory (slice 3g) — Tier 3, feature is alive on
 * the production init path (`bootTelegramOrigin` + `createRoutes`, mirroring
 * server.ts). A session reply held for recovery gets an advisory from the outbound
 * check: it is handed back (held, never reviewed or sent again), the advisory line
 * reaches the session through the real injector option, the review counters answer
 * 200 and move, and the session's answer sends exactly one message. The store
 * migration adds the verdict column to an existing database.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';
import type { AddressInfo } from 'node:net';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { OriginStore } from '../../src/messaging/telegram-origin/OriginStore.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import { admission, compileOriginWorker } from '../helpers/telegramOriginStore.js';
import type { TelegramOriginRecord } from '../../src/messaging/telegram-origin/types.js';
import type { OriginSendPolicyDecision } from '../../src/messaging/telegram-origin/OriginSendPolicy.js';

let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); }
  finally { vi.unstubAllGlobals(); }
}, 30_000);

async function home(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: `test:${prefix}cleanup` }); });
  const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
  return { root, stateDir };
}

describe('a tone verdict on a held reply reaches its author (production init path)', () => {
  it('handed back on recovery: one line through the injector, never re-reviewed or sent, counters alive, the answer sends once', async () => {
    const { root, stateDir } = await home('origin-advisory-e2e-');
    const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
      messaging: [{ type: 'telegram', enabled: true, config: { token: '123:advisory-fixture', chatId: '-100123', lifelineTopicId: 7848 } }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (!String(url).startsWith('https://api.telegram.org/')) return realFetch(url, init);
      const body = JSON.parse(init.body as string) as { text: string; message_thread_id?: number };
      sent.push(body.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 600 + sent.length, date: Math.floor(Date.now() / 1000), chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
    }));
    const boot = await bootTelegramOrigin({ config: config as never, token: '123:advisory-fixture', noticeOwner: true, workerUrl: worker,
      holdsLease: () => true, isSessionLive: () => true, diagnoseUnknown: vi.fn(async () => undefined), onNoticeState: vi.fn(),
      authorizeOrigin: async () => true });
    cleanup.push(() => boot.close());
    const runtime = boot.runtime;
    await vi.waitFor(() => { runtime.service.options.display({ accountId: '123', chatId: '-100123', topicId: '42' }); }, { timeout: 20_000, interval: 100 });
    const app = express(); app.use(express.json());
    app.use(createRoutes({ startTime: new Date(), sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }) },
      state: { getJobState: () => null, getSession: () => null }, scheduler: null, telegram: null,
      config: config as never, telegramOrigin: runtime, verifyDashboardOperatorSession: (proof: string | undefined) => proof === 'operator' } as never));
    const server = await new Promise<import('node:http').Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // After createRoutes (which attaches the production evaluator): the outbound check's answers.
    const reviews: OriginSendPolicyDecision[] = [{ ok: false, status: 422, reason: 'tone-gate-advisory', body: { error: 'tone-gate-advisory', notSent: true,
      rule: 'B11_STYLE_MISMATCH', issue: 'internal', suggestion: 'Say it in two sentences.', decisionRef: 'dq-e2e' } }];
    let reviewed = 0;
    runtime.attachSendPolicy({ review: async () => { reviewed++; return reviews.shift() ?? { ok: true }; }, authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) });
    // The server wires the session-line injector (server.ts); here it records what the session sees.
    const lines: string[] = [];
    runtime.options.injectSessionLine = (_binding, text) => { lines.push(text); return true; };

    // A session reply that never left (Telegram was unreachable): durably admitted and queued.
    const svc = runtime.service;
    const seed = svc.runAsAutomation('telegram-server', () => svc.prepareBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'seed' } }));
    const session = { ...seed.record, producerKind: 'session', producerId: 'session', sessionId: 'session-1', sessionIncarnation: 'incarnation-1',
      harnessId: 'claude-code', harnessName: 'Claude Code' } as TelegramOriginRecord;
    const reply = svc.runAsRecordedProducer(session, () => svc.prepareBot({ method: 'sendMessage', accountId: '123',
      params: { chat_id: '-100123', message_thread_id: 42, text: 'A very long answer the check would like shorter.' } }));
    await svc.admit(reply);

    await runtime.recoverHeld();
    const id = reply.record.operationId;
    expect((await runtime.store.getOperation(id))?.operation).toMatchObject({ state: 'held', holdReason: 'tone-advisory', policyVerdict: { class: 'advisory', decisionRef: 'dq-e2e' } });
    await vi.waitFor(() => expect(lines).toEqual([expect.stringContaining(`Your reply \`${id}\` was not sent. The outbound check has a suggestion (\`B11_STYLE_MISMATCH\`): Say it in two sentences.`)]), { timeout: 10_000 });
    expect(lines[0]).toContain('--tone-decision-ref dq-e2e');
    // Never reviewed again, never sent, the line never repeated.
    await runtime.recoverHeld();
    await runtime.refreshHeldForward({ force: true });
    expect(reviewed).toBe(1); expect(sent).toEqual([]); expect(lines).toHaveLength(1);

    // Alive: the status read carries the advisory counters (200, not 503); the outcome says not sent.
    const status = await realFetch(`${url}/telegram/origins/status`, { headers: { Authorization: 'Bearer fixture-auth', 'X-Instar-Operator-Session': 'operator' } });
    expect(status.status).toBe(200);
    expect((await status.json() as { heldReplies: Record<string, number> }).heldReplies).toMatchObject({ advisoryHandedBack: 1, advisoryLineSent: 1, advisoryComplied: 0 });
    const outcome = await realFetch(`${url}/telegram/origins/operations/${id}/outcome`, { headers: { Authorization: 'Bearer fixture-auth' } });
    expect(await outcome.json()).toMatchObject({ outcome: 'not-delivered', safeToResend: false, reason: 'tone-advisory' });

    // The session answers with the reference: the original is withdrawn and one revised message goes out.
    const match = await runtime.findAdvisoryAnswer({ sessionId: 'session-1', topicId: 42, ref: 'dq-e2e' });
    expect(match).toMatchObject({ operationId: id, state: 'held' });
    await svc.runAsRecordedProducer(session, async () => {
      svc.setAdvisoryAnswer({ originalId: match!.operationId, firstPreparedAt: match!.firstPreparedAt, deadlineAt: match!.deadlineAt, kind: 'complied', handedBackAt: match!.verdict.at });
      return svc.sendBot({ method: 'sendMessage', accountId: '123', params: { chat_id: '-100123', message_thread_id: 42, text: 'The short answer.' } },
        (async (request: { body: string }) => fetch('https://api.telegram.org/bot123:advisory-fixture/sendMessage', { method: 'POST', body: request.body })) as never);
    });
    expect(sent).toEqual([expect.stringContaining('The short answer.')]);
    expect((await runtime.store.getOperation(id))?.operation?.state).toBe('superseded');
    await runtime.recoverHeld();
    expect(sent).toHaveLength(1);
    const after = await realFetch(`${url}/telegram/origins/status`, { headers: { Authorization: 'Bearer fixture-auth', 'X-Instar-Operator-Session': 'operator' } });
    expect((await after.json() as { heldReplies: Record<string, number> }).heldReplies).toMatchObject({ advisoryComplied: 1, advisoryAnswerDelayCount: 1 });
  }, 60_000);

  it('the store migration adds the verdict column to an existing database and keeps its rows', async () => {
    const { stateDir } = await home('origin-advisory-migration-');
    const first = await OriginStore.open({ stateDir, agentId: 'echo', requestTimeoutMs: 20_000 }, worker);
    const a = admission('before-migration'); await first.admit(a);
    const dbPath = (await first.diagnostics()).path;
    await first.close();
    // An install from before this release: the operations table has no verdict column.
    const db = new Database(dbPath); db.exec('ALTER TABLE telegram_origin_operations DROP COLUMN policy_verdict_json'); db.close();
    const reopened = await OriginStore.open({ stateDir, agentId: 'echo', requestTimeoutMs: 20_000 }, worker);
    cleanup.push(() => reopened.close());
    expect((await reopened.getOperation(a.operationId))?.operation?.state).toBe('admitted');
    expect(await reopened.recordOperationState({ operationId: a.operationId, state: 'held', holdReason: 'tone-advisory',
      policyVerdict: { class: 'advisory', rule: 'B11_STYLE_MISMATCH', decisionRef: null, at: Date.now(), machineId: 'm1' } })).toBe(true);
    expect((await reopened.getOperation(a.operationId))?.operation?.policyVerdict).toMatchObject({ class: 'advisory' });
    const check = new Database(dbPath, { readonly: true });
    expect((check.prepare('PRAGMA table_info(telegram_origin_operations)').all() as Array<{ name: string }>).map(c => c.name)).toContain('policy_verdict_json');
    check.close();
  }, 60_000);
});
