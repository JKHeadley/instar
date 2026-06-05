/**
 * Tier-1 tests for ApprovalLedger (Approval-as-Data, spec Part B): signed,
 * append-only approval log + per-class agreement ratios.
 *
 * Covers BOTH sides of every decision boundary: record/read/verify, tamper-reject,
 * the consistency guards (each throw path AND its passing counterpart), ratio +
 * streak math (reset on change/reject), auto-eligibility threshold edges, the
 * generalized surfaces (spec WITH spec-fields, chat WITHOUT them), and corrections.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ApprovalLedger, canonicalApprovalRow, DEFAULT_ELIGIBILITY,
  type ApprovalRecordInput,
} from '../../src/core/ApprovalLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const sign = (c: string) => `sig::${c}`;
const verifySig = (c: string, s: string) => s === `sig::${c}`;

function asIs(over: Partial<ApprovalRecordInput> = {}): ApprovalRecordInput {
  return {
    subject: 'coordination-mandate', decisionClass: 'governance-safety', surface: 'chat',
    approver: 'justin', mode: 'approved-as-is', ...over,
  };
}
function withChange(over: Partial<ApprovalRecordInput> = {}): ApprovalRecordInput {
  return {
    subject: 's', decisionClass: 'governance-safety', surface: 'chat', approver: 'justin',
    mode: 'approved-with-change',
    divergences: [{ category: 'scope-correction', summary: 'broaden scope', why: 'covers chat too' }],
    ...over,
  };
}

describe('ApprovalLedger (Approval-as-Data Part B)', () => {
  let dir: string;
  let ledger: ApprovalLedger;
  let n: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-ledger-'));
    n = 0;
    ledger = new ApprovalLedger({ filePath: path.join(dir, 'approval-ledger.jsonl'), sign, verifySig, now: () => 1_700_000_000_000 + (n++) });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ApprovalLedger.test.ts' }));

  it('records a signed approved-as-is row that reads back + verifies', () => {
    const row = ledger.recordApproval(asIs());
    expect(row.mode).toBe('approved-as-is');
    expect(row.divergences).toEqual([]);
    expect(ledger.all()).toHaveLength(1);
    expect(ledger.verify(row)).toBe(true);
  });

  it('append-only: history preserved across records', () => {
    ledger.recordApproval(asIs());
    ledger.recordApproval(withChange());
    expect(ledger.all().map((r) => r.mode)).toEqual(['approved-as-is', 'approved-with-change']);
  });

  it('tamper-reject: mutating a recorded field invalidates the signature', () => {
    const row = ledger.recordApproval(asIs());
    expect(ledger.verify(row)).toBe(true);
    const tampered = { ...row, mode: 'approved-with-change' as const };
    expect(ledger.verify(tampered)).toBe(false);
  });

  // ── Consistency guards: each throw AND its passing counterpart ──

  it('throws when approved-as-is carries divergences; passes when empty', () => {
    expect(() => ledger.recordApproval(asIs({ divergences: [{ category: 'style', summary: 'x', why: 'y' }] })))
      .toThrow(/approved-as-is rows must have no divergences/);
    expect(() => ledger.recordApproval(asIs())).not.toThrow();
  });

  it('throws when a change/reject has no divergence; passes with one', () => {
    expect(() => ledger.recordApproval(withChange({ divergences: [] })))
      .toThrow(/requires at least one divergence/);
    expect(() => ledger.recordApproval(withChange())).not.toThrow();
    expect(() => ledger.recordApproval({ ...withChange(), mode: 'rejected', divergences: [] }))
      .toThrow(/requires at least one divergence/);
  });

  it('throws on unknown surface; passes on a known one', () => {
    expect(() => ledger.recordApproval(asIs({ surface: 'email' as never }))).toThrow(/unknown surface/);
    expect(() => ledger.recordApproval(asIs({ surface: 'spec' }))).not.toThrow();
  });

  it('throws on unknown divergence category and on empty summary/why', () => {
    expect(() => ledger.recordApproval(withChange({ divergences: [{ category: 'bogus' as never, summary: 's', why: 'w' }] })))
      .toThrow(/unknown divergence category/);
    expect(() => ledger.recordApproval(withChange({ divergences: [{ category: 'style', summary: ' ', why: 'w' }] })))
      .toThrow(/non-empty summary AND why/);
    expect(() => ledger.recordApproval(withChange({ divergences: [{ category: 'style', summary: 's', why: '' }] })))
      .toThrow(/non-empty summary AND why/);
  });

  // ── Ratio + streak math ──

  it('ratio = approvedAsIs / total per class', () => {
    ledger.recordApproval(asIs());
    ledger.recordApproval(asIs());
    ledger.recordApproval(withChange());
    const s = ledger.summaryForClass('governance-safety');
    expect(s.total).toBe(3);
    expect(s.approvedAsIs).toBe(2);
    expect(s.approvedWithChange).toBe(1);
    expect(s.ratio).toBeCloseTo(2 / 3);
  });

  it('streak counts TRAILING consecutive approved-as-is and resets on a change/reject', () => {
    ledger.recordApproval(asIs());
    ledger.recordApproval(asIs());
    expect(ledger.summaryForClass('governance-safety').streak).toBe(2);
    ledger.recordApproval(withChange());          // resets
    expect(ledger.summaryForClass('governance-safety').streak).toBe(0);
    ledger.recordApproval(asIs());
    expect(ledger.summaryForClass('governance-safety').streak).toBe(1);
  });

  it('autoApprovalEligible holds only when ratio + streak + total ALL clear the policy', () => {
    const policy = { minRatio: 0.9, minStreak: 3, minTotal: 3 };
    // 2 as-is: total<minTotal AND streak<minStreak → not eligible
    ledger.recordApproval(asIs());
    ledger.recordApproval(asIs());
    expect(ledger.summaryForClass('governance-safety', policy).autoApprovalEligible).toBe(false);
    // 3rd as-is: total=3, streak=3, ratio=1 → eligible
    ledger.recordApproval(asIs());
    expect(ledger.summaryForClass('governance-safety', policy).autoApprovalEligible).toBe(true);
    // a with-change drops streak to 0 → not eligible even though total grows
    ledger.recordApproval(withChange());
    expect(ledger.summaryForClass('governance-safety', policy).autoApprovalEligible).toBe(false);
  });

  it('aggregates divergence-category counts per class', () => {
    ledger.recordApproval(withChange({ divergences: [{ category: 'scope-correction', summary: 'a', why: 'b' }] }));
    ledger.recordApproval(withChange({ divergences: [
      { category: 'scope-correction', summary: 'c', why: 'd' },
      { category: 'risk-reduction', summary: 'e', why: 'f' },
    ] }));
    const s = ledger.summaryForClass('governance-safety');
    expect(s.divergenceCounts['scope-correction']).toBe(2);
    expect(s.divergenceCounts['risk-reduction']).toBe(1);
    expect(s.divergenceCounts['style']).toBe(0);
  });

  it('summaryForClass returns a zeroed summary for an unknown class', () => {
    const s = ledger.summaryForClass('does-not-exist');
    expect(s).toMatchObject({ total: 0, approvedAsIs: 0, ratio: 0, streak: 0, autoApprovalEligible: false });
  });

  it('summarize buckets multiple classes, highest-total first', () => {
    ledger.recordApproval(asIs({ decisionClass: 'design-decision' }));
    ledger.recordApproval(asIs({ decisionClass: 'design-decision' }));
    ledger.recordApproval(asIs({ decisionClass: 'governance-safety' }));
    const all = ledger.summarize();
    expect(all.map((s) => s.decisionClass)).toEqual(['design-decision', 'governance-safety']);
  });

  // ── Generalized surfaces (operator extension) ──

  it('records a spec approval WITH spec-fields and a chat approval WITHOUT them', () => {
    const specRow = ledger.recordApproval(asIs({
      subject: 'feedback-factory-migration', decisionClass: 'governance-safety', surface: 'spec',
      reviewIterations: 2, commitSha: 'abc123', evidenceRef: 'docs/specs/x.md',
    }));
    const chatRow = ledger.recordApproval(asIs({ subject: 'mandate-aab', surface: 'chat' }));
    expect(specRow.commitSha).toBe('abc123');
    expect(chatRow.commitSha).toBeUndefined();
    expect(ledger.verify(specRow)).toBe(true);
    expect(ledger.verify(chatRow)).toBe(true);
  });

  it('canonical row distinguishes present vs absent optional fields (no signature ambiguity)', () => {
    const withSha = canonicalApprovalRow({
      subject: 's', decisionClass: 'c', surface: 'spec', decidedAt: 't', approver: 'justin',
      mode: 'approved-as-is', divergences: [], commitSha: 'abc',
    });
    const withoutSha = canonicalApprovalRow({
      subject: 's', decisionClass: 'c', surface: 'spec', decidedAt: 't', approver: 'justin',
      mode: 'approved-as-is', divergences: [],
    });
    expect(withSha).not.toBe(withoutSha);
  });

  it('records a correction row (operator dispute) that reads back + verifies', () => {
    const orig = ledger.recordApproval(asIs({ subject: 'x' }));
    const correction = ledger.recordApproval(withChange({
      subject: 'x', corrects: `x@${orig.decidedAt}`,
    }));
    expect(correction.corrects).toBe(`x@${orig.decidedAt}`);
    expect(ledger.verify(correction)).toBe(true);
    // append-only: both rows present.
    expect(ledger.all()).toHaveLength(2);
  });

  it('tolerates a torn trailing line in the ledger file', () => {
    ledger.recordApproval(asIs());
    fs.appendFileSync(path.join(dir, 'approval-ledger.jsonl'), '{ "subject": "torn');
    expect(ledger.all()).toHaveLength(1);
  });

  it('DEFAULT_ELIGIBILITY is the documented 0.9 / 5 / 5', () => {
    expect(DEFAULT_ELIGIBILITY).toEqual({ minRatio: 0.9, minStreak: 5, minTotal: 5 });
  });
});
