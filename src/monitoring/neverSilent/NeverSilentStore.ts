/**
 * Never-Silent Conversation (docs/specs/never-silent-conversation.md §3.1, §3.4, §4).
 *
 * The durable record of every inbound message still owed an answer ("obligation"),
 * and of every silence incident opened for a conversation. One JSON file per agent,
 * written atomically, mode 0600 (it holds the waiting message text so a recovery can
 * re-drive it into a replacement session — it never leaves this machine).
 *
 * States (§3.1): pending → answered | told-pending → answered | released.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type ConversationPlatform = 'telegram' | 'slack';
export type ObligationState = 'pending' | 'told-pending' | 'answered' | 'released';

export interface Obligation {
  id: string;
  platform: ConversationPlatform;
  conversationKey: string;
  inboundMessageId: string;
  /** The waiting message, kept only so a recovery can re-drive it. Cleared when the obligation closes. */
  text: string | null;
  senderName?: string;
  acceptedAt: number;
  deadlineAt: number;
  state: ObligationState;
  /** A standby line (PresenceProxy) was delivered for this conversation after acceptance (§3.4 waiting notice). */
  standbySeenAt?: number;
  /** Notice kinds that already covered this obligation. */
  coveredBy: Array<'waiting' | 'status'>;
  incidentId?: string;
  /** Re-delivered into a replacement session after an engine move. */
  redrivenAt?: number;
  closedAt?: number;
  closedReason?: string;
}

export type SilenceClass =
  | 'engine-login'
  | 'usage-or-subscription-wall'
  | 'startup-dialog'
  | 'crashed'
  | 'working-slow'
  | 'message-not-delivered'
  /** Structural only (never a judge answer): the message is held for the other machine that runs the conversation. */
  | 'waiting-for-machine'
  | 'other'
  | 'undetermined';

export interface IncidentNotice {
  kind: 'waiting' | 'status';
  /** Status notices are deduped per state revision (class + action + outcome). */
  revision: string;
  messageId: string | null;
  at: number;
  covered: string[];
}

export interface Incident {
  id: string;
  platform: ConversationPlatform;
  conversationKey: string;
  openedAt: number;
  sessionName: string | null;
  framework: string | null;
  accountId: string | null;
  silenceClass: SilenceClass | null;
  confidence: number | null;
  judgeRoute: string | null;
  evidence: string | null;
  evidenceRevision: string | null;
  /** Verdict fields kept so an unchanged evidence revision reuses the verdict without a call. */
  cachedVerdict?: { truncated: boolean; actionsSinceMessage: 'none' | 'read-only' | 'some' | 'unknown' };
  action: string | null;
  /** The evidence revision the current action was taken on (one action per revision). */
  actedRevision?: string | null;
  outcome: string | null;
  notices: IncidentNotice[];
  /** Pinned-conversation one-tap ask (Frontloaded Decision 2). */
  ask?: { nonce: string; state: 'open' | 'tapped' | 'closed'; sentAt: number; tappedAt?: number; target: string | null };
  /** A framework move this feature made, so it can be undone when the original login is repaired. */
  fallback?: { from: string | null; fromUpdatedBy: string | null; to: string; appliedAt: number; by: 'automatic' | 'tap'; restoredAt?: number };
  /** Judge backoff (No Unbounded Loops): when the last judge call was made and how many were made. */
  lastJudgedAt?: number;
  judgeCount?: number;
  /** Framework the conversation already moved away from in this incident (breaker, §3.3). */
  triedFrameworks: string[];
  attempts: number;
  /** When this incident first held off for a stale-login restart (persisted, so a restart cannot reset the 3-minute cap). */
  staleLoginWaitStartedAt?: number;
  closedAt?: number;
  closedReason?: string;
}

/**
 * lease-freshness-lapse-retry — one of this machine's own replies held at the Telegram send boundary because the
 * machine did not hold the lease at that moment. A count beside the incidents, never an incident: the silence judge,
 * the notices and the actions never see it. One row per operation; the per-refusal record is the server log line.
 */
export interface SendHold {
  id: string;
  platform: ConversationPlatform;
  conversationKey: string;
  operationId: string;
  /** `lease-freshness-lapsed` (the coordinator's renewal fence answered) or `lease-not-held-at-send`. */
  reason: string;
  heldAt: number;
  /** The operation's own deadline; an undelivered row past it is closed as unobserved. */
  deadlineAt: number;
  deliveredAt?: number;
  closedAt?: number;
  /** `delivered-after-hold` (a recorded Telegram receipt) or `hold-unobserved-past-deadline` (this store saw no delivery; it claims none). */
  closedReason?: 'delivered-after-hold' | 'hold-unobserved-past-deadline';
}

interface FileShape {
  schema: 'never-silent/1';
  obligations: Obligation[];
  incidents: Incident[];
  /** Additive (files from before this list load with it empty; an older reader carries it along untouched). */
  sendHolds?: SendHold[];
}

const RETAIN_CLOSED_MS = 7 * 24 * 60 * 60_000;
const MAX_CLOSED_OBLIGATIONS = 500;
const MAX_CLOSED_INCIDENTS = 200;
/** Closed send holds are history, not state; the same figure the judged incidents use. */
const MAX_CLOSED_SEND_HOLDS = 200;

export class NeverSilentStore {
  private data: FileShape = { schema: 'never-silent/1', obligations: [], incidents: [] };
  private readonly file: string;

  constructor(stateDir: string, private readonly now: () => number = () => Date.now()) {
    this.file = path.join(stateDir, 'state', 'never-silent.json');
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as FileShape;
      if (parsed && parsed.schema === 'never-silent/1' && Array.isArray(parsed.obligations) && Array.isArray(parsed.incidents)) {
        this.data = parsed;
        if (!Array.isArray(this.data.sendHolds)) this.data.sendHolds = [];
      }
    } catch {
      // @silent-fallback-ok — an unreadable file starts empty; the corrupt copy is kept beside it for audit
      try { fs.copyFileSync(this.file, `${this.file}.corrupt-${this.now()}`); } catch { /* best effort */ }
    }
  }

  private flush(): void {
    this.prune();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private prune(): void {
    const cutoff = this.now() - RETAIN_CLOSED_MS;
    const open = this.data.obligations.filter((o) => o.state === 'pending' || o.state === 'told-pending');
    const closed = this.data.obligations
      .filter((o) => !(o.state === 'pending' || o.state === 'told-pending') && (o.closedAt ?? 0) >= cutoff)
      .slice(-MAX_CLOSED_OBLIGATIONS);
    this.data.obligations = [...closed, ...open].sort((a, b) => a.acceptedAt - b.acceptedAt);
    const openInc = this.data.incidents.filter((i) => !i.closedAt);
    const closedInc = this.data.incidents.filter((i) => i.closedAt && i.closedAt >= cutoff).slice(-MAX_CLOSED_INCIDENTS);
    this.data.incidents = [...closedInc, ...openInc].sort((a, b) => a.openedAt - b.openedAt);
    this.closeExpiredSendHolds();
    const holds = this.data.sendHolds ?? [];
    const openHolds = holds.filter((h) => !h.closedAt);
    const closedHolds = holds.filter((h) => h.closedAt && h.closedAt >= cutoff).slice(-MAX_CLOSED_SEND_HOLDS);
    this.data.sendHolds = [...closedHolds, ...openHolds].sort((a, b) => a.heldAt - b.heldAt);
  }

  /** An undelivered send hold past its operation deadline: this store saw no delivery, so it claims none either way. */
  private closeExpiredSendHolds(): boolean {
    const now = this.now();
    let changed = false;
    for (const h of this.data.sendHolds ?? []) {
      if (h.closedAt || h.deadlineAt > now) continue;
      h.closedAt = now; h.closedReason = 'hold-unobserved-past-deadline'; changed = true;
    }
    return changed;
  }

  /** lease-freshness-lapse-retry — a reply held at the send boundary for the lease (idempotent on the operation id). */
  recordSendHold(platform: ConversationPlatform, conversationKey: string, input: { operationId: string; reason: string; heldAt: number; deadlineAt: number }): SendHold {
    const holds = this.data.sendHolds ?? (this.data.sendHolds = []);
    const existing = holds.find((h) => h.operationId === input.operationId && !h.closedAt);
    if (existing) return existing;
    const row: SendHold = { id: `nsh-${crypto.randomBytes(6).toString('hex')}`, platform, conversationKey,
      operationId: input.operationId, reason: input.reason, heldAt: input.heldAt, deadlineAt: input.deadlineAt };
    holds.push(row);
    this.flush();
    return row;
  }

  /** The held reply's accepted outcome was recorded: close the row with the delivery time. No write when no open row matches. */
  recordSendHoldDelivered(operationId: string, deliveredAt: number): SendHold | null {
    const row = (this.data.sendHolds ?? []).find((h) => h.operationId === operationId && !h.closedAt);
    if (!row) return null;
    row.deliveredAt = deliveredAt; row.closedAt = deliveredAt; row.closedReason = 'delivered-after-hold';
    this.flush();
    return row;
  }

  openSendHolds(): SendHold[] { return (this.data.sendHolds ?? []).filter((h) => !h.closedAt); }

  static obligationId(platform: ConversationPlatform, conversationKey: string, inboundMessageId: string): string {
    return `${platform}:${conversationKey}:${inboundMessageId}`;
  }

  /** Accept an inbound message (idempotent on its id). */
  accept(input: { platform: ConversationPlatform; conversationKey: string; inboundMessageId: string; text: string; senderName?: string; deadlineMs: number; at?: number }): Obligation {
    const id = NeverSilentStore.obligationId(input.platform, input.conversationKey, input.inboundMessageId);
    const existing = this.data.obligations.find((o) => o.id === id);
    if (existing) return existing;
    const at = input.at ?? this.now();
    const ob: Obligation = {
      id,
      platform: input.platform,
      conversationKey: input.conversationKey,
      inboundMessageId: input.inboundMessageId,
      text: input.text,
      ...(input.senderName ? { senderName: input.senderName } : {}),
      acceptedAt: at,
      deadlineAt: at + input.deadlineMs,
      state: 'pending',
      coveredBy: [],
    };
    this.data.obligations.push(ob);
    this.flush();
    return ob;
  }

  /**
   * A substantive agent reply was delivered in the conversation: it answers every open
   * obligation accepted before it (§3.1 honest limit — "answered" means a reply went out
   * after the message, not that it addressed every point).
   */
  recordReply(platform: ConversationPlatform, conversationKey: string, at: number = this.now()): Obligation[] {
    const closed: Obligation[] = [];
    for (const o of this.data.obligations) {
      if (o.platform !== platform || o.conversationKey !== conversationKey) continue;
      if (o.state !== 'pending' && o.state !== 'told-pending') continue;
      if (o.acceptedAt > at) continue;
      o.state = 'answered';
      o.closedAt = at;
      o.closedReason = 'reply-delivered';
      o.text = null;
      closed.push(o);
    }
    if (closed.length) this.flush();
    return closed;
  }

  /** A standby line was delivered in the conversation (counts as the waiting notice, §3.4). */
  recordStandby(platform: ConversationPlatform, conversationKey: string, at: number = this.now()): void {
    let changed = false;
    for (const o of this.openFor(platform, conversationKey)) {
      if (o.acceptedAt <= at && !o.standbySeenAt) { o.standbySeenAt = at; changed = true; }
    }
    if (changed) this.flush();
  }

  /** The user or operator deliberately ended the session. */
  release(platform: ConversationPlatform, conversationKey: string, reason: string): void {
    let changed = false;
    for (const o of this.openFor(platform, conversationKey)) {
      o.state = 'released'; o.closedAt = this.now(); o.closedReason = reason; o.text = null; changed = true;
    }
    if (changed) this.flush();
  }

  openFor(platform: ConversationPlatform, conversationKey: string): Obligation[] {
    return this.data.obligations.filter((o) => o.platform === platform && o.conversationKey === conversationKey
      && (o.state === 'pending' || o.state === 'told-pending'));
  }

  /** Every open obligation past its notice deadline, grouped per conversation. */
  overdueConversations(at: number = this.now()): Array<{ platform: ConversationPlatform; conversationKey: string; obligations: Obligation[] }> {
    const groups = new Map<string, { platform: ConversationPlatform; conversationKey: string; obligations: Obligation[] }>();
    for (const o of this.data.obligations) {
      if (o.state !== 'pending' && o.state !== 'told-pending') continue;
      if (o.deadlineAt > at) continue;
      const k = `${o.platform}:${o.conversationKey}`;
      const g = groups.get(k) ?? { platform: o.platform, conversationKey: o.conversationKey, obligations: [] };
      g.obligations.push(o);
      groups.set(k, g);
    }
    return [...groups.values()];
  }

  markCovered(ids: string[], kind: 'waiting' | 'status'): void {
    for (const o of this.data.obligations) {
      if (!ids.includes(o.id)) continue;
      if (!o.coveredBy.includes(kind)) o.coveredBy.push(kind);
      if (o.state === 'pending') o.state = 'told-pending';
    }
    this.flush();
  }

  openIncident(platform: ConversationPlatform, conversationKey: string): Incident | null {
    return this.data.incidents.find((i) => i.platform === platform && i.conversationKey === conversationKey && !i.closedAt) ?? null;
  }

  ensureIncident(platform: ConversationPlatform, conversationKey: string, seed: Pick<Incident, 'sessionName' | 'framework' | 'accountId'>): Incident {
    const open = this.openIncident(platform, conversationKey);
    if (open) return open;
    const inc: Incident = {
      id: `nsi-${crypto.randomBytes(6).toString('hex')}`,
      platform,
      conversationKey,
      openedAt: this.now(),
      sessionName: seed.sessionName,
      framework: seed.framework,
      accountId: seed.accountId,
      silenceClass: null,
      confidence: null,
      judgeRoute: null,
      evidence: null,
      evidenceRevision: null,
      action: null,
      outcome: null,
      notices: [],
      triedFrameworks: [],
      attempts: 0,
    };
    this.data.incidents.push(inc);
    this.flush();
    return inc;
  }

  updateIncident(id: string, patch: Partial<Incident>): Incident | null {
    const inc = this.data.incidents.find((i) => i.id === id);
    if (!inc) return null;
    Object.assign(inc, patch);
    this.flush();
    return inc;
  }

  getIncident(id: string): Incident | null {
    return this.data.incidents.find((i) => i.id === id) ?? null;
  }

  appendNotice(id: string, notice: IncidentNotice): void {
    const inc = this.data.incidents.find((i) => i.id === id);
    if (!inc) return;
    inc.notices.push(notice);
    this.flush();
  }

  /** The waiting message was re-delivered; it gets a fresh notice deadline on the new session. */
  markRedriven(obligationId: string, at: number, deadlineMs: number): void {
    const o = this.data.obligations.find((x) => x.id === obligationId);
    if (!o) return;
    o.redrivenAt = at;
    o.deadlineAt = at + deadlineMs;
    this.flush();
  }

  incidentByAskNonce(nonce: string): Incident | null {
    return this.data.incidents.find((i) => i.ask?.nonce === nonce) ?? null;
  }

  closeIncident(id: string, reason: string): void {
    const inc = this.data.incidents.find((i) => i.id === id);
    if (!inc || inc.closedAt) return;
    inc.closedAt = this.now();
    inc.closedReason = reason;
    if (inc.ask && inc.ask.state === 'open') inc.ask.state = 'closed';
    this.flush();
  }

  /** The most recent move-back for a conversation (flap guard: a repair that did not hold). */
  lastRestoreAt(platform: ConversationPlatform, conversationKey: string): number | null {
    let at: number | null = null;
    for (const i of this.data.incidents) {
      if (i.platform !== platform || i.conversationKey !== conversationKey || !i.fallback?.restoredAt) continue;
      at = Math.max(at ?? 0, i.fallback.restoredAt);
    }
    return at;
  }

  /** Incidents with a framework move still in place (candidates to move back after repair). */
  movedIncidents(): Incident[] {
    return this.data.incidents.filter((i) => i.fallback && !i.fallback.restoredAt);
  }

  snapshot(): { obligations: Obligation[]; incidents: Incident[]; sendHolds: SendHold[] } {
    // A read also settles send holds past their deadline (a quiet agent may not write for hours); it flushes only
    // when something was closed.
    if (this.closeExpiredSendHolds()) this.flush();
    return {
      // The waiting text never leaves the store through a read surface.
      obligations: this.data.obligations.map((o) => ({ ...o, text: null })),
      sendHolds: (this.data.sendHolds ?? []).map((h) => ({ ...h })),
      incidents: this.data.incidents.map((i) => ({ ...i })),
    };
  }
}
