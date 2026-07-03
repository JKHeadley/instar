/**
 * hostTestRunnerSemaphore — the host-wide vitest concurrency bound (test lane).
 *
 * Spec: docs/specs/test-runner-concurrency-bound.md (converged round 10,
 * operator-ratified: suite cap 1, ship posture dry-run/watch-only).
 * Constitutional standard: Bounded Blast Radius (the 2nd instance of the
 * unbounded-per-actor-spawn class; the 1st is hostSpawnSemaphore).
 *
 * THE LOAD-BEARING DESIGN DECISION (§1.1): the fail-direction INVERTS from the
 * spawn cap. This lane fails OPEN — toward ADMITTING a run — on every
 * *provable, persistent* uncertainty (corrupt holders file, df-unconfirmed
 * disk, provably-wedged lock, unresolvable ancestry). A false BLOCK wedges
 * every `git push` and `/build` gate host-wide with no degradation path; a
 * false PASS is one extra concurrent suite. A single missed lock attempt is
 * "keep polling", never "admit" (§2.4 fail-open granularity).
 *
 * TWO SYMMETRIC LANES (§2.3): suite-class (cap INSTAR_HOST_TEST_MAX, default
 * 1) and targeted-run (cap INSTAR_HOST_TEST_TARGETED_MAX, default 6). A full
 * targeted lane THROWS the typed capacity-timeout — it never fail-open-admits
 * (fail-open-admit is lock-wedge-only).
 *
 * RECLAIM POLICY (§2.4, NOT the spawn defaults): immediate reclaim of a
 * provably-dead pid; start-time corroboration reclaims a REUSED pid pre-TTL;
 * a max-hold TTL frees even a pid-alive holder's slot (capacity-reclaim-ONLY
 * by default — NO process is ever signaled unless the separate, opt-in,
 * tuning-file-armed INSTAR_HOST_TEST_TTL_SIGNAL arm is on AND posture is
 * enforcing, and even then only after four mandatory gates).
 *
 * All cross-actor levers (posture, both caps, the signal arm) take their
 * host-uniform authority from ~/.instar/host-test-runner-tuning.json; env
 * vars are per-process overrides that are honored but LOUD when divergent
 * (§2.9). Every consequential decision is appended to the durable event
 * ledger (§2.8) — the soak's evidence store.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { SafeFsExecutor } from './SafeFsExecutor.js';
import { isAlive } from './ProjectRoundLock.js';
import {
  atomicWriteFileSync,
  probeDfHostLocalDetailed,
  releaseLock,
  tryTakeLockOnce,
} from './hostSemaphoreCore.js';

// ── Pinned code constants (frozen by the spec — NOT tunable) ──────────────

/** Suite-lane cap code-default (operator-ratified: full suites one-at-a-time). */
export const HOST_TEST_SUITE_CAP_DEFAULT = 1;
/** Targeted-lane cap code-default (§2.3). */
export const HOST_TEST_TARGETED_CAP_DEFAULT = 6;
/** Tuning-file cap sanity ceilings — 4× each code-default (§2.9, pinned). */
export const HOST_TEST_SUITE_CAP_CEILING = 4;
export const HOST_TEST_TARGETED_CAP_CEILING = 24;
/** Max-hold TTL code-default (1h). */
export const HOST_TEST_TTL_DEFAULT_MS = 3_600_000;
/** ttlMs sanity RANGE — pinned code constants, deliberately NOT tunable (§2.4). */
export const HOST_TEST_TTL_MIN_MS = 300_000; // 5 min floor
export const HOST_TEST_TTL_MAX_MS = 14_400_000; // 4h = 4× default
/** Poison sanity ceiling on holders-file row count (§2.4, pinned round 6). */
export const HOST_TEST_POISON_CEILING = 64;
/** Lockless fail-open storm ceiling — O_EXCL witness slots (§2.4, pinned). */
export const WEDGE_STORM_CEILING = 8;
/** Background-class suite-lane wait budget default (2 min, fail-loud). */
export const HOST_TEST_ACQUIRE_MS_DEFAULT = 120_000;
/** Targeted-lane wait budget default (1 min, fail-loud THROW). */
export const HOST_TEST_TARGETED_ACQUIRE_MS_DEFAULT = 60_000;
/** A lock older than this is provably wedged (critical section is sub-ms). */
export const LOCK_WEDGE_AGE_MS = 10_000;
/** Per-attempt lock-acquire deadline (≫ the sub-ms critical section). */
export const LOCK_ACQUIRE_DEADLINE_MS = 250;
/** Acquisition poll cadence (async yielding wait — NEVER a busy spin). */
export const POLL_INTERVAL_MS = 5_000;
export const POLL_JITTER_MS = 1_000;
/** SIGTERM→SIGKILL grace window under the (opt-in) signal arm. */
export const TOMBSTONE_GRACE_MS = 30_000;
/** Ledger rotation threshold (~5MB; segments retained per §2.8). */
export const LEDGER_ROTATE_BYTES = 5 * 1024 * 1024;
/** Segment retention floor AFTER the enforce-flip decision is recorded. */
export const LEDGER_SEGMENT_FLOOR = 10;
/** Clock-skew allowance for start-time corroboration. */
export const START_TIME_SKEW_MS = 120_000;
/** 80%-of-TTL warning fraction (§2.4). */
export const TTL_WARN_FRACTION = 0.8;
/** Targeted classification file-count limit K (§2.3). */
export const TARGETED_FILE_LIMIT = 5;

export type TestLane = 'suite' | 'targeted';
export type TestPosture = 'off' | 'dry-run' | 'enforcing';
export type TestRunClass = 'interactive' | 'background';

// ── Frozen rendezvous paths (§4) ──────────────────────────────────────────

export interface TestRunnerPaths {
  baseDir: string;
  holders: string;
  lock: string;
  witnessDir: string;
  tuning: string;
  tuningBaseline: string;
  dfMarker: string;
  ledger: string;
}

/**
 * Resolve the rendezvous base dir. `INSTAR_HOST_TEST_BASE_DIR` is an INTERNAL
 * test seam (meta-tests isolate their spawned roots into a temp universe) —
 * it is NOT a public lever and is deliberately undocumented in §2.9.
 */
export function resolveTestRunnerPaths(env: NodeJS.ProcessEnv = process.env): TestRunnerPaths {
  const override = env['INSTAR_HOST_TEST_BASE_DIR'];
  const baseDir =
    override && override.trim() ? override.trim() : path.join(os.homedir(), '.instar');
  return {
    baseDir,
    holders: path.join(baseDir, 'host-test-runner-holders.json'),
    lock: path.join(baseDir, 'host-test-runner-holders.lock'),
    witnessDir: path.join(baseDir, 'host-test-runner-witness'),
    tuning: path.join(baseDir, 'host-test-runner-tuning.json'),
    tuningBaseline: path.join(baseDir, 'host-test-runner-tuning-baseline.json'),
    dfMarker: path.join(baseDir, 'host-test-runner-dflocal.json'),
    ledger: path.join(baseDir, 'host-test-runner-events.jsonl'),
  };
}

// ── Rendezvous schema (v1, tolerant readers — §2.9) ───────────────────────

export interface TestRunnerHolderRow {
  v: 1;
  id: string;
  lane: TestLane;
  pid: number;
  hostname: string;
  /** ms epoch of the acquire. */
  acquiredAt: number;
  /** Identity fingerprint: raw `ps -o lstart=` text of the holder at acquire. */
  startedAt: string;
  /** Clamped copy of the command line (identity fingerprint). */
  cmd: string;
  /** Per-row max-hold TTL, stamped at acquire, sanity-RANGED on every read. */
  ttlMs: number;
  state: 'held' | 'terminating';
  runClass?: TestRunClass;
  /** Resolved MATCHED file count for targeted-lane rows (§2.3). */
  fileCount?: number;
  /** Recorded group-leadership at acquire (best-effort). */
  pgidLeader?: boolean;
  /** Set when the sleep-wake check re-armed the TTL window once (§2.4 gate 5). */
  reArmedAt?: number;
  /** signal-arm tombstone bookkeeping. */
  signaledAt?: number;
  [k: string]: unknown; // tolerant: unknown fields preserved verbatim
}

export interface TestRunnerTuningFile {
  v: 1;
  enforcing?: boolean;
  clampActive?: boolean;
  maxConcurrent?: number;
  targetedMax?: number;
  ttlSignal?: boolean;
  flippedAt?: string;
  by?: string;
  [k: string]: unknown;
}

// ── Typed errors (§2.6) ───────────────────────────────────────────────────

/** Distinct exit code for capacity refusals (EX_TEMPFAIL — NOT a test failure). */
export const TEST_RUNNER_CAPACITY_EXIT_CODE = 75;

export class TestRunnerCapacityTimeoutError extends Error {
  readonly code = 'INSTAR_TEST_CAPACITY_TIMEOUT';
  readonly exitCode = TEST_RUNNER_CAPACITY_EXIT_CODE;
  readonly holders: Array<{ pid: number; ageMs: number }>;
  constructor(lane: TestLane, budgetMs: number, holders: Array<{ pid: number; ageMs: number }>) {
    super(
      `[test-runner-bound] could not START within budget (${budgetMs}ms, ${lane} lane) — ` +
        `this is NOT a test failure; ${holders.length} holder(s): ` +
        `[${holders.map((h) => `pid ${h.pid}, age ${Math.round(h.ageMs / 1000)}s`).join('; ')}]; ` +
        `levers: INSTAR_HOST_TEST_SEMAPHORE=off, INSTAR_HOST_TEST_MAX`,
    );
    this.name = 'TestRunnerCapacityTimeoutError';
    this.holders = holders;
  }
}

export class TestRunnerStormCeilingError extends Error {
  readonly code = 'INSTAR_TEST_STORM_CEILING';
  readonly exitCode = TEST_RUNNER_CAPACITY_EXIT_CODE;
  readonly slots: Array<{ slot: number; pid: number; ageMs: number }>;
  constructor(slots: Array<{ slot: number; pid: number; ageMs: number }>) {
    super(
      `[test-runner-bound] wedge-storm ceiling (${WEDGE_STORM_CEILING}) reached — refusing a further ` +
        `fail-open admit; held slots: ` +
        `[${slots.map((s) => `slot ${s.slot}: pid ${s.pid}, age ${Math.round(s.ageMs / 1000)}s`).join('; ')}]. ` +
        `This is NOT a test failure — the holders lock has been wedged at storm volume; ` +
        `levers: INSTAR_HOST_TEST_SEMAPHORE=off`,
    );
    this.name = 'TestRunnerStormCeilingError';
    this.slots = slots;
  }
}

// ── Resolvers (env override → tuning file → code default; §2.9) ──────────

/**
 * Coerce a raw ttlMs to a finite integer in [HOST_TEST_TTL_MIN_MS,
 * HOST_TEST_TTL_MAX_MS]. Uses Number() + Number.isInteger — NEVER parseInt
 * (§2.4: "300000abc"/"300000.9" are definitively REJECTED to the default, not
 * truncated into range). Out-of-range/NaN/non-integer ⇒ code-default + coerced.
 */
export function coerceTtlMs(raw: unknown): { ttlMs: number; coerced: boolean } {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ttlMs: HOST_TEST_TTL_DEFAULT_MS, coerced: true };
  }
  if (n < HOST_TEST_TTL_MIN_MS || n > HOST_TEST_TTL_MAX_MS) {
    // A value BEYOND the ceiling is clamped AT the ceiling for a row read
    // (no immortal slot); anything below the floor resolves to the default
    // (instant-expiry abuse). Both are "coerced" (WARN-ledgered by callers).
    if (n > HOST_TEST_TTL_MAX_MS) return { ttlMs: HOST_TEST_TTL_MAX_MS, coerced: true };
    return { ttlMs: HOST_TEST_TTL_DEFAULT_MS, coerced: true };
  }
  return { ttlMs: n, coerced: false };
}

/** Sanity-clamp a tuning-file cap value to an integer in [1, ceiling] (§2.9). */
export function sanitizeCapValue(
  raw: unknown,
  ceiling: number,
  dflt: number,
): { value: number; coerced: boolean } {
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > ceiling) {
    return { value: dflt, coerced: raw !== undefined };
  }
  return { value: n, coerced: false };
}

export interface ResolvedPosture {
  posture: TestPosture;
  /** The host-uniform authority's posture (tuning file, else code default). */
  authority: Exclude<TestPosture, 'off'>;
  /** Env divergence from the authority: 'weaker' | 'stronger' | null. */
  divergence: 'weaker' | 'stronger' | null;
}

export function resolvePosture(
  env: NodeJS.ProcessEnv,
  tuning: TestRunnerTuningFile | null,
): ResolvedPosture {
  const authority: Exclude<TestPosture, 'off'> = tuning?.enforcing === true ? 'enforcing' : 'dry-run';
  if ((env['INSTAR_HOST_TEST_SEMAPHORE'] ?? '').toLowerCase() === 'off') {
    return { posture: 'off', authority, divergence: null };
  }
  const raw = env['INSTAR_HOST_TEST_ENFORCE'];
  let override: Exclude<TestPosture, 'off'> | null = null;
  if (raw === '1' || raw === 'true') override = 'enforcing';
  else if (raw === '0' || raw === 'false') override = 'dry-run';
  const posture = override ?? authority;
  let divergence: 'weaker' | 'stronger' | null = null;
  if (override && override !== authority) {
    divergence = override === 'enforcing' ? 'stronger' : 'weaker';
  }
  return { posture, authority, divergence };
}

/** Are the config-eval clamps REAL (clamp-active sub-stage or enforcing)? §2.11. */
export function resolveClampActive(
  posture: TestPosture,
  tuning: TestRunnerTuningFile | null,
): boolean {
  if (posture === 'off') return false;
  return posture === 'enforcing' || tuning?.clampActive === true;
}

export interface ResolvedCap {
  cap: number;
  source: 'env' | 'tuning' | 'default';
  /** Tuning value was out-of-range/non-integer and resolved to the default. */
  coerced: boolean;
  /** Resolved (env) cap exceeds the host-uniform authority by more than 4×. */
  divergentBeyond4x: boolean;
}

export function resolveCap(
  lane: TestLane,
  env: NodeJS.ProcessEnv,
  tuning: TestRunnerTuningFile | null,
): ResolvedCap {
  const dflt = lane === 'suite' ? HOST_TEST_SUITE_CAP_DEFAULT : HOST_TEST_TARGETED_CAP_DEFAULT;
  const ceiling = lane === 'suite' ? HOST_TEST_SUITE_CAP_CEILING : HOST_TEST_TARGETED_CAP_CEILING;
  const tuningRaw = lane === 'suite' ? tuning?.maxConcurrent : tuning?.targetedMax;
  const sanitized = sanitizeCapValue(tuningRaw, ceiling, dflt);
  const authorityCap = sanitized.value;
  const envRaw = env[lane === 'suite' ? 'INSTAR_HOST_TEST_MAX' : 'INSTAR_HOST_TEST_TARGETED_MAX'];
  if (envRaw !== undefined) {
    const n = Number(envRaw);
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) {
      return {
        cap: n,
        source: 'env',
        coerced: false,
        divergentBeyond4x: n > authorityCap * 4,
      };
    }
    // Malformed env value falls through to the authority (never zeroes capacity).
  }
  return {
    cap: authorityCap,
    source: tuningRaw !== undefined && !sanitized.coerced ? 'tuning' : 'default',
    coerced: sanitized.coerced,
    divergentBeyond4x: false,
  };
}

export interface ResolvedTtlSignal {
  armed: boolean;
  /** env=1 against an unarmed authority was IGNORED (env can only DISARM). */
  envArmIgnored: boolean;
}

export function resolveTtlSignal(
  env: NodeJS.ProcessEnv,
  tuning: TestRunnerTuningFile | null,
): ResolvedTtlSignal {
  const authorityArmed = tuning?.ttlSignal === true;
  const raw = env['INSTAR_HOST_TEST_TTL_SIGNAL'];
  if (raw === '0' || raw === 'false') return { armed: false, envArmIgnored: false };
  if ((raw === '1' || raw === 'true') && !authorityArmed) {
    // ASYMMETRIC (§2.9): env can only DISARM — arming is tuning-file-only.
    return { armed: false, envArmIgnored: true };
  }
  return { armed: authorityArmed, envArmIgnored: false };
}

/** Resolve the acquire wait budget for a lane + run class (§2.9). */
export function resolveAcquireBudgetMs(
  lane: TestLane,
  runClass: TestRunClass,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const readMs = (key: string): number | null => {
    const raw = env[key];
    if (raw === undefined) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
  };
  if (lane === 'targeted') {
    return readMs('INSTAR_HOST_TEST_TARGETED_ACQUIRE_MS') ?? HOST_TEST_TARGETED_ACQUIRE_MS_DEFAULT;
  }
  const background = readMs('INSTAR_HOST_TEST_ACQUIRE_MS') ?? HOST_TEST_ACQUIRE_MS_DEFAULT;
  if (runClass === 'background') return background;
  return readMs('INSTAR_HOST_TEST_ACQUIRE_MS_INTERACTIVE') ?? 5 * background;
}

/** Stamped per-row ttl at acquire (env-read, sanity-ranged). */
export function resolveAcquireTtlMs(env: NodeJS.ProcessEnv = process.env): {
  ttlMs: number;
  coerced: boolean;
} {
  const raw = env['INSTAR_HOST_TEST_TTL_MS'];
  if (raw === undefined) return { ttlMs: HOST_TEST_TTL_DEFAULT_MS, coerced: false };
  return coerceTtlMs(raw);
}

// ── Tuning file (host-uniform authority; §2.9) ────────────────────────────

export const TUNING_HASH_ABSENT = 'absent';

export interface ResolvedTuning {
  file: TestRunnerTuningFile | null;
  /** sha256-12 of the raw bytes, or the 'absent' sentinel. */
  hash: string;
  corrupt: boolean;
}

function hashTuningRaw(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

/**
 * Read the tuning file. Quarantine requires CONFIRMED corruption (an immediate
 * re-read — a transient torn write must never demote the host authority);
 * confirmed-corrupt is quarantined aside + resolved to code defaults (§2.9).
 */
export function readTuningFile(paths: TestRunnerPaths): ResolvedTuning {
  let raw: string;
  try {
    raw = fs.readFileSync(paths.tuning, 'utf-8');
  } catch {
    // @silent-fallback-ok: an ABSENT tuning file is the normal fresh-host state
    // — code defaults apply; the 'absent' hash sentinel makes file CREATION
    // detectable as a change (§2.9).
    return { file: null, hash: TUNING_HASH_ABSENT, corrupt: false };
  }
  const parsed = tryParseTuning(raw);
  if (parsed) return { file: parsed, hash: hashTuningRaw(raw), corrupt: false };
  // First bad read → confirm with an immediate re-read before quarantining.
  let raw2: string | null = null;
  try {
    raw2 = fs.readFileSync(paths.tuning, 'utf-8');
  } catch {
    // @silent-fallback-ok: the file vanished between reads — treat as absent.
    return { file: null, hash: TUNING_HASH_ABSENT, corrupt: false };
  }
  const parsed2 = tryParseTuning(raw2);
  if (parsed2) return { file: parsed2, hash: hashTuningRaw(raw2), corrupt: false };
  // CONFIRMED corrupt → quarantine aside (keep newest 5) + code defaults.
  quarantineFileAside(paths.tuning, 'host-test-runner-tuning.corrupt', paths.baseDir);
  return { file: null, hash: TUNING_HASH_ABSENT, corrupt: true };
}

function tryParseTuning(raw: string): TestRunnerTuningFile | null {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj as TestRunnerTuningFile;
  } catch {
    // @silent-fallback-ok: parse failure is the caller's confirmed-corruption
    // branch — never a throw into the chokepoint.
    return null;
  }
}

/** Atomic tuning write (the recommended writer — never a raw shell redirect). */
export function writeTuningFile(paths: TestRunnerPaths, tuning: TestRunnerTuningFile): void {
  ensureBaseDir(paths);
  atomicWriteFileSync(paths.tuning, JSON.stringify(tuning, null, 2), {
    mode: 0o600,
    operation: 'hostTestRunnerSemaphore.writeTuningFile',
  });
}

/** Rename a corrupt file aside with a timestamp, retaining only the newest 5. */
function quarantineFileAside(filePath: string, quarantinePrefix: string, baseDir: string): string | null {
  const target = path.join(baseDir, `${quarantinePrefix}-${Date.now()}.json`);
  try {
    fs.renameSync(filePath, target);
  } catch {
    // @silent-fallback-ok: a concurrent quarantine already moved it — fine.
    return null;
  }
  // Keep-newest-5 retention (destructive delete → SafeFsExecutor funnel, L12).
  try {
    const siblings = fs
      .readdirSync(baseDir)
      .filter((f) => f.startsWith(`${quarantinePrefix}-`))
      .sort()
      .reverse();
    for (const stale of siblings.slice(5)) {
      SafeFsExecutor.safeUnlinkSync(path.join(baseDir, stale), {
        operation: 'hostTestRunnerSemaphore.quarantineRetention',
      });
    }
  } catch {
    /* @silent-fallback-ok: retention is best-effort housekeeping */
  }
  return target;
}

// ── Ledger (§2.8) — durable, best-effort, rotation-bounded ────────────────

export interface TestRunnerLedgerEvent {
  v: 1;
  ts: string;
  kind: string;
  pid: number;
  hostname: string;
  posture: TestPosture;
  suiteCap: number;
  targetedCap: number;
  ttlSignalArmed: boolean;
  tuningHash: string;
  [k: string]: unknown;
}

/** Best-effort ledger append — a ledger write failure never blocks a run. */
export function appendLedgerEvent(
  paths: TestRunnerPaths,
  event: TestRunnerLedgerEvent,
  opts: { flipRecorded?: boolean } = {},
): void {
  try {
    ensureBaseDir(paths);
    rotateLedgerIfNeeded(paths, opts.flipRecorded === true);
    fs.appendFileSync(paths.ledger, JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch {
    /* @silent-fallback-ok: best-effort append — never throws into the run (§2.8) */
  }
}

function rotateLedgerIfNeeded(paths: TestRunnerPaths, flipRecorded: boolean): void {
  let size = 0;
  try {
    size = fs.statSync(paths.ledger).size;
  } catch {
    // @silent-fallback-ok: no ledger yet — nothing to rotate.
    return;
  }
  if (size < LEDGER_ROTATE_BYTES) return;
  const segment = paths.ledger.replace(/\.jsonl$/, `.${Date.now()}.jsonl`);
  try {
    fs.renameSync(paths.ledger, segment);
  } catch {
    // @silent-fallback-ok: a concurrent rotation won the rename — fine.
    return;
  }
  // Segments are RETAINED until the enforce-flip decision is recorded; after
  // that a newest-LEDGER_SEGMENT_FLOOR floor applies (§2.8).
  if (!flipRecorded) return;
  try {
    const segs = listLedgerSegments(paths).sort().reverse();
    for (const stale of segs.slice(LEDGER_SEGMENT_FLOOR)) {
      SafeFsExecutor.safeUnlinkSync(stale, {
        operation: 'hostTestRunnerSemaphore.ledgerSegmentRetention',
      });
    }
  } catch {
    /* @silent-fallback-ok: retention is best-effort housekeeping */
  }
}

export function listLedgerSegments(paths: TestRunnerPaths): string[] {
  try {
    const base = path.basename(paths.ledger).replace(/\.jsonl$/, '');
    return fs
      .readdirSync(paths.baseDir)
      .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.jsonl') && f !== path.basename(paths.ledger))
      .map((f) => path.join(paths.baseDir, f));
  } catch {
    // @silent-fallback-ok: no base dir yet → no segments.
    return [];
  }
}

/**
 * Bounded, torn-line-tolerant read of the newest ledger events. Spans the
 * newest rotated SEGMENT when the live file carries no events (§2.9 —
 * rotation must not blind the baseline read).
 */
export function readLedgerTail(paths: TestRunnerPaths, maxLines = 200): TestRunnerLedgerEvent[] {
  const files = [paths.ledger];
  const segments = listLedgerSegments(paths).sort().reverse();
  if (segments.length > 0) files.push(segments[0]);
  const out: TestRunnerLedgerEvent[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      // @silent-fallback-ok: a missing live file / segment is an empty tail.
      continue;
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    for (const line of lines.slice(-maxLines)) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object' && typeof obj.kind === 'string') {
          out.push(obj as TestRunnerLedgerEvent);
        }
      } catch {
        /* @silent-fallback-ok: torn/malformed ledger lines are tolerated (§2.6) */
      }
    }
    if (out.length > 0) break; // live file had events — segment not needed
  }
  return out.slice(-maxLines);
}

// ── Tuning-hash baseline marker (§2.9) ────────────────────────────────────

interface TuningBaselineMarker {
  v: 1;
  hash: string;
  at: string;
  snapshot: TestRunnerTuningFile | null;
}

export interface TuningBaselineResult {
  changed: boolean;
  changedFields: string[];
  established: boolean;
  /** true when establishment was silent (genuinely fresh host). */
  silentEstablish: boolean;
}

/**
 * Detect tuning-file mutation via the content-hash baseline marker. On
 * no-prior-baseline the LEDGER TAIL (live + newest segment) is consulted
 * before establishing silently — marker-deletion must not launder an edit.
 */
export function checkTuningBaseline(
  paths: TestRunnerPaths,
  current: ResolvedTuning,
): TuningBaselineResult {
  let marker: TuningBaselineMarker | null = null;
  try {
    const raw = fs.readFileSync(paths.tuningBaseline, 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && typeof obj.hash === 'string') {
      marker = obj as TuningBaselineMarker;
    }
  } catch {
    // @silent-fallback-ok: absent/corrupt marker → the no-prior-baseline path
    // below (which consults the ledger tail — deletion is not a laundering).
    marker = null;
  }
  const writeMarker = (): void => {
    try {
      ensureBaseDir(paths);
      atomicWriteFileSync(
        paths.tuningBaseline,
        JSON.stringify({ v: 1, hash: current.hash, at: new Date().toISOString(), snapshot: current.file }),
        { mode: 0o600, operation: 'hostTestRunnerSemaphore.tuningBaseline' },
      );
    } catch {
      /* @silent-fallback-ok: marker write is best-effort — the ledger stamps still detect */
    }
  };
  if (marker) {
    if (marker.hash === current.hash) {
      return { changed: false, changedFields: [], established: false, silentEstablish: false };
    }
    const changedFields = diffTuningFields(marker.snapshot ?? null, current.file);
    writeMarker();
    return { changed: true, changedFields, established: false, silentEstablish: false };
  }
  // No prior baseline: consult the ledger tail for the most recent hash stamp.
  const tail = readLedgerTail(paths);
  const lastStamped = [...tail].reverse().find((e) => typeof e.tuningHash === 'string');
  writeMarker();
  if (lastStamped && lastStamped.tuningHash !== current.hash) {
    return { changed: true, changedFields: [], established: true, silentEstablish: false };
  }
  return {
    changed: false,
    changedFields: [],
    established: true,
    silentEstablish: !lastStamped,
  };
}

function diffTuningFields(
  oldFile: TestRunnerTuningFile | null,
  newFile: TestRunnerTuningFile | null,
): string[] {
  const keys = new Set<string>([
    ...Object.keys(oldFile ?? {}),
    ...Object.keys(newFile ?? {}),
  ]);
  const changed: string[] = [];
  for (const k of keys) {
    const a = (oldFile as Record<string, unknown> | null)?.[k];
    const b = (newFile as Record<string, unknown> | null)?.[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed.push(`${k}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
    }
  }
  return changed;
}

// ── df marker (revalidated, never trusted forever — §2.2 item 2) ──────────

const DF_MARKER_TTL_MS = 24 * 3600_000;

/**
 * Resolve the host-local determination for the rendezvous dir, cached to the
 * on-disk marker. THE §1.2 LESSON APPLIED: a FAILED probe ('unknown') is
 * NEVER written to the marker — only a positive local/not-local
 * classification is cacheable, so a df timeout under load disables reclaim
 * for ONE pass, never for the process (or marker) lifetime.
 */
export function resolveDfLocal(
  paths: TestRunnerPaths,
  probe: (p: string) => { status: 'local' | 'not-local' | 'unknown' } = probeDfHostLocalDetailed,
): { local: boolean; status: 'local' | 'not-local' | 'unknown' } {
  let device: number | null = null;
  try {
    device = fs.statSync(paths.baseDir).dev;
  } catch {
    // @silent-fallback-ok: base dir missing — treat as unknown (no reclaim).
    return { local: false, status: 'unknown' };
  }
  try {
    const raw = fs.readFileSync(paths.dfMarker, 'utf-8');
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj === 'object' &&
      typeof obj.device === 'number' &&
      typeof obj.local === 'boolean' &&
      typeof obj.checkedAt === 'number' &&
      obj.device === device &&
      Date.now() - obj.checkedAt < DF_MARKER_TTL_MS
    ) {
      return { local: obj.local, status: obj.local ? 'local' : 'not-local' };
    }
  } catch {
    /* @silent-fallback-ok: absent/corrupt marker → re-probe below */
  }
  const probed = probe(paths.baseDir);
  if (probed.status === 'unknown') {
    // NEVER cache a failed probe (§1.2 root-cause of the spawn-lane wedge).
    return { local: false, status: 'unknown' };
  }
  try {
    ensureBaseDir(paths);
    atomicWriteFileSync(
      paths.dfMarker,
      JSON.stringify({ v: 1, device, local: probed.status === 'local', checkedAt: Date.now() }),
      { mode: 0o600, operation: 'hostTestRunnerSemaphore.dfMarker' },
    );
  } catch {
    /* @silent-fallback-ok: marker write is a cache — the determination stands */
  }
  return { local: probed.status === 'local', status: probed.status };
}

// ── Process identity evidence (gathered OUTSIDE the lock — §2.4) ──────────

export interface PidEvidence {
  /** pid → parsed `ps lstart` start time in ms epoch (null: unobtainable). */
  startMs: Map<number, number | null>;
  /** pid → process group id (null: unobtainable). */
  pgid: Map<number, number | null>;
}

export function gatherPidEvidence(
  pids: number[],
  pidAlive: (pid: number) => boolean = isAlive,
): PidEvidence {
  const startMs = new Map<number, number | null>();
  const pgid = new Map<number, number | null>();
  const live = [...new Set(pids)].filter((p) => Number.isInteger(p) && p >= 2 && pidAlive(p));
  if (live.length === 0) return { startMs, pgid };
  try {
    // lint-allow-sync-spawn: a bounded (3s) one-shot ps over a single-digit
    // live-pid set, gathered OUTSIDE the holders lock (§2.4 round-9).
    const out = execFileSync('ps', ['-o', 'pid=,pgid=,lstart=', '-p', live.join(',')], {
      timeout: 3000,
      encoding: 'utf-8',
    });
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const parsed = Date.parse(m[3].trim());
      startMs.set(pid, Number.isFinite(parsed) ? parsed : null);
      pgid.set(pid, Number(m[2]));
    }
  } catch {
    /* @silent-fallback-ok: ps unavailable → evidence stays null (no reclaim on doubt for the mismatch path) */
  }
  for (const p of live) {
    if (!startMs.has(p)) startMs.set(p, null);
    if (!pgid.has(p)) pgid.set(p, null);
  }
  return { startMs, pgid };
}

/** The holder's OWN start time + cmd (fingerprint stamped at acquire). */
export function selfProcessFingerprint(): { startedAt: string; cmd: string } {
  let startedAt = '';
  try {
    // lint-allow-sync-spawn: one bounded ps self-probe at acquire time.
    startedAt = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], {
      timeout: 2000,
      encoding: 'utf-8',
    }).trim();
  } catch {
    /* @silent-fallback-ok: fingerprint is best-effort corroboration data */
  }
  const cmd = process.argv.join(' ').slice(0, 512);
  return { startedAt, cmd };
}

// ── Holder-row helpers ────────────────────────────────────────────────────

export type RowKind = 'held' | 'terminating' | 'unknown-state' | 'malformed';

export function classifyRow(row: unknown): RowKind {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return 'malformed';
  const r = row as Record<string, unknown>;
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid < 2) return 'malformed';
  if (r.state === 'held') {
    // A held row must carry a recognizable lane to be countable.
    if (r.lane === 'suite' || r.lane === 'targeted') return 'held';
    return 'unknown-state';
  }
  if (r.state === 'terminating') return 'terminating';
  return 'unknown-state';
}

/** Effective TTL window start (a sleep-wake re-arm restarts the window once). */
function ttlWindowStart(row: TestRunnerHolderRow): number {
  const reArmed = typeof row.reArmedAt === 'number' ? row.reArmedAt : 0;
  return Math.max(row.acquiredAt, reArmed);
}

// ── The semaphore ─────────────────────────────────────────────────────────

export interface HostTestRunnerSemaphoreDeps {
  paths?: TestRunnerPaths;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  hostname?: () => string;
  pidAlive?: (pid: number) => boolean;
  /** Injected df probe (tests). */
  dfProbe?: (p: string) => { status: 'local' | 'not-local' | 'unknown' };
  /** Injected process-signal seam (tests) — default process.kill. */
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  /** Injected evidence gatherer (tests). */
  gatherEvidence?: (pids: number[]) => PidEvidence;
  /** Injected boot-time reader for the sleep-wake gate (ms epoch, null = unobtainable). */
  bootTimeMs?: () => number | null;
  /** INTERNAL policy parameter: sub-floor TTL for tests (never the public env). */
  ttlMsOverride?: number;
  /** Async sleep seam (tests shrink the poll). */
  sleep?: (ms: number) => Promise<void>;
  /** Poll interval override (INTERNAL test seam). */
  pollIntervalMs?: number;
  genId?: () => string;
}

export interface AcquireRequest {
  lane: TestLane;
  runClass: TestRunClass;
  /** Resolved MATCHED file count (targeted lane). */
  fileCount?: number;
  /** Override budget (default resolved per §2.9). */
  budgetMs?: number;
  /** Called about once per poll while waiting (the §2.10 wait-line hook). */
  onWaitTick?: (elapsedMs: number, holders: Array<{ pid: number; ageMs: number }>) => void;
}

export type AcquireOutcome =
  | { kind: 'acquired'; id: string; wouldBlock: boolean; ttlMs: number }
  | { kind: 'fail-open-admit'; cause: string; witnessFile: string | null };

export interface PruneReport {
  reclaimed: Array<{ pid: number; lane?: string; reason: string }>;
  tombstonesCompleted: number;
  liveSuite: number;
  liveTargeted: number;
}

interface HoldersReadResult {
  rows: unknown[];
  status: 'ok' | 'missing' | 'unparseable' | 'poisoned';
  raw: string | null;
}

export class HostTestRunnerSemaphore {
  readonly paths: TestRunnerPaths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private readonly host: string;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly dfProbe: (p: string) => { status: 'local' | 'not-local' | 'unknown' };
  private readonly signal: (pid: number, sig: NodeJS.Signals) => void;
  private readonly gatherEvidence: (pids: number[]) => PidEvidence;
  private readonly bootTimeMs: () => number | null;
  private readonly ttlMsOverride?: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;
  private readonly genId: () => string;

  constructor(deps: HostTestRunnerSemaphoreDeps = {}) {
    this.env = deps.env ?? process.env;
    this.paths = deps.paths ?? resolveTestRunnerPaths(this.env);
    this.now = deps.now ?? (() => Date.now());
    this.host = (deps.hostname ?? (() => os.hostname()))();
    this.pidAlive = deps.pidAlive ?? isAlive;
    this.dfProbe = deps.dfProbe ?? probeDfHostLocalDetailed;
    this.signal = deps.signal ?? ((pid, sig) => process.kill(pid, sig));
    this.gatherEvidence = deps.gatherEvidence ?? ((pids) => gatherPidEvidence(pids, this.pidAlive));
    this.bootTimeMs = deps.bootTimeMs ?? readMacBootTimeMs;
    this.ttlMsOverride = deps.ttlMsOverride;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.pollIntervalMs = deps.pollIntervalMs ?? resolveInternalPollMs(this.env);
    this.genId =
      deps.genId ??
      (() => `test:${process.pid}:${this.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`);
  }

  // ── Context stamps ──────────────────────────────────────────────────

  /** Resolve the full lever context (tuning, posture, caps, arm) once. */
  resolveContext(): {
    tuning: ResolvedTuning;
    posture: ResolvedPosture;
    suiteCap: ResolvedCap;
    targetedCap: ResolvedCap;
    ttlSignal: ResolvedTtlSignal;
    clampActive: boolean;
  } {
    const tuning = readTuningFile(this.paths);
    const posture = resolvePosture(this.env, tuning.file);
    return {
      tuning,
      posture,
      suiteCap: resolveCap('suite', this.env, tuning.file),
      targetedCap: resolveCap('targeted', this.env, tuning.file),
      ttlSignal: resolveTtlSignal(this.env, tuning.file),
      clampActive: resolveClampActive(posture.posture, tuning.file),
    };
  }

  ledger(kind: string, fields: Record<string, unknown> = {}): void {
    const ctx = this.resolveContext();
    appendLedgerEvent(
      this.paths,
      {
        v: 1,
        ts: new Date(this.now()).toISOString(),
        kind,
        pid: process.pid,
        hostname: this.host,
        posture: ctx.posture.posture,
        suiteCap: ctx.suiteCap.cap,
        targetedCap: ctx.targetedCap.cap,
        ttlSignalArmed: ctx.ttlSignal.armed,
        tuningHash: ctx.tuning.hash,
        ...fields,
      },
      { flipRecorded: ctx.tuning.file?.enforcing === true && ctx.tuning.file?.flippedAt !== undefined },
    );
  }

  // ── Holders IO ──────────────────────────────────────────────────────

  private readHolders(): HoldersReadResult {
    let raw: string;
    try {
      raw = fs.readFileSync(this.paths.holders, 'utf-8');
    } catch {
      // @silent-fallback-ok: a missing holders file is an empty set.
      return { rows: [], status: 'missing', raw: null };
    }
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.holders)) {
        return { rows: [], status: 'unparseable', raw };
      }
      // §2.4/§5: a holders file AT HOST_TEST_POISON_CEILING (64) rows
      // quarantines; one below it does not (>=, not >).
      if (obj.holders.length >= HOST_TEST_POISON_CEILING) {
        return { rows: obj.holders, status: 'poisoned', raw };
      }
      return { rows: obj.holders, status: 'ok', raw };
    } catch {
      // @silent-fallback-ok: unparseable → the caller's quarantine+admit branch (§2.4 fail-OPEN).
      return { rows: [], status: 'unparseable', raw };
    }
  }

  private writeHolders(rows: unknown[]): void {
    ensureBaseDir(this.paths);
    atomicWriteFileSync(this.paths.holders, JSON.stringify({ v: 1, holders: rows }), {
      mode: 0o600,
      operation: 'HostTestRunnerSemaphore.writeHolders',
    });
  }

  /**
   * Quarantine a corrupt/poisoned holders file aside and start a fresh one,
   * RE-HOMING any pending `terminating` tombstones (parseable path) or
   * best-effort SALVAGING them via a line scan (unparseable path, §2.4).
   * Returns the tombstones carried into the fresh file + whether any may have
   * been dropped.
   */
  private quarantineHolders(read: HoldersReadResult): {
    rehomed: unknown[];
    possibleDrop: boolean;
    salvaged: number;
  } {
    const rehomed: unknown[] = [];
    let possibleDrop = false;
    let salvaged = 0;
    if (read.status === 'poisoned') {
      for (const row of read.rows) {
        if (classifyRow(row) === 'terminating') rehomed.push(row);
      }
    } else if (read.raw) {
      // Unparseable: best-effort SALVAGE of terminating rows (§2.4 round 8).
      // Holder rows are FLAT JSON objects and the holders file is written as a
      // single line, so a line split cannot isolate rows (a row's own commas
      // would shred it) — extract flat `{…"state":"terminating"…}` objects by
      // regex over the whole raw instead.
      const sawTerminatingText = /"state"\s*:\s*"terminating"/.test(read.raw);
      const candidates = read.raw.match(/\{[^{}]*"state"\s*:\s*"terminating"[^{}]*\}/g) ?? [];
      for (const candidate of candidates) {
        try {
          const obj = JSON.parse(candidate);
          if (classifyRow(obj) === 'terminating') {
            rehomed.push(obj);
            salvaged++;
            continue;
          }
        } catch {
          /* @silent-fallback-ok: salvage is best-effort — the drop is ENUMERATED below */
        }
        possibleDrop = true;
      }
      // Whether or not salvage succeeds, ENUMERATE any terminating text the
      // scan could not recover — an armed kill obligation lost to unparseable
      // corruption is at worst LOUD, never silent (§2.4).
      const occurrences = read.raw.match(/"state"\s*:\s*"terminating"/g)?.length ?? 0;
      if (sawTerminatingText && salvaged < occurrences) possibleDrop = true;
    }
    quarantineFileAside(this.paths.holders, 'host-test-runner-holders.corrupt', this.paths.baseDir);
    this.writeHolders(rehomed);
    return { rehomed, possibleDrop, salvaged };
  }

  // ── Reclaim pass (§2.4) ─────────────────────────────────────────────

  /**
   * Apply the test-lane ReclaimPolicy over `rows`. Evidence is gathered by the
   * caller OUTSIDE the lock; decisions are applied here (re-validated per row).
   * Returns kept rows + freed info. NEVER signals unless `armed && enforcing`.
   */
  private applyReclaimPass(
    rows: unknown[],
    evidence: PidEvidence,
    ctx: {
      dfLocal: boolean;
      armed: boolean;
      posture: TestPosture;
    },
    events: Array<{ kind: string; fields: Record<string, unknown> }>,
  ): { kept: unknown[]; report: PruneReport; changed: boolean } {
    const kept: unknown[] = [];
    const report: PruneReport = { reclaimed: [], tombstonesCompleted: 0, liveSuite: 0, liveTargeted: 0 };
    // §2.2 item 3 (write-only-on-change): callers skip the holders rewrite on a
    // failed acquire when the pass removed/mutated nothing. Set whenever a row
    // is dropped, transitioned (tombstoned), or mutated (sleep-wake re-arm).
    let changed = false;
    const nowMs = this.now();
    for (const rowRaw of rows) {
      const kind = classifyRow(rowRaw);
      if (kind === 'malformed') {
        // Corrupt row (pid 0/1/negative/non-integer/garbage) — quarantine path:
        // slot freed, NO signal (§2.4 gate 1).
        events.push({ kind: 'warn', fields: { warnType: 'malformed-row-dropped' } });
        report.reclaimed.push({ pid: NaN, reason: 'malformed-row' });
        continue;
      }
      const row = rowRaw as TestRunnerHolderRow;
      if (kind === 'unknown-state') {
        // Tolerant rule (§2.9): excluded from the cap count (fail-open), never
        // signaled, preserved verbatim — but preservation is BOUNDED.
        const age = nowMs - (typeof row.acquiredAt === 'number' ? row.acquiredAt : nowMs);
        const dead = !this.pidAlive(row.pid);
        if (dead && age > HOST_TEST_TTL_MAX_MS && ctx.dfLocal) {
          events.push({ kind: 'warn', fields: { warnType: 'unknown-state-row-dropped', pid: row.pid } });
          report.reclaimed.push({ pid: row.pid, reason: 'unknown-state-expired' });
          continue;
        }
        events.push({ kind: 'schema-unknown', fields: { pid: row.pid, state: row.state ?? null } });
        kept.push(rowRaw);
        continue;
      }
      if (!ctx.dfLocal) {
        // Reclaim disabled for the pass (fail-open: runs still admit) — keep.
        kept.push(rowRaw);
        if (kind === 'held') this.countLive(row, report);
        continue;
      }
      if (row.hostname !== this.host) {
        // A foreign-hostname holder on a df-confirmed-local disk is bogus by
        // the host-local contract — dropped + surfaced loudly (§2.4).
        events.push({
          kind: 'quarantine',
          fields: { cause: 'foreign-hostname-holder', foreignHost: String(row.hostname).slice(0, 64), pid: row.pid },
        });
        report.reclaimed.push({ pid: row.pid, lane: row.lane, reason: 'foreign-hostname' });
        continue;
      }
      if (kind === 'terminating') {
        const done = this.completeTombstone(row, evidence, ctx, events, nowMs);
        if (done) {
          report.tombstonesCompleted++;
        } else {
          kept.push(rowRaw); // obligation persists (non-cap-counting)
        }
        continue;
      }
      // kind === 'held'
      const pidDead = !this.pidAlive(row.pid);
      if (pidDead) {
        // IMMEDIATE reclaim of a provably-dead pid — no heartbeat gate (§2.4).
        events.push({ kind: 'reclaim-dead', fields: { pid: row.pid, lane: row.lane } });
        report.reclaimed.push({ pid: row.pid, lane: row.lane, reason: 'pid-dead' });
        continue;
      }
      // Start-time corroboration on the DEFAULT capacity path (§2.4): a live
      // pid whose start time postdates the row's acquiredAt (+skew) is
      // provably NOT the recorded holder → treated as dead → capacity reclaim.
      const startMs = evidence.startMs.get(row.pid);
      if (typeof startMs === 'number' && startMs > row.acquiredAt + START_TIME_SKEW_MS) {
        events.push({
          kind: 'reclaim-mismatch',
          fields: { pid: row.pid, lane: row.lane, cause: 'start-time-postdates-acquire' },
        });
        report.reclaimed.push({ pid: row.pid, lane: row.lane, reason: 'pid-reuse' });
        continue;
      }
      // Max-hold TTL — sanity-RANGED on read (§2.4).
      const ttl = coerceTtlMs(row.ttlMs);
      if (ttl.coerced) {
        events.push({ kind: 'warn', fields: { warnType: 'ttl-coerced-on-read', pid: row.pid, raw: String(row.ttlMs).slice(0, 32) } });
      }
      const age = nowMs - ttlWindowStart(row);
      if (age >= ttl.ttlMs) {
        if (ctx.armed && ctx.posture === 'enforcing') {
          const outcome = this.signalHungHolder(row, evidence, events, nowMs);
          if (outcome === 'tombstoned') {
            changed = true; // row mutated in place (state → terminating)
            kept.push(rowRaw); // now terminating (non-counting)
            continue;
          }
          if (outcome === 'rearmed') {
            changed = true; // row mutated in place (reArmedAt stamped)
            kept.push(rowRaw);
            this.countLive(row, report);
            continue;
          }
          // 'freed' — corroboration failed → slot freed, no signal.
          report.reclaimed.push({ pid: row.pid, lane: row.lane, reason: 'ttl-mismatch' });
          continue;
        }
        // DEFAULT: capacity-reclaim-ONLY — slot freed, loud event, NO signal.
        events.push({
          kind: 'stale-holder-reclaimed',
          fields: { pid: row.pid, lane: row.lane, ageMs: age, ttlMs: ttl.ttlMs, pidAlive: true },
        });
        report.reclaimed.push({ pid: row.pid, lane: row.lane, reason: 'ttl-capacity-reclaim' });
        continue;
      }
      if (age >= TTL_WARN_FRACTION * ttl.ttlMs) {
        events.push({ kind: 'approaching-ttl', fields: { pid: row.pid, lane: row.lane, ageMs: age, ttlMs: ttl.ttlMs } });
      }
      kept.push(rowRaw);
      this.countLive(row, report);
    }
    // Every drop path records into the report; only in-place mutations set the
    // flag directly above.
    changed = changed || report.reclaimed.length > 0 || report.tombstonesCompleted > 0;
    return { kept, report, changed };
  }

  private countLive(row: TestRunnerHolderRow, report: PruneReport): void {
    if (row.lane === 'suite') report.liveSuite++;
    else if (row.lane === 'targeted') report.liveTargeted++;
  }

  /**
   * The opt-in TTL signal path (§2.4) — four mandatory gates; a holder row is
   * data, not a warrant. Returns 'tombstoned' | 'freed' | 'rearmed'.
   */
  private signalHungHolder(
    row: TestRunnerHolderRow,
    evidence: PidEvidence,
    events: Array<{ kind: string; fields: Record<string, unknown> }>,
    nowMs: number,
  ): 'tombstoned' | 'freed' | 'rearmed' {
    // Gate 1 — pid sanity clamp (classifyRow already excluded <2/non-integer;
    // re-assert + never self).
    if (!Number.isInteger(row.pid) || row.pid < 2 || row.pid === process.pid) {
      events.push({ kind: 'warn', fields: { warnType: 'signal-pid-sanity-refused', pid: row.pid } });
      return 'freed';
    }
    // Gate 2 — identity corroboration: start time ≤ acquiredAt (+skew) AND a
    // test-runner-shaped command line.
    const startMs = evidence.startMs.get(row.pid);
    const cmdOk = typeof row.cmd === 'string' && /vitest|node/i.test(row.cmd);
    if (typeof startMs !== 'number' || startMs > row.acquiredAt + START_TIME_SKEW_MS || !cmdOk) {
      events.push({ kind: 'reclaim-mismatch', fields: { pid: row.pid, lane: row.lane, cause: 'signal-corroboration-failed' } });
      return 'freed';
    }
    // Gate 5 — sleep-wake honesty: on evidence of a boot/wake gap overlapping
    // the hold, RE-ARM the TTL window once rather than signaling.
    const boot = this.bootTimeMs();
    if (typeof boot === 'number' && boot > ttlWindowStart(row) && row.reArmedAt === undefined) {
      row.reArmedAt = nowMs;
      events.push({ kind: 'warn', fields: { warnType: 'ttl-rearmed-sleep-wake', pid: row.pid } });
      return 'rearmed';
    }
    // Gate 3 — group-leadership: group-signal ONLY when the root is its own
    // group leader; otherwise the corroborated single PID only (+ ledger the
    // downgrade).
    const pgid = evidence.pgid.get(row.pid);
    const isLeader = typeof pgid === 'number' && pgid === row.pid;
    try {
      this.signal(isLeader ? -row.pid : row.pid, 'SIGTERM');
    } catch {
      /* @silent-fallback-ok: the target may have exited between corroboration and signal */
    }
    events.push({
      kind: 'signal-term',
      fields: {
        pid: row.pid,
        lane: row.lane,
        groupSignal: isLeader,
        leadershipDowngrade: !isLeader,
        corroboration: 'matched',
      },
    });
    // Gate 4 — durable escalation: transition to a non-cap-counting
    // `terminating` tombstone (capacity freed, obligation persists).
    row.state = 'terminating';
    row.signaledAt = nowMs;
    // Completer (a): an unref'd grace timer in THIS process.
    const timer = setTimeout(() => {
      try {
        this.prune({ source: 'grace-timer' });
      } catch {
        /* @silent-fallback-ok: completers (b)/(c) — later passes — still fire */
      }
    }, TOMBSTONE_GRACE_MS + 500);
    timer.unref();
    return 'tombstoned';
  }

  /** Complete (or keep) a terminating tombstone. Returns true when dropped. */
  private completeTombstone(
    row: TestRunnerHolderRow,
    evidence: PidEvidence,
    ctx: { armed: boolean; posture: TestPosture },
    events: Array<{ kind: string; fields: Record<string, unknown> }>,
    nowMs: number,
  ): boolean {
    const pidDead = !this.pidAlive(row.pid);
    if (pidDead) {
      events.push({ kind: 'warn', fields: { warnType: 'tombstone-completed-dead', pid: row.pid } });
      return true;
    }
    const signaledAt = typeof row.signaledAt === 'number' ? row.signaledAt : row.acquiredAt;
    if (nowMs - signaledAt < TOMBSTONE_GRACE_MS) return false; // grace not elapsed
    // Re-corroborate before the SIGKILL — the fingerprint must STILL match.
    const startMs = evidence.startMs.get(row.pid);
    if (typeof startMs !== 'number' || startMs > row.acquiredAt + START_TIME_SKEW_MS) {
      events.push({ kind: 'reclaim-mismatch', fields: { pid: row.pid, cause: 'tombstone-fingerprint-mismatch' } });
      return true; // drop, no signal
    }
    if (!(ctx.armed && ctx.posture === 'enforcing')) {
      // Arm has been turned off since the SIGTERM — the kill obligation is
      // void; drop the tombstone without signaling (capacity already free).
      events.push({ kind: 'warn', fields: { warnType: 'tombstone-dropped-arm-off', pid: row.pid } });
      return true;
    }
    const pgid = evidence.pgid.get(row.pid);
    const isLeader = typeof pgid === 'number' && pgid === row.pid;
    try {
      this.signal(isLeader ? -row.pid : row.pid, 'SIGKILL');
    } catch {
      /* @silent-fallback-ok: target exited between corroboration and kill */
    }
    events.push({ kind: 'signal-kill', fields: { pid: row.pid, groupSignal: isLeader } });
    return true;
  }

  // ── Witness records + storm slots (§2.4) ────────────────────────────

  private writeWitness(): string | null {
    try {
      fs.mkdirSync(this.paths.witnessDir, { recursive: true, mode: 0o700 });
      const file = path.join(this.paths.witnessDir, `w-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
      fs.writeFileSync(file, JSON.stringify({ v: 1, pid: process.pid, hostname: this.host, acquiredAt: this.now() }), { mode: 0o600 });
      return file;
    } catch {
      // @silent-fallback-ok: the witness is best-effort observability.
      return null;
    }
  }

  /**
   * Claim a numbered O_EXCL storm slot (§2.4). Throws TestRunnerStormCeilingError
   * when all WEDGE_STORM_CEILING slots are held by pid-ALIVE claimants.
   */
  private claimStormSlot(): number {
    fs.mkdirSync(this.paths.witnessDir, { recursive: true, mode: 0o700 });
    const held: Array<{ slot: number; pid: number; ageMs: number }> = [];
    for (let n = 1; n <= WEDGE_STORM_CEILING; n++) {
      const slotPath = path.join(this.paths.witnessDir, `slot-${n}`);
      const record = JSON.stringify({ v: 1, pid: process.pid, hostname: this.host, at: this.now() });
      const take = tryTakeLockOnce(slotPath, record);
      if (take.ok) {
        try {
          fs.closeSync(take.fd);
        } catch {
          /* @silent-fallback-ok: slot fd close is benign */
        }
        return n;
      }
      // Occupied: sweepable when the claimant is dead or over the TTL ceiling.
      const info = this.readSlot(slotPath);
      if (info && (!this.pidAlive(info.pid) || this.now() - info.at > HOST_TEST_TTL_MAX_MS)) {
        if (this.renameAsideVerified(slotPath)) {
          const retake = tryTakeLockOnce(slotPath, record);
          if (retake.ok) {
            try {
              fs.closeSync(retake.fd);
            } catch {
              /* @silent-fallback-ok: slot fd close is benign */
            }
            return n;
          }
        }
        // Lost the reclaim race — treat as held by the winner.
      }
      if (info) held.push({ slot: n, pid: info.pid, ageMs: this.now() - info.at });
      else held.push({ slot: n, pid: -1, ageMs: 0 });
    }
    throw new TestRunnerStormCeilingError(held);
  }

  private readSlot(slotPath: string): { pid: number; at: number } | null {
    try {
      const obj = JSON.parse(fs.readFileSync(slotPath, 'utf-8'));
      if (obj && typeof obj.pid === 'number' && typeof obj.at === 'number') return obj;
      return { pid: -1, at: 0 }; // unparseable-but-present: age-sweepable
    } catch {
      // @silent-fallback-ok: a torn/mid-write slot reads as fresh-unknown (kept).
      return null;
    }
  }

  /**
   * Rename a file aside with dev+ino verification (§2.4 round 9/10): capture
   * identity BEFORE the rename, verify the moved object AFTER — on mismatch
   * (a peer's FRESH file created in the race) drop the claim and leave the
   * mis-grabbed file for the age sweep. Returns true when we moved the exact
   * observed object.
   */
  private renameAsideVerified(target: string): boolean {
    let before: fs.Stats;
    try {
      before = fs.lstatSync(target);
    } catch {
      // @silent-fallback-ok: it vanished — nothing to reclaim.
      return false;
    }
    const aside = `${target}.reclaim-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.renameSync(target, aside);
    } catch {
      // @silent-fallback-ok: lost the rename race — the winner proceeds.
      return false;
    }
    try {
      const after = fs.lstatSync(aside);
      // Identity = dev + ino + mtime. dev+ino alone is NOT sufficient: a freed
      // inode can be REUSED for the peer's FRESH file (observed on CI's
      // filesystem), giving a false identity match. rename(2) preserves mtime,
      // so the object we actually moved matches `before.mtimeMs` on the happy
      // path — while a swapped-in fresh file (written "now") never will (the
      // reclaimed object was provably wedged/dead, so its mtime is old).
      if (
        after.dev === before.dev &&
        after.ino === before.ino &&
        after.mtimeMs === before.mtimeMs
      )
        return true;
    } catch {
      /* @silent-fallback-ok: the aside vanished — treat as lost */
    }
    // Mismatch: we grabbed a FRESH file created in the race. Do NOT rename
    // back (itself racy — round 10): leave it under the private aside name
    // (age-swept later) and report failure.
    return false;
  }

  /** Liveness-gated witness + storm-slot + reclaim-temp sweep (§2.4). */
  private sweepWitnesses(): void {
    // §2.4 round 10: a mis-grabbed/aged LOCK aside (lock.reclaim-<pid>-<nonce>,
    // living beside the lock in the base dir) is swept by age like any stale
    // reclaim-temp — the abort path deliberately never renames back.
    try {
      const lockBase = path.basename(this.paths.lock);
      for (const name of fs.readdirSync(this.paths.baseDir)) {
        if (!name.startsWith(`${lockBase}.reclaim-`)) continue;
        const p = path.join(this.paths.baseDir, name);
        try {
          const st = fs.statSync(p);
          if (this.now() - st.mtimeMs > LOCK_WEDGE_AGE_MS * 6) {
            SafeFsExecutor.safeUnlinkSync(p, {
              operation: 'HostTestRunnerSemaphore.sweepLockReclaimTemp',
            });
          }
        } catch {
          /* @silent-fallback-ok: sweep is best-effort housekeeping */
        }
      }
    } catch {
      /* @silent-fallback-ok: no base dir yet */
    }
    let entries: string[];
    try {
      entries = fs.readdirSync(this.paths.witnessDir);
    } catch {
      // @silent-fallback-ok: no witness dir yet.
      return;
    }
    for (const name of entries) {
      const p = path.join(this.paths.witnessDir, name);
      try {
        if (name.includes('.reclaim-')) {
          // Aged reclaim-temp litter.
          const st = fs.statSync(p);
          if (this.now() - st.mtimeMs > LOCK_WEDGE_AGE_MS * 6) {
            SafeFsExecutor.safeUnlinkSync(p, { operation: 'HostTestRunnerSemaphore.sweepReclaimTemp' });
          }
          continue;
        }
        const obj = JSON.parse(fs.readFileSync(p, 'utf-8'));
        const pid = typeof obj?.pid === 'number' ? obj.pid : null;
        const at = typeof obj?.acquiredAt === 'number' ? obj.acquiredAt : typeof obj?.at === 'number' ? obj.at : null;
        const dead = pid === null || !this.pidAlive(pid);
        const overTtl = at !== null && this.now() - at > HOST_TEST_TTL_MAX_MS;
        // Liveness-gated: swept ONLY when the pid is DEAD or over the max TTL —
        // a still-running admitted-open suite's witness is never erased mid-run.
        if (dead || overTtl) {
          SafeFsExecutor.safeUnlinkSync(p, { operation: 'HostTestRunnerSemaphore.sweepWitness' });
        }
      } catch {
        /* @silent-fallback-ok: sweep is best-effort housekeeping */
      }
    }
  }

  /** Live (pid-alive) witness records — the route's `admittedOpen` field. */
  readAdmittedOpen(): Array<{ pid: number; acquiredAt: number }> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.paths.witnessDir);
    } catch {
      // @silent-fallback-ok: no witness dir → none admitted-open.
      return [];
    }
    const out: Array<{ pid: number; acquiredAt: number }> = [];
    for (const name of entries) {
      if (!name.startsWith('w-')) continue;
      try {
        const obj = JSON.parse(fs.readFileSync(path.join(this.paths.witnessDir, name), 'utf-8'));
        if (typeof obj?.pid === 'number' && this.pidAlive(obj.pid)) {
          out.push({ pid: obj.pid, acquiredAt: typeof obj.acquiredAt === 'number' ? obj.acquiredAt : 0 });
        }
      } catch {
        /* @silent-fallback-ok: torn witness rows are ignored for display */
      }
    }
    return out;
  }

  // ── Lock helpers ────────────────────────────────────────────────────

  /**
   * Try to take the holders lock within LOCK_ACQUIRE_DEADLINE_MS (only the
   * sub-millisecond critical section may spin). Returns the fd or null.
   */
  private takeLockBounded(): number | null {
    const deadline = this.now() + LOCK_ACQUIRE_DEADLINE_MS;
    for (;;) {
      const res = tryTakeLockOnce(
        this.paths.lock,
        JSON.stringify({ pid: process.pid, hostname: this.host, at: this.now() }),
      );
      if (res.ok) return res.fd;
      if (res.reason === 'error') {
        // Could be a missing base dir — create and retry once.
        try {
          ensureBaseDir(this.paths);
        } catch {
          /* @silent-fallback-ok: the outer loop treats persistent errors as lock-unavailable */
        }
      }
      if (this.now() >= deadline) return null;
      busyWaitSubMs();
    }
  }

  /**
   * Race-safe AGE-reclaim of a provably-wedged lock (§2.4): atomic rename of
   * the observed lock + dev+ino verify. The test lane's ONLY lock reclaim —
   * it never pid-probes the lock (the spawn lane's legacy reclaim is not
   * inherited).
   */
  private ageReclaimWedgedLock(): boolean {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(this.paths.lock);
    } catch {
      // @silent-fallback-ok: lock vanished — nothing to reclaim (retry take).
      return true;
    }
    if (this.now() - st.mtimeMs <= LOCK_WEDGE_AGE_MS) return false; // fresh — live
    return this.renameAsideVerified(this.paths.lock);
  }

  private lockFileAgeMs(): number | null {
    try {
      return this.now() - fs.lstatSync(this.paths.lock).mtimeMs;
    } catch {
      // @silent-fallback-ok: no lock file → no age.
      return null;
    }
  }

  // ── Acquire / release (§2.2–§2.4) ───────────────────────────────────

  async acquire(req: AcquireRequest): Promise<AcquireOutcome> {
    const ctx = this.resolveContext();
    const budgetMs = req.budgetMs ?? resolveAcquireBudgetMs(req.lane, req.runClass, this.env);
    const startMs = this.now();
    const deadline = startMs + budgetMs;
    let lockEverAcquired = false;
    let lastHolders: Array<{ pid: number; ageMs: number }> = [];

    // df determination — OUTSIDE the lock, marker-cached (§2.2 item 2).
    const df = resolveDfLocal(this.paths, this.dfProbe);
    if (!df.local) {
      // §6: df can't confirm host-local → admit the run; reclaim disabled.
      const witnessFile = this.writeWitness();
      this.ledger('fail-open-admit', { cause: `df-${df.status}`, lane: req.lane });
      return { kind: 'fail-open-admit', cause: `df-${df.status}`, witnessFile };
    }

    // Self-identity fingerprint + group leadership for the row we may write —
    // gathered OUTSIDE the lock, once per acquire (§2.4 round 9, mirroring the
    // df-outside-lock discipline of §2.2 item 2: the sub-ms critical section
    // must never spawn `ps`).
    const selfFp = selfProcessFingerprint();
    const selfPgid = this.gatherEvidence([process.pid]).pgid.get(process.pid) ?? null;

    for (;;) {
      // Evidence gathered OUTSIDE the lock (§2.4): snapshot pids, run ps on
      // the live ones; decisions re-validated under the lock.
      const preRead = this.readHolders();
      const prePids = preRead.rows
        .map((r) => (r && typeof r === 'object' ? (r as TestRunnerHolderRow).pid : NaN))
        .filter((p) => Number.isInteger(p));
      const evidence = this.gatherEvidence(prePids as number[]);

      const fd = this.takeLockBounded();
      if (fd !== null) {
        lockEverAcquired = true;
        try {
          const read = this.readHolders();
          const events: Array<{ kind: string; fields: Record<string, unknown> }> = [];
          let rows = read.rows;
          if (read.status === 'unparseable' || read.status === 'poisoned') {
            // Fail-OPEN: admit AND quarantine (§2.4).
            const q = this.quarantineHolders(read);
            this.ledger('quarantine', {
              cause: read.status === 'poisoned' ? 'poison-ceiling' : 'unparseable',
              rehomedTombstones: q.rehomed.length,
              salvaged: q.salvaged,
              possibleTombstoneDrop: q.possibleDrop,
              lane: req.lane,
            });
            rows = q.rehomed;
            const row = this.buildRow(req, ctx, selfFp, selfPgid);
            rows.push(row);
            this.writeHolders(rows);
            this.ledger('acquire', this.acquireFields(req, row, false));
            this.armSelfTtlWarn(row);
            return { kind: 'acquired', id: row.id, wouldBlock: false, ttlMs: row.ttlMs };
          }
          const pass = this.applyReclaimPass(rows, evidence, {
            dfLocal: true,
            armed: ctx.ttlSignal.armed,
            posture: ctx.posture.posture,
          }, events);
          this.flushEvents(events);
          const live = req.lane === 'suite' ? pass.report.liveSuite : pass.report.liveTargeted;
          const cap = req.lane === 'suite' ? ctx.suiteCap.cap : ctx.targetedCap.cap;
          if (live < cap) {
            const row = this.buildRow(req, ctx, selfFp, selfPgid);
            pass.kept.push(row);
            this.writeHolders(pass.kept);
            this.ledger('acquire', this.acquireFields(req, row, false));
            this.armSelfTtlWarn(row);
            this.sweepWitnesses();
            return { kind: 'acquired', id: row.id, wouldBlock: false, ttlMs: row.ttlMs };
          }
          // Lane full.
          lastHolders = this.holderAges(pass.kept, req.lane);
          if (ctx.posture.posture !== 'enforcing') {
            // Dry-run (§2.11): full bookkeeping — the run that WOULD block
            // logs `would-block` (with the live holder set) and ADMITS.
            const row = this.buildRow(req, ctx, selfFp, selfPgid);
            pass.kept.push(row);
            this.writeHolders(pass.kept);
            this.ledger('would-block', { lane: req.lane, holders: lastHolders, cap });
            this.ledger('acquire', this.acquireFields(req, row, true));
            this.armSelfTtlWarn(row);
            return { kind: 'acquired', id: row.id, wouldBlock: true, ttlMs: row.ttlMs };
          }
          // Enforcing: persist reclaim work — but ONLY when the pass actually
          // changed something (§2.2 item 3: skip the holders rewrite on a
          // failed acquire when prune removed nothing — no O(waiters) churn).
          if (pass.changed) this.writeHolders(pass.kept);
        } finally {
          releaseLock(this.paths.lock, fd, 'HostTestRunnerSemaphore.acquire:release');
        }
        if (this.now() >= deadline) {
          this.ledger('block', { lane: req.lane, holders: lastHolders, budgetMs });
          throw new TestRunnerCapacityTimeoutError(req.lane, budgetMs, lastHolders);
        }
        req.onWaitTick?.(this.now() - startMs, lastHolders);
        await this.sleep(this.jitteredPoll());
        continue;
      }
      // Lock unavailable within the attempt deadline.
      const age = this.lockFileAgeMs();
      if (age !== null && age > LOCK_WEDGE_AGE_MS) {
        // Provably wedged (critical section is sub-ms) — race-safe age-reclaim.
        this.ageReclaimWedgedLock();
        continue; // retake immediately — a missed attempt is NEVER an admit
      }
      if (this.now() >= deadline) {
        if (!lockEverAcquired) {
          // Continuously unavailable for the entire budget → fail-open admit,
          // gated by the atomic storm ceiling (§2.4).
          const slot = this.claimStormSlot(); // throws TestRunnerStormCeilingError at the ceiling
          const witnessFile = this.writeWitness();
          this.ledger('fail-open-admit', { cause: 'lock-unavailable-full-budget', lane: req.lane, stormSlot: slot });
          return { kind: 'fail-open-admit', cause: 'lock-unavailable-full-budget', witnessFile };
        }
        this.ledger('block', { lane: req.lane, holders: lastHolders, budgetMs });
        throw new TestRunnerCapacityTimeoutError(req.lane, budgetMs, lastHolders);
      }
      req.onWaitTick?.(this.now() - startMs, lastHolders);
      await this.sleep(this.jitteredPoll());
    }
  }

  private jitteredPoll(): number {
    // ±POLL_JITTER_MS uniform jitter desynchronizes the thundering herd (§2.2
    // item 3). Floored at 0 so an internal test seam that sets a sub-jitter
    // poll interval can never produce a negative sleep (defaults, 5s ≫ 1s
    // jitter, are unaffected).
    return Math.max(0, this.pollIntervalMs + Math.floor(Math.random() * POLL_JITTER_MS * 2) - POLL_JITTER_MS);
  }

  /**
   * Build the holder row for THIS process. The self fingerprint + pgid are
   * passed in by acquire() — gathered OUTSIDE the lock (§2.4 round 9), never
   * probed from inside the critical section.
   */
  private buildRow(
    req: AcquireRequest,
    ctx: ReturnType<HostTestRunnerSemaphore['resolveContext']>,
    selfFp: { startedAt: string; cmd: string },
    selfPgid: number | null,
  ): TestRunnerHolderRow {
    void ctx;
    const ttl =
      this.ttlMsOverride !== undefined
        ? { ttlMs: this.ttlMsOverride, coerced: false } // INTERNAL policy parameter (tests)
        : resolveAcquireTtlMs(this.env);
    if (ttl.coerced) {
      this.ledger('warn', { warnType: 'ttl-coerced-at-acquire', raw: String(this.env['INSTAR_HOST_TEST_TTL_MS']).slice(0, 32) });
    }
    return {
      v: 1,
      id: this.genId(),
      lane: req.lane,
      pid: process.pid,
      hostname: this.host,
      acquiredAt: this.now(),
      startedAt: selfFp.startedAt,
      cmd: selfFp.cmd,
      ttlMs: ttl.ttlMs,
      state: 'held',
      runClass: req.runClass,
      ...(req.fileCount !== undefined ? { fileCount: req.fileCount } : {}),
      pgidLeader: typeof selfPgid === 'number' ? selfPgid === process.pid : false,
    };
  }

  private acquireFields(req: AcquireRequest, row: TestRunnerHolderRow, wouldBlock: boolean): Record<string, unknown> {
    return {
      lane: req.lane,
      runClass: req.runClass,
      holderId: row.id,
      ttlMs: row.ttlMs,
      wouldBlock,
      ...(req.fileCount !== undefined ? { fileCount: req.fileCount } : {}),
    };
  }

  private flushEvents(events: Array<{ kind: string; fields: Record<string, unknown> }>): void {
    for (const e of events) this.ledger(e.kind, e.fields);
  }

  private holderAges(rows: unknown[], lane: TestLane): Array<{ pid: number; ageMs: number }> {
    const out: Array<{ pid: number; ageMs: number }> = [];
    for (const r of rows) {
      if (classifyRow(r) !== 'held') continue;
      const row = r as TestRunnerHolderRow;
      if (row.lane !== lane) continue;
      out.push({ pid: row.pid, ageMs: this.now() - row.acquiredAt });
    }
    return out;
  }

  /** The 80%-of-TTL warning timer, armed in the holding root (§2.4). */
  private armSelfTtlWarn(row: TestRunnerHolderRow): void {
    const delay = Math.max(1000, Math.floor(row.ttlMs * TTL_WARN_FRACTION));
    const timer = setTimeout(() => {
      try {
        process.stderr.write(
          `[test-runner-bound] WARN: this run has held its ${row.lane}-lane slot for ${Math.round(
            (row.ttlMs * TTL_WARN_FRACTION) / 60000,
          )}m (80% of its ${Math.round(row.ttlMs / 60000)}m TTL) — the slot will be capacity-reclaimed at TTL.\n`,
        );
        this.ledger('approaching-ttl', { pid: process.pid, lane: row.lane, self: true });
      } catch {
        /* @silent-fallback-ok: the prune-pass approaching-ttl event is the durable backstop */
      }
    }, delay);
    timer.unref();
  }

  /** Release the slot held under `id`. Never throws; bounded lock wait. */
  release(id: string): void {
    for (let attempt = 0; attempt < 8; attempt++) {
      const fd = this.takeLockBounded();
      if (fd === null) {
        const age = this.lockFileAgeMs();
        if (age !== null && age > LOCK_WEDGE_AGE_MS) {
          this.ageReclaimWedgedLock();
          continue;
        }
        busyWaitSubMs();
        continue;
      }
      try {
        const read = this.readHolders();
        if (read.status === 'ok' || read.status === 'poisoned') {
          const remaining = read.rows.filter(
            (r) => !(r && typeof r === 'object' && (r as TestRunnerHolderRow).id === id),
          );
          this.writeHolders(remaining);
        }
        this.ledger('release', { holderId: id });
        return;
      } finally {
        releaseLock(this.paths.lock, fd, 'HostTestRunnerSemaphore.release:release');
      }
    }
    // Couldn't take the lock — pid-death reclaim will free the slot; loud trace.
    this.ledger('warn', { warnType: 'release-lock-unavailable', holderId: id });
  }

  // ── Prune (POST /prune + acquire path are the ONLY persistent reclaimers) ──

  private static _pruneInFlight = false;
  private static _lastPruneAt = 0;

  /**
   * Force a full reclaim pass (the §2.6 recovery lever). Single-flight +
   * rate-limited (one forced pass per 5s). Returns what was reclaimed.
   */
  prune(opts: { source: string; force?: boolean } = { source: 'manual' }): PruneReport & {
    rateLimited?: boolean;
  } {
    const nowMs = this.now();
    if (HostTestRunnerSemaphore._pruneInFlight) {
      return { reclaimed: [], tombstonesCompleted: 0, liveSuite: 0, liveTargeted: 0, rateLimited: true };
    }
    if (!opts.force && nowMs - HostTestRunnerSemaphore._lastPruneAt < 5000) {
      return { reclaimed: [], tombstonesCompleted: 0, liveSuite: 0, liveTargeted: 0, rateLimited: true };
    }
    HostTestRunnerSemaphore._pruneInFlight = true;
    HostTestRunnerSemaphore._lastPruneAt = nowMs;
    try {
      const ctx = this.resolveContext();
      const df = resolveDfLocal(this.paths, this.dfProbe);
      const preRead = this.readHolders();
      const prePids = preRead.rows
        .map((r) => (r && typeof r === 'object' ? (r as TestRunnerHolderRow).pid : NaN))
        .filter((p) => Number.isInteger(p));
      const evidence = this.gatherEvidence(prePids as number[]);
      const fd = this.takeLockBounded();
      if (fd === null) {
        return { reclaimed: [], tombstonesCompleted: 0, liveSuite: 0, liveTargeted: 0 };
      }
      try {
        const read = this.readHolders();
        if (read.status === 'unparseable' || read.status === 'poisoned') {
          const q = this.quarantineHolders(read);
          this.ledger('quarantine', {
            cause: read.status === 'poisoned' ? 'poison-ceiling' : 'unparseable',
            rehomedTombstones: q.rehomed.length,
            salvaged: q.salvaged,
            possibleTombstoneDrop: q.possibleDrop,
            source: opts.source,
          });
          return { reclaimed: [], tombstonesCompleted: 0, liveSuite: 0, liveTargeted: 0 };
        }
        const events: Array<{ kind: string; fields: Record<string, unknown> }> = [];
        const pass = this.applyReclaimPass(read.rows, evidence, {
          dfLocal: df.local,
          armed: ctx.ttlSignal.armed,
          posture: ctx.posture.posture,
        }, events);
        this.flushEvents(events);
        // Write-only-on-change (§2.2 item 3) — a no-op prune pass never churns
        // the holders file.
        if (pass.changed) this.writeHolders(pass.kept);
        this.sweepWitnesses();
        return pass.report;
      } finally {
        releaseLock(this.paths.lock, fd, 'HostTestRunnerSemaphore.prune:release');
      }
    } finally {
      HostTestRunnerSemaphore._pruneInFlight = false;
    }
  }

  // ── Status (§2.7 — PURE read: lock-free, write-free, signal-free) ────

  status(): {
    cap: number;
    targetedCap: number;
    posture: TestPosture;
    clampActive: boolean;
    ttlSignalArmed: boolean;
    liveHolders: Array<{ pid: number; hostname: string; acquiredAt: number; ttlMs: number; state: string }>;
    targetedHolders: Array<{ pid: number; hostname: string; acquiredAt: number; ttlMs: number; state: string }>;
    admittedOpen: Array<{ pid: number; acquiredAt: number }>;
    suite: { available: number; saturated: boolean };
    targeted: { available: number; saturated: boolean };
    recentEvents: TestRunnerLedgerEvent[];
    skipHistogram: Record<string, number>;
  } {
    const ctx = this.resolveContext();
    const read = this.readHolders();
    const nowMs = this.now();
    const clampField = (s: unknown): string =>
      String(s ?? '')
        .replace(/[^a-zA-Z0-9._:\-\/ ]/g, '')
        .slice(0, 128);
    const liveByLane: Record<TestLane, Array<{ pid: number; hostname: string; acquiredAt: number; ttlMs: number; state: string }>> = {
      suite: [],
      targeted: [],
    };
    for (const r of read.rows) {
      if (classifyRow(r) !== 'held') continue; // tombstones/unknown excluded from live counts
      const row = r as TestRunnerHolderRow;
      // VIRTUAL prune for display only — the file is never written and nothing
      // is ever signaled from a GET (§2.7).
      if (!this.pidAlive(row.pid)) continue;
      const ttl = coerceTtlMs(row.ttlMs);
      if (nowMs - ttlWindowStart(row) >= ttl.ttlMs) continue;
      liveByLane[row.lane].push({
        pid: row.pid,
        hostname: clampField(row.hostname),
        acquiredAt: row.acquiredAt,
        ttlMs: ttl.ttlMs,
        state: 'held',
      });
    }
    const recentEvents = readLedgerTail(this.paths, 50);
    const skipHistogram: Record<string, number> = {};
    for (const e of recentEvents) {
      if (e.kind === 'skip' && typeof e.reason === 'string') {
        skipHistogram[e.reason] = (skipHistogram[e.reason] ?? 0) + 1;
      }
    }
    return {
      cap: ctx.suiteCap.cap,
      targetedCap: ctx.targetedCap.cap,
      posture: ctx.posture.posture,
      clampActive: ctx.clampActive,
      ttlSignalArmed: ctx.ttlSignal.armed,
      liveHolders: liveByLane.suite,
      targetedHolders: liveByLane.targeted,
      admittedOpen: this.readAdmittedOpen(),
      suite: {
        available: Math.max(0, ctx.suiteCap.cap - liveByLane.suite.length),
        saturated: liveByLane.suite.length >= ctx.suiteCap.cap,
      },
      targeted: {
        available: Math.max(0, ctx.targetedCap.cap - liveByLane.targeted.length),
        saturated: liveByLane.targeted.length >= ctx.targetedCap.cap,
      },
      recentEvents,
      skipHistogram,
    };
  }
}

// ── Small shared helpers ──────────────────────────────────────────────────

function ensureBaseDir(paths: TestRunnerPaths): void {
  if (!fs.existsSync(paths.baseDir)) fs.mkdirSync(paths.baseDir, { recursive: true, mode: 0o700 });
}

/** Sub-millisecond spin — permitted ONLY inside the lock critical section (§2.2). */
function busyWaitSubMs(): void {
  const end = Date.now() + 1;
  while (Date.now() < end) {
    /* spin ~1ms */
  }
}

/** INTERNAL poll override for meta-tests (undocumented — not a public lever). */
function resolveInternalPollMs(env: NodeJS.ProcessEnv): number {
  const raw = env['INSTAR_HOST_TEST_POLL_MS'];
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 10) return Math.floor(n);
  }
  return POLL_INTERVAL_MS;
}

/** macOS boot time via sysctl (best-effort; null when unobtainable). */
export function readMacBootTimeMs(): number | null {
  try {
    // lint-allow-sync-spawn: bounded one-shot sysctl for the sleep-wake gate.
    const out = execFileSync('sysctl', ['-n', 'kern.boottime'], { timeout: 2000, encoding: 'utf-8' });
    const m = out.match(/sec\s*=\s*(\d+)/);
    if (m) return Number(m[1]) * 1000;
    return null;
  } catch {
    // @silent-fallback-ok: unobtainable boot signal → the NAMED residual (§2.4 gate 5).
    return null;
  }
}

// ── Process-wide singleton (thin, per-module — deliberately NOT in the core) ──

let _singleton: HostTestRunnerSemaphore | null = null;

export function getHostTestRunnerSemaphore(): HostTestRunnerSemaphore {
  if (!_singleton) _singleton = new HostTestRunnerSemaphore();
  return _singleton;
}

export function _resetHostTestRunnerSemaphoreForTest(): void {
  _singleton = null;
}
