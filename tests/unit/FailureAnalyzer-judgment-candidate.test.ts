/**
 * Unit tests for the judgment-candidate cluster in FailureAnalyzer +
 * FailureRecord.judgmentCandidate persistence (ownership-gated-spawn-and-
 * judgment-within-floors §3.6 — the Decision Provenance & Outcome Review
 * standard's failure-analysis hook).
 *
 * The cluster is CROSS-CATEGORY by design: the shared trait is "a static
 * heuristic at a competing-signals decision point failed", not the failure
 * category — so three judgment-flagged failures in three DIFFERENT categories
 * (each individually below the categorical support gate) still cluster.
 * Same diversity gates as categorical clusters (a single session / single
 * cause-commit can never manufacture the insight). Signal-only: the insight
 * carries the fixed template recommendation, never free prose.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FailureLedger } from '../../src/monitoring/FailureLedger.js';
import type { OpenFailureInput } from '../../src/monitoring/FailureLedger.js';
import { FailureAnalyzer, DEFAULT_GATES } from '../../src/monitoring/FailureAnalyzer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function rec(over: Partial<OpenFailureInput> = {}): OpenFailureInput {
  return {
    filedBy: 'session-A', source: 'bugfix-commit', severity: 'medium',
    summary: 'static heuristic misfired', detail: { redacted: 'r', full: 'f' },
    category: 'concurrency', initiativeId: 'init-foo', causeCommitOid: 'c1',
    attribution: 'automatic', attributionConfidence: 0.9, ...over,
  };
}

describe('FailureRecord.judgmentCandidate persistence', () => {
  let ledger: FailureLedger;
  beforeEach(() => { ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb' }); });
  afterEach(() => ledger.close());

  it('round-trips: filed true → read back true; unfiled → undefined (never false noise)', () => {
    const a = ledger.open(rec({ judgmentCandidate: true, summary: 'flagged' }));
    const b = ledger.open(rec({ summary: 'unflagged', causeCommitOid: 'c2' }));
    const all = ledger.list({ limit: 10 });
    const ra = all.find((r) => r.id === a.id);
    const rb = all.find((r) => r.id === b.id);
    expect(ra?.judgmentCandidate).toBe(true);
    expect(rb?.judgmentCandidate).toBeUndefined();
  });

  it('the schema migration is idempotent — a SECOND ledger over the same db opens clean', () => {
    // ALTER TABLE ADD COLUMN throws 'duplicate column name' on re-open unless
    // swallowed — the constructor's exec loop must tolerate the re-run.
    // (in-memory dbs don't persist across handles; a file db exercises re-open)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-ledger-'));
    const dbPath = path.join(dir, 'failures.sqlite');
    try {
      const l1 = new FailureLedger({ dbPath, machineId: 'tb' });
      l1.open(rec({ judgmentCandidate: true }));
      l1.close();
      const l2 = new FailureLedger({ dbPath, machineId: 'tb' }); // re-runs SCHEMA incl. ALTER
      expect(l2.list({ limit: 5 })[0]?.judgmentCandidate).toBe(true);
      l2.close();
    } finally {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/unit/FailureAnalyzer-judgment-candidate.test.ts:cleanup',
      });
    }
  });
});

describe('FailureAnalyzer judgment-candidate cluster', () => {
  let ledger: FailureLedger;
  beforeEach(() => { ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'tb' }); });
  afterEach(() => ledger.close());

  it('clusters ACROSS categories: flagged failures in different categories fire ONE judgment-candidate insight', () => {
    // Each category appears once — every CATEGORICAL cluster is below support.
    ledger.open(rec({ judgmentCandidate: true, category: 'concurrency', filedBy: 'sA', causeCommitOid: 'c1' }));
    ledger.open(rec({ judgmentCandidate: true, category: 'wiring', filedBy: 'sB', causeCommitOid: 'c2' }));
    ledger.open(rec({ judgmentCandidate: true, category: 'regression', filedBy: 'sC', causeCommitOid: 'c3' }));
    ledger.open(rec({ judgmentCandidate: true, category: 'unknown', filedBy: 'sD', causeCommitOid: 'c4' }));
    const res = new FailureAnalyzer(ledger, DEFAULT_GATES).analyze();
    const jc = res.insightsDiscovered.filter((i) => i.targetCategory === 'judgment-candidate');
    expect(jc).toHaveLength(1);
    expect(jc[0].summary).toContain('judgment-candidate');
    // Template recommendation, never free prose.
    expect(jc[0].recommendation).toContain('Judgment Within Floors');
    expect(jc[0].recommendation).toContain('deterministic floor');
    expect(jc[0].supportingFailureIds.length).toBe(4);
  });

  it('diversity gate holds: one session filing 4 flagged failures on one cause-commit NEVER fires', () => {
    for (let i = 0; i < 4; i++) ledger.open(rec({ judgmentCandidate: true, summary: `dup ${i}`, filedBy: 'sA', causeCommitOid: 'c1' }));
    const res = new FailureAnalyzer(ledger, DEFAULT_GATES).analyze();
    expect(res.insightsDiscovered.filter((i) => i.targetCategory === 'judgment-candidate')).toHaveLength(0);
    expect(res.clustersBelowThreshold).toBeGreaterThanOrEqual(1);
  });

  it('unflagged records never join the cluster (no flag inference)', () => {
    ledger.open(rec({ judgmentCandidate: true, category: 'concurrency', filedBy: 'sA', causeCommitOid: 'c1' }));
    ledger.open(rec({ judgmentCandidate: true, category: 'wiring', filedBy: 'sB', causeCommitOid: 'c2' }));
    ledger.open(rec({ judgmentCandidate: true, category: 'regression', filedBy: 'sC', causeCommitOid: 'c3' }));
    // Plenty of UNflagged diversity that must not count toward the jc cluster.
    ledger.open(rec({ category: 'timeout', filedBy: 'sD', causeCommitOid: 'c4' }));
    ledger.open(rec({ category: 'timeout', filedBy: 'sE', causeCommitOid: 'c5' }));
    const res = new FailureAnalyzer(ledger, DEFAULT_GATES).analyze();
    const jc = res.insightsDiscovered.filter((i) => i.targetCategory === 'judgment-candidate');
    if (jc.length === 1) {
      // If 3 flagged records cross DEFAULT_GATES support, only the 3 flagged ids belong.
      expect(jc[0].supportingFailureIds.length).toBe(3);
    } else {
      // Otherwise the cluster stayed below support — also correct; the point is
      // the unflagged records did NOT smuggle it over the gate.
      expect(jc).toHaveLength(0);
    }
  });

  it('re-run is idempotent — the jc insight upserts on its stable identityKey, never duplicates', () => {
    ledger.open(rec({ judgmentCandidate: true, category: 'concurrency', filedBy: 'sA', causeCommitOid: 'c1' }));
    ledger.open(rec({ judgmentCandidate: true, category: 'wiring', filedBy: 'sB', causeCommitOid: 'c2' }));
    ledger.open(rec({ judgmentCandidate: true, category: 'regression', filedBy: 'sC', causeCommitOid: 'c3' }));
    ledger.open(rec({ judgmentCandidate: true, category: 'unknown', filedBy: 'sD', causeCommitOid: 'c4' }));
    const a = new FailureAnalyzer(ledger, DEFAULT_GATES);
    a.analyze();
    a.analyze();
    const jc = ledger.listInsights().filter((i) => i.targetCategory === 'judgment-candidate');
    expect(jc).toHaveLength(1);
  });

  it('zero flagged records → zero jc clusters considered (no phantom cluster row)', () => {
    ledger.open(rec({ filedBy: 'sA', causeCommitOid: 'c1' }));
    const res = new FailureAnalyzer(ledger, DEFAULT_GATES).analyze();
    expect(res.insightsDiscovered.filter((i) => i.targetCategory === 'judgment-candidate')).toHaveLength(0);
  });
});
