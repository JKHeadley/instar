// @ts-nocheck — production boot path exercised over real HTTP.
/**
 * native-conversation-base §3b — Tier-3 "feature is alive": on the production
 * boot path (bootTelegramOrigin + AgentServer), the outcome route for a reply
 * whose execution owner is another machine asks that owner over the `receipt`
 * verb with `reader: true` and answers 200 with `source: 'execution-owner'`,
 * the owner's message ids and `answeredBy` set to the machine that was asked.
 * With the owner silent it answers `unknown` with `why`, never "resend"; the
 * origin status carries the owner-read counters.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import { OriginOwnerReader } from '../../src/messaging/telegram-origin/OriginOwnerRead.js';
import { HOLD_REASON_LEASE_NOT_HELD } from '../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { compileOriginWorker, compileOriginConfigWorker } from '../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const cleanup = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); }, 30_000);

describe('owner-read outcome route lifecycle', () => {
  it('is alive on the production boot path and answers with the execution owner\'s verdict', async () => {
    const tmpBase = process.env.TMPDIR && !process.env.TMPDIR.includes('/.') ? process.env.TMPDIR : os.tmpdir();
    const root = fs.mkdtempSync(path.join(tmpBase, 'origin-owner-read-')), stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    cleanup.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'origin-owner-read-e2e' }));
    const telegramConfig = { token: '123:owner-read-fixture', chatId: '-100123' };
    const config = { projectName: 'owner-read-fixture', projectDir: root, stateDir, port: 0, authToken: 'owner-read-auth', dashboardPin: '654321',
      messaging: [{ type: 'telegram', enabled: true, config: telegramConfig }] };
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(config), { mode: 0o600 });
    const boot = await bootTelegramOrigin({ config, token: telegramConfig.token, workerUrl: await compileOriginWorker(), configWorkerUrl: await compileOriginConfigWorker(),
      noticeOwner: true, holdsLease: () => false, isSessionLive: () => false, attachSessionLifecycle: () => undefined,
      diagnoseUnknown: async () => undefined, onNoticeState: () => undefined });
    cleanup.push(() => boot.close());
    const runtime = boot.runtime;
    const self = runtime.options.identity.originMachineId;

    // A reply this machine wrote and forwarded to the holder ('studio'); the forward's answer was lost.
    const operation = runtime.service.runAsUnboundAutomation('telegram-server', () => runtime.service.prepareBot({ method: 'sendMessage', accountId: '123',
      params: { chat_id: '-100123', text: 'A forwarded reply whose answer was lost', message_thread_id: 42 }, executionOwnerMachineId: 'studio' }));
    await runtime.service.recordIntent(operation);
    await runtime.service.admit(operation);
    await runtime.store.recordOperationState({ operationId: operation.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD,
      holdDetail: { kind: 'forward-to-holder', lastAttempt: 'outcome-unknown', machineId: 'studio', topicId: 42, chatId: '-100123', text: 'A forwarded reply whose answer was lost',
        reason: 'origin-relay-acceptance-unknown', at: Date.now(), noticeDelivered: false, ladder: { attempts: 0, nextAt: Date.now() + 60_000 } } });
    const operationId = operation.record.operationId;

    // The remote owner: answers the reader ask with its classified verdict.
    let ownerUp = true;
    const send = vi.fn(async (machineId, command) => {
      if (!ownerUp) return new Promise(() => undefined);
      expect(machineId).toBe('studio');
      expect(command).toEqual({ type: 'telegram-origin', protocol: 'instar-telegram-origin-v1', action: 'receipt', operationId, reader: true });
      return { ok: true, result: { ok: true, operationId, originId: operation.record.originId, envelopeDigest: operation.admission.record.envelopeDigest,
        executionOwnerMachineId: 'studio', state: 'accepted', originReceiptConfirmed: true, messageIds: ['4401'], role: 'execution-owner',
        outcome: 'delivered', safeToResend: false, reason: null, failure: null, supersededBy: null, duplicateOfMessageId: null, originMachineId: self } };
    });
    runtime.ownerReader = new OriginOwnerReader({ selfMachineId: self, transport: { send }, leaseHolder: () => 'studio', enabled: () => true, budgetMs: () => 1000 });

    const telegram = new TelegramAdapter(telegramConfig, stateDir, { suppressLifelineAutoCreate: true }); cleanup.push(() => telegram.stop());
    const server = new AgentServer({ config, state: new StateManager(stateDir), sessionManager: createMockSessionManager(), telegram, telegramOrigin: runtime });
    cleanup.push(() => server.stop());
    const http = server.getApp().listen(0, '127.0.0.1'); cleanup.push(() => new Promise(resolve => http.close(resolve)));
    await new Promise(resolve => http.listening ? resolve() : http.once('listening', resolve));
    const base = `http://127.0.0.1:${http.address().port}`;
    const auth = { Authorization: 'Bearer owner-read-auth', 'X-Instar-AgentId': 'owner-read-fixture' };

    const alive = await fetch(`${base}/telegram/origins/operations/${operationId}/outcome`, { headers: auth });
    expect(alive.status).toBe(200);
    const body = await alive.json();
    expect(body).toMatchObject({ operationId, outcome: 'delivered', safeToResend: false, source: 'execution-owner', answeredBy: 'studio',
      ownerAnswered: true, messageIds: ['4401'], executionOwnerMachineId: 'studio' });
    expect(typeof body.asOf).toBe('string');
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(body)).not.toContain('answer was lost');

    // Owner silent: the route still answers inside its deadline, unknown with why, never "resend".
    // A second reply (the first answer above is a cached terminal verdict).
    ownerUp = false;
    const second = runtime.service.runAsUnboundAutomation('telegram-server', () => runtime.service.prepareBot({ method: 'sendMessage', accountId: '123',
      params: { chat_id: '-100123', text: 'A second forwarded reply', message_thread_id: 42 }, executionOwnerMachineId: 'studio' }));
    await runtime.service.recordIntent(second);
    await runtime.service.admit(second);
    await runtime.store.recordOperationState({ operationId: second.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD,
      holdDetail: { kind: 'forward-to-holder', lastAttempt: 'outcome-unknown', machineId: 'studio', topicId: 42, chatId: '-100123', text: 'A second forwarded reply',
        reason: 'origin-relay-acceptance-unknown', at: Date.now(), noticeDelivered: false, ladder: { attempts: 0, nextAt: Date.now() + 60_000 } } });
    const started = Date.now();
    const silent = await (await fetch(`${base}/telegram/origins/operations/${second.record.operationId}/outcome`, { headers: auth })).json();
    expect(Date.now() - started).toBeLessThan(4500);
    expect(silent).toMatchObject({ outcome: 'pending', safeToResend: false, ownerAnswered: false, why: 'timeout' });

    // The counters the 2026-11-25 review reads.
    expect((await runtime.status()).ownerRead).toMatchObject({ enabled: true, asks: 2, timeouts: 1, routeReads: 2 });
  }, 60_000);
});
