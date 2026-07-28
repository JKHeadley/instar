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
