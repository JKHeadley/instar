// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  appendDesignReviewRun, cleanPeerRun, deriveDesignReview, designFingerprint, designReviewReference,
  designTitle, mapModuleReason, modelDisplayName, parseRunReport, renderProvenanceLine,
} from '../../src/core/designReviewRecord.js';
import { readDesignReviewLedger, type DesignReviewRun, type ReviewPass } from '../../src/core/designReviewLedger.js';

const FP = 'a'.repeat(64);
const known = (m: string) => /^(claude|gpt|gemini|grok)-/.test(m);
const pass = (over: Partial<ReviewPass>): ReviewPass => ({
  family: 'claude', door: 'claude-code', attempts: [{ askedModel: 'claude-fable-5-2', outcome: 'ok' }],
  model: 'claude-fable-5-2', modelBasis: 'requested', status: 'ok', verdict: 'CLEAN', ...over,
});
let seq = 0;
const run = (over: Partial<DesignReviewRun>): DesignReviewRun => ({
  v: 1, runId: (seq++).toString(16).padStart(32, '0'), machineId: 'local', recordedAt: new Date(Date.UTC(2026, 10, 17, 10, seq)).toISOString(),
  path: '/p/plan.md', fingerprint: FP, title: 'Plan', sessionId: 's', account: null, passes: [pass({})], ...over,
});
const LANES = ['claude-fable-5-2', 'gpt-6-astra', 'gemini-4-argon'];

describe('designFingerprint', () => {
  it('ignores only the post-review frontmatter keys and line endings', () => {
    const base = '---\ntitle: X\nslug: x\n---\n# X\n\nBody\n';
    const tagged = '---\ntitle: X\nslug: x\nreview-convergence: "2026"\napproved: true\napproved-by: "J"\napproval-evidence: "m"\nprovenance: "line"\n---\n# X\n\nBody\n';
    expect(designFingerprint(tagged)).toBe(designFingerprint(base));
    expect(designFingerprint(base.replace(/\n/g, '\r\n'))).toBe(designFingerprint(base));
    expect(designFingerprint(base.replace('slug: x', 'slug: y'))).not.toBe(designFingerprint(base));
    expect(designFingerprint(base.replace('Body', 'Body!'))).not.toBe(designFingerprint(base));
  });
  it('a document with no frontmatter hashes its whole text', () => {
    expect(designFingerprint('# A\n')).toMatch(/^[0-9a-f]{64}$/);
    expect(designFingerprint('# A\n')).not.toBe(designFingerprint('# B\n'));
  });
});

describe('reference, title and names', () => {
  it('reference is 12 hex and names machine, path and revision', () => {
    const r = designReviewReference('local', '/p/plan.md', FP);
    expect(r).toMatch(/^[0-9a-f]{12}$/);
    expect(designReviewReference('m2', '/p/plan.md', FP)).not.toBe(r);
    expect(designReviewReference('local', '/p/plan.md', 'b'.repeat(64))).not.toBe(r);
  });
  it('title is the first heading after frontmatter', () => {
    expect(designTitle('---\ntitle: "# no"\n---\n\n# The plan\n## Sub')).toBe('The plan');
  });
  it('display names', () => {
    expect(modelDisplayName('claude-fable-5-2')).toBe('Claude Fable 5.2');
    expect(modelDisplayName('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelDisplayName('gpt-6-astra')).toBe('GPT-6 Astra');
    expect(modelDisplayName('gemini-4-argon')).toBe('Gemini 4 Argon');
    expect(modelDisplayName('gemini-3.1-pro-preview')).toBe('Gemini 3.1 Pro Preview');
    expect(modelDisplayName('grok-4.6')).toBe('Grok 4.6');
  });
});

describe('mapModuleReason', () => {
  it('maps durable and transient reasons, and counts an unknown one', () => {
    expect(mapModuleReason('codex-not-installed')).toEqual({ reason: 'not-installed', unmapped: false });
    expect(mapModuleReason('gemini-not-authed').reason).toBe('not-signed-in');
    expect(mapModuleReason('claude-config-missing').reason).toBe('not-signed-in');
    expect(mapModuleReason('model-not-on-plan').reason).toBe('not-on-plan');
    expect(mapModuleReason('hardening-unsupported').reason).toBe('disabled');
    expect(mapModuleReason('grok-not-enabled').reason).toBe('disabled');
    expect(mapModuleReason('hardening-inconclusive').reason).toBe('call-failed');
    expect(mapModuleReason('rate-limited').reason).toBe('limit-reached');
    expect(mapModuleReason('timeout').reason).toBe('timed-out');
    expect(mapModuleReason('provider-unavailable').reason).toBe('call-failed');
    expect(mapModuleReason('brand-new-reason')).toEqual({ reason: 'call-failed', unmapped: true });
  });
});

describe('derive and render', () => {
  it('renders the spec example: written on Fable, three reviewers, three runs', () => {
    const runs = [run({}), run({}), run({
      passes: [pass({}), pass({ family: 'codex', door: 'codex-cli', attempts: [{ askedModel: 'gpt-6-astra', outcome: 'ok' }], model: 'gpt-6-astra', verdict: 'MINOR ISSUES' }),
        pass({ family: 'gemini', door: 'gemini-cli', attempts: [{ askedModel: 'gemini-4-argon', outcome: 'ok' }], model: 'gemini-4-argon' })],
      writes: [{ sessionId: 'w', at: '2026-11-17T09:00:00.000Z', model: 'claude-fable-5-2' }],
    })];
    const d = deriveDesignReview(runs, FP, LANES);
    expect(d.status).toBe('reviewed');
    expect(d.designModelTookPart).toBe(true);
    expect(d.outsideFamilyTookPart).toBe(true);
    expect(renderProvenanceLine(d, '3f9a2c1b77d0')).toBe(
      'On record as written in a session running Claude Fable 5.2. Reviewed 3 times. On this version: Claude Fable 5.2 found no issues, GPT-6 Astra found minor issues, Gemini 4 Argon found no issues. (Review record 3f9a2c1b77d0)');
  });

  it('renders the spec example: serious first, then the refused design model and its replacement', () => {
    const runs = [run({}), run({
      passes: [
        pass({ attempts: [{ askedModel: 'claude-fable-5-2', outcome: 'refused', reason: 'limit-reached' }, { askedModel: 'claude-opus-5-5', outcome: 'ok' }], model: 'claude-opus-5-5' }),
        pass({ family: 'codex', door: 'codex-cli', attempts: [{ askedModel: 'gpt-6-astra', outcome: 'ok' }], model: 'gpt-6-astra', verdict: 'SERIOUS ISSUES' }),
      ],
      writes: [{ sessionId: 'w', at: '2026-11-17T09:00:00.000Z', model: 'claude-opus-5-5' }],
    })];
    expect(renderProvenanceLine(deriveDesignReview(runs, FP, LANES), '9c41d07e52ab')).toBe(
      'GPT-6 Astra found serious issues. Claude Fable 5.2 did not review this (limit reached); Claude Opus 5.5 reviewed in its place and found no issues. On record as written in a session running Claude Opus 5.5. Reviewed 2 times. (Review record 9c41d07e52ab)');
  });

  it('single provider: says no outside model, and no write on record', () => {
    const runs = [run({ passes: [pass({}), pass({ family: 'codex', door: 'codex-cli', attempts: [], model: null, status: 'unavailable', reason: 'disabled', verdict: undefined })] })];
    const line = renderProvenanceLine(deriveDesignReview(runs, FP, LANES), 'abcdefabcdef');
    expect(line.startsWith('No model from another provider reviewed this (none enabled for this agent). No record of which model wrote this.')).toBe(true);
  });

  it('a design written and reviewed only on Codex says no other provider reviewed it', () => {
    const runs = [run({ passes: [pass({ family: 'codex', door: 'codex-cli', attempts: [{ askedModel: 'gpt-6-astra', outcome: 'ok' }], model: 'gpt-6-astra' })],
      writes: [{ sessionId: 'w', at: '2026-11-17T09:00:00.000Z', model: 'gpt-6-astra' }] })];
    const d = deriveDesignReview(runs, FP, LANES);
    expect(d.outsideFamilyTookPart).toBe(false);
    expect(renderProvenanceLine(d, 'c'.repeat(12)).startsWith('No model from another provider reviewed this.')).toBe(true);
  });

  it('an enabled reviewer that is not installed is named, a disabled one is not', () => {
    const runs = [run({ passes: [pass({}),
      pass({ family: 'codex', door: 'codex-cli', attempts: [], model: null, status: 'unavailable', reason: 'not-installed', verdict: undefined }),
      pass({ family: 'gemini', door: 'gemini-cli', attempts: [], model: null, status: 'unavailable', reason: 'disabled', verdict: undefined })] })];
    const line = renderProvenanceLine(deriveDesignReview(runs, FP, LANES), 'd'.repeat(12));
    expect(line).toContain('GPT did not review this (not installed).');
    expect(line).not.toContain('Gemini');
  });

  it('every reason durable → no-reviewer-reachable; any transient → not-reviewed', () => {
    const durable = run({ passes: [pass({ status: 'unavailable', model: null, attempts: [], reason: 'not-installed', verdict: undefined })] });
    expect(deriveDesignReview([durable], FP, LANES).status).toBe('no-reviewer-reachable');
    expect(renderProvenanceLine(deriveDesignReview([durable], FP, LANES), 'x'.repeat(12))).toContain('No reviewer could be reached (not installed).');
    const transient = run({ passes: [pass({ status: 'degraded', model: null, attempts: [], reason: 'timed-out', verdict: undefined })] });
    expect(deriveDesignReview([transient], FP, LANES).status).toBe('not-reviewed');
  });

  it('a changed file: the old fingerprint keeps its count, the new one is not reviewed', () => {
    const d = deriveDesignReview([run({})], 'b'.repeat(64), LANES);
    expect(d.status).toBe('not-reviewed');
    expect(d.timesReviewed).toBe(1);
  });

  it('writes are combined across runs and a later model fills an unattributed write', () => {
    const w = { sessionId: 'w', at: '2026-11-17T09:00:00.000Z' };
    const runs = [run({ writes: [{ ...w, model: null }] }), run({ writes: [{ ...w, model: 'claude-opus-5-5' }, { sessionId: 'v', at: '2026-11-17T09:05:00.000Z', model: null }] })];
    const d = deriveDesignReview(runs, FP, LANES);
    expect(d.writeRecord).toEqual({ models: ['claude-opus-5-5'], unattributedWrites: true, anyWrite: true });
    expect(renderProvenanceLine(d, 'r'.repeat(12))).toContain('On record as written in a session running Claude Opus 5.5, and at least one write with no model on record.');
  });
});

describe('validation, peer rows and append', () => {
  const report = { runId: 'f'.repeat(32), path: '/p/plan.md', fingerprint: FP, sessionId: 's', passes: [pass({})] };
  it('accepts a good report and refuses off-list values', () => {
    expect(parseRunReport(report, known).ok).toBe(true);
    expect(parseRunReport({ ...report, runId: 'short' }, known)).toEqual({ ok: false, error: 'runId-invalid' });
    expect(parseRunReport({ ...report, passes: [pass({ verdict: 'GREAT' as never })] }, known).ok).toBe(false);
    expect(parseRunReport({ ...report, passes: [pass({ model: 'made-up' })] }, known).ok).toBe(false);
    expect(parseRunReport({ ...report, passes: [pass({ reason: 'weird' as never })] }, known).ok).toBe(false);
  });
  it('a peer row is cleaned: bad fields drop it, long text is clamped', () => {
    expect(cleanPeerRun({ ...run({}), title: 'T'.repeat(500) }, known)?.title.length).toBe(160);
    expect(cleanPeerRun({ ...run({}), fingerprint: 'nothex' }, known)).toBeNull();
    expect(cleanPeerRun({ ...run({}), passes: [{ ...pass({}), family: 'evil' }] }, known)).toBeNull();
    expect(cleanPeerRun({ ...run({}), passes: [{ ...pass({}), door: 'codex-cli' }] }, known)).toBeNull();
    expect(cleanPeerRun({ ...run({}), path: 42 }, known)).toBeNull();
    expect(cleanPeerRun({ ...run({}), writes: [{ sessionId: 's', at: 'not a date', model: null }] }, known)?.writes).toBeUndefined();
  });
  it('append after a torn last line keeps both records readable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fdr-append-'));
    try {
      fs.writeFileSync(path.join(dir, 'design-review-runs.jsonl'), JSON.stringify(run({})) + '\n{"runId":"torn');
      appendDesignReviewRun(dir, run({}));
      const r = readDesignReviewLedger(dir);
      expect(r.runs).toHaveLength(2);
      expect(r.skipped).toBe(1);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/designReviewRecord.test.ts' });
    }
  });
});
