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

export interface KeyCapsRecord {
  provider: string;
  lifetimeCapUsd: number;
  dailyCapUsd: number;
  frozen: boolean;
  frozenBy?: string;
  frozenAt?: string;
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
}

export interface CapsAuditRow {
  ts: string;
  action: string;
  actor: string;
  before: CapsStoreFile;
  after: CapsStoreFile;
}

const EMPTY: CapsStoreFile = { version: 0, caps: {}, goLive: {}, leaseEpoch: 0 };

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
    for (const capField of ['lifetimeCapUsd', 'dailyCapUsd'] as const) {
      const v = c[capField];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return `caps['${keyRef}'].${capField} must be ≥ 0`;
    }
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
  return null;
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
  private mutate(action: string, actor: string, expectedVersion: number | null, fn: (f: CapsStoreFile) => void): CapsStoreFile {
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
    fs.writeFileSync(tmp, JSON.stringify(after, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
    this.appendAudit({ ts: new Date(this.now()).toISOString(), action, actor, before, after });
    return after;
  }

  /** PIN path: adjust caps for a key (raise or lower; lowering bumps the lease epoch — A-M9). */
  adjustCaps(actor: string, expectedVersion: number, keyRef: string, provider: string, caps: { lifetimeCapUsd: number; dailyCapUsd: number }): CapsStoreFile {
    return this.mutate('caps-adjust', actor, expectedVersion, (f) => {
      const prev = f.caps[keyRef];
      const lowered =
        prev !== undefined &&
        (caps.lifetimeCapUsd < prev.lifetimeCapUsd || caps.dailyCapUsd < prev.dailyCapUsd);
      f.caps[keyRef] = {
        provider,
        lifetimeCapUsd: caps.lifetimeCapUsd,
        dailyCapUsd: caps.dailyCapUsd,
        frozen: prev?.frozen ?? false,
        ...(prev?.frozenBy ? { frozenBy: prev.frozenBy } : {}),
        ...(prev?.frozenAt ? { frozenAt: prev.frozenAt } : {}),
      };
      if (lowered) f.leaseEpoch += 1; // fenced cap-lowering — the gate re-reads and clamps
    });
  }

  /** PIN path: arm/disarm a door + designate the metered-lease machine (FD-13). */
  setGoLive(actor: string, expectedVersion: number, door: string, rec: { enabled: boolean; keyRef: string; designatedMachineId: string }): CapsStoreFile {
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

  /** PIN path: unfreeze (releasing money is always the operator's). */
  unfreeze(actor: string, expectedVersion: number, keyRef: string): CapsStoreFile {
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
  freeze(actor: string, keyRef: string, defaults?: { provider: string; lifetimeCapUsd: number; dailyCapUsd: number }): CapsStoreFile {
    return this.mutate('freeze', actor, null, (f) => {
      const c = f.caps[keyRef];
      if (c) {
        c.frozen = true;
        c.frozenBy = actor;
        c.frozenAt = new Date(this.now()).toISOString();
      } else {
        f.caps[keyRef] = {
          provider: defaults?.provider ?? 'unknown',
          lifetimeCapUsd: defaults?.lifetimeCapUsd ?? 0,
          dailyCapUsd: defaults?.dailyCapUsd ?? 0,
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
