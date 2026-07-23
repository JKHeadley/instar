/**
 * Wiring-integrity unit test (TESTING-INTEGRITY-SPEC — "verify deps are not null,
 * not no-ops, and delegate to real implementations") for the increment-2 factory
 * makeMissingLoginSessionDetector: fake managers → a real gap → the adapted
 * attention-item shape the real TelegramAdapter.createAttentionItem consumes, plus
 * the session→configHome correlation (drift under a live session = stranded; no
 * drift, or an unresolvable session = empty).
 */
import { describe, it, expect } from 'vitest';
import { makeMissingLoginSessionDetector, type MissingLoginAttentionItemInput } from '../../src/monitoring/missingLoginSessionWiring.js';
import { MISSING_LOGIN_SESSION_DEDUP_KEY } from '../../src/monitoring/MissingLoginSessionDetector.js';

describe('makeMissingLoginSessionDetector (factory dep mapping)', () => {
  it('maps a missing-login account + a live session on its slot into the real attention-item shape', () => {
    const raised: MissingLoginAttentionItemInput[] = [];
    const detector = makeMissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => false, // live → actually raises
      getPoolAccounts: () => [
        // login gone missing (owner-relogin-required) on slot /home/a
        { id: 'acct-a', configHome: '/home/a', identityDrift: { repairState: 'owner-relogin-required', actualAccountId: 'x' } },
        // a healthy account on a different slot — not stranded
        { id: 'acct-b', configHome: '/home/b' },
      ],
      getRunningSessions: () => [
        { sessionName: 'sess-1', subscriptionAccountId: 'acct-a' }, // on the missing-login slot
        { sessionName: 'sess-2', subscriptionAccountId: 'acct-b' }, // on the healthy slot
      ],
      createAttentionItem: (item) => { raised.push(item); },
    });

    const r = detector.tick();
    expect(r.gapDetected).toBe(true);
    expect(r.raised).toBe(true);
    // only acct-a is stranded, and only sess-1 depends on it
    expect(r.stranded).toEqual([{ accountId: 'acct-a', sessionNames: ['sess-1'] }]);

    expect(raised).toHaveLength(1);
    const item = raised[0];
    // The load-bearing adaptation: dedupKey→id, body→summary, source→sourceContext,
    // category 'monitoring', priority HIGH.
    expect(item.id).toBe(MISSING_LOGIN_SESSION_DEDUP_KEY);
    expect(item.category).toBe('monitoring');
    expect(item.priority).toBe('HIGH');
    expect(item.sourceContext).toBe('missing-login-session');
    expect(item.title).toBe('A live session is running on a missing login');
    expect(item.summary).toContain('acct-a'); // body names the account
  });

  it('recognizes the actualAccountId==="missing-local-login" drift marker too', () => {
    const raised: MissingLoginAttentionItemInput[] = [];
    const detector = makeMissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => false,
      getPoolAccounts: () => [
        { id: 'acct-a', configHome: '/home/a', identityDrift: { actualAccountId: 'missing-local-login' } },
      ],
      getRunningSessions: () => [{ sessionName: 'sess-1', subscriptionAccountId: 'acct-a' }],
      createAttentionItem: (item) => { raised.push(item); },
    });
    const r = detector.tick();
    expect(r.gapDetected).toBe(true);
    expect(raised).toHaveLength(1);
  });

  it('no drift → no gap, no attention raised', () => {
    const raised: MissingLoginAttentionItemInput[] = [];
    const detector = makeMissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => false,
      getPoolAccounts: () => [{ id: 'acct-a', configHome: '/home/a' }], // healthy
      getRunningSessions: () => [{ sessionName: 'sess-1', subscriptionAccountId: 'acct-a' }],
      createAttentionItem: (item) => { raised.push(item); },
    });
    const r = detector.tick();
    expect(r.gapDetected).toBe(false);
    expect(raised).toHaveLength(0);
  });

  it('drift with NO live session on that slot → not a gap (drift alone is not urgent)', () => {
    const raised: MissingLoginAttentionItemInput[] = [];
    const detector = makeMissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => false,
      getPoolAccounts: () => [
        { id: 'acct-a', configHome: '/home/a', identityDrift: { repairState: 'owner-relogin-required' } },
      ],
      getRunningSessions: () => [{ sessionName: 'sess-2', subscriptionAccountId: 'acct-b' }], // different slot
      createAttentionItem: (item) => { raised.push(item); },
    });
    const r = detector.tick();
    expect(r.gapDetected).toBe(false);
    expect(raised).toHaveLength(0);
  });

  it('a session with no subscriptionAccountId is skipped (unresolvable slot → no false correlation)', () => {
    const raised: MissingLoginAttentionItemInput[] = [];
    const detector = makeMissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => false,
      getPoolAccounts: () => [
        { id: 'acct-a', configHome: '/home/a', identityDrift: { repairState: 'owner-relogin-required' } },
      ],
      getRunningSessions: () => [{ sessionName: 'legacy-sess' }], // no account id → skipped
      createAttentionItem: (item) => { raised.push(item); },
    });
    const r = detector.tick();
    expect(r.gapDetected).toBe(false);
    expect(raised).toHaveLength(0);
  });

  it('dryRun on a real gap → computes the verdict but raises NOTHING', () => {
    const raised: MissingLoginAttentionItemInput[] = [];
    const detector = makeMissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => true, // first rung — count would-raise, raise nothing
      getPoolAccounts: () => [
        { id: 'acct-a', configHome: '/home/a', identityDrift: { repairState: 'owner-relogin-required' } },
      ],
      getRunningSessions: () => [{ sessionName: 'sess-1', subscriptionAccountId: 'acct-a' }],
      createAttentionItem: (item) => { raised.push(item); },
    });
    const r = detector.tick();
    expect(r.gapDetected).toBe(true);
    expect(r.raised).toBe(false);
    expect(raised).toHaveLength(0);
    expect(detector.status().counters.wouldRaise).toBe(1);
  });

  it('disabled gate → strict no-op (never reads managers, never raises)', () => {
    let poolReads = 0;
    const detector = makeMissingLoginSessionDetector({
      enabled: () => false,
      dryRun: () => false,
      getPoolAccounts: () => { poolReads += 1; return []; },
      getRunningSessions: () => [],
      createAttentionItem: () => { throw new Error('must not raise while dark'); },
    });
    const r = detector.tick();
    expect(r.ran).toBe(false);
    expect(poolReads).toBe(0);
  });
});
