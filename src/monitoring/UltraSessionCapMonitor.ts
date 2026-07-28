/**
 * UltraSessionCapMonitor — §8 of docs/specs/FABLE-MODEL-ESCALATION-SPEC.md,
 * the mid-run daily-cap monitor for LAUNCHED ultra sessions.
 *
 * A spawned escalated run is launch-time-only — its model cannot be
 * down-swapped mid-run (§3.5: routing never blocks). So `dailyUltraTokenCap`
 * is admission control for NEW escalations (EscalationGovernor) AND this
 * monitor watches RUNNING escalated sessions for a cap crossing. On a
 * crossing it raises a **HIGH Attention item** for the operator to decide
 * (continue / stop), **dedup-keyed per (session-instance, UTC day)** so it
 * fires once, not once per tick (round-3 Adversarial-NEW-7 — HIGH items are
 * never coalesced by the topic-flood guard, so the dedup key is mandatory).
 *
 * Honest caveat carried from the spec (round-3 Adversarial-NEW-6): this
 * guarantees **visibility, not bounded spend** — ultra spend continues until
 * the operator acts. A multi-day run exceeding the cap is operator-visible,
 * never silent.
 *
 * NO OWN POLLER (round-3 Integration-NEW-2): this rides BurnDetector's
 * existing 60s tick — the build adds (a) per-session-instance ultra-token
 * attribution (TokenLedger.sessionActivitySince keyed by the session's
 * Claude transcript id) and (b) an absolute-cap-crossing predicate, on top
 * of BurnDetector's share/rate infrastructure.
 */

import type { Session } from '../core/types.js';
import {
  escalatedModelIds,
  type TierEscalationConfig,
} from '../core/ModelTierEscalation.js';

export interface UltraCapAttentionItem {
  id: string;
  title: string;
  summary: string;
  category: string;
  priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
}

export interface UltraSessionCapMonitorDeps {
  /** Per-session token attribution (TokenLedger). Null ⇒ monitor no-ops
   *  (visibility degrades; admission control still bounds new escalations). */
  ledger: { sessionActivitySince(sessionId: string, sinceMs: number): { tokens: number } } | null;
  listRunningSessions: () => Session[];
  getConfig: () => TierEscalationConfig;
  /** Raise an Attention item (TelegramAdapter.createAttentionItem — dedups
   *  by id, which carries the (instance, day) key). */
  attention?: (item: UltraCapAttentionItem) => unknown;
  now?: () => number;
}

export function startOfUtcDayMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export class UltraSessionCapMonitor {
  private readonly deps: UltraSessionCapMonitorDeps;
  private readonly now: () => number;
  /** In-memory (instance, day) dedup — backstopped by the Attention surface's
   *  own id-dedup, so a restart cannot re-alert more than once. */
  private readonly alerted = new Set<string>();

  constructor(deps: UltraSessionCapMonitorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Invoked from BurnDetector.tick() — must never throw. */
  tick(): void {
    try {
      this.run();
    } catch (err) {
      console.warn(`[ultra-cap-monitor] tick error (non-fatal): ${(err as Error).message}`);
    }
  }

  private run(): void {
    const cfg = this.deps.getConfig();
    const cap = cfg.costGuards.dailyUltraTokenCap;
    if (cap == null || !this.deps.ledger) return;
    const ultraIds = escalatedModelIds(cfg);
    if (ultraIds.size === 0) return;

    const nowMs = this.now();
    const dayStart = startOfUtcDayMs(nowMs);
    const dayKey = new Date(dayStart).toISOString().slice(0, 10);

    for (const session of this.deps.listRunningSessions()) {
      if (!session.model || !ultraIds.has(String(session.model))) continue;
      // Attribution key: the session's Claude transcript id — what the
      // token ledger's JSONL scan records events under. Absent (no hook
      // event seen yet) ⇒ nothing to attribute yet; skip this tick.
      if (!session.claudeSessionId) continue;
      const dedupKey = `${session.id}::${dayKey}`;
      if (this.alerted.has(dedupKey)) continue;

      const { tokens } = this.deps.ledger.sessionActivitySince(session.claudeSessionId, dayStart);
      if (tokens <= cap) continue;

      this.alerted.add(dedupKey);
      try {
        this.deps.attention?.({
          // The (instance, day) dedup key IS the item id — HIGH items are
          // never coalesced, so this id is the only thing preventing a
          // re-fire per tick across restarts.
          id: `model-tier-ultra-cap-${session.id}-${dayKey}`,
          title: `Ultra session over daily token cap: ${session.name}`,
          summary:
            `Escalated session "${session.name}" (${session.model}) has used ` +
            `${tokens.toLocaleString()} tokens today (UTC) — over the ` +
            `dailyUltraTokenCap of ${cap.toLocaleString()}. A launched ultra run ` +
            `cannot be auto-down-swapped: spend CONTINUES until you act. ` +
            `Options: let it finish, or kill the session.`,
          category: 'model-tier-escalation',
          priority: 'HIGH',
        });
      } catch {
        // Attention surface unavailable — the in-memory mark stands so we
        // don't hot-loop; the next UTC day re-evaluates.
      }
    }

    // Bound the dedup set: drop keys from previous days.
    for (const key of this.alerted) {
      if (!key.endsWith(dayKey)) this.alerted.delete(key);
    }
  }
}
