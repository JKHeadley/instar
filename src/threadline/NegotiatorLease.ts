/**
 * NegotiatorLease — types + pure helpers for the Threadline single-negotiator
 * lock (Robustness Phase 1, THREADLINE-SINGLE-NEGOTIATOR-SPEC.md, CMT-1362).
 *
 * The lease names exactly ONE session as the owner of a conversation's outbound
 * voice (G1 — "one voice"). It is stored as optional fields on the existing
 * `Conversation` record so it inherits the ConversationStore's single-writer CAS
 * + atomic-write guarantees; the acquire/renew transaction lives on
 * ConversationStore (`acquireOrRenewLease`). This module holds only the durable
 * SHAPE, the config resolver, and the pure decision helpers — no I/O, no
 * authority. The send-gate orchestration lives in {@link ./NegotiatorGate}.
 *
 * SIGNAL-vs-AUTHORITY: the lease is the ONLY blocking authority in Phase 1, and
 * it blocks on a STRUCTURAL ownership check (who holds the voice), never on what
 * a message MEANS. The commitment-class lexicon in ContentClassifier is a
 * signal-only nudge with no authority (FD-4/FD-10).
 */

import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { resolveDevAgentGate } from '../core/devAgentGate.js';

// ── The durable lease shape (additive, optional on Conversation) ────────

/**
 * Per-conversation negotiator lease. `epoch` is monotonic — every (re)acquire
 * increments it, which fences a stale holder: a session that held epoch N,
 * stalled past TTL, and was taken over (epoch N+1) re-reads the live lease at
 * the send chokepoint, finds N+1 ≠ N, and yields rather than speaking as owner.
 */
export interface NegotiatorLease {
  /** Server-authoritative live session identity at the chokepoint. */
  ownerSessionName: string;
  /** This machine's id (the lease is a per-machine, intra-machine voice guard). */
  ownerMachineId: string;
  /** Monotonic; every (re)acquire increments — fences stale holders. */
  epoch: number;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

/** The (session, machine) identity that wants to own / renew the voice. */
export interface LeaseOwner {
  ownerSessionName: string;
  ownerMachineId: string;
}

/** Disposition of an acquire-or-renew transaction. */
export type LeaseDisposition = 'acquired' | 'renewed' | 'held';

export interface LeaseResult {
  disposition: LeaseDisposition;
  /** The live lease after the transaction (the owner's lease when `held`). */
  lease: NegotiatorLease;
  /** True for acquired/renewed (the caller owns the voice); false for held. */
  ownedByCaller: boolean;
}

// ── Config (FD-1, FD-3, FD-7, FD-9) ─────────────────────────────────────

export interface SingleNegotiatorConfig {
  /**
   * Master switch. Resolved through the developmentAgent dark-feature gate:
   * the config OMITS `enabled` so it runs LIVE on a development agent (the
   * dogfooding ground — in dry-run, so it withholds nothing) and DARK on the
   * fleet. An explicit `enabled` in config always wins. Default (no key, no dev
   * agent) ⇒ pure pass-through.
   */
  enabled: boolean;
  /** When enabled, dry-run logs the verdict it WOULD reach but still sends. */
  dryRun: boolean;
  /** Lease TTL — renew-on-send, no background timers (FD-1). */
  leaseTtlMs: number;
  /** Global per-thread min interval between holding notices (FD-3). */
  holdingNoticeMinIntervalMs: number;
  /** Dry-run JSONL rotation window (FD-9). */
  dryRunRetentionDays: number;
}

export const SINGLE_NEGOTIATOR_DEFAULTS: SingleNegotiatorConfig = {
  enabled: false,
  dryRun: true,
  leaseTtlMs: 90_000,
  holdingNoticeMinIntervalMs: 300_000,
  dryRunRetentionDays: 7,
};

/**
 * Resolve the `threadline.singleNegotiator` config block defensively. Unknown /
 * missing fields fall back to the safe (dark, dry-run) defaults. `dryRun`
 * defaults TRUE when enabled (FD-7) — enforce (withholding a real send) is only
 * ever reached by an explicit `dryRun: false`.
 *
 * `enabled` resolves through the developmentAgent dark-feature gate
 * ({@link resolveDevAgentGate}): the config OMITS `enabled` so the lease runs
 * LIVE on a development agent (in dry-run — it logs would-hold verdicts but
 * withholds nothing, gathering the FD-7 false-positive telemetry) and DARK on
 * the fleet. An explicit `enabled` in config always wins. Pass the agent config
 * (only `developmentAgent` is read); omit it and the gate resolves fleet-dark.
 */
export function resolveSingleNegotiatorConfig(
  raw: unknown,
  devGateConfig?: { developmentAgent?: boolean },
): SingleNegotiatorConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const posNum = (v: unknown, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d;
  return {
    enabled: resolveDevAgentGate(
      typeof r.enabled === 'boolean' ? r.enabled : undefined,
      devGateConfig ?? {},
    ),
    // Default true when the key is absent; only an explicit `false` disarms it.
    dryRun: r.dryRun === undefined ? true : r.dryRun !== false,
    leaseTtlMs: posNum(r.leaseTtlMs, SINGLE_NEGOTIATOR_DEFAULTS.leaseTtlMs),
    holdingNoticeMinIntervalMs: posNum(
      r.holdingNoticeMinIntervalMs,
      SINGLE_NEGOTIATOR_DEFAULTS.holdingNoticeMinIntervalMs,
    ),
    dryRunRetentionDays: posNum(r.dryRunRetentionDays, SINGLE_NEGOTIATOR_DEFAULTS.dryRunRetentionDays),
  };
}

// ── Holding notice (FD-11 — the only new wire kind) ─────────────────────

/**
 * The holding-notice envelope. ADDITIVE wire kind: an upgraded peer recognizes
 * `kind`; an un-upgraded peer simply renders `text` as a harmless one-liner. On
 * OUR side it is NEVER ack/content/message-count-bearing and NEVER carries
 * model-authored text — only owner/agent/epoch are interpolated into a fixed
 * template — and it creates NO sender-side awaiting-ack record (FD-11).
 */
export interface HoldingNotice {
  kind: 'holding-notice';
  owner: { sessionName: string; machineId: string };
  epoch: number;
  text: string;
}

/** Build the fixed-template holding notice. No model-authored text (FD-11). */
export function buildHoldingNotice(agentName: string, lease: NegotiatorLease): HoldingNotice {
  const text =
    `[threadline] ${agentName} is already handling this conversation in another ` +
    `session (owner ${lease.ownerSessionName}, epoch ${lease.epoch}); that session ` +
    `will respond. This is an automated holding notice — it carries no commitment.`;
  return {
    kind: 'holding-notice',
    owner: { sessionName: lease.ownerSessionName, machineId: lease.ownerMachineId },
    epoch: lease.epoch,
    text,
  };
}

/**
 * Pure decision: may a holding notice be emitted now for (thread, epoch)? Honors
 * BOTH the durable per-epoch limit AND the global min-interval floor (FD-3),
 * which together bound an epoch-cycling flood.
 */
export function shouldEmitHoldingNotice(opts: {
  epoch: number;
  lastHoldingNoticeEpoch?: number;
  lastHoldingNoticeAt?: string;
  minIntervalMs: number;
  now: number;
}): boolean {
  const { epoch, lastHoldingNoticeEpoch, lastHoldingNoticeAt, minIntervalMs, now } = opts;
  // Per-epoch limit: at most one notice per (thread, epoch).
  if (lastHoldingNoticeEpoch === epoch) return false;
  // Global min-interval floor: at most one notice per thread per window.
  if (lastHoldingNoticeAt) {
    const last = new Date(lastHoldingNoticeAt).getTime();
    if (Number.isFinite(last) && now - last < minIntervalMs) return false;
  }
  return true;
}

// ── Holder-singularity detector (FD-2) ──────────────────────────────────

/** A reported live holder of a conversation, as observed across the mesh. */
export interface HolderObservation {
  conversationId: string;
  machineId: string;
}

/**
 * Pure detector: given holder observations (one per machine that believes it is
 * the live holder of a conversation), return the conversationIds observed on
 * MORE THAN ONE machine. Under the single-holder invariant (FD-2) this is always
 * empty; a non-empty result is a split-brain / routing-bug / clock-skew signal
 * that must raise a HIGH-priority alert rather than silently re-opening the
 * cross-machine incident path. Fed by the existing holder-election observations;
 * genuinely-concurrent multi-machine processing of one conversation is the F2
 * surface, explicitly Phase 3.
 */
export function detectDuplicateLiveHolders(observations: HolderObservation[]): Array<{
  conversationId: string;
  machineIds: string[];
}> {
  const byConversation = new Map<string, Set<string>>();
  for (const o of observations) {
    if (!o || !o.conversationId || !o.machineId) continue;
    let set = byConversation.get(o.conversationId);
    if (!set) {
      set = new Set();
      byConversation.set(o.conversationId, set);
    }
    set.add(o.machineId);
  }
  const dupes: Array<{ conversationId: string; machineIds: string[] }> = [];
  for (const [conversationId, machineIds] of byConversation) {
    if (machineIds.size > 1) dupes.push({ conversationId, machineIds: [...machineIds].sort() });
  }
  return dupes;
}

// ── Dry-run / fail-open observability log (FD-7, FD-9, D-B) ─────────────

/** One observability record appended to logs/threadline-negotiator.jsonl. */
export interface NegotiatorLogEntry {
  ts: string;
  threadId: string;
  /** What the gate did or WOULD do. */
  action: 'allow-own' | 'would-hold' | 'hold' | 'fail-open' | 'cas-exhausted';
  sessionName: string;
  ownerSessionName?: string;
  epoch?: number;
  dryRun: boolean;
  attemptCount?: number;
  detail?: string;
}

/**
 * Append a negotiator observability record. Daily-rotated by filename so the
 * retention sweep (dryRunRetentionDays) can prune by date. Best-effort — logging
 * never endangers the send.
 */
export function appendNegotiatorLog(logDir: string, entry: NegotiatorLogEntry): void {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    // YYYY-MM-DD suffix → trivially prunable by the retention sweep.
    const day = entry.ts.slice(0, 10);
    const file = path.join(logDir, `threadline-negotiator-${day}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    // @silent-fallback-ok: observability log is best-effort; never break the send.
  }
}

/** Aggregate counts read from the negotiator observability JSONL (for the route). */
export interface NegotiatorCounts {
  allowOwn: number;
  wouldHold: number;
  hold: number;
  failOpen: number;
  casExhausted: number;
}

/**
 * Tally the negotiator observability log over the most recent `days` files.
 * Bounded by reading at most `days` day-files (default 7). Best-effort — a
 * missing/corrupt line is skipped, never thrown.
 */
export function readNegotiatorCounts(logDir: string, days: number = 7): NegotiatorCounts {
  const counts: NegotiatorCounts = { allowOwn: 0, wouldHold: 0, hold: 0, failOpen: 0, casExhausted: 0 };
  try {
    if (!fs.existsSync(logDir)) return counts;
    const files = fs
      .readdirSync(logDir)
      .filter((n) => /^threadline-negotiator-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
      .sort()
      .slice(-Math.max(1, days));
    for (const name of files) {
      let raw: string;
      try {
        raw = fs.readFileSync(path.join(logDir, name), 'utf-8');
      } catch {
        continue;
      }
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as { action?: string };
          switch (e.action) {
            case 'allow-own': counts.allowOwn++; break;
            case 'would-hold': counts.wouldHold++; break;
            case 'hold': counts.hold++; break;
            case 'fail-open': counts.failOpen++; break;
            case 'cas-exhausted': counts.casExhausted++; break;
          }
        } catch { /* skip corrupt line */ }
      }
    }
  } catch { /* best-effort */ }
  return counts;
}

/**
 * Prune negotiator dry-run logs older than `retentionDays`. Idempotent;
 * best-effort. Returns the number of files removed (for tests/observability).
 */
export function pruneNegotiatorLogs(logDir: string, retentionDays: number, now: number = Date.now()): number {
  let removed = 0;
  try {
    if (!fs.existsSync(logDir)) return 0;
    const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(logDir)) {
      const m = name.match(/^threadline-negotiator-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m) continue;
      const day = new Date(`${m[1]}T00:00:00Z`).getTime();
      if (Number.isFinite(day) && day < cutoff) {
        try {
          SafeFsExecutor.safeUnlinkSync(path.join(logDir, name), { operation: 'NegotiatorLease.pruneNegotiatorLogs' });
          removed++;
        } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }
  return removed;
}
