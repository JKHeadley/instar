/**
 * RequiredAckService — the production behaviour of
 * docs/specs/a2a-required-acknowledgment.md, kept out of server.ts and routes.ts
 * so the tests run the same code the server runs.
 *
 * Enforcement is detection and telling the sender. Nothing here blocks a session or
 * a message, nothing is typed into the SENDER's session, and no kinded ack starts or
 * wakes a session. The only input ever typed into a session is one fixed reminder,
 * on the receiving side, carrying server handles only.
 */

import { createAckRateLimiter } from './autoAck.js';
import type { A2ADeliveryTracker } from './A2ADeliveryTracker.js';
import { nowIso } from './A2ADeliveryTracker.js';
import type { PendingRow, WatchRow } from './requiredAckStore.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import {
  HELD_TEXT,
  MAX_ACK_REF_IDS,
  isHeldReason,
  isHeldState,
  parseKindedAck,
  refusalReason,
  requiredAckInstruction,
  requiredAckReminderForPlace,
  PEER_PLACE_SESSION_MARKER,
  requiredAckReminder,
  sanitizeAckSummary,
  summaryProblem,
  type HeldReason,
  type KindedAckWire,
} from './requiredAck.js';

export const DEFAULT_REMINDER_MS = 5 * 60 * 1000;
export const DEFAULT_ATTENTION_MS = 15 * 60 * 1000;
export const DEFAULT_REMINDER_DAILY_CAP = 20;
export const PENDING_TICK_MS = 30 * 1000;
export const PENDING_MAX_BACKOFF_MS = 10 * 60 * 1000;
export const PENDING_TTL_MS = 60 * 60 * 1000;
export const KINDED_ACK_PER_MINUTE = 20;
const FEATURE = 'threadline.requiredAck';

export interface RequiredAckConfigShape {
  threadline?: { requiredAck?: { enabled?: boolean; reminderMs?: number; attentionMs?: number; reminderDailyCap?: number } };
}

/** On unless explicitly false: omitted means on. */
export function resolveRequiredAckEnabled(liveEnabled: boolean | undefined, config: RequiredAckConfigShape): boolean {
  return (liveEnabled ?? config.threadline?.requiredAck?.enabled) !== false;
}

export interface RequiredAckThresholds { reminderMs: number; attentionMs: number; reminderDailyCap: number }

export function resolveRequiredAckThresholds(config: RequiredAckConfigShape): RequiredAckThresholds {
  const c = config.threadline?.requiredAck;
  return {
    reminderMs: c?.reminderMs ?? DEFAULT_REMINDER_MS,
    attentionMs: c?.attentionMs ?? DEFAULT_ATTENTION_MS,
    reminderDailyCap: c?.reminderDailyCap ?? DEFAULT_REMINDER_DAILY_CAP,
  };
}

/** Where a kinded ack goes out: this machine's relay client, or the holder over the mesh. */
export type KindedAckRoute =
  | { kind: 'relay'; send: (peerFp: string, ack: KindedAckWire, text: string, opts: { threadId: string | null; triggerEncrypted: boolean }) => void }
  | { kind: 'forward'; send: (payload: ForwardAckPayload) => Promise<'sent' | 'refused'> }
  | { kind: 'none' };

export interface ForwardAckPayload {
  peerFp: string;
  ack: KindedAckWire;
  text: string;
  threadId: string | null;
  triggerEncrypted: boolean;
  /** The capability this machine has for the peer, for a new holder without a row. */
  ackKinds: number | null;
}

export interface RequiredAckDeps {
  tracker: A2ADeliveryTracker;
  enabled: () => boolean;
  thresholds: () => RequiredAckThresholds;
  route: () => KindedAckRoute;
  /** A relay standby: a missing caps row means unknown, and the holder decides. */
  isStandby: () => boolean;
  hasTrustProfile: (peerFp: string) => boolean;
  /** Peer paired by invite: its `read` must arrive encrypted and signed. */
  isPinned: (peerFp: string) => boolean;
  isSessionAlive: (sessionName: string) => boolean;
  /** Type fixed text into a session as queued input. Never peer text. */
  injectReminder: (sessionName: string, text: string) => boolean;
  /** The launch lane of a live session, when known. */
  laneOf?: (sessionName: string) => 'interactive' | 'headless' | null;
  /** The peer of a thread, when no watch row names it. */
  threadPeer?: (threadId: string) => string | null;
  now?: () => number;
  log?: (line: string) => void;
}

/** What the relay handler carries through the router for one watched message. */
export interface RequiredAckHandle {
  watchId: number;
  ackRef: string;
  instruction: string;
  receipt: QueuedReceipt;
}

/** Travels with a spawn-queue entry so the queue can report its fate. No content. */
export interface QueuedReceipt {
  watchId: number;
  peerFp: string;
  messageId: string;
  threadId: string | null;
}

export type QueueDropCause = 'expired' | 'evicted';

export interface RouterResultShape {
  delivered?: boolean;
  queued?: boolean;
  spawnQueued?: boolean;
  error?: string;
  threadId?: string;
  sessionName?: string;
  path?: string;
  remoteTopic?: boolean;
  deliveryPending?: Promise<{ delivered: boolean; reason: string }>;
}

export interface AckToolResult {
  status: number;
  body: Record<string, unknown>;
}

export class RequiredAckService {
  private readonly d: RequiredAckDeps;
  private readonly outboundLimited: (peerFp: string) => boolean;
  private readonly inboundLimited: (peerFp: string) => boolean;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private flushChain: Promise<number> = Promise.resolve(0);
  /** Kinded acks consumed with no effect, by why. Log-only evidence on the authed read. */
  readonly counters = { honoured: 0, ignoredRow: 0, ignoredUnverified: 0, ignoredUnknownKind: 0, inboundLimited: 0, heldSent: 0, heldSkippedLimit: 0, reminders: 0, unacknowledged: 0, pendingSent: 0, pendingExpired: 0 };

  constructor(deps: RequiredAckDeps) {
    this.d = deps;
    const now = () => this.nowMs();
    this.outboundLimited = createAckRateLimiter(KINDED_ACK_PER_MINUTE, 60_000, now);
    this.inboundLimited = createAckRateLimiter(KINDED_ACK_PER_MINUTE, 60_000, now);
  }

  private nowMs(): number { return this.d.now ? this.d.now() : Date.now(); }
  private iso(ms: number = this.nowMs()): string { return nowIso(new Date(ms)); }
  private get store() { return this.d.tracker.ackStore; }
  private log(line: string): void { (this.d.log ?? ((l: string) => console.log(l)))(line); }

  // ── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Boot: journal rows still open were interrupted by a restart, and become pending
   * `unknown`. The wording does not assert loss, because a crash between hand-off
   * and the callback looks the same.
   */
  recoverAfterRestart(): number {
    const rows = this.store.interruptedWatches();
    const at = this.iso();
    for (const row of rows) {
      if (this.store.peerAckKinds(row.peerFp) !== null) {
        this.queuePending(row, 'held', 'unknown', 'restart', at);
      }
      this.store.closeWatch(row.id, 'restart', at);
    }
    return rows.length;
  }

  /** The new 30-second timer (the tracker's only other one is a 15-minute sweep). */
  start(intervalMs: number = PENDING_TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ── D1: capability + inbound ──────────────────────────────────────

  /** Called after the trust check for every non-ack, non-status message. */
  notePeerMessage(peerFp: string, content: unknown): void {
    const stamp = typeof content === 'object' && content !== null ? (content as { ackKinds?: unknown }).ackKinds : undefined;
    try { this.store.notePeerCaps(peerFp, stamp, this.iso()); } catch (err) {
      this.log(`[required-ack] capability record failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * The ack-stage branch. Honoured only when EVERY referenced id is a row we sent to
   * this same fingerprint; otherwise consumed and logged with no effect, which covers
   * strangers and the relay. `held` calls nothing on the delivery state; `read` flips
   * exactly its rows. Never acks, never routes, never starts or wakes a session.
   */
  consumeInboundAck(input: { from: string; ack: KindedAckWire; arrivedEncrypted: boolean }): 'honoured' | 'ignored' | 'limited' {
    const { from, ack } = input;
    const short = from.slice(0, 8);
    if (this.inboundLimited(from)) {
      this.counters.inboundLimited++;
      this.log(`[required-ack] kinded ack from ${short} over the per-peer limit — consumed, no effect`);
      return 'limited';
    }
    if (ack.kind !== 'held' && ack.kind !== 'read') {
      this.counters.ignoredUnknownKind++;
      this.log(`[required-ack] kinded ack from ${short} with an unknown kind — consumed, no effect`);
      return 'ignored';
    }
    const ids = ack.refMessageIds.slice(0, MAX_ACK_REF_IDS);
    const fp = from.toLowerCase();
    const rowsMatch = ids.length > 0 && ids.every((id) => this.d.tracker.get(id)?.peerFp?.toLowerCase() === fp);
    if (!rowsMatch) {
      this.counters.ignoredRow++;
      this.log(`[required-ack] kinded ack from ${short} names no row sent to it — consumed, no effect`);
      return 'ignored';
    }
    if (ack.kind === 'read') {
      let pinned = true; // an unreadable pin is treated as pinned: refusal only removes an effect
      try { pinned = this.d.isPinned(from); } catch { /* @silent-fallback-ok — stays pinned */ }
      if (pinned && !input.arrivedEncrypted) {
        this.counters.ignoredUnverified++;
        this.log(`[required-ack] read from pinned peer ${short} arrived unencrypted — consumed, no effect`);
        return 'ignored';
      }
      for (const id of ids) this.d.tracker.recordRead(id, ack.summary);
    } else {
      if (!isHeldState(ack.state)) {
        this.counters.ignoredUnknownKind++;
        return 'ignored';
      }
      const reason = isHeldReason(ack.reason) ? ack.reason : null;
      for (const id of ids) this.d.tracker.recordHeld(id, ack.state, reason);
    }
    this.counters.honoured++;
    return 'honoured';
  }

  // ── Before the router ─────────────────────────────────────────────

  /**
   * The handle for one inbound message about to go through the router, or null when
   * the feature is off, the peer has not advertised support, or the message has no id
   * to refer to.
   */
  prepare(input: { peerFp: string; messageId: string | undefined; threadId: string | null | undefined; triggerEncrypted: boolean }): RequiredAckHandle | null {
    try {
      if (!this.d.enabled() || !input.messageId) return null;
      if (this.store.peerAckKinds(input.peerFp) === null) return null;
      const row = this.store.prepareWatch({
        peerFp: input.peerFp, messageId: input.messageId, threadId: input.threadId ?? null,
        triggerEncrypted: input.triggerEncrypted, at: this.iso(),
      });
      return {
        watchId: row.id,
        ackRef: row.ackRef,
        instruction: requiredAckInstruction(row.ackRef),
        receipt: { watchId: row.id, peerFp: input.peerFp, messageId: input.messageId, threadId: input.threadId ?? null },
      };
    } catch (err) {
      this.log(`[required-ack] prepare failed (the message routes as before): ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // ── D2/D5: after the router ───────────────────────────────────────

  /** Settle one router result. Never throws into routing. */
  settleRouterResult(handle: RequiredAckHandle | null, result: RouterResultShape): void {
    if (!handle) return;
    try {
      const { receipt } = handle;
      if (result.deliveryPending) {
        // A reply typed into a busy session. This can last ten minutes.
        this.sendHeldBestEffort(receipt, 'waiting', this.reasonFor(receipt.peerFp, undefined), HELD_TEXT.pending);
        void result.deliveryPending.then(({ delivered }) => {
          try {
            if (delivered) this.onDelivered(receipt, { sessionName: result.sessionName ?? null, threadId: result.threadId ?? null });
            else {
              this.sendHeldBestEffort(receipt, 'waiting', this.reasonFor(receipt.peerFp, undefined), HELD_TEXT.pending);
              this.store.closeWatch(handle.watchId, 'not-delivered', this.iso());
            }
          } catch (err) {
            console.warn(`[required-ack] settling a queued reply failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }, () => { /* @silent-fallback-ok — the router's settle already logged it */ });
        return;
      }
      if (result.delivered === true) {
        if (result.remoteTopic) {
          this.store.markNotWatched(handle.watchId, this.iso());
          return;
        }
        this.onDelivered(receipt, { sessionName: result.sessionName ?? null, threadId: result.threadId ?? null });
        return;
      }
      if (result.spawnQueued === true) {
        this.store.markQueued(handle.watchId, result.threadId ?? null);
        this.sendHeldBestEffort(receipt, 'queued', refusalReason(result.error, this.safeHasProfile(receipt.peerFp)), HELD_TEXT.received);
        return;
      }
      const state = result.queued === true ? 'waiting' : 'refused';
      this.sendHeldBestEffort(receipt, state, refusalReason(result.error, this.safeHasProfile(receipt.peerFp)), HELD_TEXT.received);
      this.store.closeWatch(handle.watchId, state === 'waiting' ? 'waiting' : 'refused', this.iso());
    } catch (err) {
      this.log(`[required-ack] settle failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * A session received the message: the router's report, or the spawn manager's
   * delivered callback from its queue commit. A later expiry of an earlier queued
   * copy then sends nothing, because the row records the hand-off.
   */
  onDelivered(receipt: QueuedReceipt, session: { sessionName: string | null; interactive?: boolean; threadId?: string | null }): void {
    try {
      let lane: 'interactive' | 'headless' = session.interactive === false ? 'headless' : 'interactive';
      if (session.sessionName && this.d.laneOf) {
        lane = this.d.laneOf(session.sessionName) ?? lane;
      }
      this.store.openWatch(receipt.watchId, { sessionName: session.sessionName, lane, threadId: session.threadId ?? null, at: this.iso() });
    } catch (err) {
      this.log(`[required-ack] watch open failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  /** D3: a queue entry died at one of the spawn manager's drop sites. */
  onQueueDropped(receipt: QueuedReceipt, cause: QueueDropCause): void {
    try {
      if (!this.store.dropCopy(receipt.watchId)) return;
      const at = this.iso();
      const row: Pick<WatchRow, 'peerFp' | 'messageId' | 'threadId' | 'triggerEncrypted'> = this.store.watchForMessage(receipt.peerFp, receipt.messageId)
        ?? { peerFp: receipt.peerFp, messageId: receipt.messageId, threadId: receipt.threadId, triggerEncrypted: false };
      this.store.closeWatch(receipt.watchId, 'dropped', at);
      if (this.d.enabled() && this.store.peerAckKinds(receipt.peerFp) !== null) {
        this.queuePending(row, 'held', 'dropped', cause, at);
        void this.flushPending().catch(() => { /* @silent-fallback-ok — the timer retries */ });
      }
    } catch (err) {
      this.log(`[required-ack] drop handling failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  /** D5 close: a session-authored send was accepted. The caller guarantees "session-authored + accepted". */
  onSessionSendAccepted(peerFp: string | null | undefined, threadId: string | null | undefined): void {
    if (!peerFp || !threadId) return;
    try { this.store.closeOnReply(peerFp, threadId, this.iso()); } catch (err) {
      this.log(`[required-ack] reply close failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── D4: the session's acknowledgment ──────────────────────────────

  /** POST /threadline/ack. Success means the `read` is durably accepted as a pending row. */
  async acceptSessionAck(input: { threadId?: unknown; ackRefs?: unknown; summary?: unknown; peerFp?: string }): Promise<AckToolResult> {
    if (!this.d.enabled()) return { status: 200, body: { sent: false, reason: 'disabled' } };
    const problem = summaryProblem(input.summary);
    if (problem) return { status: 400, body: { sent: false, error: problem } };
    const threadId = typeof input.threadId === 'string' && input.threadId ? input.threadId : null;
    const refs = Array.isArray(input.ackRefs) ? input.ackRefs.filter((r): r is string => typeof r === 'string' && r.length > 0).slice(0, 50) : [];
    if (refs.length === 0) return { status: 400, body: { sent: false, error: 'ackRefs must name at least one handle' } };
    const summary = sanitizeAckSummary(input.summary) as string;

    const rows: WatchRow[] = [];
    const unknown: string[] = [];
    for (const ref of refs) {
      const row = this.store.watchForRef(ref);
      // The ack covers only the handles listed: a handle proves receipt of that message and no other.
      // A peer place acknowledges only its own peer's messages (memory-privacy-agent-places §5).
      if (!row || (threadId && row.threadId && row.threadId !== threadId) || (input.peerFp && row.peerFp !== input.peerFp)) unknown.push(ref);
      else rows.push(row);
    }
    if (rows.length === 0) {
      const peer = threadId ? this.d.threadPeer?.(threadId) ?? null : null;
      if (peer && !this.d.isStandby() && this.store.peerAckKinds(peer) === null) {
        return { status: 200, body: { sent: false, reason: 'peer-does-not-support' } };
      }
      return { status: 200, body: { sent: false, reason: 'unknown-ack-ref', unknownRefs: unknown } };
    }

    const at = this.iso();
    const expiresAt = this.iso(this.nowMs() + PENDING_TTL_MS);
    const accepted: string[] = [];
    let unsupported = false;
    for (const row of rows) {
      // On a standby, a missing caps row means unknown: forward, and the holder decides.
      if (this.store.peerAckKinds(row.peerFp) === null && !this.d.isStandby()) { unsupported = true; continue; }
      this.store.acceptRead({ watch: row, summary, at, expiresAt });
      accepted.push(row.ackRef);
    }
    if (accepted.length === 0 && unsupported) return { status: 200, body: { sent: false, reason: 'peer-does-not-support' } };
    featureEvidence.record(FEATURE, { kind: 'fired', reason: 'session-acknowledged', context: { handles: accepted.length } });
    // Tried as soon as it is written; a limit or a dead relay leaves the pending row for the timer.
    try { await this.flushPending(); } catch { /* @silent-fallback-ok — the timer retries */ }
    return { status: 200, body: { sent: true, accepted: accepted.length, ...(unknown.length ? { unknownRefs: unknown } : {}) } };
  }

  // ── D5 + D1: the tick ─────────────────────────────────────────────

  /** One pass: reminders, unacknowledged, pending sends. Single-flight, bounded. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.d.enabled()) this.runWatchPass();
      await this.flushPending();
    } catch (err) {
      this.log(`[required-ack] tick failed (retrying next tick): ${err instanceof Error ? err.message : err}`);
    } finally {
      this.ticking = false;
    }
  }

  private runWatchPass(): void {
    const now = this.nowMs();
    const { reminderMs, attentionMs, reminderDailyCap } = this.d.thresholds();
    const at = this.iso(now);
    const dueReminders = new Map<string, WatchRow[]>();

    for (const row of this.store.openWatches()) {
      const openedMs = row.openedAt ? Date.parse(row.openedAt) : now;
      const age = now - openedMs;
      const alive = row.sessionName ? this.safeAlive(row.sessionName) : null;
      // 15 minutes, or at once if the session has ended. Wording claims no cause.
      if (age >= attentionMs || alive === false) {
        this.queuePending(row, 'held', 'unacknowledged', null, at);
        this.store.closeWatch(row.id, 'unacknowledged', at);
        this.counters.unacknowledged++;
        featureEvidence.record(FEATURE, { kind: 'held', reason: 'unacknowledged', context: { peerFp: row.peerFp, sessionEnded: alive === false } });
        continue;
      }
      // A headless one-shot worker cannot read a reminder: it goes straight to the next step.
      if (age >= reminderMs && !row.remindedAt && row.launchLane === 'interactive' && row.sessionName && alive) {
        const key = `${row.sessionName}\u0000${row.peerFp}`;
        const list = dueReminders.get(key) ?? [];
        list.push(row);
        dueReminders.set(key, list);
      }
    }

    // Per session and peer, so a burst of 50 messages is one reminder.
    const daySince = this.iso(now - 24 * 60 * 60 * 1000);
    for (const rows of dueReminders.values()) {
      const { sessionName, peerFp } = rows[0];
      if (this.store.remindersSince(peerFp, daySince) >= reminderDailyCap) continue; // past the cap the reminder step is skipped
      let typed = false;
      const reminderRefs = rows.map((r) => r.ackRef).slice(0, 50);
      const reminder = String(sessionName).includes(PEER_PLACE_SESSION_MARKER) ? requiredAckReminderForPlace(reminderRefs) : requiredAckReminder(reminderRefs);
      try { typed = this.d.injectReminder(sessionName as string, reminder); } catch (err) {
        this.log(`[required-ack] reminder failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
      if (typed) {
        this.store.markReminded(rows.map((r) => r.id), at);
        this.counters.reminders++;
      }
    }
  }

  /** Send every due pending row, coalesced per peer and outcome. One pass at a time. */
  flushPending(): Promise<number> {
    const run = () => this.runFlush();
    this.flushChain = this.flushChain.then(run, run);
    return this.flushChain;
  }

  private async runFlush(): Promise<number> {
    if (!this.d.enabled()) return 0;
    const now = this.nowMs();
    const nowStr = this.iso(now);
    const expired = this.store.expirePending(nowStr);
    if (expired > 0) {
      this.counters.pendingExpired += expired;
      featureEvidence.record(FEATURE, { kind: 'error', reason: 'pending-expired', context: { rows: expired } });
    }
    const due = this.store.duePending(nowStr);
    if (due.length === 0) return 0;
    const groups = new Map<string, PendingRow[]>();
    for (const row of due) {
      const key = [row.peerFp, row.ackKind, row.ackState ?? '', row.ackReason ?? '', row.summary ?? '', row.triggerEncrypted ? '1' : '0'].join('\u0000');
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    let sent = 0;
    for (const rows of groups.values()) {
      for (let i = 0; i < rows.length; i += MAX_ACK_REF_IDS) {
        const batch = rows.slice(i, i + MAX_ACK_REF_IDS);
        if (await this.sendBatch(batch, now)) sent += batch.length;
      }
    }
    return sent;
  }

  private async sendBatch(rows: PendingRow[], now: number): Promise<boolean> {
    const first = rows[0];
    const ids = rows.map((r) => r.id);
    const ack = pendingToWire(rows);
    const retry = (): false => {
      const attempts = first.attempts + 1;
      const wait = Math.min(PENDING_TICK_MS * 2 ** Math.max(0, attempts - 1), PENDING_MAX_BACKOFF_MS);
      this.store.markPendingRetry(ids, attempts, this.iso(now + wait));
      return false;
    };
    const route = this.d.route();
    if (route.kind === 'none') return retry();
    if (route.kind === 'relay') {
      // A kinded ack goes only to a peer with a row: one that rolled back since this
      // was queued stopped advertising, and would route the text to a session.
      if (this.store.peerAckKinds(first.peerFp) === null) {
        this.store.closePending(ids, 'peer-does-not-support', this.iso(now));
        return false;
      }
      // A limited send waits: no attempt is counted against it.
      if (this.outboundLimited(first.peerFp)) {
        this.store.markPendingRetry(ids, first.attempts, this.iso(now + PENDING_TICK_MS));
        return false;
      }
      try {
        route.send(first.peerFp, ack, pendingText(first), { threadId: first.threadId, triggerEncrypted: first.triggerEncrypted });
      } catch (err) {
        this.log(`[required-ack] pending send to ${first.peerFp.slice(0, 8)} failed (will retry): ${err instanceof Error ? err.message : err}`);
        return retry();
      }
    } else {
      let answer: 'sent' | 'refused' = 'refused';
      try {
        answer = await route.send({
          peerFp: first.peerFp, ack, text: pendingText(first), threadId: first.threadId,
          triggerEncrypted: first.triggerEncrypted, ackKinds: this.store.peerAckKinds(first.peerFp),
        });
      } catch { /* @silent-fallback-ok — unknown is retried; the receiver's state is monotonic */ }
      if (answer !== 'sent') return retry();
    }
    this.store.markPendingSent(ids, this.iso(now));
    this.counters.pendingSent += ids.length;
    return true;
  }

  // ── Holder side of the forward verb ───────────────────────────────

  /**
   * `a2a-relay-forward-ack`: the machine holding the relay sends a standby's kinded
   * ack. Decides from its own caps row, else the capability the standby has, for a
   * new holder without a row.
   */
  handleForwardedAck(payload: Partial<ForwardAckPayload>, deps: { relay: Extract<KindedAckRoute, { kind: 'relay' }> | null }): { outcome: 'sent' } | { outcome: 'refused'; reason: string } {
    if (!this.d.enabled()) return { outcome: 'refused', reason: 'required-ack-disabled' };
    if (!deps.relay) return { outcome: 'refused', reason: 'holder-is-standby' };
    const ack = parseKindedAck({ type: 'ack', ack: payload.ack });
    if (typeof payload.peerFp !== 'string' || !payload.peerFp || !ack || typeof payload.text !== 'string') {
      return { outcome: 'refused', reason: 'invalid-payload' };
    }
    const own = this.store.peerAckKinds(payload.peerFp);
    const theirs = typeof payload.ackKinds === 'number' && payload.ackKinds >= 1 ? payload.ackKinds : null;
    if (own === null && theirs === null) return { outcome: 'refused', reason: 'peer-does-not-support' };
    if (this.outboundLimited(payload.peerFp)) return { outcome: 'refused', reason: 'rate-limited' };
    try {
      deps.relay.send(payload.peerFp, ack, payload.text, { threadId: payload.threadId ?? null, triggerEncrypted: payload.triggerEncrypted === true });
      return { outcome: 'sent' };
    } catch (err) {
      return { outcome: 'refused', reason: err instanceof Error ? err.message.slice(0, 120) : 'send-failed' };
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private queuePending(
    row: Pick<WatchRow, 'peerFp' | 'messageId' | 'threadId' | 'triggerEncrypted'>,
    kind: 'held', state: 'dropped' | 'unknown' | 'unacknowledged', reason: HeldReason | null, at: string,
  ): number {
    return this.store.addPending({
      peerFp: row.peerFp, messageId: row.messageId, threadId: row.threadId, ackKind: kind,
      ackState: state, ackReason: reason, triggerEncrypted: row.triggerEncrypted,
      at, expiresAt: this.iso(Date.parse(at) + PENDING_TTL_MS),
    });
  }

  /** Immediate `held` receipts are best-effort: over the limit or on a failed send, nothing more happens. */
  private sendHeldBestEffort(receipt: QueuedReceipt, state: 'queued' | 'waiting' | 'refused', reason: HeldReason, text: string): void {
    const route = this.d.route();
    if (route.kind !== 'relay') return; // receipts are sent by the machine holding the relay connection
    if (this.outboundLimited(receipt.peerFp)) {
      this.counters.heldSkippedLimit++;
      return;
    }
    const watch = this.store.watchForMessage(receipt.peerFp, receipt.messageId);
    try {
      route.send(receipt.peerFp, { kind: 'held', state, reason, refMessageIds: [receipt.messageId] }, text, {
        threadId: receipt.threadId,
        triggerEncrypted: watch?.triggerEncrypted === true,
      });
      this.counters.heldSent++;
      featureEvidence.recordAtMostEvery(FEATURE, `held|${state}|${receipt.peerFp}`, 10 * 60 * 1000, { kind: 'fired', reason: `held-${state}`, context: { peerFp: receipt.peerFp, why: reason } });
    } catch (err) {
      this.log(`[required-ack] held receipt to ${receipt.peerFp.slice(0, 8)} failed (best-effort): ${err instanceof Error ? err.message : err}`);
    }
  }

  private reasonFor(peerFp: string, error: string | undefined): HeldReason {
    return refusalReason(error, this.safeHasProfile(peerFp));
  }

  private safeHasProfile(peerFp: string): boolean {
    try { return this.d.hasTrustProfile(peerFp); } catch { return false; /* @silent-fallback-ok — a stranger gets `busy`, which tells less */ }
  }

  private safeAlive(sessionName: string): boolean | null {
    try { return this.d.isSessionAlive(sessionName); } catch { return null; /* @silent-fallback-ok — unknown never ends a watch early */ }
  }
}

function pendingToWire(rows: PendingRow[]): KindedAckWire {
  const first = rows[0];
  return {
    kind: first.ackKind,
    ...(first.ackState ? { state: first.ackState } : {}),
    ...(first.ackReason ? { reason: first.ackReason } : {}),
    refMessageIds: rows.map((r) => r.messageId),
    ...(first.summary ? { summary: first.summary } : {}),
  };
}

function pendingText(row: PendingRow): string {
  if (row.ackKind === 'read') return HELD_TEXT.read;
  if (row.ackState === 'unacknowledged') return HELD_TEXT.unacknowledged;
  if (row.ackState === 'unknown') return HELD_TEXT.restart;
  return row.ackReason === 'evicted' ? HELD_TEXT.evicted : HELD_TEXT.expired;
}

