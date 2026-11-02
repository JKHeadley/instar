/**
 * Browser care, watch-only (docs/specs/machine-self-maintenance.md, Part B): ownership, the three
 * close grounds on both sides, the keep checks, ledger reconciliation and the audit. Every reading
 * is a stub in a temp home: no real browser, process table or tmux is touched, and nothing can be
 * closed because the sweep has no close path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BrowserCareSweep, closeGround, ledgerFileName, normalizeBrowserCare, parseChromeProcesses,
  type BrowserCareDeps, type BrowserInstanceEntry, type ChromeProcess, type TabCheck,
} from '../../src/monitoring/machineMaintenance/BrowserCare.js';
import { downloadFolder, makeDownloadCheck, parseUnsavedOutput } from '../../src/core/BrowserCareProbes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MIN = 60_000;
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function entry(over: Partial<BrowserInstanceEntry> = {}): BrowserInstanceEntry {
  return {
    userDataDir: '/home/a/.instar/state/playwright-profiles/x', pid: 10, processStartTime: 'Mon Nov 2 10:00:00 2026',
    agent: 'echo', sessionName: 'echo-topic-1', topicId: '1', purpose: 'billing page', openedAt: iso(NOW - 60 * MIN),
    lastUsedAt: iso(NOW - 5 * MIN), ttlMinutes: 120, ttlDeclared: false, leaseUntil: iso(NOW + 60 * MIN), completedAt: null, ...over,
  };
}

describe('parseChromeProcesses', () => {
  it('keeps Chrome main processes with a user-data-dir and drops helpers and other apps', () => {
    const out = parseChromeProcesses([
      '  501 Mon Nov  2 10:00:00 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/h/.instar/state/playwright-profiles/a about:blank',
      '  502 Mon Nov  2 10:00:01 2026 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper --type=renderer --user-data-dir=/h/.instar/state/playwright-profiles/a',
      '  503 Mon Nov  2 10:00:02 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '  504 Mon Nov  2 10:00:03 2026 /usr/bin/vim --user-data-dir=/x',
    ].join('\n'));
    expect(out).toEqual([{ pid: 501, startTime: 'Mon Nov 2 10:00:00 2026', userDataDir: '/h/.instar/state/playwright-profiles/a' }]);
  });
});

describe('normalizeBrowserCare', () => {
  it('is always dry-run in this build and clamps nonsense', () => {
    expect(normalizeBrowserCare({ dryRun: false, maxPerAgent: -1, keepProfiles: ['a', 3] })).toMatchObject({ dryRun: true, maxPerAgent: 4, keepProfiles: ['a'] });
    expect(normalizeBrowserCare(undefined)).toMatchObject({ enabled: true, dryRun: true, idleMinutes: 30, ttlMinutes: 120 });
    expect(normalizeBrowserCare({ enabled: false }).enabled).toBe(false);
  });
});

describe('closeGround — each ground on both sides', () => {
  it('completion signal', () => {
    expect(closeGround(entry({ completedAt: iso(NOW) }), NOW, 30, true)).toMatchObject({ verdict: 'would-close', ground: 'completed' });
  });
  it('declared lifetime: kept while running even with the owner gone, eligible once over', () => {
    expect(closeGround(entry({ ttlDeclared: true, lastUsedAt: iso(NOW - 90 * MIN) }), NOW, 30, false)).toMatchObject({ verdict: 'keep', reason: 'declared-lifetime-running' });
    expect(closeGround(entry({ ttlDeclared: true, leaseUntil: iso(NOW - MIN) }), NOW, 30, true)).toMatchObject({ verdict: 'would-close', ground: 'declared-lifetime-expired' });
  });
  it('default lease expiry with a live owner closes nothing; it only reports', () => {
    expect(closeGround(entry({ leaseUntil: iso(NOW - MIN), lastUsedAt: iso(NOW - 40 * MIN) }), NOW, 30, true)).toMatchObject({ verdict: 'keep', reason: 'lease-expired-owner-alive' });
  });
  it('confirmed absent owner: idle past the limit and the session gone', () => {
    expect(closeGround(entry({ lastUsedAt: iso(NOW - 40 * MIN) }), NOW, 30, false)).toMatchObject({ verdict: 'would-close', ground: 'owner-absent' });
    expect(closeGround(entry({ lastUsedAt: iso(NOW - 20 * MIN) }), NOW, 30, false)).toMatchObject({ verdict: 'keep', reason: 'in-use' });
    expect(closeGround(entry({ lastUsedAt: iso(NOW - 40 * MIN) }), NOW, 30, null)).toMatchObject({ verdict: 'keep', reason: 'owner-unreadable' });
    expect(closeGround(entry({ lastUsedAt: iso(NOW - 40 * MIN), sessionName: null }), NOW, 30, false)).toMatchObject({ verdict: 'keep', reason: 'owner-unreadable' });
  });
  it('adopted: only its lease applies', () => {
    expect(closeGround(entry({ purpose: 'adopted', sessionName: null, lastUsedAt: iso(NOW - 99 * MIN) }), NOW, 30, null)).toMatchObject({ verdict: 'keep', reason: 'in-use' });
    expect(closeGround(entry({ purpose: 'adopted', sessionName: null, leaseUntil: iso(NOW - MIN) }), NOW, 30, null)).toMatchObject({ verdict: 'would-close', ground: 'adopted-lease-expired' });
  });
});

describe('BrowserCareSweep', () => {
  let home: string;
  let profiles: string;
  let operatorChrome: string;
  let procs: ChromeProcess[] | null;
  let tmux: string[] | null;
  let idleMs: number | null;
  let repair: boolean | null;
  let download: boolean | null;
  let tabs: TabCheck[] | 'unreadable';
  let tabChecks: number;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-care-'));
    profiles = path.join(home, '.instar', 'state', 'playwright-profiles');
    operatorChrome = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    procs = []; tmux = ['echo-topic-1']; idleMs = 60 * MIN; repair = false; download = false; tabs = ['no']; tabChecks = 0;
  });
  afterEach(() => SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/unit/machine-maintenance-browser-care.test.ts' }));

  function sweep(over: Partial<BrowserCareDeps> = {}, now = NOW): BrowserCareSweep {
    return new BrowserCareSweep({
      agentName: 'echo', agentHome: home, operatorChromeDir: operatorChrome,
      ledgerDir: path.join(home, '.instar', 'state', 'browser-instances'),
      logPath: path.join(home, 'logs', 'browser-care.jsonl'),
      settings: () => normalizeBrowserCare({}),
      listChrome: async () => procs, tmuxSessions: async () => tmux, inputIdleMs: async () => idleMs,
      signInRepairOpen: () => repair, downloadActive: async () => download,
      checkTabs: async () => { tabChecks++; return tabs; },
      now: () => now, ...over,
    });
  }
  const ledger = (s: BrowserCareSweep) => s.readLedger();
  const writeEntry = (e: BrowserInstanceEntry) => {
    const dir = path.join(home, '.instar', 'state', 'browser-instances');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ledgerFileName(e.userDataDir)), JSON.stringify(e));
  };
  const audit = () => fs.readFileSync(path.join(home, 'logs', 'browser-care.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));

  it('owns only browsers inside this agent\'s profiles folder, never the operator\'s Chrome', () => {
    const s = sweep();
    expect(s.isOwned(path.join(profiles, 'a'))).toBe(true);
    expect(s.isOwned(profiles)).toBe(false);
    expect(s.isOwned(operatorChrome)).toBe(false);
    expect(s.isOwned(path.join(operatorChrome, 'Default'))).toBe(false);
    expect(s.isOwned('/tmp/other-agent/.instar/state/playwright-profiles/a')).toBe(false);
  });

  it('adopts an owned browser with no entry, ignores the operator\'s, and counts the host', async () => {
    procs = [
      { pid: 1, startTime: 's1', userDataDir: path.join(profiles, 'a') },
      { pid: 2, startTime: 's2', userDataDir: operatorChrome },
      { pid: 3, startTime: 's3', userDataDir: '/Users/x/.instar/agents/other/.instar/state/playwright-profiles/b' },
    ];
    const s = sweep();
    await s.sweep();
    const st = s.status();
    expect(st).toMatchObject({ dryRun: true, canClose: false, owned: 1, adopted: 1, hostTotal: 2 });
    expect(st.instances[0]).toMatchObject({ profile: '.instar/state/playwright-profiles/a', purpose: 'adopted', verdict: 'keep', reason: 'in-use' });
    expect(ledger(s)).toHaveLength(1);
    expect(audit().map((r) => r.event)).toEqual(['adopted', 'keep']);
  });

  it('binds a launched entry to its process, re-adopts a reused pid, and drops an exited one', async () => {
    const a = path.join(profiles, 'a'); const b = path.join(profiles, 'b'); const c = path.join(profiles, 'c');
    writeEntry(entry({ userDataDir: a, pid: null, processStartTime: null }));
    writeEntry(entry({ userDataDir: b, pid: 20, processStartTime: 'old' }));
    writeEntry(entry({ userDataDir: c, pid: 30, processStartTime: 's30' }));
    procs = [{ pid: 10, startTime: 's10', userDataDir: a }, { pid: 20, startTime: 'new', userDataDir: b }];
    const s = sweep();
    await s.sweep();
    const byDir = new Map(ledger(s).map((e) => [e.userDataDir, e]));
    expect(byDir.get(a)).toMatchObject({ pid: 10, processStartTime: 's10', purpose: 'billing page' });
    expect(byDir.get(b)).toMatchObject({ pid: 20, processStartTime: 'new', purpose: 'adopted' });
    expect(byDir.has(c)).toBe(false);
  });

  it('would close a browser whose session is gone and which passes every check, and closes nothing', async () => {
    const a = path.join(profiles, 'a');
    writeEntry(entry({ userDataDir: a, pid: 1, processStartTime: 's1', lastUsedAt: iso(NOW - 45 * MIN) }));
    procs = [{ pid: 1, startTime: 's1', userDataDir: a }];
    tmux = ['something-else'];
    const s = sweep();
    await s.sweep();
    expect(s.status()).toMatchObject({ wouldClose: 1, canClose: false });
    expect(s.status().instances[0]).toMatchObject({ verdict: 'would-close', ground: 'owner-absent' });
    expect(audit().find((r) => r.event === 'would-close')).toMatchObject({ dryRun: true, ground: 'owner-absent', profile: '.instar/state/playwright-profiles/a' });
    expect(ledger(s)).toHaveLength(1);
  });

  it.each([
    ['operator-active', () => { idleMs = MIN; }],
    ['operator-unreadable', () => { idleMs = null; }],
    ['sign-in-repair-open', () => { repair = true; }],
    ['sign-in-repair-unreadable', () => { repair = null; }],
    ['download-active', () => { download = true; }],
    ['download-unreadable', () => { download = null; }],
    ['unsaved-input', () => { tabs = ['no', 'yes']; }],
    ['unreadable-tabs', () => { tabs = ['no', 'unreadable']; }],
    ['unreadable-tabs', () => { tabs = 'unreadable'; }],
  ])('keeps a close candidate for %s', async (reason, arrange) => {
    const a = path.join(profiles, 'a');
    writeEntry(entry({ userDataDir: a, pid: 1, processStartTime: 's1', completedAt: iso(NOW - MIN) }));
    procs = [{ pid: 1, startTime: 's1', userDataDir: a }];
    arrange();
    const s = sweep();
    await s.sweep();
    expect(s.status().instances[0]).toMatchObject({ verdict: 'keep', ground: 'completed', reason });
  });

  it('never checks tabs of a browser still in use, and never picks an allowlisted profile', async () => {
    const a = path.join(profiles, 'a'); const k = path.join(profiles, 'keepme');
    writeEntry(entry({ userDataDir: a, pid: 1, processStartTime: 's1' }));
    writeEntry(entry({ userDataDir: k, pid: 2, processStartTime: 's2', completedAt: iso(NOW) }));
    procs = [{ pid: 1, startTime: 's1', userDataDir: a }, { pid: 2, startTime: 's2', userDataDir: k }];
    const s = sweep({ settings: () => normalizeBrowserCare({ keepProfiles: ['keepme'] }) });
    await s.sweep();
    expect(tabChecks).toBe(0);
    expect(s.status().instances.map((i) => i.reason).sort()).toEqual(['allowlisted', 'in-use']);
  });

  it('bounds the per-tab checks per pass', async () => {
    procs = [];
    for (let i = 0; i < 8; i++) {
      const d = path.join(profiles, `p${i}`);
      writeEntry(entry({ userDataDir: d, pid: i + 1, processStartTime: `s${i}`, completedAt: iso(NOW) }));
      procs.push({ pid: i + 1, startTime: `s${i}`, userDataDir: d });
    }
    const s = sweep();
    await s.sweep();
    expect(tabChecks).toBe(5);
    expect(s.status().instances.filter((i) => i.reason === 'check-budget')).toHaveLength(3);
    expect(s.status()).toMatchObject({ overAgentCap: true, owned: 8 });
  });

  it('writes an audit row only when a verdict changes', async () => {
    const a = path.join(profiles, 'a');
    procs = [{ pid: 1, startTime: 's1', userDataDir: a }];
    const s = sweep();
    await s.sweep();
    await s.sweep();
    expect(audit()).toHaveLength(2);
  });

  it('an unreadable process table fails the pass; three failures pause the sweep', async () => {
    procs = null;
    const s = sweep();
    await s.sweep(); await s.sweep(); await s.sweep();
    expect(s.status().breakerUntil).not.toBeNull();
    expect(audit().some((r) => r.event === 'breaker-open')).toBe(true);
  });

  it('does nothing when switched off', async () => {
    procs = [{ pid: 1, startTime: 's1', userDataDir: path.join(profiles, 'a') }];
    const s = sweep({ settings: () => normalizeBrowserCare({ enabled: false }) });
    await s.sweep();
    expect(s.status().lastSweepAt).toBeNull();
    expect(ledger(s)).toHaveLength(0);
  });
});

describe('BrowserCareProbes', () => {
  it('parseUnsavedOutput needs every line well formed and a final done', () => {
    expect(parseUnsavedOutput('tab 1.1 no\ntab 1.2 yes\ndone\n')).toEqual(['no', 'yes']);
    expect(parseUnsavedOutput('tab 1.1 no\n')).toBe('unreadable');
    expect(parseUnsavedOutput('done')).toBe('unreadable');
    expect(parseUnsavedOutput('tab 1.1 maybe\ndone')).toBe('unreadable');
    expect(parseUnsavedOutput('NO_PID')).toBe('unreadable');
  });

  it('reads the profile download folder and a growing .crdownload', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-dl-'));
    try {
      const profile = path.join(dir, 'p'); const dl = path.join(dir, 'dl');
      fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
      fs.mkdirSync(dl);
      expect(downloadFolder(profile, dir)).toBe(path.join(dir, 'Downloads'));
      fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: dl } }));
      expect(downloadFolder(profile, dir)).toBe(dl);
      const check = makeDownloadCheck(5 * MIN, () => Date.now(), dir);
      expect(await check(profile)).toBe(false);
      fs.writeFileSync(path.join(dl, 'big.zip.crdownload'), 'x');
      expect(await check(profile)).toBe(true);
      expect(await makeDownloadCheck(5 * MIN, () => Date.now() + 10 * MIN, dir)(profile)).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/machine-maintenance-browser-care.test.ts dl' });
    }
  });
});
