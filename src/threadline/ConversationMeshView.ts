/**
 * ConversationMeshView — P3.1 of multi-machine coherence: the fold behind
 * `GET /threadline/conversations?scope=mesh` — "which machine holds each
 * agent-to-agent conversation, and is it bound to a topic?".
 *
 * Spec: docs/specs/THREADLINE-CONVERSATION-COHERENCE-SPEC.md §3.2.
 *
 * Rules:
 *  - OWN rows come from the LIVE ConversationStore (the authority — no
 *    journal read for own truth; own-stream journal entries are ignored).
 *  - REPLICA rows fold from peer journal streams under the P1 reader's
 *    existing bounds; fold rows are keyed by the COMPOSITE
 *    (holderMachineId, conversationId); per-stream last-writer on seq
 *    (each machine's own stream is the only writer for its conversations).
 *  - A replica stream marked gapped/suspect renders its rows with an
 *    explicit streamStatus qualifier; a fold that hit a read bound carries
 *    the partial-result flag.
 *  - SIGNAL ONLY: the view answers "where is it?" — it never routes,
 *    re-binds, or closes anything.
 */

import type { Conversation } from './ConversationStore.js';
import type { CoherenceJournalReader, ReaderEntry } from '../core/CoherenceJournalReader.js';

export interface MeshConversationRow {
  kind: 'own' | 'replica';
  conversationId: string;
  peerFingerprint: string;
  holderMachineId: string;
  boundTopicId?: number;
  status: 'open' | 'closed';
  /** Replica rows: the stream's staleness; own rows: 0. */
  stalenessMs: number;
  /** Replica rows: the P1 stream status (current/behind/gapped/suspect/reset). */
  streamStatus?: string;
  /** True when the fold hit a read bound — older lifecycle may be missing. */
  partial?: boolean;
}

export interface MeshViewDeps {
  ownMachineId: string;
  /** The live store's conversations (the authority for own rows). */
  ownConversations: Conversation[];
  /** Absent = local scope: own rows only, no journal read. */
  reader?: CoherenceJournalReader;
  /** P1 reader query limit per call (bounded). */
  limit?: number;
}

const TERMINAL = new Set(['resolved', 'failed', 'archived']);

export function buildMeshConversationView(deps: MeshViewDeps): { rows: MeshConversationRow[]; partial: boolean } {
  const rows: MeshConversationRow[] = [];

  // OWN rows — live store, no journal read (§3.2).
  for (const c of deps.ownConversations) {
    const peer = c.participants?.peers?.[0];
    if (!peer) continue;
    rows.push({
      kind: 'own',
      conversationId: c.threadId,
      peerFingerprint: peer,
      holderMachineId: deps.ownMachineId,
      ...(typeof c.boundTopicId === 'number' ? { boundTopicId: c.boundTopicId } : {}),
      status: TERMINAL.has(c.state) ? 'closed' : 'open',
      stalenessMs: 0,
    });
  }

  // REPLICA rows — fold peer journal streams (bounded; own stream ignored).
  if (!deps.reader) return { rows, partial: false };
  const q = deps.reader.query({ kind: 'threadline-conversation', limit: deps.limit ?? 500 });
  const boundHit = q.truncated;
  // Per-(machine, conversationId) last-writer on seq. Entries arrive
  // newest-first from the reader; first-seen per composite key wins.
  const seen = new Map<string, MeshConversationRow>();
  for (const e of q.entries as ReaderEntry[]) {
    if (e.source !== 'replica') continue; // own truth comes from the live store
    const d = e.data as { action?: string; conversationId?: string; peerFingerprint?: string; topicId?: number };
    if (!d.conversationId || !d.peerFingerprint) continue;
    const key = `${e.machine}::${d.conversationId}`;
    if (seen.has(key)) continue; // newest already folded
    const stream = q.streams[`${e.machine}.threadline-conversation`];
    const row: MeshConversationRow = {
      kind: 'replica',
      conversationId: d.conversationId,
      peerFingerprint: d.peerFingerprint,
      holderMachineId: e.machine,
      status: d.action === 'closed' ? 'closed' : 'open',
      stalenessMs: stream?.stalenessMs ?? 0,
    };
    // The newest entry's action implies the binding: 'bound' carries the
    // topic; 'started'/'closed' may carry it; 'unbound' clears it.
    if (d.action !== 'unbound' && typeof d.topicId === 'number') row.boundTopicId = d.topicId;
    if (stream && stream.status !== 'current') row.streamStatus = stream.status;
    if (boundHit) row.partial = true;
    seen.set(key, row);
  }
  rows.push(...seen.values());
  return { rows, partial: boundHit };
}
