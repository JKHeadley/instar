/**
 * Wiring-integrity unit test (TESTING-INTEGRITY-SPEC — "verify deps are not null,
 * not no-ops, and delegate to real implementations") for the increment-2 factory
 * makeMissingLoginSessionDetector: fake managers → a real gap → the adapted
 * attention-item shape the real TelegramAdapter.createAttentionItem consumes, plus
 * the session→configHome correlation. Correlation is on the session's REAL config
 * home (its live CLAUDE_CONFIG_DIR, resolved upstream from tmux), NOT its recorded
 * subscriptionAccountId — the identity-drift case where the two DIVERGE is the exact
 * gap this guard exists for (drift under a live session = stranded; no drift, or an
 * unresolvable session = empty).
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
        { sessionName: 'sess-1', configHome: '/home/a' }, // real slot = the missing-login slot
        { sessionName: 'sess-2', configHome: '/home/b' }, // real slot = the healthy slot
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
      getRunningSessions: () => [{ sessionName: 'sess-1', configHome: '/home/a' }],
      createAttentionItem: (item) => { raised.push(item); },
    });
    const r = detector.tick();
    expect(r.gapDetected).toBe(true);
    expect(raised).toHaveLength(1);
  });

  it('IDENTITY DRIFT: correlates on the REAL config home even when the recorded account would resolve elsewhere', () => {
    // The 2026-07-22 justin-gmail defect: a live session RECORDED subscriptionAccountId
    // 'adriana' (a healthy account on /home/adriana) while its REAL CLAUDE_CONFIG_DIR was
    // '/home/justin-gmail' — the login-MISSING account's slot. Resolving via the recorded
    // account lands on /home/adriana (healthy) and MISSES the gap; correlating on the real
    // config home lands on justin-gmail and flags it.
    const raised: MissingLoginAttentionItemInput[] = [];
    const detector = makeMissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => false,
      getPoolAccounts: () => [
        // The account the session RECORDS — healthy, on its own slot. If this were the
        // resolution key the gap would be missed.
        { id: 'adriana', configHome: '/home/adriana' },
        // The account the session is ACTUALLY on — its login is missing.
        { id: 'justin-gmail', configHome: '/home/justin-gmail', identityDrift: { repairState: 'owner-relogin-required' } },
      ],
      getRunningSessions: () => [
        // Real config home = the login-missing slot, NOT adriana's (the divergence IS the drift).
        { sessionName: 'echo-llm-pathway-characterization', configHome: '/home/justin-gmail' },
      ],
      createAttentionItem: (item) => { raised.push(item); },
    });
    const r = detector.tick();
    expect(r.gapDetected).toBe(true);
    expect(r.raised).toBe(true);
    // Correlated on the REAL config home → stranded on justin-gmail, not adriana.
    expect(r.stranded).toEqual([{ accountId: 'justin-gmail', sessionNames: ['echo-llm-pathway-characterization'] }]);
    expect(raised).toHaveLength(1);
    expect(raised[0].summary).toContain('justin-gmail');
  });

  it('INVERSE: a session whose real config home matches no missing account → no alert', () => {
    const raised: MissingLoginAttentionItemInput[] = [];
    const detector = makeMissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => false,
      getPoolAccounts: () => [
        { id: 'justin-gmail', configHome: '/home/justin-gmail', identityDrift: { repairState: 'owner-relogin-required' } },
      ],
      // Real config home is a healthy slot that is NOT the missing account's → no gap.
      getRunningSessions: () => [{ sessionName: 'sess-1', configHome: '/home/adriana' }],
      createAttentionItem: (item) => { raised.push(item); },
    });
    const r = detector.tick();
    expect(r.gapDetected).toBe(false);
    expect(raised).toHaveLength(0);
  });

  it('no drift → no gap, no attention raised', () => {
    const raised: MissingLoginAttentionItemInput[] = [];
    const detector = makeMissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => false,
      getPoolAccounts: () => [{ id: 'acct-a', configHome: '/home/a' }], // healthy
      getRunningSessions: () => [{ sessionName: 'sess-1', configHome: '/home/a' }],
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
      getRunningSessions: () => [{ sessionName: 'sess-2', configHome: '/home/b' }], // different slot
      createAttentionItem: (item) => { raised.push(item); },
    });
    const r = detector.tick();
    expect(r.gapDetected).toBe(false);
    expect(raised).toHaveLength(0);
  });

  it('a session with no resolvable configHome is skipped (unresolvable slot → no false correlation)', () => {
    const raised: MissingLoginAttentionItemInput[] = [];
    const detector = makeMissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => false,
      getPoolAccounts: () => [
        { id: 'acct-a', configHome: '/home/a', identityDrift: { repairState: 'owner-relogin-required' } },
      ],
      getRunningSessions: () => [{ sessionName: 'legacy-sess' }], // configHome unresolved (tmux read failed) → skipped
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
      getRunningSessions: () => [{ sessionName: 'sess-1', configHome: '/home/a' }],
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
