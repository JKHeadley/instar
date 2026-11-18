// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  B26_DESIGN_APPROVAL_RULE, DesignRunsPeerCache, FingerprintCache, buildDesignApprovalEvidence,
  normaliseForLineMatch, referencesIn, renderDesignApprovalSection,
} from '../../src/core/designApprovalEvidence.js';
import { SPEC_DESIGN_APPROVAL_REQUEST } from '../../src/core/approvalRequestDefinition.js';
import { B25_SPEC_APPROVAL_RULE, judgeSpecApprovalAsk } from '../../src/core/specConstitutionCheckLedger.js';
import { deriveDesignReview, designFingerprint, designReviewReference, renderProvenanceLine } from '../../src/core/designReviewRecord.js';
import type { DesignReviewRun } from '../../src/core/designReviewLedger.js';
import { MessagingToneGate, VALID_RULES, RULE_CLASSES, RULE_DISPOSITIONS, ADVISORY_MIGRATION_EXEMPT_RULES, resolveRuleDisposition } from '../../src/core/MessagingToneGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/designApprovalEvidence.test.ts' }); });

let n = 0;
function setup(text = '# The export plan\n\nShip it.\n') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'b26-evidence-')));
  dirs.push(dir);
  const file = path.join(dir, 'plan.md');
  fs.writeFileSync(file, text);
  const fp = designFingerprint(text);
  const run = (over: Partial<DesignReviewRun> = {}): DesignReviewRun => ({
    v: 1, runId: (n++).toString(16).padStart(32, '0'), machineId: 'local', recordedAt: new Date(Date.UTC(2026, 10, 17, 12, n)).toISOString(),
    path: file, fingerprint: fp, title: 'The export plan', sessionId: 's', account: null,
    passes: [{ family: 'claude', door: 'claude-code', attempts: [{ askedModel: 'claude-fable-5-2', outcome: 'ok' }], model: 'claude-fable-5-2', modelBasis: 'requested', status: 'ok', verdict: 'CLEAN' }],
    ...over,
  });
  return { dir, file, fp, run };
}
const lineFor = (runs: DesignReviewRun[], fp: string, ref: string) => renderProvenanceLine(deriveDesignReview(runs, fp, ['claude-fable-5-2']), ref);

describe('reference scan and line match', () => {
  it('finds each distinct reference in the fixed form only', () => {
    expect(referencesIn('a (Review record 0123456789ab) b (Review record 0123456789ab) (Review record zz)')).toEqual(['0123456789ab']);
    expect(referencesIn('no reference here')).toEqual([]);
  });
  it('ignores whitespace and emphasis marks', () => {
    expect(normaliseForLineMatch('**Reviewed  1 time.**\n_On this_ `version`')).toBe('Reviewed 1 time. On this version');
  });
});

describe('buildDesignApprovalEvidence', () => {
  it('reviewed with the line present (through Telegram-style emphasis) clears; a stale line does not', async () => {
    const { file, fp, run } = setup();
    const r1 = run();
    const ref = designReviewReference('local', file, fp);
    const line = lineFor([r1], fp, ref);
    const text = `Please approve the export plan.\n\n*${line.replace('Reviewed 1 time.', 'Reviewed  1 time.')}*`;
    const [e] = await buildDesignApprovalEvidence({ text, runs: () => [r1], selfMachineId: 'local', fingerprints: new FingerprintCache() });
    expect(e).toMatchObject({ reference: ref, outcome: 'reviewed', linePresent: true, title: 'The export plan', recheckedHere: true, timesReviewed: 1 });
    const [stale] = await buildDesignApprovalEvidence({ text, runs: () => [r1, run()], selfMachineId: 'local', fingerprints: new FingerprintCache() });
    expect(stale.linePresent).toBe(false); // the record now says "Reviewed 2 times"
  });

  it('a typed or borrowed reference is unknown; an unreadable ledger is records-unavailable', async () => {
    const { run } = setup();
    const text = 'Approve it? (Review record abcdefabcdef)';
    expect((await buildDesignApprovalEvidence({ text, runs: () => [run()], selfMachineId: 'local', fingerprints: new FingerprintCache() }))[0].outcome).toBe('unknown-reference');
    expect((await buildDesignApprovalEvidence({ text, runs: () => undefined, selfMachineId: 'local', fingerprints: new FingerprintCache() }))[0].outcome).toBe('records-unavailable');
    expect(await buildDesignApprovalEvidence({ text: 'Approve it?', runs: () => [run()], selfMachineId: 'local', fingerprints: new FingerprintCache() })).toEqual([]);
  });

  it('an edited, moved or deleted file reads changed-since-review', async () => {
    const { file, fp, run } = setup();
    const r1 = run();
    const ref = designReviewReference('local', file, fp);
    const text = `Approve? ${lineFor([r1], fp, ref)}`;
    fs.appendFileSync(file, 'an edit\n');
    expect((await buildDesignApprovalEvidence({ text, runs: () => [r1], selfMachineId: 'local', fingerprints: new FingerprintCache() }))[0].outcome).toBe('changed-since-review');
    SafeFsExecutor.safeRmSync(file, { force: true, operation: 'tests/unit/designApprovalEvidence.test.ts' });
    expect((await buildDesignApprovalEvidence({ text, runs: () => [r1], selfMachineId: 'local', fingerprints: new FingerprintCache() }))[0].outcome).toBe('changed-since-review');
  });

  it('a peer row is never opened here and says so', async () => {
    const { file, fp, run } = setup();
    const peer = run({ machineId: 'm_peer', path: '/nowhere/on/this/machine.md' });
    const ref = designReviewReference('m_peer', '/nowhere/on/this/machine.md', fp);
    const cache = new FingerprintCache();
    const spy = vi.spyOn(cache, 'fingerprint');
    const text = `Approve? ${lineFor([peer], fp, ref)}`;
    const [e] = await buildDesignApprovalEvidence({ text, runs: () => [peer], selfMachineId: 'local', fingerprints: cache });
    expect(e).toMatchObject({ outcome: 'reviewed', linePresent: true, recheckedHere: false });
    expect(spy).not.toHaveBeenCalled();
    void file;
  });
});

describe('DesignRunsPeerCache', () => {
  it('never waits, merges as a union, cleans rows and ignores peers claiming this machine', async () => {
    const { run } = setup();
    const local = [run()];
    const peerGood = { ...run({ machineId: 'm_peer' }) };
    const fetchPeers = vi.fn(async () => [{ machineId: 'm_peer', rows: [peerGood, { ...run({ machineId: 'local' }) }, { ...run({ machineId: 'm_other' }) }, { runId: 'bad' }] }]);
    const cache = new DesignRunsPeerCache(fetchPeers, () => 'local', 60_000);
    expect(cache.get(local)).toHaveLength(1);
    await cache.refresh();
    const merged = cache.get(local);
    // Only the serving peer's own rows: a row naming this machine or a third machine is not taken.
    expect(merged.map((r) => r.machineId).sort()).toEqual(['local', 'm_peer']);
  });

  it('with an empty local ledger, a peer row claiming this machine is still never taken or opened', async () => {
    const { run } = setup();
    const forged = { ...run({ machineId: 'local', path: '/etc/hosts' }) };
    const cache = new DesignRunsPeerCache(async () => [{ machineId: 'm_peer', rows: [forged] }, { machineId: 'local', rows: [forged] }], () => 'local', 60_000);
    await cache.refresh();
    expect(cache.get([])).toEqual([]);
  });

  it('an evidence fault reaches the judge as records-unavailable, never as no reference', async () => {
    const e = await buildDesignApprovalEvidence({ text: 'Approve? (Review record abcdefabcdef)', runs: () => { throw new Error('boom'); }, selfMachineId: 'local', fingerprints: new FingerprintCache() });
    expect(e).toEqual([{ reference: 'abcdefabcdef', outcome: 'records-unavailable' }]);
  });

  it('the ledger is not read at all when the text carries no reference', async () => {
    const runs = vi.fn(() => []);
    expect(await buildDesignApprovalEvidence({ text: 'Morning, all green.', runs, selfMachineId: 'local', fingerprints: new FingerprintCache() })).toEqual([]);
    expect(runs).not.toHaveBeenCalled();
  });
});

describe('B26 rule and gate registration', () => {
  it('shares the approval-request definition with B25, which is unchanged in substance', () => {
    expect(B25_SPEC_APPROVAL_RULE).toContain(SPEC_DESIGN_APPROVAL_REQUEST);
    expect(B26_DESIGN_APPROVAL_RULE).toContain(SPEC_DESIGN_APPROVAL_REQUEST);
    expect(B26_DESIGN_APPROVAL_RULE).toContain('UNDER-FIRE BIAS');
    expect(B26_DESIGN_APPROVAL_RULE).toContain('WHATEVER the line says');
  });

  it('is registered, signal-driven, blocking, and exempt from the advisory migration', () => {
    expect(VALID_RULES.has('B26_DESIGN_APPROVAL_UNREVIEWED')).toBe(true);
    expect(RULE_CLASSES.B26_DESIGN_APPROVAL_UNREVIEWED).toBe('signal-driven');
    expect(RULE_DISPOSITIONS.B26_DESIGN_APPROVAL_UNREVIEWED).toBe('blocking');
    expect(ADVISORY_MIGRATION_EXEMPT_RULES.has('B26_DESIGN_APPROVAL_UNREVIEWED')).toBe(true);
    expect(resolveRuleDisposition('B26_DESIGN_APPROVAL_UNREVIEWED', true)).toBe('blocking');
  });

  const capture = (response: Record<string, unknown> = { pass: true, rule: '', issue: '', suggestion: '' }) => {
    const prompts: string[] = [];
    const provider: IntelligenceProvider = { evaluate: vi.fn(async (p: string) => { prompts.push(p); return JSON.stringify(response); }) };
    return { provider, last: () => prompts[prompts.length - 1] ?? '' };
  };

  it('is rendered with its evidence only when evidence is supplied (the standard is on), never for health alerts', async () => {
    const { provider, last } = capture();
    const gate = new MessagingToneGate(provider);
    await gate.review('Morning, nothing needs you.', { channel: 'telegram', specConstitutionChecks: [] });
    expect(last()).not.toContain('B26_DESIGN_APPROVAL_UNREVIEWED');
    await gate.review('Approve the plan? (Review record abcdefabcdef)', { channel: 'telegram', specConstitutionChecks: [], designApprovalEvidence: [{ reference: 'abcdefabcdef', outcome: 'unknown-reference' }] });
    expect(last().split('B26 DESIGN APPROVAL NEEDS ITS REVIEW RECORD').length - 1).toBe(1);
    expect(last()).toContain('"outcome":"unknown-reference"');
    await gate.review('Disk nearly full.', { channel: 'telegram', messageKind: 'health-alert', designApprovalEvidence: [] });
    expect(last()).not.toContain('B26_DESIGN_APPROVAL_UNREVIEWED');
    expect(renderDesignApprovalSection([])).toContain('no review record reference');
  });

  it('a B26 verdict holds and is never an acknowledgeable nudge', async () => {
    const { provider } = capture({ pass: false, rule: 'B26_DESIGN_APPROVAL_UNREVIEWED', issue: 'asks approval of a design with no review record', suggestion: 'run /design-review' });
    const r = await new MessagingToneGate(provider).review('Approve the export plan so I can build it?', { channel: 'telegram', specConstitutionChecks: [], designApprovalEvidence: [] });
    expect(r.pass).toBe(false);
    expect(r.rule).toBe('B26_DESIGN_APPROVAL_UNREVIEWED');
    expect(r.advisory).toBeUndefined();
  });
});

describe('Work Board judge with both rules', () => {
  const judge = (reply: Record<string, unknown>) => ({ evaluate: vi.fn(async () => JSON.stringify(reply)) }) as unknown as IntelligenceProvider;
  it('one call, both rules: lists every rule that fired', async () => {
    expect(await judgeSpecApprovalAsk(judge({ fireB25: true, fireB26: true, issue: 'i', suggestion: 's' }), 'approve the plan', [], []))
      .toEqual({ hold: true, rules: ['B25_SPEC_APPROVAL_UNCHECKED', 'B26_DESIGN_APPROVAL_UNREVIEWED'], issue: 'i', suggestion: 's' });
    expect((await judgeSpecApprovalAsk(judge({ fireB25: false, fireB26: true, issue: 'i', suggestion: 's' }), 'approve the plan', [], [])).rules).toEqual(['B26_DESIGN_APPROVAL_UNREVIEWED']);
    expect(await judgeSpecApprovalAsk(judge({ fireB25: false, fireB26: false }), 'approve the plan', [], [])).toEqual({ hold: false });
  });
  it('without evidence (the standard off) it is exactly B25', async () => {
    const p = judge({ fire: true, issue: 'i', suggestion: 's' });
    expect((await judgeSpecApprovalAsk(p, 'approve the plan', [])).rules).toEqual(['B25_SPEC_APPROVAL_UNCHECKED']);
    const prompt = (p.evaluate as any).mock.calls[0][0] as string;
    expect(prompt).not.toContain('B26_DESIGN_APPROVAL_UNREVIEWED');
  });
});
