/**
 * Unit tests for FailureLedger — the dev-process failure forensics spine.
 *
 * Covers the converged-spec invariants (docs/specs/FAILURE-LEARNING-LOOP-SPEC.md):
 *  - open() creates an attributed record with a machine-scoped id
 *  - dedupeKey upsert (§4.2 M5): a repeat increments occurrenceCount, never duplicates
 *  - COUNT(DISTINCT) diversity (§4.4): distinct sessions / cause-commits
 *  - mandatory ifMatch OCC (§4.2 M4): stale version → conflict, no lost update
 *  - redaction (§4.8 C7): toApiView() never exposes detail.full
 *  - list() filtering
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FailureLedger } from '../../src/monitoring/FailureLedger.js';
import type { OpenFailureInput } from '../../src/monitoring/FailureLedger.js';

function baseInput(over: Partial<OpenFailureInput> = {}): OpenFailureInput {
  return {
    filedBy: 'session-A',
    source: 'bugfix-commit',
    severity: 'medium',
    summary: 'null deref in reconciler',
    detail: { redacted: 'null deref in <module>', full: 'null deref in src/core/Foo.ts:42 (secret path)' },
    category: 'logic',
    initiativeId: 'init-foo',
    causeCommitOid: 'abc123',
    attribution: 'automatic',
    attributionConfidence: 0.9,
    ...over,
  };
}

describe('FailureLedger', () => {
  let ledger: FailureLedger;

  beforeEach(() => {
    ledger = new FailureLedger({ dbPath: ':memory:', machineId: 'testbox' });
  });
  afterEach(() => ledger.close());

  it('open() creates a record with a machine-scoped id and full attribution', () => {
    const rec = ledger.open(baseInput());
    expect(rec).not.toBeNull();
    expect(rec!.id).toMatch(/^FAIL-testbox-\d{3}$/);
    expect(rec!.occurrenceCount).toBe(1);
    expect(rec!.initiativeId).toBe('init-foo');
    expect(rec!.attribution).toBe('automatic');
    expect(rec!.version).toBe(1);
    expect(rec!.status).toBe('open');
  });

  it('dedupeKey upsert: a repeat increments occurrenceCount, never duplicates (M5)', () => {
    const first = ledger.open(baseInput());
    const second = ledger.open(baseInput()); // same source+cause+category
    expect(second!.id).toBe(first!.id);
    expect(second!.occurrenceCount).toBe(2);
    expect(ledger.list({}).length).toBe(1); // exactly one record
  });

  it('a different cause-commit produces a distinct record', () => {
    ledger.open(baseInput({ causeCommitOid: 'abc123' }));
    ledger.open(baseInput({ causeCommitOid: 'def456' }));
    expect(ledger.list({}).length).toBe(2);
  });

  it('distinctCounts uses COUNT(DISTINCT) — a single session/commit can never fake diversity (§4.4)', () => {
    const key = FailureLedger.dedupeKey('bugfix-commit', 'abc123', 'logic');
    // Same session, same commit, filed 4 times: occurrenceCount=4 but diversity=1/1.
    for (let i = 0; i < 4; i++) ledger.open(baseInput());
    const counts = ledger.distinctCounts(key);
    expect(counts.sessions).toBe(1);
    expect(counts.causeCommits).toBe(1);
    expect(ledger.getByDedupeKey(key)!.occurrenceCount).toBe(4);
  });

  it('distinctCounts counts genuinely diverse sources', () => {
    // Same dedupeKey requires same source+cause+category; vary filedBy only.
    ledger.open(baseInput({ filedBy: 'session-A' }));
    ledger.open(baseInput({ filedBy: 'session-B' }));
    ledger.open(baseInput({ filedBy: 'session-C' }));
    const key = FailureLedger.dedupeKey('bugfix-commit', 'abc123', 'logic');
    expect(ledger.distinctCounts(key).sessions).toBe(3);
  });

  it('update() enforces mandatory ifMatch — stale version loses (M4)', () => {
    const rec = ledger.open(baseInput())!;
    // Correct version succeeds and bumps version.
    const ok = ledger.update(rec.id, { status: 'attributed' }, rec.version);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.record.version).toBe(rec.version + 1);

    // Stale version (the original) now conflicts — no lost update.
    const stale = ledger.update(rec.id, { status: 'resolved' }, rec.version);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.conflict).toBe(true);
    expect(ledger.get(rec.id)!.status).toBe('attributed'); // unchanged by the stale write
  });

  it('toApiView strips detail.full — full never crosses an HTTP boundary (§4.8 C7)', () => {
    const rec = ledger.open(baseInput())!;
    const view = FailureLedger.toApiView(rec);
    expect(view.detail).toEqual({ redacted: 'null deref in <module>' });
    expect((view.detail as Record<string, unknown>).full).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('secret path');
  });

  it('list() filters by source, category, attribution', () => {
    ledger.open(baseInput({ source: 'bugfix-commit', category: 'logic', causeCommitOid: 'c1' }));
    ledger.open(baseInput({ source: 'agent-diagnosed', category: 'wiring', causeCommitOid: 'c2', attribution: 'one-tap' }));
    expect(ledger.list({ source: 'agent-diagnosed' }).length).toBe(1);
    expect(ledger.list({ category: 'logic' }).length).toBe(1);
    expect(ledger.list({ attribution: 'one-tap' })[0].source).toBe('agent-diagnosed');
  });

  // Keyset pagination for the Process Health tab (spec §3): before= upper-bound
  // + limit clamps on both list() and listInsights().
  it('list() honors a limit and a before= upper bound (detected_at < beforeMs)', () => {
    // Distinct causeCommitOid → distinct computed dedupeKey → 3 separate records.
    for (const c of ['c1', 'c2', 'c3']) ledger.open(baseInput({ causeCommitOid: c }));
    expect(ledger.list({}).length).toBe(3);
    expect(ledger.list({ limit: 2 }).length).toBe(2); // LIMIT applied
    expect(ledger.list({ beforeMs: Date.now() + 60_000 }).length).toBe(3); // all are before "now+1m"
    expect(ledger.list({ beforeMs: Date.now() - 60_000 }).length).toBe(0); // none predate "now-1m"
  });

  it('listInsights() honors before= + limit and clamps within 1..1000', () => {
    const seed = (k: string) =>
      ledger.upsertInsight({ identityKey: k, summary: `pattern ${k}`, recommendation: 'r', supportingFailureIds: [], distinctSessions: 3, distinctCauseCommits: 3 });
    seed('k1'); seed('k2');
    expect(ledger.listInsights({}).length).toBe(2);
    expect(ledger.listInsights({ limit: 1 }).length).toBe(1); // LIMIT applied
    expect(ledger.listInsights({ beforeMs: Date.now() + 60_000 }).length).toBe(2); // discovered before "now+1m"
    expect(ledger.listInsights({ beforeMs: Date.now() - 60_000 }).length).toBe(0); // none predate "now-1m"
    // A non-positive limit falls back to the insight default (not 0 rows).
    expect(ledger.listInsights({ limit: 0 }).length).toBe(2);
  });

  it('open() is fail-open: a storage failure returns null, never throws', () => {
    ledger.close(); // force subsequent ops to fail on a closed DB
    expect(() => {
      const r = ledger.open(baseInput());
      expect(r).toBeNull();
    }).not.toThrow();
  });
});
