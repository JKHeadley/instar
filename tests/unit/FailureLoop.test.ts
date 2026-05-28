/**
 * Unit tests for the closed loop — FailureAnalyzer + FailureLoopDriver.
 *
 * Covers the converged-spec invariants (docs/specs/FAILURE-LEARNING-LOOP-SPEC.md):
 *  - analyzer fires only when the support + SOURCE-DIVERSITY gate is crossed (§4.4 M4/M5)
 *  - a single session / single cause-commit can NEVER manufacture an insight
 *  - analyzer re-run is idempotent (stable identityKey → upsert, never re-announce)
 *  - BY-CONSTRUCTION AUTHORITY GUARD (§4.6.1 / BL-2): the loop opens an Action +
 *    a draft Initiative and PROVABLY never reaches the proposal / auto-implement
 *    path — even with an autonomous-mode evaluator wired and watching
 *  - verify step (§4.6.1 step 5): drop → effective; no-drop → reopen → capped
 *    inconclusive; correlational, never causal
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FailureLedger } from '../../src/monitoring/FailureLedger.js';
import type { OpenFailureInput } from '../../src/monitoring/FailureLedger.js';
import { FailureAnalyzer, DEFAULT_GATES } from '../../src/monitoring/FailureAnalyzer.js';
import { FailureLoopDriver } from '../../src/monitoring/FailureLoopDriver.js';

function rec(over: Partial<OpenFailureInput> = {}): OpenFailureInput {
  return {
    filedBy: 'session-A', source: 'bugfix-commit', severity: 'medium',
    summary: 'concurrency bug', detail: { redacted: 'race', full: 'race in X' },
    category: 'concurrency', initiativeId: 'init-foo', causeCommitOid: 'c1',
    attribution: 'automatic', attributionConfidence: 0.9, ...over,
  };
}

describe('FailureAnalyzer', () => {
  let ledger: FailureLedger;
  beforeEach(() => { ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb' }); });
  afterEach(() => ledger.close());

  it('fires an insight when support + diversity are met (3 sessions, 3 cause-commits)', () => {
    ledger.open(rec({ filedBy: 'sA', causeCommitOid: 'c1' }));
    ledger.open(rec({ filedBy: 'sB', causeCommitOid: 'c2' }));
    ledger.open(rec({ filedBy: 'sC', causeCommitOid: 'c3' }));
    ledger.open(rec({ filedBy: 'sD', causeCommitOid: 'c4' }));
    const res = new FailureAnalyzer(ledger, DEFAULT_GATES).analyze();
    expect(res.insightsDiscovered).toHaveLength(1);
    expect(res.insightsDiscovered[0].targetCategory).toBe('concurrency');
    expect(res.insightsDiscovered[0].recommendation).toMatch(/concurrency/i);
  });

  it('does NOT fire when one session files 4× on one cause-commit (diversity gate, M4/M5)', () => {
    for (let i = 0; i < 4; i++) ledger.open(rec({ filedBy: 'sA', causeCommitOid: 'c1' }));
    const res = new FailureAnalyzer(ledger, DEFAULT_GATES).analyze();
    expect(res.insightsDiscovered).toHaveLength(0);
    expect(res.clustersBelowThreshold).toBeGreaterThanOrEqual(1);
  });

  it('re-run is idempotent — same pattern updates, never duplicates (stable identityKey)', () => {
    for (const s of ['sA', 'sB', 'sC', 'sD']) ledger.open(rec({ filedBy: s, causeCommitOid: `c-${s}` }));
    const a = new FailureAnalyzer(ledger, DEFAULT_GATES);
    a.analyze();
    a.analyze();
    expect(ledger.listInsights().length).toBe(1);
  });
});

describe('FailureLoopDriver — by-construction authority guard (§4.6.1 / BL-2)', () => {
  let ledger: FailureLedger;
  beforeEach(() => {
    ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb' });
    for (const s of ['sA', 'sB', 'sC', 'sD']) ledger.open(rec({ filedBy: s, causeCommitOid: `c-${s}` }));
    new FailureAnalyzer(ledger, DEFAULT_GATES).analyze(); // produce a discovered insight
  });
  afterEach(() => ledger.close());

  it('opens an Action + a draft Initiative, and NEVER reaches the proposal/auto-implement path', async () => {
    // A stand-in for EvolutionManager exposing BOTH the action path AND the
    // proposal/auto-implement path. The loop is wired ONLY to addAction +
    // createInitiative — it has no way to call the proposal path.
    const evo = {
      addAction: vi.fn(() => ({ id: 'ACT-1' })),
      addProposal: vi.fn(() => ({ id: 'EVO-1' })),                 // MUST stay uncalled
      processProposalAutonomously: vi.fn(async () => ({ action: 'implemented' })), // MUST stay uncalled
      listProposals: vi.fn(() => [] as { id: string }[]),
      evolutionApprovalMode: 'autonomous' as const,               // autonomous ON
    };
    const createInitiative = vi.fn(async (i: { id: string }) => ({ id: i.id }));

    const driver = new FailureLoopDriver(ledger, {
      addAction: evo.addAction,
      createInitiative,
    });
    const res = await driver.actOnNewInsights();

    // It DID open the tracked items:
    expect(evo.addAction).toHaveBeenCalledTimes(1);
    expect(createInitiative).toHaveBeenCalledTimes(1);
    expect(res.actedOn[0].status).toBe('acted-on');
    expect(res.actedOn[0].actedOnVia).toMatch(/^failure-insight-/);

    // It did NOT touch the proposal / auto-implement path — even with autonomous ON:
    expect(evo.addProposal).not.toHaveBeenCalled();
    expect(evo.processProposalAutonomously).not.toHaveBeenCalled();
    expect(evo.listProposals()).toHaveLength(0); // zero loop-created proposals
  });

  it('is idempotent — an already acted-on insight is not re-actioned', async () => {
    const addAction = vi.fn(() => ({ id: 'ACT-1' }));
    const createInitiative = vi.fn(async (i: { id: string }) => ({ id: i.id }));
    const driver = new FailureLoopDriver(ledger, { addAction, createInitiative });
    await driver.actOnNewInsights();
    await driver.actOnNewInsights(); // second run: nothing new in 'discovered'
    expect(addAction).toHaveBeenCalledTimes(1);
  });
});

describe('FailureLoopDriver — verify step (§4.6.1 step 5)', () => {
  let ledger: FailureLedger;
  let clock: number;
  const day = 86400_000;

  function seedActedOnInsight() {
    for (const s of ['sA', 'sB', 'sC', 'sD']) ledger.open(rec({ filedBy: s, causeCommitOid: `c-${s}` }));
    new FailureAnalyzer(ledger, DEFAULT_GATES).analyze();
  }

  beforeEach(() => {
    ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb' });
    clock = Date.now();
  });
  afterEach(() => ledger.close());

  it('drop below baseline after the window → verified-effective (labeled correlational)', async () => {
    seedActedOnInsight();
    const driver = new FailureLoopDriver(ledger, {
      addAction: () => ({ id: 'A' }), createInitiative: async (i) => ({ id: i.id }),
      now: () => clock, verifyWindowDays: 42, minPostExposure: 0,
    });
    await driver.actOnNewInsights();
    clock += 43 * day; // window elapses; NO new concurrency failures filed since
    const res = driver.runVerification();
    expect(res.evaluated[0].status).toBe('verified-effective');
    expect(res.evaluated[0].verifiedOutcome).toBe('effective');
  });

  it('no drop → reopen, then terminal inconclusive at the reopen cap (never churns forever)', async () => {
    seedActedOnInsight();
    const driver = new FailureLoopDriver(ledger, {
      addAction: () => ({ id: 'A' }), createInitiative: async (i) => ({ id: i.id }),
      now: () => clock, verifyWindowDays: 42, maxReopens: 2, minPostExposure: 0,
    });
    await driver.actOnNewInsights();
    // Keep filing the same category so it never drops below baseline.
    const keepFailing = () => { for (const s of ['sA', 'sB', 'sC', 'sD']) ledger.open(rec({ filedBy: s, causeCommitOid: `c2-${s}` })); };
    clock += 43 * day; keepFailing(); driver.runVerification();        // reopen 1
    clock += 43 * day; keepFailing(); driver.runVerification();        // reopen 2
    clock += 43 * day; keepFailing(); const last = driver.runVerification(); // cap → inconclusive
    expect(last.evaluated[0].status).toBe('inconclusive');
    expect(last.evaluated[0].verifiedOutcome).toBe('ineffective');
  });
});
