/**
 * The code-owner approval row carries what the owner needs, with no Pace dependency
 * (docs/specs/github-approval-from-the-app.md Part A).
 */
import { describe, it, expect } from 'vitest';
import { buildShipping, prHref } from '../../dashboard/console/development-model.js';
import { NEED_SOURCES, githubFieldsOf } from '../../dashboard/console/needs-model.js';
import { githubOf } from '../../src/server/needsRoutes.js';

const HEAD = 'a'.repeat(40);
const now = Date.parse('2026-11-19T18:00:00Z');
const watcher = (over: Record<string, unknown> = {}) => ({
  ok: true,
  data: {
    lastTickAt: now - 60_000, lastSuccessfulListAt: now - 60_000, episodes: [], armed: [], stuckRed: [],
    snapshot: { at: now - 60_000, entries: [{ pr: 3478, headRefName: 'echo/x', headRefOid: HEAD, kind: 'code-owner-review', title: 'Amend the constitution', ownerFiles: ['docs/STANDARDS-REGISTRY.md'] }] },
    repo: 'JKHeadley/instar', ownerApproval: { available: true, reason: null },
    ...over,
  },
});

describe('development page', () => {
  it('builds GitHub links from the merge watcher when Pace did not answer', () => {
    const s = buildShipping({ watcher: watcher() }, now, { repo: null });
    const row = s.rows.find((r: { group: string }) => r.group === 'needs');
    expect(row.href).toBe('https://github.com/JKHeadley/instar/pull/3478/files');
    expect(row.sub).toBe('waiting for your approval on GitHub: Amend the constitution');
    expect(s.repoKnown).toBe(true);
  });
  it('prefers the watcher repository over the Pace one', () => {
    const s = buildShipping({ watcher: watcher() }, now, { repo: 'other/repo' });
    expect(s.rows[0].href).toContain('JKHeadley/instar');
  });
  it('says links are off only when nothing names a repository', () => {
    expect(buildShipping({ watcher: watcher({ repo: undefined }) }, now, { repo: null }).repoKnown).toBe(false);
    expect(prHref('bad repo', 1)).toBeNull();
  });
});

describe('Needs-you rows', () => {
  const source = NEED_SOURCES.find((s: { id: string }) => s.id === 'shipping-approvals');
  it('carry pr, githubUrl, prTitle, prSummary, headSha and approveAvailable', () => {
    const rows = source.rows({ watcher: watcher() }, now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pr: 3478, githubUrl: 'https://github.com/JKHeadley/instar/pull/3478/files', prTitle: 'Amend the constitution',
      prSummary: 'Changes docs/STANDARDS-REGISTRY.md', headSha: HEAD, approveAvailable: true, sub: 'Amend the constitution',
    });
  });
  it('offer no approval when this machine cannot record it, or on an episode row with no head', () => {
    expect(source.rows({ watcher: watcher({ ownerApproval: { available: false, reason: 'off' } }) }, now)[0].approveAvailable).toBe(false);
    const ep = watcher({ snapshot: { at: now, entries: [] }, episodes: [{ pr: 12, lastOutcome: 'refused:approval-required', lastAttemptAt: now }] });
    const r = source.rows({ watcher: ep }, now)[0];
    expect(r).toMatchObject({ pr: 12, githubUrl: 'https://github.com/JKHeadley/instar/pull/12/files', approveAvailable: false });
    expect(r.headSha).toBeUndefined();
  });
  it('a long file list is cut with "and N more"', () => {
    const files = Array.from({ length: 40 }, (_, i) => `docs/very/long/path/number-${i}.md`);
    const f = githubFieldsOf({ pr: 1, href: null, record: { kind: 'code-owner-review', headRefOid: HEAD, ownerFiles: files } }, watcher());
    expect(f.prSummary.length).toBeLessThanOrEqual(400);
    expect(f.prSummary).toMatch(/and \d+ more$/);
  });
});

describe('GET /needs item fields (needsRoutes githubOf)', () => {
  it('copies the validated fields through', () => {
    expect(githubOf({ pr: 3478, githubUrl: 'https://github.com/JKHeadley/instar/pull/3478/files', prTitle: 'T', prSummary: 'Changes x', headSha: HEAD, approveAvailable: true }))
      .toEqual({ pr: 3478, githubUrl: 'https://github.com/JKHeadley/instar/pull/3478/files', prTitle: 'T', prSummary: 'Changes x', headSha: HEAD, approveAvailable: true });
  });
  it('drops anything malformed, and never offers approval without a head', () => {
    expect(githubOf({ pr: 'x' })).toEqual({});
    expect(githubOf({ pr: 5, githubUrl: 'https://evil.example/pull/5/files', headSha: 'zz', approveAvailable: true })).toEqual({ pr: 5, approveAvailable: false });
    expect(githubOf({ pr: 5, githubUrl: 'https://github.com/a/b/pull/6/files' }).githubUrl).toBeUndefined();
  });
});
