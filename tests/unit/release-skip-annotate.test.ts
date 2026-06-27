/**
 * Unit tests — release-skip-annotate.mjs (Layer 2 publish-side classifier).
 *
 * The pure classifyRange: given the changed files in the unreleased window,
 * return the release-relevant subset that would ship NOTHING on a silent skip.
 */

import { describe, it, expect } from 'vitest';
import { classifyRange } from '../../scripts/release-skip-annotate.mjs';

describe('classifyRange', () => {
  it('finds release-relevant files in the window', () => {
    const { relevant } = classifyRange({
      files: ['src/a.ts', 'docs/b.md', 'scripts/c.mjs', 'src/a.test.ts'],
    });
    expect(relevant.sort()).toEqual(['scripts/c.mjs', 'src/a.ts']);
  });

  it('returns empty when the window is docs/test-only (a clean skip)', () => {
    const { relevant } = classifyRange({ files: ['docs/a.md', 'tests/b.test.ts', 'README.md'] });
    expect(relevant).toHaveLength(0);
  });

  it('handles an empty window', () => {
    expect(classifyRange({ files: [] }).relevant).toHaveLength(0);
    expect(classifyRange({ files: undefined as unknown as string[] }).relevant).toHaveLength(0);
  });
});
