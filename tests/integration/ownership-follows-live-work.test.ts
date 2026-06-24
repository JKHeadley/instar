import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

vi.mock('../../src/monitoring/stall-detector.js', () => ({ detectToolCallStall: vi.fn(() => null), DEFAULT_TOOL_THRESHOLDS: {} }));
vi.mock('../../src/monitoring/crash-detector.js', () => ({ detectCrashedSession: vi.fn(() => null), detectErrorLoop: vi.fn(() => null) }));
vi.mock('../../src/monitoring/jsonl-truncator.js', () => ({ truncateJsonlToSafePoint: vi.fn() }));

import {
  SessionOwnershipRegistry,
  InMemorySessionOwnershipStore,
} from '../../src/core/SessionOwnershipRegistry.js';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import { SessionRecovery, type SessionRecoveryDeps } from '../../src/monitoring/SessionRecovery.js';
import { shouldReleaseOnComplete, planClaimOnSpawn, ownershipNonce } from '../../src/core/ownershipFollowsLiveWork.js';

/**
 * Tier-2 integration — Ownership Follows Live Work (docs/specs/ownership-follows-
 * live-work.md). Wires the REAL ownership registry + REAL MachinePoolRegistry (the
 * exact deps server.ts injects) and proves:
 *  - Part A release-on-complete advances the durable record to `released` →
 *    ownerOf becomes null (the stale-`active` cause PR #1258 compensated for is gone).
 *  - Part B claim-on-spawn moves ownership onto self via place→claim.
 *  - Part D's gate, wired with the SAME isOwnerReachable signal the router uses
 *    (machinePoolRegistry.getCapacity(owner)?.online), forwards/withholds for a
 *    peer-owned topic and proceeds for a self/null owner — emitting a placement
 *    journal record on the release (so it replicates).
 */

const SELF = 'm_self';
const PEER = 'm_peer';

function makeRegistry() {
  const seen = new Set<string>();
  return new SessionOwnershipRegistry({
    store: new InMemorySessionOwnershipStore(),
    seenNonce: (k) => seen.has(k),
    recordNonce: (k) => seen.add(k),
  });
}

function ownTopicAs(reg: SessionOwnershipRegistry, sk: string, machine: string) {
  reg.cas({ type: 'place', machineId: machine }, { sessionKey: sk, sender: machine, nonce: ownershipNonce(machine, 'place', sk) });
  reg.cas({ type: 'claim', machineId: machine }, { sessionKey: sk, sender: machine, nonce: ownershipNonce(machine, 'claim', sk) });
}

describe('Tier-2: Ownership Follows Live Work — registry + pool wiring', () => {
  it('Part A: release-on-complete advances the record to released → ownerOf null + a placement is journaled', () => {
    const reg = makeRegistry();
    ownTopicAs(reg, '100', SELF);
    expect(reg.ownerOf('100')).toBe(SELF);

    const journal: Array<{ sk: string; reason: string }> = [];
    const emitPlacement = (sk: string, r: { ok: boolean }, reason: string) => { if (r.ok) journal.push({ sk, reason }); };

    // The gate (single-sourced helper) decides; the wiring performs the CAS+emit.
    const rec = reg.read('100');
    expect(shouldReleaseOnComplete({ enabled: true, selfMachineId: SELF, record: rec, completingStartedAt: 's', liveStartedAt: null })).toBe(true);
    const r = reg.cas({ type: 'release', machineId: SELF }, { sessionKey: '100', sender: SELF, nonce: ownershipNonce(SELF, 'rel-complete', '100') });
    emitPlacement('100', r, 'released');

    expect(reg.ownerOf('100')).toBeNull(); // released reads as no-owner
    expect(journal).toContainEqual({ sk: '100', reason: 'released' });
  });

  it('Part B: claim-on-spawn (place→claim) moves ownership onto self for a never-seen topic', () => {
    const reg = makeRegistry();
    const journal: string[] = [];
    const emitPlacement = (_sk: string, r: { ok: boolean }, reason: string) => { if (r.ok) journal.push(reason); };

    expect(planClaimOnSpawn({ enabled: true, selfMachineId: SELF, record: reg.read('200') })).toEqual({ action: 'place-then-claim' });
    const rp = reg.cas({ type: 'place', machineId: SELF }, { sessionKey: '200', sender: SELF, nonce: ownershipNonce(SELF, 'auto-place', '200') });
    emitPlacement('200', rp, 'placed');
    const rc = reg.cas({ type: 'claim', machineId: SELF }, { sessionKey: '200', sender: SELF, nonce: ownershipNonce(SELF, 'auto-claim', '200') });
    emitPlacement('200', rc, 'placed');

    expect(reg.ownerOf('200')).toBe(SELF);
    expect(journal).toEqual(['placed', 'placed']);
  });

  it('Part B: an autonomous spawn NEVER force-claims a peer-owned topic (withhold + audit)', () => {
    const reg = makeRegistry();
    ownTopicAs(reg, '300', PEER);
    const plan = planClaimOnSpawn({ enabled: true, selfMachineId: SELF, record: reg.read('300') });
    expect(plan).toEqual({ action: 'audit-owned-elsewhere', owner: PEER, status: 'active' });
    // ownership stays on the peer (no steal).
    expect(reg.ownerOf('300')).toBe(PEER);
  });
});

describe('Tier-2: Part D recovery gate wired with the REAL pool reachability signal', () => {
  let dir: string;
  let reg: SessionOwnershipRegistry;
  let pool: MachinePoolRegistry;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofw-int-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    reg = makeRegistry();
    pool = new MachinePoolRegistry({
      listMachines: () => [{ machineId: SELF, nickname: 'self' }, { machineId: PEER, nickname: 'peer' }],
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
    });
  });
  afterEach(() => { try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/ownership-follows-live-work.test.ts' }); } catch { /* ignore */ } });

  function makeRecovery(): { rec: SessionRecovery; spies: Record<string, ReturnType<typeof vi.fn>> } {
    const respawnSession = vi.fn(async () => {});
    const respawnSessionFresh = vi.fn(async () => {});
    const forward = vi.fn(async (topicId: number) => {
      // the real shape server.ts wires: nonePending true when nothing queued.
      void topicId;
      return { forwarded: 1, nonePending: false };
    });
    // EXACTLY the server.ts wiring shape (the same isOwnerReachable signal the router uses).
    const isOwnerReachableShared = (owner: string) => pool.getCapacity(owner)?.online === true;
    const deps: SessionRecoveryDeps = {
      isSessionAlive: vi.fn(() => true),
      getPanePid: vi.fn(() => null),
      killSession: vi.fn(async () => {}),
      respawnSession,
      respawnSessionFresh,
      captureSessionOutput: vi.fn(() => null),
      ownershipFollowsLiveWork: () => true,
      ownerOfTopic: (topicId) => reg.ownerOf(String(topicId)),
      selfMachineId: () => SELF,
      isOwnerReachable: (owner) => isOwnerReachableShared(owner),
      forwardPendingInboundViaRoute: forward,
      emitRecoveryGateTelemetry: () => {},
    };
    return { rec: new SessionRecovery({ enabled: true, projectDir: dir }, deps), spies: { respawnSession, respawnSessionFresh, forward } };
  }

  it('peer owns the topic AND the peer is ONLINE → forward, do NOT respawn locally', async () => {
    pool.recordHeartbeat({ machineId: PEER, selfReportedLastSeen: new Date().toISOString(), loadAvg: 1 });
    ownTopicAs(reg, '500', PEER);
    const { rec, spies } = makeRecovery();
    const r = await rec.checkAndRecover(500, 'topic-500');
    expect(spies.forward).toHaveBeenCalledTimes(1);
    expect(spies.respawnSession).not.toHaveBeenCalled();
    expect(spies.respawnSessionFresh).not.toHaveBeenCalled();
    expect(r.message).toMatch(/forwarded/);
  });

  it('peer owns the topic but the peer is OFFLINE (no heartbeat) → withhold local re-run, no double-dispatch', async () => {
    // No heartbeat recorded for PEER → getCapacity(PEER).online is false (unreachable).
    ownTopicAs(reg, '600', PEER);
    const { rec, spies } = makeRecovery();
    const r = await rec.checkAndRecover(600, 'topic-600');
    expect(spies.respawnSession).not.toHaveBeenCalled();
    expect(spies.forward).not.toHaveBeenCalled();
    expect(r.message).toMatch(/withheld/);
  });

  it('self owns the topic → proceed to the existing recovery logic (no forward/withhold)', async () => {
    ownTopicAs(reg, '700', SELF);
    const { rec, spies } = makeRecovery();
    const r = await rec.checkAndRecover(700, 'topic-700');
    expect(spies.forward).not.toHaveBeenCalled();
    expect(r.message).toMatch(/No JSONL found/); // proceeded to legacy path
  });
});
