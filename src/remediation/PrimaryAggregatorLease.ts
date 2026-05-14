/**
 * PrimaryAggregatorLease — A47/A60 primary-aggregator lease + failover.
 *
 * Coordinates which machine owns the cross-machine clustering / aggregator
 * role for the Self-Healing Remediator. Replaces the "whoever owns lifeline"
 * heuristic from earlier drafts with an HMAC-signed lease file and a random
 * 128-bit fencing token per A60.
 *
 * On-disk shape (`.instar/remediation/primary-lease.json`, A14 git-synced
 * read-only history):
 *
 *   {
 *     leaderId:        <machineId>,
 *     fencingToken:    <128-bit hex, A60>,
 *     leaseExpiresAt:  <ms epoch>,
 *     acquiredAt:      <ms epoch>,
 *     hmac:            <base64 HMAC over canonical body, A20 audit-v1 leaf>
 *   }
 *
 * Lifecycle:
 *   - `tryAcquire()` reads the current lease; if it is missing, expired, or
 *     belongs to this machine, attempt to claim. Tiebreak when no valid lease
 *     exists uses `sha256(machineId)` lex-min (A47): the candidate with the
 *     lowest hash wins. Higher-hash machines decline with reason 'tiebreak-lost'.
 *   - `renew()` extends `leaseExpiresAt` by `ttlMs`. Renewal fails-closed if
 *     the on-disk fencingToken differs from this instance's last-known token
 *     (someone else replaced our lease — split-brain per A60).
 *   - `readCurrent()` returns the parsed lease for follower routing decisions.
 *   - `verifyFencingToken()` compares an incoming token to the current lease's
 *     token — surfaces consuming the lease (e.g., proposal emission in S-1)
 *     can refuse stale-fenced writes.
 *
 * Split-brain handling (A47, A60):
 *   When `readCurrent()` returns a lease whose fencingToken differs from this
 *   instance's last-renewed token AND the leaderId is this machine, we have
 *   evidence of multi-write. An entry is appended to `audit-anomaly.jsonl`
 *   and the instance enters a fail-closed mode — subsequent `tryAcquire` /
 *   `renew` calls refuse to claim until the operator clears state. This
 *   prevents two primaries from emitting duplicate proposals.
 *
 * Failover signal:
 *   Every observed leader transition (own-claim, foreign-claim, or expiry)
 *   emits `remediation.primary-aggregator.changed` on the instance's
 *   `EventEmitter` interface, carrying `{ previousLeaderId, newLeaderId,
 *   fencingToken, acquiredAt }`. Consumers subscribe to drive the actual
 *   role-switch (which is owned by the follow-up NovelFailureReviewer PR).
 *
 * HMAC scheme:
 *   - Key: `RemediationKeyVault.deriveLeafKey('audit', null)` — the audit-v1
 *     leaf shared machine-wide per A20.
 *   - Body: canonical JSON of `{leaderId, fencingToken, leaseExpiresAt,
 *     acquiredAt}` with fixed key ordering.
 *   - Algo: HMAC-SHA256, 32-byte output, base64-encoded on disk.
 *   Forged lease files (any field tampered with) fail verification and the
 *   reader treats the file as absent — followers fall back to "no current
 *   leader, try to claim".
 *
 * Spec anchors: A14, A20, A47, A56, A57 (Tier-3), A60.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import type { RemediationKeyVault } from './RemediationKeyVault.js';

// ── Public types ─────────────────────────────────────────────────────

export interface LeaseState {
  /** Machine that currently holds the lease. */
  leaderId: string;
  /** 128-bit random per-lease fencing token, hex-encoded (A60). */
  fencingToken: string;
  /** ms-epoch when the lease expires. */
  leaseExpiresAt: number;
  /** ms-epoch when the lease was first acquired (NOT the last renew). */
  acquiredAt: number;
  /** HMAC over the canonical body (A20 audit-v1 leaf). */
  hmac: Buffer;
}

export interface PrimaryAggregatorChangedEvent {
  /** Previous leader machineId, or `null` on cold-boot. */
  previousLeaderId: string | null;
  /** New leader machineId. */
  newLeaderId: string;
  /** Fencing token of the new lease. */
  fencingToken: string;
  /** ms-epoch when the new lease was acquired. */
  acquiredAt: number;
}

export interface PrimaryAggregatorLeaseOptions {
  /** Agent state dir (`.instar`). */
  stateDir: string;
  /** This machine's id. */
  machineId: string;
  /** Key vault, for the audit-v1 leaf (HMAC signing). */
  keyVault: RemediationKeyVault;
  /** Lease TTL in ms. Default 15 min per A47. */
  ttlMs?: number;
  /** Recommended renew interval. Default 5 min per A47. Informational; the caller drives the timer. */
  renewIntervalMs?: number;
  /** Time source override for tests. */
  now?: () => number;
}

export type PrimaryAggregatorLeaseEvent =
  | 'remediation.primary-aggregator.changed';

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 15 * 60 * 1000;       // 15 minutes (A47)
const DEFAULT_RENEW_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (A47)
const FENCING_TOKEN_BYTES = 16;              // 128-bit (A60)
const LEASE_FILENAME = 'primary-lease.json';
const ANOMALY_FILENAME = 'audit-anomaly.jsonl';
const REMEDIATION_DIR = 'remediation';

const HMAC_ALGO = 'sha256';

// ── Errors ───────────────────────────────────────────────────────────

export class PrimaryAggregatorLeaseError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'PrimaryAggregatorLeaseError';
  }
}

// ── Implementation ───────────────────────────────────────────────────

interface OnDiskLease {
  leaderId: string;
  fencingToken: string;
  leaseExpiresAt: number;
  acquiredAt: number;
  hmac: string; // base64
}

/**
 * Build the canonical body bytes for HMAC over a lease. Keys are emitted in
 * a fixed order so the HMAC is reproducible across machines / versions.
 */
function canonicalBody(parts: {
  leaderId: string;
  fencingToken: string;
  leaseExpiresAt: number;
  acquiredAt: number;
}): Buffer {
  // Fixed-order JSON; do NOT use object literal insertion order alone, which
  // is engine-defined for some key shapes. Explicit ordering is the contract.
  const ordered = {
    leaderId: parts.leaderId,
    fencingToken: parts.fencingToken,
    leaseExpiresAt: parts.leaseExpiresAt,
    acquiredAt: parts.acquiredAt,
  };
  return Buffer.from(JSON.stringify(ordered), 'utf-8');
}

/**
 * Deterministic tiebreak (A47): lower sha256(machineId) hex wins.
 * Returns true iff `mine` should beat `theirs`.
 */
function tiebreakWins(mine: string, theirs: string): boolean {
  if (mine === theirs) return false;
  const a = crypto.createHash('sha256').update(mine, 'utf-8').digest('hex');
  const b = crypto.createHash('sha256').update(theirs, 'utf-8').digest('hex');
  return a < b;
}

export class PrimaryAggregatorLease extends EventEmitter {
  private readonly stateDir: string;
  private readonly machineId: string;
  private readonly keyVault: RemediationKeyVault;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private readonly now: () => number;
  private readonly leasePath: string;
  private readonly anomalyPath: string;

  /**
   * Last fencing token this instance wrote (acquire or renew). Used to detect
   * split-brain: if the on-disk lease still claims us as leader but the token
   * doesn't match, someone else replaced our lease.
   */
  private lastIssuedFencingToken: string | null = null;

  /**
   * Last leaderId we observed (across reads + writes). Drives the
   * `remediation.primary-aggregator.changed` event — we only emit on
   * transitions, not on every read.
   */
  private lastObservedLeaderId: string | null = null;

  /**
   * Set when split-brain has been detected. Once tripped, this instance
   * refuses to claim / renew until the file is cleared by an operator
   * (per A47's "fail-closed (stop trying to claim leader role)").
   */
  private splitBrainTripped = false;

  constructor(opts: PrimaryAggregatorLeaseOptions) {
    super();
    this.stateDir = opts.stateDir;
    this.machineId = opts.machineId;
    this.keyVault = opts.keyVault;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.renewIntervalMs = opts.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS;
    this.now = opts.now ?? (() => Date.now());

    const dir = path.join(this.stateDir, REMEDIATION_DIR);
    fs.mkdirSync(dir, { recursive: true });
    this.leasePath = path.join(dir, LEASE_FILENAME);
    this.anomalyPath = path.join(dir, ANOMALY_FILENAME);
  }

  /** Recommended renew cadence (for callers that drive their own timer). */
  getRenewIntervalMs(): number {
    return this.renewIntervalMs;
  }

  /** True iff split-brain has been detected and this instance is fail-closed. */
  isSplitBrainTripped(): boolean {
    return this.splitBrainTripped;
  }

  /**
   * Attempt to acquire the lease. Returns the current leader's state.
   *
   *   - If a valid lease is held by another machine → declined (`acquired:false`).
   *   - If no valid lease exists → run tiebreak; the lex-min hash wins (A47).
   *     The other candidate must also call `tryAcquire` and will lose.
   *   - If the current valid lease is ours, this is a no-op success
   *     (returns the existing lease unchanged). Use `renew()` to extend it.
   *   - If split-brain has been tripped, refuse with `reason:'split-brain'`.
   */
  async tryAcquire(): Promise<{ acquired: boolean; leader: LeaseState; reason?: string }> {
    if (this.splitBrainTripped) {
      const current = await this.readCurrent();
      // Synthesize an empty-leader state when even read fails; callers should
      // not interpret the leader fields when reason='split-brain'.
      const leader = current ?? this.syntheticEmptyLease();
      return { acquired: false, leader, reason: 'split-brain' };
    }

    const current = await this.readCurrent();
    const now = this.now();

    // Case 1: valid lease held by another machine.
    if (current && current.leaderId !== this.machineId && current.leaseExpiresAt > now) {
      this.observeTransition(current);
      return { acquired: false, leader: current, reason: 'held-by-other' };
    }

    // Case 2: valid lease already ours. No-op success (use renew to extend).
    if (current && current.leaderId === this.machineId && current.leaseExpiresAt > now) {
      // Verify the on-disk fencingToken matches what we issued. If it doesn't,
      // someone else stole + re-wrote claiming to be us → split brain.
      if (this.lastIssuedFencingToken !== null && current.fencingToken !== this.lastIssuedFencingToken) {
        this.tripSplitBrain('tryAcquire', current);
        return { acquired: false, leader: current, reason: 'split-brain' };
      }
      this.lastIssuedFencingToken = current.fencingToken;
      this.observeTransition(current);
      return { acquired: true, leader: current };
    }

    // Case 3: no valid lease — try to claim.
    //
    // Tiebreak (A47): if the on-disk lease names a different machine (even
    // though expired), we still defer to the lower-hash machine. This is the
    // "two simultaneous claims" deterministic resolution: both machines see
    // the same expired/empty state, run sha256, and only the lex-min one
    // writes. The other declines with 'tiebreak-lost'.
    if (current && current.leaderId !== this.machineId && !tiebreakWins(this.machineId, current.leaderId)) {
      // Other machine's hash is lower — let them claim.
      this.observeTransition(current);
      return { acquired: false, leader: current, reason: 'tiebreak-lost' };
    }

    // Claim it.
    const fencingToken = crypto.randomBytes(FENCING_TOKEN_BYTES).toString('hex');
    const acquiredAt = now;
    const leaseExpiresAt = now + this.ttlMs;
    const lease = this.signLease({
      leaderId: this.machineId,
      fencingToken,
      leaseExpiresAt,
      acquiredAt,
    });
    this.writeLeaseAtomic(lease);
    this.lastIssuedFencingToken = fencingToken;
    this.observeTransition(lease);
    return { acquired: true, leader: lease };
  }

  /**
   * Renew the lease. Called by the leader every `renewIntervalMs`.
   *
   *   - If the on-disk lease is missing, expired, or held by another machine
   *     → renew fails (`renewed: false`).
   *   - If the on-disk lease names us but the fencingToken differs from the
   *     one we last wrote → split-brain. Trip fail-closed mode (A47/A60).
   *   - On success, write a new lease record with `leaseExpiresAt = now + ttlMs`.
   *     `acquiredAt` is preserved from the original acquisition. `fencingToken`
   *     is preserved (renewal is NOT a new lease; only `tryAcquire` mints
   *     fresh tokens).
   */
  async renew(): Promise<{ renewed: boolean }> {
    if (this.splitBrainTripped) {
      return { renewed: false };
    }
    const current = await this.readCurrent();
    if (!current) return { renewed: false };
    if (current.leaderId !== this.machineId) return { renewed: false };
    const now = this.now();
    if (current.leaseExpiresAt <= now) return { renewed: false };

    if (this.lastIssuedFencingToken === null) {
      // We don't have a recorded token but the file says we're leader —
      // could be a process restart mid-lease. Treat the on-disk token as
      // our own only if we can't prove otherwise. We adopt it on renew but
      // emit nothing extra; if it later disagrees with subsequent writes
      // we'll catch the split-brain.
      this.lastIssuedFencingToken = current.fencingToken;
    } else if (current.fencingToken !== this.lastIssuedFencingToken) {
      // The lease still names us but the token has been rewritten —
      // someone else replaced our lease. Fail-closed.
      this.tripSplitBrain('renew', current);
      return { renewed: false };
    }

    const extended = this.signLease({
      leaderId: current.leaderId,
      fencingToken: current.fencingToken,
      leaseExpiresAt: now + this.ttlMs,
      acquiredAt: current.acquiredAt,
    });
    this.writeLeaseAtomic(extended);
    this.observeTransition(extended);
    return { renewed: true };
  }

  /**
   * Read the current lease. Returns `null` if no valid lease exists (file
   * missing, corrupt, or HMAC verification fails). Followers use this to
   * route reads to the current primary aggregator.
   */
  async readCurrent(): Promise<LeaseState | null> {
    if (!fs.existsSync(this.leasePath)) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(this.leasePath, 'utf-8');
    } catch {
      return null;
    }
    let parsed: OnDiskLease;
    try {
      parsed = JSON.parse(raw) as OnDiskLease;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    if (
      typeof parsed.leaderId !== 'string' ||
      typeof parsed.fencingToken !== 'string' ||
      typeof parsed.leaseExpiresAt !== 'number' ||
      typeof parsed.acquiredAt !== 'number' ||
      typeof parsed.hmac !== 'string'
    ) {
      return null;
    }
    const expected = this.computeHmac({
      leaderId: parsed.leaderId,
      fencingToken: parsed.fencingToken,
      leaseExpiresAt: parsed.leaseExpiresAt,
      acquiredAt: parsed.acquiredAt,
    });
    const actual = Buffer.from(parsed.hmac, 'base64');
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      // Forged lease — pretend there's no lease at all so we don't trust it.
      // Don't emit an event; this could be a downgrade attack or a corrupt
      // sync write. The caller's next `tryAcquire` will re-establish.
      return null;
    }
    return {
      leaderId: parsed.leaderId,
      fencingToken: parsed.fencingToken,
      leaseExpiresAt: parsed.leaseExpiresAt,
      acquiredAt: parsed.acquiredAt,
      hmac: actual,
    };
  }

  /**
   * Verify a presented fencing token matches the current valid lease. Used by
   * proposal emitters and cluster-counter writers to refuse work signed by a
   * stale primary after failover (A60's proposal-identity dedupe relies on
   * this check at write-time).
   *
   * Returns false if the lease is missing, expired, or the token does not
   * match. Constant-time string compare to avoid timing leaks.
   */
  async verifyFencingToken(token: string): Promise<boolean> {
    const current = await this.readCurrent();
    if (!current) return false;
    if (current.leaseExpiresAt <= this.now()) return false;
    if (token.length !== current.fencingToken.length) return false;
    const a = Buffer.from(token, 'utf-8');
    const b = Buffer.from(current.fencingToken, 'utf-8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  // ── Internals ──────────────────────────────────────────────────────

  private computeHmac(parts: {
    leaderId: string;
    fencingToken: string;
    leaseExpiresAt: number;
    acquiredAt: number;
  }): Buffer {
    const key = this.keyVault.deriveLeafKey('audit', null);
    try {
      const h = crypto.createHmac(HMAC_ALGO, key);
      h.update(canonicalBody(parts));
      return h.digest();
    } finally {
      // Best-effort zero. The Buffer returned by deriveLeafKey is a copy.
      key.fill(0);
    }
  }

  private signLease(parts: {
    leaderId: string;
    fencingToken: string;
    leaseExpiresAt: number;
    acquiredAt: number;
  }): LeaseState {
    const hmac = this.computeHmac(parts);
    return { ...parts, hmac };
  }

  private writeLeaseAtomic(lease: LeaseState): void {
    const payload: OnDiskLease = {
      leaderId: lease.leaderId,
      fencingToken: lease.fencingToken,
      leaseExpiresAt: lease.leaseExpiresAt,
      acquiredAt: lease.acquiredAt,
      hmac: lease.hmac.toString('base64'),
    };
    const tmp = `${this.leasePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.leasePath);
  }

  private observeTransition(lease: LeaseState): void {
    const prev = this.lastObservedLeaderId;
    if (prev !== lease.leaderId) {
      this.lastObservedLeaderId = lease.leaderId;
      // EventEmitter swallows listener throws by default; we still want the
      // event delivered even if a downstream subscriber raises.
      const evt: PrimaryAggregatorChangedEvent = {
        previousLeaderId: prev,
        newLeaderId: lease.leaderId,
        fencingToken: lease.fencingToken,
        acquiredAt: lease.acquiredAt,
      };
      this.emit('remediation.primary-aggregator.changed', evt);
    }
  }

  private tripSplitBrain(operation: 'tryAcquire' | 'renew', observed: LeaseState): void {
    this.splitBrainTripped = true;
    const entry = {
      timestamp: new Date(this.now()).toISOString(),
      kind: 'primary-aggregator.split-brain-detected',
      operation,
      machineId: this.machineId,
      observed: {
        leaderId: observed.leaderId,
        fencingToken: observed.fencingToken,
        acquiredAt: observed.acquiredAt,
        leaseExpiresAt: observed.leaseExpiresAt,
      },
      expectedFencingToken: this.lastIssuedFencingToken,
    };
    // Best-effort append; we never throw out of the trip path.
    try {
      const fd = fs.openSync(this.anomalyPath, 'a', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(entry) + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // @silent-fallback-ok — anomaly log is forensic; failing to write must
      // not propagate, since the primary-aggregator path is hot-path-adjacent.
    }
  }

  private syntheticEmptyLease(): LeaseState {
    return {
      leaderId: '',
      fencingToken: '',
      leaseExpiresAt: 0,
      acquiredAt: 0,
      hmac: Buffer.alloc(0),
    };
  }

  /**
   * Test-only / operator helper: clear local split-brain trip state. Does NOT
   * touch the on-disk lease — the operator must reconcile that out of band.
   * Exported for tests and `instar remediation reset-primary-lease`.
   */
  resetSplitBrainTrip(): void {
    this.splitBrainTripped = false;
  }

  /**
   * Test-only helper: forget the locally-tracked fencingToken so the next
   * `tryAcquire` adopts whatever is on disk. Used in tests to simulate a
   * process restart that re-loads existing lease state.
   */
  __forgetIssuedToken(): void {
    this.lastIssuedFencingToken = null;
  }
}

/**
 * Re-exported tiebreak comparator for tests / external consumers that need to
 * predict outcomes (e.g., the dashboard's "who will pick up next?" widget).
 */
export function primaryLeaseTiebreakWins(mine: string, theirs: string): boolean {
  return tiebreakWins(mine, theirs);
}
