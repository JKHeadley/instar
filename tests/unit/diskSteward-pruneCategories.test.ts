/** Disk Steward cleanup categories (spec docs/specs/disk-steward.md §3.6). */
import { describe, it, expect } from 'vitest';
import type fs from 'node:fs';
import { pruneNpmCache, pruneDerivedData, npmBusy, xcodeBusy, parseElapsed, GiB, type PruneSeams, type ProcessRow } from '../../src/monitoring/diskSteward/pruneCategories.js';

const HOME = '/Users/x';
const DD = `${HOME}/Library/Developer/Xcode/DerivedData`;
const NOW = 1_800_000_000_000;
const st = (o: { dir?: boolean; link?: boolean; mtimeMs: number }) => ({
  isDirectory: () => !!o.dir, isSymbolicLink: () => !!o.link, mtimeMs: o.mtimeMs,
} as unknown as fs.Stats);

function seams(o: {
  npmRoot?: string | Error; cacheBytes?: number; procs?: ProcessRow[] | null | Array<ProcessRow[] | null>;
  dd?: Record<string, { mtimeMs: number; link?: boolean; realpath?: string; bytes?: number }>; dev?: Record<string, number>;
}) {
  const ran: string[][] = [];
  const removed: string[] = [];
  let procCall = 0;
  const s: PruneSeams = {
    processes: async () => {
      const p = o.procs;
      if (Array.isArray(p) && p.length && (Array.isArray(p[0]) || p[0] === null)) return (p as Array<ProcessRow[] | null>)[Math.min(procCall++, p.length - 1)];
      return (p as ProcessRow[] | null | undefined) === undefined ? [] : (p as ProcessRow[] | null);
    },
    run: async (cmd, args) => {
      ran.push([cmd, ...args]);
      if (args[0] === 'config') { if (o.npmRoot instanceof Error) throw o.npmRoot; return { stdout: (o.npmRoot ?? `${HOME}/.npm`) + '\n' }; }
      return { stdout: '' };
    },
    sizeOf: async (p) => (p.endsWith('_cacache') ? (o.cacheBytes ?? 0) : (o.dd?.[p.split('/').pop()!]?.bytes ?? GiB)),
    devOf: (p) => o.dev?.[p] ?? 1,
    readdir: (p) => (p === DD ? Object.keys(o.dd ?? {}) : null),
    lstat: (p) => {
      if (p.endsWith('_cacache')) return st({ dir: true, mtimeMs: 0 });
      if (p === DD) return st({ dir: true, mtimeMs: 0 });
      const name = p.slice(DD.length + 1).split('/')[0];
      const e = o.dd?.[name];
      if (!e) return null;
      return p === `${DD}/${name}` ? st({ dir: !e.link, link: e.link, mtimeMs: e.mtimeMs }) : st({ dir: true, mtimeMs: e.mtimeMs });
    },
    realpath: (p) => { if (p === DD) return DD; const name = p.slice(DD.length + 1); return o.dd?.[name]?.realpath ?? p; },
    remove: async (p) => { removed.push(p); },
    now: () => NOW, home: HOME, platform: 'darwin',
  };
  return { s, ran, removed };
}

describe('process predicates', () => {
  it('parses ps elapsed time', () => {
    expect(parseElapsed('05:03')).toBe(303);
    expect(parseElapsed('1:00:00')).toBe(3600);
    expect(parseElapsed('2-00:00:00')).toBe(172800);
  });
  it('npm is busy while a recent install or npx runs, not for a long-lived MCP npm exec', () => {
    expect(npmBusy([{ elapsedSec: 20, command: 'npm ci --no-audit' }])).toBe(true);
    expect(npmBusy([{ elapsedSec: 20, command: 'node /opt/npm/bin/npx-cli.js vitest' }])).toBe(true);
    expect(npmBusy([{ elapsedSec: 7200, command: 'npm exec @playwright/mcp@latest' }])).toBe(false);
    expect(npmBusy([{ elapsedSec: 20, command: 'node server.js' }])).toBe(false);
  });
  it('xcode is busy while any build tool runs', () => {
    expect(xcodeBusy([{ elapsedSec: 1, command: '/Applications/Xcode-26.6.0.app/Contents/MacOS/Xcode' }])).toBe(true);
    expect(xcodeBusy([{ elapsedSec: 1, command: '/usr/bin/xcodebuild -scheme X' }])).toBe(true);
    expect(xcodeBusy([{ elapsedSec: 1, command: '/bin/zsh' }])).toBe(false);
  });
});

describe('npm cache', () => {
  const base = { dryRun: false, maxGiB: 5, budgetMs: 600_000, agentHomeDev: 1 };
  it('cleans only above the limit, bound to the measured root', async () => {
    const { s, ran } = seams({ cacheBytes: 9 * GiB, npmRoot: '/custom/cache' });
    const r = await pruneNpmCache(s, base);
    expect(r.bytesFreed).toBe(9 * GiB);
    expect(ran.at(-1)).toEqual(['npm', 'cache', 'clean', '--force', '--cache', '/custom/cache']);
  });
  it('under the limit does nothing', async () => {
    const { s, ran } = seams({ cacheBytes: 2 * GiB });
    expect((await pruneNpmCache(s, base)).skipped).toBe('under-limit');
    expect(ran.some((c) => c[1] === 'cache')).toBe(false);
  });
  it('skips while npm is busy, re-reading the process list right before cleaning', async () => {
    const { s, ran } = seams({ cacheBytes: 9 * GiB, procs: [[], [{ elapsedSec: 3, command: 'npm ci' }]] });
    expect((await pruneNpmCache(s, base)).skipped).toBe('npm-busy');
    expect(ran.some((c) => c[1] === 'cache')).toBe(false);
  });
  it('an unreadable process list means busy', async () => {
    const { s } = seams({ cacheBytes: 9 * GiB, procs: null });
    expect((await pruneNpmCache(s, base)).skipped).toBe('process-list-unreadable');
  });
  it('a cache on another volume is skipped; npm missing is not-installed', async () => {
    const other = seams({ cacheBytes: 9 * GiB, dev: { [`${HOME}/.npm/_cacache`]: 2 } });
    expect((await pruneNpmCache(other.s, base)).skipped).toBe('other-volume');
    const missing = seams({ npmRoot: Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }) });
    expect((await pruneNpmCache(missing.s, base)).skipped).toBe('not-installed');
  });
  it('a dry run plans without cleaning', async () => {
    const { s, ran } = seams({ cacheBytes: 9 * GiB });
    const r = await pruneNpmCache(s, { ...base, dryRun: true });
    expect(r).toMatchObject({ plannedBytes: 9 * GiB, skipped: 'dry-run', bytesFreed: 0 });
    expect(ran.some((c) => c[1] === 'cache')).toBe(false);
  });
});

describe('Xcode DerivedData', () => {
  const base = { dryRun: false, budgetMs: 600_000, agentHomeDev: 1 };
  const old = NOW - 48 * 3_600_000;
  const fresh = NOW - 2 * 3_600_000;
  it('removes only entries older than 24 h, never a symlink or an escaping entry', async () => {
    const { s, removed } = seams({ dd: {
      'App-abcdefghijklmnopqrstuvwxyzab': { mtimeMs: old, bytes: 3 * GiB },
      'App-bcdefghijklmnopqrstuvwxyzabc': { mtimeMs: fresh },
      'Linked-cdefghijklmnopqrstuvwxyzabcd': { mtimeMs: old, link: true },
      'Escapes-defghijklmnopqrstuvwxyzabcde': { mtimeMs: old, realpath: '/Users/x/Documents/precious' },
    } });
    const r = await pruneDerivedData(s, base);
    expect(removed).toEqual([`${DD}/App-abcdefghijklmnopqrstuvwxyzab`]);
    expect(r).toMatchObject({ plannedItems: 1, removedItems: 1, bytesFreed: 3 * GiB });
  });
  it('stops while an Xcode build tool runs', async () => {
    const { s, removed } = seams({ dd: { 'App-abcdefghijklmnopqrstuvwxyzab': { mtimeMs: old } }, procs: [{ elapsedSec: 1, command: '/usr/bin/xcodebuild build' }] });
    expect((await pruneDerivedData(s, base)).skipped).toBe('xcode-busy');
    expect(removed).toEqual([]);
  });
  it('never touches a folder Xcode did not name, or a relocated (symlinked) DerivedData', async () => {
    const odd = seams({ dd: { 'MyProject': { mtimeMs: old } } });
    expect((await pruneDerivedData(odd.s, base)).plannedItems).toBe(0);
    const relocated = seams({ dd: { 'App-abcdefghijklmnopqrstuvwxyzab': { mtimeMs: old } } });
    const lstat = relocated.s.lstat;
    relocated.s.lstat = (p) => (p === DD ? ({ isDirectory: () => false, isSymbolicLink: () => true, mtimeMs: 0 } as unknown as fs.Stats) : lstat(p));
    expect((await pruneDerivedData(relocated.s, base)).skipped).toBe('derived-data-not-a-plain-folder');
    expect(relocated.removed).toEqual([]);
  });

  it('skips off macOS and when Xcode is absent', async () => {
    const lin = seams({}); lin.s.platform = 'linux';
    expect((await pruneDerivedData(lin.s, base)).skipped).toBe('not-macos');
    const none = seams({}); none.s.lstat = () => null;
    expect((await pruneDerivedData(none.s, base)).skipped).toBe('not-installed');
  });
});
