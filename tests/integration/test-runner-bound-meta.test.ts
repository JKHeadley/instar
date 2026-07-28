// safe-git-allow: test-only os.tmpdir fixture cleanup (mkdtemp teardown; no source-tree writes) — matches the tmux-resilience test allowlist precedent.
/**
 * test-runner-bound-meta — META-VERIFICATION of the test-runner concurrency
 * bound (spec docs/specs/test-runner-concurrency-bound.md §5 "Meta-verification",
 * "Acquire-before-fanout + clamp validation", §2.2 item 5, §2.5, §2.10-adjacent).
 *
 * Does the chokepoint ACTUALLY bind? This file spawns REAL vitest root
 * processes against the tiny fixture project in tests/fixtures/test-runner-bound/
 * (wired through the real withTestRunnerBound seam) and measures behavior —
 * timestamps, actual concurrent worker counts, ledger events — rather than
 * asserting flags.
 *
 * Isolation: every spawned root gets INSTAR_HOST_TEST_BASE_DIR pointed at a
 * per-scenario temp universe (the documented internal test seam in
 * resolveTestRunnerPaths) — the real ~/.instar is NEVER touched, and env
 * inherited from the repo's own bounded run (INSTAR_*, VITEST*, CI markers)
 * is scrubbed from child env.
 *
 * Assertion map (letters from the build brief / spec §5):
 *  (a) K=3 simultaneous roots, ENFORCING cap=1 → at-most-one concurrent
 *      execution window + no deadlock (the mass-admit regression).
 *  (b) SHIP GATE §2.2 item 5 — slot acquired BEFORE first worker fork, for
 *      both pinned config shapes (plain add + prepended-before-existing).
 *  (c) SHIP GATE §2.3 — targeted run under clampActive measures ≤4 ACTUAL
 *      concurrent workers AND acquired a targeted-lane slot; the same run
 *      with --maxWorkers=16 routes suite-class.
 *  (d) §2.5 — a REAL nested child skips acquisition (nested-skip ledgered with
 *      the sheltering root pid) and, under clampActive, measures ≤4 actual
 *      workers; the CLI-proof variant (--maxWorkers=32) must STILL be ≤4.
 *  (e) §2.5 — a scrubbed-env nested child (no INSTAR_TEST_SEMAPHORE_HELD)
 *      still skips via pure ancestry.
 *  (f) §2.5 — a FULL-SUITE-class child under a TARGETED-lane holder ACQUIRES
 *      the suite lane, never skips (lane-scope regression).
 *  (g) §2.4 — a live-but-hung holder past TTL: DEFAULT posture frees the slot
 *      with NO signal (pid still alive) + stale-holder-reclaimed ledgered, on
 *      both the prune path and the acquire path.
 *  (h) §2.4 — corrupt holders file: next root ADMITS + quarantines aside
 *      (fresh file, .corrupt-<ts> aside, keep-newest-5 retention).
 *
 * KNOWN SHIP-GATE FINDING (deliberately left failing — the loud report):
 * on vitest 2.1.9, createForksPool resolves `minThreads = poolOptions.minForks
 * ?? config.minWorkers ?? (numCpus - 1)`. clampConfigPool (src/core/
 * testRunnerRunClassifier.ts) clamps ONLY the max bounds, so on any host with
 * numCpus - 1 > 4 a REAL clamp (clampActive/enforcing) yields minThreads >
 * maxThreads and Tinypool throws `options.minThreads and options.maxThreads
 * must not conflict` — CRASHING every targeted/nested clamped run on the
 * pinned config shapes (none of which set minWorkers). The min-safe fixture
 * config isolates the defect: with minWorkers set, the clamp works and even
 * defeats --maxWorkers=32 (poolOptions.forks.maxForks outranks CLI
 * maxWorkers). Fix belongs in clampConfigPool (clamp min bounds too) — NOT
 * built here (src is owned elsewhere; this tier reports).
 *
 * NOTE on (g): a spawned-root variant cannot exercise the TTL path with a
 * just-spawned hung pid — start-time corroboration (§2.4) correctly classifies
 * a pid younger than the row's acquiredAt as pid-reuse (reclaim-mismatch)
 * BEFORE the TTL check, and the ttlMs floor is 5 minutes. So (g) drives the
 * REAL module in-process with an injected clock against a REAL live `sleep`
 * pid and REAL `ps` evidence — the same applyReclaimPass code path a spawned
 * root runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HostTestRunnerSemaphore,
  resolveTestRunnerPaths,
} from '../../src/core/hostTestRunnerSemaphore.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VITEST_MJS = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const FIXTURE_DIR = 'tests/fixtures/test-runner-bound';
const FIXTURE_CONFIG = `${FIXTURE_DIR}/vitest.fixture.config.ts`;
const FIXTURE_PREPEND_CONFIG = `${FIXTURE_DIR}/vitest.fixture-prepend.config.ts`;
const FIXTURE_MINSAFE_CONFIG = `${FIXTURE_DIR}/vitest.fixture-minsafe.config.ts`;
const FIXTURE_SMALLPOOL_CONFIG = `${FIXTURE_DIR}/vitest.fixture-smallpool.config.ts`;
const PROBES = [1, 2, 3, 4, 5].map((n) => `${FIXTURE_DIR}/tests/probe-${n}.test.ts`);
const QUICK = `${FIXTURE_DIR}/tests/quick-a.test.ts`;
const NESTED = `${FIXTURE_DIR}/tests/nested.test.ts`;

// ── Scenario plumbing ──────────────────────────────────────────────────────

const scenarioRoots: string[] = [];
const trackedPids = new Set<number>();

function makeScenarioDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trb-meta-${tag}-`));
  scenarioRoots.push(dir);
  return dir;
}

/** Per-scenario temp universe = the semaphore's rendezvous base dir. */
function makeUniverse(scenario: string): string {
  const u = path.join(scenario, 'universe');
  fs.mkdirSync(u, { recursive: true });
  return u;
}

function writeTuning(universe: string, tuning: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(universe, 'host-test-runner-tuning.json'),
    JSON.stringify({ v: 1, ...tuning }),
  );
}

/**
 * Child env: start from process.env, SCRUB everything that could couple the
 * child to the repo's own bounded run or to CI, then point the child at the
 * scenario universe. INSTAR_HOST_TEST_POLL_MS is the internal poll seam
 * (kept above POLL_JITTER_MS so the jittered sleep stays positive).
 */
function childEnv(universe: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('INSTAR_')) continue;
    if (k.startsWith('VITEST')) continue;
    if (k.startsWith('FIXTURE_')) continue;
    if (['CI', 'GITHUB_ACTIONS', 'RUNNER_OS', 'TMUX', 'CLAUDE_CODE_SESSION_ID', 'NODE_OPTIONS'].includes(k)) {
      continue;
    }
    env[k] = v;
  }
  env['INSTAR_HOST_TEST_BASE_DIR'] = universe;
  env['INSTAR_HOST_TEST_POLL_MS'] = '1200';
  env['INSTAR_HOST_TEST_ACQUIRE_MS'] = '90000';
  return { ...env, ...extra };
}

interface RootResult {
  pid: number;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn a REAL vitest root (node vitest.mjs — so child.pid IS the root pid). */
function spawnRoot(opts: {
  universe: string;
  config?: string;
  args?: string[];
  env?: Record<string, string>;
}): { pid: number; done: Promise<RootResult> } {
  const child = spawn(
    process.execPath,
    [VITEST_MJS, 'run', '--config', opts.config ?? FIXTURE_CONFIG, ...(opts.args ?? [])],
    {
      cwd: REPO_ROOT,
      env: childEnv(opts.universe, opts.env),
      detached: true, // own process group → group-kill cleanup reaches the whole tree
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const pid = child.pid ?? -1;
  if (pid > 0) trackedPids.add(pid);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d: Buffer) => {
    stdout = (stdout + String(d)).slice(-8000);
  });
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + String(d)).slice(-8000);
  });
  const done = new Promise<RootResult>((resolve) => {
    child.on('close', (code) => {
      trackedPids.delete(pid);
      resolve({ pid, code, stdout, stderr });
    });
    child.on('error', () => {
      trackedPids.delete(pid);
      resolve({ pid, code: -1, stdout, stderr });
    });
  });
  return { pid, done };
}

// ── Ledger + instrumentation readers ───────────────────────────────────────

interface LedgerEvent {
  ts: string;
  kind: string;
  pid: number;
  [k: string]: unknown;
}

function readLedger(universe: string): LedgerEvent[] {
  const file = path.join(universe, 'host-test-runner-events.jsonl');
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  const out: LedgerEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.kind === 'string') out.push(obj as LedgerEvent);
    } catch {
      /* torn line tolerated */
    }
  }
  return out;
}

interface Interval {
  start: number;
  end: number;
  name: string;
}

/** Pair start-X/end-X stamps written by the fixture probes/stamp test. */
function readIntervals(dir: string, startPrefix: string, endPrefix: string): Interval[] {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const starts = new Map<string, number>();
  const ends = new Map<string, number>();
  for (const f of entries) {
    const full = path.join(dir, f);
    try {
      const obj = JSON.parse(fs.readFileSync(full, 'utf-8'));
      if (f.startsWith(startPrefix)) starts.set(f.slice(startPrefix.length), obj.t);
      else if (f.startsWith(endPrefix)) ends.set(f.slice(endPrefix.length), obj.t);
    } catch {
      /* ignore torn instrumentation */
    }
  }
  const out: Interval[] = [];
  for (const [key, start] of starts) {
    const end = ends.get(key);
    if (typeof start === 'number' && typeof end === 'number') out.push({ start, end, name: key });
  }
  return out;
}

/** Max number of simultaneously-open [start,end] windows. */
function maxOverlap(intervals: Interval[]): number {
  const events: Array<[number, number]> = [];
  for (const iv of intervals) {
    events.push([iv.start, 1]);
    events.push([iv.end, -1]);
  }
  // At equal timestamps process ends before starts (closed-open windows).
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of events) {
    cur += d;
    if (cur > max) max = cur;
  }
  return max;
}

/** Earliest worker first-seen stamp (fixture modules stamp at import). */
function minWorkerStamp(outDir: string): number | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(outDir);
  } catch {
    return null;
  }
  let min: number | null = null;
  for (const f of entries) {
    if (!f.startsWith('worker-')) continue;
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf-8'));
      if (typeof obj.t === 'number' && (min === null || obj.t < min)) min = obj.t;
    } catch {
      /* ignore */
    }
  }
  return min;
}

function acquireEventFor(ledger: LedgerEvent[], pid: number): LedgerEvent | undefined {
  return ledger.find((e) => e.kind === 'acquire' && e.pid === pid);
}

interface NestedChildResult {
  pid: number | null;
  code: number | null;
  stderrTail: string;
}

// ── Cleanup ────────────────────────────────────────────────────────────────

afterEach(() => {
  for (const pid of Array.from(trackedPids)) {
    try {
      process.kill(-pid, 'SIGKILL'); // whole process group
    } catch {
      /* already gone / not a leader */
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
    trackedPids.delete(pid);
  }
});

afterAll(() => {
  for (const dir of scenarioRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
  }
  // Sweep esbuild config-bundle litter a killed child may have left beside the
  // fixture configs (vite writes `<config>.timestamp-*.mjs` during load).
  try {
    const dir = path.join(REPO_ROOT, FIXTURE_DIR);
    for (const f of fs.readdirSync(dir)) {
      if (/\.timestamp-.*\.mjs$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    /* best-effort */
  }
});

// ── The scenarios ──────────────────────────────────────────────────────────

describe('test-runner-bound meta-verification (spec §5)', () => {
  it(
    '(a)+(b) K=3 simultaneous roots under ENFORCING cap=1 serialize (no overlap, no deadlock) and each acquires BEFORE its worker fanout',
    async () => {
      const scenario = makeScenarioDir('kroots');
      const universe = makeUniverse(scenario);
      writeTuning(universe, { enforcing: true });
      const stampDir = path.join(scenario, 'stamps');
      fs.mkdirSync(stampDir, { recursive: true });

      const roots = [1, 2, 3].map((n) => {
        const outDir = path.join(scenario, `out-${n}`);
        fs.mkdirSync(outDir, { recursive: true });
        return {
          outDir,
          ...spawnRoot({
            universe,
            env: {
              FIXTURE_STAMP_DIR: stampDir,
              FIXTURE_SLEEP_MS: '2000',
              FIXTURE_OUT_DIR: outDir,
            },
          }),
        };
      });
      const results = await Promise.all(roots.map((r) => r.done));

      // No deadlock: every queued root eventually ran to green within budget.
      for (const r of results) {
        expect(r.code, `root pid ${r.pid} failed; stderr tail:\n${r.stderr}`).toBe(0);
      }

      // (a) at-most-one concurrent execution window (mass-admit regression).
      const windows = readIntervals(stampDir, 'window-start-', 'window-end-');
      expect(windows.length).toBe(3);
      expect(
        maxOverlap(windows),
        `execution windows overlapped: ${JSON.stringify(windows)}`,
      ).toBe(1);

      // Exactly three suite-lane acquires, none dry-run-admitted past the cap.
      const ledger = readLedger(universe);
      const acquires = ledger.filter((e) => e.kind === 'acquire' && e.lane === 'suite');
      expect(acquires.length).toBe(3);
      expect(acquires.every((e) => e.wouldBlock === false)).toBe(true);
      expect(ledger.filter((e) => e.kind === 'fail-open-admit').length).toBe(0);

      // (b) SHIP GATE §2.2 item 5, plain-add shape: acquire BEFORE worker fork.
      for (const r of roots) {
        const res = results[roots.indexOf(r)];
        const acq = acquireEventFor(ledger, res.pid);
        expect(acq, `no acquire ledger event for root pid ${res.pid}`).toBeTruthy();
        const acquireMs = Date.parse(acq!.ts);
        const firstWorker = minWorkerStamp(r.outDir);
        expect(firstWorker, `no worker stamps for root pid ${res.pid}`).not.toBeNull();
        expect(
          acquireMs,
          `SHIP GATE (§2.2 item 5): slot acquired AT/AFTER first worker fork ` +
            `(acquire ${acquireMs} vs worker ${firstWorker}) — the wrapper fallback is forced`,
        ).toBeLessThan(firstWorker!);
      }
    },
    240_000,
  );

  it(
    '(b) prepend shape: acquire precedes the pre-existing globalSetup AND worker fanout',
    async () => {
      const scenario = makeScenarioDir('prepend');
      const universe = makeUniverse(scenario);
      const outDir = path.join(scenario, 'out');
      fs.mkdirSync(outDir, { recursive: true });

      const root = spawnRoot({
        universe,
        config: FIXTURE_PREPEND_CONFIG,
        env: { FIXTURE_OUT_DIR: outDir },
      });
      const res = await root.done;
      expect(res.code, `stderr tail:\n${res.stderr}`).toBe(0);

      const ledger = readLedger(universe);
      const acq = acquireEventFor(ledger, res.pid);
      expect(acq, 'no acquire ledger event for the prepend-shape root').toBeTruthy();
      const acquireMs = Date.parse(acq!.ts);

      const extraStampFile = path.join(outDir, 'extra-globalsetup.json');
      expect(fs.existsSync(extraStampFile)).toBe(true);
      const extraStamp = JSON.parse(fs.readFileSync(extraStampFile, 'utf-8')).t as number;
      const firstWorker = minWorkerStamp(outDir);
      expect(firstWorker).not.toBeNull();

      // Semaphore globalSetup is PREPENDED: acquire ≤ the pre-existing
      // globalSetup's stamp, and strictly before the first worker fork.
      expect(
        acquireMs,
        `SHIP GATE (§2.2): acquire (${acquireMs}) ran after the pre-existing globalSetup (${extraStamp}) — not prepended`,
      ).toBeLessThanOrEqual(extraStamp);
      expect(acquireMs, 'acquire did not precede worker fanout').toBeLessThan(firstWorker!);
    },
    120_000,
  );

  it(
    '(c) SHIP GATE §2.3 [KNOWN-FAILING until clampConfigPool clamps MIN bounds]: a targeted run under clampActive on the PINNED config shape runs green, holds a targeted-lane slot, and measures ≤4 actual workers',
    async () => {
      const scenario = makeScenarioDir('targeted');
      const universe = makeUniverse(scenario);
      writeTuning(universe, { clampActive: true });
      const probeDir = path.join(scenario, 'probes');
      fs.mkdirSync(probeDir, { recursive: true });

      const root = spawnRoot({
        universe,
        args: [...PROBES],
        env: { FIXTURE_PROBE_DIR: probeDir, FIXTURE_PROBE_EXPECT: '5' },
      });
      const res = await root.done;
      expect(
        res.code,
        `SHIP GATE (§2.3): a clampActive targeted run on the pinned config shape did not run green — ` +
          `on vitest 2.1.9 clampConfigPool clamps only MAX bounds, so minThreads (numCpus-1 default) > ` +
          `maxThreads (4) crashes pool creation. Fix clampConfigPool to clamp min bounds too. stderr tail:\n${res.stderr}`,
      ).toBe(0);

      // The run genuinely ACQUIRED a targeted-lane slot (no skip-free path),
      // ledgered with the resolved MATCHED file count.
      const ledger = readLedger(universe);
      const acq = acquireEventFor(ledger, res.pid);
      expect(acq, 'no acquire ledger event for the targeted root').toBeTruthy();
      expect(acq!.lane, 'targeted-argv run did not route to the targeted lane').toBe('targeted');
      expect(acq!.fileCount).toBe(5);
      expect(ledger.filter((e) => e.kind === 'skip').length).toBe(0);

      // ACTUAL concurrent worker count ≤ 4 (measured via the probe barrier).
      const intervals = readIntervals(probeDir, 'start-', 'end-');
      expect(intervals.length).toBe(5);
      const overlap = maxOverlap(intervals);
      expect(overlap, 'probe barrier detected no parallelism — measurement vacuous').toBeGreaterThanOrEqual(2);
      expect(
        overlap,
        `SHIP GATE (§2.3): targeted run's ACTUAL concurrent workers = ${overlap} > 4 — the config-eval clamp is not real`,
      ).toBeLessThanOrEqual(4);
    },
    120_000,
  );

  it(
    '(c-diagnostic) the max-clamp itself IS real: a min-safe targeted run under clampActive measures ≤4 actual workers and holds a targeted-lane slot',
    async () => {
      const scenario = makeScenarioDir('targeted-minsafe');
      const universe = makeUniverse(scenario);
      writeTuning(universe, { clampActive: true });
      const probeDir = path.join(scenario, 'probes');
      fs.mkdirSync(probeDir, { recursive: true });

      const root = spawnRoot({
        universe,
        config: FIXTURE_MINSAFE_CONFIG,
        args: [...PROBES],
        env: { FIXTURE_PROBE_DIR: probeDir, FIXTURE_PROBE_EXPECT: '5' },
      });
      const res = await root.done;
      expect(res.code, `stderr tail:\n${res.stderr}`).toBe(0);

      const ledger = readLedger(universe);
      const acq = acquireEventFor(ledger, res.pid);
      expect(acq, 'no acquire ledger event for the min-safe targeted root').toBeTruthy();
      expect(acq!.lane, 'targeted-argv run did not route to the targeted lane').toBe('targeted');
      expect(acq!.fileCount).toBe(5);

      const intervals = readIntervals(probeDir, 'start-', 'end-');
      expect(intervals.length).toBe(5);
      const overlap = maxOverlap(intervals);
      expect(overlap, 'probe barrier detected no parallelism — measurement vacuous').toBeGreaterThanOrEqual(2);
      expect(
        overlap,
        `targeted run's ACTUAL concurrent workers = ${overlap} > 4 — the config-eval max-clamp did not reach the pool`,
      ).toBeLessThanOrEqual(4);
    },
    120_000,
  );

  it(
    '(c) CLI-precedence: the SAME targeted run with --maxWorkers=16 routes suite-class',
    async () => {
      const scenario = makeScenarioDir('targeted-cli');
      const universe = makeUniverse(scenario);
      writeTuning(universe, { clampActive: true });
      const probeDir = path.join(scenario, 'probes');
      fs.mkdirSync(probeDir, { recursive: true });

      const root = spawnRoot({
        universe,
        args: [...PROBES, '--maxWorkers=16'],
        env: { FIXTURE_PROBE_DIR: probeDir, FIXTURE_PROBE_EXPECT: '5' },
      });
      const res = await root.done;
      expect(res.code, `stderr tail:\n${res.stderr}`).toBe(0);

      const ledger = readLedger(universe);
      const acq = acquireEventFor(ledger, res.pid);
      expect(acq, 'no acquire ledger event for the pool-flagged root').toBeTruthy();
      expect(
        acq!.lane,
        'a targeted-argv run carrying --maxWorkers=16 must route suite-class (§2.3 CLI-precedence closure)',
      ).toBe('suite');
      expect(ledger.some((e) => e.kind === 'acquire' && e.lane === 'targeted')).toBe(false);
    },
    120_000,
  );

  describe('(d)(e) nested-skip SEMANTICS under a SUITE-lane holder (dry-run posture, §2.5)', () => {
    let ledger: LedgerEvent[] = [];
    let outerPid = -1;
    let outerResult: RootResult | null = null;
    let results: Record<string, NestedChildResult> = {};

    beforeAll(async () => {
      const scenario = makeScenarioDir('nested-sem');
      const universe = makeUniverse(scenario); // no tuning file → dry-run posture
      const nestedOut = path.join(scenario, 'nested-results.json');
      const plan = [
        { key: 'nestedQuick', args: [QUICK] },
        { key: 'scrubbed', args: [QUICK], scrubHeld: true },
      ];

      const root = spawnRoot({
        universe,
        env: {
          FIXTURE_NESTED_PLAN: JSON.stringify(plan),
          FIXTURE_NESTED_OUT: nestedOut,
        },
      });
      outerPid = root.pid;
      outerResult = await root.done;
      ledger = readLedger(universe);
      if (fs.existsSync(nestedOut)) {
        results = JSON.parse(fs.readFileSync(nestedOut, 'utf-8'));
      }
    }, 400_000);

    it('outer root ran green and held the suite-lane slot', () => {
      expect(outerResult?.code, `outer stderr tail:\n${outerResult?.stderr}`).toBe(0);
      const acq = acquireEventFor(ledger, outerPid);
      expect(acq).toBeTruthy();
      expect(acq!.lane).toBe('suite');
    });

    it('(d) nested child SKIPS acquisition — nested-skip ledgered with the sheltering root pid', () => {
      const child = results['nestedQuick'];
      expect(child, 'nested driver produced no result for the nested child').toBeTruthy();
      expect(child.code, `nested child stderr tail:\n${child.stderrTail}`).toBe(0);
      const skip = ledger.find((e) => e.kind === 'nested-skip' && e.pid === child.pid);
      expect(skip, 'no nested-skip ledger event for the nested child').toBeTruthy();
      expect(skip!.shelteringPid, 'nested-skip does not name the sheltering ROOT pid').toBe(outerPid);
      // Skips, never acquires:
      expect(acquireEventFor(ledger, child.pid!)).toBeUndefined();
    });

    it('(e) scrubbed-env nested child (no INSTAR_TEST_SEMAPHORE_HELD) still skips via pure ancestry', () => {
      const child = results['scrubbed'];
      expect(child, 'nested driver produced no result for the scrubbed child').toBeTruthy();
      expect(child.code, `scrubbed child stderr tail:\n${child.stderrTail}`).toBe(0);
      const skip = ledger.find((e) => e.kind === 'nested-skip' && e.pid === child.pid);
      expect(
        skip,
        'scrubbed-env child did not nested-skip — the ancestry path alone must carry the skip (§2.5)',
      ).toBeTruthy();
      expect(skip!.shelteringPid).toBe(outerPid);
      expect(acquireEventFor(ledger, child.pid!)).toBeUndefined();
    });
  });

  describe('(d) nested-clamp MEASUREMENTS under a SUITE-lane holder (clampActive, §2.5)', () => {
    let ledger: LedgerEvent[] = [];
    let outerPid = -1;
    let outerResult: RootResult | null = null;
    let results: Record<string, NestedChildResult> = {};
    let probeMinsafe = '';
    let probePinned = '';
    let probeCli = '';

    beforeAll(async () => {
      const scenario = makeScenarioDir('nested-clamp');
      const universe = makeUniverse(scenario);
      writeTuning(universe, { clampActive: true });
      probeMinsafe = path.join(scenario, 'probes-minsafe');
      probePinned = path.join(scenario, 'probes-pinned');
      probeCli = path.join(scenario, 'probes-cli');
      for (const d of [probeMinsafe, probePinned, probeCli]) fs.mkdirSync(d, { recursive: true });
      const nestedOut = path.join(scenario, 'nested-results.json');
      const plan = [
        {
          key: 'clampedMinsafe',
          config: FIXTURE_MINSAFE_CONFIG,
          args: PROBES,
          env: { FIXTURE_PROBE_DIR: probeMinsafe, FIXTURE_PROBE_EXPECT: '5' },
        },
        {
          key: 'clampedPinned',
          config: FIXTURE_CONFIG,
          args: PROBES,
          env: { FIXTURE_PROBE_DIR: probePinned, FIXTURE_PROBE_EXPECT: '5' },
        },
        {
          key: 'cliProofMinsafe',
          config: FIXTURE_MINSAFE_CONFIG,
          args: [...PROBES, '--maxWorkers=32'],
          env: { FIXTURE_PROBE_DIR: probeCli, FIXTURE_PROBE_EXPECT: '5' },
        },
      ];

      const root = spawnRoot({
        universe,
        env: {
          FIXTURE_NESTED_PLAN: JSON.stringify(plan),
          FIXTURE_NESTED_OUT: nestedOut,
        },
      });
      outerPid = root.pid;
      outerResult = await root.done;
      ledger = readLedger(universe);
      if (fs.existsSync(nestedOut)) {
        results = JSON.parse(fs.readFileSync(nestedOut, 'utf-8'));
      }
    }, 400_000);

    it('outer root ran green and held the suite-lane slot', () => {
      expect(outerResult?.code, `outer stderr tail:\n${outerResult?.stderr}`).toBe(0);
      const acq = acquireEventFor(ledger, outerPid);
      expect(acq).toBeTruthy();
      expect(acq!.lane).toBe('suite');
    });

    it('(d) min-safe nested child skips, is clamped, and measures ≤ 4 actual workers', () => {
      const child = results['clampedMinsafe'];
      expect(child, 'no result for the min-safe clamped child').toBeTruthy();
      expect(child.code, `min-safe clamped child stderr tail:\n${child.stderrTail}`).toBe(0);
      const skip = ledger.find((e) => e.kind === 'nested-skip' && e.pid === child.pid);
      expect(skip, 'no nested-skip ledger event for the min-safe clamped child').toBeTruthy();
      expect(skip!.shelteringPid).toBe(outerPid);
      expect(skip!.clamped, 'nested child was not config-eval clamped').toBe(true);
      expect(acquireEventFor(ledger, child.pid!)).toBeUndefined();

      const intervals = readIntervals(probeMinsafe, 'start-', 'end-');
      expect(intervals.length).toBe(5);
      const overlap = maxOverlap(intervals);
      expect(overlap, 'probe barrier detected no parallelism — measurement vacuous').toBeGreaterThanOrEqual(2);
      expect(
        overlap,
        `nested child's ACTUAL concurrent workers = ${overlap} > 4 — the unconditional nested clamp is not real (§2.5)`,
      ).toBeLessThanOrEqual(4);
    });

    it('(d) SHIP GATE [KNOWN-FAILING until clampConfigPool clamps MIN bounds]: nested clamp on the PINNED config shape runs green and measures ≤ 4', () => {
      const child = results['clampedPinned'];
      expect(child, 'no result for the pinned-shape clamped child').toBeTruthy();
      // The nested-skip itself fires before the pool crash — the SKIP works;
      // the crash is the clamp reshaping the pool into a min>max conflict.
      const skip = ledger.find((e) => e.kind === 'nested-skip' && e.pid === child.pid);
      expect(skip, 'no nested-skip ledger event for the pinned-shape clamped child').toBeTruthy();
      expect(
        child.code,
        `SHIP GATE (§2.5): a clampActive nested run on the pinned config shape did not run green — ` +
          `clampConfigPool leaves min bounds at vitest's core-count default (min > clamped max ⇒ ` +
          `Tinypool RangeError). Fix clampConfigPool to clamp min bounds too. stderr tail:\n${child.stderrTail}`,
      ).toBe(0);
      const intervals = readIntervals(probePinned, 'start-', 'end-');
      expect(intervals.length).toBe(5);
      expect(maxOverlap(intervals)).toBeLessThanOrEqual(4);
    });

    it('(d) SHIP GATE round-9 CLI-proof: nested child with --maxWorkers=32 STILL measures ≤ 4 actual workers', () => {
      const child = results['cliProofMinsafe'];
      expect(child, 'no result for the CLI-proof child').toBeTruthy();
      expect(child.code, `CLI-proof child stderr tail:\n${child.stderrTail}`).toBe(0);
      const skip = ledger.find((e) => e.kind === 'nested-skip' && e.pid === child.pid);
      expect(skip, 'no nested-skip ledger event for the CLI-proof child').toBeTruthy();
      const intervals = readIntervals(probeCli, 'start-', 'end-');
      expect(intervals.length).toBe(5);
      const overlap = maxOverlap(intervals);
      expect(overlap, 'probe barrier detected no parallelism — measurement vacuous').toBeGreaterThanOrEqual(2);
      expect(
        overlap,
        `SHIP GATE (§2.5 round 9): nested child spawned with --maxWorkers=32 measured ${overlap} actual ` +
          `concurrent workers (> 4) — the CLI pool flag defeated the config-eval clamp on the pinned ` +
          `version; per spec this forces the guarded-vitest.mjs wrapper fallback (ledger nested-skip: ` +
          `clamped=${String(skip!.clamped)}, poolOverride=${String(skip!.poolOverride)})`,
      ).toBeLessThanOrEqual(4);
    });
  });

  it(
    '(f) lane-scope regression: a FULL-SUITE-class child under a TARGETED-lane holder ACQUIRES the suite lane — never skips',
    async () => {
      const scenario = makeScenarioDir('lanescope');
      const universe = makeUniverse(scenario); // no tuning file → dry-run posture
      const nestedOut = path.join(scenario, 'nested-results.json');
      const plan = [{ key: 'suiteChild', config: FIXTURE_CONFIG, args: [] }];

      // Outer: single-positional targeted run on the SMALL-POOL config, whose
      // NATURAL resolved pool bound (maxWorkers: 2) satisfies the §2.3 state
      // check — so it routes to the TARGETED lane without engaging the clamp.
      const root = spawnRoot({
        universe,
        config: FIXTURE_SMALLPOOL_CONFIG,
        args: [NESTED],
        env: {
          FIXTURE_NESTED_PLAN: JSON.stringify(plan),
          FIXTURE_NESTED_OUT: nestedOut,
        },
      });
      const res = await root.done;
      expect(res.code, `outer stderr tail:\n${res.stderr}`).toBe(0);

      const ledger = readLedger(universe);
      const outerAcq = acquireEventFor(ledger, res.pid);
      expect(outerAcq, 'outer root has no acquire event').toBeTruthy();
      expect(outerAcq!.lane, 'outer root was expected to hold a TARGETED-lane slot').toBe('targeted');

      expect(fs.existsSync(nestedOut), 'nested driver produced no results file').toBe(true);
      const results = JSON.parse(fs.readFileSync(nestedOut, 'utf-8'));
      const child = results['suiteChild'] as NestedChildResult;
      expect(child, 'no suiteChild result').toBeTruthy();
      expect(child.code, `suite-class child stderr tail:\n${child.stderrTail}`).toBe(0);

      // The suite-class child must ACQUIRE (or wait on) the suite lane — the
      // lane-scoped skip must NOT shelter it under the targeted holder (§2.5).
      const childAcq = acquireEventFor(ledger, child.pid!);
      expect(
        childAcq,
        'suite-class child under a targeted holder did not acquire — it skipped (lane-blindness regression)',
      ).toBeTruthy();
      expect(childAcq!.lane).toBe('suite');
      expect(ledger.some((e) => e.kind === 'nested-skip' && e.pid === child.pid)).toBe(false);
    },
    240_000,
  );

  describe('(g) hung-holder fixture (§2.4 default = capacity-reclaim-ONLY)', () => {
    let sleepPid = -1;

    afterAll(() => {
      if (sleepPid > 0) {
        try {
          process.kill(sleepPid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    });

    it('frees a live-but-hung holder past TTL with NO signal, on both the prune and acquire paths', async () => {
      const sleeper = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' });
      sleepPid = sleeper.pid ?? -1;
      sleeper.unref();
      expect(sleepPid).toBeGreaterThan(1);
      // Give ps a beat to see the process.
      await new Promise((r) => setTimeout(r, 200));

      const realNow = Date.now();
      const TTL = 300_000; // the §2.4 floor — a valid short ttlMs
      const seedRow = () => ({
        v: 1,
        id: `meta-hung-${Math.random().toString(36).slice(2, 8)}`,
        lane: 'suite',
        pid: sleepPid,
        hostname: os.hostname(),
        acquiredAt: realNow, // start-time corroboration must PASS (not pid-reuse)
        startedAt: '',
        cmd: 'node vitest run (meta fixture hung root)',
        ttlMs: TTL,
        state: 'held',
      });
      const injectedNow = () => realNow + TTL + 10_000; // hold aged past TTL

      // ── prune path (the POST /prune policy) ────────────────────────────
      const scenarioP = makeScenarioDir('hung-prune');
      const universeP = makeUniverse(scenarioP);
      fs.writeFileSync(
        path.join(universeP, 'host-test-runner-holders.json'),
        JSON.stringify({ v: 1, holders: [seedRow()] }),
      );
      const pathsP = resolveTestRunnerPaths({ INSTAR_HOST_TEST_BASE_DIR: universeP } as NodeJS.ProcessEnv);
      const semP = new HostTestRunnerSemaphore({
        paths: pathsP,
        env: {},
        now: injectedNow,
        dfProbe: () => ({ status: 'local' as const }),
      });
      const report = semP.prune({ source: 'meta-test', force: true });
      expect(report.rateLimited).not.toBe(true);
      expect(report.reclaimed).toEqual([
        expect.objectContaining({ pid: sleepPid, reason: 'ttl-capacity-reclaim' }),
      ]);
      const ledgerP = readLedger(universeP);
      const staleP = ledgerP.find((e) => e.kind === 'stale-holder-reclaimed');
      expect(staleP, 'prune did not ledger stale-holder-reclaimed').toBeTruthy();
      expect(staleP!.pid === sleepPid || staleP!['pid'] === sleepPid).toBe(true);
      expect(staleP!['pidAlive']).toBe(true);
      expect(ledgerP.some((e) => e.kind === 'signal-term' || e.kind === 'signal-kill')).toBe(false);
      const holdersP = JSON.parse(fs.readFileSync(pathsP.holders, 'utf-8'));
      expect(holdersP.holders).toEqual([]);

      // ── acquire path (a hung holder must not false-BLOCK cap-1) ────────
      const scenarioA = makeScenarioDir('hung-acquire');
      const universeA = makeUniverse(scenarioA);
      writeTuning(universeA, { enforcing: true });
      fs.writeFileSync(
        path.join(universeA, 'host-test-runner-holders.json'),
        JSON.stringify({ v: 1, holders: [seedRow()] }),
      );
      const pathsA = resolveTestRunnerPaths({ INSTAR_HOST_TEST_BASE_DIR: universeA } as NodeJS.ProcessEnv);
      const semA = new HostTestRunnerSemaphore({
        paths: pathsA,
        env: {},
        now: injectedNow,
        dfProbe: () => ({ status: 'local' as const }),
      });
      const outcome = await semA.acquire({ lane: 'suite', runClass: 'background', budgetMs: 5000 });
      expect(
        outcome.kind,
        'ENFORCING acquire was blocked by a hung-past-TTL holder (the §1.2 false-BLOCK)',
      ).toBe('acquired');
      const ledgerA = readLedger(universeA);
      expect(ledgerA.some((e) => e.kind === 'stale-holder-reclaimed')).toBe(true);
      expect(ledgerA.some((e) => e.kind === 'signal-term' || e.kind === 'signal-kill')).toBe(false);
      expect(ledgerA.some((e) => e.kind === 'block')).toBe(false);

      // NO signal was ever sent: the hung pid is STILL ALIVE.
      expect(() => process.kill(sleepPid, 0)).not.toThrow();
    }, 60_000);
  });

  it(
    '(h) corrupt holders file: next root ADMITS and quarantines aside with keep-newest-5 retention',
    async () => {
      const scenario = makeScenarioDir('corrupt');
      const universe = makeUniverse(scenario);
      const holdersPath = path.join(universe, 'host-test-runner-holders.json');
      fs.writeFileSync(holdersPath, '{{{ this is definitely not JSON [');

      // Seed 6 pre-existing quarantine files (older timestamps) so the
      // keep-newest-5 retention has something to trim.
      const seededTs: number[] = [];
      for (let i = 0; i < 6; i++) {
        const ts = Date.now() - 60_000 + i * 1000;
        seededTs.push(ts);
        fs.writeFileSync(
          path.join(universe, `host-test-runner-holders.corrupt-${ts}.json`),
          '{"seeded": true}',
        );
      }

      const root = spawnRoot({ universe, args: [QUICK] });
      const res = await root.done;

      // ADMITTED: the corrupt file must not wedge the run (§1.1 fail-OPEN).
      expect(res.code, `root stderr tail:\n${res.stderr}`).toBe(0);

      const ledger = readLedger(universe);
      const quarantine = ledger.find((e) => e.kind === 'quarantine');
      expect(quarantine, 'no quarantine ledger event').toBeTruthy();
      expect(quarantine!['cause']).toBe('unparseable');
      expect(acquireEventFor(ledger, res.pid), 'corrupt-file root did not acquire').toBeTruthy();

      // Fresh holders file via the single repair path (run released → empty).
      const holders = JSON.parse(fs.readFileSync(holdersPath, 'utf-8'));
      expect(Array.isArray(holders.holders)).toBe(true);
      expect(holders.holders).toEqual([]);

      // Quarantined aside + keep-newest-5 retention: 6 seeded + 1 new = 7 →
      // the 2 oldest are deleted, the newest 5 (incl. the new aside) remain.
      const quarantineFiles = fs
        .readdirSync(universe)
        .filter((f) => f.startsWith('host-test-runner-holders.corrupt-'))
        .sort();
      expect(
        quarantineFiles.length,
        `retention kept ${quarantineFiles.length} quarantine files: ${quarantineFiles.join(', ')}`,
      ).toBe(5);
      const oldestTwo = [seededTs[0], seededTs[1]].map(
        (ts) => `host-test-runner-holders.corrupt-${ts}.json`,
      );
      for (const gone of oldestTwo) {
        expect(quarantineFiles.includes(gone), `${gone} should have been retention-trimmed`).toBe(false);
      }
      const newest = quarantineFiles[quarantineFiles.length - 1];
      const newestTs = Number(newest.replace('host-test-runner-holders.corrupt-', '').replace('.json', ''));
      expect(newestTs, 'the fresh quarantine aside is missing').toBeGreaterThan(seededTs[5]);
    },
    120_000,
  );
});
