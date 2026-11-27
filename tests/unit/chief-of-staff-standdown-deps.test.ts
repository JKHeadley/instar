// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Chief of Staff (docs/specs/chief-of-staff-topic.md §2.4 / §4) — the OPTIONAL stand-down deps
 * the other run producers accept, both sides of each boundary:
 *  - Liveness Reconciler `cosStandDown`: present + reason ⇒ blocked-queue-owns, no respawn;
 *    present + null ⇒ unchanged; absent ⇒ unchanged; throwing ⇒ stand down (safe side).
 *  - ResumeQueueDrainer `cosStandDown`: entry invalidated `cos-intent-open`; absent ⇒ drains.
 *  - AutonomousProgressHeartbeat `cosSuppress`: suppressed `cos-lease-expired`; absent ⇒ fires.
 *  - AutonomousRunStore: `cosNoRespawn` + `idempotencyKey` persist; `findByIdempotencyKey`;
 *    `blockingStateForTopic` maps open/history/none.
 *  - MeshRpc RBAC: `cos-action` / `cos-settle` are registered-peer class.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutonomousRunStore } from '../../src/core/AutonomousRunStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { checkCommandRBAC, type MeshCommand, type RbacDeps } from '../../src/core/MeshRpc.js';
import {
  AutonomousLivenessReconciler,
  type AutonomousLivenessReconcilerDeps,
  type ReconcilerActiveRun,
} from '../../src/monitoring/AutonomousLivenessReconciler.js';

// ── run store ────────────────────────────────────────────────────────────────

describe('AutonomousRunStore — Chief of Staff fields', () => {
  let tmp: string; let store: AutonomousRunStore;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cos-ars-')); store = new AutonomousRunStore(tmp); });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/chief-of-staff-standdown-deps.test.ts' }); });
  const HOUR = 3_600_000;
  const reg = (topicId: string, extra: Record<string, unknown> = {}) => store.register({
    topicId, condition: 'ship it', workDir: '/tmp/w', startedAt: new Date(1_000_000).toISOString(), endAt: new Date(1_000_000 + HOUR).toISOString(),
    scopeAccretion: { mode: 'off' } as never, baseRoots: [], maxDurationMs: 4 * HOUR, ...extra,
  } as never, 1_000_000);

  it('persists cosNoRespawn + idempotencyKey and finds the run by key (across a store reopen)', () => {
    const r = reg('100', { cosNoRespawn: true, idempotencyKey: 'telegram:100:7:1' });
    expect(r.ok).toBe(true);
    const rec = store.getRecord('100')!;
    expect(rec.cosNoRespawn).toBe(true); expect(rec.idempotencyKey).toBe('telegram:100:7:1');
    expect(store.findByIdempotencyKey('telegram:100:7:1')).toMatchObject({ runId: rec.runId, topicId: '100' });
    expect(new AutonomousRunStore(tmp).findByIdempotencyKey('telegram:100:7:1')?.runId).toBe(rec.runId);
    expect(store.findByIdempotencyKey('nope')).toBeNull(); expect(store.findByIdempotencyKey('')).toBeNull();
  });
  it('omits the fields when not given (plain runs are unchanged)', () => {
    reg('101');
    const rec = store.getRecord('101')!;
    expect(rec.cosNoRespawn).toBeUndefined(); expect(rec.idempotencyKey).toBeUndefined();
  });
  it('blockingStateForTopic: open while unexpired, history after the window or a terminal exit, none when unknown', () => {
    reg('102');
    expect(store.blockingStateForTopic('102', 1_000_000 + 60_000)).toBe('open');
    expect(store.blockingStateForTopic('102', 1_000_000 + 2 * HOUR)).toBe('history');
    const rec = store.getRecord('102')!;
    store.markTerminal('102', rec.runId, 'ended', 'test');
    expect(store.blockingStateForTopic('102', 1_000_000 + 60_000)).toBe('history');
    expect(store.blockingStateForTopic('999')).toBe('none');
  });
});

// ── mesh RBAC ────────────────────────────────────────────────────────────────

describe('MeshRpc RBAC — cos-action / cos-settle are registered-peer class (the handler is the gate)', () => {
  const rbac: RbacDeps = { routerHolder: () => 'ROUTER', ownerOf: () => null, placementTargetOf: () => null };
  it('any registered peer passes RBAC for both verbs', () => {
    const action: MeshCommand = { type: 'cos-action', conversationKey: 'telegram:1', action: 'redirect', leaseEpoch: 1, sequence: 1, holderMachineId: 'A', holderSignature: 's', claimedAt: '2026-11-09T12:00:00.000Z', payload: {} };
    const settle: MeshCommand = { type: 'cos-settle', conversationKey: 'telegram:1', intentKey: 'telegram:1:1:1', holderMachineId: 'A', holderSignature: 's' };
    expect(checkCommandRBAC(action, 'ANY_PEER', rbac)).toEqual({ ok: true, reason: 'ok' });
    expect(checkCommandRBAC(settle, 'ANY_PEER', rbac)).toEqual({ ok: true, reason: 'ok' });
  });
});

// ── reconciler ───────────────────────────────────────────────────────────────

function reconcilerWith(cos: AutonomousLivenessReconcilerDeps['cosStandDown'] | undefined) {
  const respawned: number[] = [];
  const run: ReconcilerActiveRun = { topicId: 100, remainingSeconds: 3600, paused: false, movedTo: null, moveSuspended: false, startedAtMs: 1_000_000 - 60_000 };
  let now = 1_000_000;
  const deps: AutonomousLivenessReconcilerDeps = {
    now: () => now,
    listActiveRuns: () => [run],
    liveTopicSnapshot: () => new Set<number>(),
    queuePaused: () => false,
    topicInResumeQueue: () => false,
    operatorStoppedSince: () => false,
    topicOwnerElsewhere: () => false,
    holdsLease: () => true,
    currentGenerationMs: () => null,
    quotaOk: () => true,
    sessionCountOk: () => true,
    migrationInFlight: () => false,
    pressureTier: () => 'normal',
    inflightSpawnStatus: () => ({ state: 'none' }),
    resolveResumeUuid: () => 'uuid-100',
    resolveCwd: () => '/w',
    bindingUnambiguous: () => true,
    respawn: async ({ topicId }) => { respawned.push(topicId); },
    claimInflight: () => true,
    releaseClaim: () => {},
    settleKill: async () => {},
    notifyTopic: async () => {},
    raiseAggregated: () => {},
    audit: () => {},
    queueResurrectionCount: () => 0,
    saveCapState: () => {},
    ...(cos !== undefined ? { cosStandDown: cos } : {}),
  } as AutonomousLivenessReconcilerDeps;
  const r = new AutonomousLivenessReconciler(deps, { enabled: true, dryRun: false, debounceTicks: 1, debounceWindowSec: 0, respawnCapPerWindow: 5, respawnCapWindowSec: 3600, spawnFailureRetryCeiling: 3, maxPressureBlockedTicks: 3, maxPressureBlockedSec: 100000, notifyUser: false });
  return { r, respawned, advance: (ms: number) => { now += ms; } };
}

async function drive(h: ReturnType<typeof reconcilerWith>) {
  await h.r.tick(); h.advance(1000); await h.r.tick(); h.advance(1000); await h.r.tick();
}

describe('AutonomousLivenessReconciler — optional cosStandDown', () => {
  it('absent ⇒ unchanged: a dead active run is respawned', async () => {
    const h = reconcilerWith(undefined); await drive(h);
    expect(h.respawned.length).toBeGreaterThanOrEqual(1); expect(new Set(h.respawned)).toEqual(new Set([100]));
  });
  it('present and null ⇒ unchanged', async () => {
    const h = reconcilerWith(() => null); await drive(h);
    expect(h.respawned.length).toBeGreaterThanOrEqual(1);
  });
  it('present with a reason ⇒ blocked-queue-owns, never respawns', async () => {
    const h = reconcilerWith(() => 'cos-intent-open'); await drive(h);
    expect(h.respawned).toEqual([]);
    expect(h.r.status().conditions.find((c) => c.topicId === 100)?.state).toBe('blocked-queue-owns');
  });
  it('a throwing dep resolves to the safe side (stand down)', async () => {
    const h = reconcilerWith(() => { throw new Error('boom'); }); await drive(h);
    expect(h.respawned).toEqual([]);
  });
});
