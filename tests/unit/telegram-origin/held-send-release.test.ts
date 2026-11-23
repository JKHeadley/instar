/**
 * held-and-startup-parked-send-release — Tier 1: the startup-beacon proof (pinned to the beacon's
 * own builder), the staleness bound, retirement in the real store, the outcome reading, and the
 * stale gate inside forwarded-hold recovery.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { OriginStore } from '../../../src/messaging/telegram-origin/OriginStore.js';
import { OriginSessionRegistry } from '../../../src/messaging/telegram-origin/OriginSessionRegistry.js';
import { RuntimeOriginObserver } from '../../../src/messaging/telegram-origin/RuntimeOriginObserver.js';
import { TelegramOriginService } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import { PendingRelayStore } from '../../../src/messaging/pending-relay-store.js';
import { isBootBeaconBody } from '../../../src/messaging/telegram-origin/OriginLegacy.js';
import { bootBeaconResponseBody } from '../../../src/server/BootHealthBeacon.js';
import { BootReadinessTracker } from '../../../src/server/BootReadiness.js';
import { classifyOperationOutcome } from '../../../src/messaging/telegram-origin/OriginOperationOutcome.js';
import { firstAuthoredAt, isStaleRelease, retirementSessionLine, STALE_HELD_RELEASE_MS } from '../../../src/messaging/telegram-origin/SessionDeliveryNotice.js';
import { HOLD_REASON_LEASE_NOT_HELD, recoverForwardedHold } from '../../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { ForwardLeaseView, HeldForwardDetail, HolderReceiptAnswer, HolderSubmitResult } from '../../../src/messaging/telegram-origin/OriginForwardToHolder.js';
import type { OriginPreparedBotOperation } from '../../../src/messaging/telegram-origin/TelegramOriginService.js';
import type { HeldOperationRow } from '../../../src/messaging/telegram-origin/StoreTypes.js';
import { compileOriginWorker, temporaryState } from '../../helpers/telegramOriginStore.js';
import { fixtureOriginContentDedup } from '../../helpers/originContentDedup.js';

const MIN = 60_000;
const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
let worker: URL;
const stores: OriginStore[] = [];
beforeAll(async () => { worker = await compileOriginWorker(); });
afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.close())); });

/** The exact body the Studio's queue stored for the Chief of Staff note (2026-11-21, delivery ac8202cb). */
const STUDIO_BEACON_BODY = JSON.stringify({ error: 'starting', status: 'starting', message: 'The server is starting. Retry after 21 s.', retryAfterSeconds: 21,
  bootReadiness: { state: 'starting', startedAt: '2026-11-21T08:44:36.019Z', elapsedMs: 56062, readyAt: null,
    earlyListen: { at: '2026-11-21T08:44:36.728Z', host: '0.0.0.0' }, phase: 'scheduler',
    subsystems: { config: 'ready', 'instance-lock': 'ready', 'multi-machine': 'ready', scheduler: 'pending', messaging: 'pending', sessions: 'not-started', http: 'not-started' },
    lastBootMs: 61000, retryAfterSeconds: 21 } });

async function harness() {
  const stateDir = temporaryState();
  const store = await OriginStore.open({ stateDir, agentId: 'echo' }, worker); stores.push(store);
  const sessions = new OriginSessionRegistry({ stateDir, agentId: 'echo', machineId: 'studio', isSessionLive: () => true });
  await sessions.initialize();
  const service = new TelegramOriginService({ store, sessions, observer: new RuntimeOriginObserver(),
    sendPolicy: { review: async () => ({ ok: true }), authorizeDispatch: () => ({ ok: true }), ...fixtureOriginContentDedup(stateDir) },
    identity: { agentId: 'echo', agentName: 'Echo', originMachineId: 'studio', originMachineName: 'Mac Studio' },
    signingKey: { privateKey: key, keyEpoch: 1, keyId: 'studio-1' }, ownerBootId: 'boot-1',
    display: () => ({}), authorize: vi.fn(async () => true), onHold: vi.fn(), spoolEvidence: vi.fn(async () => { throw new Error('spool unavailable'); }),
    reviewLegacyRecovery: async () => true });
  const queue = PendingRelayStore.open('echo', stateDir);
  /** A direct reply this machine prepared and admitted (an ordinary fresh reply, not held). */
  const admitted = async (text = 'A direct answer', ageMs = 0) => {
    const realNow = service.options.now;
    service.options.now = () => Date.now() - ageMs;
    const op = service.runAsAutomation('telegram-server', () => service.prepareBot({ method: 'sendMessage', accountId: 'bot-1',
      params: { chat_id: '-100123', message_thread_id: 42, text } }));
    service.options.now = realNow;
    await service.admit(op);
    return op;
  };
  return { stateDir, store, service, queue, admitted };
}

describe('the startup-beacon proof is pinned to the beacon builder', () => {
  it('accepts the body the beacon really sends (every subsystem, a previous restart) and the exact Studio body', () => {
    const tracker = new BootReadinessTracker(() => Date.now(), Date.now() - 50_000);
    tracker.markListeningEarly('0.0.0.0');
    const body = bootBeaconResponseBody(tracker.snapshot({ includePreviousRestart: true }), 7);
    expect(isBootBeaconBody(body)).toBe(true);
    expect(isBootBeaconBody(STUDIO_BEACON_BODY)).toBe(true);
    expect(isBootBeaconBody('{"status":"warming","phase":"booting"}')).toBe(true);
  });
  it('refuses lookalikes: an extra key, another status, a reworded message, a ready snapshot, junk', () => {
    const base = JSON.parse(STUDIO_BEACON_BODY);
    expect(isBootBeaconBody(JSON.stringify({ ...base, relayedFromHolder: true }))).toBe(false);
    expect(isBootBeaconBody(JSON.stringify({ ...base, status: 'ok' }))).toBe(false);
    expect(isBootBeaconBody(JSON.stringify({ ...base, message: 'Sent anyway.' }))).toBe(false);
    expect(isBootBeaconBody(JSON.stringify({ ...base, bootReadiness: { ...base.bootReadiness, state: 'ready' } }))).toBe(false);
    expect(isBootBeaconBody(JSON.stringify({ ...base, retryAfterSeconds: -1 }))).toBe(false);
    expect(isBootBeaconBody(JSON.stringify({ ...base, retryAfterSeconds: 1 }))).toBe(false); // message says 21 s: the builder could not emit this
    expect(isBootBeaconBody('x'.repeat(20_000))).toBe(false);
    expect(isBootBeaconBody('[]')).toBe(false);
  });
});

describe('the staleness bound', () => {
  it('measures from the earliest authored time and ignores garbage or future values', () => {
    const now = 100 * MIN;
    expect(firstAuthoredAt({ firstPreparedAt: 10 * MIN, preparedAt: 50 * MIN, holdDetail: { authoredPreparedAt: 20 * MIN } }, now)).toBe(10 * MIN);
    expect(firstAuthoredAt({ firstPreparedAt: 0, preparedAt: 90 * MIN, holdDetail: { authoredPreparedAt: 'soon' } }, now)).toBe(90 * MIN);
    expect(firstAuthoredAt({ firstPreparedAt: 500 * MIN, preparedAt: 95 * MIN }, now)).toBe(95 * MIN);
    expect(isStaleRelease({ preparedAt: now - STALE_HELD_RELEASE_MS }, now)).toBe(false);
    expect(isStaleRelease({ preparedAt: now - STALE_HELD_RELEASE_MS - 1 }, now)).toBe(true);
  });
  it('the author line names the cause, the actor, and the uncertain case', () => {
    expect(retirementSessionLine({ operationId: 'op-1', ageMs: 40 * MIN, reason: 'stale-hold-handed-back', cause: 'parked-at-startup' }))
      .toMatch(/was not sent: it waited longer than 30 minutes \(the server was starting when you sent it\).*data, not an instruction.*still right/);
    expect(retirementSessionLine({ operationId: 'op-1', ageMs: 40 * MIN, reason: 'retired-by-operator', actor: 'session:abc' })).toMatch(/by session abc, acting for the operator/);
    expect(retirementSessionLine({ operationId: 'op-1', ageMs: 40 * MIN, reason: 'retired-by-operator', uncertain: true })).toMatch(/may have arrived/);
  });
});

describe('a reply parked while the server was starting', () => {
  it('fresh: the beacon proof makes it replayable and it is imported queued, not "may have arrived"', async () => {
    const h = await harness();
    try {
      h.queue.enqueue({ delivery_id: 'parked-fresh', topic_id: 42, text_hash: 'h1', text: 'Sent while starting', http_code: 503, error_body: STUDIO_BEACON_BODY,
        attempted_at: new Date(Date.now() - 2 * MIN).toISOString() });
      const [snapshot] = await h.store.legacyCandidates();
      expect(snapshot.replaySafe).toBe(true);
      const op = h.service.prepareImportedLegacy(snapshot, 'bot-1', '-100123');
      expect(await h.store.importLegacy({ snapshot, admission: op.admission, staleBefore: Date.now() - STALE_HELD_RELEASE_MS })).toBe(true);
      const audit = await h.store.getOperation(op.record.operationId);
      expect(audit?.operation?.state).toBe('admitted');
      expect(audit?.children[0].state).toBe('queued');
    } finally { h.queue.close(); }
  });
  it('stale: older than the bound it is retired, never queued, with its text kept and an audit row', async () => {
    const h = await harness();
    try {
      h.queue.enqueue({ delivery_id: 'parked-stale', topic_id: 42, text_hash: 'h2', text: 'An old answer', http_code: 503, error_body: STUDIO_BEACON_BODY,
        attempted_at: new Date(Date.now() - 45 * MIN).toISOString() });
      const [snapshot] = await h.store.legacyCandidates();
      const op = h.service.prepareImportedLegacy(snapshot, 'bot-1', '-100123');
      expect(await h.store.importLegacy({ snapshot, admission: op.admission, staleBefore: Date.now() - STALE_HELD_RELEASE_MS })).toBe('stale-retired');
      const audit = await h.store.getOperation(op.record.operationId);
      expect(audit?.operation).toMatchObject({ state: 'suppressed', holdReason: 'stale-hold-handed-back' });
      expect(audit?.operation?.holdDetail).toMatchObject({ text: 'An old answer', neverAttempted: true, retireCause: 'parked-at-startup' });
      expect(audit?.children[0].state).toBe('suppressed');
      expect(await h.store.getRetirement(op.record.operationId)).toMatchObject({ reason: 'stale-hold-handed-back', cause: 'parked-at-startup', actor: 'system:stale-bound', reportedAt: null });
      expect(classifyOperationOutcome(op.record.operationId, audit, [])).toMatchObject({ outcome: 'not-delivered', safeToResend: true, reason: 'stale-hold-handed-back' });
      expect(await h.store.recoverableAdmissions()).toEqual([]);
    } finally { h.queue.close(); }
  });
  it('an unproved 503 stays terminal and its outcome reads unknown, not "pending, the server retries"', async () => {
    const h = await harness();
    try {
      h.queue.enqueue({ delivery_id: 'real-503', topic_id: 42, text_hash: 'h3', text: 'Maybe sent', http_code: 503, error_body: '{"error":"origin-unavailable"}' });
      const [snapshot] = await h.store.legacyCandidates();
      const op = h.service.prepareImportedLegacy(snapshot, 'bot-1', '-100123');
      expect(await h.store.importLegacy({ snapshot, admission: op.admission, staleBefore: Date.now() - STALE_HELD_RELEASE_MS })).toBe(true);
      const audit = await h.store.getOperation(op.record.operationId);
      expect(audit?.operation?.state).toBe('outcome-unknown');
      expect(classifyOperationOutcome(op.record.operationId, audit, [])).toMatchObject({ outcome: 'unknown', safeToResend: false });
    } finally { h.queue.close(); }
  });
});

describe('retireHeldOperation in the real store', () => {
  it('refuses a fresh reply that was never held, an unknown id, and a retired one twice', async () => {
    const h = await harness();
    try {
      const fresh = await h.admitted();
      expect(await h.store.retireHeldOperation({ operationId: fresh.record.operationId, reason: 'retired-by-operator', actor: 'api-token' })).toEqual({ retired: false, refusal: 'not-held' });
      expect(await h.store.retireHeldOperation({ operationId: 'no-such-operation', reason: 'retired-by-operator', actor: 'api-token' })).toEqual({ retired: false, refusal: 'unknown-operation' });
      expect(await h.store.recordOperationState({ operationId: fresh.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD })).toBe(true);
      expect(await h.store.wasLeaseHeld(fresh.record.operationId)).toBe(true);
      expect(await h.store.retireHeldOperation({ operationId: fresh.record.operationId, reason: 'retired-by-operator', actor: 'session:s1', note: 'not needed' }))
        .toMatchObject({ retired: true, uncertain: false, topicId: '42' });
      expect(await h.store.retireHeldOperation({ operationId: fresh.record.operationId, reason: 'retired-by-operator', actor: 'api-token' })).toEqual({ retired: false, refusal: 'already-retired' });
      const audit = await h.store.getOperation(fresh.record.operationId);
      expect(classifyOperationOutcome(fresh.record.operationId, audit, [])).toMatchObject({ outcome: 'not-delivered', safeToResend: false, reason: 'retired-by-operator' });
      expect(await h.store.getRetirement(fresh.record.operationId)).toMatchObject({ actor: 'session:s1', note: 'not needed', priorState: 'held', priorHoldReason: 'lease-not-held' });
    } finally { h.queue.close(); }
  });
  it('no resurrection: a retired row can never be held again (so a racing recovery cannot re-hold and send it)', async () => {
    const h = await harness();
    try {
      const op = await h.admitted();
      await h.store.recordOperationState({ operationId: op.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD });
      await h.store.retireHeldOperation({ operationId: op.record.operationId, reason: 'stale-hold-handed-back', actor: 'system:stale-bound', cause: 'held-lease' });
      expect(await h.store.recordOperationState({ operationId: op.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD,
        holdDetail: { kind: 'forward-to-holder', lastAttempt: 'local-sent' } })).toBe(false);
      expect(await h.store.reserveRecoveryAttempt({ operationId: op.record.operationId })).toBe(false);
    } finally { h.queue.close(); }
  });
  it('refuses a forward whose last attempt may have arrived, for both reasons', async () => {
    const h = await harness();
    try {
      const op = await h.admitted();
      await h.store.recordOperationState({ operationId: op.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD,
        holdDetail: { kind: 'forward-to-holder', lastAttempt: 'outcome-unknown', machineId: 'mini', topicId: 42, chatId: '-100123', text: 'x' } });
      for (const reason of ['stale-hold-handed-back', 'retired-by-operator'] as const) {
        expect(await h.store.retireHeldOperation({ operationId: op.record.operationId, reason, actor: 'api-token' })).toEqual({ retired: false, refusal: 'uncertain' });
      }
    } finally { h.queue.close(); }
  });
  it('re-admitting a direct lease hold keeps the durable marker (a pre-upgrade hold gains it)', async () => {
    const h = await harness();
    try {
      const op = await h.admitted();
      await h.store.recordOperationState({ operationId: op.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD });
      expect(await h.store.readmitLeaseHold({ operationId: op.record.operationId })).toBe(true);
      const audit = await h.store.getOperation(op.record.operationId);
      expect(audit?.operation).toMatchObject({ state: 'admitted' });
      expect(await h.store.wasLeaseHeld(op.record.operationId)).toBe(true);
      // Admitted with the marker is still custody: the operator may retire it.
      expect(await h.store.retireHeldOperation({ operationId: op.record.operationId, reason: 'retired-by-operator', actor: 'api-token' })).toMatchObject({ retired: true });
    } finally { h.queue.close(); }
  });
  it('a holder retirement ends the forward and records the row for its author in one step', async () => {
    const h = await harness();
    try {
      const op = await h.admitted();
      await h.store.recordOperationState({ operationId: op.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD,
        holdDetail: { kind: 'forward-to-holder', lastAttempt: 'refused', machineId: 'mini', topicId: 42, chatId: '-100123', text: 'x' } });
      expect(await h.store.recordHolderRetirement({ operationId: op.record.operationId, reason: 'stale-hold-handed-back', holderMachineId: 'mini' })).toBe(true);
      const audit = await h.store.getOperation(op.record.operationId);
      expect(audit?.operation).toMatchObject({ state: 'suppressed', holdReason: 'suppressed-at-holder' });
      expect(await h.store.getRetirement(op.record.operationId)).toMatchObject({ actor: 'holder:mini', reason: 'stale-hold-handed-back' });
      expect(classifyOperationOutcome(op.record.operationId, audit, [])).toMatchObject({ outcome: 'not-delivered', safeToResend: true });
    } finally { h.queue.close(); }
  });
  it('report rows back off on failure and are listed oldest first until reported', async () => {
    const h = await harness();
    try {
      const op = await h.admitted();
      await h.store.recordOperationState({ operationId: op.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD });
      await h.store.retireHeldOperation({ operationId: op.record.operationId, reason: 'retired-by-operator', actor: 'api-token' });
      const now = Date.now() + 1000;
      expect((await h.store.unreportedRetirements({ now })).map(r => r.operationId)).toEqual([op.record.operationId]);
      expect(await h.store.markRetirementReport({ operationId: op.record.operationId, outcome: null, now })).toBe(true);
      expect(await h.store.unreportedRetirements({ now })).toEqual([]);
      expect((await h.store.unreportedRetirements({ now: now + MIN + 1 })).length).toBe(1);
      expect(await h.store.markRetirementReport({ operationId: op.record.operationId, outcome: 'session-line', now })).toBe(true);
      expect(await h.store.unreportedRetirements({ now: now + 2 * 3_600_000 })).toEqual([]);
    } finally { h.queue.close(); }
  });
});

describe('the stale gate in forwarded-hold recovery', () => {
  const NOW = 50_000_000;
  const lease = (o: Partial<ForwardLeaseView> = {}): ForwardLeaseView => ({ selfMachineId: 'author', leaseHolder: () => 'holder', holdsLease: () => false, isHolderHealthy: () => true, ...o });
  const operation = (owner: string, id = 'op-1'): OriginPreparedBotOperation => ({
    record: { operationId: id, originId: `origin-${id}`, originMachineId: 'author', executionOwnerMachineId: owner, producerKind: 'session', operationKind: 'sendMessage', sessionId: 's1', harnessId: 'claude-code' } as never,
    admission: { operationId: id, children: [{ materializations: [{ requestJson: JSON.stringify({ method: 'sendMessage', policy: { text: 'The answer.' } }) }] }] } as never });
  const row = (detail: Partial<HeldForwardDetail>, ageMs: number): HeldOperationRow => ({ operationId: 'op-1', originId: 'o', state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD,
    holdDetail: { kind: 'forward-to-holder', lastAttempt: 'refused', machineId: 'holder', topicId: 42, chatId: '-100123', text: 'The answer.', reason: 'x', at: 1,
      noticeDelivered: false, ladder: { attempts: 0, nextAt: 5 }, authoredPreparedAt: NOW - ageMs, ...detail },
    preparedAt: NOW - ageMs, deadlineAt: NOW + 6 * 60 * MIN, executionOwnerMachineId: 'holder', destination: { accountId: '1', chatId: '-100123', topicId: '42' },
    recovery: null, expiryReportedAt: null, producerKind: 'session', originMachineId: 'author', sessionId: 's1', harnessId: 'claude-code' });
  function deps(o: Record<string, unknown> = {}) {
    const submit = vi.fn<(holder: string, op: OriginPreparedBotOperation) => Promise<HolderSubmitResult>>(async holder => ({ ok: true, messageId: 9, deliveryMachineId: holder, receiptJson: '{"messageId":9}' }));
    const prepare = vi.fn(async (holder: string) => operation(holder, 'op-next'));
    const sendLocal = vi.fn(async () => ({ messageId: 3 }));
    const receipt = vi.fn<(m: string, id: string) => Promise<HolderReceiptAnswer>>(async () => ({ state: 'unreachable' }));
    const retire = vi.fn(async () => ({ retired: true }));
    const mergeDetail = vi.fn(async () => true);
    const d = { lease: lease(), prepare, submit, receipt, resolve: vi.fn(async () => true), rehold: vi.fn(async () => true), supersede: vi.fn(async () => true),
      sendLocal, settleUnknown: vi.fn(async () => true), mergeDetail, now: () => NOW, staleBound: { afterMs: STALE_HELD_RELEASE_MS, retire }, ...o };
    return { d, submit, prepare, sendLocal, receipt, retire, mergeDetail };
  }
  it('fresh rows are forwarded exactly as before', async () => {
    const t = deps();
    expect(await recoverForwardedHold(t.d as never, row({}, 5 * MIN), operation('holder'))).toBe('sent');
    expect(t.retire).not.toHaveBeenCalled();
  });
  it('a stale row is retired, not re-forwarded, not replaced, not sent locally (the holder and self routes alike)', async () => {
    for (const holder of ['holder', 'author']) {
      const t = deps({ lease: lease({ leaseHolder: () => holder, holdsLease: () => holder === 'author' }) });
      expect(await recoverForwardedHold(t.d as never, row({}, 31 * MIN), operation('holder'))).toBe('retired');
      expect(t.retire).toHaveBeenCalledWith('op-1');
      expect(t.submit).not.toHaveBeenCalled(); expect(t.prepare).not.toHaveBeenCalled(); expect(t.sendLocal).not.toHaveBeenCalled();
    }
  });
  it('a refused retirement never falls through to a send', async () => {
    const t = deps();
    t.retire.mockResolvedValue({ retired: false, refusal: 'in-flight' } as never);
    expect(await recoverForwardedHold(t.d as never, row({}, 40 * MIN), operation('holder'))).toBe('retained');
    expect(t.submit).not.toHaveBeenCalled(); expect(t.sendLocal).not.toHaveBeenCalled();
  });
  it('the four Studio rows: outcome-unknown is resolved at the receipt first; a stale older-owner reasonless answer settles, never a replacement', async () => {
    const unreachable = deps();
    expect(await recoverForwardedHold(unreachable.d as never, row({ lastAttempt: 'outcome-unknown', machineId: 'mini' }, 3 * 60 * MIN), operation('mini'))).toBe('retained');
    expect(unreachable.retire).not.toHaveBeenCalled(); expect(unreachable.submit).not.toHaveBeenCalled();
    const reasonless = deps();
    reasonless.receipt.mockResolvedValue({ state: 'owner-reasonless', olderOwner: true });
    await recoverForwardedHold(reasonless.d as never, row({ lastAttempt: 'outcome-unknown', machineId: 'mini' }, 3 * 60 * MIN), operation('mini'));
    expect(reasonless.prepare).not.toHaveBeenCalled(); expect(reasonless.submit).not.toHaveBeenCalled();
    expect(reasonless.mergeDetail).toHaveBeenCalledWith('op-1', expect.objectContaining({ ownerUnstated: expect.objectContaining({ settled: true }) }));
  });
  it('a local-sent row (the user may already have it) is never retired as "not sent"', async () => {
    const t = deps({ lease: lease({ leaseHolder: () => 'author', holdsLease: () => true }) });
    expect(await recoverForwardedHold(t.d as never, row({ lastAttempt: 'local-sent' }, 60 * MIN), operation('holder'))).toBe('retained');
    expect(t.retire).not.toHaveBeenCalled(); expect(t.sendLocal).not.toHaveBeenCalled();
  });
  it('the holder retired its copy: the author machine records it as retired through onHolderRetired', async () => {
    const onHolderRetired = vi.fn(async () => true);
    const t = deps({ onHolderRetired });
    t.receipt.mockResolvedValue({ state: 'owner-ended', reason: 'stale-hold-handed-back' });
    expect(await recoverForwardedHold(t.d as never, row({ lastAttempt: 'outcome-unknown', machineId: 'mini' }, 10 * MIN), operation('mini'))).toBe('retired');
    expect(onHolderRetired).toHaveBeenCalledWith('op-1', 'stale-hold-handed-back', 'mini', expect.anything());
  });
});

describe('a successor of a pre-upgrade lease hold inherits the marker', () => {
  it('supersedeWithAdmission marks the successor when the old row is held lease-not-held, even with no marker yet', async () => {
    const h = await harness();
    try {
      const old = await h.admitted('The original held reply text for the marker test.');
      await h.store.recordOperationState({ operationId: old.record.operationId, state: 'held', holdReason: HOLD_REASON_LEASE_NOT_HELD });
      const next = await (async () => {
        const op = h.service.runAsAutomation('telegram-server', () => h.service.prepareBot({ method: 'sendMessage', accountId: 'bot-1',
          params: { chat_id: '-100123', message_thread_id: 42, text: 'The successor of the held reply for the marker test.' } }));
        return op;
      })();
      expect(await h.store.supersedeWithAdmission({ operationId: old.record.operationId, admission: next.admission, holdReason: null, holdDetail: null,
        replacementState: 'admitted' })).toBe(true);
      expect(await h.store.wasLeaseHeld(next.record.operationId)).toBe(true);
    } finally { h.queue.close(); }
  });
});
