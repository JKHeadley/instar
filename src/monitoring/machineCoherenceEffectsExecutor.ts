/**
 * Machine-coherence effects executor (calm-transient-episode-alerting M-P2).
 *
 * Extracted from the server.ts boot closure — the exact site of the original
 * hardcoded-`priority: 'HIGH'` bug — into an injectable, unit-testable module.
 * The executor is a PASS-THROUGH: priority / silent / copy decisions live in
 * the episode manager (where dimension/stall/flap/interacted context lives);
 * this module only carries them to the Telegram chokepoints.
 *
 * Fail-toward-silence: every effect executes fire-and-forget with its own
 * catch — a Telegram fault must never crash the shared presence tick; the next
 * reconcile re-derives from durable episode state.
 */

import type { EpisodeEffect } from './machineCoherenceEpisodeManager.js';

/** The Telegram surface the executor needs (structural subset of TelegramAdapter). */
export interface EffectsTelegram {
  createAttentionItem(item: {
    id: string; title: string; summary: string; description?: string;
    category: string; priority: string; sourceContext?: string; silent?: boolean;
  }): Promise<unknown>;
  getAttentionItem(itemId: string): { topicId?: number } | undefined;
  sendToTopic(topicId: number, text: string, options?: { silent?: boolean }): Promise<unknown>;
  updateAttentionStatus(itemId: string, status: string, opts?: { silent?: boolean }): Promise<boolean>;
}

export interface EffectsExecutorDeps {
  /** The live adapter (null when Telegram is unavailable — effects are best-effort). */
  telegram: () => EffectsTelegram | null;
  /** `execute-fix` handler (the atomic config funnel lives server-side). */
  onExecuteFix?: (eff: Extract<EpisodeEffect, { kind: 'execute-fix' }>) => Promise<void>;
}

/**
 * Execute one batch of episode effects. Each effect runs independently
 * (fire-and-forget, own catch) — one fault never blocks the rest.
 */
export function executeMachineCoherenceEffects(effects: EpisodeEffect[], deps: EffectsExecutorDeps): void {
  for (const eff of effects) {
    void (async () => {
      try {
        const tg = deps.telegram();
        if (eff.kind === 'raise') {
          await tg?.createAttentionItem({
            id: eff.itemId, title: eff.title, summary: eff.summary, description: eff.description,
            category: 'machine-coherence',
            // M-P2 pass-through: the manager decides; absent = legacy HIGH.
            priority: eff.priority ?? 'HIGH',
            silent: eff.silent === true,
            sourceContext: 'machine-coherence-guard',
          });
        } else if (eff.kind === 'append') {
          const item = tg?.getAttentionItem(eff.itemId);
          if (item?.topicId !== undefined) await tg?.sendToTopic(item.topicId, eff.text, { silent: eff.silent === true });
        } else if (eff.kind === 'resolve') {
          const item = tg?.getAttentionItem(eff.itemId);
          if (item?.topicId !== undefined) await tg?.sendToTopic(item.topicId, eff.note, { silent: eff.silent === true });
          await tg?.updateAttentionStatus(eff.itemId, 'DONE', { silent: eff.silent === true });
        } else if (eff.kind === 'resolve-status') {
          // Orphan self-closeout arm: status-only DONE, no message ever.
          await tg?.updateAttentionStatus(eff.itemId, 'DONE', { silent: true });
        } else if (eff.kind === 'execute-fix') {
          await deps.onExecuteFix?.(eff);
        }
      } catch { /* @silent-fallback-ok: episode effect execution is best-effort; a Telegram send/create fault must never crash the presence tick — the next reconcile re-derives from durable episode state */ }
    })();
  }
}
