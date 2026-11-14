/** DiskSteward heal-then-notify cycle, cadence and holder delivery (spec docs/specs/disk-steward.md §3.4–§3.5). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiskSteward, type DiskStewardDeps, type DuePost, type PeerHandle } from '../../src/monitoring/DiskSteward.js';
import type { PruneChildResult } from '../../src/monitoring/diskStewardMain.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const GiB = 1024 ** 3;
const TOTAL = 926 * GiB;
const MIN = 60_000;

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-steward-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/diskSteward.test.ts' }); });

function harness(o: { holder?: boolean; prune?: boolean; freeAfterPrune?: number; peers?: PeerHandle[]; sendFails?: boolean } = {}) {
  let now = 1_800_000_000_000;
  let free = 200 * GiB;
  const sent: DuePost[] = [];
  const runs: Array<{ trigger: string; dryRun: boolean }> = [];
  const logs: Array<Record<string, unknown>> = [];
  const degrades: string[] = [];
  const result = (dryRun: boolean): PruneChildResult => ({
    runId: 'r' + runs.length, startedAt: now, finishedAt: now, trigger: 'auto', dryRun,
    categories: [{ category: 'npm-cache', plannedBytes: 9 * GiB, plannedItems: 1, removedItems: dryRun ? 0 : 1, bytesFreed: dryRun ? 0 : 9 * GiB }],
    bytesFreed: dryRun ? 0 : 9 * GiB, statfsBefore: free, statfsAfter: free, cachesLock: 'held',
  });
  const deps: DiskStewardDeps = {
    machineId: 'm_studio', machineName: () => 'Mac Studio', agentHome: dir,
    stateFile: path.join(dir, 'state.json'), now: () => now,
    statfs: () => ({ free, total: TOTAL }),
    isHolder: () => o.holder ?? true,
    runner: {
      start: (req) => {
        runs.push({ trigger: req.trigger, dryRun: req.dryRun });
        if (!req.dryRun && o.freeAfterPrune !== undefined) free = o.freeAfterPrune;
        return { record: { runId: 'r' + runs.length, deadline: now + 30 * MIN, resultPath: '', startedAt: now, trigger: req.trigger, dryRun: req.dryRun }, done: Promise.resolve(result(req.dryRun)) };
      },
      running: () => null,
    },
    pruneEnabled: () => !!o.prune, pruneDryRun: () => false, reaperArmed: () => false,
    thresholds: () => ({ warnPercent: 15, warnMinGiB: 100, escalatePercent: 10, escalateMinGiB: 60, forecastEscalateDays: 3 }),
    pruneMinIntervalMs: () => 6 * 60 * MIN,
    peers: async () => o.peers ?? [],
    send: async (p) => { if (o.sendFails) throw new Error('telegram down'); sent.push(p); return 'posted'; },
    log: (e) => { logs.push(e); },
    degrade: (f) => { degrades.push(f); },
  };
  const make = () => new DiskSteward(deps);
  return {
    deps, make, sent, runs, logs, degrades,
    setFree: (g: number) => { free = g * GiB; },
    advance: (ms: number) => { now += ms; },
    async tickAll(s: DiskSteward) { await s.tick(); await s.settle(); await s.tick(); },
  };
}

describe('DiskSteward', () => {
  it('is quiet on a healthy disk', async () => {
    const h = harness();
    const s = h.make();
    await h.tickAll(s);
    expect(h.sent).toEqual([]);
    expect(h.runs).toEqual([]);
    expect(s.status().level).toBe('ok');
  });

  it('below the warn line with cleanup off: plans (dry run), then posts once, naming the machine', async () => {
    const h = harness();
    const s = h.make();
    await s.tick();
    h.setFree(120); h.advance(15 * MIN);
    await h.tickAll(s);
    expect(h.runs).toEqual([{ trigger: 'auto', dryRun: true }]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ machineName: 'Mac Studio', level: 'warn', kind: 'alert', cacheReclaimableBytes: 9 * GiB });
    expect(s.status().duePost).toBeNull();
    // the next tick inside the repeat window does not post again
    h.advance(15 * MIN);
    await h.tickAll(s);
    expect(h.sent).toHaveLength(1);
  });

  it('heal first: when the cleanup fixes it, nothing is posted', async () => {
    const h = harness({ prune: true, freeAfterPrune: 200 * GiB });
    const s = h.make();
    await s.tick();
    h.setFree(120); h.advance(15 * MIN);
    await h.tickAll(s);
    expect(h.runs).toEqual([{ trigger: 'auto', dryRun: false }]);
    expect(h.sent).toEqual([]);
    expect(h.logs.some((l) => l.event === 'healed')).toBe(true);
  });

  it('still low after the cleanup: posts what was cleared', async () => {
    const h = harness({ prune: true, freeAfterPrune: 125 * GiB });
    const s = h.make();
    await s.tick();
    h.setFree(120); h.advance(15 * MIN);
    await h.tickAll(s);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].cleared).toEqual([{ category: 'npm-cache', bytes: 9 * GiB }]);
  });

  it('repeats a warn after 24 h, and posts once when it recovers', async () => {
    const h = harness();
    const s = h.make();
    await s.tick();
    h.setFree(120); h.advance(15 * MIN);
    await h.tickAll(s);
    h.advance(24 * 60 * MIN);
    await h.tickAll(s);
    expect(h.sent).toHaveLength(2);
    h.setFree(200);
    h.advance(15 * MIN); await h.tickAll(s);
    h.advance(15 * MIN); await h.tickAll(s);
    h.advance(15 * MIN); await h.tickAll(s);
    expect(h.sent.at(-1)!.kind).toBe('recovery');
    expect(s.status().level).toBe('ok');
  });

  it('critical with nothing to clear: repeats back off to once a day, and a 2% drop posts again at once (2026-11-12)', async () => {
    const h = harness({ prune: true, freeAfterPrune: 30 * GiB });
    const s = h.make();
    await s.tick();
    h.setFree(30); h.advance(15 * MIN);
    await h.tickAll(s);
    expect(h.sent.filter((p) => p.kind === 'alert')).toHaveLength(1);
    expect(h.sent[0].critical).toBe(true);
    // Four days with the disk steady: the old fixed 2 h repeat posted 48 times.
    for (let i = 0; i < 4 * 96; i++) { h.advance(15 * MIN); await h.tickAll(s); }
    const steady = h.sent.filter((p) => p.kind === 'alert').length;
    expect(steady).toBeLessThanOrEqual(9);
    expect(steady).toBeGreaterThanOrEqual(4);
    const times = h.sent.slice(-2).map((p) => p.createdAt);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(23 * 60 * MIN);
    // Free space falls by 2% of the disk: the next post comes at the base 2 h.
    h.setFree(10);
    const before = h.sent.length;
    for (let i = 0; i < 9; i++) { h.advance(15 * MIN); await h.tickAll(s); }
    expect(h.sent.length).toBeGreaterThan(before);
  });

  it('a restart restores the level and does not post again', async () => {
    const h = harness();
    const s = h.make();
    await s.tick();
    h.setFree(120); h.advance(15 * MIN);
    await h.tickAll(s);
    expect(h.sent).toHaveLength(1);
    const again = h.make();
    h.advance(15 * MIN);
    await h.tickAll(again);
    expect(h.sent).toHaveLength(1);
    expect(again.status().level).toBe('warn');
  });

  it('a standby never sends; its due post waits for the holder acknowledgement', async () => {
    const h = harness({ holder: false });
    const s = h.make();
    await s.tick();
    h.setFree(120); h.advance(15 * MIN);
    await h.tickAll(s);
    expect(h.sent).toEqual([]);
    const due = s.status().duePost!;
    expect(due).toBeTruthy();
    expect(s.applyAck('wrong-id', 'posted')).toBe(false);
    expect(s.applyAck(due.postId, 'posted')).toBe(true);
    expect(s.status().duePost).toBeNull();
  });

  it('the holder renders and sends a peer due post, then acknowledges it', async () => {
    const acks: Array<[string, string]> = [];
    const peerDue: DuePost = {
      postId: 'p1', machineId: 'm_laptop', machineName: 'Laptop', kind: 'alert', level: 'escalate', critical: false,
      episodeStart: 1, stage: 0, createdAt: 1, free: 30 * GiB, total: 250 * GiB, change24h: null, daysToFloor: null,
      cleared: [], cacheReclaimableBytes: 0, reaperArmed: null, pruneEnabled: false, cleanupNotHelping: false, failures: 0, nextAttemptAt: 0,
    };
    const peer: PeerHandle = {
      machineId: 'm_laptop',
      status: async () => ({ ok: true, body: { duePost: peerDue } as never }),
      ack: async (id, outcome) => { acks.push([id, outcome]); return true; },
    };
    const h = harness({ peers: [peer] });
    const s = h.make();
    await s.tick();
    expect(h.sent.map((p) => p.machineName)).toEqual(['Laptop']);
    expect(acks).toEqual([['p1', 'posted']]);
  });

  it('a failed send backs off, bumps a critical stage, and reports after 4 failures', async () => {
    const h = harness({ sendFails: true });
    const s = h.make();
    await s.tick();
    h.setFree(40); h.advance(15 * MIN); // below the floor: critical
    await h.tickAll(s);
    const due = s.status().duePost!;
    expect(due.critical).toBe(true);
    expect(due.failures).toBe(1);
    expect(due.stage).toBe(1);
    for (const wait of [15, 30, 60]) { h.advance(wait * MIN + 1); await s.tick(); }
    expect(h.degrades).toContain('DiskSteward.post');
  });

  it('a statfs failure posts nothing and is reported once', async () => {
    const h = harness();
    h.deps.statfs = () => null;
    const s = h.make();
    await s.tick(); await s.tick();
    expect(h.degrades.filter((d) => d === 'DiskSteward.measure')).toHaveLength(1);
    expect(h.sent).toEqual([]);
    expect(s.status().measured).toBe(false);
  });
});
