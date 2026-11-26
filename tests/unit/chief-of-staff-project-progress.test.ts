import { describe, expect, it, vi } from 'vitest';
import { buildProjectCoverage, buildProjectProgressReader, matchProgressProject, projectProgressStatus, readProjectEvidencePage, readProgressWithin } from '../../src/core/ChiefOfStaffProjectProgress.js';
import type { Initiative } from '../../src/core/InitiativeTracker.js';
import type { BoundProject } from '../../src/core/ChiefOfStaffLoop.js';
import type { LocalVerifyRecord } from '../../src/localVerify/record.js';

const now = Date.parse('2026-11-26T22:00:00Z');
const baseline = '2026-11-26T10:00:00Z';
const project = {
  conversationKey: 'telegram:123',
  doneDefinition: [],
  linked: { repos: ['example/instar'], branches: [], domains: [] },
} as BoundProject;
const initiative = {
  id: 'tracking', kind: 'project', telegramTopicId: '123',
  blockers: ['Waiting on verification'], rounds: [{ itemIds: ['child'] }],
} as Initiative;
const child = {
  id: 'child', parentProjectId: 'tracking', prNumber: 1234, links: [],
} as unknown as Initiative;

describe('verified Chief of Staff project progress', () => {
  it('marks a six-hour stall from the last verified transition and never invents evidence', () => {
    const events = [
      { kind: 'done-item' as const, at: '2026-11-26T13:00:00Z' },
      { kind: 'merge' as const, at: '2026-11-26T15:00:00Z' },
      { kind: 'full-test-pass' as const, at: '2026-11-27T15:00:00Z' },
    ];
    expect(projectProgressStatus(now, baseline, events, ['Queue'], now, true)).toMatchObject({
      lastProgressAt: events[1].at, lastProgressKind: 'merge', waitingOn: ['Queue'], stalledSince: '2026-11-26T21:00:00.000Z',
    });
    expect(projectProgressStatus(now, baseline, events, [], now, false).stalledSince).toBeNull();
    expect(projectProgressStatus(now, baseline, [], [], null, true).stalledSince).toBeNull();
    expect(projectProgressStatus(now, '2026-11-26T16:00:01Z', [], [], now, true).stalledSince).toBeNull();
  });

  it('resolves exact project membership and refuses duplicate or wrong mappings', () => {
    expect(matchProgressProject(project, [initiative])?.id).toBe(initiative.id);
    expect(matchProgressProject(project, [initiative, { ...initiative, id: 'duplicate' }])).toBeNull();
    expect(matchProgressProject({ ...project, initiativeId: 'missing' }, [initiative])).toBeNull();
  });

  it('gives the same conversation one row and keeps registry-only rows visible', () => {
    const progress = projectProgressStatus(now, baseline, [], [], now, true);
    const rows = buildProjectCoverage(
      [{ conversationKey: 'telegram:123', title: 'Tracked', ...progress }],
      [
        { ...initiative, status: 'active', title: 'Registry name' },
        { ...initiative, id: 'duplicate', title: 'Duplicate', status: 'active' },
        { ...initiative, id: 'new', title: 'Needs binding', telegramTopicId: '456', status: 'active' },
        { ...initiative, id: 'missing', title: 'Needs conversation', telegramTopicId: undefined, status: 'active' },
      ],
      null,
    );
    expect(rows.map(({ disposition, projectIds }) => ({ disposition, projectIds }))).toEqual([
      { disposition: 'awaiting-binding', projectIds: ['new'] },
      { disposition: 'needs-conversation', projectIds: ['missing'] },
      { disposition: 'ambiguous-membership', projectIds: ['duplicate', 'tracking'] },
    ]);
  });

  it('refuses an expired probe, an HTTP error body and an oversized success body', async () => {
    const read = vi.fn(async () => 'unreachable');
    expect(await readProgressWithin(performance.now() - 1, read, null)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('target text', { status: 503 }))
      .mockResolvedValueOnce(new Response('x'.repeat(256 * 1024 + 1)))
      .mockResolvedValueOnce(new Response('bounded evidence'));
    vi.stubGlobal('fetch', fetcher);
    const url = new URL('https://example.com/evidence');
    try {
      expect(await readProjectEvidencePage(url)).toBeNull();
      expect(await readProjectEvidencePage(url)).toBeNull();
      expect(await readProjectEvidencePage(url)).toBe('bounded evidence');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads only exact attached PRs and accepts a matching full-test receipt', async () => {
    const head = 'c'.repeat(40);
    const gh = vi.fn(async () => ({
      code: 0, stdout: JSON.stringify({ state: 'MERGED', mergedAt: '2026-11-26T18:00:00Z', headRefOid: head, baseRefName: 'main' }), stderr: '',
    }));
    const verify = vi.fn(() => ({
      repo: 'example/instar', pr: 1234, outcome: 'success', headSha: head, baseRefName: 'main',
      finishedAt: '2026-11-26T17:00:00Z', lanes: [{ gating: true, tests: 10, failed: 0 }],
    } as LocalVerifyRecord));
    const read = buildProjectProgressReader({ gh, verify, verifyAvailable: () => true });
    expect(await read(project, [initiative, child, { ...child, id: 'other', prNumber: 999 }])).toEqual({
      evidence: [
        { kind: 'merge', at: '2026-11-26T18:00:00Z' },
        { kind: 'full-test-pass', at: '2026-11-26T17:00:00Z' },
      ], complete: true, waitingOn: ['Waiting on verification'], doneItems: {},
    });
    expect(verify).toHaveBeenCalledWith(1234, head, 'main');
    expect(gh).toHaveBeenCalledTimes(1);
    expect((await read(project, [initiative, { ...child, parentProjectId: 'wrong' }])).complete).toBe(false);
    const conflicting = { ...child, links: [{ type: 'pr' as const, label: 'Other PR', url: 'https://github.com/other/repo/pull/999' }] };
    expect((await read(project, [initiative, conflicting])).complete).toBe(false);
    expect(gh).toHaveBeenCalledTimes(1);
  });
});
