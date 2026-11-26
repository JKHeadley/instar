/**
 * held-and-startup-parked-send-release — Tier 3: the production boot path (bootTelegramOrigin, real
 * config, identity and store worker) with the real route table. A reply the reply script parked in
 * the queue while the boot beacon answered (the beacon's real body) is sent by one recovery pass; an
 * old one is handed back to its live author instead; held forwards shaped like the four Studio rows
 * are never sent; the retire route is alive (answers, never 503).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { fixtureOriginContentDedup } from '../helpers/originContentDedup.js';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { compileOriginWorker } from '../helpers/telegramOriginStore.js';
import { PendingRelayStore } from '../../src/messaging/pending-relay-store.js';
import { bootBeaconResponseBody } from '../../src/server/BootHealthBeacon.js';
import { BootReadinessTracker } from '../../src/server/BootReadiness.js';
import { HOLD_REASON_LEASE_NOT_HELD } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { OriginSessionLifecycle } from '../../src/messaging/telegram-origin/OriginSessionRegistry.js';

const MIN = 60_000;
let worker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); });
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close(); } finally { vi.unstubAllGlobals(); }
}, 30_000);

describe('held and startup-parked sends through the production boot', () => {
  it('sends the fresh parked reply once, hands the old one back, never sends the Studio-shaped holds, and the retire route is alive', async () => {
    const root = await mkdtemp('/tmp/held-send-release-');
    cleanup.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:held-send-release:cleanup' }); });
    const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
    const config = { projectDir: root, stateDir, projectName: 'echo', port: 0, authToken: 'fixture-auth',
      messaging: [{ type: 'telegram', enabled: true, config: { token: '123:fixture', chatId: '-100123', lifelineTopicId: 7848 } }] };
    await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
    let lifecycle: OriginSessionLifecycle | undefined;
    const boot = await bootTelegramOrigin({ config: config as never, token: '123:fixture', noticeOwner: true,
      workerUrl: worker, holdsLease: () => true, isSessionLive: () => true, reviewLegacyRecovery: async () => true,
      attachSessionLifecycle: value => { lifecycle = value; }, diagnoseUnknown: vi.fn(async () => undefined), onNoticeState: vi.fn() });
    cleanup.push(() => boot.close());
    const runtime = boot.runtime;
    runtime.attachSendPolicy({ review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) });
    await vi.waitFor(async () => expect(await runtime.service.options.authorize({ accountId: '123', destination: { chatId: '-100123' } } as never)).toBe(true),
      { timeout: 20_000, interval: 100 });
    const lines: string[] = [];
    runtime.options.injectSessionLine = (_binding, text) => { lines.push(text); return true; };
    const items: unknown[] = [];
    runtime.options.raiseRetirementItem = input => { items.push(input); };
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sent.push(body.text);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 + sent.length, chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
    }));

    // The reply script's queue rows, with the beacon's own body (a real tracker, mid-boot).
    const tracker = new BootReadinessTracker(() => Date.now(), Date.now() - 45_000);
    tracker.markListeningEarly('0.0.0.0');
    const beaconBody = bootBeaconResponseBody(tracker.snapshot({ includePreviousRestart: true }), 12);
    const credential = await lifecycle!.issue({ sessionId: 'chief-of-staff', harnessId: 'claude-code', projectDir: root, configuredModel: 'claude-opus-5-5' });
    const digest = createHash('sha256').update(credential).digest('hex');
    const queue = PendingRelayStore.open('echo', stateDir);
    queue.enqueue({ delivery_id: 'parked-fresh', topic_id: 42, text_hash: 'fresh', text: 'A heads-up written while the server was restarting a minute ago.',
      http_code: 503, error_body: beaconBody, attempted_at: new Date(Date.now() - MIN).toISOString(), origin_session_digest: digest });
    queue.enqueue({ delivery_id: 'parked-old', topic_id: 42, text_hash: 'old', text: 'A note written before a long outage, now out of date.',
      http_code: 503, error_body: beaconBody, attempted_at: new Date(Date.now() - 50 * MIN).toISOString(), origin_session_digest: digest });
    queue.close();

    // Four held forwards shaped like the Studio rows: outcome unknown at a holder that cannot be reached.
    const studioShaped: string[] = [];
    for (let i = 0; i < 4; i++) {
      const realNow = runtime.service.options.now;
      runtime.service.options.now = () => Date.now() - (60 + i * 30) * MIN;
      const op = runtime.service.runAsAutomation('telegram-server', () => runtime.service.prepareBot({ method: 'sendMessage', accountId: '123',
        executionOwnerMachineId: 'm_mini', params: { chat_id: '-100123', message_thread_id: 42, text: `Held forward number ${i} from the outage night, never to be sent blind.` } }));
      runtime.service.options.now = realNow;
      // Admitted straight into the outbox as the forward path's hold does (its origin evidence lives with the author).
      await runtime.store.admit(op.admission);
      expect(await runtime.store.recordOperationState({ operationId: op.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD,
        holdDetail: { kind: 'forward-to-holder', lastAttempt: 'outcome-unknown', machineId: 'm_mini', topicId: 42, chatId: '-100123',
          text: `Held forward number ${i}`, ladder: { attempts: 9, nextAt: null }, authoredPreparedAt: op.admission.preparedAt } })).toBe(true);
      studioShaped.push(op.record.operationId);
    }
    // The production forward recovery is wired by the server; here the holder answers "unreachable" to every receipt.
    const { recoverForwardedHold } = await import('../../src/messaging/telegram-origin/OriginForwardToHolder.js');
    runtime.options.forwardRecovery = (operation, row) => recoverForwardedHold({
      lease: { selfMachineId: runtime.options.identity.originMachineId, leaseHolder: () => runtime.options.identity.originMachineId, holdsLease: () => true, isHolderHealthy: () => true },
      prepare: async () => { throw new Error('no successor may be prepared'); }, submit: async () => { throw new Error('no submit'); },
      receipt: async () => ({ state: 'unreachable' }), resolve: async () => false, settleUnknown: async () => false,
      rehold: async (id, detail) => runtime.store.recordOperationState({ operationId: id, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD, holdDetail: detail as never }),
      supersede: async () => false, sendLocal: async () => { throw new Error('no local send'); }, now: Date.now,
      staleBound: { afterMs: 30 * MIN, retire: id => runtime.retireStale(id, 'held-lease') } }, row, operation);

    await runtime.recoverHeld();
    await runtime.recoverHeld();

    expect(sent).toEqual([expect.stringContaining('A heads-up written while the server was restarting a minute ago.')]);
    expect(await runtime.store.getRetirement('legacy:parked-old')).toMatchObject({ reason: 'stale-hold-handed-back', cause: 'parked-at-startup', reportOutcome: 'session-line' });
    expect(lines).toEqual([expect.stringMatching(/^Your reply `legacy:parked-old`, written 50 minutes ago, was not sent: it waited longer than 30 minutes \(the server was starting when you sent it\)/)]);
    expect(items).toEqual([]);
    for (const id of studioShaped) {
      const audit = await runtime.store.getOperation(id);
      expect(audit?.operation?.state).toBe('held');
      expect(await runtime.store.getRetirement(id)).toBeNull();
    }

    // The route is mounted through the production route table and alive.
    const app = express(); app.use(express.json());
    app.use(createRoutes({ state: { getSession: () => undefined }, config: { ...config, port: 0 }, telegramOrigin: runtime,
      verifyDashboardOperatorSession: () => false, sessionManager: { clearInjectionTracker: () => undefined } } as never));
    const uncertain = await request(app).post(`/telegram/origins/operations/${studioShaped[0]}/retire`).send({ note: 'operator: do not send' });
    expect(uncertain.status).toBe(409);
    expect(uncertain.body).toMatchObject({ retired: false, refusal: 'uncertain' });
    const outcome = await request(app).get('/telegram/origins/operations/legacy:parked-old/outcome');
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({ outcome: 'not-delivered', safeToResend: true });
    const text = await request(app).get('/telegram/origins/operations/legacy:parked-old/text');
    expect(text.status).toBe(200);
    expect(text.body.text).toContain('A note written before a long outage');
    expect(sent).toHaveLength(1);
  }, 90_000);
});
