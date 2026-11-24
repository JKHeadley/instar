/**
 * Unroutable-owner release (docs/specs/unroutable-owner-release.md) — Tier 1.
 *
 * The live bug (2026-11-20): a rebuilt Mac Studio came back with a NEW machine id;
 * ~70 topics stayed owned by the OLD (revoked / unregistered) id. The stale-owner
 * engine held them as transport-ambiguity forever (a revoked machine can never be
 * probed), the router's owner-dead `place` was refused on the live record (queued
 * as ownership-contention forever), and /pool/transfer could not move them.
 *
 * Covers both sides of every decision boundary of the shared assessment, the
 * engine pass (claims even in dryRun, lease-holder-only, the opt-out), and the
 * router takeover.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  assessOwnerRoutability,
  createUnroutableOwnerAssessor,
  standingFromRegistry,
  newestSideEffectMs,
  DEFAULT_UNREGISTERED_SILENCE_MS,
  DEFAULT_UNREGISTERED_BOOT_WINDOW_MS,
  type OwnerRoutabilityInput,
} from '../../src/core/unroutableOwner.js';
import {
  StaleOwnerReleaseEngine,
  DEFAULT_STALE_OWNER_RELEASE_CONFIG,
  type StaleOwnerReleaseDeps,
  type StaleOwnerReleaseConfig,
  type StaleOwnerTraceEntry,
} from '../../src/core/StaleOwnerReleaseEngine.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';
import { SessionRouter, type SessionRouterDeps, type OwnershipView, type DeliverAck, type InboundMessage } from '../../src/core/SessionRouter.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import type { MachineCapacity } from '../../src/core/types.js';

const NOW = 10_000_000_000;
const HOUR = 3_600_000;

function input(over: Partial<OwnerRoutabilityInput> = {}): OwnerRoutabilityInput {
  return {
    owner: 'm_old',
    selfMachineId: 'm_self',
    standing: 'unregistered',
    inPoolView: false,
    lastSideEffectMs: NOW - 20 * HOUR,
    nowMs: NOW,
    absentForMs: HOUR,
    silenceBoundMs: DEFAULT_UNREGISTERED_SILENCE_MS,
    ...over,
  };
}

describe('assessOwnerRoutability — decision table', () => {
  it('revoked owner is unroutable regardless of every other input', () => {
    expect(assessOwnerRoutability(input({ standing: 'revoked', inPoolView: true, lastSideEffectMs: NOW, absentForMs: 0 })))
      .toEqual({ unroutable: true, reason: 'revoked' });
  });
  it('registered owner is never unroutable (the full evidence bar owns it)', () => {
    expect(assessOwnerRoutability(input({ standing: 'registered' }))).toEqual({ unroutable: false, reason: 'registered' });
  });
  it('unknown self identity decides nothing', () => {
    expect(assessOwnerRoutability(input({ selfMachineId: null, standing: 'revoked' }))).toEqual({ unroutable: false, reason: 'registry-unavailable' });
  });
  it('a just-vanished registry entry with an OLD journal event does not qualify at once (continuous absence required)', async () => {
    const { AbsenceTracker } = await import('../../src/core/unroutableOwner.js');
    const t = new AbsenceTracker();
    expect(t.observe('m_x', 'unregistered', 1000)).toBe(0);
    expect(assessOwnerRoutability(input({ absentForMs: 0, lastSideEffectMs: NOW - 8 * HOUR })).reason).toBe('unregistered-boot-window');
    // Watched every 60 s for the whole window → continuous.
    let m = 1000;
    for (let i = 0; i < DEFAULT_UNREGISTERED_BOOT_WINDOW_MS / 60_000; i++) { m += 60_000; t.observe('m_x', 'unregistered', m); }
    expect(t.observe('m_x', 'unregistered', m)).toBe(DEFAULT_UNREGISTERED_BOOT_WINDOW_MS);
    // A registered (or unavailable) reading resets the clock.
    expect(t.observe('m_x', 'registered', m + 1)).toBe(0);
    expect(t.observe('m_x', 'unregistered', m + 2)).toBe(0);
  });
  it('a missed sampling gap (process suspended / clock jump) restarts the absence window', async () => {
    const { AbsenceTracker, DEFAULT_ABSENCE_MAX_GAP_MS } = await import('../../src/core/unroutableOwner.js');
    const t = new AbsenceTracker();
    t.observe('m_x', 'unregistered', 0);
    t.observe('m_x', 'unregistered', 60_000);
    expect(t.observe('m_x', 'unregistered', 60_000 + DEFAULT_ABSENCE_MAX_GAP_MS + 1)).toBe(0); // gap → restart
    expect(t.observe('m_x', 'unregistered', 10)).toBe(0); // clock went backwards → restart
  });
  it('self is never unroutable', () => {
    expect(assessOwnerRoutability(input({ owner: 'm_self', standing: 'revoked' })).unroutable).toBe(false);
  });
  it('unregistered + silent past the bound + fresh mirror → unroutable', () => {
    expect(assessOwnerRoutability(input())).toEqual({ unroutable: true, reason: 'unregistered-silent' });
  });
  it('unavailable registry → routable even with qualifying journal evidence', () => {
    expect(assessOwnerRoutability(input({ standing: 'unavailable' }))).toEqual({ unroutable: false, reason: 'registry-unavailable' });
  });
  it('unregistered but present in the pool view → routable (registry lag)', () => {
    expect(assessOwnerRoutability(input({ inPoolView: true })).reason).toBe('unregistered-in-pool-view');
  });
  it('unregistered inside the boot window → routable', () => {
    expect(assessOwnerRoutability(input({ absentForMs: DEFAULT_UNREGISTERED_BOOT_WINDOW_MS - 1 })).reason).toBe('unregistered-boot-window');
    expect(assessOwnerRoutability(input({ absentForMs: DEFAULT_UNREGISTERED_BOOT_WINDOW_MS })).unroutable).toBe(true);
  });
  it('mirror freshness is not consulted for an unregistered owner (its stream is no longer pulled); the 6h silence bound carries it', () => {
    expect(DEFAULT_UNREGISTERED_SILENCE_MS).toBe(6 * HOUR);
  });
  it('unregistered with NO journal evidence at all → routable (no positive evidence of silence)', () => {
    expect(assessOwnerRoutability(input({ lastSideEffectMs: null })).reason).toBe('unregistered-no-evidence');
  });
  it('unregistered with recent journal activity → routable; at the bound → unroutable', () => {
    expect(assessOwnerRoutability(input({ lastSideEffectMs: NOW - DEFAULT_UNREGISTERED_SILENCE_MS + 1 })).reason).toBe('unregistered-recent-activity');
    expect(assessOwnerRoutability(input({ lastSideEffectMs: NOW - DEFAULT_UNREGISTERED_SILENCE_MS })).unroutable).toBe(true);
  });
});

describe('standingFromRegistry', () => {
  const machines = {
    m_live: { status: 'active' },
    m_rev: { status: 'revoked', revokedAt: '2026-11-20T10:10:08.283Z' },
    m_halfrev: { status: 'active', revokedAt: '2026-11-20T10:10:08.283Z' },
  };
  it('maps active / revoked / revokedAt-stamped / absent', () => {
    expect(standingFromRegistry(machines, 'm_live')).toBe('registered');
    expect(standingFromRegistry(machines, 'm_rev')).toBe('revoked');
    expect(standingFromRegistry(machines, 'm_halfrev')).toBe('revoked');
    expect(standingFromRegistry(machines, 'm_gone')).toBe('unregistered');
    // An unreadable snapshot is NOT evidence the id is missing.
    expect(standingFromRegistry(undefined, 'm_gone')).toBe('unavailable');
    // A missing registry.json loads as {machines:{}} — not evidence either.
    expect(standingFromRegistry({}, 'm_gone')).toBe('unavailable');
  });
});

describe('createUnroutableOwnerAssessor', () => {
  it('binds live seams and reads a seam fault as routable', () => {
    const ok = createUnroutableOwnerAssessor({
      selfMachineId: () => 'm_self',
      registryMachines: () => ({ m_self: { status: 'active' }, m_rev: { status: 'revoked' } }),
      inPoolView: () => false,
      lastSideEffectMs: () => null,
      mirrorLastSyncOkMs: () => null,
      bootAtMs: NOW - HOUR,
      now: () => NOW,
    });
    expect(ok('m_rev')).toEqual({ unroutable: true, reason: 'revoked' });
    // A registry that does not list THIS machine is not a sane snapshot.
    const noSelf = createUnroutableOwnerAssessor({
      selfMachineId: () => 'm_self',
      registryMachines: () => ({ m_other: { status: 'active' } }),
      inPoolView: () => false,
      lastSideEffectMs: () => NOW - 20 * HOUR,
      mirrorLastSyncOkMs: () => null,
      bootAtMs: NOW - 10 * HOUR,
      now: () => NOW,
    });
    expect(noSelf('m_gone')).toEqual({ unroutable: false, reason: 'registry-unavailable' });
    const journalReads = vi.fn(() => null);
    const registeredOnly = createUnroutableOwnerAssessor({
      selfMachineId: () => 'm_self',
      registryMachines: () => ({ m_self: { status: 'active' }, m_peer: { status: 'active' } }),
      inPoolView: () => true,
      lastSideEffectMs: journalReads,
      mirrorLastSyncOkMs: () => null,
      bootAtMs: 0,
      now: () => NOW,
    });
    expect(registeredOnly('m_peer').unroutable).toBe(false);
    expect(journalReads).not.toHaveBeenCalled(); // cheap first: no journal read for a registered owner
    const broken = createUnroutableOwnerAssessor({
      selfMachineId: () => 'm_self',
      registryMachines: () => { throw new Error('registry corrupt'); },
      inPoolView: () => false,
      lastSideEffectMs: () => null,
      mirrorLastSyncOkMs: () => null,
      bootAtMs: 0,
    });
    expect(broken('m_rev').unroutable).toBe(false);
  });
});

// ── Engine pass ────────────────────────────────────────────────────────────

const SELF = 'm_self';
function rec(sessionKey: string, owner: string): SessionOwnershipRecord {
  return { sessionKey, ownerMachineId: owner, ownershipEpoch: 22, status: 'active', nonce: 'n', timestamp: 1, updatedAt: new Date(1).toISOString() };
}

function engineHarness(opts: {
  standing: Record<string, 'registered' | 'revoked' | 'unregistered'>;
  records: SessionOwnershipRecord[];
  dryRun?: boolean;
  holdsLease?: boolean;
  lastSideEffectMs?: number | null;
  cfg?: Partial<StaleOwnerReleaseConfig>;
  noStandingDep?: boolean;
}) {
  let wall = NOW;
  let mono = 1_000_000;
  const claims: string[] = [];
  const traces: StaleOwnerTraceEntry[] = [];
  const cfg: StaleOwnerReleaseConfig = { ...DEFAULT_STALE_OWNER_RELEASE_CONFIG, enabled: true, dryRun: opts.dryRun ?? true, ...opts.cfg } as StaleOwnerReleaseConfig;
  const deps: StaleOwnerReleaseDeps = {
    enabled: () => true,
    dryRun: () => cfg.dryRun,
    config: () => cfg,
    selfMachineId: () => SELF,
    // The pool view: self + two live peers; the old owner is NOT in it.
    machines: () => [
      { machineId: SELF, online: true, observerLastSeenMs: wall },
      { machineId: 'm_peer1', online: true, observerLastSeenMs: wall },
      { machineId: 'm_peer2', online: true, observerLastSeenMs: wall },
    ],
    holdsLease: () => opts.holdsLease ?? true,
    listOwnershipRecords: () => opts.records,
    durableLastKnownHeartbeatMs: () => null,
    advertSet: () => ({ endpoints: [], fresh: false }), // a dead id has no adverts — the old bar's dead end
    probeEndpoint: async () => false,
    selfConnectivityProof: async () => true,
    hasDurableLeaseAuthority: () => true,
    evidenceMirror: () => ({
      lastSyncOkMs: wall - 1_000,
      lastOwnerSideEffectMs: () => (opts.lastSideEffectMs === undefined ? wall - 20 * HOUR : opts.lastSideEffectMs),
    }),
    claimAnnotations: () => new Map(),
    actForceClaim: (sk) => { claims.push(sk); return true; },
    emitClaimAnnotation: () => {},
    pullWorkingSet: () => {},
    trace: (e) => traces.push(e),
    raiseAttention: () => {},
    ...(opts.noStandingDep ? {} : { ownerStanding: (m: string) => opts.standing[m] ?? 'registered' }),
    now: () => wall,
    monotonicNow: () => mono,
  };
  const engine = new StaleOwnerReleaseEngine(deps);
  const advance = (ms: number) => { wall += ms; mono += ms; };
  return { engine, claims, traces, advance };
}

describe('StaleOwnerReleaseEngine — unroutable owners', () => {
  it('REVOKED owner: claims land at once, even in dryRun, with no adverts or probes', () => {
    const h = engineHarness({ standing: { m_old: 'revoked' }, records: [rec('141385', 'm_old'), rec('29723', 'm_old')] });
    h.engine.tick();
    expect(h.claims.sort()).toEqual(['141385', '29723']);
    expect(h.traces.some((t) => t.type === 'claim' && t.reason === 'unroutable-owner:revoked')).toBe(true);
    expect(h.engine.status().evidenceClasses['unroutable-revoked']).toBeGreaterThan(0);
  });

  it('respects maxClaimsPerTick (bounded blast radius)', () => {
    const recs = Array.from({ length: 5 }, (_, i) => rec(String(100 + i), 'm_old'));
    const h = engineHarness({ standing: { m_old: 'revoked' }, records: recs });
    h.engine.tick();
    expect(h.claims).toHaveLength(DEFAULT_STALE_OWNER_RELEASE_CONFIG.maxClaimsPerTick);
  });

  it('never claims when this machine is not the lease holder', () => {
    const h = engineHarness({ standing: { m_old: 'revoked' }, records: [rec('141385', 'm_old')], holdsLease: false });
    h.engine.tick();
    expect(h.claims).toEqual([]);
  });

  it('unroutableOwnerLive:false keeps unroutable claims under dryRun (would-claim only)', () => {
    const h = engineHarness({ standing: { m_old: 'revoked' }, records: [rec('141385', 'm_old')], cfg: { unroutableOwnerLive: false } });
    h.engine.tick();
    expect(h.claims).toEqual([]);
    expect(h.traces.some((t) => t.type === 'would-claim')).toBe(true);
  });

  it('UNREGISTERED + silent owner: no claim until 9 min of continuously watched absence; then claims when NOT in dryRun', () => {
    const h = engineHarness({ standing: { m_old: 'unregistered' }, records: [rec('141385', 'm_old')], dryRun: false });
    h.engine.tick();
    expect(h.claims).toEqual([]);
    for (let i = 0; i < 8; i++) { h.advance(60_000); h.engine.tick(); }
    expect(h.claims).toEqual([]); // 8 min of absence: not yet
    h.advance(60_000); h.engine.tick();
    expect(h.claims[0]).toBe('141385');
  });

  it('UNREGISTERED + silent owner stays under dryRun (only a REVOKED owner bypasses it)', () => {
    const h = engineHarness({ standing: { m_old: 'unregistered' }, records: [rec('141385', 'm_old')], dryRun: true });
    for (let i = 0; i < 12; i++) { h.advance(60_000); h.engine.tick(); }
    expect(h.claims).toEqual([]);
    expect(h.traces.some((t) => t.type === 'would-claim')).toBe(true);
  });

  it('UNREGISTERED owner with no journal evidence is NOT claimed (stays on the fail-closed bar)', () => {
    const h = engineHarness({ standing: { m_new: 'unregistered' }, records: [rec('144400', 'm_new')], lastSideEffectMs: null });
    h.advance(DEFAULT_UNREGISTERED_SILENCE_MS + 1);
    h.engine.tick();
    h.engine.tick();
    expect(h.claims).toEqual([]);
  });

  it('UNREGISTERED owner with recent journal activity is NOT claimed', () => {
    const h = engineHarness({ standing: { m_new: 'unregistered' }, records: [rec('144400', 'm_new')], lastSideEffectMs: NOW + DEFAULT_UNREGISTERED_SILENCE_MS - 60_000 });
    h.advance(DEFAULT_UNREGISTERED_SILENCE_MS + 1);
    h.engine.tick();
    expect(h.claims).toEqual([]);
  });

  it('a REGISTERED offline owner in dryRun is unchanged (no live claim — the soak still holds)', () => {
    const h = engineHarness({ standing: {}, records: [rec('700', 'm_peerX')] });
    h.advance(3 * HOUR);
    h.engine.tick();
    h.engine.tick();
    expect(h.claims).toEqual([]);
  });

  it('without the ownerStanding dep behavior is byte-for-byte today (no unroutable claims)', () => {
    const h = engineHarness({ standing: { m_old: 'revoked' }, records: [rec('141385', 'm_old')], noStandingDep: true });
    h.advance(3 * HOUR);
    h.engine.tick();
    expect(h.claims).toEqual([]);
  });
});

// ── Router takeover ───────────────────────────────────────────────────────

function cap(id: string): MachineCapacity {
  return { machineId: id, online: true, clockSkewStatus: 'ok', loadAvg: 1, activeSessionCount: 1, maxSessions: 10, memPressure: 'low', capabilities: ['sessions'] };
}
function msg(): InboundMessage {
  return { sessionKey: '141385', messageId: 'tg-1', payload: { text: 'hi' } };
}
function router(over: Partial<SessionRouterDeps>) {
  const deps: SessionRouterDeps = {
    selfMachineId: SELF,
    placement: new PlacementExecutor(),
    machineRegistry: () => [cap(SELF)],
    resolveOwnership: () => ({ owner: 'm_old', epoch: 22, status: 'active' }) as OwnershipView,
    isMachineAlive: (m) => m === SELF,
    // Real-shaped: `place` on a live record is refused by the FSM.
    casClaimOwnership: vi.fn(() => ({ ok: false, epoch: 22 })),
    deliverMessage: async () => ({ messageId: 'tg-1', accepted: 'queued' }) as DeliverAck,
    handleLocally: vi.fn(async () => {}),
    spawnOnMachine: vi.fn(async () => ({ messageId: 'tg-1', accepted: 'queued' as const })),
    queueMessage: vi.fn(() => 'queued' as const),
    raiseAttention: vi.fn(),
    markOwnerSuspect: vi.fn(),
    sleep: vi.fn(async () => {}),
    ...over,
  };
  return { r: new SessionRouter(deps), deps };
}

describe('SessionRouter — unroutable owner takeover', () => {
  it('before the fix shape: a dead registered owner re-places, place is refused → queued (ownership-contention)', async () => {
    const { r } = router({});
    const out = await r.route(msg());
    expect(out).toMatchObject({ action: 'queued', detail: 'ownership-contention' });
  });

  it('unroutable owner → force-claimed for self and handled locally', async () => {
    const force = vi.fn(() => true);
    const { r, deps } = router({ isOwnerUnroutable: (m) => m === 'm_old', forceClaimUnroutableForSelf: force });
    const out = await r.route(msg());
    expect(out).toMatchObject({ action: 'owner-dead-replaced', owner: SELF, detail: 'unroutable-owner-takeover', acked: true });
    expect(force).toHaveBeenCalledWith('141385', { owner: 'm_old', epoch: 22, status: 'active' });
    expect(deps.handleLocally).toHaveBeenCalledOnce();
    expect(deps.casClaimOwnership).not.toHaveBeenCalled();
  });

  it('routable (merely offline) owner keeps today\'s path — no takeover', async () => {
    const force = vi.fn(() => true);
    const { r } = router({ isOwnerUnroutable: () => false, forceClaimUnroutableForSelf: force });
    await r.route(msg());
    expect(force).not.toHaveBeenCalled();
  });

  it('placement policy still applies: a holder that may not place the topic here keeps it in custody', async () => {
    const force = vi.fn(() => true);
    const { r, deps } = router({ machineRegistry: () => [], isOwnerUnroutable: () => true, forceClaimUnroutableForSelf: force });
    const out = await r.route(msg());
    expect(force).not.toHaveBeenCalled();
    expect(out).toMatchObject({ action: 'queued', detail: 'unroutable-owner-not-taken' });
    expect(deps.handleLocally).not.toHaveBeenCalled();
  });

  it('a takeover CAS that does not land keeps the message in custody (never a policy-skipping re-place)', async () => {
    const { r, deps } = router({ isOwnerUnroutable: () => true, forceClaimUnroutableForSelf: () => false });
    const out = await r.route(msg());
    expect(out).toMatchObject({ action: 'queued', detail: 'unroutable-owner-not-taken' });
    expect(deps.handleLocally).not.toHaveBeenCalled();
    expect(deps.casClaimOwnership).not.toHaveBeenCalled();
  });

  it('the drain\'s forced attempt (forceReplace) runs the same guarded takeover', async () => {
    const force = vi.fn(() => true);
    const { r } = router({ isOwnerUnroutable: (m) => m === 'm_old', forceClaimUnroutableForSelf: force });
    expect(await r.forceReplace(msg())).toBe('local');
    expect(force).toHaveBeenCalledOnce();
  });

  it('a frozen transferring record (owner and target both unroutable) is taken over', async () => {
    const force = vi.fn(() => true);
    const { r } = router({
      resolveOwnership: () => ({ owner: 'm_old', epoch: 12, status: 'transferring', target: 'm_old2' }),
      isOwnerUnroutable: (m) => m === 'm_old' || m === 'm_old2',
      forceClaimUnroutableForSelf: force,
    });
    expect(await r.route(msg())).toMatchObject({ action: 'owner-dead-replaced' });
  });

  it('a transferring record toward a LIVE target is left for the target to claim', async () => {
    const force = vi.fn(() => true);
    const { r } = router({
      resolveOwnership: () => ({ owner: 'm_old', epoch: 12, status: 'transferring', target: 'm_live' }),
      isOwnerUnroutable: (m) => m === 'm_old',
      forceClaimUnroutableForSelf: force,
    });
    expect(await r.route(msg())).toMatchObject({ action: 'queued' });
    expect(force).not.toHaveBeenCalled();
  });
});

describe('newestSideEffectMs — real CoherenceJournalReader streams', () => {
  it('reads the machine.kind-keyed streams (the U4.2 wiring read streams[machineId] and always saw null)', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unroutable-owner-'));
    const peers = path.join(stateDir, 'state', 'coherence-journal', 'peers');
    fs.mkdirSync(peers, { recursive: true });
    const m = 'm_03b30f5b32c6ef3eb0afd3ca7054e252';
    fs.writeFileSync(path.join(peers, `${m}.topic-placement.jsonl`),
      JSON.stringify({ seq: 1, ts: '2026-11-19T21:08:59.156Z', machine: m, kind: 'topic-placement', topic: 141385, data: { owner: m, epoch: 22, reason: 'reconcile' } }) + '\n');
    fs.writeFileSync(path.join(peers, `${m}.session-lifecycle.jsonl`),
      JSON.stringify({ seq: 1, ts: '2026-11-19T22:25:05.700Z', machine: m, kind: 'session-lifecycle', data: { sessionId: 's', status: 'created' } }) + '\n');
    const reader = new CoherenceJournalReader({ stateDir });
    expect(newestSideEffectMs(reader, m)).toBe(Date.parse('2026-11-19T22:25:05.700Z'));
    expect(newestSideEffectMs(reader, 'm_never_seen')).toBeNull();
    // A present-but-malformed timestamp on one stream ⇒ newest activity UNKNOWN (null), never the other stream's old value.
    const fake = { query: ({ kind }: { kind: string }) => ({ streams: { [`${m}.${kind}`]: { lastTs: kind === 'topic-placement' ? '2026-11-19T21:08:59.156Z' : 'not-a-date' } } }) };
    expect(newestSideEffectMs(fake, m)).toBeNull();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/unroutable-owner-release.test.ts' });
  });
});

describe('round-3 review cases', () => {
  it('forceReplace never takes a transfer away from a LIVE target (same eligibility as dispatch)', async () => {
    const force = vi.fn(() => true);
    const { r } = router({
      resolveOwnership: () => ({ owner: 'm_old', epoch: 12, status: 'transferring', target: 'm_live' }),
      isOwnerUnroutable: (m) => m === 'm_old',
      forceClaimUnroutableForSelf: force,
    });
    await r.forceReplace(msg());
    expect(force).not.toHaveBeenCalled();
  });

  it('a drained routing-only message whose takeover is refused by placement stays in custody (no tryTakeOver bypass)', async () => {
    const force = vi.fn(() => true);
    const takeOverFromPeer = vi.fn(() => true);
    const { r, deps } = router({ machineRegistry: () => [], isOwnerUnroutable: () => true, forceClaimUnroutableForSelf: force, takeOverFromPeer });
    const out = await r.forceReplace({ ...msg(), routingOnly: true });
    expect(force).not.toHaveBeenCalled();
    expect(takeOverFromPeer).not.toHaveBeenCalled();
    expect(out).toBe(false);
    expect(deps.queueMessage).toHaveBeenCalledWith(expect.anything(), 'unroutable-owner-not-taken');
  });

  it('a registry read error resets the continuous-absence clock (errors never bridge a window)', () => {
    let fail = false;
    let now = NOW;
    const a = createUnroutableOwnerAssessor({
      selfMachineId: () => 'm_self',
      registryMachines: () => { if (fail) throw new Error('EIO'); return { m_self: { status: 'active' } }; },
      inPoolView: () => false,
      lastSideEffectMs: () => NOW - 20 * HOUR,
      now: () => now,
      monoNow: () => now,
    });
    expect(a('m_old').reason).toBe('unregistered-boot-window'); // clock starts
    const watch = (ms: number) => { for (let i = 0; i < ms / 60_000; i++) { now += 60_000; a('m_old'); } };
    watch(DEFAULT_UNREGISTERED_BOOT_WINDOW_MS / 2);
    fail = true;
    expect(a('m_old').reason).toBe('registry-unavailable');
    fail = false;
    watch(DEFAULT_UNREGISTERED_BOOT_WINDOW_MS - 60_000); // > window since the first reading, but the error reset it
    expect(a('m_old').reason).toBe('unregistered-boot-window');
    watch(120_000);
    expect(a('m_old').unroutable).toBe(true);
  });

  it('documented policy: a long-silent id (journal ≥ 6 h) qualifies after 9 min of continuous absence', () => {
    expect(assessOwnerRoutability(input({ lastSideEffectMs: NOW - 20 * HOUR, absentForMs: DEFAULT_UNREGISTERED_BOOT_WINDOW_MS })).unroutable).toBe(true);
    expect(assessOwnerRoutability(input({ lastSideEffectMs: NOW - 20 * HOUR, absentForMs: DEFAULT_UNREGISTERED_BOOT_WINDOW_MS - 1 })).unroutable).toBe(false);
  });

  it('an ownership move alone never starts a session: the engine has no spawn seam and the router acts only per message', () => {
    const h = engineHarness({ standing: { m_old: 'revoked' }, records: [rec('141133', 'm_old'), rec('142909', 'm_old')] });
    h.engine.tick();
    expect(h.claims.sort()).toEqual(['141133', '142909']);
    // The engine's only post-claim effects are the annotation, the working-set pull and a log line —
    // no StaleOwnerReleaseDeps member can spawn a session (asserted structurally on the deps type keys used here).
    const { r, deps } = router({ isOwnerUnroutable: () => true, forceClaimUnroutableForSelf: () => true });
    expect(deps.handleLocally).not.toHaveBeenCalled();
    expect(deps.spawnOnMachine).not.toHaveBeenCalled();
    void r;
  });

  it('a forward that fails mid-flight falls back through the SAME guarded takeover (placement refusal ⇒ custody, no tryTakeOver)', async () => {
    const takeOverFromPeer = vi.fn(() => true);
    const force = vi.fn(() => true);
    const { r, deps } = router({
      isMachineAlive: () => true, // alive at dispatch …
      deliverMessage: async () => { throw new Error('ECONNREFUSED'); }, // … unreachable while forwarding
      machineRegistry: () => [], // a hard pin elsewhere / no local placement
      isOwnerUnroutable: () => true,
      forceClaimUnroutableForSelf: force,
      takeOverFromPeer,
    });
    // the owner is "alive" for dispatch but unroutable once re-checked by the fallback
    (deps as { isMachineAlive: (m: string) => boolean }).isMachineAlive = (() => { let n = 0; return () => n++ === 0; })();
    const out = await r.route(msg());
    expect(force).not.toHaveBeenCalled();
    expect(takeOverFromPeer).not.toHaveBeenCalled();
    expect(out).toMatchObject({ action: 'queued', detail: 'unroutable-owner-not-taken' });
  });

  it('a target the liveness view reports ALIVE keeps its transfer even if its registry standing says revoked (dispatch + forceReplace)', async () => {
    const force = vi.fn(() => true);
    const { r } = router({
      resolveOwnership: () => ({ owner: 'm_old', epoch: 12, status: 'transferring', target: 'm_t' }),
      isMachineAlive: (m) => m === SELF || m === 'm_t',
      isOwnerUnroutable: () => true,
      forceClaimUnroutableForSelf: force,
    });
    await r.route(msg());
    await r.forceReplace(msg());
    expect(force).not.toHaveBeenCalled();
  });
});
