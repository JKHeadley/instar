/**
 * decision-audit-presence gate (task #81 close-out) — PR-boundary detection of
 * commits that bypassed the local instar-dev gate.
 *
 * The live case this detects: a build worktree created with raw
 * `git worktree add` has no husky shim, so `git commit` runs zero hooks and
 * in-scope changes arrive with no decision-audit record. Verified across
 * three real worktrees on 2026-06-05; root fixed in #829 (the CLI path), this
 * gate is the structural backstop (Structure > Willpower) that makes any
 * future bypass visible.
 *
 * Both sides of every boundary: in-scope + per-entry evidence passes;
 * in-scope + legacy-jsonl evidence passes (transition grace); in-scope with
 * NO evidence fails with the actionable message; docs-only passes; bot and
 * release-cut PRs are exempt.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateDecisionAuditPresence,
  parseNameStatus,
  isInScopeFile,
} from '../../scripts/decision-audit-presence-check.mjs';

describe('isInScopeFile (mirrors the precommit gate scope)', () => {
  it('matches gate-scoped prefixes', () => {
    expect(isInScopeFile('src/core/SessionManager.ts')).toBe(true);
    expect(isInScopeFile('scripts/instar-dev-precommit.js')).toBe(true);
    expect(isInScopeFile('.husky/pre-commit')).toBe(true);
    expect(isInScopeFile('skills/instar-dev/SKILL.md')).toBe(true);
    expect(isInScopeFile('skills/instar-dev/scripts/x.mjs')).toBe(true);
  });
  it('does not match docs/tests/upgrades', () => {
    expect(isInScopeFile('docs/specs/foo.md')).toBe(false);
    expect(isInScopeFile('tests/unit/foo.test.ts')).toBe(false);
    expect(isInScopeFile('upgrades/next/foo.md')).toBe(false);
    expect(isInScopeFile('.instar/instar-dev-decisions/x.json')).toBe(false);
  });
});

describe('parseNameStatus', () => {
  it('parses status + path and takes the rename target', () => {
    const parsed = parseNameStatus('M\tsrc/a.ts\nA\t.instar/instar-dev-decisions/t-s.json\nR100\told.ts\tnew.ts\n\n');
    expect(parsed).toEqual([
      { status: 'M', file: 'src/a.ts' },
      { status: 'A', file: '.instar/instar-dev-decisions/t-s.json' },
      { status: 'R100', file: 'new.ts' },
    ]);
  });
});

describe('evaluateDecisionAuditPresence', () => {
  const entry = { status: 'A', file: '.instar/instar-dev-decisions/2026-06-05T12-00-00-000Z-slug.json' };
  const legacy = { status: 'M', file: '.instar/instar-dev-decisions.jsonl' };
  const srcChange = { status: 'M', file: 'src/core/Config.ts' };
  const docsChange = { status: 'M', file: 'docs/specs/foo.md' };

  it('passes when in-scope changes carry a per-entry decision file', () => {
    const r = evaluateDecisionAuditPresence({ changes: [srcChange, entry] });
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('evidence');
  });

  it('passes when in-scope changes carry a legacy jsonl modification (transition grace)', () => {
    const r = evaluateDecisionAuditPresence({ changes: [srcChange, legacy] });
    expect(r.ok).toBe(true);
  });

  it('FAILS when in-scope changes carry no gate evidence — the bypass shape', () => {
    const r = evaluateDecisionAuditPresence({ changes: [srcChange, docsChange] });
    expect(r.ok).toBe(false);
    expect(r.inScopeFiles).toEqual(['src/core/Config.ts']);
    // The message must be actionable: name the cause and the fix.
    expect(r.reason).toMatch(/husky shim/);
    expect(r.reason).toMatch(/npm run prepare/);
  });

  it('passes docs/tests-only PRs without requiring evidence', () => {
    const r = evaluateDecisionAuditPresence({
      changes: [docsChange, { status: 'A', file: 'tests/unit/x.test.ts' }],
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('no in-scope changes');
  });

  it('exempts bot authors and the release-cut PR', () => {
    expect(evaluateDecisionAuditPresence({ changes: [srcChange], authorType: 'Bot' }).exempt).toBe('bot-author');
    expect(evaluateDecisionAuditPresence({ changes: [srcChange], title: 'chore: release v1.3.300 [skip ci]' }).exempt).toBe('release-cut');
  });

  it('an entry file alone (no in-scope change) still passes — evidence is never harmful', () => {
    const r = evaluateDecisionAuditPresence({ changes: [entry, docsChange] });
    expect(r.ok).toBe(true);
  });
});
