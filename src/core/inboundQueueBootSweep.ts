/**
 * Inbound-queue boot sweep (Durable Inbound Message Queue spec §5.2/§5.3 +
 * the §3.4 crash table). Runs on the UNCONDITIONAL boot path — outside the
 * mesh-gated wiring — keyed on store-file existence alone, BEFORE
 * `recoverPendingInjects` (boot ordering, §3.4) and before any drain starts.
 *
 * Duties:
 *  - corrupt/locked store → quarantine-rename (main + -wal/-shm sidecars,
 *    0600 preserved) + ONE attention item; boot proceeds (fail-open);
 *  - expired quarantines (> 7 days) deleted via SafeFsExecutor (L12) — this
 *    sweep owns the gated-off case; the backstop tick is the steady-state
 *    second layer;
 *  - queue-will-NOT-run-this-boot (gate reasons: feature-disabled /
 *    pool-dark / no-mesh-identity / dry-run) → expire ALL non-terminal rows
 *    in one transaction, loss reason NAMES the gate, loss-reported;
 *  - queue WILL run → crash recovery per the §3.4 crash table:
 *      claimed + receipt + PIS record  → delivered (PIS replays the inject);
 *      claimed + receipt, no PIS       → delivered + "possibly not injected";
 *      claimed, no receipt             → released to queued (frozen when a
 *                                        pause is durably in effect);
 *    + PIS veto for operator-stop rows (STOP-scoped ONLY, round-9);
 *    + unflipped unreported receipts → "possibly not injected" report.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import {
  PendingInboundStore,
  resolvePendingInboundPath,
  type PendingInboundRow,
} from './PendingInboundStore.js';
import type { LossItem } from './QueueDrainLoop.js';

export type QueueGateReason = 'feature-disabled' | 'pool-dark' | 'no-mesh-identity' | 'dry-run';

export interface BootSweepDeps {
  stateDir: string;
  agentId: string;
  /** Will the drain run this boot? false carries the NAMED gate (§5.3). */
  queueWillRun: { run: true } | { run: false; gateReason: QueueGateReason };
  /** Does a PendingInjectStore record exist for this session? (crash row 2 vs 3) */
  hasPisRecord(sessionKey: string): boolean;
  /** Delete the PIS record (stop veto — through the PIS clear API). */
  clearPisRecord(sessionKey: string): void;
  reportLoss(items: LossItem[], reason: string): void;
  reportPossiblyNotInjected(items: LossItem[]): void;
  raiseAttention(title: string, body: string): void;
  log(line: string): void;
  nowMs(): number;
}

export interface BootSweepResult {
  storePresent: boolean;
  quarantined: boolean;
  expiredQuarantinesDeleted: number;
  gateExpired: number;
  recoveredToQueued: number;
  settledDelivered: number;
  possiblyNotInjected: number;
  pisVetoed: number;
  /** The opened store when the queue will run (handed to the drain), else null. */
  store: PendingInboundStore | null;
}

const QUARANTINE_MAX_AGE_MS = 7 * 24 * 3600_000;

export function quarantineDirFor(stateDir: string): string {
  return path.join(stateDir, 'state', 'pending-inbound-quarantine');
}

export function runInboundQueueBootSweep(deps: BootSweepDeps): BootSweepResult {
  const result: BootSweepResult = {
    storePresent: false,
    quarantined: false,
    expiredQuarantinesDeleted: 0,
    gateExpired: 0,
    recoveredToQueued: 0,
    settledDelivered: 0,
    possiblyNotInjected: 0,
    pisVetoed: 0,
    store: null,
  };

  // Expired-quarantine deletion runs EVERY boot regardless of anything else
  // (round-4: a disabled install must not keep payload plaintext forever).
  result.expiredQuarantinesDeleted = deleteExpiredQuarantines(deps);

  const storePath = resolvePendingInboundPath(deps.stateDir, deps.agentId);
  if (!fs.existsSync(storePath)) return result;
  result.storePresent = true;

  let store: PendingInboundStore;
  try {
    store = PendingInboundStore.open(deps.agentId, deps.stateDir);
  } catch (err) {
    // Corrupt/locked store never blocks boot: quarantine-rename + one item.
    quarantineStore(deps, storePath, err);
    result.quarantined = true;
    return result;
  }

  const nowIso = new Date(deps.nowMs()).toISOString();

  if (!deps.queueWillRun.run) {
    // §5.3: one transaction, loss reason names the gate, store closed after.
    const gate = deps.queueWillRun.gateReason;
    const rows = store.listNonTerminal();
    const dropped: LossItem[] = [];
    for (const row of rows) {
      const prior = row.state as 'queued' | 'claimed';
      if (store.transition(row.enqueue_seq, prior, 'expired', { nowIso, terminalReason: `gate:${gate}` })) {
        dropped.push(lossItem(row, `gate:${gate}`));
      }
    }
    result.gateExpired = dropped.length;
    if (dropped.length > 0) deps.reportLoss(dropped, `queue-dispatch-will-not-run:${gate}`);
    store.close();
    return result;
  }

  // Queue WILL run — crash recovery (§3.4 crash table), one pass.
  const paused = store.isPaused();
  const pni: LossItem[] = [];
  for (const row of store.listNonTerminal()) {
    // PIS veto — STOP-scoped ONLY (round-9). Terminal rows aren't in this
    // list; stop rows are terminal, so the veto scans terminal reasons below.
    if (row.state !== 'claimed') continue;
    const hasReceipt = store.hasReceipt(row.session_key, row.message_id, 'injection');
    if (hasReceipt) {
      const hasPis = deps.hasPisRecord(row.session_key);
      store.transition(row.enqueue_seq, 'claimed', 'delivered', {
        nowIso,
        deliveredUnconfirmed: !hasPis,
      });
      result.settledDelivered += 1;
      if (!hasPis) {
        // Crash row 2: receipt-without-downstream-record — the accepted loss
        // window, REPORTED ("possibly not injected — resend if unanswered").
        pni.push(lossItem(row, 'receipt-without-downstream-record'));
        result.possiblyNotInjected += 1;
        store.incrementCounter('possiblyNotInjected');
      }
      // Crash row 3 (receipt + PIS): PIS replays the inject — permitted even
      // during a durable pause (in-flight work completing is the round-9
      // pause contract).
    } else {
      // Crash row 1: claimed, no receipt → release to queued; frozen when a
      // pause is durably in effect (§3.6 round-9 boot arm).
      store.release(row.enqueue_seq, {
        nowIso,
        attempts: row.attempts,
        nextAttemptAt: null,
        freeze: paused,
      });
      result.recoveredToQueued += 1;
    }
  }

  // PIS veto for operator-stop rows (terminal — scan recent terminals).
  // listNonTerminal misses them by design; a bounded scan over the terminal
  // set within retention is the honest read.
  for (const sk of stopSessionKeys(store)) {
    try {
      deps.clearPisRecord(sk);
      result.pisVetoed += 1;
    } catch { /* veto best-effort; recoverPendingInjects expiry is the next layer */ }
  }

  // Unflipped, unreported receipts (windows 4/6 boot detection).
  for (const r of store.findUnflippedUnreportedReceipts()) {
    pni.push({ sessionKey: r.session_key, messageId: r.message_id, enqueuedAt: r.created_at, reason: 'receipt-never-injected' });
    store.markReceiptReported(r.session_key, r.message_id, r.class);
    result.possiblyNotInjected += 1;
  }

  if (pni.length > 0) deps.reportPossiblyNotInjected(pni);
  result.store = store;
  return result;
}

// ── helpers ───────────────────────────────────────────────────────────

function lossItem(row: PendingInboundRow, reason: string): LossItem {
  return {
    sessionKey: row.session_key,
    messageId: row.message_id,
    enqueuedAt: row.enqueued_at,
    reason,
    senderDisplay: row.sender_display,
  };
}

/** Sessions with operator-stop terminal rows (the PIS-veto scan, §3.4). */
function stopSessionKeys(store: PendingInboundStore): string[] {
  // The store API is method-only (no raw handle) — use the terminal listing
  // the prune path already bounds. A dedicated method keeps it indexed:
  return store.listOperatorStopSessions();
}

function quarantineStore(deps: BootSweepDeps, storePath: string, err: unknown): void {
  const qDir = quarantineDirFor(deps.stateDir);
  try {
    fs.mkdirSync(qDir, { recursive: true });
    const stamp = new Date(deps.nowMs()).toISOString().replace(/[:.]/g, '-');
    for (const suffix of ['', '-wal', '-shm']) {
      const src = `${storePath}${suffix}`;
      if (!fs.existsSync(src)) continue;
      const dest = path.join(qDir, `${path.basename(src)}.${stamp}`);
      fs.renameSync(src, dest); // rename is data-preserving (not a destructive op)
      try { fs.chmodSync(dest, 0o600); } catch { /* mode preserved best-effort */ }
    }
    deps.log(`[inbound-queue] store quarantined (${stamp}): ${err instanceof Error ? err.message : String(err)}`);
    deps.raiseAttention(
      'Inbound message queue store quarantined',
      `The durable inbound queue store could not be opened and was moved aside (kept 7 days at ${qDir}). ` +
        `Messages it held could not be recovered — resend anything still needed. Reason: ${err instanceof Error ? err.message : String(err)}`,
    );
  } catch (qErr) {
    // Quarantine itself failed (e.g. disk full) — log loudly; boot proceeds.
    deps.log(`[inbound-queue] quarantine FAILED for ${storePath}: ${qErr instanceof Error ? qErr.message : String(qErr)}`);
  }
}

function deleteExpiredQuarantines(deps: BootSweepDeps): number {
  const qDir = quarantineDirFor(deps.stateDir);
  let deleted = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(qDir);
  } catch {
    return 0; // no quarantine dir — the normal case
  }
  for (const name of entries) {
    const full = path.join(qDir, name);
    try {
      const stat = fs.statSync(full);
      if (deps.nowMs() - stat.mtimeMs > QUARANTINE_MAX_AGE_MS) {
        SafeFsExecutor.safeUnlinkSync(full, { operation: 'inboundQueueBootSweep.expiredQuarantine' });
        deleted += 1;
      }
    } catch { /* per-file best-effort */ }
  }
  return deleted;
}
