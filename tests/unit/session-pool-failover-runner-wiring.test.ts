// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-1 unit: the SessionPoolFailoverRunner boot-wiring seam
 * (src/core/sessionPoolFailoverRunnerConfig.ts — §Rollout, Track H).
 *
 * Proves the pure wiring logic with ZERO real subprocess (runProcess is injected):
 *   - resolveSessionPoolFailoverRunnerConfig: dev-gate + dryRun-first + cadence floor.
 *   - buildSessionPoolFailoverRunnerDriver: enabled → constructs, dark → null.
 *   - the driver records the verdict HONESTLY and to the RIGHT store:
 *       dryRun → the SIDE store (promotion store untouched);
 *       live   → the real promotion store;
 *       check-throws (no source) → records NOTHING in EITHER store (honest degrade).
 *   - the slow-cadence throttle: a second maybeTick inside tickIntervalMs is skipped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionPoolE2EResultStore } from '../../src/core/SessionPoolE2EResultStore.js';
import {
  resolveSessionPoolFailoverRunnerConfig,
  buildSessionPoolFailoverRunnerDriver,
  guardStatusForFailoverRunner,
  DEFAULT_FAILOVER_RUNNER_TICK_INTERVAL_MS,
  MIN_FAILOVER_RUNNER_TICK_INTERVAL_MS,
  type SessionPoolFailoverRunnerResolvedConfig,
} from '../../src/core/sessionPoolFailoverRunnerConfig.js';
import type { SubprocessRunResult } from '../../src/core/sessionPoolFailoverCheck.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'failover-runner-wiring-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/session-pool-failover-runner-wiring.test.ts' });
});

function makeStore(dir: string, name: string): SessionPoolE2EResultStore {
  return new SessionPoolE2EResultStore({
    filePath: path.join(dir, name),
    sign: (c) => `sig:${c.length}`,
    verifySig: (c, s) => s === `sig:${c.length}`,
  });
}

/** A gate that echoes the explicit value or, when undefined, the given default (a stand-in for resolveDevAgentGate). */
function gate(defaultWhenUndefined: boolean) {
  return (explicit: boolean | undefined) => (typeof explicit === 'boolean' ? explicit : defaultWhenUndefined);
}

describe('resolveSessionPoolFailoverRunnerConfig', () => {
  it('rides the dev gate when enabled is omitted (dark on the fleet, live on a dev agent)', () => {
    expect(resolveSessionPoolFailoverRunnerConfig({ dryRun: true }, gate(false)).enabled).toBe(false); // fleet
    expect(resolveSessionPoolFailoverRunnerConfig({ dryRun: true }, gate(true)).enabled).toBe(true); // dev
  });

  it('an explicit enabled overrides the gate', () => {
    expect(resolveSessionPoolFailoverRunnerConfig({ enabled: true }, gate(false)).enabled).toBe(true);
    expect(resolveSessionPoolFailoverRunnerConfig({ enabled: false }, gate(true)).enabled).toBe(false);
  });

  it('dryRun defaults TRUE (the graduated-rollout first rung)', () => {
    expect(resolveSessionPoolFailoverRunnerConfig(undefined, gate(true)).dryRun).toBe(true);
    expect(resolveSessionPoolFailoverRunnerConfig({ dryRun: false }, gate(true)).dryRun).toBe(false);
  });

  it('tickIntervalMs defaults to 1h and is floored so it can never hot-loop', () => {
    expect(resolveSessionPoolFailoverRunnerConfig(undefined, gate(true)).tickIntervalMs).toBe(DEFAULT_FAILOVER_RUNNER_TICK_INTERVAL_MS);
    expect(resolveSessionPoolFailoverRunnerConfig({ tickIntervalMs: 1000 }, gate(true)).tickIntervalMs).toBe(MIN_FAILOVER_RUNNER_TICK_INTERVAL_MS);
    expect(resolveSessionPoolFailoverRunnerConfig({ tickIntervalMs: 7_200_000 }, gate(true)).tickIntervalMs).toBe(7_200_000);
  });

  it('checkTimeoutMs defaults to 180s and rejects non-positive/NaN', () => {
    expect(resolveSessionPoolFailoverRunnerConfig(undefined, gate(true)).checkTimeoutMs).toBe(180_000);
    expect(resolveSessionPoolFailoverRunnerConfig({ checkTimeoutMs: 0 }, gate(true)).checkTimeoutMs).toBe(180_000);
    expect(resolveSessionPoolFailoverRunnerConfig({ checkTimeoutMs: 5_000 }, gate(true)).checkTimeoutMs).toBe(5_000);
  });

  it('guardStatusForFailoverRunner grades dark ▸ dry-run ▸ live', () => {
    const mk = (enabled: boolean, dryRun: boolean): SessionPoolFailoverRunnerResolvedConfig => ({ enabled, dryRun, tickIntervalMs: 1, checkTimeoutMs: 1 });
    expect(guardStatusForFailoverRunner(mk(false, true))).toBe('dark');
    expect(guardStatusForFailoverRunner(mk(true, true))).toBe('dry-run');
    expect(guardStatusForFailoverRunner(mk(true, false))).toBe('live');
  });
});

describe('buildSessionPoolFailoverRunnerDriver — construct-or-null', () => {
  it('dark (enabled:false) → null (a strict no-op — no driver, no route status)', () => {
    const dir = tmp();
    const driver = buildSessionPoolFailoverRunnerDriver({
      config: { enabled: false, dryRun: true, tickIntervalMs: 60_000, checkTimeoutMs: 1000 },
      resultStore: makeStore(dir, 'real.json'),
      dryRunResultStore: makeStore(dir, 'dry.json'),
      runProcess: async () => ({ ranToCompletion: true, exitCode: 0, evidenceRef: 'x' }),
      currentCommitSha: () => 'abc',
      provenStage: () => 0,
    });
    expect(driver).toBeNull();
  });

  it('enabled → constructs a driver whose status reflects the resolved gate', () => {
    const dir = tmp();
    const driver = buildSessionPoolFailoverRunnerDriver({
      config: { enabled: true, dryRun: true, tickIntervalMs: 60_000, checkTimeoutMs: 1000 },
      resultStore: makeStore(dir, 'real.json'),
      dryRunResultStore: makeStore(dir, 'dry.json'),
      runProcess: async () => ({ ranToCompletion: true, exitCode: 0, evidenceRef: 'x' }),
      currentCommitSha: () => 'abc',
      provenStage: () => 0,
    });
    expect(driver).not.toBeNull();
    const s = driver!.status();
    expect(s.enabled).toBe(true);
    expect(s.dryRun).toBe(true);
    expect(s.resultsSink).toBe('dry-run');
    expect(s.provenStage).toBe(0);
    expect(s.commitSha).toBe('abc');
    expect(s.lastOutcome).toBeNull(); // never ran yet
    expect(s.counters).toEqual({ ticks: 0, recordedGreen: 0, recordedRed: 0, errored: 0 });
  });
});

describe('SessionPoolFailoverRunnerDriver — honest recording to the right store', () => {
  it('dryRun: a green lands in the SIDE store, NEVER the promotion store', async () => {
    const dir = tmp();
    const realStore = makeStore(dir, 'real.json');
    const dryStore = makeStore(dir, 'dry.json');
    const driver = buildSessionPoolFailoverRunnerDriver({
      config: { enabled: true, dryRun: true, tickIntervalMs: 60_000, checkTimeoutMs: 1000 },
      resultStore: realStore,
      dryRunResultStore: dryStore,
      runProcess: async (): Promise<SubprocessRunResult> => ({ ranToCompletion: true, exitCode: 0, evidenceRef: 'ev-green' }),
      currentCommitSha: () => 'sha1',
      provenStage: () => 0,
    })!;
    const r = await driver.maybeTick();
    expect(r).toEqual({ ran: true, outcome: 'green' });
    // The promotion store the StageAdvancer reads is UNTOUCHED.
    expect(realStore.all()).toHaveLength(0);
    // The would-record green is captured in the SIDE store only.
    expect(dryStore.all()).toHaveLength(1);
    expect(dryStore.all()[0]).toMatchObject({ stage: 0, result: 'green', commitSha: 'sha1', evidenceRef: 'ev-green' });
    const s = driver.status();
    expect(s.lastOutcome).toBe('green');
    expect(s.lastRecorded).toBe(true);
    expect(s.counters.recordedGreen).toBe(1);
  });

  it('live (dryRun:false): a green lands in the REAL promotion store', async () => {
    const dir = tmp();
    const realStore = makeStore(dir, 'real.json');
    const dryStore = makeStore(dir, 'dry.json');
    const driver = buildSessionPoolFailoverRunnerDriver({
      config: { enabled: true, dryRun: false, tickIntervalMs: 60_000, checkTimeoutMs: 1000 },
      resultStore: realStore,
      dryRunResultStore: dryStore,
      runProcess: async (): Promise<SubprocessRunResult> => ({ ranToCompletion: true, exitCode: 0, evidenceRef: 'ev' }),
      currentCommitSha: () => 'sha2',
      provenStage: () => 0,
    })!;
    await driver.maybeTick();
    expect(realStore.all()).toHaveLength(1);
    expect(realStore.all()[0]).toMatchObject({ result: 'green', commitSha: 'sha2' });
    expect(dryStore.all()).toHaveLength(0);
    expect(driver.status().resultsSink).toBe('real');
  });

  it('a genuine regression (exit non-zero) records RED', async () => {
    const dir = tmp();
    const dryStore = makeStore(dir, 'dry.json');
    const driver = buildSessionPoolFailoverRunnerDriver({
      config: { enabled: true, dryRun: true, tickIntervalMs: 60_000, checkTimeoutMs: 1000 },
      resultStore: makeStore(dir, 'real.json'),
      dryRunResultStore: dryStore,
      runProcess: async (): Promise<SubprocessRunResult> => ({ ranToCompletion: true, exitCode: 1, evidenceRef: 'ev-red' }),
      currentCommitSha: () => 'sha3',
      provenStage: () => 0,
    })!;
    const r = await driver.maybeTick();
    expect(r).toEqual({ ran: true, outcome: 'red' });
    expect(dryStore.all()[0]).toMatchObject({ result: 'red' });
    expect(driver.status().counters.recordedRed).toBe(1);
  });

  it('honest degrade: no source/vitest (ranToCompletion:false) → the check throws → records NOTHING in either store', async () => {
    const dir = tmp();
    const realStore = makeStore(dir, 'real.json');
    const dryStore = makeStore(dir, 'dry.json');
    const driver = buildSessionPoolFailoverRunnerDriver({
      config: { enabled: true, dryRun: true, tickIntervalMs: 60_000, checkTimeoutMs: 1000 },
      resultStore: realStore,
      dryRunResultStore: dryStore,
      // Mirrors a deployed agent with no checkout: the subprocess could not run.
      runProcess: async (): Promise<SubprocessRunResult> => ({ ranToCompletion: false, exitCode: null, evidenceRef: 'no-source' }),
      currentCommitSha: () => 'sha4',
      provenStage: () => 0,
    })!;
    const r = await driver.maybeTick();
    expect(r).toEqual({ ran: true, outcome: 'error' });
    expect(realStore.all()).toHaveLength(0);
    expect(dryStore.all()).toHaveLength(0); // a throw is NOT a verdict — nothing is fabricated
    const s = driver.status();
    expect(s.lastOutcome).toBe('error');
    expect(s.lastRecorded).toBe(false);
    expect(s.counters.errored).toBe(1);
  });
});

describe('SessionPoolFailoverRunnerDriver — slow-cadence throttle', () => {
  it('a second maybeTick within tickIntervalMs is skipped (the heavy E2E never hot-loops)', async () => {
    const dir = tmp();
    let now = 1_000_000;
    let runCount = 0;
    const driver = buildSessionPoolFailoverRunnerDriver({
      config: { enabled: true, dryRun: true, tickIntervalMs: 3_600_000, checkTimeoutMs: 1000 },
      resultStore: makeStore(dir, 'real.json'),
      dryRunResultStore: makeStore(dir, 'dry.json'),
      runProcess: async (): Promise<SubprocessRunResult> => { runCount += 1; return { ranToCompletion: true, exitCode: 0, evidenceRef: `ev${runCount}` }; },
      currentCommitSha: () => 'sha',
      provenStage: () => 0,
      now: () => now,
    })!;
    expect(await driver.maybeTick()).toEqual({ ran: true, outcome: 'green' });
    now += 60_000; // well within the 1h cadence
    expect(await driver.maybeTick()).toBeNull(); // throttled
    expect(runCount).toBe(1);
    now += 3_600_000; // past the cadence
    expect(await driver.maybeTick()).toEqual({ ran: true, outcome: 'green' });
    expect(runCount).toBe(2);
  });

  it('a dark driver is never constructed, so nothing can tick — proven by the factory returning null', () => {
    const dir = tmp();
    expect(
      buildSessionPoolFailoverRunnerDriver({
        config: { enabled: false, dryRun: true, tickIntervalMs: 60_000, checkTimeoutMs: 1000 },
        resultStore: makeStore(dir, 'real.json'),
        dryRunResultStore: makeStore(dir, 'dry.json'),
        runProcess: async () => ({ ranToCompletion: true, exitCode: 0, evidenceRef: 'x' }),
        currentCommitSha: () => 'sha',
        provenStage: () => 0,
      }),
    ).toBeNull();
  });
});
