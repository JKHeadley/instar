/**
 * RoutingSpendCapsStore — the DEDICATED PIN-only money-authority store of the
 * Routing Control Room (docs/specs/routing-control-room-spend-alerts.md,
 * Increment B, Surface 2 / S-F2).
 *
 * Caps + go-live + metered-lease designation live in
 * `<stateDir>/state/routing-spend-caps.json`, written ONLY through this store's
 * typed mutators — which the PIN routes (and the Bearer set-true-only freeze)
 * call. The file is NEVER under any `PATCHABLE_CONFIG_KEYS` key, so a Bearer
 * `PATCH /config` can structurally never arm a door, unfreeze a key, or raise a
 * cap (regression-tested).
 *
 * Concurrency/authority discipline:
 *  - Every write is atomic (tmp+rename) and bumps the store VERSION — the
 *    optimistic-concurrency anchor the rendered-plan commit checks (C5-3):
 *    a plan pins the version it read; commit refuses on mismatch.
 *  - Every committed mutation ADDITIONALLY passes a schema-level validator
 *    independent of the plan machinery (C4-4) — a plan-renderer bug can never
 *    become the sole authority boundary.
 *  - Every change appends a BEFORE+AFTER audit row (never just the delta).
 *  - STOP is cheap: `freeze()` is set-TRUE-only (the Bearer surface); unfreeze
 *    goes through the PIN plan path like every other money-releasing action.
 *  - Deny-by-default: with no go-live record every metered door stays skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROBE_DOOR, PROBE_KEY_REF, withProbeDoor } from './moneyLayerProbe.js';

/**
 * The RESERVED cap-gate probe door is refused by EVERY generic caps mutator
 * (docs/specs/money-layer-operator-enable-surface.md §6/T41). Generic registry
 * code that does not know the door is special was named by the convergence
 * check as the one residual risk of the probe-door design, so the refusal lives
 * HERE — at the single mutation funnel every route goes through — rather than
 * in each route.
 */
function refuseIfReservedProbe(op: string, keyRefOrDoor: string): void {
  if (keyRefOrDoor === PROBE_KEY_REF || keyRefOrDoor === PROBE_DOOR) {
    throw new Error(`'${keyRefOrDoor}' is the reserved cap-gate probe door — ${op} is refused on it`);
  }
}

export interface KeyCapsRecord {
  provider: string;
  /**
   * Lifetime cap. OPTIONAL when `monthlyCapUsd` is set (gemini-payg §5 period
   * model): the monthly cap is then the operator's bound. A record must carry
   * at least one of lifetime or monthly, plus the daily cap.
   */
  lifetimeCapUsd?: number;
  /** Monthly cap, the calendar month in `periodTimeZone` (gemini-payg §5). */
  monthlyCapUsd?: number;
  dailyCapUsd: number;
  /**
   * IANA zone the day and month periods are computed in. Absent ⇒ UTC, so every
   * pre-existing key keeps today's UTC-day behaviour. Fixed once a door using
   * this key has a live go-live record.
   */
  periodTimeZone?: string;
  frozen: boolean;
  frozenBy?: string;
  frozenAt?: string;
}

/**
 * The closed set of metered callers (gemini-payg §2). `release-proof` is
 * admitted only with a recorder-minted proof marker; `probe` is the reserved
 * cap-gate probe value and never passes the caller-facing entry.
 */
export type MeteredCallerId =
  | 'spec-review'
  | 'second-opinion'
  | 'nature-routing'
  | 'doorway-liveness'
  | 'release-proof'
  | 'probe';

export const METERED_CALLER_IDS: readonly MeteredCallerId[] = [
  'spec-review',
  'second-opinion',
  'nature-routing',
  'doorway-liveness',
  'release-proof',
  'probe',
];

/** Callers an operator may list in a door policy (release-proof/probe are internal-only). */
export const POLICY_LISTABLE_CALLERS: ReadonlySet<MeteredCallerId> = new Set([
  'spec-review',
  'second-opinion',
  'nature-routing',
  'doorway-liveness',
]);

export type MeteredReleaseState = 'armed-pending-proof' | 'live';

/**
 * Per-door governed money policy (gemini-payg §5). Every field is PIN-only
 * governed state except the reduce-only Bearer mutators (`lowerCaps`,
 * `disableCaller`, `lowerShare`), which can only halt money, never release it.
 */
export interface MeteredDoorPolicy {
  /** One call may reserve at most this much. */
  perCallCeilingUsd: number;
  /** `provisional + outstanding + this reserve` may not exceed this (month-scoped provisional). */
  provisionalCeilingUsd: number;
  /** E2 (second-opinion) may commit at most this share of the monthly cap. */
  e2MonthSharePct: number;
  /** E2 daily cap. */
  e2DayCapUsd: number;
  /** E1 passes per (specSha256, round). */
  e1PassesPerRound: number;
  /** SHA-256 fingerprint of the committed key, or null before go-live. */
  keyGeneration: string | null;
  meteredCallers: { callers: MeteredCallerId[]; e3Components: string[] };
  /** Measured throughput floor per model (tokens/s) — derives timeouts; releases no money. */
  throughputFloorTps: Record<string, number>;
  releaseState: MeteredReleaseState;
  /** Orders lane transfers. NOT bumped by a cap lowering. */
  designationEpoch: number;
}

export interface GoLiveRecord {
  enabled: boolean;
  keyRef: string;
  /** The PIN-designated metered-lease machine (FD-13). */
  designatedMachineId: string;
  designatedAt: string;
  /** Bumped on every designation/cap-lowering (A-M9/A-B4) — the gate re-validates against it. */
  epoch: number;
}

export interface CapsStoreFile {
  /** Optimistic-concurrency version — bumped on EVERY write (C5-3). */
  version: number;
  caps: Record<string, KeyCapsRecord>;
  goLive: Record<string, GoLiveRecord>;
  /** Metered-lease epoch — bumped on designation change and cap-lowering. */
  leaseEpoch: number;
  /** Per-door policy (gemini-payg §5). Optional so a pre-change file loads unchanged. */
  doorPolicy?: Record<string, MeteredDoorPolicy>;
  /**
   * door → the hash of the go-live intent applied to it (gemini-payg §8 "Apply").
   * Makes the boot-time apply idempotent by intent hash: a crash between the
   * write and the intent's deletion re-applies nothing. Optional (pre-change files).
   */
  appliedIntents?: Record<string, { intentHash: string; appliedAt: string }>;
}

/** The setup a go-live intent applies in ONE write (gemini-payg §8 "Apply"). */
export interface GoLiveSetupApply {
  door: string;
  keyRef: string;
  provider: string;
  designatedMachineId: string;
  caps: { monthlyCapUsd: number; dailyCapUsd: number; periodTimeZone: string };
  policy: MeteredDoorPolicy;
}

export interface CapsAuditRow {
  ts: string;
  action: string;
  actor: string;
  before: CapsStoreFile;
  after: CapsStoreFile;
}

const EMPTY: CapsStoreFile = { version: 0, caps: {}, goLive: {}, leaseEpoch: 0 };

/** True when `tz` is an IANA zone this runtime's Intl knows. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    // @silent-fallback-ok: an unknown zone is a validation FAILURE (returns false), not a default.
    return false;
  }
}

function isNonNegFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** Store-level validation of one door policy record (C4-4 independence applies here too). */
export function validateDoorPolicy(door: string, p: unknown): string | null {
  if (!p || typeof p !== 'object') return `doorPolicy['${door}'] not an object`;
  const r = p as MeteredDoorPolicy;
  for (const f of ['perCallCeilingUsd', 'provisionalCeilingUsd', 'e2DayCapUsd'] as const) {
    if (!isNonNegFinite(r[f])) return `doorPolicy['${door}'].${f} must be ≥ 0`;
  }
  if (!isNonNegFinite(r.e2MonthSharePct) || r.e2MonthSharePct > 100) return `doorPolicy['${door}'].e2MonthSharePct must be in [0,100]`;
  if (!Number.isInteger(r.e1PassesPerRound) || r.e1PassesPerRound < 0) return `doorPolicy['${door}'].e1PassesPerRound must be a non-negative integer`;
  if (r.keyGeneration !== null && (typeof r.keyGeneration !== 'string' || !/^[0-9a-f]{64}$/.test(r.keyGeneration))) {
    return `doorPolicy['${door}'].keyGeneration must be null or a sha256 hex fingerprint`;
  }
  const mc = r.meteredCallers;
  if (!mc || typeof mc !== 'object' || !Array.isArray(mc.callers) || !Array.isArray(mc.e3Components)) {
    return `doorPolicy['${door}'].meteredCallers must be { callers: [], e3Components: [] }`;
  }
  for (const c of mc.callers) {
    if (!POLICY_LISTABLE_CALLERS.has(c)) return `doorPolicy['${door}'].meteredCallers.callers holds a non-listable caller '${String(c)}'`;
  }
  if (new Set(mc.callers).size !== mc.callers.length) return `doorPolicy['${door}'].meteredCallers.callers has duplicates`;
  for (const c of mc.e3Components) {
    if (typeof c !== 'string' || !c.trim()) return `doorPolicy['${door}'].meteredCallers.e3Components holds an empty name`;
  }
  if (!r.throughputFloorTps || typeof r.throughputFloorTps !== 'object' || Array.isArray(r.throughputFloorTps)) {
    return `doorPolicy['${door}'].throughputFloorTps must be an object`;
  }
  for (const [m, v] of Object.entries(r.throughputFloorTps)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return `doorPolicy['${door}'].throughputFloorTps['${m}'] must be > 0`;
  }
  if (r.releaseState !== 'armed-pending-proof' && r.releaseState !== 'live') return `doorPolicy['${door}'].releaseState invalid`;
  if (!Number.isInteger(r.designationEpoch) || r.designationEpoch < 0) return `doorPolicy['${door}'].designationEpoch must be a non-negative integer`;
  return null;
}

/** Schema-level validator, independent of the rendered-plan machinery (C4-4). */
export function validateCapsFile(f: unknown, knownKeyRefs?: ReadonlySet<string>, knownDoors?: ReadonlySet<string>): string | null {
  if (!f || typeof f !== 'object') return 'not an object';
  const file = f as CapsStoreFile;
  if (!Number.isInteger(file.version) || file.version < 0) return 'version must be a non-negative integer';
  if (!Number.isInteger(file.leaseEpoch) || file.leaseEpoch < 0) return 'leaseEpoch must be a non-negative integer';
  if (!file.caps || typeof file.caps !== 'object') return 'caps must be an object';
  if (!file.goLive || typeof file.goLive !== 'object') return 'goLive must be an object';
  for (const [keyRef, c] of Object.entries(file.caps)) {
    if (knownKeyRefs && !knownKeyRefs.has(keyRef)) return `unknown keyRef '${keyRef}'`;
    if (!c || typeof c !== 'object') return `caps['${keyRef}'] not an object`;
    if (typeof c.provider !== 'string' || !c.provider.trim()) return `caps['${keyRef}'].provider missing`;
    // Period model (gemini-payg §5): one of lifetime or monthly, plus the daily cap.
    if (c.lifetimeCapUsd === undefined && c.monthlyCapUsd === undefined) {
      return `caps['${keyRef}'] needs a lifetimeCapUsd or a monthlyCapUsd`;
    }
    for (const capField of ['lifetimeCapUsd', 'monthlyCapUsd'] as const) {
      const v = c[capField];
      if (v !== undefined && !isNonNegFinite(v)) return `caps['${keyRef}'].${capField} must be ≥ 0`;
    }
    if (!isNonNegFinite(c.dailyCapUsd)) return `caps['${keyRef}'].dailyCapUsd must be ≥ 0`;
    if (c.periodTimeZone !== undefined && !isValidTimeZone(c.periodTimeZone)) return `caps['${keyRef}'].periodTimeZone is not a known IANA zone`;
    if (typeof c.frozen !== 'boolean') return `caps['${keyRef}'].frozen must be boolean`;
  }
  for (const [door, g] of Object.entries(file.goLive)) {
    if (knownDoors && !knownDoors.has(door)) return `unknown door '${door}'`;
    if (!g || typeof g !== 'object') return `goLive['${door}'] not an object`;
    if (typeof g.enabled !== 'boolean') return `goLive['${door}'].enabled must be boolean`;
    if (typeof g.keyRef !== 'string' || !g.keyRef.trim()) return `goLive['${door}'].keyRef missing`;
    if (typeof g.designatedMachineId !== 'string' || !g.designatedMachineId.trim()) return `goLive['${door}'].designatedMachineId missing`;
    if (!Number.isInteger(g.epoch) || g.epoch < 0) return `goLive['${door}'].epoch must be a non-negative integer`;
  }
  if (file.doorPolicy !== undefined) {
    if (!file.doorPolicy || typeof file.doorPolicy !== 'object' || Array.isArray(file.doorPolicy)) return 'doorPolicy must be an object';
    for (const [door, p] of Object.entries(file.doorPolicy)) {
      if (knownDoors && !knownDoors.has(door)) return `unknown door '${door}' in doorPolicy`;
      if (door === PROBE_DOOR) return 'the reserved probe door carries no door policy';
      const err = validateDoorPolicy(door, p);
      if (err) return err;
    }
  }
  if (file.appliedIntents !== undefined) {
    if (!file.appliedIntents || typeof file.appliedIntents !== 'object' || Array.isArray(file.appliedIntents)) return 'appliedIntents must be an object';
    for (const [door, a] of Object.entries(file.appliedIntents)) {
      if (!a || typeof a !== 'object' || typeof a.intentHash !== 'string' || !/^[0-9a-f]{64}$/.test(a.intentHash)) return `appliedIntents['${door}'].intentHash must be a sha256 hex`;
    }
  }
  return null;
}

/** The period zone a caps record uses (UTC when unset — pre-change behaviour). */
export function periodTimeZoneOf(c: KeyCapsRecord | undefined): string {
  return c?.periodTimeZone ?? 'UTC';
}

/** Values the Bearer reduce-only `lowerCaps` mutator accepts. Each must be ≤ its current value. */
export interface LowerCapsValues {
  monthlyCapUsd?: number;
  dailyCapUsd?: number;
  lifetimeCapUsd?: number;
  /** Door whose policy ceilings below are lowered (required when any of them is set). */
  door?: string;
  perCallCeilingUsd?: number;
  provisionalCeilingUsd?: number;
  e2DayCapUsd?: number;
}

export interface RoutingSpendCapsStoreOptions {
  /** The agent's `.instar/` dir. */
  stateDir: string;
  /** Where audit rows append (default `<stateDir>/state/routing-spend-caps-audit.jsonl`). */
  auditPath?: string;
  knownKeyRefs?: ReadonlySet<string>;
  knownDoors?: ReadonlySet<string>;
  now?: () => number;
}

export class RoutingSpendCapsStore {
  private readonly filePath: string;
  private readonly auditPath: string;
  private readonly knownKeyRefs?: ReadonlySet<string>;
  private readonly knownDoors?: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(opts: RoutingSpendCapsStoreOptions) {
    const stateSub = path.join(opts.stateDir, 'state');
    fs.mkdirSync(stateSub, { recursive: true });
    this.filePath = path.join(stateSub, 'routing-spend-caps.json');
    this.auditPath = opts.auditPath ?? path.join(stateSub, 'routing-spend-caps-audit.jsonl');
    this.knownKeyRefs = opts.knownKeyRefs;
    this.knownDoors = opts.knownDoors;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Read the store. A missing file is the deny-by-default EMPTY store; a corrupt file throws (fail closed — money state must never be silently defaulted). */
  read(): CapsStoreFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf-8');
    } catch {
      // @silent-fallback-ok: an ABSENT store is the legitimate pre-go-live state —
      // deny-by-default (no caps overrides, no doors armed). Only absence is safe
      // to default; a PRESENT-but-corrupt file throws below.
      return structuredClone(EMPTY);
    }
    const parsed = JSON.parse(raw) as CapsStoreFile; // throws on corrupt → caller fails closed
    const err = validateCapsFile(parsed, this.knownKeyRefs, this.knownDoors);
    if (err) throw new Error(`routing-spend caps store invalid (fail-closed): ${err}`);
    return parsed;
  }

  /** Current optimistic-concurrency version (0 when absent). */
  version(): number {
    try {
      return this.read().version;
    } catch {
      // A corrupt store has no usable version; surface a sentinel the plan path
      // will fail to match (commit then refuses — the safe direction).
      return -1;
    }
  }

  /**
   * Apply a typed mutation. `expectedVersion` is the optimistic-concurrency check
   * (pass null to skip ONLY for the Bearer freeze path — halting money must never
   * be blocked by a concurrent PIN plan).
   */
  private mutate(action: string, actor: string, expectedVersion: number | null, fn: (f: CapsStoreFile) => void, opts?: { durable?: boolean }): CapsStoreFile {
    const before = this.read();
    if (expectedVersion !== null && before.version !== expectedVersion) {
      throw new Error(`caps store version drift (expected ${expectedVersion}, is ${before.version}) — re-render the plan`);
    }
    const after = structuredClone(before);
    fn(after);
    after.version = before.version + 1;
    const err = validateCapsFile(after, this.knownKeyRefs, this.knownDoors);
    if (err) throw new Error(`caps mutation rejected by schema validator (C4-4): ${err}`);
    const tmp = this.filePath + '.tmp';
    if (opts?.durable) {
      // The go-live apply deletes its intent only after THIS write is on disk, so the
      // bytes and the rename are fsync'd (gemini-payg §8 "deletes the intent only after
      // that write has been fsync'd").
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(after, null, 2));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.filePath);
      try {
        const dfd = fs.openSync(path.dirname(this.filePath), 'r');
        try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
      } catch {
        // @silent-fallback-ok: a directory fsync is unsupported on some platforms; the
        // file's own bytes are already synced and the rename is atomic.
      }
    } else {
      fs.writeFileSync(tmp, JSON.stringify(after, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    }
    this.appendAudit({ ts: new Date(this.now()).toISOString(), action, actor, before, after });
    return after;
  }

  /**
   * PIN path: adjust caps for a key (raise or lower; lowering bumps the lease epoch — A-M9).
   * `lifetimeCapUsd` may be omitted/null when `monthlyCapUsd` is set (gemini-payg §5).
   * The period zone is FIXED once any door using this key has a live go-live
   * record: a zone change then is refused (a reservation near midnight on a
   * month's last day could otherwise land in a fresh month).
   */
  adjustCaps(
    actor: string,
    expectedVersion: number,
    keyRef: string,
    provider: string,
    caps: { lifetimeCapUsd?: number | null; monthlyCapUsd?: number | null; dailyCapUsd: number; periodTimeZone?: string | null },
  ): CapsStoreFile {
    refuseIfReservedProbe('re-pricing', keyRef);
    return this.mutate('caps-adjust', actor, expectedVersion, (f) => {
      const prev = f.caps[keyRef];
      const nextZone = caps.periodTimeZone ?? prev?.periodTimeZone;
      if (prev && periodTimeZoneOf(prev) !== (nextZone ?? 'UTC')) {
        const liveDoor = Object.entries(f.goLive).find(([, g]) => g.keyRef === keyRef && g.enabled);
        if (liveDoor) {
          throw new Error(
            `the period zone of '${keyRef}' is fixed while door '${liveDoor[0]}' is live — it can change only through a new go-live at a closed period boundary`,
          );
        }
      }
      const lifetime = caps.lifetimeCapUsd ?? undefined;
      const monthly = caps.monthlyCapUsd ?? undefined;
      const lowered =
        prev !== undefined &&
        (caps.dailyCapUsd < prev.dailyCapUsd ||
          (lifetime !== undefined && (prev.lifetimeCapUsd === undefined || lifetime < prev.lifetimeCapUsd)) ||
          (monthly !== undefined && (prev.monthlyCapUsd === undefined || monthly < prev.monthlyCapUsd)));
      f.caps[keyRef] = {
        provider,
        ...(lifetime !== undefined ? { lifetimeCapUsd: lifetime } : {}),
        ...(monthly !== undefined ? { monthlyCapUsd: monthly } : {}),
        dailyCapUsd: caps.dailyCapUsd,
        ...(nextZone ? { periodTimeZone: nextZone } : {}),
        frozen: prev?.frozen ?? false,
        ...(prev?.frozenBy ? { frozenBy: prev.frozenBy } : {}),
        ...(prev?.frozenAt ? { frozenAt: prev.frozenAt } : {}),
      };
      if (lowered) f.leaseEpoch += 1; // fenced cap-lowering — the gate re-reads and clamps
    });
  }

  /**
   * PIN path: write a door's whole policy record (gemini-payg §5). Adding a
   * caller or an E3 component, or raising a share, is a money release, so it
   * rides the PIN plan path with an optimistic-concurrency version.
   */
  setDoorPolicy(actor: string, expectedVersion: number, door: string, policy: MeteredDoorPolicy): CapsStoreFile {
    refuseIfReservedProbe('setting a door policy', door);
    return this.mutate('door-policy-set', actor, expectedVersion, (f) => {
      const prev = f.doorPolicy?.[door];
      // The release proof recorder is the ONLY path to `live` (spec §8). A policy
      // write may keep a live door live, but never moves a door to live.
      if (policy.releaseState === 'live' && prev?.releaseState !== 'live') {
        throw new Error(`door '${door}' can become live only through the release-proof recorder (recordReleaseLive), not a policy write`);
      }
      f.doorPolicy = { ...(f.doorPolicy ?? {}), [door]: structuredClone(policy) };
    });
  }

  /**
   * The store carrier for the release-proof recorder (spec §8, built in a later
   * slice): moves a door from `armed-pending-proof` to `live`, recording the
   * proof evidence in the audit row's actor. Refuses from any other state. The
   * recorder is responsible for the release checks (a)–(e) before calling this.
   */
  recordReleaseLive(actor: string, door: string, evidence: { proofReserveId: string; intentHash: string }): CapsStoreFile {
    refuseIfReservedProbe('recording a release on', door);
    if (!evidence?.proofReserveId?.trim() || !evidence?.intentHash?.trim()) throw new Error('recordReleaseLive: proof evidence required');
    return this.mutate('release-live', `${actor} proof=${evidence.proofReserveId} intent=${evidence.intentHash}`, null, (f) => {
      const p = f.doorPolicy?.[door];
      if (!p) throw new Error(`recordReleaseLive: no door policy for '${door}'`);
      if (p.releaseState !== 'armed-pending-proof') throw new Error(`recordReleaseLive: door '${door}' is not armed-pending-proof`);
      p.releaseState = 'live';
    });
  }

  /**
   * The go-live APPLY (gemini-payg §8 "Apply"): caps, the GoLiveRecord, the door
   * policy (releaseState `armed-pending-proof`) and the period zone in ONE durable
   * write, stamped with the intent hash it applied. Called only by the pending-intent
   * apply (boot, or hot when money is already enforcing) — the PIN commit that wrote
   * the intent is the authority; this is its single writer.
   *
   * Idempotent by intent hash: a door already stamped with this hash is returned
   * unchanged. A fresh go-live (a new intent hash) starts the door at
   * `armed-pending-proof` again, so the proof is repeated. An existing freeze is kept
   * (an apply never releases a frozen key).
   */
  applyGoLiveSetup(actor: string, intentHash: string, setup: GoLiveSetupApply): CapsStoreFile {
    refuseIfReservedProbe('applying a go-live setup to', setup.door);
    refuseIfReservedProbe('applying a go-live setup to', setup.keyRef);
    if (!/^[0-9a-f]{64}$/.test(intentHash)) throw new Error('applyGoLiveSetup: intentHash must be a sha256 hex');
    if (setup.policy.releaseState !== 'armed-pending-proof') throw new Error('applyGoLiveSetup: a go-live starts armed-pending-proof — only the recorder sets live');
    const current = this.read();
    if (current.appliedIntents?.[setup.door]?.intentHash === intentHash) return current;
    return this.mutate('go-live-setup-apply', `${actor} intent=${intentHash}`, null, (f) => {
      const prevCaps = f.caps[setup.keyRef];
      f.caps[setup.keyRef] = {
        provider: setup.provider,
        monthlyCapUsd: setup.caps.monthlyCapUsd,
        dailyCapUsd: setup.caps.dailyCapUsd,
        periodTimeZone: setup.caps.periodTimeZone,
        frozen: prevCaps?.frozen ?? false,
        ...(prevCaps?.frozenBy ? { frozenBy: prevCaps.frozenBy } : {}),
        ...(prevCaps?.frozenAt ? { frozenAt: prevCaps.frozenAt } : {}),
      };
      const prevEpoch = f.goLive[setup.door]?.epoch ?? 0;
      f.goLive[setup.door] = {
        enabled: true,
        keyRef: setup.keyRef,
        designatedMachineId: setup.designatedMachineId,
        designatedAt: new Date(this.now()).toISOString(),
        epoch: prevEpoch + 1,
      };
      f.doorPolicy = { ...(f.doorPolicy ?? {}), [setup.door]: structuredClone(setup.policy) };
      f.appliedIntents = { ...(f.appliedIntents ?? {}), [setup.door]: { intentHash, appliedAt: new Date(this.now()).toISOString() } };
      f.leaseEpoch += 1;
    }, { durable: true });
  }

  /**
   * Bearer, REDUCE-ONLY: lower key caps and/or a door's money ceilings. Every
   * value must be ≤ its current value (adding a lifetime cap where none exists
   * is a restriction and is allowed). Bumps the gate's `leaseEpoch` (slice
   * fencing) and NEVER `designationEpoch`, so lowering never interrupts the
   * lease confirmation (§6). No expectedVersion: halting money is never blocked
   * by a concurrent plan.
   */
  lowerCaps(actor: string, keyRef: string, values: LowerCapsValues): CapsStoreFile {
    refuseIfReservedProbe('lowering', keyRef);
    return this.mutate('caps-lower', actor, null, (f) => {
      const c = f.caps[keyRef];
      const keyFields = ['monthlyCapUsd', 'dailyCapUsd', 'lifetimeCapUsd'] as const;
      const doorFields = ['perCallCeilingUsd', 'provisionalCeilingUsd', 'e2DayCapUsd'] as const;
      let touched = false;
      for (const k of keyFields) {
        const v = values[k];
        if (v === undefined) continue;
        if (!isNonNegFinite(v)) throw new Error(`lowerCaps: ${k} must be a number ≥ 0`);
        if (!c) throw new Error(`lowerCaps: no caps record for '${keyRef}'`);
        const cur = c[k];
        if (cur !== undefined && v > cur) throw new Error(`lowerCaps: ${k} ${v} is above the current ${cur} — raising is a PIN action`);
        c[k] = v;
        touched = true;
      }
      if (doorFields.some((k) => values[k] !== undefined)) {
        const door = values.door;
        if (!door) throw new Error('lowerCaps: door required to lower a door ceiling');
        refuseIfReservedProbe('lowering', door);
        const p = f.doorPolicy?.[door];
        if (!p) throw new Error(`lowerCaps: no door policy for '${door}'`);
        for (const k of doorFields) {
          const v = values[k];
          if (v === undefined) continue;
          if (!isNonNegFinite(v)) throw new Error(`lowerCaps: ${k} must be a number ≥ 0`);
          if (v > p[k]) throw new Error(`lowerCaps: ${k} ${v} is above the current ${p[k]} — raising is a PIN action`);
          p[k] = v;
          touched = true;
        }
      }
      if (!touched) throw new Error('lowerCaps: nothing to lower');
      f.leaseEpoch += 1;
    });
  }

  /** Bearer, REDUCE-ONLY: remove a caller (or an E3 component) from a door's allowlist. Halting money is immediate. */
  disableCaller(actor: string, door: string, target: { caller: MeteredCallerId } | { e3Component: string }): CapsStoreFile {
    refuseIfReservedProbe('disabling a caller on', door);
    return this.mutate('caller-disable', actor, null, (f) => {
      const p = f.doorPolicy?.[door];
      if (!p) throw new Error(`disableCaller: no door policy for '${door}'`);
      if ('caller' in target) {
        p.meteredCallers.callers = p.meteredCallers.callers.filter((c) => c !== target.caller);
      } else {
        p.meteredCallers.e3Components = p.meteredCallers.e3Components.filter((c) => c !== target.e3Component);
      }
    });
  }

  /** Bearer, REDUCE-ONLY: lower the E2 month share. Raising is a PIN action. */
  lowerShare(actor: string, door: string, e2MonthSharePct: number): CapsStoreFile {
    refuseIfReservedProbe('lowering a share on', door);
    return this.mutate('share-lower', actor, null, (f) => {
      const p = f.doorPolicy?.[door];
      if (!p) throw new Error(`lowerShare: no door policy for '${door}'`);
      if (!isNonNegFinite(e2MonthSharePct)) throw new Error('lowerShare: share must be a number ≥ 0');
      if (e2MonthSharePct > p.e2MonthSharePct) throw new Error(`lowerShare: ${e2MonthSharePct}% is above the current ${p.e2MonthSharePct}% — raising is a PIN action`);
      p.e2MonthSharePct = e2MonthSharePct;
    });
  }

  /** PIN path: arm/disarm a door + designate the metered-lease machine (FD-13). */
  setGoLive(actor: string, expectedVersion: number, door: string, rec: { enabled: boolean; keyRef: string; designatedMachineId: string }): CapsStoreFile {
    refuseIfReservedProbe('arming/disarming', door);
    refuseIfReservedProbe('arming/disarming', rec.keyRef);
    return this.mutate('go-live', actor, expectedVersion, (f) => {
      const prevEpoch = f.goLive[door]?.epoch ?? 0;
      f.goLive[door] = {
        enabled: rec.enabled,
        keyRef: rec.keyRef,
        designatedMachineId: rec.designatedMachineId,
        designatedAt: new Date(this.now()).toISOString(),
        epoch: prevEpoch + 1,
      };
      f.leaseEpoch += 1;
    });
  }

  /**
   * Install the RESERVED cap-gate probe door, idempotently
   * (docs/specs/money-layer-operator-enable-surface.md §6).
   *
   * It is deliberately LIVE with a tiny POSITIVE cap, so the readiness probe is
   * an ORDINARY metered call on the ORDINARY path — go-live passes because the
   * door really is live, and the refusal is a genuine `cap-exceeded` from the
   * real comparison rather than an `invalid-cap` short-circuit.
   *
   * Writes nothing when the door is already correct, so a server restart does
   * not append an audit row per boot.
   */
  ensureProbeDoor(machineId: string): CapsStoreFile {
    const before = this.read();
    const wanted = withProbeDoor(before, machineId, new Date(this.now()).toISOString());
    const capsSame = JSON.stringify(before.caps[PROBE_KEY_REF]) === JSON.stringify(wanted.caps[PROBE_KEY_REF]);
    const goLiveSame =
      before.goLive[PROBE_DOOR]?.enabled === true &&
      before.goLive[PROBE_DOOR]?.keyRef === PROBE_KEY_REF &&
      before.goLive[PROBE_DOOR]?.designatedMachineId === machineId;
    if (capsSame && goLiveSame) return before;
    return this.mutate('probe-door-ensure', 'system', null, (f) => {
      const next = withProbeDoor(f, machineId, new Date(this.now()).toISOString());
      f.caps[PROBE_KEY_REF] = next.caps[PROBE_KEY_REF];
      f.goLive[PROBE_DOOR] = next.goLive[PROBE_DOOR];
    });
  }

  /** PIN path: unfreeze (releasing money is always the operator's). */
  unfreeze(actor: string, expectedVersion: number, keyRef: string): CapsStoreFile {
    refuseIfReservedProbe('unfreezing', keyRef);
    return this.mutate('unfreeze', actor, expectedVersion, (f) => {
      const c = f.caps[keyRef];
      if (!c) throw new Error(`unfreeze: no caps record for '${keyRef}'`);
      c.frozen = false;
      delete c.frozenBy;
      delete c.frozenAt;
    });
  }

  /**
   * Bearer path: FREEZE a key — set-TRUE-only (S-F5/X-C5); records the actor; never
   * takes an expectedVersion (halting money is never blocked by a concurrent plan).
   * Creates the caps record from defaults if absent so an un-adjusted key can still
   * be frozen instantly.
   */
  freeze(
    actor: string,
    keyRef: string,
    defaults?: { provider: string; lifetimeCapUsd?: number; monthlyCapUsd?: number; dailyCapUsd: number; periodTimeZone?: string },
  ): CapsStoreFile {
    // Freezing the probe door would break readiness for no safety gain: it holds
    // a no-op provider and cannot spend in the first place.
    refuseIfReservedProbe('freezing', keyRef);
    return this.mutate('freeze', actor, null, (f) => {
      const c = f.caps[keyRef];
      if (c) {
        c.frozen = true;
        c.frozenBy = actor;
        c.frozenAt = new Date(this.now()).toISOString();
      } else {
        const monthly = defaults?.monthlyCapUsd;
        f.caps[keyRef] = {
          provider: defaults?.provider ?? 'unknown',
          // A monthly-shaped default stays monthly-only; otherwise lifetime (0 when unknown).
          ...(monthly !== undefined && defaults?.lifetimeCapUsd === undefined
            ? { monthlyCapUsd: monthly }
            : { lifetimeCapUsd: defaults?.lifetimeCapUsd ?? 0, ...(monthly !== undefined ? { monthlyCapUsd: monthly } : {}) }),
          dailyCapUsd: defaults?.dailyCapUsd ?? 0,
          ...(defaults?.periodTimeZone ? { periodTimeZone: defaults.periodTimeZone } : {}),
          frozen: true,
          frozenBy: actor,
          frozenAt: new Date(this.now()).toISOString(),
        };
      }
    });
  }

  /** Bearer-read audit trail (most recent last; bounded by the caller's limit). */
  auditLog(limit = 100): CapsAuditRow[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.auditPath, 'utf-8');
    } catch {
      // @silent-fallback-ok: no audit yet — an empty log is the fresh-store state.
      return [];
    }
    const rows: CapsAuditRow[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // Malformed-row-skip (torn trailing append).
        continue;
      }
    }
    return rows.slice(-Math.max(1, limit));
  }

  private appendAudit(row: CapsAuditRow): void {
    try {
      fs.appendFileSync(this.auditPath, JSON.stringify(row) + '\n', { mode: 0o600 });
    } catch {
      // @silent-fallback-ok: the audit append is observability riding a mutation that
      // already landed atomically; a failed append never rolls back money state.
    }
  }
}
