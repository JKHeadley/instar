/**
 * restart-lock-continuity part A: boot session census.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BootSessionCensus, readBootAt, buildOpenWorkNotice, bootCensusDeps, UNREVIEWED_BACKLOG_LIMIT, type ClassifyDeps } from '../../src/core/BootSessionCensus.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { Session } from '../../src/core/types.js';

const BOOT = Date.parse('2026-11-18T05:20:00Z');
const sess = (over: Partial<Session>): Session => ({
  id: 'id-' + Math.random().toString(36).slice(2), name: 'n', status: 'running', tmuxSession: 'echo-x',
  startedAt: '2026-11-17T20:00:00Z', ...over,
} as Session);

function deps(over: Partial<ClassifyDeps> & { records?: Record<string, Session | null> } = {}): ClassifyDeps {
  const records = over.records ?? {};
  return {
    getSession: (id) => (id in records ? records[id] : null),
    isTopicActive: () => false,
    isTmuxAlive: () => false,
    hasOpenWork: () => false,
    autonomousActive: () => false,
    reconcilerEnabled: false,
    serverStartedAt: BOOT + 60_000,
    now: () => BOOT + 20 * 60_000,
    ...over,
  };
}

describe('boot session census', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/boot-session-census.test.ts' }); });

  it('captures only records alive at the previous shutdown (started before boot, still running/starting)', () => {
    const c = new BootSessionCensus({ stateDir: dir, bootAt: BOOT });
    const r = c.capture([
      sess({ id: 'a', status: 'running', telegramTopicId: 144503 }),
      sess({ id: 'b', status: 'starting' }),
      sess({ id: 'c', status: 'completed' }),
      sess({ id: 'd', status: 'running', startedAt: '2026-11-18T06:00:00Z' }), // created after this boot
    ]);
    expect(r.written).toBe(true);
    expect(c.current()!.entries.map((e) => e.sessionId).sort()).toEqual(['a', 'b']);
    expect(c.current()!.entries.find((e) => e.sessionId === 'a')!.topicId).toBe(144503);
  });

  it('a server restart in the same boot keeps the first census', () => {
    new BootSessionCensus({ stateDir: dir, bootAt: BOOT }).capture([sess({ id: 'a' })]);
    const again = new BootSessionCensus({ stateDir: dir, bootAt: BOOT + 30_000 }); // within slack
    expect(again.capture([]).written).toBe(false);
    expect(again.current()!.entries).toHaveLength(1);
  });

  it('writes nothing when the boot time is unreadable', () => {
    const c = new BootSessionCensus({ stateDir: dir, bootAt: null });
    expect(c.capture([sess({})])).toEqual({ written: false, reason: 'boot time unreadable' });
  });

  it('classifies by session id: ended on the awake machine (purge) and on a standby (exit monitor)', () => {
    const c = new BootSessionCensus({ stateDir: dir, bootAt: BOOT });
    c.capture([sess({ id: 'awake' }), sess({ id: 'standby' }), sess({ id: 'still' })]);
    const out = c.classify(c.current()!, deps({ records: {
      awake: sess({ id: 'awake', status: 'completed' }),
      standby: sess({ id: 'standby', status: 'completed' }),
      still: sess({ id: 'still', status: 'running' }),
    }, isTmuxAlive: (n) => n === 'alive' }));
    const by = Object.fromEntries(out.map((e) => [e.sessionId, e.end]));
    expect(by.awake).toBe('ended');
    expect(by.standby).toBe('ended');
    expect(by.still).toBe('ended (unconfirmed)'); // running record, no tmux, 15 min past start
  });

  it('a record still running before the 15-minute settle is not yet called ended', () => {
    const c = new BootSessionCensus({ stateDir: dir, bootAt: BOOT });
    c.capture([sess({ id: 'x' })]);
    const out = c.classify(c.current()!, deps({ records: { x: sess({ id: 'x' }) }, now: () => BOOT + 5 * 60_000 }));
    expect(out[0].end).toBe('running');
  });

  it('marks open work, autonomous and unknown; never "none" for an unreadable tracker', () => {
    const c = new BootSessionCensus({ stateDir: dir, bootAt: BOOT });
    c.capture([sess({ id: 'w', telegramTopicId: 1 }), sess({ id: 'a', telegramTopicId: 2 }), sess({ id: 'u', telegramTopicId: 3 })]);
    const out = c.classify(c.current()!, deps({
      hasOpenWork: (t) => { if (t === 3) throw new Error('tracker unreadable'); return t === 1; },
      autonomousActive: (t) => t === 2,
    }));
    const by = Object.fromEntries(out.map((e) => [e.sessionId, e.mark]));
    expect(by).toEqual({ w: 'open work', a: 'autonomous (reconciler dark)', u: 'unknown' });
  });

  it('labels an entry that started before the previous boot, and uses the age fallback with no older census', () => {
    const prev = Date.parse('2026-11-10T00:00:00Z');
    new BootSessionCensus({ stateDir: dir, bootAt: prev }).capture([]);
    const c = new BootSessionCensus({ stateDir: dir, bootAt: BOOT });
    c.capture([sess({ id: 'old', startedAt: '2026-11-05T00:00:00Z' }), sess({ id: 'new', startedAt: '2026-11-17T00:00:00Z' })]);
    const by = Object.fromEntries(c.classify(c.current()!, deps()).map((e) => [e.sessionId, e.age]));
    expect(by).toEqual({ old: 'started before previous boot', new: null });

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'census2-'));
    const c2 = new BootSessionCensus({ stateDir: dir2, bootAt: BOOT });
    c2.capture([sess({ id: 'old', startedAt: '2026-11-05T00:00:00Z' })]);
    expect(c2.classify(c2.current()!, deps())[0].age).toBe('old (previous boot unknown)');
    SafeFsExecutor.safeRmSync(dir2, { recursive: true, force: true, operation: 'tests/unit/boot-session-census.test.ts' });
  });

  it('notice: names open-work and reconciler-dark sessions not active again; nothing otherwise', () => {
    const c = new BootSessionCensus({ stateDir: dir, bootAt: BOOT });
    c.capture([sess({ id: 'w', telegramTopicId: 11 }), sess({ id: 'back', telegramTopicId: 12 })]);
    const out = c.classify(c.current()!, deps({ hasOpenWork: () => true, isTopicActive: (t) => t === 12 }));
    const notice = buildOpenWorkNotice(out)!;
    expect(notice).toContain('topics 11');
    expect(notice).not.toContain('12');
    expect(notice).toContain('phase 2');
    expect(buildOpenWorkNotice(c.classify(c.current()!, deps()))).toBeNull();
  });

  it('notice is marked sent at most once per boot', () => {
    const c = new BootSessionCensus({ stateDir: dir, bootAt: BOOT });
    c.capture([]);
    expect(c.markNoticeSent()).toBe(true);
    expect(c.markNoticeSent()).toBe(false);
  });

  it('retention: unreviewed files are never removed; reviewed ones older than 30 days are', () => {
    const old = BOOT - 40 * 24 * 3600_000;
    new BootSessionCensus({ stateDir: dir, bootAt: old }).capture([]);
    new BootSessionCensus({ stateDir: dir, bootAt: old + 3600_000 }).capture([]);
    const c = new BootSessionCensus({ stateDir: dir, bootAt: BOOT });
    c.capture([]);
    expect(c.prune(BOOT).removed).toBe(0);
    c.markReviewed(old);
    const r = c.prune(BOOT);
    expect(r.removed).toBe(1);
    expect(c.listFiles().files.map((f) => f.bootAt)).toEqual([old + 3600_000, BOOT]);
  });

  it('a backlog over the limit is reported, nothing dropped', () => {
    const d = path.join(dir, 'state', 'boot-session-census');
    fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i <= UNREVIEWED_BACKLOG_LIMIT; i++) {
      fs.writeFileSync(path.join(d, `${1000 + i * 120_000}.json`), JSON.stringify({ v: 1, bootAt: 1000 + i * 120_000, writtenAt: 'x', entries: [] }));
    }
    const c = new BootSessionCensus({ stateDir: dir, bootAt: BOOT });
    const r = c.prune(BOOT);
    expect(r.backlog).toBe(true);
    expect(r.removed).toBe(0);
  });

  it('readBootAt: macOS sysctl, Linux btime, uptime fallback rounded, null when unreadable', () => {
    expect(readBootAt({ platform: 'darwin', exec: () => '{ sec = 1795000000, usec = 1 } Tue' })).toBe(1795000000_000);
    expect(readBootAt({ platform: 'linux', readFile: () => 'cpu 1 2\nbtime 1795000000\n' })).toBe(1795000000_000);
    expect(readBootAt({ platform: 'win32', uptimeSec: () => 3600, now: () => 1795003630_000 })).toBe(Math.round((1795003630_000 - 3600_000) / 60_000) * 60_000);
    expect(readBootAt({ platform: 'win32', uptimeSec: () => { throw new Error('x'); } })).toBeNull();
  });

  it('production deps: open work uses the commitment predicate without the 6-hour creation window', () => {
    const d = bootCensusDeps({
      state: { getSession: () => null },
      sessionManager: { listRunningSessions: () => [], isSessionAlive: () => false },
      commitmentTracker: { getActiveByTopicId: () => [{ id: 'CMT-1', status: 'pending', createdAt: '2026-11-01T00:00:00Z' } as never] },
      ownMachineId: undefined,
      activeAutonomousTopics: () => new Set(),
      reconcilerEnabled: false,
      serverStartedAt: BOOT,
      now: () => BOOT,
    });
    expect(d.hasOpenWork(5)).toBe(true);
  });
});
