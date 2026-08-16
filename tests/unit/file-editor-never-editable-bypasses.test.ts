/**
 * Unit tests — the never-editable deny list cannot be walked around
 * (round-14 security, found while reviewing the grok-build branch).
 *
 * The list's stated invariant is that a PIN compromise must never yield
 * arbitrary code execution — `.claude/hooks/` and `.claude/scripts/` are on it
 * for exactly that reason, and round-13 added `.instar/config.json` because it
 * selects which executable a session spawns.
 *
 * Two bypasses were confirmed END-TO-END against the real route before this fix
 * (200, real file rewritten, including a hook body):
 *   1. CASE. macOS APFS and Windows are case-insensitive, so `.instar/Config.json`
 *      reaches the same file while a case-SENSITIVE comparison sees a different
 *      path. The sibling `isBlockedFilename` in the same module already
 *      lower-cases both sides; this list did not.
 *   2. SYMLINK. `isNeverEditable` was checked against the REQUESTED path while
 *      the write goes to the resolved target, so an alias inside an allowed
 *      directory slipped through. `isNeverServed` already had the post-realpath
 *      re-check, and its own comment says that check exists so "a symlink cannot
 *      evade it" — the edit list simply never got the same treatment.
 *
 * These assert the PREDICATES; both are the single chokepoint the routes call.
 */

import { describe, it, expect } from 'vitest';
import { isNeverServed } from '../../src/server/fileRoutes.js';

// Round-17 (security review): this used to be a helper that fell back to
// `isNeverServed` when `isNeverEditable` was not exported. That fallback was
// the exact PROXY ASSERTION this file's own header warns against — had the
// export ever been removed, the tests would have silently degraded to
// asserting a SIBLING predicate instead of failing loudly. `isNeverEditable`
// IS exported, so the fallback was dead code armed and waiting. Import it
// directly: an un-export now breaks the build, which is the correct failure.
import { isNeverEditable as neverEditable } from '../../src/server/fileRoutes.js';

describe('never-served deny list — case folding (round-14)', () => {
  it('denies the exact-case path', () => {
    expect(isNeverServed('.instar/state/external-hog-decisions.json')).toBe(true);
    expect(isNeverServed('.instar/state/judgment-provenance/row.json')).toBe(true);
  });

  it('denies a CAPITALISED path that reaches the same file on a case-insensitive FS', () => {
    // This is the bypass: before the fix these returned false.
    expect(isNeverServed('.instar/State/External-Hog-Decisions.json')).toBe(true);
    expect(isNeverServed('.INSTAR/state/judgment-provenance/row.json')).toBe(true);
  });

  it('CONTROL: an unrelated path is still served', () => {
    expect(isNeverServed('docs/specs/some-spec.md')).toBe(false);
    expect(isNeverServed('.instar/config-notes.md')).toBe(false);
  });
});

describe('never-editable deny list — case folding (round-14)', () => {
  it('denies the executable-selection config and the code-execution prefixes, any case', () => {
    for (const p of [
      '.instar/config.json',
      '.instar/Config.json',
      '.INSTAR/CONFIG.JSON',
      '.claude/hooks/session-start.js',
      '.claude/Hooks/session-start.js',
      '.claude/scripts/telegram-reply.sh',
    ]) {
      expect(neverEditable(p), `expected ${p} to be refused`).toBe(true);
    }
  });

  it('CONTROL: an ordinary editable file is not refused', () => {
    expect(neverEditable('docs/specs/some-spec.md')).toBe(false);
    expect(neverEditable('.claude/skills/spec-converge/SKILL.md')).toBe(false);
  });
});
