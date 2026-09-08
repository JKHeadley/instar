import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bootTelegramOrigin } from '../../src/messaging/telegram-origin/TelegramOriginBoot.js';
import type { OriginNoticeDestinationPolicy } from '../../src/messaging/telegram-origin/OriginNoticePolicy.js';
import { RECORDING_OUTAGE_TEXT } from '../../src/messaging/telegram-origin/TelegramOriginOutageNotifier.js';
import { telegramFetch } from '../../src/messaging/telegram-egress.js';
import { compileOriginWorker, compileOriginConfigWorker } from '../helpers/telegramOriginStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { migrateSecrets } from '../../src/core/SecretMigrator.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import type { OriginBotTransport } from '../../src/messaging/telegram-origin/TelegramOriginService.js';

let worker: URL, configWorker: URL;
beforeAll(async () => { worker = await compileOriginWorker(); configWorker = await compileOriginConfigWorker(); });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.unstubAllGlobals(); });
async function boot(withAuthority: boolean, allowOrdinary = false, vault = false) {
  const root = await mkdtemp('/tmp/origin-notice-policy-');
  cleanups.push(async () => { await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-notice-policy:cleanup' }); });
  const stateDir = path.join(root, '.instar'); await mkdir(path.join(stateDir, 'state'), { recursive: true });
  const config = { projectDir: root, stateDir, projectName: 'echo', port: 0,
    messaging: [{ type: 'telegram', enabled: true, config: { token: '123:notice-fixture', chatId: '-100123' } }] };
  await writeFile(path.join(stateDir, 'config.json'), JSON.stringify(config));
  await writeFile(path.join(stateDir, 'state/agent-attention-topic.json'), '7848');
  if (vault) migrateSecrets(path.join(stateDir, 'config.json'), stateDir);
  const now = Date.now();
  let policy: OriginNoticeDestinationPolicy | null = { destination: { accountId: '123', chatId: '-100123', topicId: '7848' },
    authorized: true, clientPreferences: 'telegram-managed', optedOut: false,
    observerHealthy: true, observedAt: now, validUntil: now + 30_000, version: 'fixture-observation' };
  let ownsLease = true;
  const current = await bootTelegramOrigin({ config: config as never, token: '123:notice-fixture', noticeOwner: true,
    workerUrl: worker, configWorkerUrl: configWorker, holdsLease: () => ownsLease, diagnoseUnknown: async () => undefined, onNoticeState: () => undefined,
    ...(withAuthority ? { readAlertDestinationPolicy: () => policy } : {}) });
  let storageFailed = false;
  cleanups.push(async () => {
    // The deliberate permanent worker loss also prevents durable owner
    // retirement at shutdown; cleanup must report that exact failure.
    if (storageFailed) await expect(current.close()).rejects.toThrow('origin worker is closed/unavailable');
    else await current.close();
  });
  const wire = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (!allowOrdinary) expect(body.text).toContain(RECORDING_OUTAGE_TEXT);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 99, chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
  });
  vi.stubGlobal('fetch', wire);
  const failRecording = async () => {
    await current.runtime.store.close(); await current.runtime.spool.close();
    storageFailed = true;
    await expect(telegramFetch('https://api.telegram.org/bot123:notice-fixture/sendMessage', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100123', message_thread_id: 42, text: 'Held ordinary message' }) }))
      .rejects.toMatchObject({ reason: 'all-durable-recording-sinks-unavailable' });
  };
  return { ...current, wire, failRecording, stateDir, config, loseOwnership: () => { ownsLease = false; }, revoke: () => { policy = null; }, optOut: () => { policy = { ...policy!, optedOut: true }; } };
}
describe('production bootstrap outage authority separation', () => {
  it('rechecks notice permission after a capacity grant without consuming a revoked notice', async () => {
    const h = await boot(true);
    const consume = h.runtime.capacity.consume.bind(h.runtime.capacity);
    vi.spyOn(h.runtime.capacity, 'consume').mockImplementation(async grant => {
      const result = await consume(grant); h.optOut(); return result;
    });
    await h.failRecording();
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-attention-hub')).toMatchObject({
      notificationOutcome: 'suppressed', notificationAttempted: false, reason: 'destination-policy' }));
    expect(h.wire).not.toHaveBeenCalled();
  });
  it.each(['before', 'after'] as const)('never invokes a late wire closure when capacity expires %s durable dispatch intent', async phase => {
    const h = await boot(true, true);
    let prepared: Awaited<ReturnType<NonNullable<OriginBotTransport['prepare']>>> | undefined;
    const execute = h.runtime.service.executePreparedBot.bind(h.runtime.service);
    vi.spyOn(h.runtime.service, 'executePreparedBot').mockImplementation(async (operation, transport) => {
      const prepare = transport.prepare!;
      transport.prepare = async request => { prepared = await prepare(request); return prepared; };
      return execute(operation, transport);
    });
    const actualNow = Date.now.bind(Date); let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => actualNow() + offset);
    if (phase === 'before') {
      const claim = h.runtime.store.claim.bind(h.runtime.store);
      vi.spyOn(h.runtime.store, 'claim').mockImplementation(async input => { const result = await claim(input); offset = 500; return result; });
    } else {
      const mark = h.runtime.store.markDispatched.bind(h.runtime.store);
      vi.spyOn(h.runtime.store, 'markDispatched').mockImplementation(async input => { const result = await mark(input); offset = 500; return result; });
    }
    try {
      await expect(telegramFetch('https://api.telegram.org/bot123:notice-fixture/sendMessage', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100123', message_thread_id: 42, text: 'Expires before network' }) }))
        .rejects.toMatchObject({ reason: 'credential-capacity-unavailable' });
      expect(prepared).toBeDefined(); await expect(prepared!.send()).rejects.toThrow('credential-capacity-unavailable');
      expect(h.wire).not.toHaveBeenCalled();
      const row = (await h.runtime.store.listOrigins()).records.find(row => row.attempts.length > 0)!;
      expect(row.attempts[0]).toMatchObject({ phase: phase === 'before' ? 'claimed' : 'dispatched', outcome: 'known-failed' });
    } finally { clock.mockRestore(); }
  });
  it('retains one notice while ordinary sends spend shared capacity, then drains without either recording worker', async () => {
    const h = await boot(true, true);
    await telegramFetch('https://api.telegram.org/bot123:notice-fixture/sendMessage', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100123', message_thread_id: 42, text: 'Ordinary accepted answer' }) });
    for (let i = 0; i < 9; i++) expect(await h.runtime.capacity.reserve('123')).not.toBeNull();
    await h.failRecording();
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-attention-hub')).toMatchObject({
      notificationAttempted: false, notificationOutcome: 'queued', reason: 'credential-capacity-unavailable' }));
    expect(h.wire).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-attention-hub').notificationOutcome).toBe('accepted'), { timeout: 3000 });
    expect(h.wire).toHaveBeenCalledTimes(2);
    h.runtime.notifier.requestHoldNotice('operator-attention-hub');
    await new Promise(resolve => setTimeout(resolve, 150)); expect(h.wire).toHaveBeenCalledTimes(2);
  });
  it('resolves encrypted vault placeholders for ordinary egress and the independent outage notice', async () => {
    const h = await boot(false, true, true);
    expect(h.runtime.options.getAlertPolicy('operator-attention-hub')).toMatchObject({ authorized: true, optedOut: false });
    await telegramFetch('https://api.telegram.org/bot123:notice-fixture/sendMessage', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100123', message_thread_id: 42, text: 'Ordinary answer from resolved vault configuration' }) });
    expect(h.wire).toHaveBeenCalledOnce();
    await h.failRecording();
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-attention-hub').notificationOutcome).toBe('accepted'));
    expect(h.wire).toHaveBeenCalledTimes(2);
  });
  it.each(['123:rotated-fixture', '456:rotated-fixture'])('revokes the old runtime after a vault token rotation', async nextToken => {
    const h = await boot(false, true, true);
    new SecretStore({ stateDir: h.stateDir, forceFileKey: true }).set('messaging.0.config.token', nextToken);
    // File-watch delivery is asynchronous; allow the production five-second
    // refresh plus its bounded two-second source read to observe the rotation.
    await vi.waitFor(() => expect(h.runtime.options.getAlertPolicy('operator-attention-hub')).toBeNull(), { timeout: 7500 });
    h.runtime.notifier.requestHoldNotice('operator-attention-hub');
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-attention-hub').notificationOutcome).toBe('suppressed'));
    await expect(telegramFetch('https://api.telegram.org/bot123:notice-fixture/sendMessage', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: '-100123', message_thread_id: 42, text: 'Must not use revoked credential authority' }) })).rejects.toThrow();
    expect(h.wire).not.toHaveBeenCalled();
  });
  it('boots the real bot-only authority and sends a pre-recorded notice after both workers fail', async () => {
    const h = await boot(false);
    const policy = h.runtime.options.getAlertPolicy('operator-attention-hub');
    expect(policy).toMatchObject({ optedOut: false, ownershipValid: true, clientPreferences: 'telegram-managed' });
    expect(policy).not.toHaveProperty('muted');
    expect(h.runtime.notifier.getState('operator-attention-hub').notificationOutcome).toBe('reserved');
    await h.failRecording();
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-attention-hub').notificationOutcome).toBe('accepted'));
    expect(h.wire).toHaveBeenCalledOnce();
  });
  it.each(['opt-out', 'unreadable', 'ownership'] as const)('the production observer suppresses after %s without consulting the failed workers', async reason => {
    const h = await boot(false);
    if (reason === 'ownership') h.loseOwnership();
    else {
      const updated = structuredClone(h.config) as any;
      updated.messaging[0].config.messageOrigin = { outageNotice: { enabled: false } };
      await writeFile(path.join(h.stateDir, 'config.json'), reason === 'unreadable' ? '{' : JSON.stringify(updated));
      await vi.waitFor(() => {
        const current = h.runtime.options.getAlertPolicy('operator-attention-hub');
        expect(reason === 'unreadable' ? current === null : current?.optedOut).toBe(true);
      }, { timeout: 7000 });
    }
    h.runtime.notifier.requestHoldNotice('operator-attention-hub');
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-attention-hub').notificationOutcome).toBe('suppressed'));
    expect(h.wire).not.toHaveBeenCalled();
  });
  it.each(['missing-topic', 'unknown'] as const)('never retries a notice after a concrete %s network outcome', async outcome => {
    const h = await boot(false);
    if (outcome === 'missing-topic') h.wire.mockImplementation(async () => new Response(JSON.stringify({ ok: false,
      description: 'Bad Request: message thread not found' }), { status: 400 }));
    else h.wire.mockRejectedValue(new Error('response lost'));
    await h.failRecording();
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-attention-hub')).toMatchObject({
      notificationOutcome: outcome === 'missing-topic' ? 'known-failed' : 'outcome-unknown', notificationAttempted: true,
      reason: outcome === 'missing-topic' ? 'telegram-topic-unavailable' : 'network-or-receipt-unavailable' }));
    h.runtime.notifier.requestHoldNotice('operator-attention-hub');
    await new Promise(resolve => setTimeout(resolve, 150)); expect(h.wire).toHaveBeenCalledOnce();
  });
  it('can consume a pre-recorded notice with the origin workers failed and independent policy still healthy', async () => {
    const h = await boot(true);
    expect(h.runtime.notifier.getState('operator-attention-hub').notificationOutcome).toBe('reserved');
    await h.failRecording();
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-attention-hub').notificationOutcome).toBe('accepted'));
    expect(h.wire).toHaveBeenCalledOnce();
  });
  it.each(['revoked', 'optedOut'] as const)('suppresses the reserved notice immediately when independent policy becomes %s', async kind => {
    const h = await boot(true);
    expect(h.runtime.notifier.getState('operator-attention-hub').notificationOutcome).toBe('reserved');
    if (kind === 'revoked') h.revoke(); else h.optOut();
    await h.failRecording();
    await vi.waitFor(() => expect(h.runtime.notifier.getState('operator-attention-hub')).toMatchObject({
      notificationOutcome: 'suppressed', reason: kind === 'revoked' ? 'state-unavailable' : 'destination-policy' }));
    expect(h.wire).not.toHaveBeenCalled();
  });
});
