/**
 * SwapLedger — the durable JSONL decision ledger for account-swap continuity
 * (docs/specs/swap-continuity-antithrash.md §3.5 / §6.1).
 *
 * One module owns `state/swap-ledger.jsonl` — the ONLY append site. The
 * ProactiveSwapMonitor (via the SwapAntiThrashEngine), the QuotaAwareScheduler
 * and SessionRefresh all route their rows through here; none writes the file
 * directly (spec S14: single append chokepoint).
 *
 * Duties:
 *  - Atomic single-line appends with O(1) segment rotation
 *    (`maybeRotateJsonlSegment`, 10 MB, keep 2 — never the legacy whole-file
 *    rewrite, which is marked non-conformant by the spec).
 *  - Boot hydration: walk retained segments NEWEST-FIRST until the oldest row
 *    read is older than the hydration window; tolerate a corrupt/partial
 *    trailing line (counted, never poisoning the derivation or aborting boot).
 *  - Unwritable-ledger accounting (§3.5 R3-M3/R4-m1/R5-m3): while an append
 *    fails, the ledger reports `writable:false` (the engine pauses proactive
 *    optimization on it — invariant I12); non-refusal decisions during the
 *    outage are counted (`rowsLostWhileDown`); the level-triggered resume's
 *    FIRST successful append writes ONE `outage-summary` row so the mid-window
 *    gap is durable and boot-visible.
 *
 * The ledger is deliberately dumb about POLICY: brake decisions, episode
 * arithmetic and the in-memory index all live in SwapAntiThrashEngine. This
 * module is file IO + honest failure accounting only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { maybeRotateJsonlSegment } from '../utils/jsonl-rotation.js';

// ── Enums (§6.2 — single-sourced; other modules import these) ──────────────

export type SwapDecision =
  | 'swapped'
  | 'refused'
  | 'deferred'
  | 'dropped'
  | 'invalidated'
  | 'failed'
  | 'proceeded'
  | 'outage-summary';

export type SwapReason =
  | 'all-hot'
  | 'dwell'
  | 'no-material-target'
  | 'target-unmeasured'
  | 'reversal'
  | 'thrash-breaker'
  | 'target-revalidation-failed'
  | 'busy-turn'
  | 'busy-subagents'
  | 'busy-indeterminate'
  | 'deferral-ceiling-dropped'
  | 'intent-stale'
  | 'session-busy'
  | 'swap-exec-failed';
// NOTE: `ledger-lost` is deliberately NOT a SwapReason row member — it is the
// one refusal that can never write a row (the writer is what died, §3.5/I5);
// it lives only in status counters and log lines.

export type SwapKind = 'proactive' | 'reactive' | 'interactive';

export type EpisodeKind =
  | 'thrash-breaker'
  | 'all-hot'
  | 'failure-streak'
  | 'measurement-blind';

export type BreakerState = 'closed' | 'open' | 'half-open';

export type SubagentLegState = 'ok' | 'absent' | 'indeterminate';

export interface TriggerSignature {
  tier: 'T1' | 'T2';
  /** T2 trigger: the session whose frequency crossing opened the episode. */
  session?: string;
  /** T1 trigger: the unordered account pair, canonicalized `a|b` (sorted). */
  pair?: string;
}

/** The authoritative row schema (§6.1). All fields optional except the spine. */
export interface SwapLedgerRow {
  ts: string;
  kind: SwapKind;
  decision: SwapDecision;
  callerClass?: string;
  session?: string;
  topicId?: number;
  machineId?: string;
  from?: string;
  to?: string;
  fromUtilPct?: number;
  toUtilPct?: number;
  reason?: SwapReason;
  dwellRemainingMs?: number;
  unmeasuredAlternates?: number;
  deferralAgeMs?: number;
  deferCount?: number;
  inFlight?: { turn: boolean; subagents: number };
  subagentLeg?: SubagentLegState;
  killedSubagents?: number;
  killedSubagentList?: Array<{ agentType: string; ageMinutes: number; transcriptPath?: string }>;
  inbound?: 'reinjected' | 'none' | 'unknown';
  force?: boolean;
  authLevel?: 'bearer';
  defaultAccountChanged?: boolean;
  episodeId?: string;
  episodeKind?: EpisodeKind;
  breakerOpenedAt?: string;
  breakerDeadline?: string;
  triggerSignature?: TriggerSignature;
  transition?: 'enter' | 'leave' | 'heartbeat';
  errorClass?: string;
  /** Rung-2 soak marker: this row records a WOULD-decision under dryRun. */
  dryRun?: boolean;
  // ── outage-summary-only fields (§6.1, R5-m3) ──
  rowsLostWhileDown?: number;
  ledgerLostRefusals?: number;
  outageStartTs?: string;
  outageEndTs?: string;
}

export interface SwapLedgerHydration {
  /** Rows inside the hydration window, OLDEST-FIRST (derivation-friendly). */
  rows: SwapLedgerRow[];
  corruptLinesSkipped: number;
  hydration: 'complete' | 'under-primed';
  /** Why under-primed (named gap, §3.5): 'rotation-shortfall' | 'outage-summary-in-window'. */
  underPrimedReason?: string;
}

export interface SwapLedgerStatus {
  writable: boolean;
  lostSince?: string;
  rowsLostWhileDown: number;
  corruptLinesSkipped: number;
  hydration: 'complete' | 'under-primed';
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB (§3.5)
const DEFAULT_KEEP_SEGMENTS = 2; // §3.5 — bounded boot read: active + 2 segments

export interface SwapLedgerOptions {
  filePath: string;
  /** Hydration window (= retentionBoundMs, §3.2 one-formula). */
  windowMs: () => number;
  now?: () => number;
  maxBytes?: number;
  keepSegments?: number;
  /** Counts supplied at outage-resume time by the engine (ledger-lost refusals). */
  outageRefusalCount?: () => number;
  machineId?: string;
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

export class SwapLedger {
  private readonly filePath: string;
  private readonly windowMs: () => number;
  private readonly now: () => number;
  private readonly maxBytes: number;
  private readonly keepSegments: number;
  private readonly outageRefusalCount: () => number;
  private readonly machineId: string;
  private readonly logger: { log: (m: string) => void; warn: (m: string) => void };

  private writable = true;
  private lostSinceMs: number | null = null;
  private rowsLostWhileDown = 0;
  private lastCorruptSkipped = 0;
  private hydrationState: 'complete' | 'under-primed' = 'complete';

  constructor(opts: SwapLedgerOptions) {
    this.filePath = opts.filePath;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? (() => Date.now());
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keepSegments = opts.keepSegments ?? DEFAULT_KEEP_SEGMENTS;
    this.outageRefusalCount = opts.outageRefusalCount ?? (() => 0);
    this.machineId = opts.machineId ?? 'local';
    this.logger = opts.logger ?? { log: () => {}, warn: () => {} };
  }

  get path(): string {
    return this.filePath;
  }

  /** Is the ledger currently writable? (I12: false ⇒ proactive optimization pauses.) */
  isWritable(): boolean {
    return this.writable;
  }

  status(): SwapLedgerStatus {
    return {
      writable: this.writable,
      ...(this.lostSinceMs !== null ? { lostSince: new Date(this.lostSinceMs).toISOString() } : {}),
      rowsLostWhileDown: this.rowsLostWhileDown,
      corruptLinesSkipped: this.lastCorruptSkipped,
      hydration: this.hydrationState,
    };
  }

  /**
   * Append one decision row. Returns true when the row landed on disk.
   *
   * On the first successful append AFTER an unwritable episode, ONE
   * `outage-summary` row is written first (R5-m3) so the mid-window row gap
   * is durable and boot-visible. On failure the ledger flips unwritable
   * (level-triggered — each subsequent append re-attempts, so recovery needs
   * no restart) and the row is COUNTED as lost when it is a non-refusal
   * decision (`rowsLostWhileDown`, R4-m1) — the caller keeps its in-memory
   * index primed regardless.
   */
  /**
   * Level-triggered outage resume (§3.5, I12): when the ledger is down,
   * attempt to write the ONE `outage-summary` breadcrumb row now. Returns
   * true when the ledger is writable afterwards (already up, or the summary
   * landed and the outage is over); false while the outage persists. The
   * engine calls this at the top of every proactive evaluation, so recovery
   * needs no restart.
   */
  tryResume(): boolean {
    if (this.writable) return true;
    const outageStartMs = this.lostSinceMs;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const summary: SwapLedgerRow = {
        ts: new Date(this.now()).toISOString(),
        kind: 'proactive',
        decision: 'outage-summary',
        machineId: this.machineId,
        rowsLostWhileDown: this.rowsLostWhileDown,
        ledgerLostRefusals: this.outageRefusalCount(),
        outageStartTs: outageStartMs !== null ? new Date(outageStartMs).toISOString() : undefined,
        outageEndTs: new Date(this.now()).toISOString(),
      };
      fs.appendFileSync(this.filePath, JSON.stringify(summary) + '\n');
      this.writable = true;
      this.lostSinceMs = null;
      this.logger.log('[SwapLedger] append recovered — outage-summary row written, proactive optimization may resume');
      return true;
    } catch {
      return false;
    }
  }

  append(row: SwapLedgerRow): boolean {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (!this.writable) {
        // Level-triggered resume: the first successful append path writes the
        // outage-summary breadcrumb BEFORE the actual row (R5-m3). If it
        // cannot be written the outage continues (caught below).
        if (!this.tryResume()) throw new Error('ledger-still-unwritable');
      }
      fs.appendFileSync(this.filePath, JSON.stringify(row) + '\n');
      maybeRotateJsonlSegment(this.filePath, {
        maxBytes: this.maxBytes,
        keepSegments: this.keepSegments,
      });
      return true;
    } catch (err) {
      // @silent-fallback-ok: NOT silent — the first failure warns loudly, the
      // engine pauses proactive optimization while unwritable (I12), and lost
      // rows are counted (rowsLostWhileDown / ledgerLostRefusals, R4-m1).
      if (this.writable) {
        this.writable = false;
        this.lostSinceMs = this.now();
        this.logger.warn(
          `[SwapLedger] append FAILED (${err instanceof Error ? err.constructor.name : 'Error'}) — ledger unwritable; proactive optimization pauses (I12)`,
        );
      }
      // A refusal row lost during the outage is counter-only via the engine's
      // ledgerLostRefusals; EXECUTED/PROCEEDED rows lost here are the
      // rowsLostWhileDown class (R4-m1).
      if (row.decision !== 'refused') this.rowsLostWhileDown += 1;
      return false;
    }
  }

  /**
   * Boot hydration (§3.5 read path): read retained segments NEWEST-FIRST
   * (active file, then `.N` segments descending) until the oldest row read is
   * older than the window. Bounded by keepSegments — at most active + 2
   * segments. Runs UNCONDITIONALLY at boot (R4-L3) so the index is warm the
   * moment a dark flag flips on mid-run. Never throws.
   */
  hydrate(): SwapLedgerHydration {
    const nowMs = this.now();
    const windowMs = this.windowMs();
    const cutoff = nowMs - windowMs;
    let corrupt = 0;
    const rows: SwapLedgerRow[] = [];
    let sawOutageSummaryInWindow = false;
    let oldestRowMs: number | null = null;

    const files = this.listFilesNewestFirst();
    let coveredWindow = files.length === 0; // empty ledger = cold start, complete
    let rotatedSegmentsSeen = 0;

    for (const f of files) {
      if (f.rotated) rotatedSegmentsSeen += 1;
      let content: string;
      try {
        content = fs.readFileSync(f.file, 'utf-8');
      } catch {
        // @silent-fallback-ok: an unreadable segment is treated as absent —
        // hydration stays partial and the incomplete window is surfaced via
        // the hydration result's coveredWindow/corrupt fields, never hidden.
        continue;
      }
      let fileOldest: number | null = null;
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let row: SwapLedgerRow;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!parsed || typeof parsed !== 'object' || typeof (parsed as SwapLedgerRow).ts !== 'string') {
            corrupt += 1;
            continue;
          }
          row = parsed as SwapLedgerRow;
        } catch {
          // Corrupt/partial trailing line — tolerated, counted, never poisons
          // the derivation or aborts the boot (§3.5 durability rules).
          corrupt += 1;
          continue;
        }
        const tsMs = Date.parse(row.ts);
        if (!Number.isFinite(tsMs)) {
          corrupt += 1;
          continue;
        }
        if (fileOldest === null || tsMs < fileOldest) fileOldest = tsMs;
        if (oldestRowMs === null || tsMs < oldestRowMs) oldestRowMs = tsMs;
        if (tsMs < cutoff) continue; // older than the window — read past, not kept
        if (row.decision === 'outage-summary') sawOutageSummaryInWindow = true;
        rows.push(row);
      }
      // Stop the newest-first walk once this file's OLDEST row predates the
      // window — every older file is entirely out of window.
      if (fileOldest !== null && fileOldest < cutoff) {
        coveredWindow = true;
        break;
      }
    }
    if (oldestRowMs !== null && oldestRowMs < cutoff) coveredWindow = true;

    // Under-primed honesty (§3.5): (a) retention could not cover the window —
    // every retained row is younger than the bound AND rotation has evidently
    // discarded older segments; (b) an outage-summary row sits inside the
    // window (a mid-window row gap, R5-m3).
    let hydration: 'complete' | 'under-primed' = 'complete';
    let underPrimedReason: string | undefined;
    if (!coveredWindow && rotatedSegmentsSeen >= this.keepSegments) {
      hydration = 'under-primed';
      underPrimedReason = 'rotation-shortfall';
    }
    if (sawOutageSummaryInWindow) {
      hydration = 'under-primed';
      underPrimedReason = underPrimedReason
        ? `${underPrimedReason}+outage-summary-in-window`
        : 'outage-summary-in-window';
    }
    if (hydration === 'under-primed') {
      this.logger.warn(
        `[SwapLedger] hydration UNDER-PRIMED (${underPrimedReason}) — the in-memory brake index may be missing rows inside its window`,
      );
    }

    rows.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    this.lastCorruptSkipped = corrupt;
    this.hydrationState = hydration;
    return { rows, corruptLinesSkipped: corrupt, hydration, ...(underPrimedReason ? { underPrimedReason } : {}) };
  }

  private listFilesNewestFirst(): Array<{ file: string; rotated: boolean }> {
    const out: Array<{ file: string; rotated: boolean }> = [];
    try {
      if (fs.existsSync(this.filePath)) out.push({ file: this.filePath, rotated: false });
      const dir = path.dirname(this.filePath);
      const base = path.basename(this.filePath);
      const segRe = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\.(\\d+)$');
      const segs: Array<{ seq: number; file: string }> = [];
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(segRe);
        if (m) segs.push({ seq: parseInt(m[1], 10), file: path.join(dir, f) });
      }
      segs.sort((a, b) => b.seq - a.seq); // newest rotated segment first
      for (const s of segs) out.push({ file: s.file, rotated: true });
    } catch {
      /* directory unreadable — hydrate cold */
    }
    return out;
  }
}
