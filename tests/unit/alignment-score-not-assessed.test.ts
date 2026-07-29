import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntentDriftDetector } from '../../src/core/IntentDriftDetector.js';
import { DecisionJournal } from '../../src/core/DecisionJournal.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * The defect these tests encode:
 *
 * `alignmentScore()` on an empty journal returned `score: 0, grade: 'F'`. The
 * `summary` field said "No decisions logged — alignment cannot be assessed",
 * which is honest — but no consumer read it. `instar intent drift` printed
 *
 *     Alignment Score: 0/100 (F)        <- in red
 *       Conflict Freedom:      0/100
 *       ...
 *
 * and dropped the summary entirely. So "we have no data" rendered identically
 * to "we assessed you and you failed catastrophically" — on the instrument
 * whose whole job is measuring alignment honestly.
 *
 * The journal was empty for its entire existence (count: 0 until 2026-07-26),
 * so that red F is the only output this surface has ever produced.
 *
 * Root cause was the vocabulary: the grade union was `A|B|C|D|F` with no way
 * to say "no verdict", so absence had to borrow the worst real grade.
 */

const SESSION = 'sess-alignment';

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

describe('alignmentScore — absence must not render as a bad grade', () => {
  let dir: string;
  let detector: IntentDriftDetector;
  let journal: DecisionJournal;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alignment-score-'));
    detector = new IntentDriftDetector(dir);
    journal = new DecisionJournal(dir);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/alignment-score-not-assessed.test.ts:cleanup',
    });
  });

  it("REGRESSION: an empty journal grades 'N/A', never 'F'", () => {
    const s = detector.alignmentScore();

    expect(s.sampleSize).toBe(0);
    // The load-bearing assertion. 'F' here is a fabricated verdict.
    expect(s.grade).toBe('N/A');
    expect(s.grade).not.toBe('F');
  });

  it('REGRESSION: an empty journal is flagged unassessable', () => {
    const s = detector.alignmentScore();

    // A machine consumer reads this rather than having to know that
    // sampleSize===0 invalidates every other field.
    expect(s.assessable).toBe(false);
    expect(s.summary).toMatch(/cannot be assessed/i);
  });

  it('REGRESSION: a real assessment is DISTINGUISHABLE from an empty one', () => {
    const empty = detector.alignmentScore();

    journal.log(
      { sessionId: SESSION, decision: 'a real decision', principle: 'Structure > Willpower', confidence: 0.9 },
      evidence(),
    );
    const populated = detector.alignmentScore();

    // Before this change both agreed on `grade` whenever the real score was
    // also poor — the two cases were indistinguishable on every field a
    // consumer actually rendered.
    expect(populated.assessable).not.toBe(empty.assessable);
    expect(populated.grade).not.toBe(empty.grade);
    expect(populated.sampleSize).toBeGreaterThan(0);
  });

  it('a genuinely assessed period still reports a real letter grade', () => {
    for (let i = 0; i < 3; i++) {
      journal.log(
        { sessionId: SESSION, decision: `d${i}`, principle: 'Structure > Willpower', confidence: 0.9 },
        evidence(),
      );
    }

    const s = detector.alignmentScore();

    expect(s.assessable).toBe(true);
    expect(['A', 'B', 'C', 'D', 'F']).toContain(s.grade);
    // 'N/A' must never appear on an assessed period — that would be the
    // mirror error: a real measurement reported as no-data.
    expect(s.grade).not.toBe('N/A');
    expect(s.sampleSize).toBe(3);
  });

  it('a finite populated journal is assessable', () => {
    expect(detector.alignmentScore().assessable).toBe(false);

    journal.log(
      { sessionId: SESSION, decision: 'one', principle: 'p', confidence: 0.5 },
      evidence(),
    );

    const s = detector.alignmentScore();
    expect(s.sampleSize).toBeGreaterThan(0);
    expect(s.assessable).toBe(true);
  });

  it('REGRESSION: a populated journal with string confidence is not graded F', () => {
    fs.writeFileSync(
      path.join(dir, 'decision-journal.jsonl'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: SESSION,
        decision: 'legacy poisoned decision',
        principle: 'Structure > Willpower',
        confidence: 'high',
      }) + '\n',
    );

    const s = detector.alignmentScore();

    expect(s.sampleSize).toBe(1);
    expect(s.assessable).toBe(false);
    expect(s.grade).toBe('N/A');
    expect(s.grade).not.toBe('F');
    expect(s.score).toBe(0);
    expect(Number.isFinite(s.score)).toBe(true);
    expect(s.components.confidenceLevel).toBe(0);
    expect(Number.isFinite(s.components.confidenceLevel)).toBe(true);
    expect(s.summary).toMatch(/invalid confidence/i);
    expect(JSON.stringify(s)).not.toContain('null');
  });

  it('legacy numeric strings retain their unambiguous numeric meaning', () => {
    fs.writeFileSync(
      path.join(dir, 'decision-journal.jsonl'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        sessionId: SESSION,
        decision: 'legacy numeric confidence',
        principle: 'Structure > Willpower',
        confidence: '0.8',
      }) + '\n',
    );

    const s = detector.alignmentScore();

    expect(s.assessable).toBe(true);
    expect(s.components.confidenceLevel).toBe(80);
    expect(s.grade).not.toBe('N/A');
  });

  it('components are zero on the empty case, and the caller is told not to read them', () => {
    const s = detector.alignmentScore();

    // The components ARE all zero — that is not itself the bug. The bug was
    // presenting them as measurements. `assessable:false` is what marks them
    // as placeholders.
    expect(s.components.conflictFreedom).toBe(0);
    expect(s.components.journalHealth).toBe(0);
    expect(s.assessable).toBe(false);
  });
});
