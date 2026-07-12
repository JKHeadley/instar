/**
 * Rope escalation sink router (calm-transient-episode-alerting M-P3).
 *
 * Routes the prober's escalations on their SOURCE-DECLARED class:
 * - `actionable` (or UNDECLARED — fail-loud) → a hub attention item.
 * - `informational` → demoted to the audit log + digest, but ONLY under the
 *   delivery-true conjunction verified LIVE on this machine: rope-health
 *   enabled AND digestTopicId set AND the rope-health-digest job RUNNABLE IN
 *   THIS PROCESS (a live scheduler handle with the job loaded + enabled — the
 *   lease read is NOT the conjunct: a promoted standby holds the lease with no
 *   scheduler until restart). Any miss ⇒ fall back to the hub item.
 *
 * Both classes are deduped per (peer, kind) per 24 h with a visible silent
 * "Nth episode" count append — an oscillating rope is a visible recurring
 * defect, not a quiet audit fact. The dedupe is in-memory (restart reset is an
 * accepted bounded consequence: re-tripping needs exhaustAttempts consecutive
 * failures at the floor cadence).
 *
 * No id-string parsing anywhere: class/peer/kind ride the typed payload.
 */

import type { MeshEndpoint } from '../core/types.js';

export interface RopeSinkItem {
  id: string;
  title: string;
  body: string;
  class?: 'informational' | 'actionable';
  peer?: string;
  kind?: MeshEndpoint['kind'];
}

export interface RopeSinkDeps {
  telegram: () => {
    createAttentionItem(item: { id: string; title: string; summary: string; description: string; category: string; priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW'; sourceContext: string }): Promise<unknown>;
    getAttentionItem(id: string): { topicId?: number } | undefined;
    sendToTopic(topicId: number, text: string, options?: { silent?: boolean }): Promise<unknown>;
  } | null;
  /** LIVE read: rope-health enabled AND digestTopicId configured. */
  digestConfigured: () => boolean;
  /** LIVE read: a JobScheduler instance runs in THIS process with the
   *  rope-health-digest job loaded + enabled. */
  digestRunnableHere: () => boolean;
  /** Self nickname for the direction label. */
  selfNickname: () => string;
  /** Append one audit row to the sentinel-events jsonl (metadata only). */
  audit: (row: Record<string, unknown>) => void;
  now?: () => number;
}

const DAY_MS = 24 * 3_600_000;

export function makeRopeSinkRouter(deps: RopeSinkDeps): (item: RopeSinkItem) => unknown {
  const dedupe = new Map<string, { firstAt: number; count: number; itemId: string }>();
  return (item: RopeSinkItem): unknown => {
    const now = (deps.now ?? Date.now)();
    const cls: 'informational' | 'actionable' = item.class === 'informational' ? 'informational' : 'actionable';
    const audit = (event: string, extra: Record<string, unknown> = {}) =>
      deps.audit({ ts: new Date(now).toISOString(), sentinel: 'rope-recovery-probe', event, class: cls, peer: item.peer, kind: item.kind, id: item.id, ...extra });

    // Both-class (peer, kind) 24 h dedupe with a visible count append.
    if (item.peer && item.kind) {
      const dk = `${item.peer}:${item.kind}:${cls}`;
      const st = dedupe.get(dk);
      if (st && now - st.firstAt < DAY_MS) {
        st.count += 1;
        audit('deduped', { count: st.count });
        const existing = deps.telegram()?.getAttentionItem(st.itemId);
        if (existing?.topicId !== undefined) {
          void deps.telegram()?.sendToTopic(existing.topicId, `${st.count}th ${cls} episode for this rope in 24 h — a recurring rope is worth a look at the link itself.`, { silent: true })?.catch?.(() => {});
        }
        return;
      }
      dedupe.set(dk, { firstAt: now, count: 1, itemId: item.id });
    }

    if (cls === 'informational') {
      const configured = deps.digestConfigured();
      const runnable = deps.digestRunnableHere();
      if (configured && runnable) {
        audit('demoted-to-digest');
        return; // the digest's recovering-rope class carries it
      }
      audit('fallback-to-hub', { digestConfigured: configured, digestRunnableHere: runnable });
    } else {
      audit('actionable-to-hub');
    }

    return deps.telegram()?.createAttentionItem({
      id: item.id,
      title: item.title,
      summary: item.body.slice(0, 160),
      description: `${item.body}\n\nDirection: observed from ${deps.selfNickname()} — rope health is directional; the peer's own view may differ.`,
      category: 'rope-recovery-probe',
      priority: 'NORMAL',
      sourceContext: 'rope-recovery-probe',
    });
  };
}
