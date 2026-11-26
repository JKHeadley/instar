// lease-freshness-lapse-retry — a send refused at the network boundary because this machine did not hold the
// lease is named from the coordinator's own verdict, logged once, counted, and retried within seconds once the
// lease is held again; nothing is sent while the lease is away.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { OriginSessionLifecycle } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { TelegramOriginRuntime } from '../../../src/messaging/telegram-origin/TelegramOriginRuntime.js';
import type { LeaseFreshness } from '../../../src/messaging/telegram-origin/OriginEgressCapacity.js';
import { telegramFetch } from '../../../src/messaging/telegram-egress.js';
import { compileOriginWorker, temporaryState, allowSlowOriginRecording, SLOW_DISK_STORE_REQUEST_TIMEOUT_MS } from '../../helpers/telegramOriginStore.js';
import { fixtureOriginContentDedup } from '../../helpers/originContentDedup.js';

let worker: URL;
const runtimes: TelegramOriginRuntime[] = [];
const privateKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** A fake lease: `held` is what the coordinator would answer; the reader reports the verdict from the same flag. */
async function harness(input: { reader?: boolean; verdict?: LeaseFreshness['verdict']; schedule?: number[] } = {}) {
  const stateDir = temporaryState(), token = `123:${randomUUID()}`;
  const lease = { held: true, verdictWhenAway: input.verdict ?? 'renewal-lapsed' as LeaseFreshness['verdict'], gapMs: 61_500, readerCalls: 0, boundaryRefusals: 0 };
  const held = vi.fn(() => []);
  const delivered = vi.fn();
  const onSessionDeliveryHeld = vi.fn(async () => undefined);
  let lifecycle: OriginSessionLifecycle | undefined;
  const runtime = await TelegramOriginRuntime.open({ storage: { stateDir, agentId: 'echo', requestTimeoutMs: SLOW_DISK_STORE_REQUEST_TIMEOUT_MS }, workerUrl: worker,
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Studio' },
    signingKey: { privateKey, keyId: 'studio-1', keyEpoch: 1 }, bot: { token, accountId: '123', chatId: '-100123' },
    isSessionLive: () => true, attachSessionLifecycle: value => { lifecycle = value; },
    display: () => ({}), authorize: () => true, diagnoseUnknown: async () => undefined,
    alertDestinations: () => [], getAlertPolicy: () => null, onNoticeState: () => undefined,
    holdsLease: () => lease.held,
    ownsCapacityLease: () => lease.held,
    leaseFreshness: input.reader === false ? undefined : () => {
      lease.readerCalls++;
      if (lease.boundaryRefusals > 0) { lease.boundaryRefusals--; return { msSinceConfirmedRenewal: lease.gapMs, ttlMs: 60_000, verdict: lease.verdictWhenAway }; }
      return lease.held ? { msSinceConfirmedRenewal: 1_000, ttlMs: 60_000, verdict: 'holding' } : { msSinceConfirmedRenewal: lease.gapMs, ttlMs: 60_000, verdict: lease.verdictWhenAway };
    },
    sendHoldIncidents: { held: input => { held(input as never); }, delivered },
    leaseLapseRetryScheduleMs: input.schedule ?? [2_100, 400, 400, 400],
    onSessionDeliveryHeld });
  runtimes.push(runtime);
  allowSlowOriginRecording(runtime.service);
  const sessionToken = await lifecycle!.issue({ sessionId: 'lease-session', harnessId: 'codex-cli', projectDir: process.cwd(), configuredModel: 'fixture-model' });
  runtime.attachSendPolicy({ review: async () => ({ ok: true as const }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) });
  const network = vi.fn(async (_url: string, init: RequestInit) => {
    init.signal?.throwIfAborted();
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 27, chat: { id: -100123 }, message_thread_id: body.message_thread_id } }));
  });
  vi.stubGlobal('fetch', network);
  const send = (text = 'The requested status.') => runtime.service.runWithSessionToken(sessionToken, () => telegramFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', body: JSON.stringify({ chat_id: '-100123', message_thread_id: 42, text }), networkTimeoutMs: 15_000 }));
  const operationId = async () => (await runtime.store.listOrigins()).records[0].operation!.operationId;
  return { runtime, lease, held, delivered, onSessionDeliveryHeld, network, send, token, operationId };
}

describe('a send refused at the boundary for the lease', () => {
  it('is named from the verdict, logged once without the token, counted, and not reported as a live notice', async () => {
    const h = await harness();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.lease.held = false;
    await expect(h.send()).rejects.toMatchObject({ reason: 'lease-freshness-lapsed', outcome: 'held' });
    expect(h.network).not.toHaveBeenCalled();
    const id = await h.operationId();
    const row = (await h.runtime.store.getOperation(id))!;
    expect(row.attempts.at(-1)).toMatchObject({ outcome: 'known-failed', reason: 'lease-freshness-lapsed' });
    expect((await h.runtime.store.listOrigins()).records[0].children[0].attempts).toBe(0); // the transport budget was not charged
    const nextAttemptAt = row.attempts.at(-1)!.nextAttemptAt!;
    expect(nextAttemptAt - row.attempts.at(-1)!.createdAt).toBeGreaterThan(1_000);
    expect(nextAttemptAt - row.attempts.at(-1)!.createdAt).toBeLessThanOrEqual(2_500);
    const lines = warn.mock.calls.map(call => String(call[0])).filter(line => line.includes('lease-freshness-lapsed: held'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`held ${id} at the network boundary`);
    expect(lines[0]).toContain('lease verdict renewal-lapsed, 61500 ms since the last confirmed lease renewal (lease lifetime 60000 ms)');
    expect(lines[0]).not.toContain(h.token.split(':')[1]);
    expect(lines[0]).not.toContain('-100123');
    expect(h.held).toHaveBeenCalledOnce();
    expect(h.held.mock.calls[0][0]).toMatchObject({ operationId: id, reason: 'lease-freshness-lapsed', chatId: '-100123', topicId: '42' });
    expect(h.onSessionDeliveryHeld).not.toHaveBeenCalled();
    expect(h.runtime.service.heldReason(id)).toBe('lease-freshness-lapsed');
    expect(h.runtime.service.wasLeaseHeldInMemory(id)).toBe(true);
    expect(h.runtime.leaseRetryState()).toEqual({ step: 0 });
  });
  it('names a loss within the lifetime, or an unmeasured one, as lease-not-held-at-send', async () => {
    const superseded = await harness({ verdict: 'superseded' });
    superseded.lease.held = false; superseded.lease.gapMs = 20_000;
    await expect(superseded.send()).rejects.toMatchObject({ reason: 'lease-not-held-at-send' });
    expect(superseded.held.mock.calls[0][0]).toMatchObject({ reason: 'lease-not-held-at-send' });
    const unmeasured = await harness({ reader: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    unmeasured.lease.held = false;
    await expect(unmeasured.send()).rejects.toMatchObject({ reason: 'lease-not-held-at-send' });
    expect(warn.mock.calls.map(call => String(call[0])).find(line => line.includes('lease-not-held-at-send: held'))).toContain('lease verdict unknown, renewal gap unknown');
  });
  it('keeps credential-capacity-unavailable for every other cause', async () => {
    const h = await harness();
    vi.spyOn(h.runtime.service.options.capacity!, 'reserveExplained').mockResolvedValue({ grant: null, refusal: { cause: 'rate-window-full', leaseFreshness: null } });
    await expect(h.send()).rejects.toMatchObject({ reason: 'credential-capacity-unavailable' });
    expect(h.held).toHaveBeenCalledOnce();
    expect(h.held).toHaveBeenCalledWith(expect.objectContaining({
      operationId: await h.operationId(), reason: 'credential-capacity-unavailable', topicId: '42',
    }));
    expect(h.runtime.leaseRetryState()).toBeNull();
    expect(h.onSessionDeliveryHeld).toHaveBeenCalledOnce(); // today's live notice path, unchanged for the other causes
  });
  it('is skipped by the recovery pass while the lease is away, then sent once when it returns, with the count closed', async () => {
    const h = await harness({ schedule: [60_000, 60_000, 60_000, 60_000] }); // the timer stays out of this test
    h.lease.held = false;
    await expect(h.send()).rejects.toMatchObject({ reason: 'lease-freshness-lapsed' });
    const id = await h.operationId();
    await delay(2_200); // the durable row is due
    expect(await h.runtime.recoverHeld()).toEqual({ processed: 0, recovered: 0 });
    expect(h.network).not.toHaveBeenCalled();
    expect((await h.runtime.store.getOperation(id))!.recovery ?? null).toBeNull(); // no reservation, no ladder step
    h.lease.held = true;
    const heldAt = Date.now();
    expect(await h.runtime.recoverHeld()).toMatchObject({ recovered: 1 });
    expect(h.network).toHaveBeenCalledOnce();
    expect(h.runtime.service.heldReason(id)).toBeNull();
    expect(h.delivered).toHaveBeenCalledWith(expect.objectContaining({ operationId: id }));
    expect(h.delivered.mock.calls[0][0].deliveredAt).toBeGreaterThanOrEqual(heldAt - 5);
    expect((await h.runtime.store.getOperation(id))!.operation?.state).toBe('accepted');
    expect(h.onSessionDeliveryHeld).not.toHaveBeenCalled();
  });
  it('delivers by itself through the armed timer once the lease is held again', async () => {
    const h = await harness();
    h.lease.held = false;
    await expect(h.send()).rejects.toMatchObject({ reason: 'lease-freshness-lapsed' });
    const id = await h.operationId();
    h.lease.held = true; // back before the first step (2.1 s) fires
    await vi.waitFor(() => expect(h.network).toHaveBeenCalledOnce(), { timeout: 6_000, interval: 100 });
    await vi.waitFor(() => expect(h.delivered).toHaveBeenCalledWith(expect.objectContaining({ operationId: id })), { timeout: 2_000 });
    await vi.waitFor(() => expect(h.runtime.leaseRetryState()).toBeNull(), { timeout: 2_000 });
    expect((await h.runtime.store.getOperation(id))!.operation?.state).toBe('accepted');
  }, 15_000);
  it('ends the episode after its last step with no item when the lease never returns, inside the wake budget', async () => {
    const h = await harness({ schedule: [100, 100, 100, 100] });
    h.lease.held = false;
    await expect(h.send()).rejects.toMatchObject({ reason: 'lease-freshness-lapsed' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await vi.waitFor(() => expect(h.runtime.leaseRetryState()).toBeNull(), { timeout: 3_000, interval: 50 });
    expect(warn.mock.calls.map(call => String(call[0])).filter(line => line.includes('lease still not held after'))).toHaveLength(1);
    expect(h.network).not.toHaveBeenCalled();
    expect(h.onSessionDeliveryHeld).not.toHaveBeenCalled();
    // The four wakes spent the lifetime's budget: a second refusal arms nothing until the window passes.
    await expect(h.send('A second status.')).rejects.toMatchObject({ reason: 'lease-freshness-lapsed' });
    expect(h.runtime.leaseRetryState()).toBeNull();
  });
  it('moves the review-schedule row to the short next attempt when a replay is refused at the boundary', async () => {
    const h = await harness({ schedule: [60_000, 60_000, 60_000, 60_000] });
    h.lease.held = false;
    await expect(h.send()).rejects.toMatchObject({ reason: 'lease-freshness-lapsed' });
    const id = await h.operationId();
    await delay(2_200);
    h.lease.held = true;
    h.lease.boundaryRefusals = 1; // the pass sees the lease held; the boundary read, one call later, sees it lapsed again
    const before = Date.now();
    expect(await h.runtime.recoverHeld()).toMatchObject({ processed: 1, recovered: 0 });
    expect(h.network).not.toHaveBeenCalled();
    const row = (await h.runtime.store.getOperation(id))!;
    expect(row.recovery).toMatchObject({ attempts: 1 });
    expect(row.recovery!.nextAttemptAt - before).toBeLessThanOrEqual(2_500); // the 30 s rung was moved to the 2 s step
    expect(row.attempts.filter(a => a.reason === 'lease-freshness-lapsed')).toHaveLength(2);
    await delay(2_200);
    expect(await h.runtime.recoverHeld()).toMatchObject({ recovered: 1 });
    expect(h.network).toHaveBeenCalledOnce();
  }, 15_000);
});
