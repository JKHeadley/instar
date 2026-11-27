/**
 * ACT-053: safe-merge refuses a PR whose base is not main.
 *
 * ci.yml runs the suite only for PRs into main and the required checks are
 * scoped to main, so a stacked PR (base = a feature branch) ran no suite on
 * GitHub yet showed CLEAN, and `--auto` would let GitHub merge it at once.
 * PR #2202 merged branch-to-branch that way on 2026-10-19.
 *
 * The CLI-level proof (real script, fake gh, no merge call) is in
 * tests/integration/safe-merge-non-main-base.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { nonMainBaseRefusal, MERGE_BASE, capabilities } from '../../scripts/safe-merge.mjs';

describe('nonMainBaseRefusal — pure', () => {
  it('main is the merge base and is not refused', () => {
    expect(MERGE_BASE).toBe('main');
    expect(nonMainBaseRefusal('main')).toBeNull();
  });

  it('a feature-branch base is refused with a retarget instruction', () => {
    const r = nonMainBaseRefusal('feat/a2a-inbound-id-ledger');
    expect(r?.result).toBe('refused:non-main-base');
    expect(r?.base).toBe('feat/a2a-inbound-id-ledger');
    expect(r?.message).toContain('--base main');
  });

  it('near-misses of main are refused (exact match only)', () => {
    for (const b of ['Main', 'main ', 'mainline', 'refs/heads/main', 'master']) {
      expect(nonMainBaseRefusal(b)?.result, b).toBe('refused:non-main-base');
    }
  });

  it('an unreadable base is refused, never treated as main', () => {
    for (const b of [undefined, null, '', 42]) {
      const r = nonMainBaseRefusal(b);
      expect(r?.result).toBe('refused:non-main-base');
      expect(r?.base).toBeNull();
    }
  });

  it('advertises the refusal in the capabilities probe', () => {
    expect(capabilities().features).toContain('non-main-base-refusal');
  });
});
