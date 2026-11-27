/** Whole-disk attribution by owner (spec docs/specs/disk-steward.md §3.7a). Read-only. */
import { describe, it, expect } from 'vitest';
import type fs from 'node:fs';
import { measureWholeDisk, agentsFromRegistry, groupOwners, ownerOf, MAC_NOT_OPENED } from '../../src/monitoring/diskSteward/wholeDisk.js';
import { renderPost } from '../../src/monitoring/DiskStewardPoster.js';
import type { DuePost } from '../../src/monitoring/DiskSteward.js';

const GiB = 1024 ** 3;
const HOME = '/Users/me';

/** A fake home folder: directories hold names, files hold a size. */
function fakeSeams(tree: Record<string, string[] | number>, opts: { platform?: NodeJS.Platform; otherVolume?: string[]; links?: string[]; slow?: string[] } = {}) {
  const sized: string[] = [];
  const opened: string[] = [];
  let clock = 0;
  const sizeOf = (p: string): number | null => {
    const v = tree[p];
    if (typeof v === 'number') return v;
    if (!Array.isArray(v)) return null;
    return v.reduce<number>((a, n) => a + (sizeOf(`${p}/${n}`) ?? 0), 0);
  };
  return {
    sized, opened,
    tick: (ms: number) => { clock += ms; },
    now: () => clock,
    seams: {
      platform: opts.platform ?? 'darwin',
      readdir: (p: string) => { opened.push(p); const v = tree[p]; return Array.isArray(v) ? [...v] : null; },
      lstat: (p: string) => (p in tree ? ({ isSymbolicLink: () => (opts.links ?? []).includes(p), isDirectory: () => Array.isArray(tree[p]) } as unknown as fs.Stats) : null),
      devOf: (p: string) => ((opts.otherVolume ?? []).includes(p) ? 2 : 1),
      sizeOf: async (p: string) => { sized.push(p); if ((opts.slow ?? []).includes(p)) clock += 10_000_000; return sizeOf(p); },
    },
  };
}

const TREE: Record<string, string[] | number> = {
  [HOME]: ['.instar', 'Projects', 'Documents', 'Library', 'dawn-backups', '.npm'],
  [`${HOME}/.instar`]: ['agents', 'registry.json'],
  [`${HOME}/.instar/registry.json`]: 1024,
  [`${HOME}/.instar/agents`]: ['echo', 'groky'],
  [`${HOME}/.instar/agents/echo`]: 31 * GiB,
  [`${HOME}/.instar/agents/groky`]: 2 * GiB,
  [`${HOME}/Projects`]: ['sagemind', 'the-portal-prop-1', 'the-portal-prop-2'],
  [`${HOME}/Projects/sagemind`]: 79 * GiB,
  [`${HOME}/Projects/the-portal-prop-1`]: 4 * GiB,
  [`${HOME}/Projects/the-portal-prop-2`]: 3 * GiB,
  [`${HOME}/Documents`]: 50 * GiB,
  [`${HOME}/Library`]: 92 * GiB,
  [`${HOME}/dawn-backups`]: 39 * GiB,
  [`${HOME}/.npm`]: 5 * GiB,
};
const AGENTS = [
  { name: 'echo', path: `${HOME}/.instar/agents/echo` },
  { name: 'groky', path: `${HOME}/.instar/agents/groky` },
  { name: 'sagemind', path: `${HOME}/Projects/sagemind` },
];

describe('measureWholeDisk', () => {
  it('names agents as owners, groups the rest by top-level folder, and never opens the privacy folders on macOS', async () => {
    const f = fakeSeams(TREE);
    const r = await measureWholeDisk(f.seams, { home: HOME, agents: AGENTS, usedBytes: 400 * GiB, budgetMs: 600_000, now: f.now });
    const by = Object.fromEntries(r.owners.map((o) => [o.owner, o.bytes]));
    expect(by.sagemind).toBe(79 * GiB);
    expect(by.echo).toBe(31 * GiB);
    expect(by.groky).toBe(2 * GiB);
    expect(by['~/Projects']).toBe(7 * GiB); // the non-agent checkouts beside sagemind
    expect(by['~/dawn-backups']).toBe(39 * GiB);
    expect(r.owners.find((o) => o.owner === 'echo')?.agent).toBe(true);
    expect(r.owners.find((o) => o.owner === '~/dawn-backups')?.agent).toBe(false);
    // Documents and Library are neither sized nor listed.
    for (const n of MAC_NOT_OPENED) {
      expect(f.sized.some((p) => p.startsWith(`${HOME}/${n}`))).toBe(false);
      expect(f.opened.some((p) => p.startsWith(`${HOME}/${n}`))).toBe(false);
    }
    expect(r.measuredBytes).toBe((79 + 31 + 2 + 7 + 39 + 5) * GiB + 1024);
    expect(r.notOpenedBytes).toBe(400 * GiB - r.measuredBytes);
    expect(r.partial).toBe(false);
  });

  it('on Linux the same folders are measured like any other', async () => {
    const f = fakeSeams(TREE, { platform: 'linux' });
    const r = await measureWholeDisk(f.seams, { home: HOME, agents: AGENTS, usedBytes: 600 * GiB, budgetMs: 600_000, now: f.now });
    expect(r.owners.find((o) => o.owner === '~/Library')?.bytes).toBe(92 * GiB);
  });

  it('skips links and folders on another volume', async () => {
    const f = fakeSeams(TREE, { links: [`${HOME}/dawn-backups`], otherVolume: [`${HOME}/.npm`] });
    const r = await measureWholeDisk(f.seams, { home: HOME, agents: AGENTS, usedBytes: 400 * GiB, budgetMs: 600_000, now: f.now });
    expect(r.owners.map((o) => o.owner)).not.toContain('~/dawn-backups');
    expect(r.owners.map((o) => o.owner)).not.toContain('~/.npm');
  });

  it('a spent budget marks the result partial and the unsized bytes count as not opened', async () => {
    const f = fakeSeams(TREE, { slow: [`${HOME}/.instar/agents/echo`] });
    const r = await measureWholeDisk(f.seams, { home: HOME, agents: AGENTS, usedBytes: 400 * GiB, budgetMs: 600_000, now: f.now });
    expect(r.partial).toBe(true);
    expect(r.notOpenedBytes + r.measuredBytes).toBe(400 * GiB);
  });

  it('only reads: the seams it gets have no way to remove or write', async () => {
    const f = fakeSeams(TREE);
    expect(Object.keys(f.seams).sort()).toEqual(['devOf', 'lstat', 'platform', 'readdir', 'sizeOf']);
  });
});

describe('owners and the registry', () => {
  it('reads agents from the registry, drops lifelines and relative paths, and survives junk', () => {
    const raw = JSON.stringify({ entries: [
      { name: 'echo', path: '/a/echo' }, { name: 'echo-lifeline', path: '/a/echo-lifeline' },
      { name: 'bad', path: 'relative/x' }, { name: 7, path: '/a/n' },
    ] });
    expect(agentsFromRegistry(raw)).toEqual([{ name: 'echo', path: '/a/echo' }]);
    expect(agentsFromRegistry('not json')).toEqual([]);
    expect(agentsFromRegistry(null)).toEqual([]);
  });
  it('a folder is its agent only when the agent lives at or inside it', () => {
    expect(ownerOf('/a/echo', [{ name: 'echo', path: '/a/echo' }])?.name).toBe('echo');
    expect(ownerOf('/a/echo-old', [{ name: 'echo', path: '/a/echo' }])).toBeNull();
    expect(ownerOf('/a', [{ name: 'echo', path: '/a/echo' }])?.name).toBe('echo');
  });
  it('keeps the three biggest folders per owner, biggest owner first', () => {
    const g = groupOwners(HOME, [1, 2, 3, 4].map((i) => ({ path: `${HOME}/P/x${i}`, bytes: i })), []);
    expect(g[0].owner).toBe('~/P');
    expect(g[0].bytes).toBe(10);
    expect(g[0].paths.map((p) => p.name)).toEqual(['~/P/x4', '~/P/x3', '~/P/x2']);
  });
});

describe('the whole-disk line in a post', () => {
  const NOW = 1_800_000_000_000;
  const post: DuePost = {
    postId: 'p', machineId: 'm_laptop', machineName: 'Laptop', kind: 'alert', level: 'warn', critical: false,
    episodeStart: NOW, stage: 0, createdAt: NOW, free: 97 * GiB, total: 926 * GiB, change24h: null, daysToFloor: null,
    cleared: [], cacheReclaimableBytes: 0, reaperArmed: null, pruneEnabled: true, cleanupNotHelping: false, failures: 0, nextAttemptAt: NOW,
    wholeDisk: {
      at: NOW - 5 * 3_600_000, partial: false, usedBytes: 746 * GiB, measuredBytes: 446 * GiB, notOpenedBytes: 300 * GiB,
      owners: [
        { owner: 'sagemind', agent: true, bytes: 79 * GiB, paths: [] },
        { owner: '~/Projects', agent: false, bytes: 62 * GiB, paths: [] },
        { owner: '~/dawn-backups', agent: false, bytes: 39 * GiB, paths: [] },
        { owner: 'evil\nname', agent: true, bytes: 30 * GiB, paths: [] },
      ],
    },
  };
  it('says who uses the space and how much was not opened', () => {
    const text = renderPost(post, NOW);
    expect(text).toContain('Whole disk, 746 GiB used: agent sagemind 79 GiB, `~/Projects` 62 GiB, `~/dawn-backups` 39 GiB; 300 GiB is in folders I don\'t open (personal files, app data, the system) (measured 5 h ago).');
    expect(text).not.toContain('evil');
  });
  it('names the folders it did not finish counting instead of calling them unopened', () => {
    const text = renderPost({ ...post, wholeDisk: { ...post.wholeDisk!, partial: true, unfinished: ['~/.instar/agents/echo', 'bad\nname'] } }, NOW);
    expect(text).toContain("or didn't finish counting (`~/.instar/agents/echo`)");
    expect(text).toContain('partial: at least these');
    expect(text).not.toContain('bad');
  });
  it('a malformed peer measurement renders nothing instead of throwing', () => {
    const bad = { ...post, wholeDisk: { usedBytes: 5, owners: 'x' } as unknown as DuePost['wholeDisk'] };
    expect(() => renderPost(bad, NOW)).not.toThrow();
    expect(renderPost(bad, NOW)).not.toContain('Whole disk');
  });
});

describe('a slow folder cannot starve the rest (live finding 2026-11-12)', () => {
  it('each folder gets at most a quarter of what is left; a stopped walk counts as "at least"', async () => {
    const caps: Array<[string, number]> = [];
    const f = fakeSeams(TREE);
    const seams = {
      ...f.seams,
      sizeAtLeast: async (p: string, timeoutMs: number) => {
        caps.push([p, timeoutMs]);
        if (p === `${HOME}/.instar/agents/echo`) { f.tick(timeoutMs); return { bytes: 20 * GiB, complete: false }; }
        const b = await f.seams.sizeOf(p);
        return b === null ? null : { bytes: b, complete: true };
      },
    };
    const r = await measureWholeDisk(seams, { home: HOME, agents: AGENTS, usedBytes: 400 * GiB, budgetMs: 600_000, now: f.now });
    expect(caps.find(([p]) => p.endsWith('/echo'))?.[1]).toBe(150_000);
    expect(r.partial).toBe(true);
    expect(r.owners.find((o) => o.owner === 'echo')?.bytes).toBe(20 * GiB);
    // Everything after the slow folder was still measured.
    expect(r.owners.find((o) => o.owner === 'sagemind')?.bytes).toBe(79 * GiB);
    expect(r.owners.find((o) => o.owner === '~/dawn-backups')?.bytes).toBe(39 * GiB);
    expect(r.unfinished).toEqual(['~/.instar/agents/echo']);
  });
  it('a folder that printed nothing in time is named unfinished, and a known floor stands in for its size', async () => {
    const f = fakeSeams(TREE);
    const seams = {
      ...f.seams,
      sizeAtLeast: async (p: string) => {
        if (p === `${HOME}/.instar/agents/echo`) return null;
        const b = await f.seams.sizeOf(p);
        return b === null ? null : { bytes: b, complete: true };
      },
    };
    const none = await measureWholeDisk(seams, { home: HOME, agents: AGENTS, usedBytes: 400 * GiB, budgetMs: 600_000, now: f.now });
    expect(none.owners.map((o) => o.owner)).not.toContain('echo');
    expect(none.unfinished).toEqual(['~/.instar/agents/echo']);
    const floored = await measureWholeDisk(seams, {
      home: HOME, agents: AGENTS, usedBytes: 400 * GiB, budgetMs: 600_000, now: f.now,
      floors: new Map([[`${HOME}/.instar/agents/echo`, 190 * GiB]]),
    });
    expect(floored.owners[0]).toMatchObject({ owner: 'echo', bytes: 190 * GiB });
    expect(floored.unfinished).toEqual(['~/.instar/agents/echo']);
  });
});

describe('du depth-1 output and the budget', () => {
  it('uses the total line when du finished, and sums the children printed before it stopped', async () => {
    const { parseDuDepth1 } = await import('../../src/monitoring/diskSteward/pruneCategories.js');
    expect(parseDuDepth1('10\t/h/x/a\n20\t/h/x/b\n35\t/h/x\n', '/h/x', true)).toEqual({ bytes: 35 * 1024, complete: true });
    expect(parseDuDepth1('10\t/h/x/a\n20\t/h/x/b\n', '/h/x', false)).toEqual({ bytes: 30 * 1024, complete: false });
    expect(parseDuDepth1('', '/h/x', false)).toBeNull();
    // An unreadable child makes du exit non-zero though the total printed: a lower bound.
    expect(parseDuDepth1('10\t/h/x/a\n12\t/h/x\n', '/h/x', false)).toEqual({ bytes: 12 * 1024, complete: false });
  });
  it('the walk ends 2 minutes before the server kills the run, and never takes over 15 minutes', async () => {
    const { wholeDiskBudget } = await import('../../src/monitoring/diskStewardMain.js');
    expect(wholeDiskBudget({}, 0)).toBe(15 * 60_000);
    expect(wholeDiskBudget({ runDeadlineAt: 60 * 60_000 }, 0)).toBe(15 * 60_000);
    expect(wholeDiskBudget({ runDeadlineAt: 10 * 60_000 }, 0)).toBe(8 * 60_000);
    expect(wholeDiskBudget({ runDeadlineAt: 60_000 }, 0)).toBe(0);
  });
});
