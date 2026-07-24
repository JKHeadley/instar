import { describe, expect, it } from 'vitest';
import { findMaturationPlanGaps } from '../../scripts/feature-maturation-plan-gate.mjs';
import { computeCoverage } from '../../src/core/StandardsEnforcementAuditor.js';

const complete = `## Maturation plan
- **test-agent-live:** supervised scenarios
- **dev-agent-live:** direct-user soak
- **fleet:** promote after evidence
- **graduation criterion:** all required assertions pass
- **dark-window:** 14 days
`;

describe('findMaturationPlanGaps', () => {
  it('is cited by the live Maturation Path article as a gate, not a ratchet', () => {
    const report = computeCoverage({ registryPath: 'docs/STANDARDS-REGISTRY.md', projectDir: process.cwd() });
    const standard = report.standards.find((entry) => entry.standard.startsWith('Maturation Path —'));
    expect(standard?.enforcementKind).toBe('gate');
    expect(standard?.danglingRefs).toEqual([]);
  });
  it('accepts exactly one complete canonical plan', () => {
    expect(findMaturationPlanGaps(complete)).toEqual({ ok: true });
  });

  it('reports missing fields without judging their prose', () => {
    expect(findMaturationPlanGaps('## Maturation plan\n- **fleet:** later\n')).toMatchObject({
      ok: false,
      reason: 'invalid-fields',
      missing: ['test-agent-live', 'dev-agent-live', 'graduation criterion', 'dark-window'],
    });
  });

  it('rejects duplicate fields and duplicate real sections', () => {
    expect(findMaturationPlanGaps(`${complete}- **fleet:** shadow\n`)).toMatchObject({
      ok: false,
      duplicates: ['fleet'],
    });
    expect(findMaturationPlanGaps(`${complete}\n## Maturation plan\n${complete}`)).toEqual({
      ok: false,
      reason: 'duplicate-section',
    });
  });

  it('ignores frontmatter, fenced examples, comments, and blockquotes', () => {
    const adversarial = `---
title: "## Maturation plan"
---
\`\`\`
${complete}
\`\`\`
<!-- ${complete} -->
> ## Maturation plan
> - **fleet:** quoted
`;
    expect(findMaturationPlanGaps(adversarial)).toEqual({ ok: false, reason: 'missing-section' });
  });

  it('stops at the next level-two section', () => {
    expect(findMaturationPlanGaps('## Maturation plan\n- **fleet:** here\n## Other\n- **test-agent-live:** hidden\n- **dev-agent-live:** hidden\n- **graduation criterion:** hidden\n- **dark-window:** hidden\n'))
      .toMatchObject({ ok: false, reason: 'invalid-fields' });
  });
});
