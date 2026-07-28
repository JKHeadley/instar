/**
 * hostTestRunnerSemaphore unit tests — the §5 unit tier of
 * docs/specs/test-runner-concurrency-bound.md.
 *
 * Every describe/it is named after the spec clause it covers so coverage is
 * auditable against the §5 unit bullet. All filesystem fixtures live in
 * per-test mkdtemp dirs injected through the module's `paths` seam
 * (resolveTestRunnerPaths / deps.paths) — the real ~/.instar is never touched.
 *
 * Clauses that need REAL vitest process spawning (acquire-before-fanout,
 * measured worker counts, K-simultaneous-roots mass-admit) are delegated to
 * the meta-verification tier per the spec — not faked here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  HOST_TEST_POISON_CEILING,
  HOST_TEST_SUITE_CAP_CEILING,
  HOST_TEST_SUITE_CAP_DEFAULT,
  HOST_TEST_TARGETED_CAP_CEILING,
  HOST_TEST_TARGETED_CAP_DEFAULT,
  HOST_TEST_TTL_DEFAULT_MS,
  HOST_TEST_TTL_MAX_MS,
  HOST_TEST_TTL_MIN_MS,
  HostTestRunnerSemaphore,
  LOCK_WEDGE_AGE_MS,
  TEST_RUNNER_CAPACITY_EXIT_CODE,
  TUNING_HASH_ABSENT,
  TestRunnerCapacityTimeoutError,
  TestRunnerStormCeilingError,
  WEDGE_STORM_CEILING,
  appendLedgerEvent,
  checkTuningBaseline,
  classifyRow,
  coerceTtlMs,
  gatherPidEvidence,
  listLedgerSegments,
  readLedgerTail,
  readMacBootTimeMs,
  readTuningFile,
  resolveAcquireBudgetMs,
  resolveAcquireTtlMs,
  resolveCap,
  resolveClampActive,
  resolveDfLocal,
  resolvePosture,
  resolveTestRunnerPaths,
  resolveTtlSignal,
  sanitizeCapValue,
  writeTuningFile,
  type HostTestRunnerSemaphoreDeps,
  type PidEvidence,
  type TestRunnerHolderRow,
  type TestRunnerLedgerEvent,
  type TestRunnerPaths,
} from '../../src/core/hostTestRunnerSemaphore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import globalSetupEntry from '../setup/test-runner-semaphore.globalSetup.js';

const HOST = 'test-host';

// ── Fixture helpers ────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function mkPaths(): TestRunnerPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-trs-'));
  tmpDirs.push(dir);
  return resolveTestRunnerPaths({ INSTAR_HOST_TEST_BASE_DIR: dir });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'host-test-runner-semaphore.test:cleanup-tmpdir',
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function makeSem(
  paths: TestRunnerPaths,
  over: Partial<HostTestRunnerSemaphoreDeps> = {},
): HostTestRunnerSemaphore {
  return new HostTestRunnerSemaphore({
    paths,
    env: {},
    hostname: () => HOST,
    dfProbe: () => ({ status: 'local' }),
    pidAlive: () => true,
    gatherEvidence: () => ({ startMs: new Map(), pgid: new Map() }),
    signal: () => {},
    bootTimeMs: () => null,
    sleep: async () => {},
    pollIntervalMs: 5000,
    ...over,
  });
}

/** Fake-clock semaphore: sleep advances the shared clock (never real waits). */
function clockSem(
  paths: TestRunnerPaths,
  over: Partial<HostTestRunnerSemaphoreDeps> = {},
  startAt = 10_000_000_000,
): {
  sem: HostTestRunnerSemaphore;
  sleeps: number[];
  now: () => number;
  advance: (ms: number) => void;
} {
  let t = startAt;
  const sleeps: number[] = [];
  const sem = makeSem(paths, {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += Math.max(1, ms);
    },
    ...over,
  });
  return { sem, sleeps, now: () => t, advance: (ms) => (t += ms) };
}

let idSeq = 0;
function row(over: Partial<TestRunnerHolderRow> = {}): TestRunnerHolderRow {
  return {
    v: 1,
    id: `fixture-${++idSeq}`,
    lane: 'suite',
    pid: process.pid,
    hostname: HOST,
    acquiredAt: Date.now() - 1000,
    startedAt: '',
    cmd: 'node vitest run x.test.ts',
    ttlMs: HOST_TEST_TTL_DEFAULT_MS,
    state: 'held',
    ...over,
  };
}

function writeRows(paths: TestRunnerPaths, rows: unknown[]): void {
  fs.mkdirSync(paths.baseDir, { recursive: true });
  fs.writeFileSync(paths.holders, JSON.stringify({ v: 1, holders: rows }));
}

function readRows(paths: TestRunnerPaths): TestRunnerHolderRow[] {
  return JSON.parse(fs.readFileSync(paths.holders, 'utf-8')).holders;
}

function ledgerEvents(paths: TestRunnerPaths): Array<Record<string, unknown>> {
  try {
    return fs
      .readFileSync(paths.ledger, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function eventsOf(paths: TestRunnerPaths, kind: string): Array<Record<string, unknown>> {
  return ledgerEvents(paths).filter((e) => e.kind === kind);
}

function warnsOf(paths: TestRunnerPaths, warnType: string): Array<Record<string, unknown>> {
  return ledgerEvents(paths).filter((e) => e.kind === 'warn' && e.warnType === warnType);
}

function evidenceOf(
  entries: Record<number, { start?: number | null; pgid?: number | null }>,
): PidEvidence {
  const startMs = new Map<number, number | null>();
  const pgid = new Map<number, number | null>();
  for (const [pidStr, v] of Object.entries(entries)) {
    const pid = Number(pidStr);
    startMs.set(pid, v.start ?? null);
    pgid.set(pid, v.pgid ?? null);
  }
  return { startMs, pgid };
}

function enforcing(paths: TestRunnerPaths, extra: Record<string, unknown> = {}): void {
  writeTuningFile(paths, { v: 1, enforcing: true, ...extra });
}

// ═══════════════════════════════════════════════════════════════════════════
// §4 frozen rendezvous paths
// ═══════════════════════════════════════════════════════════════════════════

describe('§4 frozen rendezvous paths (resolveTestRunnerPaths)', () => {
  it('resolves the frozen file names under the base dir; env seam overrides the base only', () => {
    const p = resolveTestRunnerPaths({ INSTAR_HOST_TEST_BASE_DIR: '/tmp/x' });
    expect(p.baseDir).toBe('/tmp/x');
    expect(path.basename(p.holders)).toBe('host-test-runner-holders.json');
    expect(path.basename(p.lock)).toBe('host-test-runner-holders.lock');
    expect(path.basename(p.witnessDir)).toBe('host-test-runner-witness');
    expect(path.basename(p.tuning)).toBe('host-test-runner-tuning.json');
    expect(path.basename(p.tuningBaseline)).toBe('host-test-runner-tuning-baseline.json');
    expect(path.basename(p.dfMarker)).toBe('host-test-runner-dflocal.json');
    expect(path.basename(p.ledger)).toBe('host-test-runner-events.jsonl');
    const dflt = resolveTestRunnerPaths({});
    expect(dflt.baseDir).toBe(path.join(os.homedir(), '.instar'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.3 cap enforcement on BOTH symmetric lanes
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.3 cap enforcement — two symmetric lanes', () => {
  it('suite lane enforces the cap: a second acquire at cap 1 THROWS the typed capacity-timeout', async () => {
    const paths = mkPaths();
    enforcing(paths);
    const { sem } = clockSem(paths);
    const first = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 20_000 });
    expect(first.kind).toBe('acquired');
    await expect(
      sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 }),
    ).rejects.toBeInstanceOf(TestRunnerCapacityTimeoutError);
    expect(eventsOf(paths, 'block')).toHaveLength(1);
  });

  it('a FULL targeted lane THROWS the typed capacity-timeout — it never fail-open-admits', async () => {
    const paths = mkPaths();
    enforcing(paths);
    // Fill the targeted lane to its default cap (6).
    writeRows(
      paths,
      Array.from({ length: HOST_TEST_TARGETED_CAP_DEFAULT }, (_, i) =>
        row({ lane: 'targeted', pid: 40_000 + i }),
      ),
    );
    const { sem } = clockSem(paths);
    let err: unknown;
    try {
      await sem.acquire({ lane: 'targeted', runClass: 'background', budgetMs: 0 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TestRunnerCapacityTimeoutError);
    // NOT a fail-open admit: no witness record, no fail-open-admit event.
    expect(eventsOf(paths, 'fail-open-admit')).toHaveLength(0);
    expect(fs.existsSync(paths.witnessDir)).toBe(false);
  });

  it('the typed capacity error carries the DISTINCT exit code, holder pids+ages, and the "NOT a test failure" message + levers (§2.6)', async () => {
    const paths = mkPaths();
    enforcing(paths);
    writeRows(paths, [row({ lane: 'suite', pid: 41_111 })]);
    const { sem } = clockSem(paths);
    let err: TestRunnerCapacityTimeoutError | null = null;
    try {
      await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    } catch (e) {
      err = e as TestRunnerCapacityTimeoutError;
    }
    expect(err).not.toBeNull();
    expect(err!.code).toBe('INSTAR_TEST_CAPACITY_TIMEOUT');
    expect(err!.exitCode).toBe(TEST_RUNNER_CAPACITY_EXIT_CODE);
    expect(err!.holders).toEqual([{ pid: 41_111, ageMs: expect.any(Number) }]);
    expect(err!.message).toContain('NOT a test failure');
    expect(err!.message).toContain('INSTAR_HOST_TEST_SEMAPHORE=off');
    expect(err!.message).toContain('INSTAR_HOST_TEST_MAX');
  });

  it('shard-storm regression: N concurrent ≤K-file targeted runs admit at most TARGETED_MAX; the rest THROW', async () => {
    const paths = mkPaths();
    enforcing(paths);
    const { sem } = clockSem(paths, { pollIntervalMs: 5000 });
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        sem.acquire({ lane: 'targeted', runClass: 'background', fileCount: 2, budgetMs: 12_000 }),
      ),
    );
    const admitted = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(admitted).toHaveLength(HOST_TEST_TARGETED_CAP_DEFAULT);
    expect(refused).toHaveLength(10 - HOST_TEST_TARGETED_CAP_DEFAULT);
    for (const r of refused) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(TestRunnerCapacityTimeoutError);
    }
    const held = readRows(paths).filter((r) => r.lane === 'targeted' && r.state === 'held');
    expect(held).toHaveLength(HOST_TEST_TARGETED_CAP_DEFAULT);
    // Every targeted acquire is ledgered with the resolved file count (§2.3).
    const acquires = eventsOf(paths, 'acquire');
    expect(acquires).toHaveLength(HOST_TEST_TARGETED_CAP_DEFAULT);
    for (const a of acquires) expect(a.fileCount).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.4 ReclaimPolicy — DEFAULT capacity-reclaim-only
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.4 ReclaimPolicy — default capacity-reclaim-only', () => {
  it('max-hold TTL frees a pid-ALIVE holder slot, ledgers stale-holder-reclaimed, NO signal (dry-run posture)', async () => {
    const paths = mkPaths();
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, { signal: (p, s) => signals.push([p, s]) });
    writeRows(paths, [
      row({ pid: 40_500, acquiredAt: 10_000_000_000 - HOST_TEST_TTL_DEFAULT_MS - 1 }),
    ]);
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 20_000 });
    expect(out.kind).toBe('acquired');
    expect((out as { wouldBlock: boolean }).wouldBlock).toBe(false); // the slot was freed
    const ev = eventsOf(paths, 'stale-holder-reclaimed');
    expect(ev).toHaveLength(1);
    expect(ev[0].pid).toBe(40_500);
    expect(ev[0].pidAlive).toBe(true);
    expect(signals).toHaveLength(0);
  });

  it('NO signal under ANY posture when INSTAR_HOST_TEST_TTL_SIGNAL is unset (enforcing posture, TTL expiry)', async () => {
    const paths = mkPaths();
    enforcing(paths); // enforcing but arm unset → capacity-only
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, { signal: (p, s) => signals.push([p, s]) });
    writeRows(paths, [
      row({ pid: 40_501, acquiredAt: 10_000_000_000 - HOST_TEST_TTL_DEFAULT_MS - 1 }),
    ]);
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 20_000 });
    expect(out.kind).toBe('acquired');
    expect(signals).toHaveLength(0);
    expect(eventsOf(paths, 'stale-holder-reclaimed')).toHaveLength(1);
    expect(eventsOf(paths, 'signal-term')).toHaveLength(0);
  });

  it('immediate dead-pid reclaim — no heartbeat gate (reclaim-dead)', async () => {
    const paths = mkPaths();
    enforcing(paths);
    const { sem } = clockSem(paths, { pidAlive: (p) => p !== 40_502 });
    writeRows(paths, [row({ pid: 40_502, acquiredAt: 10_000_000_000 - 5000 })]);
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(out.kind).toBe('acquired'); // slot freed immediately, cap 1 honored
    const ev = eventsOf(paths, 'reclaim-dead');
    expect(ev).toHaveLength(1);
    expect(ev[0].pid).toBe(40_502);
  });

  it('pid-reuse PRE-TTL reclaim via start-time corroboration on the DEFAULT path — acquire (reclaim-mismatch, NO signal)', async () => {
    const paths = mkPaths();
    enforcing(paths);
    const acquiredAt = 10_000_000_000 - 600_000; // 10 min old — far below TTL
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, {
      signal: (p, s) => signals.push([p, s]),
      // The live pid's start time POSTDATES the row's acquiredAt (+skew):
      // provably NOT the recorded holder (a reused pid).
      gatherEvidence: () => evidenceOf({ 40_503: { start: acquiredAt + 300_000 } }),
    });
    writeRows(paths, [row({ pid: 40_503, acquiredAt })]);
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(out.kind).toBe('acquired'); // no hour-long false-BLOCK at cap 1
    const ev = eventsOf(paths, 'reclaim-mismatch');
    expect(ev).toHaveLength(1);
    expect(ev[0].cause).toBe('start-time-postdates-acquire');
    expect(signals).toHaveLength(0);
  });

  it('pid-reuse PRE-TTL reclaim via the prune lever (POST /prune runs the SAME policy)', () => {
    const paths = mkPaths();
    const acquiredAt = 10_000_000_000 - 600_000;
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, {
      signal: (p, s) => signals.push([p, s]),
      gatherEvidence: () => evidenceOf({ 40_504: { start: acquiredAt + 300_000 } }),
    });
    writeRows(paths, [row({ pid: 40_504, acquiredAt })]);
    const report = sem.prune({ source: 'test', force: true });
    expect(report.reclaimed).toEqual([{ pid: 40_504, lane: 'suite', reason: 'pid-reuse' }]);
    expect(readRows(paths)).toHaveLength(0);
    expect(signals).toHaveLength(0);
  });

  it('per-row ttlMs honored BUT sanity-RANGED on read — the three §5 assertions as a jointly-satisfiable set', () => {
    const paths = mkPaths();
    const nowMs = 10_000_000_000;
    const signals: Array<[number, string]> = [];
    // Enforcing but the signal arm UNSET: the range checks run on the DEFAULT
    // capacity path (the arm-on young-holder case is the next test).
    enforcing(paths);
    const { sem } = clockSem(paths, {
      signal: (p, s) => signals.push([p, s]),
      gatherEvidence: () =>
        evidenceOf({
          40_601: { start: 1, pgid: 40_601 },
          40_602: { start: 1, pgid: 40_602 },
          40_603: { start: 1, pgid: 40_603 },
          40_604: { start: 1, pgid: 40_604 },
        }),
    });
    writeRows(paths, [
      // (a) legitimately raised to 2h, age 1.5h: a peer at the 1h default must
      // NOT reclaim it (honors the ROW's ttlMs).
      row({ pid: 40_601, ttlMs: 7_200_000, acquiredAt: nowMs - 5_400_000 }),
      // (b) absurd ttlMs — reclaimed AT the 4h pinned ceiling: age 5h ≥ 4h.
      row({ pid: 40_602, ttlMs: 999_999_999_999, acquiredAt: nowMs - 5 * 3_600_000 }),
      // (c) ttlMs=1 (instant-expiry abuse): resolves to the code-default TTL +
      // WARN; the YOUNG holder (10 min) is NOT reclaimed and NOT signaled.
      row({ pid: 40_603, ttlMs: 1, acquiredAt: nowMs - 600_000 }),
      // (c′) NaN-shaped ttlMs: same resolution.
      row({ pid: 40_604, ttlMs: 'NaN-garbage' as unknown as number, acquiredAt: nowMs - 600_000 }),
    ]);
    const report = sem.prune({ source: 'test', force: true });
    const kept = readRows(paths).map((r) => r.pid).sort();
    expect(kept).toEqual([40_601, 40_603, 40_604]);
    expect(report.reclaimed.map((r) => r.pid)).toEqual([40_602]);
    // The absurd row was reclaimed AT the ceiling constant, not its own value.
    const stale = eventsOf(paths, 'stale-holder-reclaimed');
    expect(stale).toHaveLength(1);
    expect(stale[0].ttlMs).toBe(HOST_TEST_TTL_MAX_MS);
    // WARN on every coerced read; young holders neither reclaimed nor signaled.
    expect(warnsOf(paths, 'ttl-coerced-on-read').length).toBeGreaterThanOrEqual(3);
    expect(signals).toHaveLength(0);
  });

  it('arm ON: a young holder whose ttlMs was coerced (1/0/NaN) is NOT signaled — instant-expiry abuse cannot convert the kill machinery', () => {
    const paths = mkPaths();
    const nowMs = 10_000_000_000;
    writeTuningFile(paths, { v: 1, enforcing: true, ttlSignal: true }); // fully armed
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, {
      signal: (p, s) => signals.push([p, s]),
      gatherEvidence: () => evidenceOf({ 40_605: { start: 1, pgid: 40_605 } }),
    });
    writeRows(paths, [row({ pid: 40_605, ttlMs: 1, acquiredAt: nowMs - 600_000 })]);
    sem.prune({ source: 'test', force: true });
    expect(signals).toHaveLength(0);
    expect(readRows(paths)).toHaveLength(1); // young holder kept
    expect(warnsOf(paths, 'ttl-coerced-on-read')).toHaveLength(1);
  });

  it('coerceTtlMs uses Number()+Number.isInteger, NEVER parseInt — "300000abc"/"300000.9" are REJECTED to the default', () => {
    expect(coerceTtlMs('300000abc')).toEqual({ ttlMs: HOST_TEST_TTL_DEFAULT_MS, coerced: true });
    expect(coerceTtlMs('300000.9')).toEqual({ ttlMs: HOST_TEST_TTL_DEFAULT_MS, coerced: true });
    expect(coerceTtlMs(NaN)).toEqual({ ttlMs: HOST_TEST_TTL_DEFAULT_MS, coerced: true });
    expect(coerceTtlMs(Infinity)).toEqual({ ttlMs: HOST_TEST_TTL_DEFAULT_MS, coerced: true });
    expect(coerceTtlMs(0)).toEqual({ ttlMs: HOST_TEST_TTL_DEFAULT_MS, coerced: true });
    expect(coerceTtlMs(1)).toEqual({ ttlMs: HOST_TEST_TTL_DEFAULT_MS, coerced: true });
    expect(coerceTtlMs(-0)).toEqual({ ttlMs: HOST_TEST_TTL_DEFAULT_MS, coerced: true });
    // Beyond the ceiling → clamped AT the ceiling (no immortal slot).
    expect(coerceTtlMs(HOST_TEST_TTL_MAX_MS + 1)).toEqual({
      ttlMs: HOST_TEST_TTL_MAX_MS,
      coerced: true,
    });
    // Scientific notation resolves to its numeric value and is range-checked once.
    expect(coerceTtlMs('3e5')).toEqual({ ttlMs: 300_000, coerced: false });
    // In-range values pass through: the range brackets [5min, 4h].
    expect(coerceTtlMs(HOST_TEST_TTL_MIN_MS)).toEqual({ ttlMs: HOST_TEST_TTL_MIN_MS, coerced: false });
    expect(coerceTtlMs(7_200_000)).toEqual({ ttlMs: 7_200_000, coerced: false });
    expect(coerceTtlMs(HOST_TEST_TTL_MAX_MS)).toEqual({ ttlMs: HOST_TEST_TTL_MAX_MS, coerced: false });
    // The env-read resolver applies the same coercion at acquire.
    expect(resolveAcquireTtlMs({ INSTAR_HOST_TEST_TTL_MS: '300000abc' })).toEqual({
      ttlMs: HOST_TEST_TTL_DEFAULT_MS,
      coerced: true,
    });
    expect(resolveAcquireTtlMs({})).toEqual({ ttlMs: HOST_TEST_TTL_DEFAULT_MS, coerced: false });
  });

  it('the 80%-of-TTL warning timer arms in the holding root and emits stderr + ledger', async () => {
    vi.useFakeTimers();
    const paths = mkPaths();
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const sem = makeSem(paths, { ttlMsOverride: 600_000 });
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 20_000 });
    expect(out.kind).toBe('acquired');
    vi.advanceTimersByTime(Math.floor(600_000 * 0.8) + 1000);
    const warned = stderrSpy.mock.calls.some((c) => String(c[0]).includes('80% of its'));
    expect(warned).toBe(true);
    const backstop = eventsOf(paths, 'approaching-ttl');
    expect(backstop.some((e) => e.self === true)).toBe(true);
  });

  it('approaching-ttl ledger backstop fires on a prune pass at ≥80% of the row TTL', () => {
    const paths = mkPaths();
    const nowMs = 10_000_000_000;
    const { sem } = clockSem(paths);
    writeRows(paths, [
      row({ pid: 40_610, acquiredAt: nowMs - Math.floor(HOST_TEST_TTL_DEFAULT_MS * 0.9) }),
    ]);
    sem.prune({ source: 'test', force: true });
    const ev = eventsOf(paths, 'approaching-ttl');
    expect(ev).toHaveLength(1);
    expect(ev[0].pid).toBe(40_610);
    expect(readRows(paths)).toHaveLength(1); // kept, not reclaimed
  });

  it('ps evidence is gathered OUTSIDE the holders lock — acquire AND prune (§2.4 round 9)', async () => {
    const paths = mkPaths();
    const lockHeldAtGather: boolean[] = [];
    const gatherEvidence = (pids: number[]): PidEvidence => {
      // The observable contract: at evidence-gathering time this process does
      // NOT hold the holders lock (the lock file does not exist).
      lockHeldAtGather.push(fs.existsSync(paths.lock));
      void pids;
      return { startMs: new Map(), pgid: new Map() };
    };
    const { sem } = clockSem(paths, { gatherEvidence });
    writeRows(paths, [row({ pid: 40_620 })]);
    await sem.acquire({ lane: 'targeted', runClass: 'background', budgetMs: 20_000 });
    sem.prune({ source: 'test', force: true });
    expect(lockHeldAtGather.length).toBeGreaterThanOrEqual(2);
    expect(lockHeldAtGather.every((held) => held === false)).toBe(true);
  });

  it('gatherPidEvidence: dead/sub-2 pids are filtered without a ps spawn; a live pid gets start+pgid entries', () => {
    const none = gatherPidEvidence([0, 1, -5], () => true);
    expect(none.startMs.size).toBe(0);
    expect(none.pgid.size).toBe(0);
    const dead = gatherPidEvidence([40_630], () => false);
    expect(dead.startMs.size).toBe(0);
    const self = gatherPidEvidence([process.pid], (p) => p === process.pid);
    expect(self.startMs.has(process.pid)).toBe(true);
    expect(self.pgid.has(process.pid)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.4 opt-in TTL signal arm — the four mandatory gates
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.4 opt-in signal arm (TTL_SIGNAL) — gates 1-5 + durable escalation', () => {
  const nowMs = 10_000_000_000;

  function armedSem(
    paths: TestRunnerPaths,
    evidence: PidEvidence,
    over: Partial<HostTestRunnerSemaphoreDeps> = {},
  ): { sem: HostTestRunnerSemaphore; signals: Array<[number, string]> } {
    writeTuningFile(paths, { v: 1, enforcing: true, ttlSignal: true });
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, {
      signal: (p, s) => signals.push([p, s]),
      gatherEvidence: () => evidence,
      ...over,
    });
    return { sem, signals };
  }

  it('the arm requires BOTH enforcing posture AND the tuning-file arm: armed + dry-run stays capacity-only', () => {
    const paths = mkPaths();
    writeTuningFile(paths, { v: 1, ttlSignal: true }); // armed but NOT enforcing
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, {
      signal: (p, s) => signals.push([p, s]),
      gatherEvidence: () => evidenceOf({ 40_700: { start: 1, pgid: 40_700 } }),
    });
    writeRows(paths, [row({ pid: 40_700, acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 })]);
    sem.prune({ source: 'test', force: true });
    expect(signals).toHaveLength(0);
    expect(eventsOf(paths, 'stale-holder-reclaimed')).toHaveLength(1);
  });

  it('gate 1 — pid sanity clamp: a row carrying pid 0/1/negative/non-integer is corrupt ⇒ dropped, NO signal', () => {
    const paths = mkPaths();
    const { sem, signals } = armedSem(paths, evidenceOf({}));
    writeRows(paths, [
      row({ pid: 0, acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 }),
      row({ pid: 1, acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 }),
      row({ pid: -7, acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 }),
      row({ pid: 3.5 as unknown as number, acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 }),
    ]);
    sem.prune({ source: 'test', force: true });
    expect(readRows(paths)).toHaveLength(0);
    expect(signals).toHaveLength(0);
    expect(warnsOf(paths, 'malformed-row-dropped')).toHaveLength(4);
  });

  it('gate 1 — the reclaimer never signals its OWN pid (self-refusal, slot freed)', () => {
    const paths = mkPaths();
    const { sem, signals } = armedSem(
      paths,
      evidenceOf({ [process.pid]: { start: 1, pgid: process.pid } }),
    );
    writeRows(paths, [row({ pid: process.pid, acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 })]);
    sem.prune({ source: 'test', force: true });
    expect(signals).toHaveLength(0);
    expect(warnsOf(paths, 'signal-pid-sanity-refused')).toHaveLength(1);
    expect(readRows(paths)).toHaveLength(0); // slot freed
  });

  it('gate 2 — identity corroboration failure (no ps evidence) ⇒ slot freed, NO signal, reclaim-mismatch ledgered', () => {
    const paths = mkPaths();
    const { sem, signals } = armedSem(paths, evidenceOf({})); // no start-time evidence
    writeRows(paths, [row({ pid: 40_701, acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 })]);
    sem.prune({ source: 'test', force: true });
    expect(signals).toHaveLength(0);
    const ev = eventsOf(paths, 'reclaim-mismatch');
    expect(ev).toHaveLength(1);
    expect(ev[0].cause).toBe('signal-corroboration-failed');
    expect(readRows(paths)).toHaveLength(0);
  });

  it('gate 2 — a non-test-runner command line fails corroboration ⇒ freed, NO signal', () => {
    const paths = mkPaths();
    const { sem, signals } = armedSem(paths, evidenceOf({ 40_702: { start: 1, pgid: 40_702 } }));
    writeRows(paths, [
      row({ pid: 40_702, cmd: 'totally-unrelated-daemon', acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 }),
    ]);
    sem.prune({ source: 'test', force: true });
    expect(signals).toHaveLength(0);
    expect(eventsOf(paths, 'reclaim-mismatch')).toHaveLength(1);
  });

  it('gate 3 — getpgid(pid)!==pid ⇒ SIGTERM the single corroborated pid only + ledger the downgrade', () => {
    const paths = mkPaths();
    const { sem, signals } = armedSem(paths, evidenceOf({ 40_703: { start: 1, pgid: 99 } }));
    writeRows(paths, [row({ pid: 40_703, acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 })]);
    sem.prune({ source: 'test', force: true });
    expect(signals).toEqual([[40_703, 'SIGTERM']]); // POSITIVE pid — never the group
    const ev = eventsOf(paths, 'signal-term');
    expect(ev).toHaveLength(1);
    expect(ev[0].groupSignal).toBe(false);
    expect(ev[0].leadershipDowngrade).toBe(true);
  });

  it('gate 3 — a corroborated group LEADER gets the group SIGTERM (kill(-pid))', () => {
    const paths = mkPaths();
    const { sem, signals } = armedSem(paths, evidenceOf({ 40_704: { start: 1, pgid: 40_704 } }));
    writeRows(paths, [row({ pid: 40_704, acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 })]);
    sem.prune({ source: 'test', force: true });
    expect(signals).toEqual([[-40_704, 'SIGTERM']]);
    expect(eventsOf(paths, 'signal-term')[0].groupSignal).toBe(true);
  });

  it('gate 4 — SIGTERM writes a `terminating` tombstone (NOT a delete); capacity is freed while the obligation persists', async () => {
    const paths = mkPaths();
    const { sem, signals } = armedSem(paths, evidenceOf({ 40_705: { start: 1, pgid: 40_705 } }));
    writeRows(paths, [row({ pid: 40_705, acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 })]);
    sem.prune({ source: 'test', force: true });
    const rows = readRows(paths);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('terminating');
    expect(typeof rows[0].signaledAt).toBe('number');
    expect(signals).toEqual([[-40_705, 'SIGTERM']]);
    // Capacity freed: a suite acquire admits at cap 1 despite the tombstone row.
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(out.kind).toBe('acquired');
  });

  it("gate 4 completer (a) — the reclaiming process's own unref'd grace timer fires the SIGKILL", () => {
    vi.useFakeTimers();
    const paths = mkPaths();
    let t = nowMs;
    writeTuningFile(paths, { v: 1, enforcing: true, ttlSignal: true });
    const signals: Array<[number, string]> = [];
    const sem = makeSem(paths, {
      now: () => t,
      signal: (p, s) => signals.push([p, s]),
      gatherEvidence: () => evidenceOf({ 40_706: { start: 1, pgid: 40_706 } }),
    });
    writeRows(paths, [row({ pid: 40_706, acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 1 })]);
    sem.prune({ source: 'test', force: true });
    expect(signals).toEqual([[-40_706, 'SIGTERM']]);
    // Advance both the module clock and the timer wheel past the grace window.
    t += 31_000;
    vi.advanceTimersByTime(31_000);
    expect(signals).toEqual([
      [-40_706, 'SIGTERM'],
      [-40_706, 'SIGKILL'],
    ]);
    expect(readRows(paths)).toHaveLength(0); // tombstone dropped after the kill
    expect(eventsOf(paths, 'signal-kill')).toHaveLength(1);
  });

  it('gate 4 completers (b) — reclaimer-dies-mid-grace fixture: a LATER pass (fresh process) past grace completes the SIGKILL', () => {
    const paths = mkPaths();
    writeTuningFile(paths, { v: 1, enforcing: true, ttlSignal: true });
    // The durable tombstone is on disk; the process that SIGTERMed is gone.
    writeRows(paths, [
      row({
        pid: 40_707,
        state: 'terminating',
        acquiredAt: nowMs - HOST_TEST_TTL_DEFAULT_MS - 60_000,
        signaledAt: nowMs - 31_000, // grace (30s) elapsed
      }),
    ]);
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, {
      signal: (p, s) => signals.push([p, s]),
      gatherEvidence: () => evidenceOf({ 40_707: { start: 1, pgid: 40_707 } }),
    });
    sem.prune({ source: 'test', force: true });
    expect(signals).toEqual([[-40_707, 'SIGKILL']]);
    expect(readRows(paths)).toHaveLength(0);
  });

  it('gate 4 — a tombstone within its grace window is KEPT (no early SIGKILL)', () => {
    const paths = mkPaths();
    writeTuningFile(paths, { v: 1, enforcing: true, ttlSignal: true });
    writeRows(paths, [
      row({ pid: 40_708, state: 'terminating', acquiredAt: nowMs - 3_700_000, signaledAt: nowMs - 5_000 }),
    ]);
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, {
      signal: (p, s) => signals.push([p, s]),
      gatherEvidence: () => evidenceOf({ 40_708: { start: 1, pgid: 40_708 } }),
    });
    sem.prune({ source: 'test', force: true });
    expect(signals).toHaveLength(0);
    expect(readRows(paths)[0].state).toBe('terminating');
  });

  it('gate 4 — tombstone completion re-corroborates: fingerprint mismatch ⇒ dropped with reclaim-mismatch, NO SIGKILL', () => {
    const paths = mkPaths();
    writeTuningFile(paths, { v: 1, enforcing: true, ttlSignal: true });
    const acquiredAt = nowMs - 3_700_000;
    writeRows(paths, [
      row({ pid: 40_709, state: 'terminating', acquiredAt, signaledAt: nowMs - 31_000 }),
    ]);
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, {
      signal: (p, s) => signals.push([p, s]),
      // Reused pid: the live process started AFTER the row's acquire.
      gatherEvidence: () => evidenceOf({ 40_709: { start: acquiredAt + 300_000, pgid: 40_709 } }),
    });
    sem.prune({ source: 'test', force: true });
    expect(signals).toHaveLength(0);
    expect(readRows(paths)).toHaveLength(0);
    expect(
      eventsOf(paths, 'reclaim-mismatch').some((e) => e.cause === 'tombstone-fingerprint-mismatch'),
    ).toBe(true);
  });

  it('gate 4 — arm turned OFF mid-grace voids the kill obligation (tombstone dropped, no signal)', () => {
    const paths = mkPaths();
    writeTuningFile(paths, { v: 1, enforcing: true }); // arm no longer set
    writeRows(paths, [
      row({ pid: 40_710, state: 'terminating', acquiredAt: nowMs - 3_700_000, signaledAt: nowMs - 31_000 }),
    ]);
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, {
      signal: (p, s) => signals.push([p, s]),
      gatherEvidence: () => evidenceOf({ 40_710: { start: 1, pgid: 40_710 } }),
    });
    sem.prune({ source: 'test', force: true });
    expect(signals).toHaveLength(0);
    expect(readRows(paths)).toHaveLength(0);
    expect(warnsOf(paths, 'tombstone-dropped-arm-off')).toHaveLength(1);
  });

  it('gate 4 — a DEAD tombstone pid completes without any signal', () => {
    const paths = mkPaths();
    writeTuningFile(paths, { v: 1, enforcing: true, ttlSignal: true });
    writeRows(paths, [
      row({ pid: 40_711, state: 'terminating', acquiredAt: nowMs - 3_700_000, signaledAt: nowMs - 31_000 }),
    ]);
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, {
      pidAlive: (p) => p !== 40_711,
      signal: (p, s) => signals.push([p, s]),
      gatherEvidence: () => evidenceOf({}),
    });
    sem.prune({ source: 'test', force: true });
    expect(signals).toHaveLength(0);
    expect(readRows(paths)).toHaveLength(0);
  });

  it('gate 5 — sleep-wake honesty: a boot gap overlapping the hold RE-ARMS the TTL window once instead of signaling; the SECOND expiry signals', () => {
    const paths = mkPaths();
    const acquiredAt = nowMs - HOST_TEST_TTL_DEFAULT_MS - 1;
    const { sem, signals } = armedSem(paths, evidenceOf({ 40_712: { start: 1, pgid: 40_712 } }), {
      bootTimeMs: () => acquiredAt + 60_000, // the machine BOOTED mid-hold
    });
    writeRows(paths, [row({ pid: 40_712, acquiredAt })]);
    sem.prune({ source: 'test', force: true });
    expect(signals).toHaveLength(0);
    const kept = readRows(paths);
    expect(kept).toHaveLength(1);
    expect(typeof kept[0].reArmedAt).toBe('number');
    expect(warnsOf(paths, 'ttl-rearmed-sleep-wake')).toHaveLength(1);
    // Second expiry (re-armed window ALSO elapsed): re-arm is ONCE — signal fires.
    const rearmed = readRows(paths)[0];
    rearmed.reArmedAt = nowMs - HOST_TEST_TTL_DEFAULT_MS - 1;
    writeRows(paths, [rearmed]);
    sem.prune({ source: 'test', force: true });
    expect(signals).toEqual([[-40_712, 'SIGTERM']]);
  });

  it('readMacBootTimeMs returns an ms-epoch number on darwin (best-effort seam for gate 5)', () => {
    const boot = readMacBootTimeMs();
    if (process.platform === 'darwin') {
      expect(typeof boot).toBe('number');
      expect(boot!).toBeGreaterThan(1_000_000_000_000); // an ms epoch, not seconds
      expect(boot!).toBeLessThanOrEqual(Date.now());
    } else {
      expect(boot === null || typeof boot === 'number').toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.4 fail-OPEN — corrupt holders / df-unknown
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.4 fail-OPEN: corrupt holders file / df-unknown', () => {
  it('corrupt holders file ⇒ admit AND quarantine aside + fresh file + WARN ledger', async () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(paths.holders, '{{{not json');
    const { sem } = clockSem(paths);
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(out.kind).toBe('acquired'); // fail-OPEN: admitted
    const quarantined = fs
      .readdirSync(paths.baseDir)
      .filter((f) => f.startsWith('host-test-runner-holders.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(paths.baseDir, quarantined[0]), 'utf-8')).toBe('{{{not json');
    // Fresh file via the single repair path, holding the new row.
    expect(readRows(paths)).toHaveLength(1);
    const ev = eventsOf(paths, 'quarantine');
    expect(ev).toHaveLength(1);
    expect(ev[0].cause).toBe('unparseable');
  });

  it('quarantine retention keeps only the newest 5 aside files', async () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(
        path.join(paths.baseDir, `host-test-runner-holders.corrupt-${1000 + i}.json`),
        'old',
      );
    }
    fs.writeFileSync(paths.holders, 'garbage');
    const { sem } = clockSem(paths);
    await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    const quarantined = fs
      .readdirSync(paths.baseDir)
      .filter((f) => f.startsWith('host-test-runner-holders.corrupt-'));
    expect(quarantined).toHaveLength(5);
  });

  it('df-unknown ⇒ fail-open ADMIT with a witness record; the failed probe is NEVER cached to the marker (§1.2)', async () => {
    const paths = mkPaths();
    const { sem } = clockSem(paths, { dfProbe: () => ({ status: 'unknown' }) });
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(out.kind).toBe('fail-open-admit');
    expect((out as { cause: string }).cause).toBe('df-unknown');
    const witness = (out as { witnessFile: string | null }).witnessFile;
    expect(witness).not.toBeNull();
    expect(fs.existsSync(witness!)).toBe(true);
    expect(fs.existsSync(paths.dfMarker)).toBe(false); // unknown never cached
    expect(eventsOf(paths, 'fail-open-admit')).toHaveLength(1);
  });

  it('df-unknown disables reclaim for the pass — a TTL-expired holder is KEPT (runs still admit)', () => {
    const paths = mkPaths();
    const { sem } = clockSem(paths, { dfProbe: () => ({ status: 'unknown' }) });
    writeRows(paths, [
      row({ pid: 40_800, acquiredAt: 10_000_000_000 - HOST_TEST_TTL_DEFAULT_MS - 1 }),
    ]);
    const report = sem.prune({ source: 'test', force: true });
    expect(report.reclaimed).toHaveLength(0);
    expect(readRows(paths)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.4 race-safe wedged-lock age-reclaim
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.4 race-safe wedged-lock age-reclaim', () => {
  function plantWedgedLock(paths: TestRunnerPaths, ageMs = 15_000): void {
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: 40_900, hostname: HOST, at: 1 }));
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(paths.lock, past, past);
  }

  it('a lock older than 10s is provably wedged: age-reclaimed by atomic rename, acquire proceeds; the aside is left for the age sweep', async () => {
    const paths = mkPaths();
    plantWedgedLock(paths);
    const sem = makeSem(paths, { pollIntervalMs: 20 }); // REAL clock (lock-contention path)
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 5000 });
    expect(out.kind).toBe('acquired');
    const asides = fs
      .readdirSync(paths.baseDir)
      .filter((f) => f.startsWith('host-test-runner-holders.lock.reclaim-'));
    expect(asides).toHaveLength(1); // no rename-back — left for the age sweep
  });

  it('two concurrent acquirers past a wedged lock: exactly one wins the rename; holders writes never interleave-lose a row', async () => {
    const paths = mkPaths();
    plantWedgedLock(paths);
    const sem = makeSem(paths, { pollIntervalMs: 20 });
    const [a, b] = await Promise.all([
      sem.acquire({ lane: 'targeted', runClass: 'background', budgetMs: 8000 }),
      sem.acquire({ lane: 'targeted', runClass: 'background', budgetMs: 8000 }),
    ]);
    expect(a.kind).toBe('acquired');
    expect(b.kind).toBe('acquired');
    // Both rows present: the reclaim race did not lose a holders row.
    expect(readRows(paths).filter((r) => r.lane === 'targeted')).toHaveLength(2);
    const asides = fs
      .readdirSync(paths.baseDir)
      .filter((f) => f.startsWith('host-test-runner-holders.lock.reclaim-'));
    expect(asides).toHaveLength(1); // exactly one winner performed the rename
  });

  it('round-9 dev+ino verification: a peer\'s FRESH lock swapped in mid-race is detected — ABORT + re-poll, mis-grabbed file left aside, no rename-back', () => {
    const paths = mkPaths();
    plantWedgedLock(paths);
    const sem = makeSem(paths);
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementationOnce((from, to) => {
      // Simulate the §2.4 round-9 race: between the reclaimer's lstat and its
      // rename, a peer reclaims the stale lock and creates a FRESH one (new
      // inode) at the same path. The reclaimer's rename then moves the FRESH
      // file — dev+ino mismatch — and must abort.
      SafeFsExecutor.safeUnlinkSync(paths.lock, {
        operation: 'host-test-runner-semaphore.test:race-fixture-peer-reclaim',
      });
      fs.writeFileSync(paths.lock, JSON.stringify({ pid: 40_901, hostname: HOST, at: 2 }));
      realRename(from as string, to as string);
    });
    const won = (
      sem as unknown as { ageReclaimWedgedLock(): boolean }
    ).ageReclaimWedgedLock();
    expect(won).toBe(false); // dropped its claim — treats the lock as live
    const asides = fs
      .readdirSync(paths.baseDir)
      .filter((f) => f.startsWith('host-test-runner-holders.lock.reclaim-'));
    expect(asides).toHaveLength(1);
    // The mis-grabbed FRESH lock stays under the private aside name (never
    // renamed back — round 10), and the lock path itself is now free.
    const asideBody = JSON.parse(
      fs.readFileSync(path.join(paths.baseDir, asides[0]), 'utf-8'),
    );
    expect(asideBody.pid).toBe(40_901);
  });

  it('a FRESH lock is never age-reclaimed (fail-open granularity: a missed poll is "retry", not "admit")', () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: 40_902, hostname: HOST, at: Date.now() }));
    const sem = makeSem(paths);
    const won = (
      sem as unknown as { ageReclaimWedgedLock(): boolean }
    ).ageReclaimWedgedLock();
    expect(won).toBe(false);
    expect(fs.existsSync(paths.lock)).toBe(true); // untouched
  });

  it('a per-poll lock miss retries and never admits: a lock freed mid-budget yields a NORMAL acquire, not a fail-open admit', async () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: 40_903, hostname: HOST, at: Date.now() }));
    // A REAL (macrotask-yielding) sleep so the lock-release timer below can fire.
    const sem = makeSem(paths, {
      pollIntervalMs: 20,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(1, Math.min(ms, 30)))),
    });
    const release = setTimeout(() => {
      try {
        SafeFsExecutor.safeUnlinkSync(paths.lock, {
          operation: 'host-test-runner-semaphore.test:free-lock-mid-budget',
        });
      } catch {
        /* already gone */
      }
    }, 400);
    try {
      const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 8000 });
      expect(out.kind).toBe('acquired'); // NORMAL admit — never fail-open mid-budget
      expect(eventsOf(paths, 'fail-open-admit')).toHaveLength(0);
    } finally {
      clearTimeout(release);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.4 wedge storm ceiling (O_EXCL witness slots)
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.4 wedge storm ceiling — numbered O_EXCL witness slots', () => {
  function plantHeldFreshLock(paths: TestRunnerPaths): void {
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(paths.lock, JSON.stringify({ pid: 41_000, hostname: HOST, at: Date.now() }));
  }

  function plantSlots(paths: TestRunnerPaths, pids: number[]): void {
    fs.mkdirSync(paths.witnessDir, { recursive: true });
    pids.forEach((pid, i) => {
      fs.writeFileSync(
        path.join(paths.witnessDir, `slot-${i + 1}`),
        JSON.stringify({ v: 1, pid, hostname: HOST, at: Date.now() - 1000 }),
      );
    });
  }

  it('a full-budget lock wedge fail-open ADMITS by claiming a numbered witness slot via O_EXCL; concurrent racers claim DISTINCT slots', async () => {
    const paths = mkPaths();
    plantHeldFreshLock(paths);
    const sem = makeSem(paths, { pollIntervalMs: 20 });
    const outs = await Promise.all([
      sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 50 }),
      sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 50 }),
      sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 50 }),
    ]);
    for (const out of outs) {
      expect(out.kind).toBe('fail-open-admit');
      expect((out as { cause: string }).cause).toBe('lock-unavailable-full-budget');
    }
    const slots = eventsOf(paths, 'fail-open-admit')
      .map((e) => e.stormSlot)
      .sort();
    expect(slots).toEqual([1, 2, 3]); // distinct atomic reservations
    for (const n of [1, 2, 3]) {
      expect(fs.existsSync(path.join(paths.witnessDir, `slot-${n}`))).toBe(true);
    }
  });

  it('the 9th admit REFUSES with the typed storm-ceiling error enumerating the held slots\' pids + ages', async () => {
    const paths = mkPaths();
    plantHeldFreshLock(paths);
    plantSlots(
      paths,
      Array.from({ length: WEDGE_STORM_CEILING }, (_, i) => 42_000 + i),
    );
    const sem = makeSem(paths, { pollIntervalMs: 20, pidAlive: () => true });
    let err: TestRunnerStormCeilingError | null = null;
    try {
      await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 50 });
    } catch (e) {
      err = e as TestRunnerStormCeilingError;
    }
    expect(err).toBeInstanceOf(TestRunnerStormCeilingError);
    expect(err!.exitCode).toBe(TEST_RUNNER_CAPACITY_EXIT_CODE);
    expect(err!.slots).toHaveLength(WEDGE_STORM_CEILING);
    expect(err!.slots.map((s) => s.pid).sort()).toEqual(
      Array.from({ length: WEDGE_STORM_CEILING }, (_, i) => 42_000 + i),
    );
    for (const s of err!.slots) expect(s.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('a dead-pid slot is sweepable and RECLAIMED for a new claim (liveness-gated, not permanent)', async () => {
    const paths = mkPaths();
    plantHeldFreshLock(paths);
    plantSlots(
      paths,
      Array.from({ length: WEDGE_STORM_CEILING }, (_, i) => 42_100 + i),
    );
    const deadPid = 42_102; // slot-3's claimant
    const sem = makeSem(paths, { pollIntervalMs: 20, pidAlive: (p) => p !== deadPid });
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 50 });
    expect(out.kind).toBe('fail-open-admit');
    expect(eventsOf(paths, 'fail-open-admit')[0].stormSlot).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.4 foreign hostname + §2.2 df marker revalidation
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.4 foreign-hostname drop + §2.2 df-marker revalidation', () => {
  it('a foreign-hostname holder on a df-confirmed-local disk is DROPPED and surfaced loudly (synced-home signal)', async () => {
    const paths = mkPaths();
    enforcing(paths);
    const { sem } = clockSem(paths);
    writeRows(paths, [row({ pid: 41_200, hostname: 'some-other-machine' })]);
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(out.kind).toBe('acquired'); // the bogus row did not consume cap 1
    const ev = eventsOf(paths, 'quarantine').filter((e) => e.cause === 'foreign-hostname-holder');
    expect(ev).toHaveLength(1);
    expect(ev[0].foreignHost).toBe('some-other-machine');
  });

  it('df marker: a fresh matching marker SKIPS the probe; a stale device or expired checkedAt RE-PROBES and rewrites', () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    const device = fs.statSync(paths.baseDir).dev;
    let probes = 0;
    const probe = (): { status: 'local' } => {
      probes++;
      return { status: 'local' };
    };
    // 1. No marker → probe runs and caches.
    expect(resolveDfLocal(paths, probe)).toEqual({ local: true, status: 'local' });
    expect(probes).toBe(1);
    // 2. Fresh matching marker → probe skipped.
    expect(resolveDfLocal(paths, probe)).toEqual({ local: true, status: 'local' });
    expect(probes).toBe(1);
    // 3. Stale DEVICE (home moved volumes) → re-probe (round-2 security).
    fs.writeFileSync(
      paths.dfMarker,
      JSON.stringify({ v: 1, device: device + 999, local: true, checkedAt: Date.now() }),
    );
    expect(resolveDfLocal(paths, probe).local).toBe(true);
    expect(probes).toBe(2);
    // 4. Expired checkedAt (24h TTL) → re-probe.
    fs.writeFileSync(
      paths.dfMarker,
      JSON.stringify({ v: 1, device, local: true, checkedAt: Date.now() - 25 * 3_600_000 }),
    );
    expect(resolveDfLocal(paths, probe).local).toBe(true);
    expect(probes).toBe(3);
  });

  it('a positive not-local classification IS cacheable; acquire fail-open-admits with cause df-not-local', async () => {
    const paths = mkPaths();
    const { sem } = clockSem(paths, { dfProbe: () => ({ status: 'not-local' }) });
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(out.kind).toBe('fail-open-admit');
    expect((out as { cause: string }).cause).toBe('df-not-local');
    const marker = JSON.parse(fs.readFileSync(paths.dfMarker, 'utf-8'));
    expect(marker.local).toBe(false); // positive classification cached
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.2 jitter / write-only-on-change / async yielding wait
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.2 jitter, write-only-on-change, async yielding wait', () => {
  it('write-only-on-change: an enforcing wait poll where prune removed nothing does NOT rewrite the holders file', async () => {
    const paths = mkPaths();
    enforcing(paths);
    const { sem, sleeps } = clockSem(paths);
    writeRows(paths, [row({ pid: 41_300, acquiredAt: 10_000_000_000 - 1000 })]);
    const inoBefore = fs.statSync(paths.holders).ino;
    await expect(
      sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 12_000 }),
    ).rejects.toBeInstanceOf(TestRunnerCapacityTimeoutError);
    expect(sleeps.length).toBeGreaterThanOrEqual(1); // it really polled
    // Atomic temp+rename changes the inode on every write — an unchanged inode
    // proves NO rewrite happened across the failed polls (§2.2 item 3).
    expect(fs.statSync(paths.holders).ino).toBe(inoBefore);
  });

  it('the poll wait is jittered (±1s around the interval), never a constant', () => {
    const paths = mkPaths();
    const sem = makeSem(paths, { pollIntervalMs: 5000 });
    const samples = Array.from({ length: 60 }, () =>
      (sem as unknown as { jitteredPoll(): number }).jitteredPoll(),
    );
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(4000);
      expect(s).toBeLessThanOrEqual(6000);
    }
    expect(new Set(samples).size).toBeGreaterThan(1);
  });

  it('the between-poll wait is an async yielding sleep (setTimeout-based default; busy-spin only inside the lock section) — structural', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src', 'core', 'hostTestRunnerSemaphore.ts'),
      'utf-8',
    );
    expect(src).toContain('await this.sleep(this.jitteredPoll())');
    expect(src).toMatch(/deps\.sleep \?\? \(\(ms\) => new Promise\(\(r\) => setTimeout\(r, ms\)\)\)/);
    // The only permitted spin is the sub-ms lock critical-section helper.
    expect(src).toMatch(/busyWaitSubMs[\s\S]*permitted ONLY inside the lock critical section/i);
  });

  it('the wait ticks the §2.10 hook with elapsed time + the live holder set', async () => {
    const paths = mkPaths();
    enforcing(paths);
    const { sem } = clockSem(paths);
    writeRows(paths, [row({ pid: 41_301 })]);
    const ticks: Array<{ elapsedMs: number; holders: Array<{ pid: number }> }> = [];
    await expect(
      sem.acquire({
        lane: 'suite',
        runClass: 'background',
        budgetMs: 12_000,
        onWaitTick: (elapsedMs, holders) => ticks.push({ elapsedMs, holders }),
      }),
    ).rejects.toBeInstanceOf(TestRunnerCapacityTimeoutError);
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0].holders.map((h) => h.pid)).toEqual([41_301]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.9 resolution order + divergence loudness
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.9 resolution order (env → tuning file → code-default) for EVERY cross-actor lever', () => {
  it('posture: env override → tuning file → default, with BIDIRECTIONAL divergence flags', () => {
    // default
    expect(resolvePosture({}, null)).toEqual({
      posture: 'dry-run',
      authority: 'dry-run',
      divergence: null,
    });
    // tuning authority
    expect(resolvePosture({}, { v: 1, enforcing: true })).toEqual({
      posture: 'enforcing',
      authority: 'enforcing',
      divergence: null,
    });
    // env WEAKER than an enforcing authority
    expect(resolvePosture({ INSTAR_HOST_TEST_ENFORCE: '0' }, { v: 1, enforcing: true })).toEqual({
      posture: 'dry-run',
      authority: 'enforcing',
      divergence: 'weaker',
    });
    // env STRONGER than a dry-run authority (round 8 — env can silently arm)
    expect(resolvePosture({ INSTAR_HOST_TEST_ENFORCE: '1' }, null)).toEqual({
      posture: 'enforcing',
      authority: 'dry-run',
      divergence: 'stronger',
    });
  });

  it('kill switch is ENV-ONLY: no tuning-file content can produce posture off', () => {
    expect(resolvePosture({ INSTAR_HOST_TEST_SEMAPHORE: 'off' }, null).posture).toBe('off');
    expect(resolvePosture({ INSTAR_HOST_TEST_SEMAPHORE: 'OFF' }, null).posture).toBe('off');
    // A tuning file cannot: there is no off lever in the authority file.
    const malicious = { v: 1, enforcing: false, enabled: false, off: true, semaphore: 'off' } as never;
    expect(resolvePosture({}, malicious).posture).toBe('dry-run');
  });

  it('suite + targeted caps: env → tuning → default; tuning values sanity-clamped at the PINNED ceilings (suite ≤4, targeted ≤24; valid range [1, ceiling])', () => {
    // defaults
    expect(resolveCap('suite', {}, null)).toMatchObject({ cap: HOST_TEST_SUITE_CAP_DEFAULT, source: 'default' });
    expect(resolveCap('targeted', {}, null)).toMatchObject({ cap: HOST_TEST_TARGETED_CAP_DEFAULT, source: 'default' });
    // tuning authority (in range)
    expect(resolveCap('suite', {}, { v: 1, maxConcurrent: 2 })).toMatchObject({ cap: 2, source: 'tuning' });
    expect(resolveCap('suite', {}, { v: 1, maxConcurrent: HOST_TEST_SUITE_CAP_CEILING })).toMatchObject({ cap: 4, source: 'tuning' });
    expect(resolveCap('targeted', {}, { v: 1, targetedMax: HOST_TEST_TARGETED_CAP_CEILING })).toMatchObject({ cap: 24, source: 'tuning' });
    // env outranks tuning
    expect(resolveCap('suite', { INSTAR_HOST_TEST_MAX: '3' }, { v: 1, maxConcurrent: 2 })).toMatchObject({ cap: 3, source: 'env' });
    expect(
      resolveCap('targeted', { INSTAR_HOST_TEST_TARGETED_MAX: '10' }, { v: 1, targetedMax: 4 }),
    ).toMatchObject({ cap: 10, source: 'env' });
    // beyond-ceiling / non-integer / 0 / negative tuning values → code-default + coerced (WARN-ledgered by callers)
    for (const bad of [HOST_TEST_SUITE_CAP_CEILING + 1, 0, -1, 2.5, 'abc'] as const) {
      expect(resolveCap('suite', {}, { v: 1, maxConcurrent: bad as never })).toMatchObject({
        cap: HOST_TEST_SUITE_CAP_DEFAULT,
        coerced: true,
      });
    }
    expect(resolveCap('targeted', {}, { v: 1, targetedMax: 25 })).toMatchObject({
      cap: HOST_TEST_TARGETED_CAP_DEFAULT,
      coerced: true,
    });
    // sanitizeCapValue direct: absent is NOT "coerced" (no false WARN)
    expect(sanitizeCapValue(undefined, 4, 1)).toEqual({ value: 1, coerced: false });
    expect(sanitizeCapValue(0, 4, 1)).toEqual({ value: 1, coerced: true });
  });

  it('resolved-cap divergence beyond 4× the host-uniform authority is flagged (the quiet twin of the kill switch)', () => {
    expect(resolveCap('suite', { INSTAR_HOST_TEST_MAX: '50' }, null).divergentBeyond4x).toBe(true);
    expect(resolveCap('suite', { INSTAR_HOST_TEST_MAX: '4' }, null).divergentBeyond4x).toBe(false);
    expect(
      resolveCap('suite', { INSTAR_HOST_TEST_MAX: '9' }, { v: 1, maxConcurrent: 2 }).divergentBeyond4x,
    ).toBe(true);
    // A malformed env value falls through to the authority — never zeroes capacity.
    expect(resolveCap('suite', { INSTAR_HOST_TEST_MAX: '0' }, null)).toMatchObject({
      cap: HOST_TEST_SUITE_CAP_DEFAULT,
    });
    expect(resolveCap('suite', { INSTAR_HOST_TEST_MAX: 'junk' }, null)).toMatchObject({
      cap: HOST_TEST_SUITE_CAP_DEFAULT,
    });
  });

  it('signal-arm asymmetry: env can only DISARM — TTL_SIGNAL=1 against an unarmed authority resolves UNARMED + envArmIgnored', () => {
    expect(resolveTtlSignal({}, null)).toEqual({ armed: false, envArmIgnored: false });
    expect(resolveTtlSignal({}, { v: 1, ttlSignal: true })).toEqual({ armed: true, envArmIgnored: false });
    // env=1 against an UNARMED authority: IGNORED (the dangerous direction does not exist per-process)
    expect(resolveTtlSignal({ INSTAR_HOST_TEST_TTL_SIGNAL: '1' }, null)).toEqual({
      armed: false,
      envArmIgnored: true,
    });
    expect(resolveTtlSignal({ INSTAR_HOST_TEST_TTL_SIGNAL: 'true' }, { v: 1 })).toEqual({
      armed: false,
      envArmIgnored: true,
    });
    // env=0 disarms an armed authority (the weaker direction is always available)
    expect(resolveTtlSignal({ INSTAR_HOST_TEST_TTL_SIGNAL: '0' }, { v: 1, ttlSignal: true })).toEqual({
      armed: false,
      envArmIgnored: false,
    });
    // env=1 with an ARMED authority is consistent, not ignored
    expect(resolveTtlSignal({ INSTAR_HOST_TEST_TTL_SIGNAL: '1' }, { v: 1, ttlSignal: true })).toEqual({
      armed: true,
      envArmIgnored: false,
    });
  });

  it('acquire budgets resolve per lane + run class: targeted env, background env, interactive = env || 5× background', () => {
    expect(resolveAcquireBudgetMs('targeted', 'background', {})).toBe(60_000);
    expect(resolveAcquireBudgetMs('targeted', 'interactive', { INSTAR_HOST_TEST_TARGETED_ACQUIRE_MS: '5000' })).toBe(5000);
    expect(resolveAcquireBudgetMs('suite', 'background', {})).toBe(120_000);
    expect(resolveAcquireBudgetMs('suite', 'background', { INSTAR_HOST_TEST_ACQUIRE_MS: '30000' })).toBe(30_000);
    expect(resolveAcquireBudgetMs('suite', 'interactive', {})).toBe(600_000);
    expect(resolveAcquireBudgetMs('suite', 'interactive', { INSTAR_HOST_TEST_ACQUIRE_MS: '30000' })).toBe(150_000);
    expect(
      resolveAcquireBudgetMs('suite', 'interactive', { INSTAR_HOST_TEST_ACQUIRE_MS_INTERACTIVE: '99000' }),
    ).toBe(99_000);
  });

  it('tuning-file corruption: quarantine ONLY after a confirming re-read; confirmed-corrupt resolves to code-defaults, never silent', () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(paths.tuning, '{"v":1,"enforcing":tr'); // persistently torn
    const res = readTuningFile(paths);
    expect(res.corrupt).toBe(true);
    expect(res.file).toBeNull(); // code defaults apply
    const quarantined = fs
      .readdirSync(paths.baseDir)
      .filter((f) => f.startsWith('host-test-runner-tuning.corrupt-'));
    expect(quarantined).toHaveLength(1);
    expect(fs.existsSync(paths.tuning)).toBe(false); // moved aside
  });

  it('a TORN tuning write raced by the reader resolves WITHOUT moving the file (transient race never demotes the authority)', () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    const goodBody = JSON.stringify({ v: 1, enforcing: true });
    fs.writeFileSync(paths.tuning, goodBody);
    const realRead = fs.readFileSync.bind(fs);
    let firstTuningRead = true;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((p: unknown, o: unknown) => {
      if (p === paths.tuning && firstTuningRead) {
        firstTuningRead = false;
        return '{"v":1,"enfo'; // the torn mid-write read
      }
      return realRead(p as never, o as never);
    }) as typeof fs.readFileSync);
    const res = readTuningFile(paths);
    expect(res.corrupt).toBe(false); // the confirming re-read cleared it
    expect(fs.existsSync(paths.tuning)).toBe(true); // file untouched — NOT quarantined
    const quarantined = fs
      .readdirSync(paths.baseDir)
      .filter((f) => f.startsWith('host-test-runner-tuning.corrupt-'));
    expect(quarantined).toHaveLength(0);
  });

  it('unknown tuning-file fields are ignored without invalidating the known ones (§2.9 tolerant reader)', () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(
      paths.tuning,
      JSON.stringify({ v: 1, enforcing: true, futureKnob: { nested: [1, 2] } }),
    );
    const res = readTuningFile(paths);
    expect(res.corrupt).toBe(false);
    expect(res.file?.enforcing).toBe(true);
    expect(resolvePosture({}, res.file).posture).toBe('enforcing');
  });
});

describe('§2.9 tuning-hash baseline (mutation visibility is a mechanism, not prose)', () => {
  it('a genuinely fresh host (no marker, no ledger) establishes the baseline SILENTLY', () => {
    const paths = mkPaths();
    const res = checkTuningBaseline(paths, readTuningFile(paths));
    expect(res).toEqual({ changed: false, changedFields: [], established: true, silentEstablish: true });
    expect(fs.existsSync(paths.tuningBaseline)).toBe(true); // marker written
  });

  it('an unchanged hash is quiet; a changed hash emits changedFields (old → new)', () => {
    const paths = mkPaths();
    writeTuningFile(paths, { v: 1, enforcing: false });
    const first = checkTuningBaseline(paths, readTuningFile(paths));
    expect(first.established).toBe(true);
    const second = checkTuningBaseline(paths, readTuningFile(paths));
    expect(second).toMatchObject({ changed: false, established: false });
    // The edit — an enforce flip.
    writeTuningFile(paths, { v: 1, enforcing: true });
    const third = checkTuningBaseline(paths, readTuningFile(paths));
    expect(third.changed).toBe(true);
    expect(third.changedFields.join(';')).toContain('enforcing');
  });

  it('tuning-file CREATION from absent is detected as a change via the sentinel hash', () => {
    const paths = mkPaths();
    const absent = readTuningFile(paths);
    expect(absent.hash).toBe(TUNING_HASH_ABSENT);
    checkTuningBaseline(paths, absent); // baseline = 'absent'
    writeTuningFile(paths, { v: 1, enforcing: true }); // the flip creates the file
    const res = checkTuningBaseline(paths, readTuningFile(paths));
    expect(res.changed).toBe(true);
  });

  it('marker-DELETED-then-edited is caught via the ledger tail (round 8 — deletion is not a laundering)', () => {
    const paths = mkPaths();
    const { sem } = clockSem(paths);
    writeTuningFile(paths, { v: 1, enforcing: false });
    // Stamp the ledger with the OLD hash (every acquire/skip event carries it).
    sem.ledger('acquire', { lane: 'suite' });
    checkTuningBaseline(paths, readTuningFile(paths));
    // The attack: delete the marker AND edit the tuning file.
    SafeFsExecutor.safeUnlinkSync(paths.tuningBaseline, {
      operation: 'host-test-runner-semaphore.test:marker-delete-fixture',
    });
    writeTuningFile(paths, { v: 1, enforcing: true, maxConcurrent: 4 });
    const res = checkTuningBaseline(paths, readTuningFile(paths));
    expect(res.changed).toBe(true); // NOT silently established
    expect(res.established).toBe(true);
    expect(res.silentEstablish).toBe(false);
  });

  it('the no-prior-baseline ledger consultation SPANS the newest rotated segment (round 9 — rotation must not blind it)', () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    writeTuningFile(paths, { v: 1, enforcing: true });
    // The live ledger is EMPTY/absent (just rotated); the newest segment holds
    // the hash-stamped history under a DIFFERENT (older) tuning hash.
    const segment = paths.ledger.replace(/\.jsonl$/, `.${Date.now() - 1000}.jsonl`);
    const oldEvent: TestRunnerLedgerEvent = {
      v: 1,
      ts: new Date().toISOString(),
      kind: 'acquire',
      pid: 1234,
      hostname: HOST,
      posture: 'dry-run',
      suiteCap: 1,
      targetedCap: 6,
      ttlSignalArmed: false,
      tuningHash: 'aaaaaaaaaaaa',
    };
    fs.writeFileSync(segment, JSON.stringify(oldEvent) + '\n');
    const res = checkTuningBaseline(paths, readTuningFile(paths));
    expect(res.changed).toBe(true); // the just-edited state was NOT silently established
  });

  it('readLedgerTail tolerates torn/malformed lines (ledger content can add a warning, never break a read)', () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    const good: TestRunnerLedgerEvent = {
      v: 1,
      ts: new Date().toISOString(),
      kind: 'skip',
      pid: 1,
      hostname: HOST,
      posture: 'dry-run',
      suiteCap: 1,
      targetedCap: 6,
      ttlSignalArmed: false,
      tuningHash: 'x',
    };
    fs.writeFileSync(paths.ledger, `torn{{{\n${JSON.stringify(good)}\n{"half":`);
    const tail = readLedgerTail(paths);
    expect(tail).toHaveLength(1);
    expect(tail[0].kind).toBe('skip');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.11 dry-run semantics
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.11 dry-run semantics — full bookkeeping, zero enforcement side-effects', () => {
  it('a run that WOULD block logs `would-block` with the live holder set and ADMITS (full bookkeeping)', async () => {
    const paths = mkPaths(); // no tuning file → dry-run authority
    const { sem } = clockSem(paths);
    writeRows(paths, [row({ pid: 41_400 })]);
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(out.kind).toBe('acquired');
    expect((out as { wouldBlock: boolean }).wouldBlock).toBe(true);
    const wb = eventsOf(paths, 'would-block');
    expect(wb).toHaveLength(1);
    expect(wb[0].cap).toBe(1);
    expect((wb[0].holders as Array<{ pid: number }>).map((h) => h.pid)).toEqual([41_400]);
    // Bookkeeping is REAL: the admitted run's row is in the holders file.
    expect(readRows(paths)).toHaveLength(2);
  });

  it('release removes exactly the released holder row and ledgers `release`', async () => {
    const paths = mkPaths();
    const { sem } = clockSem(paths);
    writeRows(paths, [row({ pid: 41_401, id: 'other-holder' })]);
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    const id = (out as { id: string }).id;
    sem.release(id);
    const remaining = readRows(paths);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('other-holder');
    expect(eventsOf(paths, 'release')).toHaveLength(1);
    expect(eventsOf(paths, 'release')[0].holderId).toBe(id);
  });

  it('EVERY ledger event is stamped with resolved posture + BOTH caps + arm + tuning hash (§2.8/§2.11)', async () => {
    const paths = mkPaths();
    writeTuningFile(paths, { v: 1, maxConcurrent: 2, targetedMax: 12 });
    const { sem } = clockSem(paths);
    await sem.acquire({ lane: 'targeted', runClass: 'interactive', fileCount: 3, budgetMs: 0 });
    const all = ledgerEvents(paths);
    expect(all.length).toBeGreaterThanOrEqual(1);
    for (const e of all) {
      expect(e.posture).toBe('dry-run');
      expect(e.suiteCap).toBe(2);
      expect(e.targetedCap).toBe(12);
      expect(e.ttlSignalArmed).toBe(false);
      expect(typeof e.tuningHash).toBe('string');
      expect(e.tuningHash).not.toBe(TUNING_HASH_ABSENT);
    }
    const acq = eventsOf(paths, 'acquire')[0];
    expect(acq.runClass).toBe('interactive');
    expect(acq.fileCount).toBe(3);
  });

  it('resolveClampActive: clamps are real ONLY in the clamp-active sub-stage or enforcing (§2.11/§4 ladder)', () => {
    expect(resolveClampActive('dry-run', null)).toBe(false);
    expect(resolveClampActive('dry-run', { v: 1, clampActive: true })).toBe(true);
    expect(resolveClampActive('enforcing', null)).toBe(true);
    expect(resolveClampActive('off', { v: 1, clampActive: true })).toBe(false);
  });

  it('prune is single-flight + rate-limited (one forced pass per 5s); the recovery lever still reports', () => {
    const paths = mkPaths();
    const { sem } = clockSem(paths);
    writeRows(paths, []);
    const first = sem.prune({ source: 'test', force: true });
    expect(first.rateLimited).toBeUndefined();
    const second = sem.prune({ source: 'test' }); // within 5s of the forced pass
    expect(second.rateLimited).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.4 poison ceiling + tombstone re-homing / salvage
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.4 poison ceiling — quarantine with terminating tombstones RE-HOMED', () => {
  it('a holders file AT HOST_TEST_POISON_CEILING (64) rows quarantines WITH terminating tombstones re-homed into the fresh file', async () => {
    const paths = mkPaths();
    const rows: unknown[] = [];
    for (let i = 0; i < HOST_TEST_POISON_CEILING - 2; i++) rows.push(row({ pid: 43_000 + i }));
    rows.push(row({ pid: 43_900, state: 'terminating', signaledAt: Date.now() }));
    rows.push(row({ pid: 43_901, state: 'terminating', signaledAt: Date.now() }));
    expect(rows).toHaveLength(HOST_TEST_POISON_CEILING);
    writeRows(paths, rows);
    const { sem } = clockSem(paths);
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(out.kind).toBe('acquired'); // fail-OPEN: admitted
    const fresh = readRows(paths);
    // Fresh file = the 2 re-homed tombstones + the admitted run's row.
    expect(fresh).toHaveLength(3);
    expect(fresh.filter((r) => r.state === 'terminating').map((r) => r.pid).sort()).toEqual([
      43_900, 43_901,
    ]);
    const ev = eventsOf(paths, 'quarantine').filter((e) => e.cause === 'poison-ceiling');
    expect(ev).toHaveLength(1);
    expect(ev[0].rehomedTombstones).toBe(2);
  });

  it('a holders file ONE BELOW the ceiling does NOT quarantine', async () => {
    const paths = mkPaths();
    writeRows(
      paths,
      Array.from({ length: HOST_TEST_POISON_CEILING - 1 }, (_, i) => row({ pid: 44_000 + i })),
    );
    const { sem } = clockSem(paths);
    await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(eventsOf(paths, 'quarantine')).toHaveLength(0);
    const quarantined = fs
      .readdirSync(paths.baseDir)
      .filter((f) => f.startsWith('host-test-runner-holders.corrupt-'));
    expect(quarantined).toHaveLength(0);
  });

  it('an UNPARSEABLE file with one intact terminating row is SALVAGED + re-homed (round 8)', async () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    const tombstone = row({ pid: 44_500, state: 'terminating', signaledAt: Date.now() });
    // A corrupted single-line holders file whose terminating row object is
    // still intact inside the wreckage.
    fs.writeFileSync(
      paths.holders,
      `{"v":1,"holders":[{"broken":true,,,${JSON.stringify(tombstone)},{"more":garbage`,
    );
    const { sem } = clockSem(paths);
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(out.kind).toBe('acquired');
    const fresh = readRows(paths);
    expect(fresh.filter((r) => r.state === 'terminating').map((r) => r.pid)).toEqual([44_500]);
    const ev = eventsOf(paths, 'quarantine');
    expect(ev).toHaveLength(1);
    expect(ev[0].salvaged).toBe(1);
  });

  it('a fully-MANGLED file WARNs naming the possible tombstone drop (loud, never silent)', async () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    // The terminating text is present but no intact row object survives.
    fs.writeFileSync(paths.holders, '{"v":1,"holders":[{"state":"terminating","pid":###mangled');
    const { sem } = clockSem(paths);
    await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    const ev = eventsOf(paths, 'quarantine');
    expect(ev).toHaveLength(1);
    expect(ev[0].possibleTombstoneDrop).toBe(true);
    expect(readRows(paths).filter((r) => r.state === 'terminating')).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.8 ledger — durable, best-effort, rotation-bounded
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.8 durable event ledger', () => {
  it('appendLedgerEvent is best-effort and never throws into the run (unwritable base dir)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-trs-ro-'));
    tmpDirs.push(dir);
    const fileAsBase = path.join(dir, 'a-file');
    fs.writeFileSync(fileAsBase, 'x'); // baseDir is a FILE → every write fails
    const paths = resolveTestRunnerPaths({ INSTAR_HOST_TEST_BASE_DIR: fileAsBase });
    expect(() =>
      appendLedgerEvent(paths, {
        v: 1,
        ts: new Date().toISOString(),
        kind: 'skip',
        pid: 1,
        hostname: HOST,
        posture: 'dry-run',
        suiteCap: 1,
        targetedCap: 6,
        ttlSignalArmed: false,
        tuningHash: 'x',
      }),
    ).not.toThrow();
  });

  it('rotation moves the live file to a timestamp-named segment; the rotated-out early-window event remains readable (§4 soak evidence)', () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    const early: TestRunnerLedgerEvent = {
      v: 1,
      ts: new Date().toISOString(),
      kind: 'would-block',
      pid: 77,
      hostname: HOST,
      posture: 'dry-run',
      suiteCap: 1,
      targetedCap: 6,
      ttlSignalArmed: false,
      tuningHash: 'early',
    };
    // Fill the live ledger past the rotation threshold with the early event first.
    const filler = JSON.stringify({ ...early, kind: 'noise' });
    const lines = [JSON.stringify(early)];
    const fillerCount = Math.ceil((5 * 1024 * 1024) / (filler.length + 1)) + 10;
    for (let i = 0; i < fillerCount; i++) lines.push(filler);
    fs.writeFileSync(paths.ledger, lines.join('\n') + '\n');
    appendLedgerEvent(paths, { ...early, kind: 'post-rotation' });
    const segments = listLedgerSegments(paths);
    expect(segments).toHaveLength(1);
    expect(path.basename(segments[0])).toMatch(/^host-test-runner-events\.\d+\.jsonl$/);
    // The early-window event is retained in the segment set, readable by the review.
    const segBody = fs.readFileSync(segments[0], 'utf-8');
    expect(segBody).toContain('"tuningHash":"early"');
    expect(segBody.split('\n')[0]).toContain('"kind":"would-block"');
    // The live file starts fresh with the post-rotation event.
    expect(fs.readFileSync(paths.ledger, 'utf-8')).toContain('"kind":"post-rotation"');
  });

  it('segments are RETAINED before the flip decision; the newest-10 floor applies only after (flipRecorded)', () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.baseDir, { recursive: true });
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(paths.ledger.replace(/\.jsonl$/, `.${1000 + i}.jsonl`), 'seg\n');
    }
    const big = 'x'.repeat(6 * 1024 * 1024);
    const ev: TestRunnerLedgerEvent = {
      v: 1,
      ts: new Date().toISOString(),
      kind: 'skip',
      pid: 1,
      hostname: HOST,
      posture: 'dry-run',
      suiteCap: 1,
      targetedCap: 6,
      ttlSignalArmed: false,
      tuningHash: 'x',
    };
    // Pre-flip rotation: ALL segments retained.
    fs.writeFileSync(paths.ledger, big);
    appendLedgerEvent(paths, ev);
    expect(listLedgerSegments(paths)).toHaveLength(13);
    // Post-flip rotation: the newest-10 floor applies.
    fs.writeFileSync(paths.ledger, big);
    appendLedgerEvent(paths, ev, { flipRecorded: true });
    expect(listLedgerSegments(paths)).toHaveLength(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.9 rendezvous schema tolerance
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.9 schema-version tolerance (mixed-version hosts safe AND loud)', () => {
  it('a future-versioned row with unknown state round-trips a prune pass INTACT (fields verbatim), excluded from the cap count, schema-unknown WARN, never signaled', async () => {
    const paths = mkPaths();
    writeTuningFile(paths, { v: 1, enforcing: true, ttlSignal: true }); // arm everything — it must STILL not signal
    const futureRow = {
      v: 2,
      id: 'future-1',
      lane: 'suite',
      pid: 45_000,
      hostname: HOST,
      acquiredAt: 10_000_000_000 - HOST_TEST_TTL_DEFAULT_MS - 1, // would be TTL-expired if counted
      state: 'held-v2-frozen', // unrecognized state
      futureField: { deep: ['x', 1] },
    };
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, {
      signal: (p, s) => signals.push([p, s]),
      gatherEvidence: () => evidenceOf({ 45_000: { start: 1, pgid: 45_000 } }),
    });
    writeRows(paths, [futureRow]);
    // Excluded from the cap count: a suite acquire admits at cap 1.
    const out = await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(out.kind).toBe('acquired');
    const kept = readRows(paths).find((r) => r.id === 'future-1');
    expect(kept).toEqual(futureRow); // preserved VERBATIM, unknown fields intact
    expect(eventsOf(paths, 'schema-unknown').length).toBeGreaterThanOrEqual(1);
    expect(signals).toHaveLength(0);
  });

  it('unknown-state rows COUNT toward the poison ceiling (they occupy file bytes)', async () => {
    const paths = mkPaths();
    writeRows(
      paths,
      Array.from({ length: HOST_TEST_POISON_CEILING }, (_, i) => ({
        v: 9,
        id: `u-${i}`,
        pid: 46_000 + i,
        state: 'mystery',
      })),
    );
    const { sem } = clockSem(paths);
    await sem.acquire({ lane: 'suite', runClass: 'background', budgetMs: 0 });
    expect(eventsOf(paths, 'quarantine').filter((e) => e.cause === 'poison-ceiling')).toHaveLength(1);
  });

  it('a DEAD-pid unknown-state row older than HOST_TEST_TTL_MAX_MS is droppable + WARN (bounded preservation)', () => {
    const paths = mkPaths();
    const { sem } = clockSem(paths, { pidAlive: (p) => p !== 45_100 });
    writeRows(paths, [
      {
        v: 3,
        id: 'ancient',
        lane: 'suite',
        pid: 45_100,
        hostname: HOST,
        acquiredAt: 10_000_000_000 - HOST_TEST_TTL_MAX_MS - 60_000,
        state: 'unknown-thing',
      },
    ]);
    sem.prune({ source: 'test', force: true });
    expect(readRows(paths)).toHaveLength(0);
    expect(warnsOf(paths, 'unknown-state-row-dropped')).toHaveLength(1);
  });

  it('an ALIVE unknown-state row is preserved even when old (pid-liveness bounds preservation, not age alone)', () => {
    const paths = mkPaths();
    const { sem } = clockSem(paths, { pidAlive: () => true });
    writeRows(paths, [
      {
        v: 3,
        id: 'old-but-alive',
        lane: 'suite',
        pid: 45_101,
        hostname: HOST,
        acquiredAt: 10_000_000_000 - HOST_TEST_TTL_MAX_MS - 60_000,
        state: 'unknown-thing',
      },
    ]);
    sem.prune({ source: 'test', force: true });
    expect(readRows(paths)).toHaveLength(1);
  });

  it('classifyRow: held requires a recognizable lane; pid <2/non-integer is malformed; terminating recognized', () => {
    expect(classifyRow(row())).toBe('held');
    expect(classifyRow(row({ lane: 'weird' as never }))).toBe('unknown-state');
    expect(classifyRow(row({ state: 'terminating' }))).toBe('terminating');
    expect(classifyRow(row({ state: 'future' as never }))).toBe('unknown-state');
    expect(classifyRow(row({ pid: 0 }))).toBe('malformed');
    expect(classifyRow(row({ pid: 1.5 }))).toBe('malformed');
    expect(classifyRow('nope')).toBe('malformed');
    expect(classifyRow(null)).toBe('malformed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.4 witness liveness-gated sweep
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.4 witness liveness-gated sweep', () => {
  it('a live-pid witness survives a prune pass; dead-pid and over-TTL witnesses are swept; aged reclaim-temps (incl. lock asides) are swept', () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.witnessDir, { recursive: true });
    // The reclaim-temp sweep compares REAL file mtimes against the clock, so
    // this fixture's fake clock is anchored to real time.
    const nowMs = Date.now();
    const livePid = 47_001;
    const deadPid = 47_002;
    fs.writeFileSync(
      path.join(paths.witnessDir, 'w-live.json'),
      JSON.stringify({ v: 1, pid: livePid, hostname: HOST, acquiredAt: nowMs - 60_000 }),
    );
    fs.writeFileSync(
      path.join(paths.witnessDir, 'w-dead.json'),
      JSON.stringify({ v: 1, pid: deadPid, hostname: HOST, acquiredAt: nowMs - 60_000 }),
    );
    fs.writeFileSync(
      path.join(paths.witnessDir, 'w-overttl.json'),
      JSON.stringify({ v: 1, pid: livePid, hostname: HOST, acquiredAt: nowMs - HOST_TEST_TTL_MAX_MS - 1000 }),
    );
    // Aged reclaim-temp litter inside the witness dir (slot reclaims).
    const agedTemp = path.join(paths.witnessDir, 'slot-3.reclaim-99-aaa');
    fs.writeFileSync(agedTemp, 'x');
    const past = new Date(Date.now() - LOCK_WEDGE_AGE_MS * 6 - 60_000);
    fs.utimesSync(agedTemp, past, past);
    const freshTemp = path.join(paths.witnessDir, 'slot-4.reclaim-99-bbb');
    fs.writeFileSync(freshTemp, 'x');
    // The mis-grabbed LOCK aside in the base dir (§2.4 round 10 — swept by age
    // like any stale reclaim-temp).
    const lockAside = `${paths.lock}.reclaim-99-ccc`;
    fs.writeFileSync(lockAside, 'x');
    fs.utimesSync(lockAside, past, past);

    const { sem } = clockSem(paths, { pidAlive: (p) => p === livePid }, nowMs);
    writeRows(paths, []);
    sem.prune({ source: 'test', force: true });

    expect(fs.existsSync(path.join(paths.witnessDir, 'w-live.json'))).toBe(true);
    expect(fs.existsSync(path.join(paths.witnessDir, 'w-dead.json'))).toBe(false);
    expect(fs.existsSync(path.join(paths.witnessDir, 'w-overttl.json'))).toBe(false);
    expect(fs.existsSync(agedTemp)).toBe(false);
    expect(fs.existsSync(freshTemp)).toBe(true); // young temps are never swept
    expect(fs.existsSync(lockAside)).toBe(false);
  });

  it('readAdmittedOpen reports only pid-ALIVE witness records (the route\'s admittedOpen field)', () => {
    const paths = mkPaths();
    fs.mkdirSync(paths.witnessDir, { recursive: true });
    fs.writeFileSync(
      path.join(paths.witnessDir, 'w-a.json'),
      JSON.stringify({ v: 1, pid: 48_001, hostname: HOST, acquiredAt: 5 }),
    );
    fs.writeFileSync(
      path.join(paths.witnessDir, 'w-b.json'),
      JSON.stringify({ v: 1, pid: 48_002, hostname: HOST, acquiredAt: 6 }),
    );
    const sem = makeSem(paths, { pidAlive: (p) => p === 48_001 });
    expect(sem.readAdmittedOpen()).toEqual([{ pid: 48_001, acquiredAt: 5 }]);
  });

  it('status() per-lane availability is honest: a full targeted lane + free suite lane reports targeted.saturated only (pure read — no write, no signal)', () => {
    const paths = mkPaths();
    const signals: Array<[number, string]> = [];
    const { sem } = clockSem(paths, { signal: (p, s) => signals.push([p, s]) });
    writeRows(
      paths,
      Array.from({ length: HOST_TEST_TARGETED_CAP_DEFAULT }, (_, i) =>
        row({ lane: 'targeted', pid: 48_100 + i, acquiredAt: 10_000_000_000 - 1000 }),
      ),
    );
    const inoBefore = fs.statSync(paths.holders).ino;
    const status = sem.status();
    expect(status.targeted.saturated).toBe(true);
    expect(status.suite.saturated).toBe(false);
    expect(status.suite.available).toBe(1);
    expect(fs.statSync(paths.holders).ino).toBe(inoBefore); // never written
    expect(signals).toHaveLength(0);
    // Virtual prune for display: a TTL-expired holder is excluded from the count.
    writeRows(paths, [
      row({ lane: 'suite', pid: 48_200, acquiredAt: 10_000_000_000 - HOST_TEST_TTL_DEFAULT_MS - 1 }),
    ]);
    expect(sem.status().liveHolders).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// globalSetup chokepoint — §2.2/§2.5/§2.6 decision surface
// ═══════════════════════════════════════════════════════════════════════════

describe('globalSetup chokepoint (§2.2/§2.5/§2.6 — skip reasons, lane routing, re-entrancy)', () => {
  const MANAGED_ENV = [
    'INSTAR_HOST_TEST_BASE_DIR',
    'INSTAR_HOST_TEST_SEMAPHORE',
    'INSTAR_HOST_TEST_ENFORCE',
    'INSTAR_HOST_TEST_TTL_SIGNAL',
    'INSTAR_HOST_TEST_MAX',
    'INSTAR_HOST_TEST_TARGETED_MAX',
    'INSTAR_HOST_TEST_ACQUIRE_MS',
    'INSTAR_HOST_TEST_POLL_MS',
    'INSTAR_HOST_TEST_RUN_CLASS',
    'INSTAR_TEST_SEMAPHORE_HELD',
    '__INSTAR_TRB_CONFIG',
    '__INSTAR_TRB_TARGETED',
    '__INSTAR_TRB_CLAMPED',
    'CI',
    'GITHUB_ACTIONS',
    'RUNNER_OS',
    'TMUX',
    'INSTAR_SESSION_ID',
    'CLAUDE_CODE_SESSION_ID',
  ] as const;

  let savedEnv: Record<string, string | undefined>;
  let savedArgv: string[];
  let paths: TestRunnerPaths;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of MANAGED_ENV) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    savedArgv = process.argv;
    process.argv = ['node', '/repo/node_modules/.bin/vitest', 'run'];
    paths = mkPaths();
    process.env.INSTAR_HOST_TEST_BASE_DIR = paths.baseDir;
    delete (globalThis as Record<string, unknown>).__instarTestRunnerHeld;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true) as ReturnType<
      typeof vi.spyOn
    >;
  });

  afterEach(() => {
    for (const k of MANAGED_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    process.argv = savedArgv;
    delete (globalThis as Record<string, unknown>).__instarTestRunnerHeld;
  });

  function stderrText(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  function ctxOf(config: Record<string, unknown>): Parameters<typeof globalSetupEntry>[0] {
    return { config } as unknown as Parameters<typeof globalSetupEntry>[0];
  }

  const suiteCtx = (): Parameters<typeof globalSetupEntry>[0] =>
    ctxOf({ include: ['tests/integration/**/*.test.ts'], watch: false, maxWorkers: 1 });

  it('kill switch (env-only): INSTAR_HOST_TEST_SEMAPHORE=off skips with a LOUD stderr WARN + a posture-stamped skip ledger event (§2.6 serverless surfacing)', async () => {
    process.env.INSTAR_HOST_TEST_SEMAPHORE = 'off';
    const teardown = await globalSetupEntry(suiteCtx());
    expect(teardown).toBeUndefined();
    expect(stderrText()).toContain('WARN: SKIPPING');
    const skips = eventsOf(paths, 'skip');
    expect(skips).toHaveLength(1);
    expect(skips[0].reason).toBe('off');
    expect(skips[0].loud).toBe(true);
    expect(skips[0].posture).toBe('off'); // every skip is posture-stamped
  });

  it('hardened CI predicate: CI=true + positive signal skips QUIETLY off an agent context', async () => {
    process.env.CI = 'true';
    process.env.GITHUB_ACTIONS = 'true';
    const teardown = await globalSetupEntry(suiteCtx());
    expect(teardown).toBeUndefined();
    const skips = eventsOf(paths, 'skip');
    expect(skips[0].reason).toBe('CI');
    expect(skips[0].loud).toBe(false);
    expect(stderrText()).not.toContain('WARN: SKIPPING');
  });

  it('spoofed-CI grading signal: a CI skip in an AGENT context is LOUD (graded like off)', async () => {
    process.env.CI = 'true';
    process.env.GITHUB_ACTIONS = 'true';
    process.env.TMUX = '/tmp/tmux-1/default,1,1';
    await globalSetupEntry(suiteCtx());
    const skips = eventsOf(paths, 'skip');
    expect(skips[0].reason).toBe('CI');
    expect(skips[0].loud).toBe(true);
    expect(stderrText()).toContain('WARN: SKIPPING');
  });

  it('CI truthy-trap: CI=false (truthy string!) must NOT skip — the run acquires', async () => {
    process.env.CI = 'false';
    process.env.GITHUB_ACTIONS = 'true';
    const teardown = await globalSetupEntry(suiteCtx());
    expect(typeof teardown).toBe('function'); // acquired, not skipped
    expect(eventsOf(paths, 'skip')).toHaveLength(0);
    expect(eventsOf(paths, 'acquire')).toHaveLength(1);
    await (teardown as () => Promise<void>)();
  });

  it('CI without a positive signal (GITHUB_ACTIONS/RUNNER_OS) must NOT skip', async () => {
    process.env.CI = 'true'; // a stray local export
    const teardown = await globalSetupEntry(suiteCtx());
    expect(typeof teardown).toBe('function');
    await (teardown as () => Promise<void>)();
  });

  it('watch detection: explicit --watch in an interactive (non-agent) shell keeps the QUIET skip line', async () => {
    process.argv = ['node', '/x/vitest', '--watch'];
    await globalSetupEntry(ctxOf({ include: ['tests/integration/x'], watch: true }));
    const skips = eventsOf(paths, 'skip');
    expect(skips[0].reason).toBe('watch');
    expect(skips[0].loud).toBe(false);
  });

  it('watch detection: bare-vitest DEFAULTED into watch is LOUD with the "use `vitest run`" hint + ledgered (§4(f) soak metric)', async () => {
    process.argv = ['node', '/x/vitest']; // no explicit --watch
    await globalSetupEntry(ctxOf({ include: ['tests/integration/x'], watch: true }));
    const skips = eventsOf(paths, 'skip');
    expect(skips[0].reason).toBe('watch');
    expect(skips[0].loud).toBe(true);
    expect(stderrText()).toContain('vitest run');
  });

  it('watch detection: explicit --watch in an AGENT context is LOUD (labeled-innocent full-suite skip)', async () => {
    process.argv = ['node', '/x/vitest', '--watch'];
    process.env.TMUX = '/tmp/tmux-1/default,2,2';
    await globalSetupEntry(ctxOf({ include: ['tests/integration/x'], watch: true }));
    const skips = eventsOf(paths, 'skip');
    expect(skips[0].loud).toBe(true);
  });

  it('a list/collect invocation is no-op\'d on the same seam (never waits or consumes a slot)', async () => {
    process.argv = ['node', '/x/vitest', 'list'];
    const teardown = await globalSetupEntry(suiteCtx());
    expect(teardown).toBeUndefined();
    expect(eventsOf(paths, 'skip')[0].reason).toBe('list');
    expect(fs.existsSync(paths.holders)).toBe(false); // never consumed a slot
  });

  it('re-entrancy is LANE-SCOPED: a suite-class child under a TARGETED-only ancestor does NOT skip — it acquires the suite lane (§2.5)', async () => {
    process.env.__INSTAR_TRB_CONFIG = 'integration'; // suite-class
    writeRows(paths, [row({ lane: 'targeted', pid: process.ppid })]); // ancestor holds TARGETED only
    const teardown = await globalSetupEntry(suiteCtx());
    expect(typeof teardown).toBe('function'); // acquired — never sheltered
    expect(eventsOf(paths, 'nested-skip')).toHaveLength(0);
    const acquired = readRows(paths).filter((r) => r.pid === process.pid);
    expect(acquired).toHaveLength(1);
    expect(acquired[0].lane).toBe('suite');
    await (teardown as () => Promise<void>)();
  });

  it('a SAME-lane ancestor holder skips (nested-skip ledgered with sheltering root pid + slot-id + clamped:true) — WITH the env marker', async () => {
    process.env.__INSTAR_TRB_CONFIG = 'integration';
    const ancestorRow = row({ lane: 'suite', pid: process.ppid, id: 'ancestor-slot-1' });
    writeRows(paths, [ancestorRow]);
    process.env.INSTAR_TEST_SEMAPHORE_HELD = `${process.ppid}:ancestor-slot-1`;
    const teardown = await globalSetupEntry(suiteCtx());
    expect(teardown).toBeUndefined(); // skipped — never blocks on its own ancestor
    const nested = eventsOf(paths, 'nested-skip');
    expect(nested).toHaveLength(1);
    expect(nested[0].shelteringPid).toBe(process.ppid);
    expect(nested[0].shelteringSlotId).toBe('ancestor-slot-1');
    expect(nested[0].clamped).toBe(true);
  });

  it('a scrubbed-env child still skips via PURE ancestry (the marker is an optimization hint, not the authority)', async () => {
    process.env.__INSTAR_TRB_CONFIG = 'integration';
    delete process.env.INSTAR_TEST_SEMAPHORE_HELD; // no marker at all
    writeRows(paths, [row({ lane: 'suite', pid: process.ppid })]);
    const teardown = await globalSetupEntry(suiteCtx());
    expect(teardown).toBeUndefined();
    expect(eventsOf(paths, 'nested-skip')).toHaveLength(1);
  });

  it('a stale/leaked HELD marker fails the ancestry+holders cross-check and does NOT skip (the bound stays live)', async () => {
    process.env.__INSTAR_TRB_CONFIG = 'integration';
    // The marker names a pid that holds NO slot and is NOT an ancestor holder.
    process.env.INSTAR_TEST_SEMAPHORE_HELD = '54321:leaked-slot';
    writeRows(paths, []); // no holders at all
    const teardown = await globalSetupEntry(suiteCtx());
    expect(typeof teardown).toBe('function'); // acquired normally
    expect(eventsOf(paths, 'nested-skip')).toHaveLength(0);
    await (teardown as () => Promise<void>)();
  });

  it('an UNGUARDED-config nested child (no config-eval clamp ran) skips with clamped:false at WARN (§2.5 — the one remaining edge case)', async () => {
    delete process.env.__INSTAR_TRB_CONFIG; // the config-eval helper never ran
    writeRows(paths, [row({ lane: 'suite', pid: process.ppid })]);
    await globalSetupEntry(suiteCtx());
    const nested = eventsOf(paths, 'nested-skip');
    expect(nested).toHaveLength(1);
    expect(nested[0].clamped).toBe(false);
    expect(stderrText()).toContain('WITHOUT the config-eval clamp');
  });

  it('process-global one-slot-per-process is LANE-SCOPED: a targeted-first process\'s later suite-class globalSetup ACQUIRES the suite lane; a same-lane repeat skips reentrant', async () => {
    // First: a targeted-lane acquire.
    process.env.__INSTAR_TRB_CONFIG = 'unit';
    process.env.__INSTAR_TRB_TARGETED = JSON.stringify({ targeted: true, matchedCount: 1 });
    process.argv = ['node', '/x/vitest', 'run', 'one.test.ts'];
    const unitCtx = ctxOf({ include: ['tests/unit/**/*.test.ts'], watch: false, maxWorkers: 2 });
    const t1 = await globalSetupEntry(unitCtx);
    expect(typeof t1).toBe('function');
    expect(readRows(paths).map((r) => r.lane)).toEqual(['targeted']);
    // Second: a suite-class globalSetup in the SAME process acquires the SUITE lane.
    process.env.__INSTAR_TRB_CONFIG = 'integration';
    const t2 = await globalSetupEntry(suiteCtx());
    expect(typeof t2).toBe('function');
    expect(readRows(paths).map((r) => r.lane).sort()).toEqual(['suite', 'targeted']);
    // Third: a SAME-lane (suite) repeat in this process skips `reentrant`.
    const t3 = await globalSetupEntry(suiteCtx());
    expect(t3).toBeUndefined();
    expect(eventsOf(paths, 'skip').some((s) => s.reason === 'reentrant')).toBe(true);
    await (t2 as () => Promise<void>)();
    await (t1 as () => Promise<void>)();
    expect(readRows(paths)).toHaveLength(0); // both released
  });

  it('two-point agreement BY STATE: a targeted-classified run whose RESOLVED pool bound exceeds 4 routes SUITE-class by construction (§2.3)', async () => {
    process.env.__INSTAR_TRB_CONFIG = 'unit';
    process.env.__INSTAR_TRB_TARGETED = JSON.stringify({ targeted: true, matchedCount: 1 });
    process.argv = ['node', '/x/vitest', 'run', 'one.test.ts'];
    const t = await globalSetupEntry(
      ctxOf({ include: ['tests/unit/**'], watch: false, maxWorkers: 16 }),
    );
    expect(typeof t).toBe('function');
    expect(readRows(paths)[0].lane).toBe('suite'); // the dangerous combination is impossible
    await (t as () => Promise<void>)();
  });

  it('pool-shaping argv disqualifies at the globalSetup point too: targeted stash + --maxWorkers argv routes suite-class', async () => {
    process.env.__INSTAR_TRB_CONFIG = 'unit';
    process.env.__INSTAR_TRB_TARGETED = JSON.stringify({ targeted: true, matchedCount: 1 });
    process.argv = ['node', '/x/vitest', 'run', 'one.test.ts', '--maxWorkers=16'];
    const t = await globalSetupEntry(
      ctxOf({ include: ['tests/unit/**'], watch: false, maxWorkers: 2 }),
    );
    expect(typeof t).toBe('function');
    expect(readRows(paths)[0].lane).toBe('suite');
    await (t as () => Promise<void>)();
  });

  it('a genuinely targeted run acquires the TARGETED lane and its acquire event carries the MATCHED file count (§2.3 — never the argv count)', async () => {
    process.env.__INSTAR_TRB_CONFIG = 'unit';
    process.env.__INSTAR_TRB_TARGETED = JSON.stringify({ targeted: true, matchedCount: 2 });
    process.argv = ['node', '/x/vitest', 'run', 'a.test.ts', 'b.test.ts'];
    const t = await globalSetupEntry(
      ctxOf({ include: ['tests/unit/**'], watch: false, maxWorkers: 2 }),
    );
    expect(typeof t).toBe('function');
    expect(readRows(paths)[0].lane).toBe('targeted');
    const acq = eventsOf(paths, 'acquire');
    expect(acq[0].lane).toBe('targeted');
    expect(acq[0].fileCount).toBe(2);
    await (t as () => Promise<void>)();
  });

  it('BIDIRECTIONAL posture-divergence WARN: ENFORCE=0 against an enforcing authority AND ENFORCE=1 against a dry-run authority (§2.9 round 8)', async () => {
    // Weaker: env dry-run vs enforcing tuning.
    writeTuningFile(paths, { v: 1, enforcing: true });
    process.env.INSTAR_HOST_TEST_ENFORCE = '0';
    process.env.__INSTAR_TRB_CONFIG = 'integration';
    const t1 = await globalSetupEntry(suiteCtx());
    expect(stderrText()).toContain('WEAKER');
    expect(
      ledgerEvents(paths).some(
        (e) => e.kind === 'warn' && e.warnType === 'posture-divergence' && e.direction === 'weaker',
      ),
    ).toBe(true);
    await (t1 as () => Promise<void>)();
    // Stronger: env enforcing vs dry-run authority.
    SafeFsExecutor.safeUnlinkSync(paths.tuning, {
      operation: 'host-test-runner-semaphore.test:clear-tuning-authority',
    });
    process.env.INSTAR_HOST_TEST_ENFORCE = '1';
    delete (globalThis as Record<string, unknown>).__instarTestRunnerHeld;
    const t2 = await globalSetupEntry(suiteCtx());
    expect(stderrText()).toContain('STRONGER');
    expect(
      ledgerEvents(paths).some(
        (e) => e.kind === 'warn' && e.warnType === 'posture-divergence' && e.direction === 'stronger',
      ),
    ).toBe(true);
    await (t2 as () => Promise<void>)();
  });

  it('cap-inflation loudness: an env cap >4× the host-uniform authority WARNs (as loud as off) + ledgers cap-divergence', async () => {
    process.env.INSTAR_HOST_TEST_MAX = '50';
    process.env.__INSTAR_TRB_CONFIG = 'integration';
    const t = await globalSetupEntry(suiteCtx());
    expect(stderrText()).toContain('quiet twin of the kill switch');
    expect(warnsOf(paths, 'cap-divergence')).toHaveLength(1);
    await (t as () => Promise<void>)();
  });

  it('signal-arm asymmetry surfaced: TTL_SIGNAL=1 env against an unarmed authority WARNs + ledgers env-arm-ignored; events stamp the RESOLVED (unarmed) arm', async () => {
    process.env.INSTAR_HOST_TEST_TTL_SIGNAL = '1';
    process.env.__INSTAR_TRB_CONFIG = 'integration';
    const t = await globalSetupEntry(suiteCtx());
    expect(stderrText()).toContain('env can only disarm');
    expect(warnsOf(paths, 'env-arm-ignored')).toHaveLength(1);
    for (const e of ledgerEvents(paths)) expect(e.ttlSignalArmed).toBe(false);
    await (t as () => Promise<void>)();
  });

  it('tuning-changed surfacing: an edited tuning file gets the WARN + tuning-changed ledger event on the next run', async () => {
    writeTuningFile(paths, { v: 1, enforcing: false });
    process.env.__INSTAR_TRB_CONFIG = 'integration';
    const t1 = await globalSetupEntry(suiteCtx());
    await (t1 as () => Promise<void>)();
    expect(eventsOf(paths, 'tuning-baseline-established')).toHaveLength(1);
    writeTuningFile(paths, { v: 1, enforcing: false, targetedMax: 12 }); // the edit
    delete (globalThis as Record<string, unknown>).__instarTestRunnerHeld;
    const t2 = await globalSetupEntry(suiteCtx());
    expect(eventsOf(paths, 'tuning-changed')).toHaveLength(1);
    expect(stderrText()).toContain('tuning file CHANGED');
    await (t2 as () => Promise<void>)();
  });

  it('enforcing + full lane: the typed capacity-timeout propagates out of the chokepoint (never process.exit) with the distinct exit code', async () => {
    writeTuningFile(paths, { v: 1, enforcing: true });
    process.env.INSTAR_HOST_TEST_ACQUIRE_MS = '0';
    process.env.__INSTAR_TRB_CONFIG = 'integration';
    // A live non-ancestor holder fills the suite lane (our own pid is NOT in
    // our ancestor chain, so no nested skip). The row must carry the REAL
    // hostname — the globalSetup runs the real semaphore, and a foreign
    // hostname would be dropped by the §2.4 host-local contract.
    writeRows(paths, [
      row({ pid: process.pid, hostname: os.hostname(), acquiredAt: Date.now() - 60_000 }),
    ]);
    const prevExitCode = process.exitCode;
    try {
      await expect(globalSetupEntry(suiteCtx())).rejects.toBeInstanceOf(
        TestRunnerCapacityTimeoutError,
      );
      expect(process.exitCode).toBe(TEST_RUNNER_CAPACITY_EXIT_CODE);
    } finally {
      process.exitCode = prevExitCode;
    }
  });

  it('FAIL-OPEN (§1.1): an internal chokepoint error admits the run with a loud WARN — it never wedges', async () => {
    // Point the base dir at a FILE so every holders/ledger write throws.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-trs-err-'));
    tmpDirs.push(dir);
    const fileAsBase = path.join(dir, 'not-a-dir');
    fs.writeFileSync(fileAsBase, 'x');
    process.env.INSTAR_HOST_TEST_BASE_DIR = fileAsBase;
    process.env.__INSTAR_TRB_CONFIG = 'integration';
    // Shrink the wait budget + poll so the persistent lock-open error reaches
    // the fail-open path quickly (the default budget is 2 min).
    process.env.INSTAR_HOST_TEST_ACQUIRE_MS = '300';
    process.env.INSTAR_HOST_TEST_POLL_MS = '30';
    const teardown = await globalSetupEntry(suiteCtx());
    expect(teardown).toBeUndefined(); // admitted without a slot
    expect(stderrText()).toMatch(/fail-open/i);
  });
});
