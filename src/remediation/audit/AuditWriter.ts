/**
 * AuditWriter — Central audit-log append path for the Remediator.
 *
 * Part of Foundation F-4 (SELF-HEALING-REMEDIATOR-V2-SPEC §A12 / §A29 / §A42).
 *
 * Every audit append carries an HMAC `auditToken` that the writer verifies
 * via the caller-injected `tokenVerifier`. Forged entries (bad token) route
 * to `audit-rejected.jsonl` for forensic review (A12 / A27). Stale-watermark
 * entries (declared timestamp older than the persisted per-surface
 * high-watermark, A42) are also rejected.
 *
 * Files (per A14):
 *   - <stateDir>/remediation/audit-projection-<machineId>.jsonl  (accepted)
 *   - <stateDir>/remediation/audit-rejected.jsonl                (rejected)
 *
 * In-memory tail (A29): the writer keeps the last 1,000 accepted entries in
 * memory for hot-path reads by the churn detector and projection consumers.
 */

import fs from 'node:fs';
import path from 'node:path';

export type AuditOutcome =
  | 'started'
  | 'verified-healthy'
  | 'verify-failed'
  | 'verify-inconclusive'
  | 'aborted-deadline'
  | 'no-matching-runbook'
  | 'covered-by-inline';

export interface AuditEntry {
  entryId: string;
  attemptId: string;
  outcome: AuditOutcome;
  runbookId?: string;
  subsystem: string;
  reason?: { redacted: string; full?: string };
  /**
   * Canonical errorCode of the event (when known). Populated by the
   * Remediator's append path so consumers like NovelFailureReviewer
   * (§A10, §A26, Tier-3 S-1) can cluster `no-matching-runbook` rows by
   * subsystem + errorCode without re-extracting from `reason.redacted`.
   * Optional for backwards compatibility with existing rows.
   */
  errorCode?: string;
  /** Wall-clock ms epoch. */
  timestamp: number;
  /** process.hrtime.bigint() at write-side declaration. */
  monotonicTs: bigint;
  /** HMAC audit-token; verified before persistence. */
  auditToken: Buffer;
}

export interface AuditWriterOptions {
  /**
   * Verifies the `auditToken` against the entry payload (A12 / A42). The
   * concrete implementation lives in F-1 (RemediationKeyVault); F-4 tests
   * inject a mock.
   */
  tokenVerifier: (entry: AuditEntry) => boolean;
  /** Machine id — disambiguates the projection file. */
  machineId: string;
  /** Size of in-memory tail. Defaults to 1000 (A29). */
  tailSize?: number;
}

export interface AppendResult {
  accepted: boolean;
  rejectedReason?: string;
}

const DEFAULT_TAIL_SIZE = 1000;

export class AuditWriter {
  private readonly projectionPath: string;
  private readonly rejectedPath: string;
  private readonly tokenVerifier: (entry: AuditEntry) => boolean;
  private readonly tailSize: number;
  private tail: AuditEntry[] = [];
  /**
   * Per-(surface,attemptId) high-watermark for A42 atomicTs check. We key on
   * `${subsystem}:${attemptId}` — re-declarations against the same attempt
   * must be monotonically non-decreasing in `timestamp`.
   */
  private highWatermark: Map<string, number> = new Map();

  constructor(stateDir: string, options: AuditWriterOptions) {
    const dir = path.join(stateDir, 'remediation');
    fs.mkdirSync(dir, { recursive: true });
    this.projectionPath = path.join(dir, `audit-projection-${options.machineId}.jsonl`);
    this.rejectedPath = path.join(dir, 'audit-rejected.jsonl');
    this.tokenVerifier = options.tokenVerifier;
    this.tailSize = options.tailSize ?? DEFAULT_TAIL_SIZE;
  }

  /**
   * Append an entry. Verified entries land in the projection file and the
   * in-memory tail; forged or stale-watermark entries land in the rejected
   * file and DO NOT touch the projection.
   */
  async append(entry: AuditEntry): Promise<AppendResult> {
    if (!this.tokenVerifier(entry)) {
      this.persistRejected(entry, 'token-verify-failed');
      return { accepted: false, rejectedReason: 'token-verify-failed' };
    }
    const watermarkKey = `${entry.subsystem}:${entry.attemptId}`;
    const prev = this.highWatermark.get(watermarkKey);
    if (prev !== undefined && entry.timestamp < prev) {
      // A42: declared timestamp regressed against persisted high-watermark.
      this.persistRejected(entry, 'watermark-regression');
      return { accepted: false, rejectedReason: 'watermark-regression' };
    }
    this.highWatermark.set(watermarkKey, Math.max(prev ?? 0, entry.timestamp));
    this.persistAccepted(entry);
    this.pushTail(entry);
    return { accepted: true };
  }

  /** In-memory tail of the last N accepted entries (A29). */
  recentTail(): AuditEntry[] {
    return [...this.tail];
  }

  // ── Internals ──────────────────────────────────────────────────────

  private persistAccepted(entry: AuditEntry): void {
    const line = serializeEntry(entry) + '\n';
    const fd = fs.openSync(this.projectionPath, 'a', 0o600);
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private persistRejected(entry: AuditEntry, reason: string): void {
    const payload =
      JSON.stringify({
        rejectedAt: Date.now(),
        reason,
        entry: serializeEntryObj(entry),
      }) + '\n';
    const fd = fs.openSync(this.rejectedPath, 'a', 0o600);
    try {
      fs.writeSync(fd, payload);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private pushTail(entry: AuditEntry): void {
    this.tail.push(entry);
    if (this.tail.length > this.tailSize) {
      this.tail.splice(0, this.tail.length - this.tailSize);
    }
  }
}

function serializeEntryObj(e: AuditEntry): Record<string, unknown> {
  const obj: Record<string, unknown> = {
    entryId: e.entryId,
    attemptId: e.attemptId,
    outcome: e.outcome,
    runbookId: e.runbookId,
    subsystem: e.subsystem,
    reason: e.reason,
    timestamp: e.timestamp,
    monotonicTs: e.monotonicTs.toString(),
    auditToken: e.auditToken.toString('base64'),
  };
  if (e.errorCode !== undefined) obj.errorCode = e.errorCode;
  return obj;
}

function serializeEntry(e: AuditEntry): string {
  return JSON.stringify(serializeEntryObj(e));
}

export function deserializeAuditEntry(line: string): AuditEntry {
  const obj = JSON.parse(line);
  return {
    entryId: String(obj.entryId),
    attemptId: String(obj.attemptId),
    outcome: obj.outcome as AuditOutcome,
    runbookId: obj.runbookId ? String(obj.runbookId) : undefined,
    subsystem: String(obj.subsystem),
    reason: obj.reason,
    errorCode: obj.errorCode ? String(obj.errorCode) : undefined,
    timestamp: Number(obj.timestamp),
    monotonicTs: BigInt(obj.monotonicTs),
    auditToken: Buffer.from(String(obj.auditToken), 'base64'),
  };
}
