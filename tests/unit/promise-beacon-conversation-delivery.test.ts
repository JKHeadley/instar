/**
 * promise-beacon-conversation-delivery.test.ts — the §6.1 step-2 funnel swap
 * (durable-conversation-identity). PromiseBeacon.emitUserSend now routes every
 * send through deliverToConversation when wired; applyDeliveryOutcome maps the
 * typed §5.1/§5.0(a) outcomes onto the beacon's durable sequencing + failure
 * state.
 *
 * Both sides of every boundary (Testing Integrity):
 *  - delivered / delivered-equivalent → sendSeq advances (R7-M1) + retireSend.
 *  - not-delivered + standDown        → stood down, no re-fire (R3-M16).
 *  - not-delivered + permanent        → dead-letter + beaconSuppressed (§5.1).
 *  - not-delivered transient          → seq HELD, N-fail dead-letter (R3-M15).
 *  - funnel UNWIRED                   → legacy sendMessage passthrough.
 *  - a thrown send                    → fire() re-arms in finally (safety).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CommitmentTracker, type Commitment } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { LlmQueue } from '../../src/monitoring/LlmQueue.js';
import { ProxyCoordinator } from '../../src/monitoring/ProxyCoordinator.js';
import { PromiseBeacon, type BeaconSendResult } from '../../src/monitoring/PromiseBeacon.js';
import type { DeliveryOutcome } from '../../src/core/deliverToConversation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TelegramOriginHoldError } from '../../src/messaging/telegram-origin/types.js';

function commitment(over: Partial<Commitment>): Commitment {
  return {
    id: 'CMT-001',
    userRequest: 'do x',
    agentResponse: 'I will report back in 10 minutes',
    type: 'one-time-action',
    status: 'pending',
    createdAt: new Date().toISOString(),
    verificationCount: 0,
    violationCount: 0,
    topicId: -111, // a minted Slack conversation id
    owner: 'agent',
    blockedOn: 'none',
    ...over,
  } as Commitment;
}

describe('PromiseBeacon conversation-delivery funnel swap (§6.1 step 2)', () => {
  let dir: string;
  let deliverCalls: Array<{ topicId: number; text: string; logicalSendId?: string }>;
  let retireCalls: Array<{ conversationId: number; logicalSendId: string }>;
  let legacySends: Array<{ topicId: number; text: string }>;
  let attention: Array<{ id: string; detail: string }>;
  let nextOutcome: DeliveryOutcome;
  let ownsResult: boolean;
  let originConfirmed: boolean;
  let beacon: PromiseBeacon;

  const readHot = (id: string): { sendSeq?: number; standDownAt?: string } => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'state', 'promise-beacon', `${id}.json`), 'utf-8'));
    } catch {
      return {};
    }
  };

  const makeBeacon = () =>
    new PromiseBeacon({
      userOutputEnabled: true,
      stateDir: dir,
      commitmentTracker: new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) }),
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => '',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (topicId, text) => { legacySends.push({ topicId, text }); },
      raiseAttention: (id, detail) => { attention.push({ id, detail }); },
      deliverMessage: async (topicId, text, opts) => {
        deliverCalls.push({ topicId, text, logicalSendId: opts.logicalSendId });
        return nextOutcome;
      },
      retireSend: (conversationId, logicalSendId) => { retireCalls.push({ conversationId, logicalSendId }); },
      ownsConversation: () => ownsResult,
      resolveOriginDelivery: async () => originConfirmed,
    });

  const emit = (c: Commitment, kind: 'heartbeat' | 'closeOut' | 'rung2' | 'terminal' = 'heartbeat'): Promise<BeaconSendResult> =>
    (beacon as unknown as { emitUserSend: (c: Commitment, t: string, k: string) => Promise<BeaconSendResult> })
      .emitUserSend(c, 'a heartbeat body', kind);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beacon-conv-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({}, null, 2));
    deliverCalls = [];
    retireCalls = [];
    legacySends = [];
    attention = [];
    nextOutcome = { delivered: true, outcome: 'delivered' };
    ownsResult = true;
    originConfirmed = false;
    beacon = makeBeacon();
  });
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/promise-beacon-conversation-delivery.test.ts' });
    } catch {
      /* cleanup */
    }
  });

  it('a wired beacon routes the send through deliverMessage with logicalSendId=<id>:<seq>', async () => {
    const result = await emit(commitment({}));
    expect(result).toBe('sent');
    expect(deliverCalls).toHaveLength(1);
    expect(deliverCalls[0].logicalSendId).toBe('CMT-001:0');
    expect(legacySends).toHaveLength(0); // NOT the legacy path
  });

  it('retains an origin-held operation across retries and restart until its receipt confirms delivery', async () => {
    const c = commitment({ topicId: 42 });
    nextOutcome = { delivered: false, outcome: 'not-delivered', reason: 'telegram-origin-held',
      originHold: { operationId: 'operation-1', outcome: 'outcome-unknown', reason: 'transport-acceptance-unknown' } };
    expect(await emit(c)).toBe('held-origin');
    expect(await emit(c)).toBe('held-origin');
    expect(deliverCalls).toHaveLength(1);
    beacon = makeBeacon();
    expect(await emit(c)).toBe('held-origin');
    expect(deliverCalls).toHaveLength(1);
    expect(readHot(c.id).sendSeq ?? 0).toBe(0);
    originConfirmed = true;
    expect(await emit(c)).toBe('sent');
    expect(deliverCalls).toHaveLength(1);
    expect(readHot(c.id).sendSeq).toBe(1);
    nextOutcome = { delivered: true, outcome: 'delivered' };
    expect(await emit(c)).toBe('sent');
    expect(deliverCalls[1].logicalSendId).toBe(`${c.id}:1`);
    expect(attention).toHaveLength(0);
  });

  it('replays a trusted response-loss hold after restart using the same logical identity', async () => {
    const c = commitment({ topicId: 42 });
    nextOutcome = { delivered: false, outcome: 'not-delivered', reason: 'telegram-origin-held',
      originHold: { operationId: null, outcome: 'outcome-unknown', reason: 'automation-response-unavailable', logicalReplaySafe: true } };
    expect(await emit(c)).toBe('held-origin');
    beacon = makeBeacon();
    nextOutcome = { delivered: true, outcome: 'delivered' };
    expect(await emit(c)).toBe('sent');
    expect(deliverCalls.map(call => call.logicalSendId)).toEqual([`${c.id}:0`, `${c.id}:0`]);
    expect(readHot(c.id).sendSeq).toBe(1);
  });

  it('does not replay an unknown operation without trusted logical replay authority', async () => {
    const c = commitment({ topicId: 42 });
    nextOutcome = { delivered: false, outcome: 'not-delivered', reason: 'telegram-origin-held',
      originHold: { operationId: null, outcome: 'outcome-unknown', reason: 'logical-send-content-conflict' } };
    expect(await emit(c)).toBe('held-origin');
    beacon = makeBeacon();
    expect(await emit(c)).toBe('held-origin');
    expect(deliverCalls).toHaveLength(1);
  });

  it.each([false, true])('settles the old heartbeat then delivers a distinct close-out (response lost: %s)', async responseLost => {
    const c = commitment({ topicId: 42 });
    nextOutcome = { delivered: false, outcome: 'not-delivered', reason: 'telegram-origin-held',
      originHold: { operationId: responseLost ? null : 'heartbeat-operation', outcome: 'outcome-unknown',
        reason: 'response-lost', logicalReplaySafe: responseLost } };
    expect(await emit(c)).toBe('held-origin');
    beacon = makeBeacon();
    originConfirmed = !responseLost;
    nextOutcome = { delivered: true, outcome: 'delivered' };
    const result = await (beacon as unknown as { emitUserSend: (c: Commitment, text: string, kind: string) => Promise<BeaconSendResult> })
      .emitUserSend(c, 'The requested work is complete.', 'closeOut');
    expect(result).toBe('sent');
    expect(deliverCalls.at(-1)).toEqual({ topicId: 42, text: 'The requested work is complete.', logicalSendId: `${c.id}:1` });
    expect(deliverCalls).toHaveLength(responseLost ? 3 : 2);
    if (responseLost) expect(deliverCalls[1]).toEqual(deliverCalls[0]);
    expect(readHot(c.id).sendSeq).toBe(2);
  });

  it('serializes overlapping heartbeat and close-out sequence allocation', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const config = (beacon as unknown as { config: { deliverMessage: (...args: any[]) => Promise<DeliveryOutcome> } }).config;
    const original = config.deliverMessage;
    config.deliverMessage = async (...args) => { const result = await original(...args); await blocked; return result; };
    const c = commitment({ topicId: 42 });
    const heartbeat = emit(c);
    const closeOut = emit(c, 'closeOut');
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(deliverCalls).toHaveLength(1);
    release();
    expect(await Promise.all([heartbeat, closeOut])).toEqual(['sent', 'sent']);
    expect(deliverCalls.map(call => call.logicalSendId)).toEqual([`${c.id}:0`, `${c.id}:1`]);
    expect(readHot(c.id).sendSeq).toBe(2);
  });

  it('also preserves origin custody through the legacy direct-send dependency', async () => {
    const config = (beacon as unknown as { config: { deliverMessage?: unknown; sendMessage: () => Promise<void> } }).config;
    delete config.deliverMessage;
    let sends = 0;
    config.sendMessage = async () => { sends++; throw new TelegramOriginHoldError('response-lost', 'legacy-operation', 'outcome-unknown'); };
    expect(await emit(commitment({ topicId: 42 }))).toBe('held-origin');
    expect(await emit(commitment({ topicId: 42 }))).toBe('held-origin');
    expect(sends).toBe(1);
    expect(readHot('CMT-001').sendSeq ?? 0).toBe(0);
  });

  it('a delivered outcome advances + persists sendSeq and retires the logical send (R5-M3 order)', async () => {
    await emit(commitment({}));
    expect(readHot('CMT-001').sendSeq).toBe(1);
    expect(retireCalls).toEqual([{ conversationId: -111, logicalSendId: 'CMT-001:0' }]);
  });

  it('already-delivered-recently is DELIVERED-EQUIVALENT — seq advances so the next tick is a NEW send (R7-M1 un-mute)', async () => {
    nextOutcome = { delivered: false, outcome: 'already-delivered-recently' };
    const result = await emit(commitment({}));
    expect(result).toBe('suppressed-delivered-equivalent');
    expect(readHot('CMT-001').sendSeq).toBe(1); // advanced → next tick sends seq 1
    expect(retireCalls).toHaveLength(1);
  });

  it('a non-owning standDown refusal stands the commitment down (no re-fire) — NEVER the legacy path', async () => {
    nextOutcome = { delivered: false, outcome: 'not-delivered', reason: 'replicated-only-origin', standDown: true };
    const result = await emit(commitment({}));
    expect(result).toBe('failed-standdown');
    expect(readHot('CMT-001').standDownAt).toBeTruthy();
    // seq is NOT advanced on a stand-down.
    expect(readHot('CMT-001').sendSeq ?? 0).toBe(0);
  });

  it('the stand-down recheck picks the beacon back up when this machine BECOMES the owner (R3-M16)', async () => {
    const tracker = (beacon as unknown as { config: { commitmentTracker: CommitmentTracker } }).config.commitmentTracker;
    const rec = tracker.record({ type: 'one-time-action', userRequest: 'x', agentResponse: 'y', topicId: -222 });
    nextOutcome = { delivered: false, outcome: 'not-delivered', reason: 'replicated-only-origin', standDown: true };
    beacon.start();
    await emit(rec);
    expect(readHot(rec.id).standDownAt).toBeTruthy();
    let cleared = false;
    beacon.on('delivery.stand-down-cleared', () => { cleared = true; });
    // Not the owner yet → the recheck leaves it stood down.
    ownsResult = false;
    beacon.recheckStandDowns();
    expect(cleared).toBe(false);
    // This machine BECOMES the owner (adoption) → the recheck clears + re-schedules.
    ownsResult = true;
    beacon.recheckStandDowns();
    expect(cleared).toBe(true);
    beacon.stop();
  });

  it('a permanent §5.1 failure dead-letters (raiseAttention) and suppresses the beacon', async () => {
    nextOutcome = { delivered: false, outcome: 'not-delivered', reason: 'conversation-unreachable', permanent: true, detail: 'is_archived' };
    const tracker = (beacon as unknown as { config: { commitmentTracker: CommitmentTracker } }).config.commitmentTracker;
    const c = tracker.record({ type: 'one-time-action', userRequest: 'x', agentResponse: 'y', topicId: 999 });
    const result = await emit({ ...c, topicId: -111 } as Commitment);
    expect(result).toBe('failed-permanent');
    expect(attention.some((a) => a.detail.includes('permanently failing'))).toBe(true);
  });

  it('a transient failure HOLDS the seq and dead-letters only after N consecutive failures (R3-M15)', async () => {
    nextOutcome = { delivered: false, outcome: 'not-delivered', reason: 'send-failed', detail: 'ambiguous: socket hang up' };
    const c = commitment({});
    await emit(c);
    await emit(c);
    expect(attention).toHaveLength(0); // below the threshold (default 3)
    await emit(c);
    expect(attention.some((a) => a.detail.includes('consecutive delivery failures'))).toBe(true);
    // The seq is NEVER advanced on a transient failure (so the re-fire matches E1).
    expect(readHot('CMT-001').sendSeq ?? 0).toBe(0);
  });

  it('an UNWIRED beacon (no deliverMessage) falls back to the legacy sendMessage path byte-for-byte', async () => {
    const legacy = new PromiseBeacon({
      userOutputEnabled: true,
      stateDir: dir,
      commitmentTracker: new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir) }),
      llmQueue: new LlmQueue({ maxDailyCents: 100 }),
      proxyCoordinator: new ProxyCoordinator(),
      captureSessionOutput: () => '',
      getSessionForTopic: () => 'sess-1',
      isSessionAlive: () => true,
      sendMessage: async (topicId, text) => { legacySends.push({ topicId, text }); },
    });
    const result = await (legacy as unknown as { emitUserSend: (c: Commitment, t: string, k: string) => Promise<BeaconSendResult> })
      .emitUserSend(commitment({ topicId: 42 }), 'legacy body', 'heartbeat');
    expect(result).toBe('sent');
    expect(legacySends).toEqual([{ topicId: 42, text: 'legacy body' }]);
    expect(deliverCalls).toHaveLength(0);
  });
});
