/**
 * open-pr-overlap — the commit-time "another session's open PR changes these
 * files" signal (Echo Bugs topic 10000002588: two machines changed the same
 * reply-delivery code for a day without knowing).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  findOpenPrOverlaps,
  formatOverlapNotice,
  checkOpenPrOverlap,
  isBookkeepingPath,
} from '../../scripts/lib/open-pr-overlap.mjs';

const PRS = [
  {
    number: 3082,
    title: 'fix: a check-in no longer cancels a waiting reply',
    headRefName: 'echo/checkin-keeps-reply',
    updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    files: [{ path: 'src/messaging/PendingRelayStore.ts' }, { path: 'package.json' }],
  },
  {
    number: 3092,
    title: 'feat: conversation robustness piece 1',
    headRefName: 'echo/robustness-1',
    updatedAt: new Date(Date.now() - 1_800_000).toISOString(),
    files: [
      { path: 'src/messaging/PendingRelayStore.ts' },
      { path: 'src/monitoring/DeliveryFailureSentinel.ts' },
    ],
  },
  {
    number: 3000,
    title: 'unrelated',
    headRefName: 'echo/unrelated',
    updatedAt: new Date().toISOString(),
    files: [{ path: 'src/core/Other.ts' }],
  },
];

const NOW = Date.parse('2026-11-12T00:00:00Z');

describe('findOpenPrOverlaps', () => {
  it('flags another open PR changing a file being committed (the 11 Nov collision)', () => {
    const r = findOpenPrOverlaps(
      ['src/messaging/PendingRelayStore.ts', 'src/monitoring/DeliveryFailureSentinel.ts'],
      PRS,
      'echo/checkin-keeps-reply',
      { now: NOW },
    );
    expect(r.overlaps.map((o) => o.number)).toEqual([3092]);
    expect(r.overlaps[0].files).toEqual([
      'src/messaging/PendingRelayStore.ts',
      'src/monitoring/DeliveryFailureSentinel.ts',
    ]);
  });

  it('never flags the PR for the branch being committed on', () => {
    expect(findOpenPrOverlaps(['src/core/Other.ts'], PRS, 'echo/unrelated', { now: NOW }).overlaps).toEqual([]);
  });

  it('reports nothing when no other PR shares a file', () => {
    expect(findOpenPrOverlaps(['src/core/Fresh.ts'], PRS, null, { now: NOW }).overlaps).toEqual([]);
  });

  it('ignores bookkeeping files every PR touches', () => {
    expect(findOpenPrOverlaps(['package.json', 'upgrades/next/x.md'], PRS, null, { now: NOW }).overlaps).toEqual([]);
    expect(isBookkeepingPath('src/core/X.ts')).toBe(false);
    expect(isBookkeepingPath('.instar/instar-dev-decisions/a.json')).toBe(true);
  });

  it('orders the PR sharing the most files first', () => {
    const r = findOpenPrOverlaps(
      ['src/messaging/PendingRelayStore.ts', 'src/monitoring/DeliveryFailureSentinel.ts'],
      PRS,
      null,
      { now: NOW },
    );
    expect(r.overlaps.map((o) => o.number)).toEqual([3092, 3082]);
  });

  it('skips PRs untouched for longer than the active window', () => {
    const stale = [{ number: 145, headRefName: 'old', updatedAt: '2026-05-11T00:00:00Z', files: [{ path: 'src/a.ts' }] }];
    expect(findOpenPrOverlaps(['src/a.ts'], stale, null, { now: NOW }).overlaps).toEqual([]);
    // No usable date → kept (unknown age is not proof of staleness).
    const undated = [{ number: 146, headRefName: 'x', files: [{ path: 'src/a.ts' }] }];
    expect(findOpenPrOverlaps(['src/a.ts'], undated, null, { now: NOW }).overlaps.map((o) => o.number)).toEqual([146]);
  });

  it('summarises PRs that share only a busy wiring file instead of listing them', () => {
    const hubPrs = [1, 2, 3, 4, 5, 6].map((n) => ({
      number: n,
      headRefName: `b${n}`,
      updatedAt: '2026-11-11T00:00:00Z',
      files: [{ path: 'src/commands/server.ts' }, ...(n === 6 ? [{ path: 'src/core/Mine.ts' }] : [])],
    }));
    const r = findOpenPrOverlaps(['src/commands/server.ts', 'src/core/Mine.ts'], hubPrs, null, { now: NOW });
    expect(r.hubFiles).toEqual(['src/commands/server.ts']);
    expect(r.overlaps.map((o) => o.number)).toEqual([6]);
    expect(r.overlaps[0].files).toEqual(['src/core/Mine.ts']);
    expect(r.hubOnly.map((o) => o.number)).toEqual([5, 4, 3, 2, 1]);
  });

  it('lists several sessions colliding on one ordinary file (not mistaken for a hub)', () => {
    // Reviewer repro: 4 active PRs all changing the file being committed.
    const prs = [1, 2, 3, 4].map((n) => ({
      number: n, headRefName: `b${n}`, updatedAt: '2026-11-11T00:00:00Z',
      files: [{ path: 'src/messaging/PendingRelayStore.ts' }],
    }));
    const r = findOpenPrOverlaps(['src/messaging/PendingRelayStore.ts'], prs, null, { now: NOW });
    expect(r.hubFiles).toEqual([]);
    expect(r.overlaps.map((o) => o.number)).toEqual([4, 3, 2, 1]);
  });

  it('counts hubs across all active PRs, including ones that do not overlap the commit', () => {
    const prs = [1, 2, 3, 4, 5, 6].map((n) => ({
      number: n, headRefName: `b${n}`, updatedAt: '2026-11-11T00:00:00Z',
      files: [{ path: 'src/commands/server.ts' }],
    }));
    // Own branch b1 excluded from the listing, but still counts toward hub-ness.
    const r = findOpenPrOverlaps(['src/commands/server.ts'], prs, 'b1', { now: NOW });
    expect(r.hubFiles).toEqual(['src/commands/server.ts']);
    expect(r.hubOnly.map((o) => o.number)).toEqual([6, 5, 4, 3, 2]);
  });

  it('tolerates malformed PR rows', () => {
    const r = findOpenPrOverlaps(['a.ts'], [null, { title: 'no number' }, { number: 1, files: null }] as never, null);
    expect(r.overlaps).toEqual([]);
  });
});

describe('formatOverlapNotice', () => {
  it('names each PR, its branch and the shared files, and counts hub-only PRs', () => {
    const text = formatOverlapNotice({
      overlaps: [{ number: 3092, title: 'robustness', branch: 'echo/robustness-1', updatedAt: 'x', files: ['src/a.ts'], hubFiles: [] }],
      hubOnly: [{ number: 1, title: '', branch: 'b', updatedAt: 'x', files: [], hubFiles: ['src/commands/server.ts'] }],
      hubFiles: ['src/commands/server.ts'],
    });
    expect(text).toContain('OPEN PR OVERLAP');
    expect(text).toContain('#3092 robustness');
    expect(text).toContain('echo/robustness-1');
    expect(text).toContain('↳ src/a.ts');
    expect(text).toContain('1 more share only busy wiring files (src/commands/server.ts)');
  });

  it('still prints one line when only busy wiring files are shared (never silent)', () => {
    const text = formatOverlapNotice({ overlaps: [], hubOnly: [{ number: 7 }], hubFiles: ['src/commands/server.ts'] } as never);
    expect(text).toContain('1 other active PR(s) also change busy wiring file(s)');
    expect(text).toContain('#7');
  });

  it('is empty when nothing is shared', () => {
    expect(formatOverlapNotice({ overlaps: [], hubOnly: [], hubFiles: [] })).toBe('');
  });
});

describe('checkOpenPrOverlap', () => {
  const base = {
    env: {},
    isRepoClone: () => true,
    currentBranch: () => 'echo/checkin-keeps-reply',
  };

  it('writes the notice and reports overlap', () => {
    const written: string[] = [];
    const r = checkOpenPrOverlap({
      ...base,
      stagedFiles: ['src/messaging/PendingRelayStore.ts'],
      listOpenPrs: () => PRS,
      write: (t: string) => written.push(t),
    });
    expect(r.status).toBe('overlap');
    expect(written.join('\n')).toContain('#3092');
  });

  it('stays silent when clear', () => {
    const written: string[] = [];
    const r = checkOpenPrOverlap({
      ...base,
      stagedFiles: ['src/core/Fresh.ts'],
      listOpenPrs: () => PRS,
      write: (t: string) => written.push(t),
    });
    expect(r.status).toBe('clear');
    expect(written).toEqual([]);
  });

  it('fails open, saying overlap is unknown, when gh fails', () => {
    const written: string[] = [];
    const r = checkOpenPrOverlap({
      ...base,
      stagedFiles: ['src/core/Fresh.ts'],
      listOpenPrs: () => { throw new Error('gh: not logged in'); },
      write: (t: string) => written.push(t),
    });
    expect(r.status).toBe('degraded');
    expect(written.join('\n')).toContain('UNKNOWN');
  });

  it('never throws even if a dependency does unexpectedly', () => {
    const r = checkOpenPrOverlap({
      ...base,
      stagedFiles: ['src/core/Fresh.ts'],
      listOpenPrs: () => PRS,
      currentBranch: () => { throw new Error('boom'); },
      write: () => {},
    });
    expect(r.status).toBe('degraded');
  });

  it('skips when switched off, in CI, outside the instar repo, or with only bookkeeping files', () => {
    const listOpenPrs = () => { throw new Error('must not be called'); };
    const w = () => {};
    expect(checkOpenPrOverlap({ ...base, env: { INSTAR_PR_OVERLAP_CHECK: 'off' }, stagedFiles: ['a.ts'], listOpenPrs, write: w }).reason).toBe('off');
    expect(checkOpenPrOverlap({ ...base, env: { CI: 'true' }, stagedFiles: ['a.ts'], listOpenPrs, write: w }).reason).toBe('ci');
    expect(checkOpenPrOverlap({ ...base, isRepoClone: () => false, stagedFiles: ['a.ts'], listOpenPrs, write: w }).reason).toBe('not-repo-clone');
    expect(checkOpenPrOverlap({ ...base, stagedFiles: ['package.json'], listOpenPrs, write: w }).reason).toBe('no-files');
  });
});

describe('wiring', () => {
  it('the instar-dev pre-commit gate runs the check on every staged file before its scope exit', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../scripts/instar-dev-precommit.js'), 'utf8');
    expect(src).toContain("import { checkOpenPrOverlap } from './lib/open-pr-overlap.mjs'");
    const call = src.indexOf('checkOpenPrOverlap({ stagedFiles: [...staged, ...scopeOnlyPaths]');
    const scopeExit = src.indexOf('if (inScopeFiles.length === 0)');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(scopeExit);
  });
});
