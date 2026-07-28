/**
 * threadSymmetry — the cross-end symmetry state machine + the participant-
 * authorized, terminating convergence backfill (Robustness Phase 2, D-D).
 *
 * Symmetry is ADVISORY-ONLY (Signal vs. Authority): it never blocks a send, never
 * binds, never gates an irreversible action. Divergence is surfaced loudly (ONE
 * deduped Attention item per (thread, episode)) and an upgraded pair can converge
 * via a bounded backfill, but a forged `verified` only misleads an auditor — it
 * grants nothing (SA3 honest bound).
 *
 * Authorization is the keystone (SA1): every participant check keys on the
 * fingerprint DERIVED from the verified Ed25519 signature — NEVER a name header or
 * a body/envelope `from` field. A representation mismatch fails CLOSED.
 */

import {
  computeSetAccum,
  contentDigest,
  DIGEST_VERSION,
  type ThreadSync,
} from './threadDigest.js';
import type { ThreadLog, ThreadDirection } from './ThreadLog.js';
import type { ConversationStore } from './ConversationStore.js';
import type { ThreadMessageRecorder } from './recordThreadMessage.js';

/** The closed set of advisory symmetry states (FD-6). Only the diverged-* states are actionable. */
export type SymmetryState =
  | 'verified'
  | 'diverged'
  | 'diverged-unreconcilable'
  | 'version-skew'
  | 'unverified-peer-legacy'
  | 'unverified-backfill'
  | 'local-integrity-fault'
  | 'unknown';

/** The dependency bundle the symmetry surfaces read (a subset of CanonicalHistoryDeps). */
export interface SymmetryDeps {
  threadLog?: ThreadLog;
  conversationStore?: ConversationStore;
  threadMessageRecorder?: ThreadMessageRecorder;
  backfillMaxDigestsPerRequest?: number;
  backfillMaxRecordsPerResponse?: number;
  attention?: { createAttentionItem?: (item: { id: string; title: string; summary: string; category: string; priority: 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW'; sourceContext?: string }) => unknown } | null;
  /**
   * Gated (dev-live/fleet-dark) active backfill pull. Present ONLY when the
   * convergence-backfill feature is enabled. On a confirmed `diverged`, ONE bounded
   * round is initiated: this posts an authenticated backfill request to the peer
   * (returning its records) — the caller recomputes + ingests them (SA4). Absent →
   * divergence is detect-and-surface only (the core fleet posture).
   */
  backfillInitiator?: (threadId: string, missingDigests: string[]) => Promise<BackfillRecord[]>;
}

/** A backfill wire record — the requester recomputes EVERYTHING else (SA4). */
export interface BackfillRecord {
  messageId: string;
  body: string;
  createdAt: string;
  direction: ThreadDirection;
}

/**
 * Derive the advisory symmetry state from the local head + a (verified-participant)
 * peer threadSync. Pure — the caller persists it.
 */
export function computeSymmetryState(opts: {
  localCount: number;
  localSetAccum: string;
  peerSync?: { digestVersion: number; count: number; setAccum: string } | null;
  hasBackfilled: boolean;
  localVerifyOk: boolean;
  /** Already terminal-unreconcilable → stays sticky terminal (SA2). */
  sticky?: boolean;
  /** Peer is upgraded (sent threadSync at least once) but this report is absent. */
  peerEverReported?: boolean;
}): SymmetryState {
  if (opts.sticky) return 'diverged-unreconcilable';
  if (!opts.localVerifyOk) return 'local-integrity-fault';
  if (!opts.peerSync) return opts.peerEverReported ? 'unknown' : 'unverified-peer-legacy';
  // version-skew is logged, NOT collapsed into the benign legacy bucket (closes F4 downgrade).
  if (opts.peerSync.digestVersion !== DIGEST_VERSION) return 'version-skew';
  if (opts.hasBackfilled) return 'unverified-backfill';
  if (opts.peerSync.count === opts.localCount && opts.peerSync.setAccum === opts.localSetAccum) return 'verified';
  return 'diverged';
}

/** Build this end's threadSync for a thread (the additive wire field). */
export function localThreadSync(threadLog: ThreadLog, threadId: string): ThreadSync {
  const head = threadLog.head(threadId);
  return { digestVersion: DIGEST_VERSION, count: head.count, setAccum: head.setAccum };
}

/** True if `fp` is a recorded participant of the thread (verified-fp only — SA1). */
function isParticipant(deps: SymmetryDeps, threadId: string, fp: string): boolean {
  if (deps.threadLog?.participants(threadId).has(fp)) return true;
  const conv = deps.conversationStore?.get(threadId);
  return !!conv?.participants.peers.includes(fp);
}

/**
 * Honor a peer's piggybacked threadSync: participant-scoped (SA1) + monotonic
 * (anti-replay), then recompute + persist the advisory symmetry state. A threadSync
 * for a NON-participant thread is dropped, never surfaced. Returns the new state.
 */
export async function honorPeerThreadSync(
  deps: SymmetryDeps,
  threadId: string,
  verifiedFp: string,
  peerSync: ThreadSync,
): Promise<SymmetryState> {
  const { threadLog, conversationStore } = deps;
  if (!threadLog || !conversationStore) return 'unknown';
  // SA1: verified-fp participant check — a representation mismatch fails CLOSED.
  if (!isParticipant(deps, threadId, verifiedFp)) return 'unknown';

  const conv = conversationStore.get(threadId);
  const sticky = conv?.symmetryState === 'diverged-unreconcilable';
  // Monotonic guard (Phase-1 epoch lesson): a stale/replayed lower count never
  // regresses the view (unless we're already terminal, which stays sticky).
  const lastPeerCount = conv?.peerThreadSync?.count ?? -1;
  if (!sticky && peerSync.count < lastPeerCount) {
    return (conv?.symmetryState as SymmetryState) ?? 'unknown';
  }

  const head = threadLog.head(threadId);
  const verifyOk = threadLog.verify(threadId).ok;
  const hasBackfilled = threadLog.hasBackfilledLegs(threadId);
  const state = computeSymmetryState({
    localCount: head.count,
    localSetAccum: head.setAccum,
    peerSync,
    hasBackfilled,
    localVerifyOk: verifyOk,
    sticky,
    peerEverReported: true,
  });
  await conversationStore.stampSymmetry(threadId, state, { ...peerSync, at: new Date().toISOString() });

  if (state !== 'diverged') return state;

  // Confirmed divergence. If the convergence-backfill is enabled (dev-gated), run
  // EXACTLY ONE bounded round (SA2). Otherwise (fleet core posture) detect-and-
  // surface only. Either way, the episode raises at most ONE deduped Attention item.
  if (deps.backfillInitiator) {
    return runBackfillEpisode(deps, threadId, verifiedFp, peerSync);
  }
  raiseDivergenceAttention(deps, threadId, false);
  return state;
}

/**
 * Run ONE bounded, terminating backfill round on a confirmed divergence (SA2). On
 * success that reconciles → `verified`/`unverified-backfill`. If still diverged
 * after the single round → STICKY terminal `diverged-unreconcilable`: it stops
 * requesting and raises the ONE deduped Attention item, and stays terminal —
 * suppressing all further rounds + Attention for the thread (each new divergent leg
 * is still LOGGED so F3 holds, but mints no new episode) until an explicit reset.
 */
async function runBackfillEpisode(
  deps: SymmetryDeps,
  threadId: string,
  verifiedFp: string,
  peerSync: ThreadSync,
): Promise<SymmetryState> {
  const { threadLog, conversationStore, backfillInitiator } = deps;
  if (!threadLog || !conversationStore || !backfillInitiator) return 'diverged';
  try {
    // Anti-entropy pull: request the peer's bounded record set (it serves only
    // threads we participate in). We recompute + ingest idempotently; only legs we
    // genuinely lack are appended (duplicates no-op). Empty `missingDigests` ⇒
    // "send your live set, bounded" (we can't derive exact gaps from a sum alone).
    const records = await backfillInitiator(threadId, []);
    // Anti-entropy ingest: accept participant-authorized records, recompute locally.
    ingestBackfill(deps, threadId, verifiedFp, records, null);
  } catch { /* @silent-fallback-ok: a failed pull just leaves us diverged → terminal below */ }

  // Re-evaluate against the SAME peer report after the single round.
  const head = threadLog.head(threadId);
  const reconciled = head.count === peerSync.count && head.setAccum === peerSync.setAccum;
  if (reconciled && !threadLog.hasBackfilledLegs(threadId)) {
    await conversationStore.stampSymmetry(threadId, 'verified');
    return 'verified';
  }
  if (reconciled) {
    await conversationStore.stampSymmetry(threadId, 'unverified-backfill');
    return 'unverified-backfill';
  }
  // Still diverged after one round → STICKY terminal (suppresses all further episodes).
  await conversationStore.stampSymmetry(threadId, 'diverged-unreconcilable');
  raiseDivergenceAttention(deps, threadId, true);
  return 'diverged-unreconcilable';
}

/**
 * Serve a participant-authorized, bounded backfill response (SA1). Returns records
 * ONLY for a thread the verified requester PARTICIPATES in, and only for
 * contentDigests already in that thread's log. A non-participant request returns
 * EMPTY (the caller counts the refusal — closes cross-thread exfiltration).
 */
export function serveBackfill(
  deps: SymmetryDeps,
  threadId: string,
  verifiedFp: string,
  missingDigests: string[],
): BackfillRecord[] {
  const { threadLog } = deps;
  if (!threadLog) return [];
  if (!isParticipant(deps, threadId, verifiedFp)) return []; // SA1 — fail closed, empty
  const reqCap = deps.backfillMaxDigestsPerRequest ?? 100;
  const respCap = deps.backfillMaxRecordsPerResponse ?? 50;
  // Empty `missingDigests` = anti-entropy: serve the bounded live set (capped). A
  // non-empty request serves ONLY the specifically-requested digests.
  const want = missingDigests.length ? new Set(missingDigests.slice(0, reqCap)) : null;
  const out: BackfillRecord[] = [];
  // Bounded synchronous read of the live log (read-until-cap; NEVER a full scan / spawn).
  for (const e of threadLog.read(threadId, { limit: 100000 }).entries) {
    if (out.length >= respCap) break;
    if (e.backfilled) continue; // never re-serve a leg we ourselves backfilled
    if (want && !want.has(e.contentDigest)) continue;
    const body = e.textRef.kind === 'inline' ? e.textRef.text : '';
    out.push({ messageId: e.messageId, body, createdAt: e.createdAt, direction: e.direction });
  }
  return out;
}

/**
 * Ingest a backfill RESPONSE — UNTRUSTED (SA4). Each record is treated as raw
 * message content: the requester RECOMPUTES `contentDigest` locally, assigns its
 * OWN seq/prevHash/hash via the funnel, stamps `backfilled:true` + the verified
 * responder as author/peer ITSELF, and IGNORES any peer-supplied chain fields. A
 * record whose recomputed digest is NOT among `requestedDigests` is dropped +
 * counted (a responder cannot push unrequested content). Returns the tally.
 */
export function ingestBackfill(
  deps: SymmetryDeps,
  threadId: string,
  verifiedResponderFp: string,
  records: BackfillRecord[],
  /** The digests this side actually requested. `null` = anti-entropy (accept any). */
  requestedDigests: Set<string> | null,
): { ingested: number; dropped: number } {
  const { threadMessageRecorder } = deps;
  if (!threadMessageRecorder) return { ingested: 0, dropped: records.length };
  let ingested = 0;
  let dropped = 0;
  for (const rec of records) {
    // SA4: recompute the digest locally; a record not in what we asked for is dropped
    // (the drop-unrequested guard applies ONLY to a specific request, not anti-entropy).
    const digest = contentDigest({ threadId, messageId: rec.messageId, body: rec.body, createdAt: rec.createdAt });
    if (requestedDigests !== null && !requestedDigests.has(digest)) { dropped += 1; continue; }
    const res = threadMessageRecorder.record({
      threadId,
      messageId: rec.messageId,
      direction: rec.direction,
      body: rec.body,
      createdAt: rec.createdAt,
      backfilled: true, // EXCLUDED from the symmetry accumulator (FD-5)
      peerFingerprint: verifiedResponderFp,
      author: { agentFingerprint: verifiedResponderFp },
    });
    if (res.status === 'appended' || res.status === 'duplicate') ingested += 1;
    else dropped += 1;
  }
  return { ingested, dropped };
}

/**
 * Raise the ONE deduped divergence Attention item (Bounded Notification Surface).
 * The dedup id is stable per thread, so a peer oscillating its claimed digest
 * collapses to one episode.
 */
export function raiseDivergenceAttention(deps: SymmetryDeps, threadId: string, terminal: boolean): void {
  try {
    deps.attention?.createAttentionItem?.({
      // ONE stable dedup id per thread — a peer oscillating its digest, or a stream
      // of new unreconcilable legs, collapses to a SINGLE episode (SA2/Bounded
      // Notification Surface), never one alert per message.
      id: `threadline-symmetry-diverged:${threadId}`,
      title: terminal ? 'Threadline history unreconcilable with peer' : 'Threadline history diverged from peer',
      summary: terminal
        ? `The canonical log for thread ${threadId} could not be reconciled with the peer after a bounded backfill round. This is advisory — it never blocks a message. Resolve with an operator ack / re-bind once the two histories are reconciled.`
        : `The canonical log for thread ${threadId} disagrees with the peer's reported history (count/checksum mismatch). This is advisory — it never blocks a message; an upgraded peer can converge via backfill.`,
      category: 'general',
      priority: 'NORMAL',
      sourceContext: 'threadline-symmetry-diverged',
    });
  } catch { /* @silent-fallback-ok: advisory alert is best-effort; the state is still stamped on the conversation */ }
}
