// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Unit — fold ownership with the session pool's placement LIVE
 * (context-budget-layered-summaries §9.3: "when the session pool's placement is
 * live, also the topic's ownership record … missing ⇒ fold-skipped:
 * owner-unknown"). Before this slice every topic read 'unknown' on a
 * pool-live agent, so no fold could ever begin there.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFoldCoordinator, poolLiveOwner } from '../../src/monitoring/foldCoordinatorBoot.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/fold-pool-ownership.test.ts';
const T = '141133';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

function build(o: { record?: { ownerMachineId: string; status: string; ownershipEpoch: number } | null; self?: string | null; hosts?: boolean; live?: boolean }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-pool-')); dirs.push(stateDir);
  let record = o.record ?? null;
  const c = buildFoldCoordinator({
    stateDir, runningTopicSessions: () => (o.hosts === false ? [] : [{ topicKey: T }]), poolPlacementLive: () => o.live ?? true,
    inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
    ownershipRecord: () => record, selfMachineId: () => (o.self === undefined ? 'm_self' : o.self),
  }).coordinator;
  return { c, setRecord: (r: typeof record) => { record = r; } };
}

const active = (owner = 'm_self', epoch = 7) => ({ ownerMachineId: owner, status: 'active', ownershipEpoch: epoch });

describe('poolLiveOwner (the shared §9.3 rule)', () => {
  it('owned only by an active record naming this machine; missing ⇒ unknown', () => {
    expect(poolLiveOwner({ ownerMachineId: 'm1', status: 'active' }, 'm1')).toBe(true);
    expect(poolLiveOwner({ ownerMachineId: 'm2', status: 'active' }, 'm1')).toBe(false);
    expect(poolLiveOwner({ ownerMachineId: 'm1', status: 'transferring' }, 'm1')).toBe(false);
    expect(poolLiveOwner(null, 'm1')).toBe('unknown');
    expect(poolLiveOwner({ ownerMachineId: 'm1', status: 'active' }, null)).toBe('unknown');
  });
});

describe('fold ownership with placement live', () => {
  it('an active record naming this machine, with the session here, is the owner', () => {
    const { c } = build({ record: active() });
    const b = c.begin(T, 'prepare');
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.record.ownerEpoch).toBe(7);
  });
  it.each([
    ['no record', { record: null }, 'owner-unknown'],
    ['no mesh identity', { record: active(), self: null }, 'owner-unknown'],
    ['another machine owns it', { record: active('m_other') }, 'not-owner'],
    ['the record is transferring', { record: { ...active(), status: 'transferring' } }, 'not-owner'],
    ['the session is not here', { record: active(), hosts: false }, 'not-owner'],
  ])('%s ⇒ no fold', (_n, o, reason) => {
    const b = build(o as Parameters<typeof build>[0]).c.begin(T, 'prepare');
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.reason).toBe(reason);
  });
  it('an ownership epoch change after begin fences every later transition', () => {
    const { c, setRecord } = build({ record: active('m_self', 7) });
    const b = c.begin(T, 'prepare');
    if (!b.ok) throw new Error(b.reason);
    setRecord(active('m_self', 8));
    const r = c.transition(T, b.record.foldId, { state: b.record.state, seq: b.record.seq, generation: b.record.generation }, 'shadow-probing');
    expect(r).toEqual({ ok: false, reason: 'owner-epoch-changed' });
  });
  it('the owner may still close its own fold after the session left (active record naming this machine)', () => {
    let hosts = true;
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-pool-')); dirs.push(stateDir);
    const c = buildFoldCoordinator({
      stateDir, runningTopicSessions: () => (hosts ? [{ topicKey: T }] : []), poolPlacementLive: () => true,
      inboundQueueLive: () => true, topicRowsPresent: () => true, sentinelHeartbeatFresh: () => true, layerKindPresent: () => true,
      ownershipRecord: () => active(), selfMachineId: () => 'm_self',
    }).coordinator;
    const b = c.begin(T, 'prepare');
    if (!b.ok) throw new Error(b.reason);
    hosts = false; // the live session exited mid-fold
    const r = c.transition(T, b.record.foldId, { state: b.record.state, seq: b.record.seq, generation: b.record.generation }, 'aborted', { reason: 'session-gone' });
    expect(r.ok).toBe(true);
  });

  it('reconcileStale closes only this machine\'s own stale pre-PNR record, even after an epoch change', () => {
    const { c, setRecord } = build({ record: active('m_self', 7) });
    const b = c.begin(T, 'prepare');
    if (!b.ok) throw new Error(b.reason);
    expect(c.reconcileStale(T, 60 * 60_000)).toEqual([]); // fresh: kept
    setRecord(active('m_self', 9)); // ownership moved and came back: the old record's epoch no longer matches
    expect(c.transition(T, b.record.foldId, { state: b.record.state, seq: b.record.seq, generation: b.record.generation }, 'aborted').ok).toBe(false);
    const closed = c.reconcileStale(T, 0);
    expect(closed.map((r) => [r.state, r.reason])).toEqual([['aborted', 'reconciled-stale:prepared']]);
    expect(c.begin(T, 'prepare').ok).toBe(true); // the topic can fold again
  });
  it('reconcileStale does nothing where this machine does not own the topic', () => {
    const { c, setRecord } = build({ record: active('m_self') });
    const b = c.begin(T, 'prepare');
    if (!b.ok) throw new Error(b.reason);
    setRecord(active('m_other'));
    expect(c.reconcileStale(T, 0)).toEqual([]);
  });

  it('placement dark: the host is the owner, no record consulted, epoch null', () => {
    const b = build({ live: false, record: null }).c.begin(T, 'prepare');
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.record.ownerEpoch).toBeNull();
  });
});
