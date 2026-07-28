import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs script, no types; we only exercise the pure export.
import { versionMatches } from '../../scripts/post-publish-smoke.mjs';

describe('post-publish-smoke versionMatches (Track A)', () => {
  it('matches the bare version output (commander prints just the version)', () => {
    expect(versionMatches('1.3.55\n', '1.3.55')).toBe(true);
    expect(versionMatches('1.3.55', '1.3.55')).toBe(true);
    expect(versionMatches('  1.3.55  ', '1.3.55')).toBe(true);
  });

  it('matches when the version is one token among others', () => {
    expect(versionMatches('instar 1.3.55 (build x)', '1.3.55')).toBe(true);
  });

  it('does NOT match a different version (catches a stale/mis-tagged publish)', () => {
    expect(versionMatches('1.3.54\n', '1.3.55')).toBe(false);
    expect(versionMatches('', '1.3.55')).toBe(false);
  });

  it('does not false-match a substring (1.3.5 vs 1.3.55)', () => {
    expect(versionMatches('1.3.5\n', '1.3.55')).toBe(false);
  });
});
