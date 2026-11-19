/**
 * Tier-1 unit tests for agent-sessions-placed-by-load Step 1 (src/core/agentSessionPlacement.ts):
 * the busy test (load, verdict, memory), peer room, the decision, the durable placement
 * store, live placement outcomes and the pool-tick reconciler.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MachineCapacity } from '../../src/core/types.js';
import type { MachineLoadReport } from '../../src/core/machineLoadReport.js';
import {
  AgentSessionPlacementService, AgentSessionPlacementStore, PLACEMENT_STORE_MAX, RECONCILE_WINDOW_MS, LIVE_RECHECK_MS,
  agentSessionReservations, decideAgentSessionPlacement, isUnresolved, peerRoom, selfLoadState, travelBlocker,
  sessionRunningIn, agentSessionPlacementEnabled,
} from '../../src/core/agentSessionPlacement.js';
import { heavyReservations, type ForwardOutcome } from '../../src/core/heavyWorkPlacement.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const GIB = 1024 ** 3;
function row(machineId: string, o: { cores?: number; mem?: number; lpc?: number | null; verdict?: MachineLoadReport['verdict']; memoryPressured?: boolean; online?: boolean; quotaBlocked?: boolean; nickname?: string } = {}): MachineCapacity {
  const lpc = o.lpc === undefined ? 0.2 : o.lpc;
  const report = lpc === null ? undefined : {
    bootId: 'b', seq: 1, sampleAgeMs: 0, platform: 'darwin', cores: o.cores ?? 16, totalMemBytes: (o.mem ?? 64) * GIB, loadPerCore: lpc,
    cpuIdlePct: 40, memAvailablePct: o.memoryPressured ? 3 : 40, memPressureNative: o.memoryPressured ? 'critical' : 'normal', eventLoopLagP99Ms: 5,
    sessionsActive: 1, sessionsMax: 25, spawnCapSaturated: false, testRunnerSaturated: false, verdict: o.verdict ?? 'ok', uptimeS: 1000,
    ...(o.memoryPressured !== undefined ? { memoryPressured: o.memoryPressured } : {}),
  } as MachineLoadReport;
  return {
    machineId, nickname: o.nickname ?? machineId, online: o.online ?? true, activeSessionCount: 1, maxSessions: 25,
    loadVerdict: o.verdict ?? 'ok', ...(report ? { loadReport: report, loadReportAgeMs: 1000 } : {}),
    ...(o.quotaBlocked ? { quotaState: { blocked: true } } : {}),
  } as unknown as MachineCapacity;
}

beforeEach(() => { agentSessionReservations.clear(); heavyReservations.clear(); });

describe('selfLoadState: is this machine busy?', () => {
  it('room below 1.0 per core, busy at or above it', () => {
    expect(selfLoadState(row('s', { lpc: 0.99 })).state).toBe('room');
    expect(selfLoadState(row('s', { lpc: 1.0 }))).toMatchObject({ state: 'busy', busyBy: 'load' });
  });
  it('busy on its own saturated/impaired verdict even at low load', () => {
    expect(selfLoadState(row('s', { lpc: 0.3, verdict: 'impaired' }))).toMatchObject({ state: 'busy', busyBy: 'verdict' });
  });
  it('busy when its own report says it is short of memory, even at low CPU load', () => {
    const r = selfLoadState(row('s', { lpc: 0.3, memoryPressured: true }));
    expect(r).toMatchObject({ state: 'busy', busyBy: 'memory' });
    expect(r.memory).toMatch(/memory/);
  });
  it('one low-memory sample without the 2-of-3 reading is not memory-busy', () => {
    expect(selfLoadState(row('s', { lpc: 0.3, memoryPressured: false })).state).toBe('room');
  });
  it('unknown with no fresh row of its own (stay local)', () => {
    expect(selfLoadState(undefined).state).toBe('unknown');
    expect(selfLoadState(row('s', { lpc: null })).state).toBe('unknown');
  });
});

describe('peerRoom', () => {
  it('fits with headroom; busy over 1.0; memory-short and quota-blocked never receive work', () => {
    expect(peerRoom(row('p', { lpc: 0.4 }), 'standard')).toEqual({ eligible: true, reason: 'fits' });
    expect(peerRoom(row('p', { lpc: 1.2 }), 'standard').reason).toBe('machine-busy');
    expect(peerRoom(row('p', { lpc: 0.1, memoryPressured: true }), 'light').reason).toBe('memory-short');
    expect(peerRoom(row('p', { lpc: 0.1, quotaBlocked: true }), 'standard').reason).toBe('quota-blocked');
    expect(peerRoom(row('p', { lpc: 0.1, online: false }), 'standard').reason).toBe('offline');
  });
  it('heavy keeps the size rule', () => {
    expect(peerRoom(row('mini', { cores: 10, mem: 16, lpc: 0.1 }), 'heavy').reason).toBe('machine-too-small');
    expect(peerRoom(row('mini', { cores: 10, mem: 16, lpc: 0.1 }), 'standard').eligible).toBe(true);
  });
  it('standard reservations add 0.25 per core each to the headroom test', () => {
    const p = row('p', { lpc: 0.6 });
    agentSessionReservations.record('p');
    expect(peerRoom(p, 'standard').eligible).toBe(true); // 0.85
    agentSessionReservations.record('p');
    expect(peerRoom(p, 'standard').eligible).toBe(false); // 1.1
  });
});

describe('decideAgentSessionPlacement', () => {
  const pool = (selfO: Parameters<typeof row>[1]) => [row('studio', selfO), row('m5', { lpc: 0.5, cores: 18, mem: 48 }), row('laptop', { lpc: 0.1, cores: 10, mem: 32 })];
  it('stays here while this machine has room (it is preferred)', () => {
    const d = decideAgentSessionPlacement({ capacities: pool({ lpc: 0.5 }), selfMachineId: 'studio', workWeight: 'standard' });
    expect(d).toMatchObject({ target: null, reason: 'self-has-room' });
  });
  it('busy → the least-loaded peer with room, never this machine', () => {
    const d = decideAgentSessionPlacement({ capacities: pool({ lpc: 1.6, verdict: 'saturated' }), selfMachineId: 'studio', workWeight: 'standard' });
    expect(d.target).toBe('laptop');
    expect(d.reason).toMatch(/^placement-/);
  });
  it('memory-short here → moves even at low CPU load', () => {
    const d = decideAgentSessionPlacement({ capacities: pool({ lpc: 0.3, memoryPressured: true }), selfMachineId: 'studio', workWeight: 'standard' });
    expect(d.target).toBe('laptop');
    expect(d.self.busyBy).toBe('memory');
  });
  it('a burst spreads: reservations shift the ranking to the next peer', () => {
    const caps = pool({ lpc: 1.6 });
    agentSessionReservations.record('laptop');
    agentSessionReservations.record('laptop');
    const d = decideAgentSessionPlacement({ capacities: caps, selfMachineId: 'studio', workWeight: 'standard' });
    expect(d.target).toBe('m5');
  });
  it('no eligible peer → local with the reason; no pool → local', () => {
    const caps = [row('studio', { lpc: 2 }), row('m5', { lpc: 1.5 })];
    expect(decideAgentSessionPlacement({ capacities: caps, selfMachineId: 'studio', workWeight: 'standard' })).toMatchObject({ target: null, reason: 'no-eligible-peer' });
    expect(decideAgentSessionPlacement({ capacities: [row('studio', { lpc: 2 })], selfMachineId: 'studio', workWeight: 'standard' }).reason).toBe('no-pool');
    expect(decideAgentSessionPlacement({ capacities: caps, selfMachineId: null, workWeight: 'standard' }).reason).toBe('no-pool');
  });
});

describe('travelBlocker and the gate', () => {
  it('only name/prompt/workWeight/framework/model travel', () => {
    expect(travelBlocker({ name: 'a', prompt: 'p', model: 'opus' }, {})).toBeNull();
    expect(travelBlocker({ name: 'a', prompt: 'p', topicId: 5 }, {})).toBe('topic-bound');
    expect(travelBlocker({ name: 'a', prompt: 'p', jobSlug: 'j' }, {})).toBe('options-do-not-travel');
    expect(travelBlocker({ name: 'a', prompt: 'p', ultracode: false }, {})).toBeNull();
    expect(travelBlocker({ name: 'a', prompt: 'p' }, { 'x-instar-bind-token': 't' })).toBe('options-do-not-travel');
  });
  it('dev-gated: on for a development agent, off on the fleet, explicit wins', () => {
    expect(agentSessionPlacementEnabled({ developmentAgent: true }, resolveDevAgentGate)).toBe(true);
    expect(agentSessionPlacementEnabled({}, resolveDevAgentGate)).toBe(false);
    expect(agentSessionPlacementEnabled({ developmentAgent: true, multiMachine: { placement: { agentSessions: { enabled: false } } } }, resolveDevAgentGate)).toBe(false);
  });
  it('sessionRunningIn reads arrays and {sessions}, and only running/starting rows', () => {
    expect(sessionRunningIn([{ name: 'h', status: 'running' }], 'h')).toBe(true);
    expect(sessionRunningIn({ sessions: [{ tmuxSession: 'echo-h', status: 'starting' }] }, 'x', { tmuxSession: 'echo-h' } as never)).toBe(true);
    expect(sessionRunningIn([{ name: 'h', status: 'completed' }], 'h')).toBe(false);
    expect(sessionRunningIn({ error: 'x' }, 'h')).toBeNull();
  });
});

describe('the placement store', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-store-')); });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/agent-session-placement.test.ts' }));

  it('survives a restart', () => {
    const f = path.join(dir, 'state', 'p.json');
    new AgentSessionPlacementStore(f).setPending('h', 'm5');
    expect(new AgentSessionPlacementStore(f).get('h')).toMatchObject({ machineId: 'm5', state: 'pending' });
  });
  it('a corrupt file is kept aside and reported, not silently replaced', () => {
    const f = path.join(dir, 'p.json');
    fs.writeFileSync(f, '{not json');
    const s = new AgentSessionPlacementStore(f);
    expect(s.loadError).not.toBeNull();
    expect(fs.readdirSync(dir).some((n) => n.startsWith('p.json.corrupt-'))).toBe(true);
  });
  it('drops only resolved entries, gone first; full when every entry is unresolved', () => {
    let now = Date.parse('2026-11-18T00:00:00Z');
    const s = new AgentSessionPlacementStore(path.join(dir, 'p.json'), () => now);
    for (let i = 0; i < PLACEMENT_STORE_MAX; i++) s.setPending(`h${i}`, 'm5');
    expect(s.isFull()).toBe(true);
    s.update('h7', { state: 'gone' });
    expect(s.isFull()).toBe(false);
    s.setPending('new', 'm5');
    expect(s.get('h7')).toBeNull();
    expect(s.get('h0')).not.toBeNull();
    now += 1;
  });
  it('not-observed holds the name 24 h; gone never does', () => {
    const now = Date.now();
    expect(isUnresolved({ machineId: 'm', state: 'not-observed', at: new Date(now - 3600_000).toISOString(), lastSeenAt: null, lastCheckAt: null, okReads: 1 }, now)).toBe(true);
    expect(isUnresolved({ machineId: 'm', state: 'not-observed', at: new Date(now - 25 * 3600_000).toISOString(), lastSeenAt: null, lastCheckAt: null, okReads: 1 }, now)).toBe(false);
    expect(isUnresolved({ machineId: 'm', state: 'gone', at: new Date(now).toISOString(), lastSeenAt: null, lastCheckAt: null, okReads: 1 }, now)).toBe(false);
  });
});

describe('the service: live placement and reconciliation', () => {
  let dir: string;
  let now: number;
  let peerSessions: unknown;
  let readFails: boolean;
  let attention: Array<{ id: string }>;
  let svc: AgentSessionPlacementService;
  const busyHere = () => decideAgentSessionPlacement({ capacities: [row('studio', { lpc: 1.8 }), row('m5', { lpc: 0.3 })], selfMachineId: 'studio', workWeight: 'standard', nowMs: now });
  const place = (forward: (id: string, b: Record<string, unknown>) => Promise<ForwardOutcome | 'no-address'>, name = 'helper-a') =>
    svc.placeLive({ name, weight: 'standard', body: { name, prompt: 'p' }, decision: busyHere, forward, reconcileReads: 2, reconcileGapMs: 0 });
  const started: ForwardOutcome = { kind: 'started', status: 201, body: { tmuxSession: 'echo-helper-a', id: 'sid-1' } };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-svc-'));
    now = Date.now();
    peerSessions = [];
    readFails = false;
    attention = [];
    svc = new AgentSessionPlacementService({
      store: new AgentSessionPlacementStore(path.join(dir, 'p.json'), () => now),
      logPath: path.join(dir, 'logs', 'asp.jsonl'),
      readPeerSessions: async () => { if (readFails) throw new Error('down'); return peerSessions; },
      raiseAttention: (i) => attention.push(i),
      nickname: (id) => (id === 'm5' ? 'Mac M5 Pro' : null),
      now: () => now,
      sleep: async () => {},
    });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/agent-session-placement.test.ts' }));

  it('started → 201 peer, recorded live, audit line without the prompt', async () => {
    const r = await place(async () => started);
    expect(r).toMatchObject({ kind: 'respond', status: 201, body: { placementOutcome: 'peer', placedOn: { machineId: 'm5', nickname: 'Mac M5 Pro' } } });
    expect(svc.deps.store.get('helper-a')).toMatchObject({ state: 'live', tmuxSession: 'echo-helper-a', sessionId: 'sid-1' });
    const log = fs.readFileSync(path.join(dir, 'logs', 'asp.jsonl'), 'utf8');
    expect(log).toContain('"outcome":"peer"');
    expect(log).not.toContain('"prompt"');
  });
  it('the record is written pending BEFORE the send', async () => {
    let seen: unknown = null;
    await place(async () => { seen = svc.deps.store.get('helper-a')?.state; return started; });
    expect(seen).toBe('pending');
  });
  it('a definite refusal → local-fallback, record removed, reservation released', async () => {
    const r = await place(async () => ({ kind: 'refused', status: 409, body: {}, code: 'admission-refused' }));
    expect(r).toMatchObject({ kind: 'local', outcome: 'local-fallback', reason: 'peer-refused:admission-refused' });
    expect(svc.deps.store.get('helper-a')).toBeNull();
    expect(agentSessionReservations.count('m5')).toBe(0);
  });
  it('session-exists on the peer → 409 exists-on-peer, never a local start, record kept', async () => {
    const r = await place(async () => ({ kind: 'refused', status: 409, body: {}, code: 'session-exists' }));
    expect(r).toMatchObject({ kind: 'respond', status: 409, body: { placementOutcome: 'exists-on-peer' } });
    expect(svc.deps.store.get('helper-a')?.state).toBe('live');
  });
  it('unconfirmed, then found running → 201', async () => {
    peerSessions = [{ name: 'helper-a', status: 'running' }];
    const r = await place(async () => ({ kind: 'unconfirmed', status: null, detail: 'TimeoutError' }));
    expect(r).toMatchObject({ kind: 'respond', status: 201, body: { placementOutcome: 'peer' } });
  });
  it('unconfirmed, not found → 202, no local start, the name is then read-only', async () => {
    const r = await place(async () => ({ kind: 'unconfirmed', status: null, detail: 'TimeoutError' }));
    expect(r).toMatchObject({ kind: 'respond', status: 202, body: { placementOutcome: 'unconfirmed', tmuxSession: 'helper-a' } });
    let sent = 0;
    const again = await place(async () => { sent++; return started; });
    expect(sent).toBe(0);
    expect(again).toMatchObject({ kind: 'respond', status: 202 });
  });
  it('a retry while the first copy runs lands on it (exists-on-peer), never a second copy', async () => {
    await place(async () => started);
    peerSessions = [{ tmuxSession: 'echo-helper-a', status: 'running' }];
    let sent = 0;
    const r = await place(async () => { sent++; return started; });
    expect(sent).toBe(0);
    expect(r).toMatchObject({ status: 409, body: { placementOutcome: 'exists-on-peer' } });
  });
  it('a finished (gone) name is free again, as local reuse is today', async () => {
    await place(async () => started);
    peerSessions = [];
    let sent = 0;
    const r = await place(async () => { sent++; return started; });
    expect(sent).toBe(1);
    expect(r).toMatchObject({ status: 201 });
  });
  it('concurrent same-name requests are serialized: exactly one send', async () => {
    let sent = 0;
    peerSessions = [{ name: 'helper-a', status: 'running' }];
    const fwd = async () => { sent++; await new Promise((r) => setTimeout(r, 10)); return started; };
    const [a, b] = await Promise.all([place(fwd), place(fwd)]);
    expect(sent).toBe(1);
    expect([a, b].map((x) => (x as { status: number }).status).sort()).toEqual([201, 409]);
  });
  it('no address → local-fallback without sending', async () => {
    const r = await place(async () => 'no-address');
    expect(r).toMatchObject({ kind: 'local', reason: 'target-unreachable' });
  });

  it('tick: a pending entry never seen becomes not-observed after the window and raises one attention item', async () => {
    svc.deps.store.setPending('h', 'm5');
    await svc.tick();
    expect(svc.deps.store.get('h')?.state).toBe('pending');
    now += RECONCILE_WINDOW_MS + 1;
    await svc.tick();
    expect(svc.deps.store.get('h')?.state).toBe('not-observed');
    await svc.tick();
    expect(attention).toHaveLength(1);
  });
  it('tick: an unreachable target stays unknown (elapsed time never makes it absent)', async () => {
    readFails = true;
    svc.deps.store.setPending('h', 'm5');
    now += RECONCILE_WINDOW_MS + 1;
    await svc.tick();
    expect(svc.deps.store.get('h')?.state).toBe('unknown');
    now += LIVE_RECHECK_MS * 10;
    await svc.tick();
    expect(svc.deps.store.get('h')?.state).toBe('unknown');
    expect(attention).toHaveLength(1);
  });
  it('the 24 h hold runs from when the entry became not-observed, not from the placement', async () => {
    readFails = true;
    svc.deps.store.setPending('h', 'm5');
    now += RECONCILE_WINDOW_MS + 1;
    await svc.tick();
    expect(svc.deps.store.get('h')?.state).toBe('unknown');
    now += 30 * 3600_000; // peer unreachable for 30 h
    readFails = false;
    peerSessions = [];
    await svc.tick();
    const e = svc.deps.store.get('h')!;
    expect(e.state).toBe('not-observed');
    expect(isUnresolved(e, now)).toBe(true);
    expect(isUnresolved(e, now + 25 * 3600_000)).toBe(false);
  });
  it('a held name lock makes a second start decision wait', async () => {
    const release = await svc.acquireNameLock('x');
    let second = false;
    const p = svc.acquireNameLock('x').then((r) => { second = true; r(); });
    await new Promise((r) => setTimeout(r, 5));
    expect(second).toBe(false);
    release();
    await p;
    expect(second).toBe(true);
  });
  it('tick: live → gone when a successful read no longer shows it', async () => {
    await place(async () => started);
    now += LIVE_RECHECK_MS + 1;
    peerSessions = [];
    await svc.tick();
    expect(svc.deps.store.get('helper-a')?.state).toBe('gone');
  });
});
