/**
 * testRunnerRunClassifier — run-class differentiation + skip detection for the
 * test-runner concurrency bound (spec §2.3/§2.5/§2.6).
 *
 * Pure logic (no holders/lock I/O beyond an injected holders read + `ps`
 * ancestry walk) so the vitest config-eval helper and the globalSetup
 * chokepoint consume ONE shared classifier — the two evaluation points must
 * never disagree in the dangerous direction, and sharing the code is how
 * (State-Not-Symbol: the globalSetup additionally verifies the RESOLVED
 * config's live pool bound — a symbol never binds the two points).
 *
 * CLASSIFICATION IS CONSERVATIVE BY PINNED DESIGN (§2.3): vitest positionals
 * are substring FILTERS, not exact selectors, so a run is targeted ONLY if
 * every positional matches EXACTLY ONE file under filter expansion against
 * the resolved include set, the union is ≤ K files, and NO pool-shaping or
 * filter flags are present. Every ambiguity routes suite-class (safe
 * superset) — version drift can only ever mis-route toward the STRICTER lane.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { TARGETED_FILE_LIMIT, type TestLane, type TestRunClass, classifyRow, type TestRunnerHolderRow } from './hostTestRunnerSemaphore.js';

// ── Pool-shaping argv (§2.3 — disqualifies at BOTH evaluation points) ─────

/**
 * Recognized pool-shaping flags (defense-in-depth; the resolved-state check is
 * the guarantee). Kebab and camel variants both match; `=value` suffix too.
 */
const POOL_SHAPING_FLAG_RE =
  /^--?(no-)?(max-?workers|min-?workers|pool|pool-?options(\..+)?|file-?parallelism|isolate)(=.*)?$/i;

export function findPoolShapingArgv(argv: string[]): string[] {
  return argv.filter((a) => POOL_SHAPING_FLAG_RE.test(a));
}

/**
 * Strip recognized pool-shaping flags (and their value token where the flag
 * form takes one) from an argv array. Used by the nested CLI-proof clamp
 * (§2.5) — the BELT alongside the config hard-set.
 *
 * VERSION NOTE (verified against vitest 2.1.9): mutating `process.argv` at
 * config-eval is a NO-OP on this line — vitest's `cac` parser reads the CLI
 * BEFORE the config module loads, so the pool flags are already resolved by
 * the time this runs. The load-bearing CLI-proofness therefore comes from the
 * config `clampConfigPool` hard-set of `poolOptions.*.{min,max}` (which outrank
 * a CLI `--maxWorkers`, measured in §5), NOT from this strip. This is kept as
 * the belt because (a) it is harmless, (b) it does work for children spawned
 * through `guarded-vitest.mjs`, and (c) vitest arg-parse order is not a stable
 * contract across versions. The residual it cannot reach — a CLI
 * `--poolOptions.forks.maxForks=N` that same-keys the config clamp — is caught
 * loud by the globalSetup `poolOverride` WARN (resolved pool > 4 → ledgered
 * `nested-skip clamped:false, poolOverride:true`), never silently unbounded.
 */
export function neutralizePoolShapingArgv(argv: string[]): { argv: string[]; removed: string[] } {
  const out: string[] = [];
  const removed: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!POOL_SHAPING_FLAG_RE.test(a)) {
      out.push(a);
      continue;
    }
    removed.push(a);
    if (!a.includes('=')) {
      const next = argv[i + 1];
      const isValueTaking = /^--?(max-?workers|min-?workers|pool|pool-?options)/i.test(a);
      if (next !== undefined) {
        if (isValueTaking && !next.startsWith('-')) {
          removed.push(next);
          i++;
        } else if (!isValueTaking && /^(true|false)$/i.test(next)) {
          removed.push(next);
          i++;
        }
      }
    }
  }
  return { argv: out, removed };
}

// ── Filter-argv extraction (conservative allowlist — §2.3) ────────────────

const SUBCOMMANDS = new Set(['run', 'watch', 'list', 'related', 'bench', 'dev', 'typecheck', 'init']);
/** Flags that do NOT disqualify a targeted classification (value-taking noted). */
const SAFE_FLAGS_WITH_VALUE = new Set(['--config', '--reporter', '--root', '--dir']);
const SAFE_BOOLEAN_FLAGS = new Set(['--run', '--silent', '--no-color', '--color', '--globals', '--passWithNoTests', '--pass-with-no-tests', '--allowOnly', '--allow-only']);

export interface ArgvAnalysis {
  subcommand: string | null;
  positionals: string[];
  poolShaping: string[];
  /** A flag outside the safe allowlist (── conservative: disqualifies targeted). */
  unknownFlags: string[];
  explicitWatch: boolean;
  isList: boolean;
}

/** Analyze a vitest argv (process.argv.slice(2) shape or full — both work). */
export function analyzeVitestArgv(argvIn: string[]): ArgvAnalysis {
  // Trim node + script tokens when a full process.argv is passed.
  let argv = argvIn;
  const scriptIdx = argvIn.findIndex((a) => /vitest(\.mjs|\.js)?$/.test(a) || a.endsWith('/vitest'));
  if (scriptIdx >= 0) argv = argvIn.slice(scriptIdx + 1);
  else if (argvIn[0] && /node(\.exe)?$/.test(argvIn[0])) argv = argvIn.slice(2);

  const analysis: ArgvAnalysis = {
    subcommand: null,
    positionals: [],
    poolShaping: [],
    unknownFlags: [],
    explicitWatch: false,
    isList: false,
  };
  let first = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (first && SUBCOMMANDS.has(a)) {
      analysis.subcommand = a;
      if (a === 'list') analysis.isList = true;
      if (a === 'watch') analysis.explicitWatch = true;
      first = false;
      continue;
    }
    first = false;
    if (a === '--watch' || a === '-w') {
      analysis.explicitWatch = true;
      continue;
    }
    if (POOL_SHAPING_FLAG_RE.test(a)) {
      analysis.poolShaping.push(a);
      continue;
    }
    if (a.startsWith('-')) {
      const base = a.split('=')[0];
      if (SAFE_FLAGS_WITH_VALUE.has(base)) {
        if (!a.includes('=')) i++; // consume the value token
        continue;
      }
      if (SAFE_BOOLEAN_FLAGS.has(base)) continue;
      analysis.unknownFlags.push(a);
      continue;
    }
    analysis.positionals.push(a);
  }
  return analysis;
}

// ── Include-set resolution + matched-file-set classification (§2.3) ───────

/**
 * Resolve the test files selected by simple include globs of the shape this
 * repo uses (`tests/<dir>/**\/*.test.ts`). Deliberately minimal: a pattern we
 * cannot interpret contributes NOTHING (and classification then routes
 * suite-class via zero/ambiguous matches — the safe direction).
 */
export function resolveIncludedTestFiles(includeGlobs: string[], rootDir: string): string[] {
  const out: string[] = [];
  for (const glob of includeGlobs) {
    const starIdx = glob.indexOf('*');
    if (starIdx < 0) {
      out.push(glob);
      continue;
    }
    const baseDir = glob.slice(0, starIdx).replace(/\/$/, '');
    const suffixMatch = glob.match(/\*\*\/\*(\.[a-z.]+)$/i) ?? glob.match(/\*(\.[a-z.]+)$/i);
    const suffix = suffixMatch ? suffixMatch[1].replace('*', '') : '.test.ts';
    const abs = path.resolve(rootDir, baseDir);
    walkFiles(abs, (p) => {
      if (p.endsWith(suffix) || p.endsWith('.test.ts')) out.push(path.relative(rootDir, p));
    });
  }
  return [...new Set(out)];
}

function walkFiles(dir: string, visit: (p: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // @silent-fallback-ok: unreadable dir contributes no files (→ suite-class).
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      walkFiles(p, visit);
    } else {
      visit(p);
    }
  }
}

export interface TargetedClassification {
  targeted: boolean;
  /** MATCHED file count (the ledgered value — NEVER the argv count; §2.3). */
  matchedCount: number;
  reason: string;
}

/**
 * The pinned conservative classifier (§2.3): targeted ONLY if every positional
 * is a non-glob, non-directory filter matching EXACTLY ONE file in the
 * resolved include set under vitest's substring filter semantics, and the
 * union of matches is ≤ K. Anything ambiguous routes suite-class.
 */
export function classifyTargetedRun(
  analysis: ArgvAnalysis,
  includedFiles: string[],
  rootDir: string,
  k: number = TARGETED_FILE_LIMIT,
): TargetedClassification {
  if (analysis.positionals.length === 0) {
    return { targeted: false, matchedCount: 0, reason: 'no-positional-filters' };
  }
  if (analysis.poolShaping.length > 0) {
    return { targeted: false, matchedCount: 0, reason: `pool-shaping-argv:${analysis.poolShaping[0]}` };
  }
  if (analysis.unknownFlags.length > 0) {
    return { targeted: false, matchedCount: 0, reason: `filter-flag:${analysis.unknownFlags[0]}` };
  }
  const matchedUnion = new Set<string>();
  for (const positional of analysis.positionals) {
    if (/[*?[\]{}]/.test(positional)) {
      return { targeted: false, matchedCount: 0, reason: `glob-positional:${positional}` };
    }
    try {
      if (fs.statSync(path.resolve(rootDir, positional)).isDirectory()) {
        return { targeted: false, matchedCount: 0, reason: `directory-positional:${positional}` };
      }
    } catch {
      /* @silent-fallback-ok: not a resolvable path — still a legal substring filter */
    }
    // vitest positionals are substring FILTERS against the file path (§2.3).
    const norm = positional.replace(/^\.\//, '');
    const matches = includedFiles.filter((f) => f.includes(norm));
    if (matches.length !== 1) {
      return {
        targeted: false,
        matchedCount: matches.length,
        reason: matches.length === 0 ? `no-match:${positional}` : `multi-match:${positional}(${matches.length})`,
      };
    }
    matchedUnion.add(matches[0]);
  }
  if (matchedUnion.size > k) {
    return { targeted: false, matchedCount: matchedUnion.size, reason: `matched-count-${matchedUnion.size}>K-${k}` };
  }
  return { targeted: true, matchedCount: matchedUnion.size, reason: 'exact-match-set' };
}

// ── Resolved-pool bound (the STATE check — §2.3) ──────────────────────────

/**
 * Compute the effective worker-pool bound from a resolved vitest config
 * fragment. Reads maxWorkers AND every poolOptions max* — the MAX of the
 * bounds that could apply; `fileParallelism:false` bounds file concurrency
 * to 1. Unknown/absent values resolve to `null` (unbounded ⇒ suite-class).
 */
export function resolvedPoolBound(config: {
  maxWorkers?: number | string;
  fileParallelism?: boolean;
  poolOptions?: {
    threads?: { maxThreads?: number };
    forks?: { maxForks?: number };
    vmThreads?: { maxThreads?: number };
    vmForks?: { maxForks?: number };
  };
}): number | null {
  if (config.fileParallelism === false) return 1;
  const candidates: number[] = [];
  const mw = typeof config.maxWorkers === 'string' ? Number(config.maxWorkers) : config.maxWorkers;
  if (typeof mw === 'number' && Number.isFinite(mw) && mw >= 1) candidates.push(mw);
  const po = config.poolOptions;
  for (const v of [po?.threads?.maxThreads, po?.forks?.maxForks, po?.vmThreads?.maxThreads, po?.vmForks?.maxForks]) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 1) candidates.push(v);
  }
  if (candidates.length === 0) return null; // unbounded / unknown
  return Math.max(...candidates);
}

/** Clamp a config's pool bounds to ≤ maxAllowed (Math.min — a ceiling, never a floor). */
export function clampConfigPool<T extends Record<string, unknown>>(test: T, maxAllowed: number): T {
  const t = test as Record<string, unknown>;
  const clampMax = (v: unknown): number => {
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) && n >= 1 ? Math.min(n, maxAllowed) : maxAllowed;
  };
  // The MIN bound must be set EXPLICITLY to ≤ the clamped max, even when the
  // config left it UNSET — otherwise vitest's Tinypool resolves the pool's
  // `minThreads`/`minForks` default to (numCpus − 1), which on a ≥6-core host
  // EXCEEDS our max of 4 and throws `minThreads and maxThreads must not
  // conflict`, crashing the root at pool creation. That is a §1.1 false-BLOCK
  // (the clamp meant to bound a run wedges it instead). Clamp min DOWN toward
  // the max (default an unset/invalid min to 1); never raise a legitimately
  // lower min — still a ceiling, never a floor.
  const clampMin = (v: unknown, max: number): number => {
    const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : 1;
  };
  const maxW = clampMax(t.maxWorkers);
  t.maxWorkers = maxW;
  t.minWorkers = clampMin(t.minWorkers, maxW);
  const po = (t.poolOptions ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, maxKey, minKey] of [
    ['threads', 'maxThreads', 'minThreads'],
    ['forks', 'maxForks', 'minForks'],
    ['vmThreads', 'maxThreads', 'minThreads'],
    ['vmForks', 'maxForks', 'minForks'],
  ] as const) {
    const sub = { ...(po[key] ?? {}) } as Record<string, unknown>;
    const m = clampMax(sub[maxKey]);
    sub[maxKey] = m;
    sub[minKey] = clampMin(sub[minKey], m);
    po[key] = sub;
  }
  t.poolOptions = po;
  return test;
}

// ── CI / off detection (§2.6, hardened) ───────────────────────────────────

/** Hardened CI predicate: CI truthy-ONLY-as-'true'/'1' AND a positive signal. */
export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env['CI'];
  if (ci !== 'true' && ci !== '1') return false;
  return env['GITHUB_ACTIONS'] !== undefined || env['RUNNER_OS'] !== undefined;
}

/** Is this an agent-launched / non-interactive context (watch-loudness + CI-spoof heuristics)? */
export function isAgentContext(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env['TMUX'] !== undefined ||
    env['INSTAR_SESSION_ID'] !== undefined ||
    env['CLAUDE_CODE_SESSION_ID'] !== undefined ||
    env['INSTAR_HOST_TEST_RUN_CLASS'] === 'background'
  );
}

export function isKillSwitchOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env['INSTAR_HOST_TEST_SEMAPHORE'] ?? '').toLowerCase() === 'off';
}

/** Run-class derivation (§2.6): never from user input. */
export function deriveRunClass(
  configName: string,
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): TestRunClass {
  if (env['INSTAR_HOST_TEST_RUN_CLASS'] === 'background') return 'background';
  if (configName === 'push') return 'interactive';
  // Safest reading (§1.1 bias): a TTY-attached run not marked background gets
  // the longer, user-blocking budget — a human is waiting on it.
  return isTTY ? 'interactive' : 'background';
}

// ── Re-entrancy: ancestry + holders cross-check (§2.5) ────────────────────

/** Walk the ancestor pid chain via `ps` (bounded depth). */
export function ancestryPids(startPid: number = process.pid, maxDepth = 25): number[] {
  const chain: number[] = [];
  let pid = startPid;
  for (let i = 0; i < maxDepth; i++) {
    let out: string;
    try {
      // lint-allow-sync-spawn: bounded (1s) one-shot ppid probes, cold path only.
      out = execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], { timeout: 1000, encoding: 'utf-8' });
    } catch {
      // @silent-fallback-ok: unresolvable ancestry fails toward NOT-nested —
      // the run then acquires normally (bounded, never sheltered).
      break;
    }
    const ppid = Number(out.trim());
    if (!Number.isInteger(ppid) || ppid <= 1) break;
    chain.push(ppid);
    pid = ppid;
  }
  return chain;
}

export interface NestedCheckResult {
  nested: boolean;
  /** The sheltering ancestor's holder row (same-lane for the skip decision). */
  shelteringPid: number | null;
  shelteringSlotId: string | null;
  /** True when an ancestor holds ANY-lane slot (drives the unconditional clamp). */
  anyLaneAncestorHolder: boolean;
}

/**
 * The lane-scoped ancestry+holders cross-check (§2.5). The env marker
 * (INSTAR_TEST_SEMAPHORE_HELD) only NARROWS the check — a stale/foreign/leaked
 * marker fails the cross-check and does NOT skip; a scrubbed-env child still
 * skips via pure ancestry.
 */
export function checkNestedUnderHolder(
  holdersRows: unknown[],
  laneChildWouldAcquire: TestLane,
  opts: {
    ancestors?: number[];
    envMarker?: string | undefined;
    pidAlive?: (pid: number) => boolean;
  } = {},
): NestedCheckResult {
  const ancestors = opts.ancestors ?? ancestryPids();
  const ancestorSet = new Set(ancestors);
  let markerPid: number | null = null;
  if (opts.envMarker) {
    const n = Number(opts.envMarker.split(':')[0]);
    if (Number.isInteger(n) && n >= 2) markerPid = n;
  }
  let sameLane: TestRunnerHolderRow | null = null;
  let anyLane = false;
  for (const r of holdersRows) {
    if (classifyRow(r) !== 'held') continue;
    const row = r as TestRunnerHolderRow;
    if (!ancestorSet.has(row.pid)) continue;
    if (opts.pidAlive && !opts.pidAlive(row.pid)) continue;
    if (markerPid !== null && row.pid !== markerPid) {
      // Marker present but names a different pid: the marker only narrows —
      // the ancestry facts still count this ancestor row.
    }
    anyLane = true;
    if (row.lane === laneChildWouldAcquire && !sameLane) sameLane = row;
  }
  return {
    nested: sameLane !== null,
    shelteringPid: sameLane?.pid ?? null,
    shelteringSlotId: sameLane?.id ?? null,
    anyLaneAncestorHolder: anyLane,
  };
}
