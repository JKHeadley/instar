/**
 * Unit tests — check-release-fragment.mjs (Layer 1 PR-gate decision function).
 *
 * The objective binary: a release-relevant PR must add/modify a release-note
 * fragment (or be exempt). Both sides of every branch, plus the security cases
 * (bot exemption keyed on identity not a spoofable title; internal-only fragment
 * satisfies the presence check).
 */

import { describe, it, expect } from 'vitest';
import { checkReleaseFragment } from '../../scripts/check-release-fragment.mjs';

const F = (path: string, status = 'modified') => ({ path, status });

describe('checkReleaseFragment', () => {
  it('FAILS a release-relevant PR with no fragment', () => {
    const res = checkReleaseFragment({ files: [F('src/foo.ts')], authorType: 'User', authorLogin: 'echo' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('release-relevant-no-fragment');
    expect(res.relevant).toContain('src/foo.ts');
  });

  it('PASSES when a fragment is added alongside the src change', () => {
    const res = checkReleaseFragment({
      files: [F('src/foo.ts'), F('upgrades/next/my-change.md', 'added')],
      authorType: 'User', authorLogin: 'echo',
    });
    expect(res.ok).toBe(true);
  });

  it('PASSES an internal-only fragment (presence satisfies Layer 1; legitimacy is downstream)', () => {
    // Layer 1 sees only the file list; an internal-only fragment IS a fragment file.
    const res = checkReleaseFragment({
      files: [F('src/foo.ts'), F('upgrades/next/internal.md', 'added')],
      authorType: 'User', authorLogin: 'echo',
    });
    expect(res.ok).toBe(true);
  });

  it('PASSES (exempt) a docs/test-only PR', () => {
    const res = checkReleaseFragment({
      files: [F('docs/x.md'), F('src/foo.test.ts')],
      authorType: 'User', authorLogin: 'echo',
    });
    expect(res.ok).toBe(true);
    expect(res.exempt).toBe('no-release-relevant-paths');
  });

  it('exempts ONLY the authenticated release-cut bot identity', () => {
    const res = checkReleaseFragment({
      files: [F('src/foo.ts')],
      authorType: 'Bot', authorLogin: 'github-actions[bot]',
    });
    expect(res.ok).toBe(true);
    expect(res.exempt).toBe('release-cut-bot');
  });

  it('does NOT exempt a non-release bot', () => {
    const res = checkReleaseFragment({
      files: [F('src/foo.ts')],
      authorType: 'Bot', authorLogin: 'dependabot[bot]',
    });
    expect(res.ok).toBe(false);
  });

  it('EVASION: a human PR titled "chore: release" is still gated (title is not the key)', () => {
    const res = checkReleaseFragment({
      files: [F('src/foo.ts')],
      authorType: 'User', authorLogin: 'attacker', title: 'chore: release v9.9.9',
    });
    expect(res.ok).toBe(false);
  });

  it('accepts a bare path-list shape too', () => {
    const res = checkReleaseFragment({ files: ['src/foo.ts'], authorType: 'User', authorLogin: 'echo' });
    expect(res.ok).toBe(false);
  });

  it('a fragment alone (no src) passes', () => {
    const res = checkReleaseFragment({
      files: [F('upgrades/next/notes.md', 'added')],
      authorType: 'User', authorLogin: 'echo',
    });
    // No release-relevant path → exempt before the fragment check even matters.
    expect(res.ok).toBe(true);
  });
});
