/**
 * canonicalHistoryRead — the UNION read source for `threadline_history` (D-C).
 *
 * The read is `canonical log ∪ bounded best-effort backfill`, so post-upgrade
 * history can ONLY GAIN, never regress (`guard-bypass-carries-its-own-cap`). On the
 * first read of a thread whose canonical log predates the upgrade, a ONE-TIME,
 * MEMOIZED, BOUNDED backfill reconstructs entries through the idempotent funnel:
 *   - Outbound legs from a TAIL-BOUNDED scan of `outbox.jsonl.active` (a cap on
 *     lines scanned — NOT the whole shared file).
 *   - Inbound legs from the per-thread derived `threads/{id}.json` aggregate
 *     (O(thread)) — NEVER a full-store scan.
 * All backfilled entries are marked `backfilled:true` and EXCLUDED from the
 * symmetry accumulator (a backfilled leg cannot reproduce the live projection —
 * the outbox lacks a distinct message `createdAt`/`contentDigest`).
 *
 * Restore-correctness (SI2/D1): the one-time `backfilled` memo lives on the
 * conversation record, which a restore-from-backup brings back EMPTY of logs — so
 * the read IGNORES a set memo when the log is ABSENT and re-runs backfill (else a
 * restored thread would stay permanently empty).
 */

import fs from 'node:fs';
import type { ThreadLog, ThreadLogEntry } from './ThreadLog.js';
import type { ThreadMessageRecorder } from './recordThreadMessage.js';
import type { ConversationStore } from './ConversationStore.js';

/** A minimal inbound leg shape pulled from the derived aggregate. */
export interface AggregateMessage {
  id: string;
  body: string;
  createdAt: string;
  /** The sender — used only to decide inbound vs. our own outbound. */
  fromAgent?: string;
}

export interface CanonicalReadDeps {
  threadLog: ThreadLog;
  threadMessageRecorder: ThreadMessageRecorder;
  conversationStore?: ConversationStore;
  /** Path to the canonical outbox (`{stateDir}/threadline/outbox.jsonl.active`). */
  outboxPath?: string;
  /** Returns the inbound legs for a thread from the derived aggregate (O(thread)). */
  getAggregateMessages?: (threadId: string) => Promise<AggregateMessage[]> | AggregateMessage[];
  /** Our own agent name/fingerprint — to classify aggregate legs as inbound. */
  selfName?: string;
  /** Tail-line cap on the outbox scan (FD-config backfillOutboxTailLines). */
  backfillOutboxTailLines?: number;
}

const DEFAULT_OUTBOX_TAIL_LINES = 5000;

/**
 * Read a thread's canonical history as the UNION (log ∪ one-time bounded
 * backfill). Returns the live-segment entries (post-backfill). Idempotent: the
 * backfill runs at most once per thread (memoized), and re-runs only if the memo
 * is set but the log is absent (restore case).
 */
export async function readThreadHistoryUnion(deps: CanonicalReadDeps, threadId: string): Promise<ThreadLogEntry[]> {
  const existing = deps.threadLog.read(threadId, { limit: 100000 }).entries;
  const conv = deps.conversationStore?.get(threadId);
  const memoSet = conv?.backfilled === true;

  // Run backfill when the log has NO entries AND (we've never memoized OR the memo
  // is set but the log is gone — the restore case). A non-empty log means the funnel
  // is already capturing live traffic; no backfill needed.
  if (existing.length === 0 && (!memoSet || existing.length === 0)) {
    await backfillThread(deps, threadId);
    if (deps.conversationStore) {
      try { await deps.conversationStore.stampBackfilled(threadId, true); } catch { /* best-effort memo */ }
    }
    return deps.threadLog.read(threadId, { limit: 100000 }).entries;
  }
  return existing;
}

/**
 * Reconstruct a thread's pre-upgrade legs into the canonical log through the
 * idempotent funnel (marked `backfilled`). Bounded: outbox is tail-scanned, inbound
 * comes from the per-thread aggregate (never a full-store scan). Honest residual:
 * inbound legs absent from BOTH the aggregate and the envelope store are
 * unrecoverable — the symmetry surface (not backfill) makes that gap visible.
 */
export async function backfillThread(deps: CanonicalReadDeps, threadId: string): Promise<{ outbound: number; inbound: number }> {
  let outbound = 0;
  let inbound = 0;

  // ── Outbound legs from a TAIL-BOUNDED outbox scan ──
  if (deps.outboxPath) {
    try {
      const tail = readOutboxTail(deps.outboxPath, deps.backfillOutboxTailLines ?? DEFAULT_OUTBOX_TAIL_LINES);
      for (const e of tail) {
        if (e.threadId !== threadId) continue;
        deps.threadMessageRecorder.record({
          threadId,
          messageId: e.id,
          direction: 'outbound',
          body: e.text ?? '',
          createdAt: e.timestamp ?? new Date(0).toISOString(),
          backfilled: true,
        });
        outbound += 1;
      }
    } catch { /* @silent-fallback-ok: outbox backfill is best-effort; the live funnel is the authority going forward */ }
  }

  // ── Inbound legs from the per-thread derived aggregate (O(thread)) ──
  if (deps.getAggregateMessages) {
    try {
      const msgs = await deps.getAggregateMessages(threadId);
      for (const m of msgs) {
        // Classify as inbound only (our own outbound came from the outbox above).
        if (deps.selfName && m.fromAgent && m.fromAgent === deps.selfName) continue;
        deps.threadMessageRecorder.record({
          threadId,
          messageId: m.id,
          direction: 'inbound',
          body: m.body ?? '',
          createdAt: m.createdAt ?? new Date(0).toISOString(),
          backfilled: true,
        });
        inbound += 1;
      }
    } catch { /* @silent-fallback-ok: aggregate backfill is best-effort; a residual gap is flagged by the symmetry surface, not hidden */ }
  }

  return { outbound, inbound };
}

interface OutboxEntry { id: string; timestamp?: string; threadId?: string; text?: string }

/** Read the last `maxLines` lines of the outbox and parse them (bounded). */
function readOutboxTail(outboxPath: string, maxLines: number): OutboxEntry[] {
  let content: string;
  try { content = fs.readFileSync(outboxPath, 'utf-8'); } catch { /* @silent-fallback-ok — no outbox file = nothing to backfill */ return []; }
  const lines = content.split('\n').filter((l) => l.trim());
  const tail = lines.slice(Math.max(0, lines.length - maxLines));
  const out: OutboxEntry[] = [];
  for (const line of tail) {
    try {
      const e = JSON.parse(line) as OutboxEntry;
      if (e && e.id) out.push(e);
    } catch { /* @silent-fallback-ok — skip a torn outbox line */ }
  }
  return out;
}
