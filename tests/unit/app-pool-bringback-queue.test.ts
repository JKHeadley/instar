/**
 * Two fixes found by the first real two-machine move (pool-proof-1107, step 7):
 *  1. "Bring it back here" stayed hidden for 15 minutes after the owner stopped: placement read the
 *     owner's liveness "live", which deriveLiveness keeps until the failover threshold.
 *  2. On an agent without Telegram, no queued app message could be delivered: the queue reached the
 *     app tail only through the local tail, which only the Telegram wiring sets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PendingInboundStore } from '../../src/core/PendingInboundStore.js';
import { QueueDrainLoop, type QueueDrainLoopDeps, type DrainDispatchResult, type DrainMessage } from '../../src/core/QueueDrainLoop.js';
import { DEFAULT_INBOUND_QUEUE_CONFIG, DEFAULT_HOLD_FOR_STABILITY_CONFIG } from '../../src/core/inboundQueueConfig.js';
import { appPlacement, ownerAnswering } from '../../src/core/appConversationMove.js';
import { dispatchQueuedInbound } from '../../src/core/appConversationPool.js';
import { deriveLiveness, type DirectAttempt } from '../../src/core/machineLiveness.js';
import { READINESS_CONTACT_MAX_AGE_MS } from '../../src/core/poolReadiness.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';

const KEY = '3423321f-dd47-45f7-b70e-eeed826a5a47';
const SELF = 'm_holder';
const OWNER = 'm_owner';
const NOW = Date.parse('2026-11-08T04:44:00Z');
const FAILOVER_MS = 15 * 60_000;

/** The owner's capacity as the holder's registry derives it: last direct success `ageMs` ago. */
function capSeen(ageMs: number, attempts: DirectAttempt[] = []) {
  return { liveness: deriveLiveness({ isSelf: false, nowMs: NOW, failoverThresholdMs: FAILOVER_MS, lastDirectSuccessAtMs: NOW - ageMs, attempts }) };
}

function rec(over: Partial<SessionOwnershipRecord> = {}): SessionOwnershipRecord {
  return { sessionKey: `app:${KEY}`, ownerMachineId: OWNER, ownershipEpoch: 20, status: 'active', nonce: 'n', timestamp: NOW, updatedAt: new Date(NOW).toISOString(), ...over } as SessionOwnershipRecord;
}

function placement(cap: ReturnType<typeof capSeen> | null, holds = true, attempts: DirectAttempt[] = []) {
  return appPlacement({
    selfId: SELF,
    holdsLease: () => holds,
    read: () => rec(),
    ownerOnline: () => ownerAnswering(cap, attempts),
    nicknameOf: (m) => (m === OWNER ? 'Proof Studio' : null),
  }, KEY);
}

describe('ownerAnswering: only fresh direct contact means the owner is answering', () => {
  it('reproduces the incident: 6 minutes without contact still derives "live", but is not answering', () => {
    const cap = capSeen(6 * 60_000, [{ atMs: NOW - 60_000, ok: false }]);
    expect(cap.liveness.state).toBe('live'); // the 15-minute window that hid Bring it back here
    expect(ownerAnswering(cap)).toBe(false);
  });

  it('is answering with direct contact inside the 2-minute readiness rule', () => {
    expect(ownerAnswering(capSeen(30_000))).toBe(true);
    expect(ownerAnswering(capSeen(READINESS_CONTACT_MAX_AGE_MS))).toBe(true);
    expect(ownerAnswering(capSeen(READINESS_CONTACT_MAX_AGE_MS + 1))).toBe(false);
  });

  it('reads indirect evidence or a missing reading as unknown, which never offers bring-back', () => {
    const relayed = { liveness: deriveLiveness({ isSelf: false, nowMs: NOW, failoverThresholdMs: FAILOVER_MS, attempts: [], relayedOriginAtMs: NOW - 5 * 60_000 }) };
    expect(relayed.liveness.source).toBe('relayed');
    expect(ownerAnswering(relayed)).toBe(true);
    expect(ownerAnswering({ liveness: undefined } as never)).toBe(true);
    expect(ownerAnswering(null)).toBe(true);
    expect(ownerAnswering(undefined)).toBe(true);
  });
});

describe('a holder that just restarted judges only from its own direct attempts', () => {
  it('does not offer bring-back for a healthy owner before its first direct contact', () => {
    // Only a success saved by the previous process, and no attempt yet in this one.
    const cap = { liveness: deriveLiveness({ isSelf: false, nowMs: NOW, failoverThresholdMs: FAILOVER_MS, attempts: [], savedDirectAtMs: NOW - 4 * 60_000 }) };
    expect(cap.liveness.source).toBe('saved');
    expect(placement(cap)).toMatchObject({ answering: true, bringBack: { can: false } });
  });

  const afterRestart = (attempts: DirectAttempt[]) => ({ liveness: deriveLiveness({ isSelf: false, nowMs: NOW, failoverThresholdMs: FAILOVER_MS, savedDirectAtMs: NOW - 6 * 60_000, attempts }) });

  it('does not offer it for a healthy owner after ONE failed pull (a busy timeout)', () => {
    const attempts: DirectAttempt[] = [{ atMs: NOW - 5_000, ok: false, shape: 'timeout' }];
    const cap = afterRestart(attempts);
    expect(cap.liveness.state).toBe('unreachable'); // what deriveLiveness says after one failure
    expect(placement(cap, true, attempts)).toMatchObject({ answering: true, bringBack: { can: false } });
  });

  it('does not offer it for failures bunched inside 2 minutes', () => {
    const attempts: DirectAttempt[] = [{ atMs: NOW - 90_000, ok: false }, { atMs: NOW - 60_000, ok: false }, { atMs: NOW - 30_000, ok: false }, { atMs: NOW, ok: false }];
    expect(placement(afterRestart(attempts), true, attempts)).toMatchObject({ answering: true, bringBack: { can: false } });
  });

  it('offers it for a dead owner once this process\'s own failures span 2 minutes', () => {
    const attempts: DirectAttempt[] = [0, 30, 60, 90, 120].map((sec) => ({ atMs: NOW - 120_000 + sec * 1_000, ok: false }));
    const cap = afterRestart(attempts);
    expect(cap.liveness.state).toBe('unreachable');
    expect(placement(cap, true, attempts)).toMatchObject({ answering: false, bringBack: { can: true } });
  });

  it('stops offering it as soon as a direct attempt succeeds', () => {
    expect(placement(capSeen(1_000))).toMatchObject({ answering: true, bringBack: { can: false } });
  });
});

describe('placement offers Bring it back here once the owner stops answering', () => {
  it('offers it 3 minutes into an outage (it stayed hidden for 15 before)', () => {
    const p = placement(capSeen(3 * 60_000));
    expect(p).toMatchObject({ moved: true, machine: 'Proof Studio', answering: false, bringBack: { can: true } });
  });

  it('does not offer it while the owner answers, or on a machine without the lease', () => {
    expect(placement(capSeen(20_000))).toMatchObject({ answering: true, bringBack: { can: false } });
    expect(placement(capSeen(3 * 60_000), false)).toMatchObject({ answering: false, bringBack: { can: false } });
  });
});

describe('dispatchQueuedInbound: app rows reach the app tail without Telegram', () => {
  const h = { commitReceipt: () => true, stopRecheck: () => false };

  it('delivers a queued app row through the app tail when no local tail is wired', async () => {
    const app = vi.fn(async () => ({ kind: 'remote-delivered' as const }));
    const out = await dispatchQueuedInbound({ sessionKey: `app:${KEY}` }, h, { app, local: null });
    expect(out).toEqual({ kind: 'remote-delivered' });
    expect(app).toHaveBeenCalledTimes(1);
  });

  it('keeps every other row on the local tail', async () => {
    const app = vi.fn(async () => ({ kind: 'remote-delivered' as const }));
    const local = vi.fn(async () => ({ kind: 'local-delivered' as const }));
    expect(await dispatchQueuedInbound({ sessionKey: '13481' }, h, { app, local })).toEqual({ kind: 'local-delivered' });
    expect(app).not.toHaveBeenCalled();
  });

  it('names the missing tail', async () => {
    expect(await dispatchQueuedInbound({ sessionKey: `app:${KEY}` }, h, { app: null, local: null })).toEqual({ kind: 'un-routable', reason: 'app-tail-not-wired' });
    expect(await dispatchQueuedInbound({ sessionKey: '13481' }, h, { app: null, local: null })).toEqual({ kind: 'un-routable', reason: 'local-tail-not-wired' });
  });
});

describe('a returning owner inside the 2-minute window never flaps the offer', () => {
  it('keeps answering through a gap shorter than 2 minutes, and stays answering when contact resumes', () => {
    // Contact lapses for 90 s (with failed pulls), then a pull succeeds again.
    const failedPulls: DirectAttempt[] = [{ atMs: NOW - 60_000, ok: false }, { atMs: NOW - 30_000, ok: false }];
    expect(ownerAnswering(capSeen(90_000, failedPulls))).toBe(true);
    expect(placement(capSeen(90_000, failedPulls))).toMatchObject({ answering: true, bringBack: { can: false } });
    expect(placement(capSeen(1_000))).toMatchObject({ answering: true, bringBack: { can: false } });
  });

  it('withdraws the offer as soon as the owner is reached again after a longer outage', () => {
    expect(placement(capSeen(4 * 60_000))).toMatchObject({ answering: false, bringBack: { can: true } });
    // The next direct success resets the age: the offer is gone on the very next read.
    expect(placement(capSeen(2_000))).toMatchObject({ answering: true, bringBack: { can: false } });
  });
});

describe('an agent without Telegram delivers a queued app message, end to end through the queue', () => {
  let qdir: string;
  let qstore: PendingInboundStore;
  let wall: number;
  let mono: number;
  let ownerUp: boolean;
  const appTailCalls: string[] = [];

  /** The app tail as the server's: owner unreachable → the message waits; owner back → forwarded. */
  const appTail = async (msg: DrainMessage): Promise<DrainDispatchResult> => {
    appTailCalls.push(msg.messageId);
    return ownerUp ? { kind: 'remote-delivered' } : { kind: 'un-routable', reason: 'queued' };
  };

  function loopWith(dispatchInbound: QueueDrainLoopDeps['dispatchInbound']): QueueDrainLoop {
    const loop = new QueueDrainLoop({
      store: qstore,
      qcfg: { ...DEFAULT_INBOUND_QUEUE_CONFIG, enabled: true, dryRun: false, minInterPassMs: 0 },
      hcfg: { ...DEFAULT_HOLD_FOR_STABILITY_CONFIG, enabled: true },
      selfMachineId: SELF,
      holdsLease: () => true,
      isStopped: () => false,
      dispatchInbound,
      forceReplace: async () => false,
      holdVerdict: () => 'deliver',
      clearPisRecord: () => {},
      reportLoss: () => {},
      reportPossiblyNotInjected: () => {},
      log: () => {},
      reportDegradation: () => {},
      now: () => wall,
      mono: () => mono,
      bootSessionId: 'boot-1',
    });
    loop.onLeaseAcquired(null);
    return loop;
  }

  async function passAfter(loop: QueueDrainLoop, ms: number): Promise<void> {
    wall += ms; mono += ms;
    await loop.runDrainPass('test');
  }

  beforeEach(() => {
    qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-only-queue-'));
    qstore = PendingInboundStore.open('proof', qdir);
    wall = NOW; mono = 1_000_000; ownerUp = false; appTailCalls.length = 0;
  });
  afterEach(() => {
    qstore.close();
    SafeFsExecutor.safeRmSync(qdir, { recursive: true, force: true, operation: 'app-pool-bringback-queue.test.ts' });
  });

  it('holds "five" while the owner is down and delivers it once the owner answers (no local tail wired)', async () => {
    const loop = loopWith((m, h) => dispatchQueuedInbound(m, h, { app: (mm) => appTail(mm), local: null }));
    const out = loop.enqueueLive({ sessionKey: `app:${KEY}`, messageId: 'five', payload: '{}', senderEnvelope: null }, 'app-owner-unreachable');
    expect(out.result).toBe('queued');
    const seq = (out as { seq: number }).seq;

    await passAfter(loop, 0);
    expect(qstore.getRow(seq)?.state).toBe('queued'); // waiting, not lost
    ownerUp = true;
    await passAfter(loop, 5 * 60_000);
    expect(qstore.getRow(seq)?.state).toBe('delivered');
    expect(appTailCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the server wires both', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
  it('routes the queue through dispatchQueuedInbound with the app tail', () => {
    expect(src).toContain('dispatchInbound: (msg, handover) => dispatchQueuedInbound(msg, handover, { app: _appDrainDeliver, local: _drainLocalDeliver })');
  });
  it('decides "answering" with ownerAnswering, not the liveness state alone', () => {
    expect(src).toContain('ownerOnline: (m: string) => ownerAnswering(appCaps().find((x) => x.machineId === m), machinePoolRegistry?.directAttempts(m) ?? [])');
    expect(src).not.toContain("c.liveness.state === 'live' : c?.online === true");
  });
});
