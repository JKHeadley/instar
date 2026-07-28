// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
// safe-fs-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Tier-1 unit tests for CommitmentMutation (P1.5b) —
 * COMMITMENTS-COHERENCE-SPEC §3.4: verdict-bearing owner-side apply,
 * the durable opKey replay window, and the pending-mutation intent queue.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyOwnerMutation,
  OpKeyWindow,
  PendingMutationLedger,
  type CommitmentMutatePayload,
} from '../../src/core/CommitmentMutation.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-mutation-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function makeTracker(): CommitmentTracker {
  return new CommitmentTracker({ stateDir: tmpDir, liveConfig: new LiveConfig(tmpDir), originMachineId: 'm_owner' });
}

function payload(over: Partial<CommitmentMutatePayload> = {}): CommitmentMutatePayload {
  return {
    origin: 'm_owner',
    id: 'CMT-001',
    op: 'deliver',
    opKey: `op-${Math.random().toString(36).slice(2)}`,
    requestedAt: new Date().toISOString(),
    callerMachineId: 'm_caller',
    ...over,
  };
}

describe('applyOwnerMutation — verdict matrix (§3.4)', () => {
  it('deliver: applied → idempotent-noop → not-found are DISTINCT verdicts', async () => {
    const t = makeTracker();
    const c = t.record({ userRequest: 'X', type: 'follow-up', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    const r1 = await applyOwnerMutation(t, payload({ id: c.id }));
    expect(r1).toMatchObject({ verdict: 'applied', status: 'delivered' });
    const r2 = await applyOwnerMutation(t, payload({ id: c.id }));
    expect(r2.verdict).toBe('idempotent-noop'); // deliver-after-deliver
    const r3 = await applyOwnerMutation(t, payload({ id: 'CMT-999' }));
    expect(r3.verdict).toBe('not-found');
  });

  it('conflicting transition after a terminal state is invalid-transition with the live status', async () => {
    const t = makeTracker();
    const c = t.record({ userRequest: 'Y', type: 'follow-up', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    await applyOwnerMutation(t, payload({ id: c.id, op: 'deliver' }));
    const r = await applyOwnerMutation(t, payload({ id: c.id, op: 'withdraw' }));
    expect(r).toMatchObject({ verdict: 'invalid-transition', status: 'delivered' });
  });

  it('a stale observedStatus is annotated, never refused on its own', async () => {
    const t = makeTracker();
    const c = t.record({ userRequest: 'Z', type: 'follow-up', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    const r = await applyOwnerMutation(t, payload({ id: c.id, observedStatus: 'withdrawn' }));
    expect(r.verdict).toBe('applied'); // the CAS state machine decides
    expect(r.staleObservation).toBe(true); // honesty annotation
  });

  it('patch-beacon: only allowlisted fields apply; an empty effective patch is idempotent-noop', async () => {
    const t = makeTracker();
    const c = t.record({ userRequest: 'W', type: 'follow-up', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    const r = await applyOwnerMutation(t, payload({ id: c.id, op: 'patch-beacon', args: { cadenceMs: 120000, status: 'delivered' } }));
    expect(r.verdict).toBe('applied');
    const after = t.getAll().find((x) => x.id === c.id)!;
    expect(after.cadenceMs).toBe(120000);
    expect(after.status).toBe('pending'); // status is NOT patchable through this op
    const r2 = await applyOwnerMutation(t, payload({ id: c.id, op: 'patch-beacon', args: { evil: true } }));
    expect(r2.verdict).toBe('idempotent-noop');
  });
});

describe('OpKeyWindow — durable replay control (§3.4)', () => {
  it('records a verdict and returns it on replay; survives a restart', () => {
    const w1 = new OpKeyWindow({ stateDir: tmpDir });
    expect(w1.check('op-1')).toBeNull();
    w1.record('op-1', { verdict: 'applied', status: 'delivered' });
    expect(w1.check('op-1')).toMatchObject({ verdict: 'applied', status: 'delivered' });
    const w2 = new OpKeyWindow({ stateDir: tmpDir }); // restart
    expect(w2.check('op-1')).toMatchObject({ verdict: 'applied' });
  });

  it('TTL-expired entries age out; corrupt window quarantines and starts fresh', () => {
    let nowMs = Date.parse('2026-06-06T00:00:00Z');
    const w = new OpKeyWindow({ stateDir: tmpDir, ttlDays: 7, now: () => new Date(nowMs) });
    w.record('op-old', { verdict: 'applied' });
    nowMs += 8 * 24 * 60 * 60 * 1000;
    w.record('op-new', { verdict: 'applied' }); // triggers the inline sweep
    expect(w.check('op-old')).toBeNull();
    expect(w.check('op-new')).not.toBeNull();
    const file = path.join(tmpDir, 'state', 'coherence-journal', 'commitment-opkeys.json');
    fs.writeFileSync(file, '{nope');
    const w2 = new OpKeyWindow({ stateDir: tmpDir });
    expect(w2.check('op-new')).toBeNull(); // fresh — worst case one idempotent re-apply
    expect(fs.readdirSync(path.dirname(file)).some((n) => n.includes('commitment-opkeys.json.corrupt-'))).toBe(true);
  });
});

describe('PendingMutationLedger — durable intent queue (§3.4 rule 3)', () => {
  it('queues, dedupes on opKey, survives restart, clears on resolution', async () => {
    const l1 = new PendingMutationLedger({ stateDir: tmpDir });
    const p = payload({ opKey: 'op-q1' });
    expect(await l1.enqueue(p)).toBe('queued');
    expect(await l1.enqueue(p)).toBe('duplicate');
    const l2 = new PendingMutationLedger({ stateDir: tmpDir }); // restart
    expect(await l2.pendingForOwner('m_owner')).toHaveLength(1);
    await l2.clear('op-q1');
    expect(await l2.pendingForOwner('m_owner')).toHaveLength(0);
  });

  it('enforces per-(origin,id) and per-owner bounds — one peer cannot stage an unbounded batch', async () => {
    const l = new PendingMutationLedger({ stateDir: tmpDir, maxPerCommitment: 2, maxPerOwner: 3 });
    expect(await l.enqueue(payload({ opKey: 'a1' }))).toBe('queued');
    expect(await l.enqueue(payload({ opKey: 'a2', op: 'withdraw' }))).toBe('queued');
    expect(await l.enqueue(payload({ opKey: 'a3', op: 'resume' }))).toBe('bounded'); // per-commitment cap
    expect(await l.enqueue(payload({ opKey: 'b1', id: 'CMT-002' }))).toBe('queued');
    expect(await l.enqueue(payload({ opKey: 'c1', id: 'CMT-003' }))).toBe('bounded'); // per-owner cap
  });

  it('TTL sweep surfaces each expiry once; pendingKeys feeds the merge-time join', async () => {
    let nowMs = Date.parse('2026-06-06T00:00:00Z');
    const expired: string[] = [];
    const l = new PendingMutationLedger({
      stateDir: tmpDir,
      ttlDays: 7,
      now: () => new Date(nowMs),
      onExpired: (r) => expired.push(r.payload.opKey),
    });
    await l.enqueue(payload({ opKey: 'old-1' }));
    expect((await l.pendingKeys()).has('m_owner::CMT-001')).toBe(true);
    nowMs += 8 * 24 * 60 * 60 * 1000;
    const swept = await l.sweepExpired();
    expect(swept.map((r) => r.payload.opKey)).toEqual(['old-1']);
    expect(expired).toEqual(['old-1']);
    expect((await l.pendingKeys()).size).toBe(0); // the computed pendingMutation flag vanishes with the record
    expect(await l.sweepExpired()).toHaveLength(0); // once
  });

  it('corrupt ledger quarantines with ONE notice, never silently empty-merged', async () => {
    const file = path.join(tmpDir, 'state', 'commitment-replicas', 'pending-mutations.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json');
    const corrupt: string[] = [];
    const l = new PendingMutationLedger({ stateDir: tmpDir, onCorrupt: (q) => corrupt.push(q) });
    expect(await l.pendingForOwner('m_owner')).toEqual([]);
    expect(corrupt).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(file)).some((n) => n.includes('.corrupt-'))).toBe(true);
  });
});
