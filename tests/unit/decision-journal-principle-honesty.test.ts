import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DecisionJournal,
  validateDecisionSubmission,
  DECISION_JOURNAL_WRITABLE_FIELDS,
} from '../../src/core/DecisionJournal.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * The incident these tests encode:
 *
 * An agent POSTed a decision with `reasoning` and `checkedAgainst`, believed it
 * had recorded what the decision was checked against, and had not — neither key
 * is read by anything. The write succeeded (201). Separately, five entries sat
 * in the journal with `principle` unset, and `stats()` reported
 * `topPrinciples: []` — byte-identical to a journal with no entries at all.
 *
 * So the journal could not distinguish "nobody has decided anything yet" from
 * "five decisions were recorded and not one said why". That is absence
 * rendering as presence, on the surface built to detect exactly that.
 */

const SESSION = 'sess-decision-honesty';

function evidence() {
  return [
    {
      kind: 'session' as const,
      sourceId: `session:${SESSION}`,
      weight: 0.5,
      confidence: 0.5,
      privacyTier: 'private' as const,
      updatedAt: new Date().toISOString(),
    },
  ];
}

describe('validateDecisionSubmission — refuses before recording', () => {
  it('REGRESSION: a decision naming no guiding principle is REFUSED', () => {
    const v = validateDecisionSubmission({
      sessionId: SESSION,
      decision: 'Split the spec rather than retry convergence',
    });

    expect(v.ok).toBe(false);
    expect(v.reason).toBe('missing-required');
    expect(v.missingFields).toContain('principle');
    expect(v.message).toMatch(/principle or intent that guided it/i);
  });

  it('REGRESSION: a field no reader consumes is REFUSED, not swallowed', () => {
    // The exact submission from the incident.
    const v = validateDecisionSubmission({
      sessionId: SESSION,
      decision: 'Prune the run file at item-closure',
      principle: 'Structure > Willpower',
      reasoning: 'effort-based pruning measurably lost ground',
      checkedAgainst: 'northstar; tier-1 topic goal',
    });

    expect(v.ok).toBe(false);
    expect(v.reason).toBe('unknown-fields');
    expect(v.unknownFields).toEqual(['checkedAgainst', 'reasoning']);
    // The refusal must tell the caller where the content actually belongs,
    // otherwise it just moves the failure rather than fixing it.
    expect(v.message).toMatch(/context/);
    expect(v.message).toMatch(/principle/);
  });

  it('accepts a complete submission', () => {
    const v = validateDecisionSubmission({
      sessionId: SESSION,
      decision: 'Prune the run file at item-closure',
      principle: 'Structure > Willpower',
      context: 'effort-based pruning lost ground five times; closure-triggered worked twice',
      tags: ['workspace'],
    });

    expect(v.ok).toBe(true);
    expect(v.reason).toBeNull();
    expect(v.unknownFields).toEqual([]);
    expect(v.missingFields).toEqual([]);
  });

  it('a blank or whitespace principle does not satisfy the requirement', () => {
    for (const principle of ['', '   ']) {
      const v = validateDecisionSubmission({
        sessionId: SESSION,
        decision: 'something',
        principle,
      });
      expect(v.ok).toBe(false);
      expect(v.missingFields).toContain('principle');
    }
  });

  it('missing-required outranks unknown-fields, and still reports both', () => {
    const v = validateDecisionSubmission({
      sessionId: SESSION,
      decision: 'something',
      bogus: 1,
    });
    expect(v.reason).toBe('missing-required');
    expect(v.missingFields).toContain('principle');
    // The caller learns about BOTH problems in one round trip rather than
    // fixing one, resubmitting, and discovering the other.
    expect(v.unknownFields).toEqual(['bogus']);
  });

  it('is total — null, undefined and non-objects refuse rather than throw', () => {
    for (const input of [null, undefined, 'string' as unknown as null, 42 as unknown as null]) {
      const v = validateDecisionSubmission(input as never);
      expect(v.ok).toBe(false);
      expect(v.reason).toBe('missing-required');
    }
  });

  it('every writable field is accepted (the allowlist is not stricter than the type)', () => {
    const full: Record<string, unknown> = {
      sessionId: SESSION,
      decision: 'd',
      principle: 'p',
      topicId: 29723,
      jobSlug: 'job',
      alternatives: ['a'],
      confidence: 0.9,
      context: 'c',
      conflict: false,
      tags: ['t'],
      evidence: evidence(),
    };
    // Guards against the allowlist drifting away from the documented field set.
    expect(Object.keys(full).sort()).toEqual([...DECISION_JOURNAL_WRITABLE_FIELDS].sort());
    expect(validateDecisionSubmission(full).ok).toBe(true);
  });
});

describe('stats() — an unprincipled journal cannot look like an empty one', () => {
  let dir: string;
  let journal: DecisionJournal;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decision-journal-'));
    journal = new DecisionJournal(dir);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/decision-journal-principle-honesty.test.ts:cleanup',
    });
  });

  it('REGRESSION: entries with no principle are COUNTED, not silently absent', () => {
    journal.log({ sessionId: SESSION, decision: 'one' }, evidence());
    journal.log({ sessionId: SESSION, decision: 'two' }, evidence());

    const s = journal.stats();

    expect(s.count).toBe(2);
    expect(s.topPrinciples).toEqual([]); // unchanged, still honest
    // The load-bearing assertion: this is what distinguishes the two journals.
    expect(s.unprincipledCount).toBe(2);
    expect(s.principledCount).toBe(0);
  });

  it('REGRESSION: an empty journal is DISTINGUISHABLE from an unprincipled one', () => {
    const empty = journal.stats();
    expect(empty.count).toBe(0);
    expect(empty.unprincipledCount).toBe(0);

    journal.log({ sessionId: SESSION, decision: 'one' }, evidence());
    const populated = journal.stats();

    // Before this change both objects agreed on every principle-related field.
    expect(populated.unprincipledCount).not.toBe(empty.unprincipledCount);
  });

  it('counts principled and unprincipled entries separately in a mixed journal', () => {
    journal.log({ sessionId: SESSION, decision: 'a', principle: 'Structure > Willpower' }, evidence());
    journal.log({ sessionId: SESSION, decision: 'b', principle: 'Structure > Willpower' }, evidence());
    journal.log({ sessionId: SESSION, decision: 'c', principle: 'Close the Loop' }, evidence());
    journal.log({ sessionId: SESSION, decision: 'd' }, evidence());

    const s = journal.stats();

    expect(s.count).toBe(4);
    expect(s.principledCount).toBe(3);
    expect(s.unprincipledCount).toBe(1);
    expect(s.principledCount + s.unprincipledCount).toBe(s.count);
    expect(s.topPrinciples[0]).toEqual({ principle: 'Structure > Willpower', count: 2 });
  });

  it('the machine-generated path is NOT blocked — log() still accepts no principle', () => {
    // DispatchDecisionJournal writes auto-applied dispatch decisions that have
    // no principle to cite. The refusal is scoped to the agent-authored HTTP
    // path; blocking here would break automatic dispatch.
    expect(() =>
      journal.log({ sessionId: SESSION, decision: 'auto-applied' }, evidence()),
    ).not.toThrow();
    expect(journal.stats().count).toBe(1);
  });
});
