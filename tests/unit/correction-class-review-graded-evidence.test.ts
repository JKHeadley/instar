/**
 * Correction class review writes graded evidence (CMT-2086,
 * docs/specs/correction-class-review-graded-evidence.md): a fill is a fired row,
 * a failed model call an error row, and an outcome a person gives a proposal is
 * the grade the ladder's quality bar reads. The reviewer never grades itself.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClassReviewStore, CLASS_REVIEW_FEATURE_ID, gradeForOutcome, proposalGradeId } from '../../src/monitoring/ClassReviewStore.js';
import { CorrectionClassReview } from '../../src/monitoring/CorrectionClassReview.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { FeatureEvidenceLog, setFeatureEvidenceLog, type FeatureEvidenceRow } from '../../src/monitoring/FeatureEvidenceLog.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { readJsonlQueries } from '../../src/monitoring/LadderEvidenceReader.js';

let dir: string;
let log: FeatureEvidenceLog;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccr-evidence-'));
  log = new FeatureEvidenceLog({ projectDir: dir, machine: 'm1', instarVersion: 'test' });
  setFeatureEvidenceLog(log);
});
afterEach(() => {
  setFeatureEvidenceLog(null);
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/correction-class-review-graded-evidence.test.ts' });
});
const rows = (): FeatureEvidenceRow[] => fs.existsSync(log.filePath)
  ? fs.readFileSync(log.filePath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];

const SECRET_SUMMARY = 'The migration fix handled one consumer but missed the validator XYZZY';
function correction(ledger: CorrectionLedger, summary = SECRET_SUMMARY) {
  return ledger.record({ kind: 'infra-gap', learning: summary, scrubbedSummary: summary, deterministicWeight: 3, llmConfidence: 1, topicId: 1 })!;
}
const judgment = (standard: string, process: string) => JSON.stringify({
  standardReview: { verdict: standard, ...(standard === 'needs-upgrade' ? { standardRef: 'Close the Loop', proposedDelta: 'cover the whole class' } : {}), isPolicyRelaxation: false },
  processReview: { verdict: process, ...(process === 'process-gap' ? { proposedDelta: 'add a structural ratchet' } : {}) },
  rationale: 'bounded rationale', confidence: 'high',
});

async function filledProposal(summary = SECRET_SUMMARY): Promise<{ store: ClassReviewStore; key: string }> {
  const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'm1' });
  const store = new ClassReviewStore({ dbPath: ':memory:', machineId: 'm1' });
  const engine = new CorrectionClassReview({ store, dryRun: false,
    intelligence: { evaluate: vi.fn().mockResolvedValue(judgment('needs-upgrade', 'process-gap')) } as any });
  const rec = correction(ledger, summary);
  engine.record(rec, 'operator-attributed');
  await vi.waitFor(() => expect(store.get(rec.dedupeKey)?.fillState).toBe('filled'));
  return { store, key: rec.dedupeKey };
}

describe('gradeForOutcome: only a decision on the review\'s own proposal grades it', () => {
  it('a decision grades (ratified/shipped right, rejected wrong) whatever came before, repeats included; deferral and expiry do not', () => {
    expect(gradeForOutcome('shipped')).toBe('right');
    expect(gradeForOutcome('ratified')).toBe('right');
    expect(gradeForOutcome('rejected')).toBe('wrong');
    for (const next of ['deferred', 'expired-unreviewed', 'no-action', 'proposed'] as const) expect(gradeForOutcome(next)).toBeNull();
  });
});

describe('the review records fired and error evidence', () => {
  it('a fill writes one fired row with the verdicts and none of the correction text', async () => {
    await filledProposal();
    const fired = rows().filter((r) => r.kind === 'fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ featureId: CLASS_REVIEW_FEATURE_ID, context: { standardVerdict: 'needs-upgrade', processVerdict: 'process-gap', confidence: 'high' } });
    expect(JSON.stringify(rows())).not.toContain('XYZZY');
  });

  it('a model reply that cannot be read writes one error row; a dry run writes nothing', async () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'm1' });
    const store = new ClassReviewStore({ dbPath: ':memory:', machineId: 'm1' });
    const engine = new CorrectionClassReview({ store, dryRun: false, intelligence: { evaluate: vi.fn().mockResolvedValue('not json') } as any });
    const rec = correction(ledger);
    engine.record(rec, 'operator-attributed');
    await vi.waitFor(() => expect(rows().filter((r) => r.kind === 'error')).toHaveLength(1));
    expect(rows().find((r) => r.kind === 'error')).toMatchObject({ featureId: CLASS_REVIEW_FEATURE_ID, reason: 'invalid-structured-output', context: { attemptCount: 1 } });

    const before = rows().length;
    const dry = new CorrectionClassReview({ store: new ClassReviewStore({ dbPath: ':memory:', machineId: 'm1' }), dryRun: true,
      intelligence: { evaluate: vi.fn().mockResolvedValue(judgment('needs-upgrade', 'process-gap')) } as any });
    dry.record(correction(ledger, 'another correction'), 'operator-attributed');
    await new Promise((r) => setTimeout(r, 20));
    expect(rows().length).toBe(before);
  });
});

describe('a decision on a proposal writes the grade', () => {
  it('ratified is right and rejected is wrong, each keyed to its proposal, graded by who decided', async () => {
    const { store, key } = await filledProposal();
    store.transitionOutcome(key, 'standard', 'ratified', 'operator-outcome');
    store.transitionOutcome(key, 'process', 'rejected', 'operator-outcome');
    const out = rows().filter((r) => r.kind === 'outcome');
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.outcome === 'right')).toMatchObject({ gradesEventId: proposalGradeId(key, 'standard'), gradedBy: 'operator-outcome' });
    expect(out.find((r) => r.outcome === 'wrong')).toMatchObject({ gradesEventId: proposalGradeId(key, 'process'), gradedBy: 'operator-outcome' });
    // The id is a fixed-length digest of the whole key, never a cut of it, and the arms differ.
    expect(proposalGradeId(key, 'standard').length).toBeLessThanOrEqual(64);
    expect(proposalGradeId(key, 'standard')).not.toBe(proposalGradeId(key, 'process'));
    expect(proposalGradeId('x'.repeat(200) + 'a', 'standard')).not.toBe(proposalGradeId('x'.repeat(200) + 'b', 'standard'));
  });

  it('a transition with no grader grades nothing, so only the PIN route can grade', async () => {
    const { store, key } = await filledProposal();
    store.transitionOutcome(key, 'process', 'shipped', null);
    store.transitionOutcome(key, 'standard', 'rejected', null);
    expect(rows().filter((r) => r.kind === 'outcome')).toHaveLength(0);
  });

  it('the latest decision stands: rejected, rejected again, deferred, then ratified is one id whose last row is right', async () => {
    const { store, key } = await filledProposal();
    store.transitionOutcome(key, 'standard', 'rejected', 'operator-outcome');
    store.transitionOutcome(key, 'standard', 'rejected', 'operator-outcome');
    store.transitionOutcome(key, 'standard', 'deferred', 'operator-outcome');
    store.transitionOutcome(key, 'standard', 'ratified', 'operator-outcome');
    const out = rows().filter((r) => r.kind === 'outcome');
    expect(out.map((r) => r.outcome)).toEqual(['wrong', 'wrong', 'right']);
    expect(new Set(out.map((r) => r.gradesEventId)).size).toBe(1);
  });

  it('the agent shipping first cannot shape the grade: the operator confirming is right, rejecting is wrong', async () => {
    const a = await filledProposal();
    a.store.transitionOutcome(a.key, 'process', 'shipped', null);
    a.store.transitionOutcome(a.key, 'process', 'shipped', 'operator-outcome');
    const b = await filledProposal('A different correction about the release checklist XYZZY');
    expect(b.key).not.toBe(a.key);
    b.store.transitionOutcome(b.key, 'process', 'shipped', null);
    b.store.transitionOutcome(b.key, 'process', 'rejected', 'operator-outcome');
    const out = rows().filter((r) => r.kind === 'outcome');
    expect(out.find((r) => r.gradesEventId === proposalGradeId(a.key, 'process'))?.outcome).toBe('right');
    expect(out.find((r) => r.gradesEventId === proposalGradeId(b.key, 'process'))?.outcome).toBe('wrong');
  });

  it('the grade is written before the record change event, so a failing listener cannot drop it', async () => {
    const { store, key } = await filledProposal();
    (store as any).emit = () => { throw new Error('listener down'); };
    expect(() => store.transitionOutcome(key, 'standard', 'ratified', 'operator-outcome')).toThrow();
    expect(rows().filter((r) => r.kind === 'outcome')).toHaveLength(1);
  });

  it('an arm that was never a proposal is never graded, even through deferral', async () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'm1' });
    const store = new ClassReviewStore({ dbPath: ':memory:', machineId: 'm1' });
    const engine = new CorrectionClassReview({ store, dryRun: false, intelligence: { evaluate: vi.fn().mockResolvedValue(judgment('needs-upgrade', 'not-applicable')) } as any });
    const rec = correction(ledger);
    engine.record(rec, 'operator-attributed');
    await vi.waitFor(() => expect(store.get(rec.dedupeKey)?.fillState).toBe('filled'));
    store.transitionOutcome(rec.dedupeKey, 'process', 'deferred', 'operator-outcome');
    store.transitionOutcome(rec.dedupeKey, 'process', 'ratified', 'operator-outcome');
    expect(rows().filter((r) => r.kind === 'outcome')).toHaveLength(0);
  });

  it('a failure after the judgment is stored still leaves the fired row, and is labelled after-fill', async () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'm1' });
    const store = new ClassReviewStore({ dbPath: ':memory:', machineId: 'm1' });
    const engine = new CorrectionClassReview({ store, dryRun: false,
      intelligence: { evaluate: vi.fn().mockResolvedValue(judgment('needs-upgrade', 'process-gap')) } as any,
      // Throws on every event after the shell (the retry's audit included); the shell's own
      // synchronous audit reaching the caller is the existing contract.
      audit: (e) => { if (e.event !== 'shell-created') throw new Error('audit sink down'); } });
    engine.record(correction(ledger), 'operator-attributed');
    await vi.waitFor(() => expect(rows().some((r) => r.kind === 'error')).toBe(true));
    expect(rows().filter((r) => r.kind === 'fired')).toHaveLength(1);
    expect(rows().find((r) => r.kind === 'error')).toMatchObject({ reason: 'post-fill-error', context: { stage: 'after-fill' } });
  });

  it('deferral, expiry and an unknown review write no grade', async () => {
    const { store, key } = await filledProposal();
    store.transitionOutcome(key, 'standard', 'expired-unreviewed', 'operator-outcome');
    store.transitionOutcome('no-such-review', 'standard', 'rejected', 'operator-outcome');
    expect(rows().filter((r) => r.kind === 'outcome')).toHaveLength(0);
  });

  it('an arm closed as no-action at fill time is never graded', async () => {
    const ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 'm1' });
    const store = new ClassReviewStore({ dbPath: ':memory:', machineId: 'm1' });
    const engine = new CorrectionClassReview({ store, dryRun: false, intelligence: { evaluate: vi.fn().mockResolvedValue(judgment('not-applicable', 'not-applicable')) } as any });
    const rec = correction(ledger);
    engine.record(rec, 'operator-attributed');
    await vi.waitFor(() => expect(store.get(rec.dedupeKey)?.fillState).toBe('filled'));
    store.transitionOutcome(rec.dedupeKey, 'standard', 'rejected', 'operator-outcome');
    expect(rows().filter((r) => r.kind === 'outcome')).toHaveLength(0);
  });
});

describe('the shipped ladder metric reads the grades as intended', () => {
  const ladder = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/data/feature-ladders.json'), 'utf-8'));
  const entry = (ladder.features ?? ladder.entries ?? ladder).find?.((f: any) => f.id === CLASS_REVIEW_FEATURE_ID)
    ?? Object.values(ladder).flat().find((f: any) => f && f.id === CLASS_REVIEW_FEATURE_ID);
  const metric = entry.rungs.fleet.metrics.find((m: any) => m.id === 'graded-wrong');
  const read = async () => (await readJsonlQueries(dir, [{ key: 'gw', ref: metric.ref, sinceMs: Date.now() - 30 * 86_400_000, direction: 'at-most' }], Date.now())).get('gw')!;

  it('five proposals, one changed from rejected to ratified: five samples, none wrong; reversing it makes one wrong', async () => {
    const reviews = [] as Array<{ store: ClassReviewStore; key: string }>;
    for (let i = 0; i < 5; i++) reviews.push(await filledProposal(`Correction number ${i} about a different gap XYZZY`));
    for (const r of reviews.slice(1)) r.store.transitionOutcome(r.key, 'standard', 'ratified', 'operator-outcome');
    const changed = reviews[0];
    changed.store.transitionOutcome(changed.key, 'standard', 'rejected', 'operator-outcome');
    changed.store.transitionOutcome(changed.key, 'standard', 'ratified', 'operator-outcome');
    let r = await read();
    expect(r.samples).toBe(5);
    expect(r.value).toBe(0);
    changed.store.transitionOutcome(changed.key, 'standard', 'rejected', 'operator-outcome');
    r = await read();
    expect(r.samples).toBe(5);
    expect(r.value).toBeCloseTo(1 / 5);
    // Over the ladder's 10% ceiling: the bar fails.
    expect(r.value!).toBeGreaterThan(metric.threshold);
  });

  it('a row outside the metric sharing a grade id cannot erase an operator grade', async () => {
    const reviews = [] as Array<{ store: ClassReviewStore; key: string }>;
    for (let i = 0; i < 5; i++) reviews.push(await filledProposal(`Erase-test correction ${i} XYZZY`));
    reviews[0].store.transitionOutcome(reviews[0].key, 'standard', 'rejected', 'operator-outcome');
    for (const r of reviews.slice(1)) r.store.transitionOutcome(r.key, 'standard', 'ratified', 'operator-outcome');
    expect((await read()).value).toBeCloseTo(1 / 5);
    // A later row under the same id from another feature, kind and grader (what the open route accepts).
    log.record('monitoring.somethingElse', { kind: 'fired', gradedBy: 'agent', gradesEventId: proposalGradeId(reviews[0].key, 'standard'), reason: 'erase attempt' });
    const r = await read();
    expect(r.samples).toBe(5);
    expect(r.value).toBeCloseTo(1 / 5);
  });

  it('an ungraded or non-operator row never reaches the bar', async () => {
    const { store, key } = await filledProposal();
    store.transitionOutcome(key, 'standard', 'rejected', null);
    log.record(CLASS_REVIEW_FEATURE_ID, { kind: 'outcome', outcome: 'wrong', gradedBy: 'someone-else', gradesEventId: 'class-review:forged', reason: 'forged' });
    const r = await read();
    expect(r.samples).toBe(0);
  });
});

