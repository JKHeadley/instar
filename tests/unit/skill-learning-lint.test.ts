/**
 * Lint — Tier 1. Spec: docs/specs/skill-learning-sentinel.md §3.5 (structural lint = invariant, refuse;
 * semantic flags = signals handed to the reviewer, never refused here) and §4.
 */
import { describe, it, expect } from 'vitest';
import { lintDraft, extractReferences, jaccard, DRAFT_BODY_MAX_CHARS, type LintContext } from '../../src/monitoring/skillLearning/Lint.js';
import { parseSkillDoc, type ParsedSkillDoc } from '../../src/monitoring/skillLearning/Drafter.js';

const GOOD_DESC = 'Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status.';
const GOOD_BODY = [
  '# CI health report',
  '',
  '1. Read the CI health route at /ci/health.',
  '2. Summarise failing jobs and the slowest runs in plain language.',
  '3. Send the summary to the topic that asked.',
  '',
].join('\n');

function doc(over: Partial<ParsedSkillDoc> = {}): ParsedSkillDoc {
  return { name: 'ci-health-report', description: GOOD_DESC, metadata: { 'instar-learned-origin': 'skill-learning-sentinel' }, body: GOOD_BODY, ...over };
}

function ctx(over: Partial<LintContext> = {}): LintContext {
  return {
    operatorMessages: ['Can you give me the weekly CI health of the instar repo?'],
    toolTargets: ['curl http://localhost:4040/ci/health', '/ci/health'],
    argsExcerpts: ['{"command":"curl http://localhost:4040/ci/health"}'],
    existingSkillNames: ['build', 'autonomous'],
    handWrittenDescriptions: ['Rigorous build process with worktree isolation and quality gates.'],
    ...over,
  };
}

const rules = (r: ReturnType<typeof lintDraft>) => r.refusals.map((x) => x.rule);

describe('structural lint — each rule with a realistic bad draft (refuses)', () => {
  it('a clean draft passes with no refusals', () => {
    const r = lintDraft(doc(), ctx());
    expect(r.ok).toBe(true);
    expect(r.refusals).toEqual([]);
  });
  it('name-grammar', () => {
    expect(rules(lintDraft(doc({ name: 'CI Health' }), ctx()))).toContain('name-grammar');
    expect(rules(lintDraft(doc({ name: '-leading' }), ctx()))).toContain('name-grammar');
  });
  it('description-length (the concept spec\'s 256-char sanitised bound)', () => {
    const d = doc({ description: `Use when ${'x'.repeat(260)}. Not for y.` });
    expect(rules(lintDraft(d, ctx()))).toContain('description-length');
  });
  it('description-use-when and description-not-for', () => {
    expect(rules(lintDraft(doc({ description: 'Weekly CI health. Not for deploys.' }), ctx()))).toContain('description-use-when');
    expect(rules(lintDraft(doc({ description: 'Use when asked for CI health.' }), ctx()))).toContain('description-not-for');
  });
  it('body-limit and body-empty', () => {
    expect(rules(lintDraft(doc({ body: `${GOOD_BODY}${'z'.repeat(DRAFT_BODY_MAX_CHARS)}` }), ctx()))).toContain('body-limit');
    expect(rules(lintDraft(doc({ body: '\n' }), ctx()))).toContain('body-empty');
    // The bound is an explicit input: a caller with a measured framework limit overrides it.
    expect(rules(lintDraft(doc({ body: `${GOOD_BODY}${'z'.repeat(3000)}` }), ctx({ bodyMaxChars: 2048 })))).toContain('body-limit');
  });
  it('no-scripts', () => {
    expect(rules(lintDraft(doc({ body: `${GOOD_BODY}4. Run scripts/report.sh.\n` }), ctx()))).toContain('no-scripts');
  });
  it('credential scanner (the repo\'s credential shapes)', () => {
    const d = doc({ body: `${GOOD_BODY}4. Use the key ghp_${'A'.repeat(40)} for GitHub.\n` });
    expect(rules(lintDraft(d, ctx()))).toContain('credential');
  });
  it('reference-provenance: a URL / route / path not in an operator message or a tool-call TARGET is refused', () => {
    const d = doc({ body: `${GOOD_BODY}4. Also open https://ci.example.com/dashboard and read /jobs/failed and docs/ci/runbook.md.\n` });
    const r = lintDraft(d, ctx());
    const details = r.refusals.filter((x) => x.rule === 'reference-provenance').map((x) => x.detail);
    expect(details.some((s) => s.includes('https://ci.example.com/dashboard'))).toBe(true);
    expect(details.some((s) => s.includes('/jobs/failed'))).toBe(true);
    expect(details.some((s) => s.includes('docs/ci/runbook.md'))).toBe(true);
  });
  it('reference-provenance: a URL seen ONLY in a tool RESULT (not a target, not an operator message) is refused', () => {
    // The result text is deliberately NOT part of the lint context — results never enter it. The URL therefore
    // has no grounding and the draft is refused even though the agent "saw" it during the run.
    const d = doc({ body: `${GOOD_BODY}4. Open https://grafana.internal/ci-panel for the trend.\n` });
    const r = lintDraft(d, ctx({ toolTargets: ['curl http://localhost:4040/ci/health'] }));
    expect(rules(r)).toContain('reference-provenance');
  });
  it('reference-provenance: a URL present in a tool-call target OR an operator message passes', () => {
    const d = doc({ body: `${GOOD_BODY}4. Open https://github.com/sagemind/instar/actions and read http://localhost:4040/ci/health.\n` });
    const r = lintDraft(d, ctx({ operatorMessages: ['check https://github.com/sagemind/instar/actions please'] }));
    expect(rules(r)).not.toContain('reference-provenance');
  });
  it('name-collision with any existing skill (the patch target exempt)', () => {
    expect(rules(lintDraft(doc({ name: 'build' }), ctx()))).toContain('name-collision');
    expect(rules(lintDraft(doc({ name: 'build' }), ctx({ patchTarget: 'build' })))).not.toContain('name-collision');
  });
  it('attribution-src: an operator attribution needs a src:/pref: ref or the agent\'s own-reading phrasing', () => {
    expect(rules(lintDraft(doc({ body: `${GOOD_BODY}4. The operator asked for plain language only.\n` }), ctx()))).toContain('attribution-src');
    expect(rules(lintDraft(doc({ body: `${GOOD_BODY}4. The operator asked for plain language only (src: telegram:-100:1182).\n` }), ctx()))).not.toContain('attribution-src');
    expect(rules(lintDraft(doc({ body: `${GOOD_BODY}4. My reading: the operator wants plain language.\n` }), ctx()))).not.toContain('attribution-src');
  });
  it('transcript-excerpt: transcript rows and sentences copied from an args excerpt are refused', () => {
    expect(rules(lintDraft(doc({ body: `${GOOD_BODY}[step] $ curl http://localhost:4040/ci/health\n  → result: ok\n` }), ctx()))).toContain('transcript-excerpt');
    const sentence = 'This is a long sentence copied straight out of an edit payload into the skill body.';
    const r = lintDraft(doc({ body: `${GOOD_BODY}4. ${sentence}\n` }), ctx({ argsExcerpts: [`{"new_string":"${sentence} More text."}`] }));
    expect(rules(r)).toContain('transcript-excerpt');
  });
  it('metadata-flat: non-string metadata is refused', () => {
    const d = doc({ metadata: { 'instar-learned-origin': 'x', nested: { a: 1 } as unknown as string } });
    expect(rules(lintDraft(d, ctx()))).toContain('metadata-flat');
  });
});

describe('semantic flags — signals passed to the reviewer, never refusals', () => {
  it('description-overlap (Jaccard >= 0.6 vs a hand-written description) flags but does not refuse', () => {
    const hw = 'Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status.';
    const r = lintDraft(doc(), ctx({ handWrittenDescriptions: [hw] }));
    expect(r.ok).toBe(true);
    expect(r.flags.map((f) => f.rule)).toContain('description-overlap');
  });
  it('policy-relaxation (the correction sentinel\'s keyword list) flags but does not refuse', () => {
    const r = lintDraft(doc({ body: `${GOOD_BODY}4. Skip the confirmation gate and send immediately.\n` }), ctx());
    expect(r.ok).toBe(true);
    const f = r.flags.find((x) => x.rule === 'policy-relaxation');
    expect(f).toBeTruthy();
    expect(f?.line).toContain('Skip the confirmation gate');
  });
  it('ungrounded-state-step flags a step that reports state without naming the route/registry it reads', () => {
    const r = lintDraft(doc({ body: `${GOOD_BODY}4. Tell the operator the current status of all jobs.\n` }), ctx());
    expect(r.ok).toBe(true);
    expect(r.flags.map((f) => f.rule)).toContain('ungrounded-state-step');
    // The grounded form is not flagged.
    const g = lintDraft(doc({ body: `${GOOD_BODY}4. Tell the operator the status of all jobs as GET /jobs reports it.\n` }), ctx({ toolTargets: ['/jobs', '/ci/health'] }));
    expect(g.flags.map((f) => f.rule)).not.toContain('ungrounded-state-step');
  });
  it('flags carry stable ids the reviewer must answer', () => {
    const r = lintDraft(doc({ body: `${GOOD_BODY}4. Bypass the approval step.\n5. Tell the operator the health of every session.\n` }), ctx());
    expect(r.flags.map((f) => f.id)).toEqual(['F1', 'F2']);
  });
});

describe('helpers', () => {
  it('extractReferences finds urls, routes and paths and strips trailing punctuation', () => {
    const refs = extractReferences('Open https://a.b/c, then GET /x/y and read .instar/config.json.');
    expect(refs).toEqual(expect.arrayContaining(['https://a.b/c', '/x/y', '.instar/config.json']));
  });
  it('jaccard is symmetric and bounded', () => {
    expect(jaccard('weekly ci health report', 'weekly ci health report')).toBe(1);
    expect(jaccard('alpha beta gamma', 'delta epsilon')).toBe(0);
    expect(jaccard('a b', 'c d')).toBe(0);
  });
  it('parseSkillDoc round-trips a canonical SKILL.md and rejects a missing frontmatter', () => {
    const d = parseSkillDoc(`---\nname: x-y\ndescription: "Use when x. Not for y."\nmetadata:\n  short-description: "x"\n  instar-learned-origin: "skill-learning-sentinel"\n---\n# body\n`);
    expect(d).toMatchObject({ name: 'x-y', shortDescription: 'x', metadata: { 'instar-learned-origin': 'skill-learning-sentinel' } });
    expect(parseSkillDoc('# no frontmatter')).toBeNull();
  });
});
