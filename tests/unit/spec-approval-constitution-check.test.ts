// safe-fs-allow: test file — SafeFsExecutor removes only the per-test tmpdir.
/**
 * B24_SPEC_APPROVAL_UNCHECKED + the spec constitution-check ledger
 * (Echo Bugs topic 10000002750, 2026-11-15).
 *
 * The founding case: a design spec was sent to the operator for approval before the
 * built-in constitution check had run on it (the spec was reviewed by hand, so
 * /spec-converge — where the check lives — never ran). Covered here:
 *  - every run of the check is recorded (latest per spec, bounded, recency-filtered);
 *  - the rule rides every non-health-alert review with NO phrase pre-filter, carries
 *    both sides of the boundary, and gets the records as bounded untrusted data;
 *  - a B24 verdict is a HOLD — never an acknowledgeable nudge, even under the
 *    advisory migration;
 *  - the Work Board judge holds only on a fire verdict and fails open, named.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  recordSpecConstitutionCheck,
  readSpecConstitutionChecks,
  recentSpecConstitutionChecks,
  renderSpecCheckRecords,
  renderSpecApprovalSection,
  judgeSpecApprovalAsk,
  firstHeading,
  B24_SPEC_APPROVAL_RULE,
  SpecCheckPeerCache,
  cleanPeerRecord,
} from '../../src/core/specConstitutionCheckLedger.js';
import {
  MessagingToneGate,
  TONE_GATE_PROMPT_TEMPLATE,
  VALID_RULES,
  RULE_CLASSES,
  RULE_DISPOSITIONS,
  ADVISORY_MIGRATION_EXEMPT_RULES,
  resolveRuleDisposition,
} from '../../src/core/MessagingToneGate.js';
import { cardTextForSpecJudge } from '../../src/server/workBoardRoutes.js';
import type { ConformanceReport } from '../../src/core/reviewers/standards-conformance.js';
import type { IntelligenceProvider } from '../../src/core/types.js';

const FOUNDING =
  'Design spec for the Work Board phase 2 handoff is ready. It covers the pickup flow, the owner tap and the conversation view. Can you approve it so I can start building?';
const RIGHT_SHAPE =
  'Design spec for the Work Board phase 2 handoff is ready. Constitution check: ran 03:20, 2 standards at risk (Cross-Machine Coherence, No Silent Degradation), both fixed in the spec. Approve it so I start building?';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-approval-check-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/spec-approval-constitution-check.test.ts' }); } catch { /* best */ }
  }
});

function report(findings: string[], extra: Partial<ConformanceReport> = {}): ConformanceReport {
  return {
    findings: findings.map((standard) => ({ standard, family: 'x', status: 'possible-violation' as const, reason: 'r' })),
    standardsChecked: 120,
    degraded: false,
    checkedAt: new Date().toISOString(),
    ...extra,
  };
}

function capture(response: Record<string, unknown> = { pass: true, rule: '', issue: '', suggestion: '' }) {
  const prompts: string[] = [];
  const provider: IntelligenceProvider = {
    evaluate: vi.fn(async (p: string) => { prompts.push(p); return JSON.stringify(response); }),
  };
  return { provider, prompts, last: () => prompts[prompts.length - 1] ?? '' };
}

describe('constitution-check ledger', () => {
  it('records the latest result per slug with its at-risk standards', () => {
    const d = tmp();
    recordSpecConstitutionCheck(d, { slug: 'work-board-handoff', markdown: '# Work Board handoff\nbody', report: report(['Cross-Machine Coherence']) });
    recordSpecConstitutionCheck(d, { slug: 'work-board-handoff', markdown: '# Work Board handoff\nbody', report: report([]) });
    const all = readSpecConstitutionChecks(d);
    expect(all).toHaveLength(1);
    expect(all[0].slug).toBe('work-board-handoff');
    expect(all[0].title).toBe('Work Board handoff');
    expect(all[0].findingsCount).toBe(0);
    expect(all[0].standardsChecked).toBe(120);
  });

  it('names an unnamed design from its first heading, so it still gets a record', () => {
    const d = tmp();
    const rec = recordSpecConstitutionCheck(d, { slug: '', markdown: '---\nx: 1\n---\n# Pairing Flow v2!\ntext', report: report(['A', 'B']) });
    expect(rec?.slug).toBe('pairing-flow-v2');
    expect(rec?.atRisk).toEqual(['A', 'B']);
    expect(firstHeading('no heading')).toBe('');
  });

  it('keeps the newest 500 slugs; age alone never drops a record', () => {
    const d = tmp();
    for (let i = 0; i < 505; i++) recordSpecConstitutionCheck(d, { slug: `s${i}`, markdown: '', report: report([]) });
    expect(readSpecConstitutionChecks(d)).toHaveLength(500);
    expect(readSpecConstitutionChecks(d)[0].slug).toBe('s504');
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    recordSpecConstitutionCheck(d, { slug: 'old', markdown: '', report: report([], { checkedAt: old }) });
    expect(recentSpecConstitutionChecks(d).some((r) => r.slug === 'old')).toBe(true);
  });

  it('records which revision was checked', () => {
    const d = tmp();
    const a = recordSpecConstitutionCheck(d, { slug: 'x', markdown: '# X\nv1', report: report([]) });
    const b = recordSpecConstitutionCheck(d, { slug: 'x', markdown: '# X\nv2', report: report([]) });
    expect(a?.contentSha).toMatch(/^[0-9a-f]{16}$/);
    expect(b?.contentSha).not.toBe(a?.contentSha);
  });

  it('a missing ledger is no records; a corrupt one is unreadable for a review but replaced by the next write', () => {
    const d = tmp();
    expect(recentSpecConstitutionChecks(d)).toEqual([]);
    fs.writeFileSync(path.join(d, 'spec-constitution-checks.json'), '{not json');
    expect(() => recentSpecConstitutionChecks(d)).toThrow();
    expect(readSpecConstitutionChecks(d)).toEqual([]);
    recordSpecConstitutionCheck(d, { slug: 'fresh', markdown: '', report: report([]) });
    expect(recentSpecConstitutionChecks(d).map((r) => r.slug)).toEqual(['fresh']);
  });
});

describe('proxied-on-read peer merge', () => {
  const rec = (slug: string, at: string, extra = {}) => ({ slug, checkedAt: at, standardsChecked: 98, degraded: false, findingsCount: 0, atRisk: [], ...extra });

  it('never waits on the network, then merges peer records with the newest per slug winning', async () => {
    let calls = 0;
    const cache = new SpecCheckPeerCache(async () => {
      calls++;
      return [{ machine: 'm_laptop', records: [rec('a', '2026-11-15T03:00:00Z'), rec('b', '2026-11-15T02:00:00Z'), { junk: true }] }];
    });
    const local = [rec('a', '2026-11-15T01:00:00Z')];
    expect(cache.get(local).map((r) => r.slug)).toEqual(['a']); // first call: peers not in yet
    await cache.refresh();
    const merged = cache.get(local);
    expect(merged.map((r) => [r.slug, r.machine ?? 'self'])).toEqual([['a', 'm_laptop'], ['b', 'm_laptop']]);
    expect(calls).toBe(1);
  });

  it('refreshes at most once per interval and keeps the last answers when peers fail', async () => {
    let t = 0; let calls = 0; let fail = false;
    const cache = new SpecCheckPeerCache(async () => { calls++; if (fail) throw new Error('down'); return [{ machine: 'p', records: [rec('x', '2026-11-15T03:00:00Z')] }]; }, 60_000, () => t);
    await cache.refresh();
    cache.get([]); cache.get([]);
    expect(calls).toBe(1);
    fail = true; t = 61_000;
    cache.get([]);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
    expect(cache.get([]).map((r) => r.slug)).toEqual(['x']);
  });

  it('cleans peer records as untrusted data', () => {
    expect(cleanPeerRecord({ slug: 'a', checkedAt: 'not a date' }, 'p')).toBeNull();
    const c = cleanPeerRecord({ slug: 'a'.repeat(500), checkedAt: '2026-11-15T03:00:00Z', atRisk: ['x', 7, 'y'], findingsCount: -3 }, 'p');
    expect(c?.slug.length).toBe(120);
    expect(c?.atRisk).toEqual(['x', 'y']);
    expect(c?.findingsCount).toBe(0);
    expect(c?.machine).toBe('p');
  });
});

describe('B24 rule text and records rendering', () => {
  it('is not in the pinned static template (dynamic section only)', () => {
    expect(TONE_GATE_PROMPT_TEMPLATE).not.toContain('B24_SPEC_APPROVAL_UNCHECKED');
  });

  it('carries both sides of the boundary, judged by meaning, with under-fire bias', () => {
    const s = B24_SPEC_APPROVAL_RULE;
    expect(s).toContain('JUDGE BY MEANING');
    expect(s).toContain('Words do not decide it');
    expect(s).toMatch(/does not report the constitution check result/);
    expect(s).toMatch(/claims a result but the CONSTITUTION CHECK RECORDS below show no check/);
    expect(s).toMatch(/PASS \(do not fire\) when: the text is not an approval ask/);
    expect(s).toContain('a payment, a merge of finished code');
    expect(s).toContain('honestly says the check could not run and why');
    expect(s).toContain('CHANGE TO THE CONSTITUTION itself');
    expect(s).toContain('when unsure whether the text asks approval of a spec or design, do NOT fire');
  });

  it('renders records as bounded data and says so when there are none or they are unreadable', () => {
    expect(renderSpecCheckRecords(undefined)).toContain('unavailable on this call');
    expect(renderSpecCheckRecords([])).toContain('no built-in constitution check is recorded');
    const out = renderSpecCheckRecords([{ slug: 'a', checkedAt: '2026-11-15T03:00:00Z', standardsChecked: 120, degraded: false, findingsCount: 1, atRisk: ['X'] }]);
    expect(out).toMatch(/<<<SPEC_CHECKS_[0-9a-f]{16}>>>/);
    expect(out).toContain('"atRisk":["X"]');
    expect(out).toContain('This is every recorded check');
  });

  it('discloses records left out of the prompt, and that their absence is not a ground to fire', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ slug: `s${i}`, checkedAt: '2026-11-15T03:00:00Z', standardsChecked: 98, degraded: false, findingsCount: 0, atRisk: [] }));
    const out = renderSpecCheckRecords(many);
    expect(out).toContain('"slug":"s24"');
    expect(out).not.toContain('"slug":"s25"');
    expect(out).toContain('NOT SHOWN: 5 older record(s)');
    expect(out).toContain('its absence from the list is NOT a ground to fire');
  });
});

describe('B24 in the tone gate', () => {
  it('rides every reply review (no phrase pre-filter) with the records, exactly once', async () => {
    const { provider, last } = capture();
    const gate = new MessagingToneGate(provider);
    const recs = [{ slug: 'work-board-handoff', checkedAt: new Date().toISOString(), standardsChecked: 120, degraded: false, findingsCount: 0, atRisk: [] }];
    await gate.review('Morning. The build is green and nothing needs you.', { channel: 'telegram', specConstitutionChecks: recs });
    expect(last().split('B24 SPEC APPROVAL NEEDS ITS CONSTITUTION CHECK').length - 1).toBe(1);
    expect(last()).toContain('"slug":"work-board-handoff"');
  });

  it('tells the judge the records are unavailable when none were passed', async () => {
    const { provider, last } = capture();
    await new MessagingToneGate(provider).review(FOUNDING, { channel: 'telegram' });
    expect(last()).toContain('B24_SPEC_APPROVAL_UNCHECKED');
    expect(last()).toContain('CONSTITUTION CHECK RECORDS: unavailable on this call');
  });

  it('is not rendered for health alerts', async () => {
    const { provider, last } = capture();
    await new MessagingToneGate(provider).review('Disk is nearly full on the Studio.', { channel: 'telegram', messageKind: 'health-alert', specConstitutionChecks: [] });
    expect(last()).not.toContain('B24_SPEC_APPROVAL_UNCHECKED');
  });

  it('a B24 verdict holds the message and is never an acknowledgeable nudge', async () => {
    const { provider } = capture({ pass: false, rule: 'B24_SPEC_APPROVAL_UNCHECKED', issue: 'asks approval of a design spec with no constitution check result', suggestion: 'run the built-in check and carry its result' });
    const r = await new MessagingToneGate(provider).review(FOUNDING, { channel: 'telegram', specConstitutionChecks: [] });
    expect(r.pass).toBe(false);
    expect(r.rule).toBe('B24_SPEC_APPROVAL_UNCHECKED');
    expect(r.advisory).toBeUndefined();
  });

  it('a right-shaped ask passes when the judge passes it', async () => {
    const { provider } = capture();
    const r = await new MessagingToneGate(provider).review(RIGHT_SHAPE, { channel: 'telegram', specConstitutionChecks: [] });
    expect(r.pass).toBe(true);
  });

  it('is registered, classified, blocking, and exempt from the advisory migration', () => {
    expect(VALID_RULES.has('B24_SPEC_APPROVAL_UNCHECKED')).toBe(true);
    expect(RULE_CLASSES.B24_SPEC_APPROVAL_UNCHECKED).toBe('signal-driven');
    expect(RULE_DISPOSITIONS.B24_SPEC_APPROVAL_UNCHECKED).toBe('blocking');
    expect(ADVISORY_MIGRATION_EXEMPT_RULES.has('B24_SPEC_APPROVAL_UNCHECKED')).toBe(true);
    expect(resolveRuleDisposition('B24_SPEC_APPROVAL_UNCHECKED', true)).toBe('blocking');
  });
});

describe('Work Board judge', () => {
  it('holds on a fire verdict and carries the issue and suggestion', async () => {
    const { provider, last } = capture({ fire: true, issue: 'asks the owner to approve a design without its check', suggestion: 'run the check' });
    const v = await judgeSpecApprovalAsk(provider, 'title: Approve the handoff design\nneed: please approve the spec', []);
    expect(v).toEqual({ hold: true, issue: 'asks the owner to approve a design without its check', suggestion: 'run the check' });
    expect(last()).toContain('B24_SPEC_APPROVAL_UNCHECKED');
    expect(last()).toMatch(/<<<CARD_[0-9a-f]{16}>>>/);
  });

  it('passes on a no-fire verdict', async () => {
    const { provider } = capture({ fire: false, issue: '', suggestion: '' });
    expect(await judgeSpecApprovalAsk(provider, 'title: Renew the domain', [])).toEqual({ hold: false });
  });

  it('reports unavailable (the route then holds) only after both model tiers fail; no provider at all is reported as such', async () => {
    expect(await judgeSpecApprovalAsk(null, 'x', [])).toEqual({ hold: false, noProvider: true });
    const bad: IntelligenceProvider = { evaluate: vi.fn(async () => 'not json') };
    expect(await judgeSpecApprovalAsk(bad, 'x', [])).toEqual({ hold: false, unavailable: true });
    expect(bad.evaluate).toHaveBeenCalledTimes(2);
    const throws: IntelligenceProvider = { evaluate: async () => { throw new Error('down'); } };
    expect(await judgeSpecApprovalAsk(throws, 'x', [])).toEqual({ hold: false, unavailable: true });
  });

  it('a second tier answers when the first fails', async () => {
    let n = 0;
    const flaky: IntelligenceProvider = { evaluate: async () => { n++; if (n === 1) throw new Error('rate limited'); return '{"fire": false}'; } };
    expect(await judgeSpecApprovalAsk(flaky, 'x', [])).toEqual({ hold: false });
  });

  it('judges the fields a person reads to decide', () => {
    const t = cardTextForSpecJudge({ title: 'Approve design', need: 'Please approve', due: '2026-11-20', doneWhen: [{ text: 'approved' }] });
    expect(t).toContain('title: Approve design');
    expect(t).toContain('need: Please approve');
    expect(t).toContain('doneWhen: [{"text":"approved"}]');
    expect(t).not.toContain('due');
  });

  it('the section helper bundles rule and records', () => {
    const s = renderSpecApprovalSection([]);
    expect(s).toContain('=== B24 SPEC APPROVAL NEEDS ITS CONSTITUTION CHECK ===');
    expect(s).toContain('may be cited like the others');
  });
});
