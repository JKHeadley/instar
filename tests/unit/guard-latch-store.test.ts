/**
 * Tier-1 tests for GuardLatchStore (green-pr-automerge-enforcement R9/R7).
 * Both sides of every boundary: dual-latch gate, ABSORBING disable (a stale-epoch
 * STOP wins over an earlier higher-epoch enable), /enable clears only named ids,
 * arrive-disabled-on-unreadable, the pool-armed marker lifecycle, durable
 * round-trip across a fresh instance, and journal replication emission.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import path from 'node:path';

import {
  GuardLatchStore,
  ROLLBACK_FAMILY,
  EMERGENCY_PAUSE_FAMILY,
  POOL_ARMED_FAMILY,
  POOL_MARKER_ID,
  type GuardLatchEntry,
} from '../../src/monitoring/GuardLatchStore.js';

let dir: string;
let emitted: Array<Record<string, unknown>>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-latch-'));
  emitted = [];
});
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ignore */ }
});

function store(opts: { machineId?: string; epoch?: number; peers?: () => GuardLatchEntry[] } = {}): GuardLatchStore {
  return new GuardLatchStore({
    stateDir: dir,
    machineId: opts.machineId ?? 'machine-A',
    journal: { emitGuardLatch: (d) => emitted.push(d as unknown as Record<string, unknown>) },
    leaseEpoch: () => opts.epoch ?? 1,
    readPeerEntries: opts.peers ?? (() => []),
  });
}

describe('GuardLatchStore — dual-latch gate', () => {
  it('allows a merge when nothing is set', () => {
    const v = store().isMergeAllowed();
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe('allowed');
  });

  it('blocks on a rollback set, and re-allows after /enable clears the exact id', () => {
    const s = store();
    const id = s.set(ROLLBACK_FAMILY, 'operator stop');
    expect(s.isMergeAllowed().allowed).toBe(false);
    expect(s.isMergeAllowed().reason).toBe('rollback');
    s.clear(ROLLBACK_FAMILY, [id], 're-arm');
    expect(s.isMergeAllowed().allowed).toBe(true);
  });

  it('blocks on an emergency-pause set independently of rollback', () => {
    const s = store();
    s.set(EMERGENCY_PAUSE_FAMILY);
    const v = s.isMergeAllowed();
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('emergency-pause');
  });

  it('emits a replication entry for every transition', () => {
    const s = store();
    const id = s.set(ROLLBACK_FAMILY, 'stop');
    s.clear(ROLLBACK_FAMILY, [id]);
    expect(emitted.length).toBe(2);
    expect(emitted[0]).toMatchObject({ latchKind: ROLLBACK_FAMILY, action: 'set' });
    expect(emitted[1]).toMatchObject({ latchKind: ROLLBACK_FAMILY, action: 'clear' });
  });
});

describe('GuardLatchStore — ABSORBING disable', () => {
  it('a stale-epoch STOP wins over an EARLIER higher-epoch enable (the round-4 invariant)', () => {
    // Machine A (epoch 1) sets a stop. Peer machine B at a HIGHER epoch 5 issues
    // /enable naming that exact id (it dominates → that id clears, merge allowed).
    // A then issues a FRESH stop whose new id B's enable never named → absorbing,
    // so a higher-epoch enable cannot pre-clear a later STOP. Merge stays blocked.
    const s = store({ epoch: 1, peers: () => peerEnable });
    const firstId = s.set(ROLLBACK_FAMILY, 'stop 1');
    const peerEnable: GuardLatchEntry[] = [
      { machine: 'machine-B', latchKind: ROLLBACK_FAMILY, latchId: firstId, action: 'clear', epoch: 5, seq: 99 },
    ];
    expect(s.isMergeAllowed().allowed).toBe(true); // B's higher-epoch enable cleared firstId
    const freshId = s.set(ROLLBACK_FAMILY, 'stale-epoch stop 2');
    expect(freshId).not.toBe(firstId);
    expect(s.isMergeAllowed().allowed).toBe(false); // fresh STOP is absorbing
  });

  it('/enable clears ONLY the named latchId, leaving a sibling STOP active', () => {
    const s = store();
    const id1 = s.set(ROLLBACK_FAMILY, 'stop 1');
    const id2 = s.set(ROLLBACK_FAMILY, 'stop 2');
    s.clear(ROLLBACK_FAMILY, [id1]);
    expect(s.isMergeAllowed().allowed).toBe(false); // id2 still set
    expect(s.activeLatchIds(ROLLBACK_FAMILY)).toEqual([id2]);
    s.clear(ROLLBACK_FAMILY, [id2]);
    expect(s.isMergeAllowed().allowed).toBe(true);
  });

  it('within ONE latchId, the higher (epoch, seq) transition wins', () => {
    // A peer re-set the same fixed marker id at a higher epoch.
    const peers = (): GuardLatchEntry[] => [
      { machine: 'machine-B', latchKind: POOL_ARMED_FAMILY, latchId: POOL_MARKER_ID, action: 'set', epoch: 9, seq: 1 },
    ];
    const s = store({ epoch: 1, peers });
    s.markPoolDisarmed(); // local clear at epoch 1
    // peer's epoch-9 set dominates the local epoch-1 clear → still armed
    expect(s.isPoolArmed()).toBe(true);
  });
});

describe('GuardLatchStore — arrive-disabled-on-unreadable', () => {
  it('returns disabled when the peer view throws', () => {
    const peers = (): GuardLatchEntry[] => { throw new Error('replica unreadable'); };
    const s = store({ peers });
    const v = s.isMergeAllowed();
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe('unreadable-peers');
  });

  it('isPoolArmed returns false (never invents an alarm) on an unreadable view', () => {
    const peers = (): GuardLatchEntry[] => { throw new Error('boom'); };
    expect(store({ peers }).isPoolArmed()).toBe(false);
  });
});

describe('GuardLatchStore — pool-armed marker', () => {
  it('arms and disarms via superseding entries', () => {
    const s = store();
    expect(s.isPoolArmed()).toBe(false);
    s.markPoolArmed();
    expect(s.isPoolArmed()).toBe(true);
    s.markPoolDisarmed();
    expect(s.isPoolArmed()).toBe(false);
  });

  it('disarm does NOT clear an active rollback latch (independent levers)', () => {
    const s = store();
    s.set(ROLLBACK_FAMILY, 'stop');
    s.markPoolDisarmed();
    expect(s.isMergeAllowed().allowed).toBe(false);
  });
});

describe('GuardLatchStore — durable round-trip', () => {
  it('a fresh instance over the same stateDir sees the prior STOP', () => {
    const s1 = store();
    s1.set(ROLLBACK_FAMILY, 'stop');
    // New instance, same dir — simulates a restart / lease move on the same box.
    const s2 = store();
    expect(s2.isMergeAllowed().allowed).toBe(false);
  });

  it('writes the durable file at 0600', () => {
    const s = store();
    s.set(ROLLBACK_FAMILY, 'stop');
    const p = path.join(dir, 'state', 'green-pr-automerge-latches.json');
    expect(fs.existsSync(p)).toBe(true);
    const mode = fs.statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('stop class (green-pr-agent-stop-release)', () => {
  const origin = { class: 'agent' as const, topicId: 18330, cause: 'The old watcher merged a PR too early.', release: { kind: 'fix-pr-released' as const }, stoppedAt: '2026-11-03T10:34:00.000Z' };

  it('a stop with no origin is operator-class', () => {
    const s = store();
    const id = s.set(ROLLBACK_FAMILY, 'operator-rollback');
    expect(s.stopClass(ROLLBACK_FAMILY, id)).toEqual({ known: true, active: true, class: 'operator' });
  });

  it('a stop minted with an origin is agent-class, and survives a restart', () => {
    const id = store().set(ROLLBACK_FAMILY, 'mine', origin);
    expect(store().stopClass(ROLLBACK_FAMILY, id)).toEqual({ known: true, active: true, class: 'agent', origin });
  });

  it('every latch in an existing file reads as operator-class, unchanged', () => {
    const file = path.join(dir, 'state', 'green-pr-automerge-latches.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacy = {
      machineId: 'machine-A', ownSeq: 216,
      transitions: { rollback: { 'machine-A:212': { action: 'set', epoch: 23323, seq: 212, reason: 'PR #2648 merged at 10:30:24Z while 10 hosted CI jobs were still in progress; hol', ts: '2026-11-03T10:34:18.000Z' } } },
    };
    fs.writeFileSync(file, JSON.stringify(legacy));
    const s = store();
    expect(s.stopClass(ROLLBACK_FAMILY, 'machine-A:212')).toEqual({ known: true, active: true, class: 'operator' });
    expect(s.rollbackStops()).toEqual([{ latchId: 'machine-A:212', class: 'operator', reason: legacy.transitions.rollback['machine-A:212'].reason, since: '2026-11-03T10:34:18.000Z' }]);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(legacy);
  });

  it('a malformed stored origin reads as operator-class', () => {
    const file = path.join(dir, 'state', 'green-pr-automerge-latches.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ machineId: 'machine-A', ownSeq: 1, transitions: { rollback: { 'machine-A:1': { action: 'set', epoch: 1, seq: 1, ts: 't', origin: { class: 'agent' } } } } }));
    expect(store().stopClass(ROLLBACK_FAMILY, 'machine-A:1')).toMatchObject({ class: 'operator' });
  });

  it('a peer row reads as operator-class, even with a local origin under its id', () => {
    const peers = (): GuardLatchEntry[] => [{ machine: 'machine-B', latchKind: ROLLBACK_FAMILY, latchId: 'machine-B:7', action: 'set', epoch: 9, seq: 7 }];
    expect(store({ peers }).stopClass(ROLLBACK_FAMILY, 'machine-B:7')).toEqual({ known: true, active: true, class: 'operator' });
  });

  it('an unknown id is unknown, and a cleared one is not active', () => {
    const s = store();
    expect(s.stopClass(ROLLBACK_FAMILY, 'machine-A:999')).toEqual({ known: false });
    const id = s.set(ROLLBACK_FAMILY, 'mine', origin);
    s.clear(ROLLBACK_FAMILY, [id], 'agent-release');
    expect(s.stopClass(ROLLBACK_FAMILY, id)).toMatchObject({ known: true, active: false, class: 'agent' });
  });

  it('an unreadable peer view throws, so the release route refuses', () => {
    const s = store({ peers: () => { throw new Error('unreadable'); } });
    expect(() => s.stopClass(ROLLBACK_FAMILY, 'machine-A:1')).toThrow();
    expect(s.rollbackStops()).toEqual([]);
  });

  it('the origin never reaches the journal, and the journal row keeps its shape', () => {
    const s = store();
    const id = s.set(ROLLBACK_FAMILY, 'mine', origin);
    s.clear(ROLLBACK_FAMILY, [id], 'agent-release', { topicId: 1, note: 'n', evidence: {}, at: 'now' });
    for (const row of emitted) {
      expect(Object.keys(row).sort()).toEqual(['action', 'epoch', 'latchId', 'latchKind', 'reason', 'seq']);
    }
  });

  it('keeps the origin and records the release across the clear, for the history', () => {
    const s = store();
    const id = s.set(ROLLBACK_FAMILY, 'mine', origin);
    const release = { topicId: 136706, note: 'fix is running', evidence: { pr: 1 }, at: 'now' };
    s.clear(ROLLBACK_FAMILY, [id], 'agent-release', release);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'green-pr-automerge-latches.json'), 'utf-8'));
    expect(onDisk.transitions.rollback[id]).toMatchObject({ action: 'clear', origin, release });
  });

  it('a claim mints a fresh id: it cannot describe or pre-clear any other stop', () => {
    const s = store();
    const op = s.set(ROLLBACK_FAMILY, 'operator-rollback');
    const mine = s.set(ROLLBACK_FAMILY, 'mine', origin);
    expect(mine).not.toBe(op);
    expect(s.stopClass(ROLLBACK_FAMILY, op)).toMatchObject({ class: 'operator' });
    s.clear(ROLLBACK_FAMILY, [mine], 'agent-release');
    expect(s.isMergeAllowed()).toMatchObject({ allowed: false, reason: 'rollback', activeLatchIds: { rollback: [op] } });
  });

  it('snapshot carries the classes and keeps the plain id list', () => {
    const s = store();
    const op = s.set(ROLLBACK_FAMILY, 'operator-rollback');
    const mine = s.set(ROLLBACK_FAMILY, 'mine', origin);
    const snap = s.snapshot();
    expect(snap.rollback).toEqual([op, mine]);
    expect(snap.rollbackStops.map((r) => r.class)).toEqual(['operator', 'agent']);
    expect(snap.rollbackStops[1].marker).toBe(`agent-stop-${mine.replace(':', '-')}`);
  });
});

