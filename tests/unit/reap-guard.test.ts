/**
 * ReapGuard — the shared stateless KEEP-guards (UNIFIED-SESSION-LIFECYCLE §P2).
 * Both sides of every guard: each protect-signal returns its KEEP reason, and a
 * fully-clear session returns null (safe to reap). Plus cheap-first ordering,
 * the "cannot inspect → KEEP" contract, and safe-by-default on a throwing signal.
 */

import { describe, it, expect } from 'vitest';
import { ReapGuard, type ReapGuardDeps } from '../../src/core/ReapGuard.js';
import type { Session } from '../../src/core/types.js';

function mkSession(over?: Partial<Session>): Session {
  return {
    id: 'sess-1',
    name: 'work',
    tmuxSession: 'agent-work',
    status: 'running',
    startedAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 1h old (past spawn grace)
    claudeSessionId: 'claude-uuid-1',
    ...over,
  } as Session;
}

/** All deps default to "no reason to keep" — a fully reap-eligible session. */
function clearDeps(over?: Partial<ReapGuardDeps>): ReapGuardDeps {
  return {
    protectedSessions: () => [],
    isRecoveryActive: () => false,
    hasPendingInjection: () => false,
    isRelayLeaseActive: () => false,
    topicBinding: () => null,
    recentUserMessage: () => false,
    activeCommitmentForTopic: () => false,
    activeSubagentCount: () => 0,
    buildOrAutonomousActive: () => false,
    hasActiveProcesses: () => false,
    mainProcessActive: () => false,
    ...over,
  };
}

describe('ReapGuard — all-clear', () => {
  it('returns null when every stateless guard clears', () => {
    const g = new ReapGuard(clearDeps());
    expect(g.blockedReason(mkSession())).toBeNull();
  });
});

describe('ReapGuard — each guard blocks with its reason', () => {
  const cases: Array<[string, Partial<ReapGuardDeps>, Partial<Session>?]> = [
    ['protected', { protectedSessions: () => ['agent-work'] }],
    ['recovery-in-flight', { isRecoveryActive: () => true }],
    ['pending-injection', { hasPendingInjection: () => true }],
    ['relay-lease', { isRelayLeaseActive: () => true }],
    ['recent-user-message', { topicBinding: () => 42, recentUserMessage: () => true }],
    // Open commitment keeps ONLY while a message arrived within the staleness window
    // but NOT within the 30min recent-user window (so guard I above doesn't pre-empt
    // it). A window-aware mock distinguishes the two horizons, robust to the default.
    ['open-commitment', {
      topicBinding: () => 42,
      activeCommitmentForTopic: () => true,
      recentUserMessage: (_t, withinMs) => withinMs > 60 * 60_000,
    }],
    ['active-subagent', { activeSubagentCount: () => 2 }],
    ['structural-long-work', { buildOrAutonomousActive: () => true }],
    ['active-process', { hasActiveProcesses: () => true }],
    ['main-process-active', { mainProcessActive: () => true }],
  ];
  for (const [reason, deps] of cases) {
    it(`blocks with "${reason}"`, () => {
      const g = new ReapGuard(clearDeps(deps));
      expect(g.blockedReason(mkSession())?.reason).toBe(reason);
    });
  }

  it('spawn-grace blocks a freshly-spawned session (and is skippable via minAgeMs:0)', () => {
    const young = mkSession({ startedAt: new Date().toISOString() });
    expect(new ReapGuard(clearDeps()).blockedReason(young)?.reason).toBe('spawn-grace');
    // A caller that wants no spawn grace (e.g. boot purge reaping a dead session) sets minAgeMs:0.
    expect(new ReapGuard(clearDeps(), { minAgeMs: 0 }).blockedReason(young)).toBeNull();
  });
});

describe('ReapGuard — stale-commitment override (2026-06-06: open-commitment was pinning 26h-idle sessions)', () => {
  // An open commitment + NO user message within the staleness window ⇒ the commitment
  // is abandoned and must NOT keep the session. Other guards clear ⇒ reap-eligible.
  it('does NOT keep on an open commitment when no user message within the stale window', () => {
    const g = new ReapGuard(clearDeps({
      topicBinding: () => 42,
      activeCommitmentForTopic: () => true,
      recentUserMessage: () => false, // no message in any window — the commitment is stale
    }));
    expect(g.blockedReason(mkSession())).toBeNull(); // falls through, reap-eligible
  });

  it('STILL keeps on an open commitment while a message is within the stale window (default 8h)', () => {
    const g = new ReapGuard(clearDeps({
      topicBinding: () => 42,
      activeCommitmentForTopic: () => true,
      recentUserMessage: (_t, withinMs) => withinMs > 60 * 60_000, // active within the stale window, not the 30min recent-user window
    }));
    expect(g.blockedReason(mkSession())?.reason).toBe('open-commitment');
  });

  it('honors a custom staleCommitmentWindowMs (a message just outside it ⇒ stale ⇒ reapable)', () => {
    // Window = 2h. A message within 2h keeps; one only within 24h is now stale.
    const within2h = new ReapGuard(clearDeps({
      topicBinding: () => 42,
      activeCommitmentForTopic: () => true,
      recentUserMessage: (_t, withinMs) => withinMs >= 2 * 60 * 60_000,
    }), { staleCommitmentWindowMs: 2 * 60 * 60_000 });
    expect(within2h.blockedReason(mkSession())?.reason).toBe('open-commitment');

    const only24h = new ReapGuard(clearDeps({
      topicBinding: () => 42,
      activeCommitmentForTopic: () => true,
      recentUserMessage: (_t, withinMs) => withinMs >= 24 * 60 * 60_000, // not within 2h
    }), { staleCommitmentWindowMs: 2 * 60 * 60_000 });
    expect(only24h.blockedReason(mkSession())).toBeNull();
  });

  it('Infinity restores always-protect (any open commitment keeps, regardless of activity)', () => {
    const g = new ReapGuard(clearDeps({
      topicBinding: () => 42,
      activeCommitmentForTopic: () => true,
      recentUserMessage: (_t, withinMs) => Number.isFinite(withinMs) ? false : true,
    }), { staleCommitmentWindowMs: Infinity });
    expect(g.blockedReason(mkSession())?.reason).toBe('open-commitment');
  });
});

describe('ReapGuard — "cannot inspect" resolves to KEEP, never reap', () => {
  it('main-process uninspectable (undefined) → KEEP low-confidence', () => {
    const g = new ReapGuard(clearDeps({ mainProcessActive: () => undefined }));
    const r = g.blockedReason(mkSession());
    expect(r?.reason).toBe('process-uninspectable');
    expect(r?.confidence).toBe('low');
  });

  it('a throwing signal source resolves to KEEP (guard-error), never reap', () => {
    const g = new ReapGuard(clearDeps({ isRecoveryActive: () => { throw new Error('boom'); } }));
    const r = g.blockedReason(mkSession());
    expect(r?.reason).toBe('guard-error');
    expect(r?.confidence).toBe('low');
  });
});

describe('ReapGuard — cheap-first ordering (no fork when an in-memory guard hits)', () => {
  it('does not call hasActiveProcesses when protected short-circuits first', () => {
    let forked = false;
    const g = new ReapGuard(
      clearDeps({ protectedSessions: () => ['agent-work'], hasActiveProcesses: () => { forked = true; return false; } }),
    );
    expect(g.blockedReason(mkSession())?.reason).toBe('protected');
    expect(forked).toBe(false);
  });
});
