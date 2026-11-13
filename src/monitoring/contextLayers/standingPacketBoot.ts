/**
 * Production wiring of the standing packet (context-budget-layered-summaries
 * §9.5, Phase 1 S10), mirrored by the e2e test. Behind `contextBudget.enabled`
 * (the layers' gate): with the layers off nothing is built, and
 * `clearStagedStandingPackets` removes any packet a previous run staged, so the
 * compaction hook behaves exactly as today.
 *
 * A verification failure is counted by the stager and reported here: one
 * DegradationReporter event per topic per hour, and a featureEvidence `error`.
 * That is signal; the only action is the fallback the stager already took
 * (nothing staged, so the hook prints today's RF-fitted block).
 */
import type { TopicIntentFile } from '../../core/TopicIntent.js';
import { DegradationReporter } from '../DegradationReporter.js';
import { featureEvidence } from '../FeatureEvidenceLog.js';
import type { ContextLayers } from './contextLayersBoot.js';
import { CONTEXT_LAYERS_FEATURE_ID } from './contextLayersBoot.js';
import { isSystemOrProxyMessage } from '../../messaging/shared/isSystemOrProxyMessage.js';
import { StandingPacketStager, type PacketRowSource } from './standingPacket.js';
import { topicRef } from '../../messaging/shared/topicRef.js';

/** The TopicMemory surface the packet reads. */
export interface PacketTopicMemory {
  getUserCorpusRows(topicId: number, opts?: { messageId?: number; limit?: number }): { rows: Array<{ rowId: number; message: { text: string; timestamp: string } }> };
  countMessagesAfter(topicId: number, messageId: number): { total: number; fromUser: number } | null;
  getTopicMeta?(topicId: number): { topicName: string | null } | null;
  getRecentMessages?(topicId: number, limit?: number): Array<{ messageId: number; fromUser: boolean; timestamp: string; text?: string | null }>;
}

/** One row's exact text by message id (the newest row carrying that id, as TopicMemory's own readers resolve it). */
export function packetRowSource(tm: PacketTopicMemory): PacketRowSource {
  return {
    getRow(topicId, messageId) {
      const r = tm.getUserCorpusRows(topicId, { messageId, limit: 10 }).rows;
      const last = r[r.length - 1];
      return last ? { text: last.message.text, timestamp: last.message.timestamp ?? null } : null;
    },
    countMessagesAfter: (t, m) => tm.countMessagesAfter(t, m),
    topicName: (t) => tm.getTopicMeta?.(t)?.topicName ?? null,
    lastAgentMessage: (t) => {
      const recent = tm.getRecentMessages?.(t, 50) ?? null;
      if (!recent) return null;
      let best: { messageId: number; timestamp: string | null } | null = null;
      let bestAt = -Infinity;
      for (const m of recent) {
        // A standby or delivery/lifecycle line is not a reply (the resume path's own filter).
        if (m.fromUser || isSystemOrProxyMessage(m.text)) continue;
        const at = Date.parse(m.timestamp);
        if (Number.isFinite(at) && at >= bestAt) { bestAt = at; best = { messageId: m.messageId, timestamp: m.timestamp }; }
      }
      return best;
    },
  };
}

export function wireStandingPacket(o: {
  layers: ContextLayers;
  stateDir: string;
  topicMemory: PacketTopicMemory;
  intent?: (topicId: number) => TopicIntentFile | null;
  /** Running sessions on this machine (SessionManager.listRunningSessions). */
  sessions: () => Array<{ id: string; telegramTopicId?: number | null; framework?: string }>;
  debounceMs?: number;
}): StandingPacketStager {
  const lastReported = new Map<string, number>();
  const stager = new StandingPacketStager({
    stateDir: o.stateDir,
    store: o.layers.store,
    rows: packetRowSource(o.topicMemory),
    intent: o.intent,
    debounceMs: o.debounceMs,
    sessionsForTopic: (topicId) => o.sessions()
      .filter((s) => s.telegramTopicId === topicId && (s.framework ?? 'claude-code') === 'claude-code' && /^[A-Za-z0-9_-]{1,128}$/.test(s.id))
      .map((s) => s.id),
    liveSessionIds: () => o.sessions().map((s) => s.id),
    onStaged: (topicKey, p) => {
      featureEvidence.recordAtMostEvery(CONTEXT_LAYERS_FEATURE_ID, `${topicKey}:standing-packet`, 10 * 60_000, { kind: 'fired', reason: 'standing packet staged and verified', context: { topicKey, chars: p.chars, reduced: p.reduced, omitted: p.omitted, protectedRows: p.protectedRows } });
    },
    onVerifyFailed: (topicKey, result) => {
      const problems = [...new Set(result.problems.map((p) => p.problem))];
      featureEvidence.record(CONTEXT_LAYERS_FEATURE_ID, { kind: 'error', reason: `standing packet failed verification: ${problems.join(', ')}`.slice(0, 300), context: { topicKey, problems: problems.join(',') } });
      const now = Date.now();
      if (now - (lastReported.get(topicKey) ?? 0) < 60 * 60_000) return;
      lastReported.set(topicKey, now);
      if (lastReported.size > 500) lastReported.delete(lastReported.keys().next().value as string);
      DegradationReporter.getInstance().report({
        feature: 'contextBudget.standingPacket',
        primary: 'After a compaction the conversation is re-seeded from its verified standing packet (the operator\'s own words verbatim, then the summary layers)',
        fallback: 'The compaction recovery prints today\'s condensed recovery block for this conversation',
        reason: `The packet for ${topicRef(topicKey)} failed verification: ${problems.join(', ')}`,
        impact: 'This conversation recovers from a compaction the way it did before the context layers; nothing wrong is delivered.',
      });
    },
  });
  o.layers.attachStandingPacket(stager);
  return stager;
}
