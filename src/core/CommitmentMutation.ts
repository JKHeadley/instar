/**
 * CommitmentMutation — P1.5b of multi-machine coherence: owner-routed
 * mutation. "Mark it delivered" works from ANY machine: a non-owner forwards
 * ONE signed `commitment-mutate` to the owner, which applies it through
 * verdict-bearing wrappers around the unchanged CommitmentTracker state
 * machine; an unreachable owner gets a durable pending-mutation that
 * re-issues a FRESH envelope on the owner's return.
 *
 * Spec: docs/specs/COMMITMENTS-COHERENCE-SPEC.md §3.4.
 *
 * Load-bearing rules:
 *  - VERDICT-BEARING wrappers (round-1: the tracker's null-on-terminal
 *    collapses "already delivered" and "not found" — outcomes the caller
 *    must distinguish): applied | idempotent-noop | invalid-transition |
 *    not-found.
 *  - opKey idempotency, DURABLE ON THE OWNER (the envelope nonce window is
 *    only 60s — this window is the replay control; it survives restarts;
 *    a replayed/re-fired mutate returns the recorded verdict, applies
 *    nothing). Written AFTER the store write; a crash between resolves as
 *    idempotent-noop on the re-fire.
 *  - The queue stores INTENT, never a signed envelope: at fire time the
 *    forwarder re-issues a FRESH signed command, so the owner always
 *    evaluates a live, fully-verified envelope (no stale-timestamp paradox;
 *    the durable queue is never an unauthenticated apply surface).
 *  - Bounds: maxPendingOpsPerCommitment (4) per (origin,id);
 *    maxPendingOpsPerOwner (64) — one peer cannot stage an unbounded
 *    transition batch.
 *  - verifyEnvelope is the SOLE authority for the verb (its RBAC case
 *    admits any registered peer by design); the owner's state machine
 *    re-validates every transition — mesh adds reach, not authority.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { Commitment, CommitmentTracker } from '../monitoring/CommitmentTracker.js';

export const DEFAULT_OPKEY_TTL_DAYS = 7;
export const DEFAULT_MAX_PENDING_PER_COMMITMENT = 4;
export const DEFAULT_MAX_PENDING_PER_OWNER = 64;
export const DEFAULT_PENDING_MUTATION_TTL_DAYS = 7;

export type CommitmentMutateOp = 'deliver' | 'withdraw' | 'resume' | 'patch-beacon';

export type MutateVerdict =
  | 'applied'
  | 'idempotent-noop'
  | 'invalid-transition'
  | 'not-found';

export interface CommitmentMutatePayload {
  /** Composite identity (§3.1) — a bare id NEVER routes across machines. */
  origin: string;
  id: string;
  op: CommitmentMutateOp;
  args?: Record<string, unknown>;
  /** Caller-generated idempotency key (crypto.randomUUID). */
  opKey: string;
  requestedAt: string;
  callerMachineId: string;
  /** The status the caller observed (stale-view annotation, §3.4). */
  observedStatus?: string;
}

export interface MutateOutcome {
  verdict: MutateVerdict;
  /** Set when the caller acted on a stale view (observedStatus mismatch). */
  staleObservation?: boolean;
  status?: string;
}

// ── Verdict-bearing owner-side apply (§3.4) ─────────────────────────

const TERMINAL = new Set(['verified', 'violated', 'expired', 'withdrawn', 'delivered']);

/**
 * Apply one op through the UNCHANGED tracker state machine, returning a
 * DISTINCT verdict. The tracker's own methods stay byte-identical — this
 * wrapper only disambiguates outcomes they collapse.
 */
export async function applyOwnerMutation(
  tracker: CommitmentTracker,
  payload: CommitmentMutatePayload,
): Promise<MutateOutcome> {
  const existing = tracker.getAll().find((c) => c.id === payload.id);
  if (!existing) return { verdict: 'not-found' };
  const stale = payload.observedStatus !== undefined && payload.observedStatus !== existing.status;

  switch (payload.op) {
    case 'deliver': {
      if (existing.status === 'delivered') {
        return { verdict: 'idempotent-noop', status: existing.status, ...(stale ? { staleObservation: true } : {}) };
      }
      if (TERMINAL.has(existing.status)) {
        return { verdict: 'invalid-transition', status: existing.status, ...(stale ? { staleObservation: true } : {}) };
      }
      const r = tracker.deliver(payload.id, typeof payload.args?.deliveryMessageId === 'string' ? payload.args.deliveryMessageId : undefined);
      return r
        ? { verdict: 'applied', status: r.status, ...(stale ? { staleObservation: true } : {}) }
        : { verdict: 'invalid-transition', status: existing.status };
    }
    case 'withdraw': {
      if (existing.status === 'withdrawn') {
        return { verdict: 'idempotent-noop', status: existing.status, ...(stale ? { staleObservation: true } : {}) };
      }
      if (TERMINAL.has(existing.status)) {
        return { verdict: 'invalid-transition', status: existing.status, ...(stale ? { staleObservation: true } : {}) };
      }
      const ok = tracker.withdraw(payload.id, typeof payload.args?.reason === 'string' ? payload.args.reason : 'owner-routed withdraw');
      return ok
        ? { verdict: 'applied', status: 'withdrawn', ...(stale ? { staleObservation: true } : {}) }
        : { verdict: 'invalid-transition', status: existing.status };
    }
    case 'resume': {
      if (existing.status === 'pending') {
        return { verdict: 'idempotent-noop', status: existing.status, ...(stale ? { staleObservation: true } : {}) };
      }
      const r = tracker.resume(payload.id);
      return r
        ? { verdict: 'applied', status: r.status, ...(stale ? { staleObservation: true } : {}) }
        : { verdict: 'invalid-transition', status: existing.status };
    }
    case 'patch-beacon': {
      const allowed = new Set(['beaconEnabled', 'cadenceMs', 'nextUpdateDueAt', 'softDeadlineAt', 'hardDeadlineAt']);
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload.args ?? {})) {
        if (allowed.has(k)) patch[k] = v;
      }
      if (!Object.keys(patch).length) return { verdict: 'idempotent-noop', status: existing.status };
      const r = await tracker.mutate(payload.id, (c) => ({ ...c, ...patch } as Commitment));
      return { verdict: 'applied', status: r.status, ...(stale ? { staleObservation: true } : {}) };
    }
    default:
      return { verdict: 'invalid-transition', status: existing.status };
  }
}

// ── The durable opKey window (owner side, §3.4) ─────────────────────

interface OpKeyFileShape {
  version: 1;
  /** opKey → { verdict, status, at } */
  seen: Record<string, { verdict: MutateVerdict; status?: string; at: string }>;
}

/**
 * Bounded durable replay window: applied opKeys persist with their verdict
 * (TTL ≥ the pending-mutation TTL); a replay returns the recorded verdict
 * and applies NOTHING. Single-writer (only the verb handler), atomic
 * temp+rename, corrupt → quarantine + fresh (worst case one idempotent
 * re-apply through the CAS).
 */
export class OpKeyWindow {
  private readonly file: string;
  private readonly ttlMs: number;
  private readonly now: () => Date;
  private data: OpKeyFileShape | null = null;

  constructor(config: { stateDir: string; ttlDays?: number; now?: () => Date }) {
    this.file = path.join(config.stateDir, 'state', 'coherence-journal', 'commitment-opkeys.json');
    this.ttlMs = (config.ttlDays ?? DEFAULT_OPKEY_TTL_DAYS) * 24 * 60 * 60 * 1000;
    this.now = config.now ?? (() => new Date());
  }

  /** The recorded verdict for a replayed opKey, or null when unseen. */
  check(opKey: string): MutateOutcome | null {
    const d = this.load();
    const rec = d.seen[opKey];
    if (!rec) return null;
    return { verdict: rec.verdict, ...(rec.status ? { status: rec.status } : {}) };
  }

  /** Record an outcome AFTER the store write (§4.5 ordering). */
  record(opKey: string, outcome: MutateOutcome): void {
    const d = this.load();
    const nowMs = this.now().getTime();
    // TTL sweep inline (bounded by entries; runs on every record).
    for (const [k, v] of Object.entries(d.seen)) {
      if (nowMs - new Date(v.at).getTime() > this.ttlMs) delete d.seen[k];
    }
    d.seen[opKey] = { verdict: outcome.verdict, ...(outcome.status ? { status: outcome.status } : {}), at: this.now().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, this.file);
  }

  private load(): OpKeyFileShape {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as OpKeyFileShape;
      if (parsed?.version === 1 && parsed.seen && typeof parsed.seen === 'object') {
        this.data = parsed;
        return parsed;
      }
      throw new Error('shape');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${this.now().getTime()}`);
        } catch { /* @silent-fallback-ok: quarantine rename best-effort; a lost window worst-cases one idempotent re-apply through the CAS (COMMITMENTS-COHERENCE-SPEC §3.4) */
        }
      }
      this.data = { version: 1, seen: {} };
      return this.data;
    }
  }
}

// ── The durable pending-mutation queue (forwarder side, §3.4 rule 3) ─

export interface PendingMutationRecord {
  payload: CommitmentMutatePayload;
  createdAt: string;
  attempts: number;
  lastAttemptAt: string | null;
}

interface PendingFileShape {
  version: 1;
  records: PendingMutationRecord[];
}

/**
 * The P2 PendingPullLedger pattern verbatim: serialized mutate() funnel
 * (single-writer — the six-mutators lesson), corrupt-quarantine (never
 * silently empty), TTL with one honest expiry notice, per-(origin,id) and
 * per-owner enqueue bounds. Stores INTENT only; the re-fire issues a FRESH
 * signed envelope.
 */
export class PendingMutationLedger {
  private readonly file: string;
  private readonly ttlMs: number;
  private readonly maxPerCommitment: number;
  private readonly maxPerOwner: number;
  private readonly now: () => Date;
  private readonly onCorrupt?: (qPath: string) => void;
  private readonly onExpired?: (rec: PendingMutationRecord) => void;
  private readonly logger: (msg: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private records: PendingMutationRecord[] | null = null;
  private corruptNotified = false;

  constructor(config: {
    stateDir: string;
    ttlDays?: number;
    maxPerCommitment?: number;
    maxPerOwner?: number;
    now?: () => Date;
    onCorrupt?: (qPath: string) => void;
    onExpired?: (rec: PendingMutationRecord) => void;
    logger?: (msg: string) => void;
  }) {
    this.file = path.join(config.stateDir, 'state', 'commitment-replicas', 'pending-mutations.json');
    this.ttlMs = (config.ttlDays ?? DEFAULT_PENDING_MUTATION_TTL_DAYS) * 24 * 60 * 60 * 1000;
    this.maxPerCommitment = config.maxPerCommitment ?? DEFAULT_MAX_PENDING_PER_COMMITMENT;
    this.maxPerOwner = config.maxPerOwner ?? DEFAULT_MAX_PENDING_PER_OWNER;
    this.now = config.now ?? (() => new Date());
    this.onCorrupt = config.onCorrupt;
    this.onExpired = config.onExpired;
    this.logger = config.logger ?? (() => {});
  }

  /**
   * Queue an intent. Idempotent on opKey; refused ('bounded') past the
   * per-(origin,id) or per-owner caps.
   */
  async enqueue(payload: CommitmentMutatePayload): Promise<'queued' | 'duplicate' | 'bounded'> {
    let outcome: 'queued' | 'duplicate' | 'bounded' = 'queued';
    await this.mutate((records) => {
      if (records.some((r) => r.payload.opKey === payload.opKey)) {
        outcome = 'duplicate';
        return records;
      }
      const perCommitment = records.filter(
        (r) => r.payload.origin === payload.origin && r.payload.id === payload.id,
      ).length;
      const perOwner = records.filter((r) => r.payload.origin === payload.origin).length;
      if (perCommitment >= this.maxPerCommitment || perOwner >= this.maxPerOwner) {
        outcome = 'bounded';
        return records;
      }
      records.push({ payload, createdAt: this.now().toISOString(), attempts: 0, lastAttemptAt: null });
      return records;
    });
    return outcome;
  }

  /** Pending intents for a returning owner, oldest-first (drain order). */
  async pendingForOwner(origin: string): Promise<PendingMutationRecord[]> {
    const records = await this.read();
    return records
      .filter((r) => r.payload.origin === origin)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** A resolved intent (any verdict) clears its record. */
  async clear(opKey: string): Promise<void> {
    await this.mutate((records) => records.filter((r) => r.payload.opKey !== opKey));
  }

  async recordAttempt(opKey: string): Promise<void> {
    await this.mutate((records) => {
      const r = records.find((x) => x.payload.opKey === opKey);
      if (r) {
        r.attempts += 1;
        r.lastAttemptAt = this.now().toISOString();
      }
      return records;
    });
  }

  /** TTL sweep — each expiry surfaced ONCE via onExpired, then removed. */
  async sweepExpired(): Promise<PendingMutationRecord[]> {
    const expired: PendingMutationRecord[] = [];
    await this.mutate((records) => {
      const nowMs = this.now().getTime();
      const kept: PendingMutationRecord[] = [];
      for (const r of records) {
        if (nowMs - new Date(r.createdAt).getTime() > this.ttlMs) expired.push(r);
        else kept.push(r);
      }
      for (const r of expired) {
        try {
          this.onExpired?.(r);
        } catch { /* @silent-fallback-ok: an expiry-notice consumer failure must never block the sweep (COMMITMENTS-COHERENCE-SPEC §4.2) */
        }
      }
      return kept;
    });
    return expired;
  }

  /** Composite keys with in-flight intents — the merge layer's join (§3.3). */
  async pendingKeys(): Promise<Set<string>> {
    const records = await this.read();
    return new Set(records.map((r) => `${r.payload.origin}::${r.payload.id}`));
  }

  // ── the serialized funnel ──
  private mutate(fn: (records: PendingMutationRecord[]) => PendingMutationRecord[]): Promise<PendingMutationRecord[]> {
    const run = this.queue.then(() => {
      const before = this.readUnqueued();
      const next = fn(before);
      this.persist(next);
      this.records = next;
      return next;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private read(): Promise<PendingMutationRecord[]> {
    const run = this.queue.then(() => this.readUnqueued());
    this.queue = run.catch(() => {});
    return run;
  }

  private readUnqueued(): PendingMutationRecord[] {
    if (this.records) return this.records;
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch { /* @silent-fallback-ok: absent ledger = genuinely empty (first boot) — distinct from corrupt, which quarantines below (COMMITMENTS-COHERENCE-SPEC §3.4) */
      this.records = [];
      return this.records;
    }
    try {
      const parsed = JSON.parse(raw) as PendingFileShape;
      if (parsed?.version !== 1 || !Array.isArray(parsed.records)) throw new Error('shape');
      this.records = parsed.records.filter((r) => r?.payload?.opKey && r.payload.origin && r.payload.id);
      return this.records;
    } catch {
      const q = `${this.file}.corrupt-${this.now().getTime()}`;
      try {
        fs.renameSync(this.file, q);
      } catch { /* @silent-fallback-ok: quarantine rename can lose a race; the notice below still fires once (COMMITMENTS-COHERENCE-SPEC §3.4) */
      }
      this.logger('pending-mutations ledger unreadable — quarantined; queued closes may be lost');
      if (!this.corruptNotified) {
        this.corruptNotified = true;
        try {
          this.onCorrupt?.(q);
        } catch { /* @silent-fallback-ok: a corrupt-notice consumer failure must never block ledger recovery (COMMITMENTS-COHERENCE-SPEC §3.4) */
        }
      }
      this.records = [];
      return this.records;
    }
  }

  private persist(records: PendingMutationRecord[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, records } satisfies PendingFileShape, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
