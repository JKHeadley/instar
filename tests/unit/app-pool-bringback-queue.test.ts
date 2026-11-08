/**
 * Two fixes found by the first real two-machine move (pool-proof-1107, step 7):
 *  1. "Bring it back here" stayed hidden for 15 minutes after the owner stopped: placement read the
 *     owner's liveness "live", which deriveLiveness keeps until the failover threshold.
 *  2. On an agent without Telegram, no queued app message could be delivered: the queue reached the
 *     app tail only through the local tail, which only the Telegram wiring sets.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

function placement(cap: ReturnType<typeof capSeen> | null, holds = true) {
  return appPlacement({
    selfId: SELF,
    holdsLease: () => holds,
    read: () => rec(),
    ownerOnline: () => ownerAnswering(cap),
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

  it('never trusts indirect evidence or a missing reading', () => {
    const relayed = { liveness: deriveLiveness({ isSelf: false, nowMs: NOW, failoverThresholdMs: FAILOVER_MS, attempts: [], relayedOriginAtMs: NOW - 5_000 }) };
    expect(relayed.liveness.source).toBe('relayed');
    expect(ownerAnswering(relayed)).toBe(false);
    expect(ownerAnswering({ liveness: undefined } as never)).toBe(false);
    expect(ownerAnswering(null)).toBe(false);
    expect(ownerAnswering(undefined)).toBe(false);
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

describe('the server wires both', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
  it('routes the queue through dispatchQueuedInbound with the app tail', () => {
    expect(src).toContain('dispatchInbound: (msg, handover) => dispatchQueuedInbound(msg, handover, { app: _appDrainDeliver, local: _drainLocalDeliver })');
  });
  it('decides "answering" with ownerAnswering, not the liveness state alone', () => {
    expect(src).toContain('ownerOnline: (m: string) => ownerAnswering(appCaps().find((x) => x.machineId === m))');
    expect(src).not.toContain("c.liveness.state === 'live' : c?.online === true");
  });
});
