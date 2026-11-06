import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MaturationLadderService, type MaturationLadderDeps } from '../../src/monitoring/MaturationLadderService.js';
import { contractForRung, type LadderRung } from '../../src/monitoring/MaturationLadder.js';
import type { Initiative } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 86_400_000;
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) SafeFsExecutor.safeRmSync(r, { recursive: true, force: true, operation: 'MaturationLadderService.test' }); });

const ran = { id: 'ran', role: 'ran', source: 'jsonl-log', ref: { file: 'logs/x.jsonl', where: { kind: 'fired' }, value: 'count' }, direction: 'at-least', threshold: 2, minSamples: 1, windowDays: 14 };
const harm = { id: 'harm', role: 'harm', source: 'jsonl-log', ref: { file: 'logs/x.jsonl', where: { kind: 'error' }, value: 'count' }, direction: 'at-most', threshold: 0, minSamples: 2, windowDays: 14 };
const devRung = { soakDays: 3, advance: { kind: 'config', set: { 'monitoring.x.dryRun': false } }, metrics: [ran, harm] };
const fleetRung = { soakDays: 7, advance: { kind: 'code' }, metrics: [ran, harm] };
const xEntry = { id: 'monitoring.x', title: 'X feature', flag: { path: 'monitoring.x' }, disposition: 'ladder', final: 'default-on', risk: 'standard', tracking: { state: 'measured', plan: 'its log' }, rungs: { 'dev-agent-live': devRung, fleet: fleetRung } };

function make(over: { entries?: unknown[]; config?: Record<string, unknown>; shipped?: Record<string, unknown>; now?: number; deps?: Partial<MaturationLadderDeps>; d7Rows?: Array<{ featureId: string; status: string; dueSlotMs: number; contractHash: string }> } = {}) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ladder-service-'));
  roots.push(projectDir);
  fs.mkdirSync(path.join(projectDir, 'logs'), { recursive: true });
  const state = { now: over.now ?? 100 * DAY, config: JSON.parse(JSON.stringify(over.config ?? { developmentAgent: true, monitoring: { x: { dryRun: true } } })), commitments: [] as Array<Record<string, unknown>>, lease: true, topic: 128732 as number | null, writes: [] as string[], failWrite: false };
  const registered = new Map<string, () => { value: number; samples: number } | null>();
  const d7Rows = over.d7Rows ?? [];
  const deps: MaturationLadderDeps = {
    projectDir, machine: 'm1', now: () => state.now,
    readRegistry: () => JSON.stringify({ schema: 'feature-ladders/1', entries: over.entries ?? [xEntry] }),
    readLiveConfig: () => JSON.parse(JSON.stringify(state.config)),
    shippedDefaults: () => over.shipped ?? {},
    d7: {
      registerMaturationProjection: (ref, read) => { registered.set(ref, read); },
      readMaturationProjection: ref => registered.get(ref)?.() ?? null,
      maturationContractHash: () => 'hash',
      evaluations: () => d7Rows,
    },
    featureMetrics: null,
    guardEffective: () => new Map(),
    commitments: {
      record: input => { const c = { id: `CMT-${state.commitments.length + 1}`, ...input }; state.commitments.push(c); return { id: c.id }; },
      getActive: () => state.commitments as Array<{ externalKey?: string; id: string }>,
    },
    holdsLease: () => state.lease,
    reviewTopic: () => state.topic,
    isCoherenceCritical: () => false,
    setConfig: (dotPath, value) => {
      state.writes.push(dotPath);
      if (state.failWrite) return;
      const keys = dotPath.split('.');
      let o = state.config as Record<string, unknown>;
      for (const k of keys.slice(0, -1)) { o[k] = (o[k] as Record<string, unknown>) ?? {}; o = o[k] as Record<string, unknown>; }
      o[keys[keys.length - 1]] = value;
    },
    isDevelopmentAgent: () => true,
    ...over.deps,
  };
  const log = (rows: unknown[]) => fs.writeFileSync(path.join(projectDir, 'logs/x.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return { svc: new MaturationLadderService(deps), state, registered, log, projectDir, deps };
}
const readyRows = (now: number, days = 10) => Array.from({ length: days * 4 + 1 }, (_, i) => ({ featureId: 'monitoring-x', status: 'ready', dueSlotMs: now - i * DAY / 4, contractHash: 'hash' }));
const fired = (now: number, n = 3) => Array.from({ length: n }, (_, i) => ({ at: new Date(now - (i + 1) * DAY).toISOString(), kind: 'fired' }));
const auditLines = (dir: string) => fs.readFileSync(path.join(dir, 'logs/maturation-advances.jsonl'), 'utf-8').trim().split('\n').map(l => JSON.parse(l));

it('clears stale scanner errors when the validated ladder becomes the contract owner', () => {
  const { svc } = make();
  const base = { id: 'monitoring-x', title: 'X', rollout: { flagPath: 'monitoring.x', stage: 'dry-run', maturationContractError: 'invalid-shape' },
    rolloutAccounting: { disposition: 'active', sourcePrNumber: 7, rung: 'test-agent-live', maturationContractError: 'invalid-shape' } } as Initiative;
  const subject = svc.subjects([base]).find(i => i.id === base.id)!;
  expect(subject.rollout?.maturationEvaluation).toEqual(contractForRung(devRung as LadderRung));
  expect(subject.rollout?.maturationContractError).toBeUndefined();
  expect(subject.rolloutAccounting?.maturationContractError).toBeUndefined();
  expect(base.rollout?.maturationContractError).toBe('invalid-shape');
});

async function readyService(over: Parameters<typeof make>[0] = {}) {
  const now = 100 * DAY;
  const ctx = make({ now, d7Rows: readyRows(now), ...over });
  ctx.log(fired(now));
  await ctx.svc.refresh();
  return { ...ctx, now };
}
const moveBody = (over: Record<string, unknown> = {}) => ({ id: 'monitoring.x', target: 'dev-agent-live' as const, reason: 'numbers held and both readers agree', from: { 'monitoring.x.dryRun': true }, opinions: [{ family: 'claude', verdict: 'promote' }], ...over });

it('measurement contracts use fresh live rung selection rather than the UI cache', () => {
  const { svc, state } = make();
  expect(svc.features()[0].next).toBe('dev-agent-live');
  state.config = { developmentAgent: true, monitoring: { x: { dryRun: false } } };
  expect(svc.features()[0].next).toBe('dev-agent-live');
  expect(svc.measurementContracts()?.get('monitoring-x')).toEqual({ contract: contractForRung(fleetRung as LadderRung), overridesInitiative: true });
  state.config = { developmentAgent: false };
  expect(svc.measurementContracts()?.get('monitoring-x')?.overridesInitiative).toBe(false);
});

describe('the registry', () => {
  it('a bad file is reported, and nothing is raised or moved', () => {
    const { svc } = make({ entries: [{ id: 'bad' }] });
    expect(svc.error).toContain('ladder-file-invalid');
    expect(svc.entries).toEqual([]);
    expect(svc.raise()).toEqual([]);
    expect(svc.response().registry).toContain('ladder-file-invalid');
  });
});

describe('subjects (the scorer input)', () => {
  it('adds an in-memory subject on the next rung contract, and skips what nothing runs', () => {
    const { svc, state } = make();
    const subject = svc.subjects([]).find(i => i.id === 'monitoring-x')!;
    expect(subject.rollout?.stage).toBe('dry-run');
    expect(subject.rollout?.maturationEvaluation).toEqual(contractForRung(devRung as unknown as LadderRung));
    state.config = { developmentAgent: false };
    expect(svc.subjects([])).toEqual([]);
  });

  it('a spec-born initiative keeps its id and history, with the ladder contract', () => {
    const { svc } = make({ entries: [{ ...xEntry, subject: 'x-spec' }] });
    const base = { id: 'x-spec', title: 'T', rollout: { flagPath: 'monitoring.x', stage: 'live' } } as unknown as Initiative;
    const out = svc.subjects([base]);
    expect(out).toHaveLength(1);
    expect(out[0].rollout?.maturationEvaluation?.metrics).toHaveLength(2);
    expect(out[0].rollout?.stage).toBe('live');
  });

  it('never adds a subject for a composed or retired entry', () => {
    const { svc } = make({ entries: [xEntry, { ...xEntry, id: 'a.b', disposition: 'composed', composedInto: 'monitoring.x', rungs: {}, flag: { path: 'a.b' } }] });
    expect(svc.subjects([]).map(i => i.id)).toEqual(['monitoring-x']);
  });
});

describe('projections', () => {
  it('registers one per metric, serves cached numbers, and clamps to the ledger limit', async () => {
    const { svc, registered, log, state } = make();
    expect(registered.size).toBe(2);
    expect([...registered.values()][0]()).toBeNull();
    log(fired(state.now));
    await svc.refresh();
    const values = [...registered.values()].map(r => r());
    expect(values).toContainEqual({ value: 3, samples: 3 });
    expect(values).toContainEqual({ value: 0, samples: 3 });
  });
});

describe('features()', () => {
  it('reports state, thresholds and the move block', async () => {
    const { svc } = await readyService();
    const [f] = svc.features();
    expect(f).toMatchObject({ rung: 'dry-run', next: 'dev-agent-live', state: 'ready-to-advance', passing: 2, total: 2 });
    expect(f.move).toEqual({ kind: 'config', set: { 'monitoring.x.dryRun': false }, from: { 'monitoring.x.dryRun': true } });
    expect(svc.counts().withThresholds).toBe(1);
  });

  it('a composed flag shows its parent state, and names stuck rows', async () => {
    const now = 100 * DAY;
    const { svc, state } = make({ now, entries: [xEntry, { ...xEntry, id: 'a.b', disposition: 'composed', composedInto: 'monitoring.x', rungs: {}, flag: { path: 'a.b' } }], d7Rows: [{ featureId: 'monitoring-x', status: 'insufficient-evidence', dueSlotMs: now - 40 * DAY, contractHash: 'hash' }] });
    await svc.refresh();
    const [x, child] = svc.features();
    expect(x).toMatchObject({ state: 'no-data', stuck: 'stuck-blind' });
    expect(child).toMatchObject({ state: 'composed', because: 'no-data' });
    expect(svc.counts().stuckBlind).toBe(1);
    expect(state.commitments).toEqual([]);
  });

  it('?id matches the id, an alias or the subject', async () => {
    const { svc } = make({ entries: [{ ...xEntry, aliases: ['old.name'] }] });
    for (const id of ['monitoring.x', 'old.name', 'monitoring-x']) expect((svc.response(id).features as unknown[])).toHaveLength(1);
    expect((svc.response('nope').features as unknown[])).toHaveLength(0);
  });
});

describe('raise()', () => {
  it('records a beacon-free commitment and an audit row, once', async () => {
    const { svc, state, projectDir } = await readyService();
    expect(svc.raise()).toEqual(['monitoring.x']);
    expect(state.commitments[0]).toMatchObject({ externalKey: 'maturation:monitoring.x', topicId: 128732, beaconEnabled: false });
    expect(auditLines(projectDir).some(r => r.action === 'raise' && r.id === 'monitoring.x')).toBe(true);
    expect(svc.raise()).toEqual([]);
  });

  it('stays quiet with no topic, without the lease, and with no commitments store', async () => {
    const a = await readyService(); a.state.topic = null; expect(a.svc.raise()).toEqual([]);
    const b = await readyService(); b.state.lease = false; expect(b.svc.raise()).toEqual([]);
    const c = await readyService({ deps: { commitments: null } }); expect(c.svc.raise()).toEqual([]);
  });

  it('a closed commitment is not reopened for 7 days, so an extend decision sticks', async () => {
    const ctx = await readyService();
    ctx.svc.raise();
    ctx.state.commitments.length = 0;
    expect(ctx.svc.raise()).toEqual([]);
    ctx.state.now += 8 * DAY;
    await ctx.svc.refresh();
    (ctx.deps.d7 as unknown as { evaluations: () => unknown[] }).evaluations = () => readyRows(ctx.state.now);
    (ctx.svc as unknown as { viewCache: null }).viewCache = null;
    ctx.log(fired(ctx.state.now));
    await ctx.svc.refresh();
    expect(ctx.svc.raise()).toEqual(['monitoring.x']);
  });

  it('caps at 5 a pass, worst first, and leaves sensitive dark features alone', async () => {
    const now = 100 * DAY;
    const dark = (i: number, risk = 'standard') => ({ ...xEntry, id: `dark.f${i}`, flag: { path: `dark.f${i}` }, risk, rungs: { fleet: fleetRung } });
    const { svc, state } = make({ now, config: { developmentAgent: false }, entries: [...Array.from({ length: 7 }, (_, i) => dark(i)), dark(8, 'sensitive')] });
    await svc.refresh();
    expect(svc.raise()).toHaveLength(5);
    expect(state.commitments.map(c => c.externalKey)).not.toContain('maturation:dark.f8');
  });
});

describe('an unreadable config', () => {
  it('raises nothing, arms no watch, and leaves the scorer input alone', async () => {
    const { svc, state, deps, projectDir } = await readyService();
    const before = auditLines(projectDir).filter(r => r.action === 'rung-observed').length;
    deps.readLiveConfig = () => null;
    const fresh = new MaturationLadderService(deps);
    await fresh.refresh();
    expect(auditLines(projectDir).filter(r => r.action === 'rung-observed')).toHaveLength(before);
    expect(fresh.raise()).toEqual([]);
    expect(state.commitments).toEqual([]);
    expect(fresh.subjects([])).toEqual([]);
    expect(fresh.response().configReadable).toBe(false);
    void svc;
  });
});

describe('POST /maturation/moves floors', () => {
  it('applies, verifies, and writes intent before the outcome', async () => {
    const { svc, state, projectDir } = await readyService();
    const r = svc.applyMove(moveBody());
    expect(r).toMatchObject({ ok: true, old: { 'monitoring.x.dryRun': true } });
    expect((state.config.monitoring as { x: { dryRun: boolean } }).x.dryRun).toBe(false);
    const actions = auditLines(projectDir).map(row => row.action).filter(a => a.startsWith('move'));
    expect(actions).toEqual(['move-intent', 'move-applied']);
  });

  it('refuses each floor by name', async () => {
    const standard = await readyService();
    expect(standard.svc.applyMove(moveBody({ id: 'nope' }))).toMatchObject({ refused: 'unknown-feature' });
    expect(standard.svc.applyMove(moveBody({ from: { 'monitoring.x.dryRun': false } }))).toMatchObject({ refused: 'changed-since-read' });
    expect(standard.svc.applyMove(moveBody({ target: 'fleet' }))).toMatchObject({ refused: 'not-ready' });

    const sensitive = await readyService({ entries: [{ ...xEntry, risk: 'sensitive' }] });
    expect(sensitive.svc.applyMove(moveBody())).toMatchObject({ refused: 'sensitive' });

    const critical = await readyService({ deps: { isCoherenceCritical: () => true } });
    expect(critical.svc.applyMove(moveBody())).toMatchObject({ refused: 'sensitive', detail: 'must match across machines' });

    const notDev = await readyService({ deps: { isDevelopmentAgent: () => false } });
    expect(notDev.svc.applyMove(moveBody())).toMatchObject({ refused: 'not-a-development-agent' });

    const held = await readyService({ config: { developmentAgent: true, monitoring: { x: { dryRun: true } }, maturation: { ladder: { holds: { 'monitoring.x': 'operator said no' } } } } });
    expect(held.svc.applyMove(moveBody())).toMatchObject({ refused: 'held', detail: 'operator said no' });

    const code = await readyService({ entries: [{ ...xEntry, rungs: { 'dev-agent-live': { ...devRung, advance: { kind: 'code' } }, fleet: fleetRung } }] });
    expect(code.svc.applyMove(moveBody())).toMatchObject({ refused: 'not-a-config-move' });

    const collecting = make();
    await collecting.svc.refresh();
    expect(collecting.svc.applyMove(moveBody())).toMatchObject({ refused: 'not-ready' });
  });

  it('reports a write that did not take, and never calls it applied', async () => {
    const { svc, state, projectDir } = await readyService();
    state.failWrite = true;
    expect(svc.applyMove(moveBody())).toMatchObject({ ok: false, refused: 'write-not-verified' });
    expect(auditLines(projectDir).map(r => r.action)).toContain('move-failed');
    expect(auditLines(projectDir).map(r => r.action)).not.toContain('move-applied');
  });

  it('a start writes the entry start, not the promotion setting', async () => {
    const start = { ...xEntry, start: { set: { 'monitoring.x.enabled': true, 'monitoring.x.dryRun': true } } };
    const fleetAgent = make({ entries: [start], config: { developmentAgent: false }, deps: { isDevelopmentAgent: () => false } });
    await fleetAgent.svc.refresh();
    const r = fleetAgent.svc.applyMove({ id: 'monitoring.x', target: 'dev-agent-live', reason: 'start it', from: {}, opinions: [{}] });
    expect(r).toMatchObject({ refused: 'not-a-development-agent' });
    const dev = make({ entries: [start], config: { developmentAgent: true, monitoring: { x: { enabled: false } } } });
    await dev.svc.refresh();
    const ok = dev.svc.applyMove({ id: 'monitoring.x', target: 'dev-agent-live', reason: 'start it', from: { 'monitoring.x.enabled': false }, opinions: [{}] });
    expect(ok.ok).toBe(true);
    expect((dev.state.config.monitoring as Record<string, unknown>).x).toEqual({ enabled: true, dryRun: true });
    expect(dev.state.writes).not.toContain('monitoring.x.fleet');
  });
});

describe('revert', () => {
  it('still works after a pass observed the rung change, and holds the feature', async () => {
    const { svc, state } = await readyService();
    const r = svc.applyMove(moveBody());
    if (!r.ok) throw new Error('move');
    await svc.refresh();
    expect(svc.revertMove(r.moveId, 'harm rose')).toMatchObject({ ok: true });
    expect((state.config.monitoring as { x: { dryRun: boolean } }).x.dryRun).toBe(true);
    expect((state.config.maturation as { ladder: { holds: Record<string, string> } }).ladder.holds['monitoring.x']).toContain('harm rose');
    expect(svc.features()[0].state).toBe('held');
    expect(svc.revertMove(r.moveId, 'again')).toMatchObject({ refused: 'not-applied' });
  });

  it('refuses when a person changed the setting since, and for an unknown move', async () => {
    const { svc, state } = await readyService();
    const r = svc.applyMove(moveBody());
    if (!r.ok) throw new Error('move');
    (state.config.monitoring as { x: { dryRun: boolean } }).x.dryRun = true;
    expect(svc.revertMove(r.moveId, 'x')).toMatchObject({ refused: 'changed-since-move' });
    expect(svc.revertMove('nope', 'x')).toMatchObject({ refused: 'not-found' });
  });

  it('restores an absent value as absent', async () => {
    const now = 100 * DAY;
    const ctx = make({ now, d7Rows: readyRows(now), config: { developmentAgent: true, monitoring: { x: { enabled: true, dryRun: true } } }, entries: [{ ...xEntry, rungs: { 'dev-agent-live': { ...devRung, advance: { kind: 'config', set: { 'monitoring.x.dryRun': false, 'monitoring.x.extra': 1 } } }, fleet: fleetRung } }] });
    ctx.log(fired(now));
    await ctx.svc.refresh();
    const r = ctx.svc.applyMove(moveBody({ from: { 'monitoring.x.dryRun': true, 'monitoring.x.extra': null } }));
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.old['monitoring.x.extra']).toBe('__absent__');
    expect(ctx.svc.revertMove(r.moveId, 'undo')).toMatchObject({ ok: true });
    expect((ctx.state.config.monitoring as { x: Record<string, unknown> }).x.extra).toBeNull();
  });
});

describe('the post-move watch survives a restart', () => {
  it('replays the audit: a rung change arms the watch, first sight does not', async () => {
    const now = 100 * DAY;
    const ctx = make({ now, d7Rows: readyRows(now), config: { developmentAgent: true } });
    ctx.log([...fired(now), { at: new Date(now - DAY).toISOString(), kind: 'error' }]);
    await ctx.svc.refresh();
    expect(ctx.svc.features()[0].state).toBe('hold');
    ctx.state.config = { developmentAgent: true, monitoring: { x: { enabled: true } } };
    const again = new MaturationLadderService(ctx.deps);
    await again.refresh();
    const seen = auditLines(ctx.projectDir).filter(r => r.action === 'rung-observed');
    expect(seen).toHaveLength(1);
    expect(seen[0].from).toBeNull();
  });
});
