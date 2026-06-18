/**
 * WS5.2 (ws52-operator-tap-not-text Part B) — DURABLE single-flight ledger for the
 * account-follow-me cross-machine enroll connector.
 *
 * The convergence pass found that the live "single-flight per (account,target)"
 * guarantee was wired as `inFlight: () => new Set()` — a fresh empty set every
 * call, i.e. a NO-OP. A re-delivery, a restart, or a double-tap each spawned a new
 * device-code login. This store is the real, durable, restart-surviving guarantee.
 *
 * It is a small state machine keyed `${accountId}::${targetMachineId}` (R3.1: the
 * CANONICAL pool account id, owned within THIS fronting machine's ledger — the
 * store is per-machine, so the frontingMachineId is recorded for provenance and a
 * different fronting context cannot suppress this one's offers):
 *
 *   (absent) --tryClaim--> enroll-in-flight --markLoginIssued--> login-issued
 *                                |                                    |
 *                                v                                    v
 *                              failed <----markFailed------------ completed
 *
 * `tryClaim` is the single-flight gate: it succeeds ONLY when there is no LIVE
 * in-flight record (absent / completed / failed / a dead-holder whose TTL lapsed).
 * While a pair is `enroll-in-flight` or `login-issued`, a second claim is REFUSED —
 * so a re-delivery/restart/double-tap collapses to one login. A crash mid-enroll is
 * self-healed: a claim past `ttlExpiresAt` reclaims the dead holder (PR-hand-lease
 * pattern). `completed`/`failed` are terminal-but-re-armable: a genuinely fresh
 * delivery can re-claim the pair (a new mandate, after the prior cycle closed).
 *
 * Pure + fs-backed (the DeliveredMandateStore pattern) so both sides of every
 * transition are unit-testable without a server.
 */
import fs from 'node:fs';
import path from 'node:path';

export type SingleFlightState =
  | 'enroll-in-flight'
  | 'login-issued'
  | 'completed'
  | 'failed';

/** The states in which a pair is LIVE — re-claim is refused and the scan must not re-offer. */
const ACTIVE_STATES: ReadonlySet<SingleFlightState> = new Set(['enroll-in-flight', 'login-issued']);

export interface SingleFlightRecord {
  /** `${accountId}::${targetMachineId}` (canonical account id). */
  key: string;
  state: SingleFlightState;
  /** The fronting machine that owns this enroll loop (provenance; this store is per-machine). */
  frontingMachineId: string;
  /** The mandate authorizing this enrollment. */
  mandateId: string;
  /** Opaque holder token (e.g. a process/run id) for dead-holder auto-heal. */
  holder: string;
  updatedAt: string;
  /** While ACTIVE, the wall-clock (ms) past which the holder is presumed dead and the pair is reclaimable. */
  ttlExpiresAt: number;
}

export interface SingleFlightDeps {
  /** Absolute path to the ledger JSON file. */
  filePath: string;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

export function singleFlightKey(accountId: string, targetMachineId: string): string {
  return `${accountId}::${targetMachineId}`;
}

export interface ClaimInput {
  accountId: string;
  targetMachineId: string;
  frontingMachineId: string;
  mandateId: string;
  holder: string;
  /** How long the enroll-in-flight claim is valid before a dead-holder reclaim is allowed. */
  ttlMs: number;
}

export class AccountFollowMeSingleFlight {
  private readonly d: SingleFlightDeps;
  constructor(deps: SingleFlightDeps) {
    this.d = deps;
  }

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private readAll(): SingleFlightRecord[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf8'));
      return Array.isArray(raw) ? (raw as SingleFlightRecord[]) : [];
    } catch {
      // @silent-fallback-ok — no ledger yet; an empty ledger means "nothing in flight" (safe).
      return [];
    }
  }

  private writeAll(records: SingleFlightRecord[]): void {
    fs.mkdirSync(path.dirname(this.d.filePath), { recursive: true });
    fs.writeFileSync(this.d.filePath, JSON.stringify(records, null, 2));
  }

  get(key: string): SingleFlightRecord | undefined {
    return this.readAll().find((r) => r.key === key);
  }

  /** A pair is LIVE (refuse re-claim, suppress scan re-offer) iff it is in an active state AND not past its TTL. */
  isActive(key: string): boolean {
    const r = this.get(key);
    if (!r || !ACTIVE_STATES.has(r.state)) return false;
    return this.now() <= r.ttlExpiresAt; // a lapsed holder is NOT live (reclaimable)
  }

  /**
   * The single-flight gate. Atomically claims (account,target) → `enroll-in-flight`
   * iff no LIVE record exists. Returns `{ claimed:false }` while another enroll is
   * genuinely in flight (the duplicate-login guard). A dead-holder (TTL lapsed) or a
   * terminal record (completed/failed/absent) is re-claimable.
   */
  tryClaim(input: ClaimInput): { claimed: boolean; record: SingleFlightRecord } {
    const key = singleFlightKey(input.accountId, input.targetMachineId);
    const all = this.readAll();
    const existing = all.find((r) => r.key === key);
    const now = this.now();
    const live = existing && ACTIVE_STATES.has(existing.state) && now <= existing.ttlExpiresAt;
    if (live) {
      return { claimed: false, record: existing! };
    }
    const record: SingleFlightRecord = {
      key,
      state: 'enroll-in-flight',
      frontingMachineId: input.frontingMachineId,
      mandateId: input.mandateId,
      holder: input.holder,
      updatedAt: new Date(now).toISOString(),
      ttlExpiresAt: now + Math.max(0, input.ttlMs),
    };
    this.writeAll([...all.filter((r) => r.key !== key), record]);
    return { claimed: true, record };
  }

  /**
   * Move a claimed pair to a new state. Refreshes the TTL for the still-active
   * `login-issued` state (the operator now has a window to tap the link); terminal
   * states clear the TTL window. Refuses to transition a key the caller does not
   * hold (holder mismatch) so a stale actor can't stomp a live claim. No-op if absent.
   */
  transition(
    key: string,
    to: SingleFlightState,
    holder: string,
    opts?: { ttlMs?: number },
  ): { ok: boolean; reason?: string; record?: SingleFlightRecord } {
    const all = this.readAll();
    const idx = all.findIndex((r) => r.key === key);
    if (idx < 0) return { ok: false, reason: 'absent' };
    if (all[idx].holder !== holder) return { ok: false, reason: 'holder-mismatch' };
    const now = this.now();
    const ttlExpiresAt = ACTIVE_STATES.has(to)
      ? now + Math.max(0, opts?.ttlMs ?? 0)
      : 0;
    const next: SingleFlightRecord = {
      ...all[idx],
      state: to,
      updatedAt: new Date(now).toISOString(),
      ttlExpiresAt,
    };
    all[idx] = next;
    this.writeAll(all);
    return { ok: true, record: next };
  }

  /** Drop a record entirely (e.g. on revocation of the pair's mandate). Idempotent. */
  remove(key: string): void {
    const all = this.readAll();
    const next = all.filter((r) => r.key !== key);
    if (next.length !== all.length) this.writeAll(next);
  }

  list(): SingleFlightRecord[] {
    return this.readAll();
  }
}
