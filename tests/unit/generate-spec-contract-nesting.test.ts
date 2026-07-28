import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain ESM script, no type declarations
import { splitStrictContract } from '../../scripts/generate-spec-contract.mjs';

/**
 * Regression guard for the defect that shipped the outbound-gate design as
 * 14 bytes of 86,314 (2026-07-25).
 *
 * The strict contract's capture was per-heading rather than hierarchical: any
 * H3 reset the "keeping" flag, so an allowlisted `## 3. Design` was closed by
 * its own first child `### 3.1 …`. The section COUNT stayed correct, so the
 * contract looked complete — and the reviews run against it produced four
 * objections the missing text already answered.
 */
describe('splitStrictContract — nested sub-headings', () => {
  const spec = [
    '---',
    'title: t',
    '---',
    '',
    '# Title',
    '',
    '## 3. Design',
    '',
    '### 3.1 First child',
    '',
    'CHILD_ONE_BODY',
    '',
    '### 3.2 Second child',
    '',
    'CHILD_TWO_BODY',
    '',
    '## 12. Round-1 change log',
    '',
    'HISTORY_BODY',
    '',
  ].join('\n');

  it('keeps non-allowlisted children of an allowlisted section', () => {
    const { contract: body } = splitStrictContract(spec);
    expect(body).toContain('CHILD_ONE_BODY');
    expect(body).toContain('CHILD_TWO_BODY');
  });

  it('still drops a non-allowlisted sibling section', () => {
    const { contract: body } = splitStrictContract(spec);
    expect(body).not.toContain('HISTORY_BODY');
  });

  it('capture does not stop at the first child heading', () => {
    // The precise shape of the historical failure: capture opened on
    // "## 3. Design", closed on "### 3.1", and everything from the SECOND
    // child onward vanished. Asserting the second child's heading survives
    // pins that exact behaviour without a magic byte threshold.
    const { contract: body } = splitStrictContract(spec);
    const design = body.indexOf('## 3. Design');
    expect(design).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('### 3.2 Second child')).toBeGreaterThan(design);
  });
});
