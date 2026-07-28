/**
 * Unit tests for WS5.2 R12 — revocation data-plane executor (AccountFollowMeRevocation.ts).
 * Spec §8.1 / §8.2 (revocation-removes-credential, de-paired non-cooperative B holder,
 * offline-revoke-honesty + give-up) + §8.4 (departed B holder, offline de-pair honesty).
 *
 * Covers BOTH sides of every decision boundary:
 *   - cooperative-online (removed) vs de-paired/hostile (provider-rotation-required)
 *   - online vs offline (durable pending)
 *   - pending (within deadline) vs escalated-failed (past deadline)
 *   - clean wipe vs partial/throwing wipe (fail-closed, never falsely "removed")
 *   - Mechanism B vs Mechanism A (A always requires provider rotation)
 *   - feature dark (no-op) vs enabled
 */

import { describe, it, expect } from 'vitest';
import {
  AccountFollowMeRevocation,
  inMemoryPendingWipeStore,
  type AccountFollowMeRevocationDeps,
  type RevocationRequest,
  type CooperativeWipeResult,
  type RevocationFailedAttention,
} from '../../src/core/AccountFollowMeRevocation.js';

const FULL: CooperativeWipeResult = { loggedOut: true, slotDeleted: true, poolRemoved: true };
const DEADLINE = 60 * 60 * 1000; // 1h

function req(over: Partial<RevocationRequest> = {}): RevocationRequest {
  return {
    accountId: 'acct-x',
    accountEmail: 'me@example.com',
    targetMachineId: 'machine-b',
    targetMachineNickname: 'the mini',
    provider: 'Anthropic',
    mandateId: 'MND-1',
    ...over,
  };
}

interface Harness {
  rev: AccountFollowMeRevocation;
  pending: ReturnType<typeof inMemoryPendingWipeStore>;
  wipeCalls: RevocationRequest[];
  failedItems: RevocationFailedAttention[];
  setNow: (n: number) => void;
}

function harness(over: Partial<AccountFollowMeRevocationDeps> = {}): Harness {
  const pending = inMemoryPendingWipeStore();
  const wipeCalls: RevocationRequest[] = [];
  const failedItems: RevocationFailedAttention[] = [];
  let now = 1_000_000;
  const deps: AccountFollowMeRevocationDeps = {
    enabled: () => true,
    cooperativeWipe: (r) => { wipeCalls.push(r); return FULL; },
    pendingStore: pending,
    emitRevocationFailed: (i) => { failedItems.push(i); },
    reconnectDeadlineMs: () => DEADLINE,
    now: () => now,
    ...over,
  };
  return {
    rev: new AccountFollowMeRevocation(deps),
    pending,
    wipeCalls,
    failedItems,
    setNow: (n) => { now = n; },
  };
}

describe('AccountFollowMeRevocation (WS5.2 R12)', () => {
  // ── (i) cooperative-online vs (ii) de-paired/hostile ─────────────────────────
  it('cooperative online target: local & total wipe → removed (R12.i)', () => {
    const h = harness();
    const out = h.rev.revoke(req(), 'cooperative-online');
    expect(out.state).toBe('removed');
    expect(out.providerRotationRequired).toBe(false);
    expect(out.wipe).toEqual(FULL);
    expect(h.wipeCalls).toHaveLength(1);
    // No false "pending" left behind.
    expect(h.pending.get('acct-x', 'machine-b')).toBeUndefined();
  });

  it('de-paired / hostile holder: NO wipe, provider-side rotation required, never "removed" (S8/R12.i)', () => {
    const h = harness();
    const out = h.rev.revoke(req(), 'revoked');
    expect(out.state).toBe('provider-rotation-required');
    expect(out.providerRotationRequired).toBe(true);
    expect(out.providerRotation?.kind).toBe('provider-rotation-required');
    // Honest message names provider-side de-authorization, never claims instar removed it.
    expect(out.providerRotation?.message).toContain('Anthropic');
    expect(out.providerRotation?.message).toContain('cannot revoke it remotely');
    expect(out.providerRotation?.message).not.toContain('removed');
    // The wipe is NOT attempted against a hostile holder.
    expect(h.wipeCalls).toHaveLength(0);
  });

  // ── (iii) online vs offline ──────────────────────────────────────────────────
  it('offline target: durable pending wipe, dashboard shows pending NOT removed (R12.iii)', () => {
    const h = harness();
    const out = h.rev.revoke(req(), 'offline');
    expect(out.state).toBe('revocation-pending');
    expect(h.wipeCalls).toHaveLength(0); // can't wipe an offline machine now
    const rec = h.pending.get('acct-x', 'machine-b');
    expect(rec).toBeDefined();
    expect(rec?.deadlineAt).toBe(1_000_000 + DEADLINE);
    expect(h.rev.pendingStateFor('acct-x', 'machine-b')).toBe('revocation-pending');
  });

  it('offline target reconnects within deadline → wipe fires, removed, pending cleared (R12.iii)', () => {
    const h = harness();
    h.rev.revoke(req(), 'offline');
    expect(h.pending.get('acct-x', 'machine-b')).toBeDefined();
    const out = h.rev.onTargetReconnect('acct-x', 'machine-b');
    expect(out?.state).toBe('removed');
    expect(h.wipeCalls).toHaveLength(1);
    expect(h.pending.get('acct-x', 'machine-b')).toBeUndefined();
  });

  it('onTargetReconnect with no pending record is a no-op', () => {
    const h = harness();
    expect(h.rev.onTargetReconnect('acct-x', 'machine-b')).toBeNull();
    expect(h.wipeCalls).toHaveLength(0);
  });

  // ── pending (within deadline) vs escalated-failed (past deadline) ─────────────
  it('pending wipe within deadline does NOT escalate', () => {
    const h = harness();
    h.rev.revoke(req(), 'offline');
    h.setNow(1_000_000 + DEADLINE - 1); // 1ms before deadline
    const escalated = h.rev.sweepDeadlines();
    expect(escalated).toHaveLength(0);
    expect(h.failedItems).toHaveLength(0);
    expect(h.pending.get('acct-x', 'machine-b')).toBeDefined();
  });

  it('pending wipe PAST deadline escalates to LOUD revocation-FAILED, removes pending (R12.iii give-up)', () => {
    const h = harness();
    h.rev.revoke(req(), 'offline');
    h.setNow(1_000_000 + DEADLINE + 1); // just past deadline
    const escalated = h.rev.sweepDeadlines();
    expect(escalated).toHaveLength(1);
    expect(h.failedItems).toHaveLength(1);
    expect(h.failedItems[0].priority).toBe('high');
    expect(h.failedItems[0].title).toContain('rotate at Anthropic');
    expect(h.failedItems[0].body).toContain('never reconnected');
    // Honest end-state: provider rotation, NOT a silently-aging pending.
    expect(h.pending.get('acct-x', 'machine-b')).toBeUndefined();
    expect(h.rev.pendingStateFor('acct-x', 'machine-b')).toBeNull();
  });

  it('pendingStateFor reports revocation-failed once past deadline before sweep runs', () => {
    const h = harness();
    h.rev.revoke(req(), 'offline');
    h.setNow(1_000_000 + DEADLINE + 5);
    // Even before the sweep escalates, the read surface tells the truth.
    expect(h.rev.pendingStateFor('acct-x', 'machine-b')).toBe('revocation-failed');
  });

  it('sweep escalates only the past-deadline records, leaves fresh ones pending (aggregated, per-target)', () => {
    const h = harness();
    h.rev.revoke(req({ accountId: 'a1', targetMachineId: 'm1' }), 'offline');
    h.setNow(1_500_000); // m2 revoked later → later deadline
    h.rev.revoke(req({ accountId: 'a2', targetMachineId: 'm2' }), 'offline');
    h.setNow(1_000_000 + DEADLINE + 1); // m1 past deadline, m2 not yet
    const escalated = h.rev.sweepDeadlines();
    expect(escalated.map((e) => e.id)).toEqual([
      'agent:account-follow-me-revoke-failed:a1::m1',
    ]);
    expect(h.pending.get('a1', 'm1')).toBeUndefined();
    expect(h.pending.get('a2', 'm2')).toBeDefined();
  });

  // ── clean wipe vs partial / throwing wipe (fail-closed) ──────────────────────
  it('partial cooperative wipe FAILS CLOSED to pending — never falsely "removed"', () => {
    const h = harness({ cooperativeWipe: () => ({ loggedOut: true, slotDeleted: false, poolRemoved: true }) });
    const out = h.rev.revoke(req(), 'cooperative-online');
    expect(out.state).toBe('revocation-pending');
    expect(out.reason).toBe('cooperative-wipe-partial');
    expect(h.pending.get('acct-x', 'machine-b')).toBeDefined();
  });

  it('throwing cooperative wipe FAILS CLOSED to pending — never falsely "removed"', () => {
    const h = harness({ cooperativeWipe: () => { throw new Error('logout failed'); } });
    const out = h.rev.revoke(req(), 'cooperative-online');
    expect(out.state).toBe('revocation-pending');
    expect(out.reason).toBe('cooperative-wipe-error');
    expect(h.pending.get('acct-x', 'machine-b')).toBeDefined();
  });

  // ── Mechanism B vs Mechanism A ───────────────────────────────────────────────
  it('Mechanism A cooperative wipe still requires provider rotation (delivered credential)', () => {
    const h = harness();
    const out = h.rev.revoke(req({ mechanism: 'credential-transport' }), 'cooperative-online');
    // Wipe ran, but a delivered credential cannot be un-delivered → rotate at provider.
    expect(out.wipe).toEqual(FULL);
    expect(out.state).toBe('provider-rotation-required');
    expect(out.providerRotationRequired).toBe(true);
    expect(out.providerRotation?.provider).toBe('Anthropic');
  });

  it('Mechanism A offline target: pending AND rotate-at-provider-now (blob already landed)', () => {
    const h = harness();
    const out = h.rev.revoke(req({ mechanism: 'credential-transport' }), 'offline');
    expect(out.state).toBe('revocation-pending');
    expect(out.providerRotationRequired).toBe(true);
    expect(out.providerRotation?.message).toContain('Offline machine');
  });

  it('Mechanism B clean wipe does NOT require provider rotation (no credential left the source)', () => {
    const h = harness();
    const out = h.rev.revoke(req({ mechanism: 're-mint' }), 'cooperative-online');
    expect(out.state).toBe('removed');
    expect(out.providerRotationRequired).toBe(false);
    expect(out.providerRotation).toBeUndefined();
  });

  // ── feature dark (no-op) ──────────────────────────────────────────────────────
  it('feature dark: revoke is a strict no-op (no wipe, no pending, no escalation)', () => {
    const h = harness({ enabled: () => false });
    const out = h.rev.revoke(req(), 'cooperative-online');
    expect(out.state).toBe('provider-rotation-required');
    expect(out.reason).toBe('feature-disabled');
    expect(out.providerRotationRequired).toBe(false);
    expect(h.wipeCalls).toHaveLength(0);
    expect(h.pending.all()).toHaveLength(0);
    expect(h.rev.sweepDeadlines()).toHaveLength(0);
    expect(h.rev.onTargetReconnect('acct-x', 'machine-b')).toBeNull();
  });
});
