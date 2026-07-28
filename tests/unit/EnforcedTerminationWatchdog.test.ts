/**
 * EnforcedTerminationWatchdog orchestration tests (Tier 1) — fake deps, no real
 * sessions. Proves: dryRun never actuates, the two-tick confirm gates a kill,
 * eligibility is respected, a failed actuation retries, the per-window cap gives
 * up loudly, and a listRuns() throw fails SAFE (no kill). Spec:
 * docs/specs/enforced-termination-watchdog.md.
 */
import { describe, it, expect } from 'vitest';
import { EnforcedTerminationWatchdog, type EnforcedTerminationAuditRow } from '../../src/monitoring/EnforcedTerminationWatchdog.js';
import type { AutonomousRunSnapshot } from '../../src/monitoring/enforcedTermination.js';

const H = 60 * 60 * 1000;
const NOW = 1_000_000_000_000;

function overrunRun(topicId = 't1'): AutonomousRunSnapshot {
  // 24h budget, started 46h ago → time-budget overrun
  return {
    topicId,
    startedAtMs: NOW - 46 * H,
    fileMtimeMs: NOW - 46 * H,
    durationSeconds: 24 * 60 * 60,
    iteration: 9,
    active: true,
    paused: false,
    moveSuspended: false,
  };
}

function harness(opts: { dryRun?: boolean; terminateOk?: boolean; runs?: AutonomousRunSnapshot[]; throwOnList?: boolean; cap?: number } = {}) {
  const audit: EnforcedTerminationAuditRow[] = [];
  const terminated: string[] = [];
  const wd = new EnforcedTerminationWatchdog(
    {
      listRuns: () => {
        if (opts.throwOnList) throw new Error('cannot read state');
        return opts.runs ?? [overrunRun()];
      },
      terminate: async (topicId) => {
        terminated.push(topicId);
        return opts.terminateOk ?? true;
      },
      audit: (row) => audit.push(row),
      now: () => NOW,
    },
    { enabled: true, dryRun: opts.dryRun ?? false, maxTerminationsPerWindow: opts.cap },
  );
  return { wd, audit, terminated };
}

describe('EnforcedTerminationWatchdog — actuation gating', () => {
  it('a single overrun tick does NOT terminate (two-phase confirm)', async () => {
    const { wd, terminated } = harness();
    await wd.tick();
    expect(terminated).toEqual([]);
    expect(wd.guardStatus().pending).toEqual(['t1']);
  });

  it('two consecutive overrun ticks → terminate once', async () => {
    const { wd, terminated } = harness();
    await wd.tick();
    await wd.tick();
    expect(terminated).toEqual(['t1']);
    expect(wd.guardStatus().terminatedCount).toBe(1);
    expect(wd.guardStatus().pending).toEqual([]); // cleared after actuation
  });

  it('dryRun: confirmed overrun logs would-terminate but NEVER actuates', async () => {
    const { wd, terminated, audit } = harness({ dryRun: true });
    await wd.tick();
    await wd.tick();
    expect(terminated).toEqual([]);
    expect(wd.guardStatus().wouldTerminateCount).toBe(1);
    expect(audit.some((r) => r.event === 'would-terminate' && r.dryRun)).toBe(true);
  });

  it('an INELIGIBLE run (paused) is never terminated even past budget', async () => {
    const paused = { ...overrunRun('p1'), paused: true };
    const { wd, terminated } = harness({ runs: [paused] });
    await wd.tick();
    await wd.tick();
    expect(terminated).toEqual([]);
  });

  it('a within-budget run is never terminated', async () => {
    const ok = { ...overrunRun('ok1'), startedAtMs: NOW - 1 * H };
    const { wd, terminated } = harness({ runs: [ok] });
    await wd.tick();
    await wd.tick();
    expect(terminated).toEqual([]);
  });

  it('a FAILED actuation leaves the topic pending and retries next tick', async () => {
    const { wd, terminated, audit } = harness({ terminateOk: false });
    await wd.tick();
    await wd.tick(); // confirmed → terminate attempted, fails
    expect(terminated).toEqual(['t1']);
    expect(audit.some((r) => r.event === 'terminate-failed')).toBe(true);
    await wd.tick(); // still overrun → retried
    expect(terminated).toEqual(['t1', 't1']);
  });

  it('the per-window cap gives up LOUDLY (cap-exceeded) instead of kill-looping', async () => {
    // cap=1: first actuation succeeds, a second distinct topic is cap-blocked
    const runs = [overrunRun('a'), overrunRun('b')];
    const { wd, terminated, audit } = harness({ runs, cap: 1 });
    await wd.tick();
    await wd.tick(); // both confirmed; cap allows only one
    expect(terminated.length).toBe(1);
    expect(audit.some((r) => r.event === 'cap-exceeded')).toBe(true);
    expect(wd.guardStatus().capExceededCount).toBeGreaterThan(0);
  });

  it('listRuns() throwing fails SAFE — no actuation, no crash', async () => {
    const { wd, terminated } = harness({ throwOnList: true });
    await expect(wd.tick()).resolves.toBeUndefined();
    await wd.tick();
    expect(terminated).toEqual([]);
  });

  it('disabled watchdog is a strict no-op', async () => {
    const audit: EnforcedTerminationAuditRow[] = [];
    const terminated: string[] = [];
    const wd = new EnforcedTerminationWatchdog(
      {
        listRuns: () => [overrunRun()],
        terminate: async (t) => { terminated.push(t); return true; },
        audit: (r) => audit.push(r),
        now: () => NOW,
      },
      { enabled: false },
    );
    await wd.tick();
    await wd.tick();
    expect(terminated).toEqual([]);
    expect(audit).toEqual([]);
  });
});
