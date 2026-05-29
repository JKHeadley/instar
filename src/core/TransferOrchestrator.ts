/**
 * TransferOrchestrator — drives a planned session handoff through the §L3/§L5
 * ordered sequence: active(S) → transferring(e+1) → [drain, flush ledger, target
 * pulls+verifies] → active(T, e+2) → S-release. Claim-before-release, fenced by
 * (status, epoch): there is no double-run (only one machine is `active` at the top
 * epoch) and no no-owner gap (`transferring` still names S as the draining owner).
 *
 * The orchestrator enforces the two §L5 timing contracts:
 *  - Drain bound (`transferDrainTimeoutMs`): a long reply/tool-call must NOT block a
 *    transfer; on timeout the source abandons its partial output (NOT emitted).
 *  - Output exclusion (`transferOutputCutoffMs`): T holds its CONTINUATION until the
 *    cutoff has elapsed since the `transferring` write, so S's drain window and T's
 *    emission window are disjoint by construction — exactly one continuation per turn.
 *
 * All I/O (CAS, drain, ledger flush, mesh transfer, claim, clock) is injected so the
 * sequence + timing logic is deterministic and unit-testable; the real wiring (real
 * SessionMigrator drain, real git ledger flush, real mesh client) lands in Track H.
 */

export type LedgerEntryStatus = 'reply_committed' | 'cursor_advanced' | 'in_flight';

export interface LedgerSnapshot {
  sessionKey: string;
  generatedAt: number;
  entries: Array<{ messageId: string; status: LedgerEntryStatus; replyMarker?: string; updatedAt: number }>;
  snapshotSha256: string;
}

/**
 * Verify a ledger snapshot at the transfer handoff (§L5): the SHA256 must match the
 * SyncManifest-covered value AND every entry must be terminal (nothing `in_flight`).
 * An `in_flight` entry means a turn was still processing at flush time — the target
 * must NOT resume from it (it waits for a terminal re-flush, or treats it as the
 * interrupted-drain case on failover). Pure.
 */
export function verifyLedgerSnapshot(
  snapshot: LedgerSnapshot,
  expectedSha256: string,
  computeSha256: (s: LedgerSnapshot) => string,
): { ok: true } | { ok: false; reason: 'sha-mismatch' | 'in-flight-entry' } {
  if (computeSha256(snapshot) !== expectedSha256 || snapshot.snapshotSha256 !== expectedSha256) {
    return { ok: false, reason: 'sha-mismatch' };
  }
  if (snapshot.entries.some((e) => e.status === 'in_flight')) {
    return { ok: false, reason: 'in-flight-entry' };
  }
  return { ok: true };
}

export interface TransferRequest {
  sessionKey: string;
  source: string;
  target: string;
  reason: 'pin' | 'rebalance' | 'failover';
  /** Whether the source machine is alive (planned transfer) or gone (failover). */
  sourceAlive: boolean;
  /** The ownership epoch the orchestrator observed before starting. */
  baseEpoch: number;
}

export interface TransferOrchestratorConfig {
  transferDrainTimeoutMs: number;
  transferOutputCutoffMs: number;
}

export const DEFAULT_TRANSFER_CONFIG: TransferOrchestratorConfig = {
  transferDrainTimeoutMs: 30000,
  transferOutputCutoffMs: 1000,
};

export interface TransferOrchestratorDeps {
  /** CAS the record source→transferring(epoch+1). */
  casToTransferring: (sessionKey: string, target: string, expectedEpoch: number) => { ok: boolean; epoch: number };
  /** Quiesce + drain the in-flight reply on the source, bounded by timeoutMs. */
  drain: (sessionKey: string, timeoutMs: number) => Promise<{ drained: boolean; abandonedPartial: boolean }>;
  /** Source flushes its ledger snapshot synchronously (returns the snapshot + its ref). */
  flushLedger: (sessionKey: string) => Promise<{ snapshot: LedgerSnapshot; ledgerSnapshotRef: string; syncManifestRef: string }>;
  /** Send the transfer MeshRpc to the target; the target pulls + verifies the snapshot. */
  sendTransferRpc: (target: string, refs: { sessionKey: string; ledgerSnapshotRef: string; syncManifestRef: string }) => Promise<{ ok: boolean; verified: boolean; reason?: string }>;
  /** Target CASes itself to active(owner=T, epoch+2). */
  targetClaim: (sessionKey: string, expectedEpoch: number) => { ok: boolean; epoch: number };
  /** Cleanup: source releases (NOT a precondition for T's claim — runs after). */
  releaseSource: (sessionKey: string) => void;
  /** Raise a deduped Attention item on sync corruption / unrecoverable handoff. */
  raiseAttention?: (title: string, body: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export type TransferStatus =
  | 'transferred'
  | 'aborted-cas-lost'
  | 'sync-corrupted'
  | 'target-claim-failed';

export interface TransferOutcome {
  ok: boolean;
  status: TransferStatus;
  drainAbandoned?: boolean;
  finalEpoch?: number;
  detail?: string;
}

export class TransferOrchestrator {
  private readonly deps: TransferOrchestratorDeps;
  private readonly cfg: TransferOrchestratorConfig;
  constructor(deps: TransferOrchestratorDeps, cfg: TransferOrchestratorConfig = DEFAULT_TRANSFER_CONFIG) {
    this.deps = deps;
    this.cfg = cfg;
  }

  async transfer(req: TransferRequest): Promise<TransferOutcome> {
    // 1. CAS source→transferring(e+1). Stamp the moment for the output-exclusion window.
    const t1 = this.deps.casToTransferring(req.sessionKey, req.target, req.baseEpoch);
    if (!t1.ok) {
      return { ok: false, status: 'aborted-cas-lost', detail: 'could-not-enter-transferring' };
    }
    const transferringAt = this.deps.now();

    // 2. Drain the in-flight reply on the source, bounded (a long reply must not block).
    const drainRes = await this.deps.drain(req.sessionKey, this.cfg.transferDrainTimeoutMs);

    // 3. Source flushes its ledger snapshot synchronously.
    const flush = await this.deps.flushLedger(req.sessionKey);

    // 4. Send transfer to the target; the target pulls + verifies (SHA + all-terminal).
    const sent = await this.deps.sendTransferRpc(req.target, { sessionKey: req.sessionKey, ledgerSnapshotRef: flush.ledgerSnapshotRef, syncManifestRef: flush.syncManifestRef });
    if (!sent.ok || !sent.verified) {
      this.deps.raiseAttention?.('Session transfer sync corrupted', `${req.sessionKey} → ${req.target}: ${sent.reason ?? 'verify-failed'}`);
      return { ok: false, status: 'sync-corrupted', drainAbandoned: drainRes.abandonedPartial, detail: sent.reason ?? 'verify-failed' };
    }

    // 5. Output exclusion: T must NOT emit until transferOutputCutoffMs has elapsed
    //    since the transferring write, so S's drain window + T's emission are disjoint.
    const elapsed = this.deps.now() - transferringAt;
    const remaining = this.cfg.transferOutputCutoffMs - elapsed;
    if (remaining > 0) await this.deps.sleep(remaining);

    // 6. Target claims active(owner=T, e+2). Then the source releases (cleanup only).
    const t2 = this.deps.targetClaim(req.sessionKey, t1.epoch);
    if (!t2.ok) {
      return { ok: false, status: 'target-claim-failed', drainAbandoned: drainRes.abandonedPartial, detail: 'target-cas-failed' };
    }
    this.deps.releaseSource(req.sessionKey);
    this.deps.log?.(`transfer ${req.sessionKey} ${req.source}→${req.target} complete @ epoch ${t2.epoch}`);
    return { ok: true, status: 'transferred', drainAbandoned: drainRes.abandonedPartial, finalEpoch: t2.epoch };
  }
}
