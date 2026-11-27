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
  const scriptChange = { status: 'M', file: 'scripts/instar-dev-precommit.js' };
  const docsChange = { status: 'M', file: 'docs/specs/foo.md' };

  it('passes when in-scope changes carry a per-entry decision file whose scope covers them', () => {
    const r = evaluateDecisionAuditPresence({
      changes: [srcChange, entry],
      records: [{ scope: { files: ['src/core/Config.ts'] } }],
    });
    expect(r.ok).toBe(true);
    expect(r.reason).toContain('covers');
  });

  it('passes when multiple per-entry decision file scopes cover the in-scope changes as a union', () => {
    const r = evaluateDecisionAuditPresence({
      changes: [srcChange, scriptChange, entry],
      records: [
        { scope: { files: ['src/core/Config.ts'] } },
        { scope: { files: ['scripts/instar-dev-precommit.js'] } },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('passes when in-scope changes carry a legacy jsonl modification (transition grace)', () => {
    const r = evaluateDecisionAuditPresence({ changes: [srcChange, legacy] });
    expect(r.ok).toBe(true);
  });

  it('fails when a per-entry decision file scopes different files', () => {
    const r = evaluateDecisionAuditPresence({
      changes: [srcChange, entry],
      records: [{ scope: { files: ['scripts/instar-dev-precommit.js'] } }],
    });
    expect(r.ok).toBe(false);
    expect(r.uncoveredFiles).toEqual(['src/core/Config.ts']);
    expect(r.reason).toContain('does not cover');
  });

  it('fails closed when a per-entry decision file has absent or malformed scope files', () => {
    const withoutScope = evaluateDecisionAuditPresence({ changes: [srcChange, entry], records: [{}] });
    const malformedScope = evaluateDecisionAuditPresence({
      changes: [srcChange, entry],
      records: [{ scope: { files: 'src/core/Config.ts' } }],
    });
    expect(withoutScope.ok).toBe(false);
    expect(withoutScope.uncoveredFiles).toEqual(['src/core/Config.ts']);
    expect(malformedScope.ok).toBe(false);
    expect(malformedScope.uncoveredFiles).toEqual(['src/core/Config.ts']);
  });

  describe('deleted in-scope files (PR #2821)', () => {
    const OLD_BASIS = 'staged-in-scope-additions-plus-deletions';
    const NEW_BASIS = 'staged-in-scope-paths-including-deleted';
    const deleted = { status: 'D', file: 'scripts/run-migration.js' };

    it('passes a deleted file under a record written before deleted paths entered scope', () => {
      const r = evaluateDecisionAuditPresence({
        changes: [srcChange, deleted, entry],
        records: [{ scope: { basis: OLD_BASIS, files: ['src/core/Config.ts'] } }],
      });
      expect(r.ok).toBe(true);
    });

    it('passes a deleted file a current record lists', () => {
      const r = evaluateDecisionAuditPresence({
        changes: [deleted, entry],
        records: [{ scope: { basis: NEW_BASIS, files: ['scripts/run-migration.js'] } }],
      });
      expect(r.ok).toBe(true);
    });

    it('fails a deleted file a current record leaves out', () => {
      const r = evaluateDecisionAuditPresence({
        changes: [srcChange, deleted, entry],
        records: [{ scope: { basis: NEW_BASIS, files: ['src/core/Config.ts'] } }],
      });
      expect(r.ok).toBe(false);
      expect(r.uncoveredFiles).toEqual(['scripts/run-migration.js']);
    });

    it('fails a deleted file with no record at all', () => {
      const r = evaluateDecisionAuditPresence({ changes: [deleted] });
      expect(r.ok).toBe(false);
      expect(r.inScopeFiles).toEqual(['scripts/run-migration.js']);
    });

    it('does not excuse a deleted file on an unreadable record', () => {
      for (const record of [{}, { scope: { basis: OLD_BASIS } }]) {
        const r = evaluateDecisionAuditPresence({ changes: [deleted, entry], records: [record] });
        expect(r.ok).toBe(false);
        expect(r.uncoveredFiles).toEqual(['scripts/run-migration.js']);
      }
    });

    it('still fails a modified uncovered file under an older record', () => {
      const r = evaluateDecisionAuditPresence({
        changes: [srcChange, deleted, entry],
        records: [{ scope: { basis: OLD_BASIS, files: ['scripts/other.js'] } }],
      });
      expect(r.ok).toBe(false);
      expect(r.uncoveredFiles).toEqual(['src/core/Config.ts']);
    });
  });

  it('does not treat a directory scope string as covering descendant files', () => {
    const r = evaluateDecisionAuditPresence({
      changes: [srcChange, entry],
      records: [{ scope: { files: ['src/core'] } }],
    });
    expect(r.ok).toBe(false);
    expect(r.uncoveredFiles).toEqual(['src/core/Config.ts']);
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

  it('exempts bot authors', () => {
    expect(evaluateDecisionAuditPresence({ changes: [srcChange], authorType: 'Bot' }).exempt).toBe('bot-author');
  });

  it('exempts the release-cut PR', () => {
    expect(evaluateDecisionAuditPresence({ changes: [srcChange], title: 'chore: release v1.3.300 [skip ci]' }).exempt).toBe('release-cut');
  });

  it('an entry file alone (no in-scope change) still passes — evidence is never harmful', () => {
    const r = evaluateDecisionAuditPresence({ changes: [entry, docsChange] });
    expect(r.ok).toBe(true);
  });
});
