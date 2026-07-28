/**
 * testRunnerRunClassifier unit tests — the classifier arm of the §5 unit tier
 * of docs/specs/test-runner-concurrency-bound.md (split out of
 * host-test-runner-semaphore.test.ts; permitted by the test plan).
 *
 * Covers: matched-file-set classification under vitest filter semantics (NOT
 * argv existence — §2.3 round 8), the pool-shaping argv matrix, the CLI-proof
 * neutralize+clamp pair (§2.5 round 9/10), the hardened CI predicate (§2.6),
 * the lane-scoped ancestry+holders re-entrancy cross-check (§2.5), and the
 * config-eval seam's dry-run/clamp-active honesty (§2.11) via
 * withTestRunnerBound.
 *
 * REAL worker-count measurements and acquire-before-fanout remain
 * meta-verification-tier per the spec — not faked here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  analyzeVitestArgv,
  ancestryPids,
  checkNestedUnderHolder,
  clampConfigPool,
  classifyTargetedRun,
  deriveRunClass,
  findPoolShapingArgv,
  isAgentContext,
  isCiEnvironment,
  isKillSwitchOff,
  neutralizePoolShapingArgv,
  resolveIncludedTestFiles,
  resolvedPoolBound,
} from '../../src/core/testRunnerRunClassifier.js';
import {
  TARGETED_FILE_LIMIT,
  resolveTestRunnerPaths,
  writeTuningFile,
  type TestRunnerHolderRow,
  type TestRunnerPaths,
} from '../../src/core/hostTestRunnerSemaphore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  GLOBAL_SETUP_ENTRY,
  POOL_CLAMP_MAX,
  withTestRunnerBound,
} from '../setup/test-runner-bound.config-eval.js';

// ── Fixture helpers ────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'test-runner-run-classifier.test:cleanup-tmpdir',
      });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/** Build a fixture repo root holding tests/unit/<files>. */
function fixtureRoot(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trb-cls-'));
  tmpDirs.push(root);
  for (const f of files) {
    const p = path.join(root, 'tests', 'unit', f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '// fixture');
  }
  return root;
}

const INCLUDE = ['tests/unit/**/*.test.ts'];

function argvOf(...rest: string[]): ReturnType<typeof analyzeVitestArgv> {
  return analyzeVitestArgv(['node', '/repo/node_modules/.bin/vitest', ...rest]);
}

let idSeq = 0;
function holderRow(over: Partial<TestRunnerHolderRow> = {}): TestRunnerHolderRow {
  return {
    v: 1,
    id: `cls-${++idSeq}`,
    lane: 'suite',
    pid: 39_000,
    hostname: 'h',
    acquiredAt: Date.now(),
    startedAt: '',
    cmd: 'node vitest',
    ttlMs: 3_600_000,
    state: 'held',
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// §2.3 argv analysis
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.3 analyzeVitestArgv (conservative allowlist)', () => {
  it('trims node + vitest script tokens and extracts subcommand/positionals', () => {
    const a = argvOf('run', 'a.test.ts', 'b.test.ts');
    expect(a.subcommand).toBe('run');
    expect(a.positionals).toEqual(['a.test.ts', 'b.test.ts']);
    expect(a.explicitWatch).toBe(false);
    expect(a.isList).toBe(false);
  });

  it('detects explicit watch (subcommand, --watch, -w) and list invocations', () => {
    expect(argvOf('watch').explicitWatch).toBe(true);
    expect(argvOf('run', '--watch').explicitWatch).toBe(true);
    expect(argvOf('run', '-w').explicitWatch).toBe(true);
    expect(argvOf('list').isList).toBe(true);
  });

  it('safe value-taking flags consume their value token; unknown flags are recorded (conservative disqualifier)', () => {
    const a = argvOf('run', '--reporter', 'dot', 'a.test.ts', '--config=vitest.x.ts');
    expect(a.positionals).toEqual(['a.test.ts']);
    expect(a.unknownFlags).toEqual([]);
    const b = argvOf('run', 'a.test.ts', '-t', 'some name');
    expect(b.unknownFlags).toContain('-t');
    const c = argvOf('run', 'a.test.ts', '--project=server');
    expect(c.unknownFlags).toContain('--project=server');
  });

  it('recognizes EVERY pool-shaping flag (§2.3): --maxWorkers/--minWorkers/--pool/--poolOptions.*/--fileParallelism/--no-isolate', () => {
    for (const flag of [
      '--maxWorkers=16',
      '--maxWorkers',
      '--max-workers=16',
      '--minWorkers=2',
      '--pool=threads',
      '--pool',
      '--poolOptions.threads.maxThreads=8',
      '--fileParallelism=false',
      '--no-isolate',
    ]) {
      expect(argvOf('run', 'a.test.ts', flag).poolShaping, flag).toContain(flag);
      expect(findPoolShapingArgv([flag]), flag).toEqual([flag]);
    }
    // Non-pool flags are NOT swept up.
    expect(findPoolShapingArgv(['--reporter=dot', 'a.test.ts'])).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.3 matched-file-set classification (STATE, not argv existence)
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.3 classifyTargetedRun — verify the MATCHED set, never argv existence', () => {
  it('the substring-filter adversarial fixture: `vitest run e.test.ts` where a REAL e.test.ts exists but the positional matches many test paths ⇒ suite-class, matchedCount = MATCHED count (never the argv count)', () => {
    const root = fixtureRoot(['e.test.ts', 'core.test.ts', 'route.test.ts']);
    const included = resolveIncludedTestFiles(INCLUDE, root);
    expect(included).toHaveLength(3);
    // The file EXISTS on disk — argv-existence would call this "1 file"...
    expect(fs.existsSync(path.join(root, 'tests/unit/e.test.ts'))).toBe(true);
    const cls = classifyTargetedRun(argvOf('run', 'e.test.ts'), included, root);
    // ...but vitest positionals are substring FILTERS: it matches all 3 paths.
    expect(cls.targeted).toBe(false);
    expect(cls.matchedCount).toBe(3);
    expect(cls.reason).toContain('multi-match');
  });

  it('a positional matching EXACTLY ONE file with union ≤ K is targeted, with the matched count reported', () => {
    const root = fixtureRoot(['e.test.ts', 'core.test.ts', 'route.test.ts']);
    const included = resolveIncludedTestFiles(INCLUDE, root);
    const cls = classifyTargetedRun(argvOf('run', 'core.test.ts'), included, root);
    expect(cls).toEqual({ targeted: true, matchedCount: 1, reason: 'exact-match-set' });
  });

  it('a DIRECTORY positional routes suite-class', () => {
    const root = fixtureRoot(['a.test.ts']);
    const included = resolveIncludedTestFiles(INCLUDE, root);
    const cls = classifyTargetedRun(argvOf('run', 'tests/unit'), included, root);
    expect(cls.targeted).toBe(false);
    expect(cls.reason).toContain('directory-positional');
  });

  it('a GLOB positional routes suite-class', () => {
    const root = fixtureRoot(['a.test.ts']);
    const included = resolveIncludedTestFiles(INCLUDE, root);
    const cls = classifyTargetedRun(argvOf('run', 'tests/unit/*.test.ts'), included, root);
    expect(cls.targeted).toBe(false);
    expect(cls.reason).toContain('glob-positional');
  });

  it('-t / --project (any non-allowlisted filter flag) routes suite-class', () => {
    const root = fixtureRoot(['a.test.ts']);
    const included = resolveIncludedTestFiles(INCLUDE, root);
    expect(classifyTargetedRun(argvOf('run', 'a.test.ts', '-t', 'x'), included, root).targeted).toBe(false);
    expect(
      classifyTargetedRun(argvOf('run', 'a.test.ts', '--project=server'), included, root).targeted,
    ).toBe(false);
  });

  it('more than K matched files routes suite-class; exactly K stays targeted (K = TARGETED_FILE_LIMIT = 5)', () => {
    const names = ['alpha', 'bravo', 'gamma', 'delta', 'kappa', 'sigma'].map((n) => `${n}.test.ts`);
    const root = fixtureRoot(names);
    const included = resolveIncludedTestFiles(INCLUDE, root);
    expect(TARGETED_FILE_LIMIT).toBe(5);
    const over = classifyTargetedRun(argvOf('run', ...names), included, root);
    expect(over.targeted).toBe(false);
    expect(over.matchedCount).toBe(6);
    expect(over.reason).toContain('>K');
    const atK = classifyTargetedRun(argvOf('run', ...names.slice(0, 5)), included, root);
    expect(atK).toEqual({ targeted: true, matchedCount: 5, reason: 'exact-match-set' });
  });

  it('ANY pool-shaping flag routes suite-class even with a perfectly targeted positional (§2.3 defense-in-depth)', () => {
    const root = fixtureRoot(['a.test.ts']);
    const included = resolveIncludedTestFiles(INCLUDE, root);
    for (const flag of [
      '--maxWorkers=16',
      '--minWorkers=2',
      '--pool=threads',
      '--poolOptions.threads.maxThreads=8',
      '--fileParallelism=false',
      '--no-isolate',
    ]) {
      const cls = classifyTargetedRun(argvOf('run', 'a.test.ts', flag), included, root);
      expect(cls.targeted, flag).toBe(false);
      expect(cls.reason, flag).toContain('pool-shaping-argv');
    }
  });

  it('zero positionals / a no-match positional route suite-class (safe superset — never fail open to the roomy lane)', () => {
    const root = fixtureRoot(['a.test.ts']);
    const included = resolveIncludedTestFiles(INCLUDE, root);
    expect(classifyTargetedRun(argvOf('run'), included, root)).toMatchObject({
      targeted: false,
      reason: 'no-positional-filters',
    });
    expect(classifyTargetedRun(argvOf('run', 'zzz.test.ts'), included, root)).toMatchObject({
      targeted: false,
      matchedCount: 0,
    });
  });

  it('resolveIncludedTestFiles walks the include set, dedupes, and skips node_modules/dot-dirs', () => {
    const root = fixtureRoot(['a.test.ts', 'sub/deep.test.ts']);
    fs.mkdirSync(path.join(root, 'tests/unit/node_modules/x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/unit/node_modules/x/evil.test.ts'), '');
    fs.mkdirSync(path.join(root, 'tests/unit/.hidden'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests/unit/.hidden/h.test.ts'), '');
    const included = resolveIncludedTestFiles([...INCLUDE, ...INCLUDE], root);
    expect(included.sort()).toEqual(['tests/unit/a.test.ts', 'tests/unit/sub/deep.test.ts']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.3/§2.5 resolved-pool bound + CLI-proof neutralize/clamp pair
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.3 resolvedPoolBound (the STATE check)', () => {
  it('absent/unknown pool settings resolve to null (unbounded ⇒ suite-class)', () => {
    expect(resolvedPoolBound({})).toBeNull();
  });

  it('reads maxWorkers (number or numeric string) and every poolOptions max*, taking the MAX bound', () => {
    expect(resolvedPoolBound({ maxWorkers: 3 })).toBe(3);
    expect(resolvedPoolBound({ maxWorkers: '5' })).toBe(5);
    expect(resolvedPoolBound({ maxWorkers: 2, poolOptions: { forks: { maxForks: 9 } } })).toBe(9);
    expect(resolvedPoolBound({ poolOptions: { vmThreads: { maxThreads: 7 } } })).toBe(7);
  });

  it('fileParallelism:false bounds file concurrency to 1', () => {
    expect(resolvedPoolBound({ fileParallelism: false, maxWorkers: 32 })).toBe(1);
  });
});

describe('§2.5 CLI-proof nested clamp — neutralizePoolShapingArgv + clampConfigPool', () => {
  it('neutralizePoolShapingArgv strips recognized flags in both =value and space-value forms, keeping everything else', () => {
    const { argv, removed } = neutralizePoolShapingArgv([
      'node',
      '/x/vitest',
      'run',
      'one.test.ts',
      '--maxWorkers=32',
      '--pool',
      'threads',
      '--fileParallelism',
      'false',
      '--no-isolate',
      '--reporter=dot',
    ]);
    expect(argv).toEqual(['node', '/x/vitest', 'run', 'one.test.ts', '--reporter=dot']);
    expect(removed).toEqual([
      '--maxWorkers=32',
      '--pool',
      'threads',
      '--fileParallelism',
      'false',
      '--no-isolate',
    ]);
  });

  it('neutralize never eats a following flag or positional as a boolean-flag "value"', () => {
    const { argv } = neutralizePoolShapingArgv(['--no-isolate', 'one.test.ts', '--maxWorkers', '--reporter']);
    // one.test.ts is not true/false → kept; --reporter is a flag → not consumed as a value.
    expect(argv).toEqual(['one.test.ts', '--reporter']);
  });

  it('clampConfigPool is Math.min(resolved, 4): a nested run legitimately requesting FEWER than 4 keeps its lower value (round 10 — a ceiling, never a floor)', () => {
    const low = clampConfigPool({ maxWorkers: 2 }, POOL_CLAMP_MAX) as Record<string, unknown>;
    expect(low.maxWorkers).toBe(2); // NOT raised to 4
    const high = clampConfigPool({ maxWorkers: 32 }, POOL_CLAMP_MAX) as Record<string, unknown>;
    expect(high.maxWorkers).toBe(4);
  });

  it('clampConfigPool caps every poolOptions max* and reconciles minWorkers > maxWorkers', () => {
    const t = clampConfigPool(
      {
        maxWorkers: 8,
        minWorkers: 6,
        poolOptions: { threads: { maxThreads: 12 }, forks: { maxForks: 2 } },
      },
      POOL_CLAMP_MAX,
    ) as {
      maxWorkers: number;
      minWorkers: number;
      poolOptions: Record<string, Record<string, number>>;
    };
    expect(t.maxWorkers).toBe(4);
    expect(t.minWorkers).toBe(4); // reconciled down to the clamped max
    expect(t.poolOptions.threads.maxThreads).toBe(4);
    expect(t.poolOptions.forks.maxForks).toBe(2); // lower value kept
    expect(t.poolOptions.vmThreads.maxThreads).toBe(4);
    expect(t.poolOptions.vmForks.maxForks).toBe(4);
  });

  it('N concurrent nested launches are each ≤4 with ZERO coordination (per-config clamp; the measured-worker proof is meta-tier)', () => {
    const configs = Array.from({ length: 5 }, (_, i) => ({ maxWorkers: 8 + i }));
    for (const c of configs) {
      const clamped = clampConfigPool(c, POOL_CLAMP_MAX) as { maxWorkers: number };
      expect(clamped.maxWorkers).toBeLessThanOrEqual(4);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.6 CI / off / run-class predicates
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.6 hardened CI predicate + kill switch + run-class derivation', () => {
  it("isCiEnvironment: CI must be EXACTLY 'true'/'1' AND a positive signal must be present", () => {
    expect(isCiEnvironment({})).toBe(false);
    expect(isCiEnvironment({ CI: 'true' })).toBe(false); // a stray local export
    expect(isCiEnvironment({ CI: 'true', GITHUB_ACTIONS: 'true' })).toBe(true);
    expect(isCiEnvironment({ CI: '1', RUNNER_OS: 'macOS' })).toBe(true);
    // The truthy-trap: CI=false is a TRUTHY string and must NOT skip.
    expect(isCiEnvironment({ CI: 'false', GITHUB_ACTIONS: 'true' })).toBe(false);
    expect(isCiEnvironment({ CI: 'yes', GITHUB_ACTIONS: 'true' })).toBe(false);
  });

  it('isAgentContext recognizes tmux/session/background markers', () => {
    expect(isAgentContext({})).toBe(false);
    expect(isAgentContext({ TMUX: '/tmp/x' })).toBe(true);
    expect(isAgentContext({ INSTAR_SESSION_ID: 's' })).toBe(true);
    expect(isAgentContext({ CLAUDE_CODE_SESSION_ID: 'c' })).toBe(true);
    expect(isAgentContext({ INSTAR_HOST_TEST_RUN_CLASS: 'background' })).toBe(true);
  });

  it('isKillSwitchOff matches only the env kill switch value (case-insensitive off)', () => {
    expect(isKillSwitchOff({})).toBe(false);
    expect(isKillSwitchOff({ INSTAR_HOST_TEST_SEMAPHORE: 'off' })).toBe(true);
    expect(isKillSwitchOff({ INSTAR_HOST_TEST_SEMAPHORE: 'OFF' })).toBe(true);
    expect(isKillSwitchOff({ INSTAR_HOST_TEST_SEMAPHORE: 'on' })).toBe(false);
  });

  it('deriveRunClass: server-set background hint wins; push config is interactive; otherwise TTY decides (§1.1 bias)', () => {
    expect(deriveRunClass('unit', { INSTAR_HOST_TEST_RUN_CLASS: 'background' }, true)).toBe('background');
    expect(deriveRunClass('push', {}, false)).toBe('interactive');
    expect(deriveRunClass('unit', {}, true)).toBe('interactive');
    expect(deriveRunClass('unit', {}, false)).toBe('background');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.5 re-entrancy — lane-scoped ancestry + holders cross-check
// ═══════════════════════════════════════════════════════════════════════════

describe('§2.5 checkNestedUnderHolder — the ancestry+holders check is the AUTHORITY; the marker only hints', () => {
  it('a SAME-lane live ancestor holder ⇒ nested (skip), with the sheltering root pid + slot-id', () => {
    const rows = [holderRow({ pid: 39_100, lane: 'suite', id: 'slot-a' })];
    const res = checkNestedUnderHolder(rows, 'suite', { ancestors: [39_100, 1] });
    expect(res).toEqual({
      nested: true,
      shelteringPid: 39_100,
      shelteringSlotId: 'slot-a',
      anyLaneAncestorHolder: true,
    });
  });

  it('LANE-SCOPED (round 4): a suite-class child under a TARGETED-only ancestor does NOT skip — but the any-lane flag still drives the unconditional clamp', () => {
    const rows = [holderRow({ pid: 39_101, lane: 'targeted' })];
    const res = checkNestedUnderHolder(rows, 'suite', { ancestors: [39_101] });
    expect(res.nested).toBe(false); // acquires/waits on the suite lane — ordinary queuing
    expect(res.anyLaneAncestorHolder).toBe(true); // still clamped ≤4
  });

  it('works WITHOUT the env marker (scrubbed-env child skips via pure ancestry)', () => {
    const rows = [holderRow({ pid: 39_102, lane: 'targeted' })];
    const res = checkNestedUnderHolder(rows, 'targeted', {
      ancestors: [39_102],
      envMarker: undefined,
    });
    expect(res.nested).toBe(true);
  });

  it('a stale/foreign/leaked marker NEVER creates a skip by itself (no ancestor holder ⇒ not nested)', () => {
    const res = checkNestedUnderHolder([holderRow({ pid: 39_103 })], 'suite', {
      ancestors: [1], // the holder is NOT an ancestor
      envMarker: '39103:leaked',
    });
    expect(res.nested).toBe(false);
    expect(res.anyLaneAncestorHolder).toBe(false);
  });

  it('the marker is a hint, not the authority: a REAL same-lane ancestor holder skips even when the marker names a different pid', () => {
    const rows = [holderRow({ pid: 39_104, lane: 'suite' })];
    const res = checkNestedUnderHolder(rows, 'suite', {
      ancestors: [39_104],
      envMarker: '99999:stale',
    });
    expect(res.nested).toBe(true); // ancestry+holders facts win
  });

  it('a DEAD ancestor row and a terminating tombstone are never counted as shelter', () => {
    const dead = checkNestedUnderHolder([holderRow({ pid: 39_105 })], 'suite', {
      ancestors: [39_105],
      pidAlive: () => false,
    });
    expect(dead.nested).toBe(false);
    const tomb = checkNestedUnderHolder(
      [holderRow({ pid: 39_106, state: 'terminating' })],
      'suite',
      { ancestors: [39_106] },
    );
    expect(tomb.nested).toBe(false);
  });

  it('ancestryPids walks the real ppid chain (bounded) and includes the direct parent', () => {
    const chain = ancestryPids();
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(chain.length).toBeLessThanOrEqual(25);
    expect(chain[0]).toBe(process.ppid);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2.2/§2.11 withTestRunnerBound — the config-eval seam
// ═══════════════════════════════════════════════════════════════════════════

describe('withTestRunnerBound (config-eval seam — §2.2 wiring, §2.11 dry-run honesty, §2.5 nested clamp)', () => {
  const MANAGED_ENV = [
    'INSTAR_HOST_TEST_BASE_DIR',
    'INSTAR_HOST_TEST_SEMAPHORE',
    'INSTAR_HOST_TEST_ENFORCE',
    'INSTAR_TEST_SEMAPHORE_HELD',
    '__INSTAR_TRB_CONFIG',
    '__INSTAR_TRB_TARGETED',
    '__INSTAR_TRB_CLAMPED',
    'CI',
    'GITHUB_ACTIONS',
    'RUNNER_OS',
  ] as const;

  let savedEnv: Record<string, string | undefined>;
  let savedArgv: string[];
  let paths: TestRunnerPaths;

  beforeEach(() => {
    savedEnv = {};
    for (const k of MANAGED_ENV) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    savedArgv = process.argv;
    process.argv = ['node', '/repo/node_modules/.bin/vitest', 'run'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trb-cfg-'));
    tmpDirs.push(dir);
    paths = resolveTestRunnerPaths({ INSTAR_HOST_TEST_BASE_DIR: dir });
    process.env.INSTAR_HOST_TEST_BASE_DIR = dir;
  });

  afterEach(() => {
    for (const k of MANAGED_ENV) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    process.argv = savedArgv;
  });

  function ledgerEvents(): Array<Record<string, unknown>> {
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

  function writeHolders(rows: unknown[]): void {
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(paths.holders, JSON.stringify({ v: 1, holders: rows }));
  }

  it('wires BOTH per-config seams: the globalSetup entry is PREPENDED (teardown runs in reverse) and the worker env marker is injected via test.env (§2.2/§2.5)', () => {
    const cfg = withTestRunnerBound('integration', {
      test: { globalSetup: ['tests/setup/build-dist.globalSetup.ts'] },
    });
    const test = cfg.test as Record<string, unknown>;
    expect(test.globalSetup).toEqual([
      GLOBAL_SETUP_ENTRY,
      'tests/setup/build-dist.globalSetup.ts', // dist build AFTER the slot acquire
    ]);
    expect((test.env as Record<string, string>).INSTAR_TEST_SEMAPHORE_HELD).toBe(
      `${process.pid}:cfg`,
    );
    expect(process.env.__INSTAR_TRB_CONFIG).toBe('integration');
  });

  it('§2.11 dry-run honesty (targeted): the clamp does NOT reshape the real pool — `would-clamp` is ledgered with the natural pool bound instead', () => {
    process.argv = ['node', '/x/vitest', 'run', 'host-semaphore-core.test.ts'];
    const cfg = withTestRunnerBound('unit', {
      test: { include: ['tests/unit/**/*.test.ts'], maxWorkers: 16 },
    });
    const test = cfg.test as Record<string, unknown>;
    expect(test.maxWorkers).toBe(16); // NOT reshaped in dry-run (zero behavior change)
    const wc = ledgerEvents().filter((e) => e.kind === 'would-clamp');
    expect(wc).toHaveLength(1);
    expect(wc[0].variant).toBe('targeted');
    expect(wc[0].naturalPoolBound).toBe(16);
    expect(wc[0].matchedCount).toBe(1);
    // The stash carries the classification for the globalSetup's lane routing.
    expect(JSON.parse(process.env.__INSTAR_TRB_TARGETED!)).toMatchObject({
      targeted: true,
      matchedCount: 1,
    });
    expect(process.env.__INSTAR_TRB_CLAMPED).toBe('dry-run');
  });

  it('clamp-active sub-stage (tuning clampActive:true): the targeted clamp becomes REAL (pool reshaped ≤4) while blocking stays off (§2.11/§4 stage 2)', () => {
    writeTuningFile(paths, { v: 1, clampActive: true }); // NOT enforcing
    process.argv = ['node', '/x/vitest', 'run', 'host-semaphore-core.test.ts'];
    const cfg = withTestRunnerBound('unit', {
      test: { include: ['tests/unit/**/*.test.ts'], maxWorkers: 16 },
    });
    expect((cfg.test as Record<string, unknown>).maxWorkers).toBe(POOL_CLAMP_MAX);
    expect(process.env.__INSTAR_TRB_CLAMPED).toBe('targeted');
    expect(ledgerEvents().filter((e) => e.kind === 'would-clamp')).toHaveLength(0);
  });

  it('a NON-targeted argv (multi-match/no positionals) stashes targeted:false and never clamps or ledgers would-clamp', () => {
    process.argv = ['node', '/x/vitest', 'run']; // whole suite
    const cfg = withTestRunnerBound('unit', {
      test: { include: ['tests/unit/**/*.test.ts'], maxWorkers: 16 },
    });
    expect((cfg.test as Record<string, unknown>).maxWorkers).toBe(16);
    expect(JSON.parse(process.env.__INSTAR_TRB_TARGETED!)).toMatchObject({ targeted: false });
    expect(ledgerEvents().filter((e) => e.kind === 'would-clamp')).toHaveLength(0);
  });

  it('§2.5 nested (dry-run): an ANY-lane ancestor holder ledgers `would-clamp` variant nested with the sheltering pid — the pool is NOT reshaped', () => {
    writeHolders([holderRow({ pid: process.ppid, lane: 'targeted' })]);
    const cfg = withTestRunnerBound('integration', { test: { maxWorkers: 16 } });
    expect((cfg.test as Record<string, unknown>).maxWorkers).toBe(16);
    const wc = ledgerEvents().filter((e) => e.kind === 'would-clamp');
    expect(wc).toHaveLength(1);
    expect(wc[0].variant).toBe('nested');
    expect(wc[0].naturalPoolBound).toBe(16);
    // The ancestor here holds a DIFFERENT lane than the child would acquire —
    // the any-lane shelter still drives the (would-)clamp (§2.5 round 8);
    // same-lane sheltering-pid attribution is asserted on the nested-skip
    // event in host-test-runner-semaphore.test.ts.
    expect(wc[0]).toHaveProperty('shelteringPid');
    expect(process.env.__INSTAR_TRB_CLAMPED).toBe('dry-run');
  });

  it('§2.5 nested (clamp-active): pool-shaping argv is NEUTRALIZED from process.argv AND the pool is hard-clamped Math.min(resolved,4) — CLI-proof (round 9)', () => {
    writeTuningFile(paths, { v: 1, clampActive: true });
    writeHolders([holderRow({ pid: process.ppid, lane: 'suite' })]);
    process.argv = ['node', '/x/vitest', 'run', 'x.test.ts', '--maxWorkers=32'];
    const cfg = withTestRunnerBound('integration', { test: { maxWorkers: 32 } });
    expect((cfg.test as Record<string, unknown>).maxWorkers).toBe(POOL_CLAMP_MAX);
    expect(process.argv).not.toContain('--maxWorkers=32'); // stripped before vitest's CLI parser
    expect(process.argv).toContain('x.test.ts'); // positionals survive
    expect(process.env.__INSTAR_TRB_CLAMPED).toBe('nested');
  });

  it('§2.5 nested (clamp-active): a nested run that legitimately requested FEWER than 4 workers keeps its lower value (round 10)', () => {
    writeTuningFile(paths, { v: 1, clampActive: true });
    writeHolders([holderRow({ pid: process.ppid, lane: 'suite' })]);
    const cfg = withTestRunnerBound('integration', { test: { maxWorkers: 2 } });
    expect((cfg.test as Record<string, unknown>).maxWorkers).toBe(2); // a ceiling, never a floor
  });

  it('kill switch / CI / explicit-watch short-circuit classification but STILL wire the globalSetup entry (skips are the globalSetup\'s job)', () => {
    process.env.INSTAR_HOST_TEST_SEMAPHORE = 'off';
    const offCfg = withTestRunnerBound('unit', { test: { include: INCLUDE, maxWorkers: 16 } });
    expect((offCfg.test as Record<string, unknown>).globalSetup).toContain(GLOBAL_SETUP_ENTRY);
    expect(process.env.__INSTAR_TRB_TARGETED).toBeUndefined();
    delete process.env.INSTAR_HOST_TEST_SEMAPHORE;
    process.env.CI = 'true';
    process.env.GITHUB_ACTIONS = 'true';
    const ciCfg = withTestRunnerBound('unit', { test: { include: INCLUDE, maxWorkers: 16 } });
    expect((ciCfg.test as Record<string, unknown>).globalSetup).toContain(GLOBAL_SETUP_ENTRY);
    expect((ciCfg.test as Record<string, unknown>).maxWorkers).toBe(16);
    delete process.env.CI;
    delete process.env.GITHUB_ACTIONS;
    process.argv = ['node', '/x/vitest', '--watch'];
    const watchCfg = withTestRunnerBound('unit', { test: { include: INCLUDE, maxWorkers: 16 } });
    expect((watchCfg.test as Record<string, unknown>).globalSetup).toContain(GLOBAL_SETUP_ENTRY);
    expect((watchCfg.test as Record<string, unknown>).maxWorkers).toBe(16);
  });

  it('FAIL-OPEN (§1.1): an internal config-eval error leaves the config usable (globalSetup wired where possible), never a throw', () => {
    // A poisoned include value makes resolveIncludedTestFiles/classification
    // throw internally; the config must come back usable.
    const evil = {
      test: {
        include: { not: 'an-array' } as unknown as string[],
        maxWorkers: 16,
      },
    };
    process.argv = ['node', '/x/vitest', 'run', 'host-semaphore-core.test.ts'];
    expect(() => withTestRunnerBound('unit', evil)).not.toThrow();
  });
});
