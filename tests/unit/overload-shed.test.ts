// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * trustworthy-machine-load Part D (docs/specs/trustworthy-machine-load-and-mesh-floor.md):
 * moving existing work off a machine that stays overloaded.
 *
 *  - OverloadShedPlanner: source only after 3 min closed; target rules (live < 2 min,
 *    verdict ok, not refusing, not refusing recently, headroom after reservations);
 *    dry-run / non-enforced admission propose nothing; pinned, Slack and
 *    autonomous-run topics stay; one live move; 2/hour breaker; 2 tries per topic
 *    per episode; a failed target (never claims) expires; a claim drops the entry;
 *    a restart mid-move keeps the live move, breaker and episode.
 *  - OwnershipReconciler: overload moves after pins at lower precedence (a pinned
 *    topic is never overload-moved), only the live owner sheds, busy / autonomous /
 *    offline target defer, pacing; and unpinned in-flight transfers are driven to
 *    claim (target) or abort past the deadline regardless of target liveness (source).
 *  - Concurrent planners: two overloaded machines each move only their own topic.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OverloadShedPlanner, DEFAULT_OVERLOAD_SHED, MAX_ATTEMPTS_PER_TOPIC, type OverloadShedConfig } from '../../src/core/OverloadShedPlanner.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import { OwnershipReconciler, type ReconcilerMachineView } from '../../src/core/OwnershipReconciler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { planRebalance } from '../../src/core/RebalancePlanner.js';
import { StaleOwnerReleaseEngine } from '../../src/core/StaleOwnerReleaseEngine.js';
import type { MachineCapacity } from '../../src/core/types.js';
import type { MachineLoadReport } from '../../src/core/machineLoadReport.js';

const SELF = 'm_self';
const PEER = 'm_peer';
const MIN = 60_000;

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'overload-shed-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) SafeFsExecutor.safeRmSync(dirs.pop()!, { recursive: true, force: true, operation: 'tests/unit/overload-shed.test.ts cleanup' });
});

function report(over: Partial<MachineLoadReport> = {}): MachineLoadReport {
  return {
    bootId: 'b', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores: 8, totalMemBytes: 1, loadPerCore: 0.5,
    cpuIdlePct: 60, memAvailablePct: 50, memPressureNative: 'normal', eventLoopLagP99Ms: 10,
    sessionsActive: 1, sessionsMax: 10, spawnCapSaturated: false, testRunnerSaturated: false,
    verdict: 'ok', uptimeS: 1000, ...over,
  };
}
function healthy(id: string, over: Partial<MachineCapacity> = {}): MachineCapacity {
  return {
    machineId: id, online: true, clockSkewStatus: 'ok', loadAvg: 1, activeSessionCount: 1, maxSessions: 10, memPressure: 'low',
    loadVerdict: 'ok', liveness: { state: 'live', evidenceAgeMs: 5_000, evidenceAt: 'x', source: 'direct' }, ...over,
  };
}
const selfRow = (): MachineCapacity => healthy(SELF, { loadVerdict: 'saturated', activeSessionCount: 10 });

interface PlannerRig {
  planner: OverloadShedPlanner;
  setNow: (t: number) => void;
  advance: (ms: number) => void;
  owner: Map<string, string>;
  state: { admission: { acceptingWork: boolean; enforced: boolean } | null; caps: MachineCapacity[]; topics: Array<{ sessionKey: string; pinned: boolean }>; cfg: Partial<OverloadShedConfig>; autonomous: Set<string>; busy: Set<string>; status: Map<string, { status: string; transferTo?: string }> | null };
  statePath: string;
  auditPath: string;
  audit: () => Array<Record<string, unknown>>;
  rebuild: () => OverloadShedPlanner;
}

function plannerRig(over: Partial<PlannerRig['state']> = {}, self = SELF, dir = tmp()): PlannerRig {
  let now = 1_700_000_000_000;
  const owner = new Map<string, string>();
  const state: PlannerRig['state'] = {
    admission: { acceptingWork: false, enforced: true },
    caps: [selfRow(), healthy(PEER)],
    topics: [{ sessionKey: '101', pinned: false }],
    cfg: { dryRun: false },
    autonomous: new Set(),
    busy: new Set(),
    status: null,
    ...over,
  };
  const statePath = path.join(dir, 'state', 'overload-shed.json');
  const auditPath = path.join(dir, 'logs', 'overload-shed.jsonl');
  const build = () => new OverloadShedPlanner({
    config: () => ({ ...DEFAULT_OVERLOAD_SHED, enabled: true, ...state.cfg }),
    selfMachineId: () => self,
    admission: () => state.admission,
    capacities: () => state.caps,
    ownedTopics: () => state.topics.filter((t) => (owner.get(t.sessionKey) ?? self) === self),
    ownerOf: (k) => owner.get(k) ?? self,
    placement: new PlacementExecutor(),
    hasLiveAutonomousRun: (k) => state.autonomous.has(k),
    isTopicBusy: (k) => state.busy.has(k),
    ...(state.status ? { statusOf: (k: string) => state.status!.get(k) ?? { status: 'active' } } : {}),
    statePath,
    auditPath,
    now: () => now,
  });
  const rig: PlannerRig = {
    planner: build(),
    setNow: (t) => { now = t; },
    advance: (ms) => { now += ms; },
    owner,
    state,
    statePath,
    auditPath,
    audit: () => fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [],
    rebuild: () => { rig.planner = build(); return rig.planner; },
  };
  return rig;
}

/** Tick every 15 s for `ms`. */
function run(rig: PlannerRig, ms: number): void {
  for (let t = 0; t < ms; t += 15_000) { rig.planner.tick(); rig.advance(15_000); }
}

describe('OverloadShedPlanner — source (D2)', () => {
  it('is not a source until admission has stayed closed for 3 minutes', () => {
    const rig = plannerRig();
    run(rig, 2.5 * MIN);
    expect(rig.planner.overloadMoves()).toEqual([]);
    expect(rig.planner.status().isSource).toBe(false);
    run(rig, MIN);
    expect(rig.planner.overloadMoves()).toEqual([{ sessionKey: '101', target: PEER, episodeId: expect.stringContaining(SELF) }]);
    expect(rig.audit().some((r) => r.event === 'proposed' && r.sessionKey === '101' && r.target === PEER)).toBe(true);
  });

  it('a reopen resets the 3-minute clock', () => {
    const rig = plannerRig();
    run(rig, 2.5 * MIN);
    rig.state.admission = { acceptingWork: true, enforced: true };
    rig.planner.tick();
    rig.state.admission = { acceptingWork: false, enforced: true };
    run(rig, 2.5 * MIN);
    expect(rig.planner.overloadMoves()).toEqual([]);
  });

  it('dry-run audits a would-move and proposes nothing', () => {
    const rig = plannerRig({ cfg: { dryRun: true } });
    run(rig, 4 * MIN);
    expect(rig.planner.overloadMoves()).toEqual([]);
    const would = rig.audit().filter((r) => r.event === 'would-move');
    expect(would.length).toBe(1); // deduped: at most one per topic/target per 5 min
    expect(would[0]).toMatchObject({ sessionKey: '101', target: PEER, reason: 'dry-run' });
  });

  it('admission in dry-run (not enforced) proposes nothing — peers would send the work straight back', () => {
    const rig = plannerRig({ admission: { acceptingWork: false, enforced: false } });
    run(rig, 4 * MIN);
    expect(rig.planner.overloadMoves()).toEqual([]);
    expect(rig.audit().find((r) => r.event === 'would-move')?.reason).toBe('admission-not-enforced');
  });

  it('disabled proposes nothing and forgets a live move', () => {
    const rig = plannerRig();
    run(rig, 4 * MIN);
    expect(rig.planner.overloadMoves()).toHaveLength(1);
    rig.state.cfg = { ...rig.state.cfg, enabled: false } as Partial<OverloadShedConfig>;
    rig.planner.tick();
    expect(rig.planner.overloadMoves()).toEqual([]);
  });
});

describe('OverloadShedPlanner — target rules (D2)', () => {
  const cases: Array<[string, Partial<MachineCapacity>]> = [
    ['stale evidence (over 2 min)', { liveness: { state: 'live', evidenceAgeMs: 3 * MIN, evidenceAt: 'x', source: 'direct' } }],
    ['not live (stale state)', { liveness: { state: 'stale', evidenceAgeMs: 30_000, evidenceAt: 'x', source: 'saved' } as MachineCapacity['liveness'] }],
    ['verdict elevated, not ok', { loadVerdict: 'elevated' }],
    ['verdict unknown', { loadVerdict: 'unknown' }],
    ['refusing work itself', { loadReportAgeMs: 5_000, loadReport: report({ acceptingWork: false, admissionEnforced: true }) }],
    ['no headroom (needs 2 free)', { activeSessionCount: 9, maxSessions: 10 }],
    ['unknown session limit', { maxSessions: undefined }],
  ];
  for (const [name, over] of cases) {
    it(`never targets a machine with ${name}`, () => {
      const rig = plannerRig({ caps: [selfRow(), healthy(PEER, over)] });
      run(rig, 4 * MIN);
      expect(rig.planner.overloadMoves()).toEqual([]);
      expect((rig.planner.status().counters as { noTarget: number }).noTarget).toBeGreaterThan(0);
    });
  }

  it('a machine seen refusing work is not a target for 30 minutes after it reopens', () => {
    const rig = plannerRig({ caps: [selfRow(), healthy(PEER, { loadReportAgeMs: 5_000, loadReport: report({ acceptingWork: false, admissionEnforced: true }) })] });
    run(rig, 4 * MIN);
    rig.state.caps = [selfRow(), healthy(PEER)]; // it reopens
    run(rig, 20 * MIN);
    expect(rig.planner.overloadMoves()).toEqual([]);
    run(rig, 12 * MIN);
    expect(rig.planner.overloadMoves()).toHaveLength(1);
  });

  it('picks the healthy machine over an ineligible one', () => {
    const rig = plannerRig({ caps: [selfRow(), healthy('m_busy', { loadVerdict: 'elevated', activeSessionCount: 0 }), healthy(PEER, { activeSessionCount: 6 })] });
    run(rig, 4 * MIN);
    expect(rig.planner.overloadMoves()[0]?.target).toBe(PEER);
  });
});

describe('OverloadShedPlanner — which topics move (D2)', () => {
  it('pinned, Slack (non-numeric / negative) and live-autonomous topics stay', () => {
    const rig = plannerRig({
      topics: [{ sessionKey: '101', pinned: true }, { sessionKey: '-5', pinned: false }, { sessionKey: 'slack:T:C', pinned: false }, { sessionKey: '102', pinned: false }],
      autonomous: new Set(['102']),
    });
    run(rig, 10 * MIN);
    expect(rig.planner.overloadMoves()).toEqual([]);
  });
});

describe('OverloadShedPlanner — brakes (D3/D4)', () => {
  it('one live move at a time; a claim drops it and releases the reservation', () => {
    const rig = plannerRig({ topics: [{ sessionKey: '101', pinned: false }, { sessionKey: '102', pinned: false }] });
    run(rig, 4 * MIN);
    const first = rig.planner.overloadMoves()[0]!;
    expect((rig.planner.status().reservations as unknown[]).length).toBe(1);
    run(rig, MIN);
    expect(rig.planner.overloadMoves()).toEqual([first]); // still the same single move
    rig.owner.set(first.sessionKey, PEER); // the target claims it
    rig.planner.tick();
    expect(rig.audit().some((r) => r.event === 'claimed' && r.sessionKey === first.sessionKey)).toBe(true);
    // The first reservation is released; the same tick may propose the next topic
    // (the breaker allows 2/hour), which takes its own reservation.
    const res = rig.planner.status().reservations as Array<{ sessionKey: string }>;
    expect(res.map((r) => r.sessionKey)).not.toContain(first.sessionKey);
    const second = rig.planner.overloadMoves()[0];
    expect(second?.sessionKey).toBe('102');
    expect(res.map((r) => r.sessionKey)).toEqual(['102']);
  });

  it('breaker: at most 2 moves per hour, checked before proposing', () => {
    const rig = plannerRig({ topics: ['101', '102', '103', '104'].map((k) => ({ sessionKey: k, pinned: false })) });
    let proposed = 0;
    for (let t = 0; t < 55 * MIN; t += 15_000) {
      rig.planner.tick();
      const mv = rig.planner.overloadMoves()[0];
      if (mv && rig.owner.get(mv.sessionKey) !== PEER) { proposed++; rig.owner.set(mv.sessionKey, PEER); }
      rig.advance(15_000);
    }
    expect(proposed).toBe(2);
    expect(rig.audit().some((r) => r.event === 'breaker-held')).toBe(true);
  });

  it('a failed target (never claims) expires, and a topic gets at most 2 tries per overload episode', () => {
    const rig = plannerRig();
    for (let i = 0; i < 8 * 60; i++) { rig.planner.tick(); rig.advance(15_000); } // 2 hours
    const proposed = rig.audit().filter((r) => r.event === 'proposed').length;
    const expired = rig.audit().filter((r) => r.event === 'expired').length;
    expect(proposed).toBe(MAX_ATTEMPTS_PER_TOPIC);
    expect(expired).toBe(MAX_ATTEMPTS_PER_TOPIC);
    expect(rig.planner.overloadMoves()).toEqual([]);
  });

  it('restart mid-move: the live move, breaker and episode survive', () => {
    const rig = plannerRig({ topics: [{ sessionKey: '101', pinned: false }, { sessionKey: '102', pinned: false }] });
    run(rig, 4 * MIN);
    const live = rig.planner.overloadMoves()[0]!;
    rig.rebuild(); // a server restart (same state file)
    expect(rig.planner.overloadMoves()).toEqual([live]);
    expect(rig.planner.status().movesLastHour).toBe(1);
    expect(JSON.parse(fs.readFileSync(rig.statePath, 'utf-8')).episode).not.toBeNull();
  });

  it('a corrupt state file starts empty, never throws', () => {
    const rig = plannerRig();
    fs.mkdirSync(path.dirname(rig.statePath), { recursive: true });
    fs.writeFileSync(rig.statePath, '{not json');
    expect(() => rig.rebuild()).not.toThrow();
    expect(rig.planner.overloadMoves()).toEqual([]);
  });
});

describe('concurrent planners (two overloaded machines)', () => {
  it('each moves only its own topic, one at a time', () => {
    const shared = [healthy('m_a', { loadVerdict: 'saturated', activeSessionCount: 10 }), healthy('m_b', { loadVerdict: 'saturated', activeSessionCount: 10 }), healthy(PEER, { activeSessionCount: 1, maxSessions: 20 })];
    const a = plannerRig({ caps: shared, topics: [{ sessionKey: '201', pinned: false }] }, 'm_a');
    const b = plannerRig({ caps: shared, topics: [{ sessionKey: '202', pinned: false }] }, 'm_b');
    run(a, 4 * MIN); run(b, 4 * MIN);
    expect(a.planner.overloadMoves()).toEqual([{ sessionKey: '201', target: PEER, episodeId: expect.stringContaining('m_a') }]);
    expect(b.planner.overloadMoves()).toEqual([{ sessionKey: '202', target: PEER, episodeId: expect.stringContaining('m_b') }]);
  });
});

// ── OwnershipReconciler: overload moves + unpinned transfer driving ──────────

interface ReconRig {
  reg: SessionOwnershipRegistry;
  pins: TopicPlacementPinStore;
  recon: OwnershipReconciler;
  setNow: (t: number) => void;
}

function reconRig(opts: {
  self?: string;
  moves?: () => Array<{ sessionKey: string; target: string; episodeId: string }>;
  drive?: boolean;
  machines?: ReconcilerMachineView[];
  busy?: (k: string) => boolean;
  autonomous?: (k: string) => boolean;
  maxMovesPerTick?: number;
  reg?: SessionOwnershipRegistry;
} = {}): ReconRig {
  const dir = tmp();
  const nonces = new Set<string>();
  const reg = opts.reg ?? new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: (k) => nonces.has(k), recordNonce: (k) => nonces.add(k) });
  const pins = new TopicPlacementPinStore({ filePath: path.join(dir, 'pins.json'), now: () => new Date(Date.now() - 60_000) });
  let now = Date.now();
  const machines = opts.machines ?? [{ machineId: SELF, online: true, lastSeenMs: now }, { machineId: PEER, online: true, lastSeenMs: now }];
  const recon = new OwnershipReconciler({
    enabled: () => true,
    dryRun: () => false,
    selfMachineId: () => opts.self ?? SELF,
    pinStore: () => pins,
    ownership: reg,
    machines: () => machines,
    isTopicBusy: opts.busy ?? (() => false),
    emitPlacement: () => {},
    debounceMs: 0,
    transferDeadlineMs: 120_000,
    ...(opts.autonomous ? { hasLiveAutonomousRun: opts.autonomous } : {}),
    ...(opts.maxMovesPerTick !== undefined ? { maxMovesPerTick: opts.maxMovesPerTick } : {}),
    ...(opts.moves ? { overloadMoves: opts.moves } : {}),
    ...(opts.drive !== undefined ? { driveUnpinnedTransfers: () => opts.drive! } : {}),
    now: () => now,
  });
  return { reg, pins, recon, setNow: (t) => { now = t; } };
}

function ownActive(reg: SessionOwnershipRegistry, key: string, owner = SELF): void {
  expect(reg.cas({ type: 'place', machineId: owner }, { sessionKey: key, sender: owner, nonce: `p-${key}` }).ok).toBe(true);
  expect(reg.cas({ type: 'claim', machineId: owner }, { sessionKey: key, sender: owner, nonce: `c-${key}` }).ok).toBe(true);
}
const mv = (k: string, target = PEER) => ({ sessionKey: k, target, episodeId: 'ep' });

describe('OwnershipReconciler — overload moves (D1)', () => {
  it('transfers an active, self-owned, unpinned topic to the target', () => {
    const r = reconRig({ moves: () => [mv('301')] });
    ownActive(r.reg, '301');
    const rep = r.recon.tick();
    expect(rep.transfers).toBe(1);
    expect(rep.overloadTransfers).toBe(1);
    expect(r.reg.read('301')).toMatchObject({ status: 'transferring', transferTo: PEER });
  });

  it('a pinned topic is never overload-moved, and nothing is written to the pin store', () => {
    const r = reconRig({ moves: () => [mv('302')] });
    ownActive(r.reg, '302');
    r.pins.set('302', SELF); // pinned here
    const rep = r.recon.tick();
    expect(rep.overloadTransfers ?? 0).toBe(0);
    expect(r.reg.read('302')?.status).toBe('active');
    expect(r.pins.get('302')?.preferredMachine).toBe(SELF);
  });

  it('only the live owner sheds (a topic owned elsewhere is skipped)', () => {
    const r = reconRig({ moves: () => [mv('303')] });
    ownActive(r.reg, '303', PEER);
    expect(r.recon.tick().transfers).toBe(0);
  });

  it('defers a busy topic, a live autonomous run, and an offline target', () => {
    const busy = reconRig({ moves: () => [mv('304')], busy: () => true });
    ownActive(busy.reg, '304');
    expect(busy.recon.tick()).toMatchObject({ transfers: 0, deferredBusy: 1 });

    const auto = reconRig({ moves: () => [mv('305')], autonomous: () => true });
    ownActive(auto.reg, '305');
    expect(auto.recon.tick()).toMatchObject({ transfers: 0, deferredAutonomousRun: 1 });

    const off = reconRig({ moves: () => [mv('306')], machines: [{ machineId: SELF, online: true, lastSeenMs: Date.now() }, { machineId: PEER, online: false, lastSeenMs: 0 }] });
    ownActive(off.reg, '306');
    expect(off.recon.tick()).toMatchObject({ transfers: 0, deferredTargetOffline: 1 });
  });

  it('is paced by maxMovesPerTick', () => {
    const r = reconRig({ moves: () => [mv('307'), mv('308')], maxMovesPerTick: 1 });
    ownActive(r.reg, '307'); ownActive(r.reg, '308');
    expect(r.recon.tick()).toMatchObject({ transfers: 1, deferredPaced: 1 });
  });

  it('a throwing proposer yields no moves (pins unaffected)', () => {
    const r = reconRig({ moves: () => { throw new Error('boom'); } });
    expect(() => r.recon.tick()).not.toThrow();
  });
});

describe('OwnershipReconciler — unpinned in-flight transfers (D4)', () => {
  function transferring(reg: SessionOwnershipRegistry, key: string): void {
    ownActive(reg, key);
    expect(reg.cas({ type: 'transfer', to: PEER }, { sessionKey: key, sender: SELF, nonce: `t-${key}` }).ok).toBe(true);
  }

  it('the target claims an unpinned transferring record', () => {
    const reg = reconRig().reg;
    transferring(reg, '401');
    const target = reconRig({ self: PEER, drive: true, reg });
    const rep = target.recon.tick();
    expect(rep.unpinnedClaims).toBe(1);
    expect(reg.read('401')).toMatchObject({ status: 'active', ownerMachineId: PEER });
  });

  it('the source aborts past the deadline even when the target looks online (and not before)', () => {
    const r = reconRig({ drive: true });
    transferring(r.reg, '402');
    expect(r.recon.tick().unpinnedAborts ?? 0).toBe(0); // inside the deadline
    r.setNow(Date.now() + 121_000);
    const rep = r.recon.tick();
    expect(rep.unpinnedAborts).toBe(1);
    expect(r.reg.read('402')).toMatchObject({ status: 'active', ownerMachineId: SELF });
  });

  it('off by default: an unpinned transfer is left alone (today\'s behaviour)', () => {
    const r = reconRig();
    transferring(r.reg, '403');
    r.setNow(Date.now() + 10 * MIN);
    expect(r.recon.tick().aborts).toBe(0);
    expect(r.reg.read('403')?.status).toBe('transferring');
  });

  it('end to end: an overload move the target never claims is aborted back to the source', () => {
    const r = reconRig({ moves: () => [mv('404')], drive: true });
    ownActive(r.reg, '404');
    expect(r.recon.tick().overloadTransfers).toBe(1);
    r.setNow(Date.now() + 121_000);
    const rep = r.recon.tick();
    expect(rep.unpinnedAborts).toBe(1);
    expect(r.reg.read('404')).toMatchObject({ status: 'active', ownerMachineId: SELF });
  });
});

// ── CMT-1568: the rebalance proposer threads the channel scope ───────────────
describe('planRebalance threads the session channel (CMT-1568)', () => {
  it('never proposes a Slack conversation onto a machine that cannot reach its workspace', () => {
    const machines: MachineCapacity[] = [
      healthy('src', { activeSessionCount: 10, maxSessions: 10 }),
      healthy('wrong-ws', { activeSessionCount: 0, servesChannels: { slack: { workspaceIds: ['T_OTHER'] } } }),
      healthy('right-ws', { activeSessionCount: 5, servesChannels: { slack: { workspaceIds: ['T_MINE'] } } }),
    ];
    const moves = planRebalance({
      machines, now: 10 ** 9, rebalanceThresholdPercent: 0.85, placementCooldownMs: 0,
      sessions: [{ sessionKey: 's1', ownerMachineId: 'src', channel: { platform: 'slack', workspaceId: 'T_MINE' } }],
    }, new PlacementExecutor());
    expect(moves).toEqual([expect.objectContaining({ sessionKey: 's1', toMachine: 'right-ws' })]);
  });

  it('isSource / targetEligible overrides replace the ratio rule and filter targets', () => {
    const moves = planRebalance({
      machines: [healthy('src', { activeSessionCount: 1 }), healthy('a', { activeSessionCount: 0 }), healthy('b', { activeSessionCount: 3 })],
      now: 10 ** 9, rebalanceThresholdPercent: 0.85, placementCooldownMs: 0,
      sessions: [{ sessionKey: 's1', ownerMachineId: 'src' }],
      isSource: (m) => m.machineId === 'src', // not over the ratio, but a source by override
      targetEligible: (m) => m.machineId === 'b',
    }, new PlacementExecutor());
    expect(moves).toEqual([expect.objectContaining({ fromMachine: 'src', toMachine: 'b' })]);
  });
});

// ── D5: stale-owner notices describe a struggling / refusing owner honestly ──
describe('stale-owner notice wording (D5)', () => {
  function engine(liveness?: MachineCapacity['liveness']) {
    return new StaleOwnerReleaseEngine({ ownerLiveness: () => liveness } as unknown as ConstructorParameters<typeof StaleOwnerReleaseEngine>[0]);
  }
  it('struggling and refusing owners are not described as gone', () => {
    expect(engine({ state: 'unreachable', shape: 'struggling', evidenceAgeMs: 1, evidenceAt: 'x', source: 'direct' }).describeOwner('m')).toMatch(/struggling/);
    expect(engine({ state: 'unreachable', shape: 'refusing', evidenceAgeMs: 1, evidenceAt: 'x', source: 'direct' }).describeOwner('m')).toMatch(/refusing connections/);
    expect(engine({ state: 'live', evidenceAgeMs: 1, evidenceAt: 'x', source: 'direct' }).describeOwner('m')).toMatch(/still answers/);
  });
  it('silent or unknown owners keep the neutral wording', () => {
    expect(engine({ state: 'unreachable', shape: 'silent', evidenceAgeMs: 1, evidenceAt: 'x', source: 'direct' }).describeOwner('m')).toBe('has been unreachable');
    expect(engine(undefined).describeOwner('m')).toBe('has been unreachable');
  });
});

// ── Second-pass review fixes ────────────────────────────────────────────────
describe('review fixes: moves that do not land', () => {
  it('a started transfer that is aborted back ends the entry (no re-proposal of the same try) and keeps one move at a time while in flight', () => {
    const status = new Map<string, { status: string; transferTo?: string }>();
    const rig = plannerRig({ status, topics: [{ sessionKey: '101', pinned: false }, { sessionKey: '102', pinned: false }] });
    run(rig, 4 * MIN);
    const mv = rig.planner.overloadMoves()[0]!;
    status.set(mv.sessionKey, { status: 'transferring', transferTo: mv.target });
    rig.planner.tick();
    expect(rig.planner.overloadMoves()).toEqual([]); // never handed out again once started
    rig.advance(11 * MIN); // past the entry TTL, transfer still in flight
    rig.planner.tick();
    expect((rig.planner.status().liveMove as { sessionKey: string } | null)?.sessionKey).toBe(mv.sessionKey); // slot held
    expect((rig.planner.status().reservations as unknown[]).length).toBe(1); // reservation held too
    status.set(mv.sessionKey, { status: 'active' }); // the source aborted it back
    rig.planner.tick();
    expect(rig.audit().some((r) => r.event === 'aborted' && r.sessionKey === mv.sessionKey)).toBe(true);
  });

  it('a proposal that expires without its transfer ever starting is refunded, at most twice per topic per episode', () => {
    const rig = plannerRig({ status: new Map() }); // status always 'active': the reconciler never acts
    for (let i = 0; i < 8 * 60; i++) { rig.planner.tick(); rig.advance(15_000); } // 2 hours
    const expired = rig.audit().filter((r) => r.event === 'expired');
    expect(expired.filter((r) => r.refunded === true)).toHaveLength(2);
    expect(rig.audit().filter((r) => r.event === 'proposed')).toHaveLength(MAX_ATTEMPTS_PER_TOPIC + 2);
    expect(rig.planner.overloadMoves()).toEqual([]);
  });

  it('busy topics are never proposed (they would only use up the budget)', () => {
    const rig = plannerRig({ busy: new Set(['101']) });
    run(rig, 10 * MIN);
    expect(rig.planner.overloadMoves()).toEqual([]);
  });
});

describe('review fixes: reconciler', () => {
  it('an overload transfer the target does not claim is aborted once and never re-initiated from the same episode', () => {
    let now = Date.now();
    const r = reconRig({ moves: () => [mv('501')], drive: true });
    r.setNow(now);
    ownActive(r.reg, '501');
    let transfers = 0; let aborts = 0;
    for (let i = 0; i < 40; i++) { // 10 minutes of 15 s ticks
      const rep = r.recon.tick();
      transfers += rep.transfers; aborts += rep.aborts;
      now += 15_000; r.setNow(now);
    }
    expect(transfers).toBe(1);
    expect(aborts).toBe(1);
    expect(r.reg.read('501')).toMatchObject({ status: 'active', ownerMachineId: SELF });
  });

  it('a target that is itself refusing work does not claim moved work', () => {
    const reg = reconRig().reg;
    ownActive(reg, '502');
    expect(reg.cas({ type: 'transfer', to: PEER }, { sessionKey: '502', sender: SELF, nonce: 't-502' }).ok).toBe(true);
    const target = new OwnershipReconciler({
      enabled: () => true, dryRun: () => false, selfMachineId: () => PEER, pinStore: () => null, ownership: reg,
      machines: () => [{ machineId: SELF, online: true, lastSeenMs: Date.now() }, { machineId: PEER, online: true, lastSeenMs: Date.now() }],
      isTopicBusy: () => false, emitPlacement: () => {}, debounceMs: 0,
      driveUnpinnedTransfers: () => true, acceptingMovedWork: () => false,
    });
    expect(target.tick().unpinnedClaims ?? 0).toBe(0);
    expect(reg.read('502')?.status).toBe('transferring');
  });
});
