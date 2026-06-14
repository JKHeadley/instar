/**
 * JobLeaseClaimStore — WS4.3 durable, epoch-fenced job-claim leases.
 *
 * (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.3, "Cutover discipline".)
 *
 * The journal-backed upgrade of the best-effort `JobClaimManager` bus
 * broadcast. A claim is a LEASE with a fenced ownership epoch: a receiver
 * rejects a stale-epoch claim (invariant-4 epoch fencing), so a demoted
 * machine's late claim cannot steal a job from the current lease-holder, and a
 * partition double-run is structurally prevented when the journal is reachable.
 *
 * Claim records store METADATA ONLY — machine id, job slug, epoch, timestamps —
 * never job payloads (the spec's explicit privacy bound). The store is the
 * local materialized view of the replicated claim kind; the journal carries
 * each record to peers and feeds them back through `applyRemote`.
 *
 * This store does NOT decide WHEN to use the journal path — that is the
 * `JobLeaseCutoverGate`. The store only manages the leases once the gate has
 * selected the journal path.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A durable, epoch-fenced job-claim lease. Metadata only. */
export interface JobLeaseClaim {
  /** Unique claim id (idempotency key). */
  claimId: string;
  /** Job slug being leased. */
  jobSlug: string;
  /** Machine id that holds the lease. */
  machineId: string;
  /** The ownership epoch under which the lease was taken (fencing token). A
   *  claim with an epoch older than the latest seen for the slug is stale. */
  epoch: number;
  /** When the lease was taken (ISO 8601). */
  claimedAt: string;
  /** When the lease expires if no completion arrives (ISO 8601). */
  expiresAt: string;
  /** Whether the job completed under this lease. */
  completed: boolean;
  /** Completion result (set on complete). */
  result?: 'success' | 'failure';
  /** When the job completed (ISO 8601). */
  completedAt?: string;
}

export interface JobLeaseClaimStoreConfig {
  /** This machine's id. */
  machineId: string;
  /** State directory (.instar) for persisting the lease ledger. */
  stateDir: string;
  /** Default lease timeout in ms (default: 30 min). */
  defaultLeaseTimeoutMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

const DEFAULT_LEASE_TIMEOUT_MS = 30 * 60_000;
const CLAIMS_FILE = 'job-lease-claims.json';

/** The verdict of a local claim attempt. */
export type ClaimAttempt =
  | { ok: true; claim: JobLeaseClaim }
  /** Another machine holds a live, non-stale lease on this slug. */
  | { ok: false; reason: 'held-by-peer'; heldBy: string }
  /** We already hold a live lease (idempotent re-claim). */
  | { ok: false; reason: 'already-own'; claim: JobLeaseClaim };

export class JobLeaseClaimStore {
  private machineId: string;
  private claimsDir: string;
  private defaultLeaseTimeoutMs: number;
  private now: () => number;
  private claims: Map<string, JobLeaseClaim> = new Map(); // keyed by jobSlug

  constructor(config: JobLeaseClaimStoreConfig) {
    this.machineId = config.machineId;
    this.defaultLeaseTimeoutMs = config.defaultLeaseTimeoutMs ?? DEFAULT_LEASE_TIMEOUT_MS;
    this.now = config.now ?? (() => Date.now());
    this.claimsDir = path.join(config.stateDir, 'state');
    if (!fs.existsSync(this.claimsDir)) {
      fs.mkdirSync(this.claimsDir, { recursive: true });
    }
    this.load();
  }

  /**
   * Attempt to take a lease on a job at the given ownership epoch.
   *
   * Returns the new lease on success, or a rejection when a peer holds a live,
   * non-stale lease. Idempotent: re-claiming a slug this machine already leases
   * (at the same-or-newer epoch) returns the existing lease.
   */
  tryClaim(jobSlug: string, epoch: number, timeoutMs?: number): ClaimAttempt {
    this.pruneExpired();
    const existing = this.claims.get(jobSlug);

    if (existing && !existing.completed && !this.isExpired(existing)) {
      if (existing.machineId === this.machineId) {
        return { ok: false, reason: 'already-own', claim: existing };
      }
      // A peer holds a live lease. We may only supersede it with a STRICTLY
      // newer epoch (the peer was demoted; our epoch advanced). A same/older
      // epoch is fenced out — never steal from a current lease-holder.
      if (epoch <= existing.epoch) {
        return { ok: false, reason: 'held-by-peer', heldBy: existing.machineId };
      }
    }

    const claim: JobLeaseClaim = {
      claimId: `lease_${crypto.randomBytes(8).toString('hex')}`,
      jobSlug,
      machineId: this.machineId,
      epoch,
      claimedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + (timeoutMs ?? this.defaultLeaseTimeoutMs)).toISOString(),
      completed: false,
    };
    this.claims.set(jobSlug, claim);
    this.save();
    return { ok: true, claim };
  }

  /** Mark our lease on a slug complete (releases it for the next tick). */
  completeClaim(jobSlug: string, result: 'success' | 'failure'): void {
    const claim = this.claims.get(jobSlug);
    if (!claim || claim.machineId !== this.machineId) return;
    claim.completed = true;
    claim.result = result;
    claim.completedAt = new Date(this.now()).toISOString();
    this.save();
  }

  /**
   * Apply a claim record received from a peer over the journal. Epoch fencing:
   * a record whose epoch is OLDER than the one we already hold for the slug is
   * rejected (returns false) — a demoted machine's stale claim never overwrites
   * a fresher lease. Returns true if the record was applied.
   */
  applyRemote(record: JobLeaseClaim): boolean {
    // Never let a remote record masquerade as our own machine's authority.
    if (record.machineId === this.machineId) return false;
    const existing = this.claims.get(record.jobSlug);
    if (existing && !existing.completed && !this.isExpired(existing)) {
      // Strict epoch fence — equal epoch keeps the incumbent (first-writer-wins
      // is resolved upstream by the journal's ordering; we never flip on a tie).
      if (record.epoch <= existing.epoch) return false;
    }
    this.claims.set(record.jobSlug, { ...record });
    this.save();
    return true;
  }

  /** True if a peer holds a live, non-stale lease on the slug. */
  hasRemoteClaim(jobSlug: string): boolean {
    this.pruneExpired();
    const claim = this.claims.get(jobSlug);
    if (!claim || claim.completed || claim.machineId === this.machineId) return false;
    return !this.isExpired(claim);
  }

  getClaim(jobSlug: string): JobLeaseClaim | undefined {
    this.pruneExpired();
    return this.claims.get(jobSlug);
  }

  getActiveClaims(): JobLeaseClaim[] {
    this.pruneExpired();
    return Array.from(this.claims.values()).filter((c) => !c.completed);
  }

  getAllClaims(): JobLeaseClaim[] {
    return Array.from(this.claims.values());
  }

  /** Remove expired (uncompleted past expiry) + old completed records. */
  pruneExpired(): number {
    const now = this.now();
    let pruned = 0;
    for (const [slug, claim] of this.claims) {
      if (claim.completed) {
        const completedAt = claim.completedAt ? new Date(claim.completedAt).getTime() : now;
        if (now - completedAt > 60 * 60_000) {
          this.claims.delete(slug);
          pruned++;
        }
      } else if (this.isExpired(claim)) {
        this.claims.delete(slug);
        pruned++;
      }
    }
    if (pruned > 0) this.save();
    return pruned;
  }

  private isExpired(claim: JobLeaseClaim): boolean {
    return this.now() > new Date(claim.expiresAt).getTime();
  }

  private load(): void {
    try {
      const data = JSON.parse(
        fs.readFileSync(path.join(this.claimsDir, CLAIMS_FILE), 'utf-8'),
      ) as JobLeaseClaim[];
      this.claims.clear();
      for (const c of data) this.claims.set(c.jobSlug, c);
    } catch {
      /* @silent-fallback-ok — no ledger yet; start empty */
    }
  }

  private save(): void {
    fs.writeFileSync(
      path.join(this.claimsDir, CLAIMS_FILE),
      JSON.stringify(Array.from(this.claims.values()), null, 2) + '\n',
    );
  }
}
