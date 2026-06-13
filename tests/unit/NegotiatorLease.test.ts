/**
 * Unit tests — Threadline single-negotiator lease (Robustness Phase 1, D-A/D-B).
 *
 * Covers the spec test plan (Unit tier):
 *  - lease acquire / renew / expire / epoch-fence over ConversationStore.mutate
 *  - the CAS race: two sessions acquire concurrently → exactly one wins; the
 *    loser sees the live foreign lease
 *  - dead-owner reclaim (foreign owner absent from the live registry)
 *  - backward-compat: a conversation with no negotiatorLease loads + acquires
 *  - holding-notice durable per-epoch limit AND global min-interval floor AND
 *    epoch-cycling-flood bounded AND fixed-template/no-model-text + exact shape
 *  - config resolver safe defaults (dry-run-first)
 *  - commitment-class signal is advisory (a "go ahead" send produces a signal
 *    but the prose is inert either way — G2 does not depend on the classifier)
 *  - holder-singularity detector (FD-2)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConversationStore } from '../../src/threadline/ConversationStore.js';
import {
  resolveSingleNegotiatorConfig,
  SINGLE_NEGOTIATOR_DEFAULTS,
  buildHoldingNotice,
  shouldEmitHoldingNotice,
  detectDuplicateLiveHolders,
  appendNegotiatorLog,
  readNegotiatorCounts,
  pruneNegotiatorLogs,
  type NegotiatorLease,
} from '../../src/threadline/NegotiatorLease.js';
import { detectCommitmentClass, commitmentNudge } from '../../src/threadline/ContentClassifier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function tmpState(): { stateDir: string; cleanup: () => void } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'negotiator-lease-'));
  return {
    stateDir,
    cleanup: () => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/NegotiatorLease.test.ts:cleanup' }),
  };
}

const OWNER_A = { ownerSessionName: 'echo-topic-1', ownerMachineId: 'machine-a' };
const OWNER_B = { ownerSessionName: 'echo-warm-99', ownerMachineId: 'machine-a' };

describe('NegotiatorLease — acquire/renew/expire/epoch (D-A)', () => {
  let stateDir: string;
  let cleanup: () => void;
  beforeEach(() => { ({ stateDir, cleanup } = tmpState()); });
  afterEach(() => cleanup());

  it('acquires a lease on a fresh conversation at epoch 1', async () => {
    const store = new ConversationStore(stateDir);
    const r = await store.acquireOrRenewLease('t1', OWNER_A, { ttlMs: 90000 });
    expect(r.disposition).toBe('acquired');
    expect(r.ownedByCaller).toBe(true);
    expect(r.lease.epoch).toBe(1);
    expect(r.lease.ownerSessionName).toBe('echo-topic-1');
  });

  it('backward-compat: a conversation with no negotiatorLease acquires cleanly', async () => {
    const store = new ConversationStore(stateDir);
    // Pre-create a conversation WITHOUT a lease (the legacy shape).
    await store.mutate('t1', (d) => { d.participants.peers.push('peerFP'); return d; });
    expect(store.readLease('t1')).toBeNull();
    const r = await store.acquireOrRenewLease('t1', OWNER_A, { ttlMs: 90000 });
    expect(r.disposition).toBe('acquired');
    expect(r.lease.epoch).toBe(1);
    // Existing data preserved.
    expect(store.get('t1')?.participants.peers).toContain('peerFP');
  });

  it('renews the same owner without bumping the epoch', async () => {
    const store = new ConversationStore(stateDir);
    const a = await store.acquireOrRenewLease('t1', OWNER_A, { ttlMs: 90000, now: 1000 });
    const b = await store.acquireOrRenewLease('t1', OWNER_A, { ttlMs: 90000, now: 2000 });
    expect(b.disposition).toBe('renewed');
    expect(b.ownedByCaller).toBe(true);
    expect(b.lease.epoch).toBe(a.lease.epoch); // epoch unchanged on renew
    expect(new Date(b.lease.expiresAt).getTime()).toBeGreaterThan(new Date(a.lease.expiresAt).getTime());
  });

  it('HOLDS a live foreign lease (the warm-session case — closes F1)', async () => {
    const store = new ConversationStore(stateDir);
    await store.acquireOrRenewLease('t1', OWNER_A, { ttlMs: 90000, now: 1000 });
    // A different session of the SAME agent tries to speak — must be held.
    const r = await store.acquireOrRenewLease('t1', OWNER_B, { ttlMs: 90000, now: 2000, isOwnerLive: () => true });
    expect(r.disposition).toBe('held');
    expect(r.ownedByCaller).toBe(false);
    expect(r.lease.ownerSessionName).toBe('echo-topic-1'); // still the original owner
  });

  it('re-acquires an EXPIRED foreign lease and bumps the epoch (fences the stale holder)', async () => {
    const store = new ConversationStore(stateDir);
    const a = await store.acquireOrRenewLease('t1', OWNER_A, { ttlMs: 1000, now: 1000 });
    // Past TTL → owner B takes over; epoch increments so A's delayed send yields.
    const b = await store.acquireOrRenewLease('t1', OWNER_B, { ttlMs: 1000, now: 5000, isOwnerLive: () => true });
    expect(b.disposition).toBe('acquired');
    expect(b.lease.epoch).toBe(a.lease.epoch + 1);
    expect(b.lease.ownerSessionName).toBe('echo-warm-99');
  });

  it('reclaims a foreign lease whose owner is provably DEAD even before TTL', async () => {
    const store = new ConversationStore(stateDir);
    await store.acquireOrRenewLease('t1', OWNER_A, { ttlMs: 90000, now: 1000 });
    // Owner A's session is gone from the live registry → reclaimable now.
    const r = await store.acquireOrRenewLease('t1', OWNER_B, {
      ttlMs: 90000, now: 2000, isOwnerLive: (name) => name !== 'echo-topic-1',
    });
    expect(r.disposition).toBe('acquired');
    expect(r.lease.ownerSessionName).toBe('echo-warm-99');
    expect(r.lease.epoch).toBe(2);
  });

  it('CAS race: two concurrent acquires → exactly one wins, the loser is held', async () => {
    const store = new ConversationStore(stateDir);
    const [r1, r2] = await Promise.all([
      store.acquireOrRenewLease('t1', OWNER_A, { ttlMs: 90000, isOwnerLive: () => true }),
      store.acquireOrRenewLease('t1', OWNER_B, { ttlMs: 90000, isOwnerLive: () => true }),
    ]);
    const owned = [r1, r2].filter((r) => r.ownedByCaller);
    const held = [r1, r2].filter((r) => !r.ownedByCaller);
    expect(owned.length).toBe(1);
    expect(held.length).toBe(1);
    // The held loser sees the winner's identity as the live owner.
    expect(held[0].lease.ownerSessionName).toBe(owned[0].lease.ownerSessionName);
  });

  it('persists the lease across a store reload', async () => {
    const store = new ConversationStore(stateDir);
    await store.acquireOrRenewLease('t1', OWNER_A, { ttlMs: 90000 });
    const fresh = new ConversationStore(stateDir);
    expect(fresh.readLease('t1')?.ownerSessionName).toBe('echo-topic-1');
  });
});

describe('NegotiatorLease — holding-notice limits (FD-3)', () => {
  it('emits at most once per (thread, epoch)', () => {
    const base = { minIntervalMs: 0, now: 10_000 };
    expect(shouldEmitHoldingNotice({ epoch: 3, ...base })).toBe(true);
    expect(shouldEmitHoldingNotice({ epoch: 3, lastHoldingNoticeEpoch: 3, ...base })).toBe(false);
    // A new epoch resets the per-epoch limit.
    expect(shouldEmitHoldingNotice({ epoch: 4, lastHoldingNoticeEpoch: 3, ...base })).toBe(true);
  });

  it('enforces the global min-interval floor even across epochs (bounds the flood)', () => {
    const now = 1_000_000;
    const minIntervalMs = 300_000;
    // Different epoch, but within the min-interval window → suppressed.
    expect(shouldEmitHoldingNotice({
      epoch: 5, lastHoldingNoticeEpoch: 4,
      lastHoldingNoticeAt: new Date(now - 60_000).toISOString(), minIntervalMs, now,
    })).toBe(false);
    // Past the window → allowed again.
    expect(shouldEmitHoldingNotice({
      epoch: 5, lastHoldingNoticeEpoch: 4,
      lastHoldingNoticeAt: new Date(now - 400_000).toISOString(), minIntervalMs, now,
    })).toBe(true);
  });

  it('builds a fixed-template notice with the exact wire shape and NO model text (FD-11)', () => {
    const lease: NegotiatorLease = {
      ownerSessionName: 'echo-topic-1', ownerMachineId: 'machine-a', epoch: 7,
      acquiredAt: 'x', renewedAt: 'x', expiresAt: 'x',
    };
    const n = buildHoldingNotice('Echo', lease);
    expect(n.kind).toBe('holding-notice');
    expect(n.owner).toEqual({ sessionName: 'echo-topic-1', machineId: 'machine-a' });
    expect(n.epoch).toBe(7);
    // Only owner/agent/epoch are interpolated — deterministic, no model text.
    expect(n.text).toContain('Echo');
    expect(n.text).toContain('echo-topic-1');
    expect(n.text).toContain('epoch 7');
    expect(buildHoldingNotice('Echo', lease).text).toBe(n.text); // deterministic
  });
});

describe('NegotiatorLease — config resolver (FD-7)', () => {
  it('defaults to dark + dry-run-first when unset', () => {
    const c = resolveSingleNegotiatorConfig(undefined);
    expect(c).toEqual(SINGLE_NEGOTIATOR_DEFAULTS);
    expect(c.enabled).toBe(false);
    expect(c.dryRun).toBe(true);
  });

  it('dryRun defaults TRUE when enabled and absent; only explicit false disarms it', () => {
    expect(resolveSingleNegotiatorConfig({ enabled: true }).dryRun).toBe(true);
    expect(resolveSingleNegotiatorConfig({ enabled: true, dryRun: false }).dryRun).toBe(false);
  });

  it('clamps bogus numeric knobs to safe defaults', () => {
    const c = resolveSingleNegotiatorConfig({ enabled: true, leaseTtlMs: -5, holdingNoticeMinIntervalMs: 'x' });
    expect(c.leaseTtlMs).toBe(90000);
    expect(c.holdingNoticeMinIntervalMs).toBe(300000);
  });
});

describe('ContentClassifier — commitment-class SIGNAL is advisory only (FD-10)', () => {
  it('detects colloquial commitment prose that has no formal keyword', () => {
    expect(detectCommitmentClass('yep, go ahead — see you at the gate').isCommitmentClass).toBe(true);
    expect(detectCommitmentClass("let's schedule the cutover for Friday 10am").isCommitmentClass).toBe(true);
  });

  it('does not flag ordinary conversation', () => {
    expect(detectCommitmentClass('how is the build going?').isCommitmentClass).toBe(false);
    expect(detectCommitmentClass('').isCommitmentClass).toBe(false);
  });

  it('produces an advisory nudge that points at the anchored path (never a block)', () => {
    const sig = detectCommitmentClass('we agreed to lock the window');
    expect(sig.isCommitmentClass).toBe(true);
    const nudge = commitmentNudge(sig.matchedTerms);
    expect(nudge).toMatch(/mandate|reviewexchange/i);
    expect(nudge).toMatch(/no authority|carries no/i);
  });
});

describe('NegotiatorLease — holder-singularity detector (FD-2)', () => {
  it('returns empty under the single-holder invariant', () => {
    expect(detectDuplicateLiveHolders([
      { conversationId: 'c1', machineId: 'm1' },
      { conversationId: 'c2', machineId: 'm2' },
    ])).toEqual([]);
  });

  it('flags a conversation observed live on two machines (split-brain signal)', () => {
    const d = detectDuplicateLiveHolders([
      { conversationId: 'c1', machineId: 'm1' },
      { conversationId: 'c1', machineId: 'm2' },
      { conversationId: 'c2', machineId: 'm1' },
    ]);
    expect(d).toEqual([{ conversationId: 'c1', machineIds: ['m1', 'm2'] }]);
  });
});

describe('NegotiatorLease — observability log', () => {
  let stateDir: string;
  let cleanup: () => void;
  beforeEach(() => { ({ stateDir, cleanup } = tmpState()); });
  afterEach(() => cleanup());

  it('appends + tallies dry-run/fail-open counts and prunes by retention', () => {
    const logDir = path.join(stateDir, 'logs');
    appendNegotiatorLog(logDir, { ts: '2026-06-12T10:00:00.000Z', threadId: 't1', action: 'would-hold', sessionName: 's', dryRun: true });
    appendNegotiatorLog(logDir, { ts: '2026-06-12T10:01:00.000Z', threadId: 't1', action: 'allow-own', sessionName: 's', dryRun: true });
    appendNegotiatorLog(logDir, { ts: '2026-06-12T10:02:00.000Z', threadId: 't1', action: 'fail-open', sessionName: 's', dryRun: true });
    const counts = readNegotiatorCounts(logDir, 30);
    expect(counts.wouldHold).toBe(1);
    expect(counts.allowOwn).toBe(1);
    expect(counts.failOpen).toBe(1);
    // An old file is pruned; a recent one survives.
    appendNegotiatorLog(logDir, { ts: '2000-01-01T00:00:00.000Z', threadId: 't0', action: 'hold', sessionName: 's', dryRun: false });
    const removed = pruneNegotiatorLogs(logDir, 7, new Date('2026-06-12T12:00:00.000Z').getTime());
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(logDir, 'threadline-negotiator-2000-01-01.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(logDir, 'threadline-negotiator-2026-06-12.jsonl'))).toBe(true);
  });
});
