import { describe, expect, it } from 'vitest';
import { findMaturationPlanGaps } from '../../src/core/FeatureMaturationPlanGate.mjs';

const plan = (extra = '') => `---\ntitle: x\n---\n# X\n\n## Maturation plan\n\n- **test-agent-live:** a\n- **dev-agent-live:** b\n- **fleet:** c\n- **graduation criterion:** d\n- **dark-window:** 14 days\n${extra}\n`;

describe('the plan gate: ladder line', () => {
  it('outside the source tree the line is not asked for', () => {
    expect(findMaturationPlanGaps(plan())).toEqual({ ok: true });
  });
  it('in the source tree it is required', () => {
    expect(findMaturationPlanGaps(plan(), { requireLadder: true })).toMatchObject({ ok: false, missing: ['ladder'] });
    expect(findMaturationPlanGaps(plan('- **ladder:** monitoring.x'), { requireLadder: true })).toEqual({ ok: true });
  });
  it('refuses a duplicate, a malformed id, and one hidden in a quote or code block', () => {
    expect(findMaturationPlanGaps(plan('- **ladder:** a\n- **ladder:** b'), { requireLadder: true })).toMatchObject({ ok: false, duplicates: ['ladder'] });
    expect(findMaturationPlanGaps(plan('- **ladder:** a|b'), { requireLadder: true }).ok).toBe(false);
    expect(findMaturationPlanGaps(plan('> - **ladder:** a'), { requireLadder: true }).ok).toBe(false);
    expect(findMaturationPlanGaps(plan('```\n- **ladder:** a\n```'), { requireLadder: true }).ok).toBe(false);
  });
});
