/**
 * Wiring helpers for the shadow fold runner (context-budget-layered-summaries
 * §10 item 2, §9.7; Phase 2 slice P2-4b): reading the folded stretches back out
 * of the transcript archive, bounded.
 *
 * A finished stretch is named by TopicMemory message ids (the session never
 * sees entry ids). The archive indexes which spans carry each message id
 * (`spansForMessage`); the stretch's entries are the entries of those spans
 * whose own message ids fall inside the stretch, plus the agent and tool
 * entries between them in span order. Bounded: at most `maxEntries` per
 * stretch, the newest kept (the sampler then applies its own ceiling).
 */
import type { TranscriptArchive } from './contextLayers/TranscriptArchive.js';
import { spanEntriesFromArchive, type SpanEntry } from './contextLayers/spanSampler.js';
import type { FoldedSpan } from './foldProbe.js';
import type { TopicMessage } from '../memory/TopicMemory.js';
import { classifyRow, type OperatorResolver } from './contextLayers/userCorpus.js';
import type { IntelligenceProvider } from '../core/types.js';
import { IntelligenceRouter } from '../core/IntelligenceRouter.js';
import { CLAUDE_CODE_FRAMEWORK } from '../core/frameworkFacts.js';

export const FOLDED_SPAN_MAX_ENTRIES = 4_000;

export function foldedSpansFromArchive(archive: Pick<TranscriptArchive, 'spansForMessage' | 'readSpan'>, topicKey: string, finished: ReadonlyArray<{ fromMessageId: number; toMessageId: number; outcome: string }>, knownMessageIds: readonly number[], o: { maxEntries?: number } = {}): FoldedSpan[] {
  const cap = o.maxEntries ?? FOLDED_SPAN_MAX_ENTRIES;
  return finished.map((f, index) => {
    const spanIds = new Set<string>();
    // Every known message inside the stretch, not just its ends: a long stretch crosses several spans.
    for (const id of knownMessageIds) if (id >= f.fromMessageId && id <= f.toMessageId) for (const s of archive.spansForMessage(topicKey, id)) spanIds.add(s);
    const entries: SpanEntry[] = [];
    for (const spanId of spanIds) {
      const read = archive.readSpan(topicKey, spanId);
      if (!read) continue;
      const all = spanEntriesFromArchive(read);
      // From the first entry carrying a message id in the stretch to the last one.
      const inside = (e: SpanEntry) => e.messageIds.some((m) => m >= f.fromMessageId && m <= f.toMessageId);
      const first = all.findIndex(inside);
      if (first < 0) continue;
      let last = first;
      for (let i = all.length - 1; i >= first; i--) if (inside(all[i])) { last = i; break; }
      entries.push(...all.slice(first, last + 1));
    }
    const seen = new Set<string>();
    const unique = entries.filter((e) => (seen.has(e.entryId) ? false : (seen.add(e.entryId), true)));
    return { index, outcome: f.outcome, entries: unique.slice(-cap) };
  });
}

/**
 * The Anchor and live-ledger inputs the audit and the probe read (§7.4, §10):
 * the framing rows' text, each live decision/evolution with its bound
 * operator row, and the deterministic dropped-decision check's input. Read
 * from the layer store's references and the TopicMemory rows (the store keeps
 * references only).
 */
export function ledgerInputs(
  store: { read(t: string, type: 'anchor', key: string): { status?: string; rows?: Array<{ messageId: number }> } | null; list(t: string, type: 'ledger-entry'): Array<{ entryKey: string; status?: string; rows?: Array<{ messageId: number }>; data: Record<string, unknown> }> },
  rows: { getRow(topicId: number, messageId: number): { text: string } | null },
  topicKey: string,
): { anchorText: string; ledgerText: string; ledgerItems: Array<{ key: string; type: 'decision' | 'evolution'; text: string }>; ledgerDecisions: Array<{ key: string; boundMessageId: number | null; text: string }> } {
  const topicId = Number(topicKey);
  const text = (id: number) => { try { return rows.getRow(topicId, id)?.text ?? null; } catch { return null; } }; // @silent-fallback-ok — an unreadable row is left out (the audit sees fewer decisions, never invented ones)
  const anchor = store.read(topicKey, 'anchor', 'current');
  const anchorText = anchor?.status === 'anchored' ? (anchor.rows ?? []).map((r) => text(r.messageId)).filter((x): x is string => !!x).join('\n') : '';
  const LIVE = new Set(['settled', 'derived-settled', 'confirmed', 'tentative', 'pending']);
  const ledgerItems: Array<{ key: string; type: 'decision' | 'evolution'; text: string }> = [];
  const ledgerDecisions: Array<{ key: string; boundMessageId: number | null; text: string }> = [];
  for (const r of store.list(topicKey, 'ledger-entry')) {
    if (!LIVE.has(r.status ?? '')) continue;
    const bound = r.rows?.[0]?.messageId ?? null;
    const t = bound !== null ? text(bound) : null;
    if (!t) continue;
    const type = r.data.type === 'evolution' ? 'evolution' : 'decision';
    ledgerItems.push({ key: r.entryKey, type, text: t });
    if (r.status === 'settled' || r.status === 'derived-settled') ledgerDecisions.push({ key: r.entryKey, boundMessageId: bound, text: t });
  }
  return { anchorText, ledgerText: ledgerItems.map((l) => `${l.key} (${l.type}): ${l.text}`).join('\n'), ledgerItems, ledgerDecisions };
}

/**
 * The model for practice-fold calls (§9): handoffs and folded spans stay on the
 * conversation's own provider family. The runner handles Claude Code sessions only,
 * so calls are pinned there. A provider that cannot honour the pin yields null, which
 * the runner records as `no-judge`: the fold stops rather than risk another vendor.
 */
export function foldPinnedIntelligence(base: IntelligenceProvider | null | undefined): IntelligenceProvider | null {
  if (!base) return null;
  if (base instanceof IntelligenceRouter) {
    return { evaluate: (prompt, options) => base.evaluate(prompt, { ...options, pinnedFramework: CLAUDE_CODE_FRAMEWORK }) };
  }
  // No router means no routing or swap, so the single provider must itself say it is Claude.
  return base.frameworkId === CLAUDE_CODE_FRAMEWORK ? base : null;
}

/**
 * A topic row for the handoff flow. `fromUser` here means the verified operator's own
 * typed message (§6.2): a forwarded, relayed or third party's row is never `operator`,
 * so it cannot be labelled or quoted as the operator's words.
 */
export function foldMessageRow(m: TopicMessage, isOperator?: OperatorResolver): { messageId: number; fromUser: boolean; fromOther: boolean; text: string; at: string | null } {
  const isHumanOrPeer = m.fromUser === true || m.origin === 'relay' || m.origin === 'a2a' || m.forwarded === true;
  const op = isHumanOrPeer && classifyRow(m, isOperator).label === 'operator';
  return { messageId: m.messageId, fromUser: op, fromOther: isHumanOrPeer && !op, text: m.text, at: m.timestamp ?? null };
}
