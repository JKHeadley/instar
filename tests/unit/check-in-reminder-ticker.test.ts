// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier 1 — the check-in reminder server tick.
 * Spec: docs/specs/check-in-reminder-server-tick.md (CMT-1130).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CheckInReminderTicker,
  CHECK_IN_TICK_DEFAULT_INTERVAL_MS,
  CHECK_IN_TICK_FAILURE_STREAK,
  CHECK_IN_TICK_MIN_INTERVAL_MS,
  CHECK_IN_TICK_STALL_MS,
  resolveCheckInTickIntervalMs,
} from '../../src/monitoring/CheckInReminderTicker.js';
import type { CheckInReminderPassReport } from '../../src/monitoring/CheckInReminderReconciler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/check-in-reminder-ticker.test.ts' });
  }
});

function report(over: Partial<CheckInReminderPassReport> = {}): CheckInReminderPassReport {
  return {
    ran: true, dryRun: true, scanned: 2, due: 1, sent: 0, failed: 0, wouldSend: 1,
    capped: 0, dueIds: ['CMT-1'], gaveUp: 0, skippedByReason: {}, errors: [], ...over,
  };
}

function ticker(over: Partial<ConstructorParameters<typeof CheckInReminderTicker>[0]> = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-in-tick-'));
  dirs.push(stateDir);
  return new CheckInReminderTicker({
    stateDir, intervalMs: 1000, skipReason: () => null, runPass: async () => report(), ...over,
  });
}
const rows = (t: CheckInReminderTicker) =>
  fs.existsSync(t.ledgerPath) ? fs.readFileSync(t.ledgerPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [];

describe('resolveCheckInTickIntervalMs', () => {
  it('defaults when absent or nonsensical and floors a tiny value', () => {
    for (const bad of [undefined, null, 0, -5, NaN, '300000']) {
      expect(resolveCheckInTickIntervalMs(bad)).toBe(CHECK_IN_TICK_DEFAULT_INTERVAL_MS);
    }
    expect(resolveCheckInTickIntervalMs(1)).toBe(CHECK_IN_TICK_MIN_INTERVAL_MS);
    expect(resolveCheckInTickIntervalMs(60_000)).toBe(60_000);
  });
});

describe('CheckInReminderTicker.tick', () => {
  it('does not run the pass when a gate says skip, and names why', async () => {
    const runPass = vi.fn(async () => report());
    const t = ticker({ skipReason: () => 'feature-dark', runPass });
    expect(await t.tick()).toBeNull();
    expect(runPass).not.toHaveBeenCalled();
    expect(t.status()).toMatchObject({ ticks: 1, lastSkip: 'feature-dark', enabled: false });
  });

  it('re-reads the gate every tick, so a live config change takes effect', async () => {
    let skip: string | null = null;
    const runPass = vi.fn(async () => report());
    const t = ticker({ skipReason: () => skip, runPass });
    await t.tick();
    skip = 'tick-disabled';
    await t.tick();
    expect(runPass).toHaveBeenCalledTimes(1);
  });

  it('asks for a quiet pass, because dry-run logs one line per row', async () => {
    const runPass = vi.fn(async () => report());
    await ticker({ runPass }).tick();
    expect(runPass).toHaveBeenCalledWith({ quiet: true });
  });

  it('never rejects, and reports a failure streak exactly once', async () => {
    const onFailureStreak = vi.fn();
    let fail = true;
    const t = ticker({
      onFailureStreak,
      runPass: async () => { if (fail) throw new Error('boom'); return report(); },
    });
    for (let i = 0; i < CHECK_IN_TICK_FAILURE_STREAK + 2; i++) await expect(t.tick()).resolves.toBeNull();
    expect(onFailureStreak).toHaveBeenCalledTimes(1);
    expect(t.status().lastError).toContain('boom');
    fail = false;
    await t.tick();
    expect(t.status()).toMatchObject({ consecutiveFailures: 0, lastError: null });
  });

  it('raises undelivered only when a pass gave up', async () => {
    const onUndelivered = vi.fn();
    await ticker({ onUndelivered }).tick();
    expect(onUndelivered).not.toHaveBeenCalled();
    await ticker({ onUndelivered, runPass: async () => report({ gaveUp: 1, dryRun: false }) }).tick();
    expect(onUndelivered).toHaveBeenCalledTimes(1);
  });

  it('a failed undelivered notice is reported rather than thrown at the timer', async () => {
    const t = ticker({
      onUndelivered: async () => { throw new Error('attention down'); },
      runPass: async () => report({ gaveUp: 1 }),
    });
    await expect(t.tick()).resolves.toBeTruthy();
    expect(t.status().lastError).toContain('attention down');
  });

  it('a route pass that gives up raises the notice and updates status too', async () => {
    const onUndelivered = vi.fn();
    const t = ticker({ onUndelivered, runPass: async () => report({ gaveUp: 1, dryRun: false }) });
    await t.pass({ quiet: false });
    expect(onUndelivered).toHaveBeenCalledTimes(1);
    expect(t.status().lastReport?.gaveUp).toBe(1);
    expect(rows(t)).toHaveLength(1);
  });
});

describe('single-flight', () => {
  it('a route call during a tick shares the running pass', async () => {
    let release!: (r: CheckInReminderPassReport) => void;
    const runPass = vi.fn(() => new Promise<CheckInReminderPassReport>((r) => { release = r; }));
    const t = ticker({ runPass });
    const tick = t.tick();
    const route = t.pass({ quiet: false });
    release(report());
    expect(await route).toEqual(await tick);
    expect(runPass).toHaveBeenCalledTimes(1);
  });

  it('a finished pass does not block the next, even if it threw', async () => {
    const runPass = vi.fn<() => Promise<CheckInReminderPassReport>>()
      .mockRejectedValueOnce(new Error('x'))
      .mockResolvedValue(report());
    const t = ticker({ runPass });
    await expect(t.pass({ quiet: true })).rejects.toThrow('x');
    await expect(t.pass({ quiet: true })).resolves.toBeTruthy();
    expect(runPass).toHaveBeenCalledTimes(2);
  });
});

describe('a pass that never settles', () => {
  it('is reported, not overlapped, and ends once the pass settles', async () => {
    let now = 1_000_000;
    let release!: (r: CheckInReminderPassReport) => void;
    const runPass = vi.fn(() => new Promise<CheckInReminderPassReport>((r) => { release = r; }));
    const onFailureStreak = vi.fn();
    const t = ticker({ now: () => now, runPass, onFailureStreak });
    const stuck = t.tick();
    now += CHECK_IN_TICK_STALL_MS;
    for (let i = 0; i < CHECK_IN_TICK_FAILURE_STREAK; i++) expect(await t.tick()).toBeNull();
    expect(runPass).toHaveBeenCalledTimes(1);
    expect(onFailureStreak).toHaveBeenCalledTimes(1);
    expect(t.status().lastError).toBe('pass-stalled');
    expect(t.stalled()).toBe(true);
    release(report());
    await stuck;
    expect(t.status().consecutiveFailures).toBe(0);
    expect(t.stalled()).toBe(false);
  });
});

describe('soak ledger', () => {
  it('writes on change, then only hourly, with ids and never promise text', async () => {
    let now = 1_000_000;
    let ids = ['CMT-1'];
    const t = ticker({ now: () => now, runPass: async () => report({ dueIds: ids }) });
    await t.tick();
    now += 5 * 60_000;
    await t.tick();
    expect(rows(t)).toHaveLength(1);
    expect(Object.keys(rows(t)[0])).not.toContain('text');
    ids = ['CMT-1', 'CMT-2'];
    await t.tick();
    expect(rows(t)).toHaveLength(2);
    now += 61 * 60_000;
    await t.tick();
    expect(rows(t)).toHaveLength(3);
  });

  it('always records a pass that acted', async () => {
    const t = ticker({ runPass: async () => report({ sent: 1, dryRun: false }) });
    await t.tick();
    await t.tick();
    expect(rows(t)).toHaveLength(2);
  });

  it('a ledger write fault is counted and never stops the pass', async () => {
    const t = ticker();
    fs.writeFileSync(path.dirname(t.ledgerPath), 'a file, not a dir');
    await expect(t.tick()).resolves.toBeTruthy();
    expect(t.status().ledgerWriteFailures).toBe(1);
  });
});
