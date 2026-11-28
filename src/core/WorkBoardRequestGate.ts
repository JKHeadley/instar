/**
 * WorkBoardRequestGate — every direct request becomes a card (docs/specs/agent-work-cards-default.md §3).
 *
 * Two halves, both deterministic lookups against recorded fields (no meaning decision is made here):
 *
 *  1. `verifySource` — at RECORDING time, on the recording machine: the durable message row for
 *     `(conversation, messageId)` is looked up through the adapter's own arm and the requester is read from it
 *     (Vocabulary "Durable message row and the requester"). A session binding is never an input. The verdict,
 *     the requester and the row's whole text replicate with the commitment and are never upgraded elsewhere.
 *  2. `writeCard` / `sweep` — the card for a commitment, with an id derived from the commitment's replicated
 *     identity `(originMachineId, id)`, so the origin's gate, the holder's sweep and any machine that sees the
 *     replicated commitment write the SAME `created` record. The card index (`refs`) is the truth about whether a
 *     request has a card; `commitment.cardId` is an origin-written cache.
 *
 * The gate writes with the server principal, which is the only writer the gate-only fields (`requester`,
 * `requestTextHash`, `recordedAsHash`, `pickupHold`) accept.
 */

import type { WorkBoardService, WorkBoardSettings, Refusal } from './WorkBoardService.js';
import { workCardPlainLanguageIssue } from './WorkCardPlainLanguage.js';
import { TERMINAL_CARD_REASONS } from './WorkBoardService.js';
import {
  requestCardId, commitmentRefId, requestTextHashOf, cutAtWord, GENERAL_PROJECT_KEY, SCHEMA_MAX, MAX_REFS,
  type CardRef, type PickupHold,
} from './WorkCardStore.js';

export type SourceUnverifiedReason = 'no-message-id' | 'not-found' | 'budget-exceeded' | 'unreadable' | 'no-requester' | 'unproven-provenance' | 'request-too-long' | 'credential-shaped';

export type SourceVerdict =
  | { sourceVerified: true; requesterPersonKey: string; requesterIsOwner: boolean; requestText: string; requestTextHash: string }
  | { sourceVerified: false; sourceUnverifiedReason: SourceUnverifiedReason };

/** The fields of a commitment row the gate reads (own rows and replicas alike). */
export interface GateCommitmentRow {
  id: string;
  originMachineId: string;
  status: string;
  createdAt: string;
  source?: 'agent' | 'sentinel' | 'manual';
  userRequest: string;
  agentResponse: string;
  topicId?: number;
  sourceConversationKey?: string;
  sourceMessageId?: string;
  sourceVerified?: boolean;
  requesterPersonKey?: string;
  requesterIsOwner?: boolean;
  requestText?: string;
  requestTextHash?: string;
  milestones?: string[];
  outward?: boolean;
  recommendation?: string;
  whyYou?: string;
  cardId?: string;
  cardWritten?: boolean;
  cardPending?: boolean;
  cardReason?: string;
  cardRefused?: string;
}

/** The origin's bookkeeping on its own commitment (never re-replicates the row). */
export interface CardBookkeeping { cardId?: string; cardWritten?: boolean; cardPending?: boolean; cardReason?: string | null; cardRefused?: string | null }

/** A native Telegram row, or an app-mirrored one, as `telegram-messages.jsonl` holds it. */
export interface TelegramRow {
  text: string; fromUser: boolean; forwarded?: boolean; telegramUserId?: number; via?: 'mobile-device'; deviceId?: string;
  senderRole?: 'owner' | 'msp' | 'team'; senderPerson?: { machineId: string; userId: string }; teamPhone?: boolean; rowOrigin?: 'relay' | 'a2a';
}
export type TelegramRowLookup = { entry: TelegramRow | null; unreadable?: boolean; budgetExceeded?: boolean };
/** An app conversation's operator message event. */
export interface AppRow { role: 'operator' | 'agent'; text: string; deviceId?: string | null; senderRole?: 'owner' | 'msp' | 'team'; senderPerson?: { machineId: string; userId: string } }
export interface DeviceRecordView { status: string; revokedAt?: string; userId?: string; role?: 'owner' | 'msp' | 'team' }

export interface RequestGateDeps {
  svc: WorkBoardService;
  machineId: string;
  now: () => number;
  settings: () => WorkBoardSettings;
  ownerPersonKey: () => string | null;
  detectCredential: (text: string) => string | null;
  /** Is this a conversation a person the agent serves speaks in (Vocabulary)? With the project it belongs to, when any. */
  operatorConversation: (conversationKey: string) => { ok: true; projectKey: string | null } | { ok: false };
  /** Telegram's existing backward scan of the durable log by `(topicId, messageId)` under its byte budget. Absent ⇒ unreadable. */
  telegramRow?: (topicId: number, messageId: number) => TelegramRowLookup;
  /** The app conversation store's message event by id. Absent ⇒ unreadable. */
  appRow?: (conversationKey: string, messageId: string) => AppRow | null;
  /** Slack's stored row (the weakest arm). Absent ⇒ `unproven-provenance`, which the verdict states. */
  slackRow?: (channel: string, thread: string | null, messageId: string) => { text: string; user: string; bot: boolean } | null;
  /** The device record held on THIS machine (physical-credential locality); absent elsewhere. */
  deviceRecord: (deviceId: string) => DeviceRecordView | null;
  /** The owner's Telegram id and the team people a Telegram id links to. */
  telegramOwnerId: () => number | null;
  teamPersonForTelegramId: (telegramUserId: number) => string | null;
  /** Slack: the configured owner id, and a linked member's person key. */
  slackOwnerId?: () => string | null;
  teamPersonForSlackId?: (slackUserId: string) => string | null;
  /** The commitments this machine holds (own + replicas) and the origin's bookkeeping writer. */
  commitments: {
    list: () => GateCommitmentRow[];
    /** Set bookkeeping on an OWN commitment; a replica is never written (the index is the truth). */
    annotate: (id: string, patch: CardBookkeeping) => void;
    /** Withdraw pending `sentinel` rows this card supersedes (§3 "Sentinel captures"); returns the ids withdrawn. */
    supersedeSentinels: (conversationKey: string, userRequest: string, agentResponse: string, byId: string) => string[];
  };
  /** The team the board belongs to (the `enabled-at` key). */
  teamKey: () => string;
  /** The holder has completed an exchange with every live peer since boot (§3 "The first run"); absent ⇒ single machine. */
  caughtUpWithAllPeers?: () => boolean;
  /** Write a progress note on a card (the runtime's note writer: conversation event first, pointer by the holder). */
  writeNote?: (cardId: string, text: string, writerBinding: string) => { ok: true; eventId: string } | Refusal;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface GateOutcome { cardId: string; written: boolean; reason?: string; retryable?: boolean; linked?: boolean }

const OPEN_STATUSES: ReadonlySet<string> = new Set(['pending', 'verified', 'violated']);

/** `telegram:<topic>` → the numeric topic, else null. */
export function telegramTopicOf(conversationKey: string): number | null {
  const m = /^telegram:(-?\d{1,20})$/.exec(conversationKey);
  return m ? Number(m[1]) : null;
}

/** The conversation a commitment was recorded from: its explicit source key, else its Telegram topic. */
export function conversationKeyOf(c: Pick<GateCommitmentRow, 'sourceConversationKey' | 'topicId'>): string | null {
  if (typeof c.sourceConversationKey === 'string' && c.sourceConversationKey) return c.sourceConversationKey;
  if (typeof c.topicId === 'number' && Number.isSafeInteger(c.topicId)) return `telegram:${c.topicId}`;
  return null;
}

export class WorkBoardRequestGate {
  /** Replica commitments the sweep skipped as stale backfill (the origin's bookkeeping is not ours to write). */
  private readonly skipped = new Set<string>();
  readonly stats = { cardsWritten: 0, linked: 0, refsRepaired: 0, sweepRefusals: 0, backfillSkipped: 0 };

  constructor(private readonly d: RequestGateDeps) {}

  // ── 1. the requester, from the durable message row ─────────────────────────

  verifySource(conversationKey: string | null, messageId: string | null | undefined): SourceVerdict {
    if (!conversationKey || typeof messageId !== 'string' || !messageId.trim()) return { sourceVerified: false, sourceUnverifiedReason: 'no-message-id' };
    const topic = telegramTopicOf(conversationKey);
    if (topic !== null) return this.verifyTelegram(topic, messageId);
    if (conversationKey.startsWith('slack:')) return this.verifySlack(conversationKey, messageId);
    return this.verifyApp(conversationKey, messageId);
  }

  private textVerdict(text: string, personKey: string, isOwner: boolean): SourceVerdict {
    if (text.length > SCHEMA_MAX.need) return { sourceVerified: false, sourceUnverifiedReason: 'request-too-long' };
    if (this.d.detectCredential(text)) return { sourceVerified: false, sourceUnverifiedReason: 'credential-shaped' };
    return { sourceVerified: true, requesterPersonKey: personKey, requesterIsOwner: isOwner, requestText: text, requestTextHash: requestTextHashOf(text) };
  }

  /** The device-record arm shared by mirrored Telegram rows and app events (physical-credential locality). */
  private personFromDevice(deviceId: string | undefined | null, senderRole: string | undefined, senderPerson: { machineId: string; userId: string } | undefined): { personKey: string; isOwner: boolean } | 'unproven' | 'no-requester' {
    if (!deviceId) return 'unproven';
    const dev = this.d.deviceRecord(deviceId);
    if (!dev || dev.status !== 'active' || dev.revokedAt) return 'unproven';
    const role = dev.role ?? 'owner';
    if (senderRole !== role) return 'unproven';
    if (senderPerson && (senderPerson.userId !== (dev.userId ?? '') || senderPerson.machineId !== this.d.machineId)) return 'unproven';
    if (role === 'owner') { const owner = this.d.ownerPersonKey(); return owner ? { personKey: owner, isOwner: true } : 'no-requester'; }
    return dev.userId ? { personKey: dev.userId, isOwner: false } : 'no-requester';
  }

  private verifyTelegram(topicId: number, messageId: string): SourceVerdict {
    const mid = Number(messageId);
    if (!Number.isSafeInteger(mid)) return { sourceVerified: false, sourceUnverifiedReason: 'no-message-id' };
    if (!this.d.telegramRow) return { sourceVerified: false, sourceUnverifiedReason: 'unreadable' };
    const r = this.d.telegramRow(topicId, mid);
    if (r.unreadable) return { sourceVerified: false, sourceUnverifiedReason: 'unreadable' };
    if (r.budgetExceeded) return { sourceVerified: false, sourceUnverifiedReason: 'budget-exceeded' };
    const row = r.entry;
    if (!row) return { sourceVerified: false, sourceUnverifiedReason: 'not-found' };
    if (!row.fromUser || row.rowOrigin) return { sourceVerified: false, sourceUnverifiedReason: 'no-requester' };
    if (row.via === 'mobile-device') {
      const p = this.personFromDevice(row.deviceId, row.senderRole, row.senderPerson);
      if (p === 'unproven') return { sourceVerified: false, sourceUnverifiedReason: 'unproven-provenance' };
      if (p === 'no-requester') return { sourceVerified: false, sourceUnverifiedReason: 'no-requester' };
      return this.textVerdict(row.text, p.personKey, p.isOwner);
    }
    // Native: only an explicit `forwarded: false` proves the words are the sender's own.
    if (row.forwarded !== false) return { sourceVerified: false, sourceUnverifiedReason: 'unproven-provenance' };
    if (typeof row.telegramUserId !== 'number') return { sourceVerified: false, sourceUnverifiedReason: 'no-requester' };
    if (row.telegramUserId === this.d.telegramOwnerId()) {
      const owner = this.d.ownerPersonKey();
      return owner ? this.textVerdict(row.text, owner, true) : { sourceVerified: false, sourceUnverifiedReason: 'no-requester' };
    }
    const member = this.d.teamPersonForTelegramId(row.telegramUserId);
    return member ? this.textVerdict(row.text, member, false) : { sourceVerified: false, sourceUnverifiedReason: 'no-requester' };
  }

  private verifyApp(conversationKey: string, messageId: string): SourceVerdict {
    if (!this.d.appRow) return { sourceVerified: false, sourceUnverifiedReason: 'unreadable' };
    const ev = this.d.appRow(conversationKey, messageId);
    if (!ev) return { sourceVerified: false, sourceUnverifiedReason: 'not-found' };
    if (ev.role !== 'operator') return { sourceVerified: false, sourceUnverifiedReason: 'no-requester' };
    const p = this.personFromDevice(ev.deviceId, ev.senderRole, ev.senderPerson);
    if (p === 'unproven') return { sourceVerified: false, sourceUnverifiedReason: 'unproven-provenance' };
    if (p === 'no-requester') return { sourceVerified: false, sourceUnverifiedReason: 'no-requester' };
    return this.textVerdict(ev.text, p.personKey, p.isOwner);
  }

  private verifySlack(conversationKey: string, messageId: string): SourceVerdict {
    if (!this.d.slackRow) return { sourceVerified: false, sourceUnverifiedReason: 'unproven-provenance' };
    const parts = conversationKey.split(':'); // slack:<channel>[:<thread>]
    const row = this.d.slackRow(parts[1] ?? '', parts[2] ?? null, messageId);
    if (!row) return { sourceVerified: false, sourceUnverifiedReason: 'not-found' };
    if (row.bot) return { sourceVerified: false, sourceUnverifiedReason: 'no-requester' };
    const ownerId = this.d.slackOwnerId?.() ?? null;
    if (ownerId && row.user === ownerId) {
      const owner = this.d.ownerPersonKey();
      return owner ? this.textVerdict(row.text, owner, true) : { sourceVerified: false, sourceUnverifiedReason: 'no-requester' };
    }
    const member = this.d.teamPersonForSlackId?.(row.user) ?? null;
    return member ? this.textVerdict(row.text, member, false) : { sourceVerified: false, sourceUnverifiedReason: 'no-requester' };
  }

  // ── 2. the card ──────────────────────────────────────────────────────────────

  /** The card a commitment has, by the index or the derived id; null when none. */
  cardFor(c: Pick<GateCommitmentRow, 'id' | 'originMachineId'>): string | null {
    const byRef = this.d.svc.cardForRef('commitment', commitmentRefId(c.originMachineId, c.id));
    if (byRef) return byRef;
    const derived = requestCardId(c.originMachineId, c.id);
    return this.d.svc.view(derived)?.card.created ? derived : null;
  }

  /** Is this commitment one the gate carries at all (source, conversation)? */
  private eligible(c: GateCommitmentRow): { ok: true; conversationKey: string; projectKey: string | null } | { ok: false; reason: 'not-operator-conversation' | 'not-a-request' } {
    if (c.source !== 'agent' && c.source !== 'manual') return { ok: false, reason: 'not-a-request' };
    const key = conversationKeyOf(c);
    if (!key) return { ok: false, reason: 'not-operator-conversation' };
    const op = this.d.operatorConversation(key);
    if (!op.ok) return { ok: false, reason: 'not-operator-conversation' };
    return { ok: true, conversationKey: key, projectKey: op.projectKey };
  }

  private cardCopy(c: Pick<GateCommitmentRow, 'userRequest' | 'agentResponse' | 'milestones' | 'outward' | 'recommendation' | 'whyYou'>, original?: string) {
    const L = this.d.svc.limits();
    const milestones = c.milestones?.length ? c.milestones : [`Done: ${c.agentResponse}`];
    return {
      title: cutAtWord(c.userRequest, L.title),
      need: original ?? cutAtWord(c.userRequest, L.need),
      doneWhen: milestones.slice(0, 256).map((text, i) => ({
        id: `m${i + 1}`, text: cutAtWord(String(text), L.doneItemText), certify: 'agent-may-certify',
      })),
      ...(c.outward ? {
        recommendation: cutAtWord(c.recommendation?.trim() ? c.recommendation : c.agentResponse, L.recommendation),
        whyYou: c.whyYou?.trim() ? cutAtWord(c.whyYou, L.recommendation) : 'This request sends outside your team or spends money, so it waits for you.',
      } : {}),
    };
  }

  /** Refuse a fixable draft before recording it, so the caller can retry without another commitment. */
  copyIssue(
    conversationKey: string,
    fields: Parameters<WorkBoardRequestGate['cardCopy']>[0],
    verdict: SourceVerdict | null,
  ): ReturnType<typeof workCardPlainLanguageIssue> {
    if (!this.d.settings().requestCards.enabled || !this.d.operatorConversation(conversationKey).ok) return null;
    const original = verdict?.sourceVerified ? verdict.requestText : undefined;
    const issue = workCardPlainLanguageIssue(this.cardCopy(fields, original), {
      preserveOriginalRequest: verdict?.sourceVerified === true && verdict.requesterIsOwner,
    });
    if (!issue) return null;
    const field = issue.field === 'title' || issue.field === 'need' ?
      'userRequest' : issue.field.startsWith('doneWhen') ? (fields.milestones?.length ? 'milestones' : 'agentResponse') : issue.field;
    return { ...issue, field };
  }

  /**
   * Write (or link) the card for one commitment. `backfill` marks the first-run cards (uncounted, held as backfill).
   * Idempotent: a second call for the same commitment links instead of creating.
   */
  writeCard(c: GateCommitmentRow, opts: { backfill?: boolean; own: boolean } = { own: true }): GateOutcome {
    const cardId = requestCardId(c.originMachineId, c.id);
    const refId = commitmentRefId(c.originMachineId, c.id);
    const el = this.eligible(c);
    if (!el.ok) {
      if (opts.own && el.reason === 'not-operator-conversation') this.d.commitments.annotate(c.id, { cardPending: false, cardReason: 'not-operator-conversation' });
      return { cardId, written: false, reason: el.reason };
    }
    const existing = this.cardFor(c);
    if (existing) {
      const linked = this.ensureRef(existing, refId);
      if (opts.own) this.d.commitments.annotate(c.id, { cardId: existing, cardWritten: true, cardPending: false, cardReason: null, cardRefused: null });
      return { cardId: existing, written: false, linked };
    }
    // A pickup session records against its own card (§3): a commitment from a card's conversation links to that card
    // while its `refs` has room; the 21st gets its own card with a `parent-card` ref.
    const parent = this.d.svc.cardIdForConversation(el.conversationKey);
    if (parent) {
      const pv = this.d.svc.view(parent);
      if (pv && pv.card.created && !pv.card.redacted && pv.card.refs.length < MAX_REFS) {
        const linked = this.ensureRef(parent, refId);
        if (opts.own) this.d.commitments.annotate(c.id, { cardId: parent, cardWritten: true, cardPending: false, cardReason: 'card-exists-linked', cardRefused: null });
        return { cardId: parent, written: false, linked };
      }
    }
    const L = this.d.settings().limits;
    const verified = c.sourceVerified === true && typeof c.requestText === 'string' && typeof c.requestTextHash === 'string' && typeof c.requesterPersonKey === 'string';
    const fields: Record<string, unknown> = {
      // The approval remains attached to the complete sender-verified request.
      ...this.cardCopy(c, verified ? c.requestText : undefined),
      carrier: 'agent',
      outward: c.outward === true,
      projectKey: el.projectKey ?? GENERAL_PROJECT_KEY,
      source: c.sourceMessageId ? { conversationKey: el.conversationKey, messageId: String(c.sourceMessageId).slice(0, 200) } : undefined,
      refs: [{ kind: 'commitment', id: refId }, ...(parent ? [{ kind: 'parent-card' as const, id: parent }] : [])] satisfies CardRef[],
      pickupHold: (opts.backfill ? { kind: 'backfill' } : { kind: 'recording-session', conversationKey: el.conversationKey }) satisfies PickupHold,
    };
    if (verified) {
      fields.requester = { personKey: c.requesterPersonKey, isOwner: c.requesterIsOwner === true };
      fields.requestTextHash = c.requestTextHash;
      fields.recordedAsHash = requestTextHashOf(c.userRequest);
    }
    if (fields.source === undefined) delete fields.source;
    const r = this.d.svc.createCard({ kind: 'agent', server: true }, fields, { cardId, counted: !opts.backfill });
    if (!r.ok) {
      if (r.error === 'card-exists') {
        const linked = this.ensureRef(cardId, refId);
        if (opts.own) this.d.commitments.annotate(c.id, { cardId, cardWritten: true, cardPending: false, cardReason: null, cardRefused: null });
        return { cardId, written: false, linked };
      }
      const retryable = !TERMINAL_CARD_REASONS.has(r.error);
      this.stats.sweepRefusals++;
      if (opts.own) {
        this.d.commitments.annotate(c.id, retryable
          ? { cardId, cardPending: true, cardReason: r.error, ...(r.error === 'daily-card-ceiling' ? { cardRefused: 'daily-card-ceiling' } : {}) }
          : { cardId, cardPending: false, cardReason: r.error });
      }
      this.d.log?.('work-board-request-card-refused', { commitmentId: c.id, origin: c.originMachineId, error: r.error, retryable });
      return { cardId, written: false, reason: r.error, retryable };
    }
    this.stats.cardsWritten++;
    this.d.log?.('work-board-request-card-written', { commitmentId: c.id, origin: c.originMachineId, cardId, backfill: opts.backfill === true, requestApproved: verified && c.requesterIsOwner === true });
    if (opts.own) this.d.commitments.annotate(c.id, { cardId, cardWritten: true, cardPending: false, cardReason: null, cardRefused: null });
    // A pending sentinel capture of the same exchange is superseded by the card's commitment (§3 "Sentinel captures").
    try { this.d.commitments.supersedeSentinels(el.conversationKey, c.userRequest, c.agentResponse, c.id); } catch (err) { /* @silent-fallback-ok: logged; the card stands and the sentinel row, if any, stays in promise-review until the agent's commitment supersedes it */ this.d.log?.('work-board-sentinel-supersede-failed', { commitmentId: c.id, error: (err as Error)?.message }); }
    return { cardId, written: true };
  }

  /** The card's `refs` names the commitment (repairing the card side; the index is authoritative). */
  private ensureRef(cardId: string, refId: string): boolean {
    const v = this.d.svc.view(cardId); if (!v || !v.card.created) return false;
    if (v.card.refs.some((r) => r.kind === 'commitment' && r.id === refId)) return false;
    if (v.card.refs.length >= MAX_REFS) return false; // a pickup session's 21st link gets its own card (slice 2 scope)
    const r = this.d.svc.edit({ kind: 'agent', server: true }, cardId, { refs: [...v.card.refs, { kind: 'commitment', id: refId }] });
    if (r.ok) { this.stats.refsRepaired++; this.stats.linked++; }
    return r.ok;
  }

  /** The commitment was recorded on this machine (the origin): the gate runs after the response was sent. */
  onRecorded(c: GateCommitmentRow): GateOutcome | null {
    if (!this.d.settings().requestCards.enabled) return null;
    if (c.source !== 'agent' && c.source !== 'manual') return null;
    return this.writeCard(c, { own: true });
  }

  /**
   * The needs-card set (§3 "Where and when it runs"): open commitments from an operator conversation with no terminal
   * reason and no card. Computed from the commitments this machine holds (own + replicas); the index decides "has a card".
   */
  needsCard(): GateCommitmentRow[] {
    const out: GateCommitmentRow[] = [];
    for (const c of this.d.commitments.list()) {
      if (!OPEN_STATUSES.has(c.status)) continue;
      if (c.source !== 'agent' && c.source !== 'manual') continue;
      if (c.cardReason && TERMINAL_CARD_REASONS.has(c.cardReason)) continue;
      if (this.skipped.has(`${c.originMachineId}:${c.id}`)) continue;
      if (!conversationKeyOf(c)) continue;
      if (this.cardFor(c)) continue;
      out.push(c);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  }

  /**
   * The lease holder's paced pass (boot and tick): the first run writes the team's `enabled-at` record and backfills
   * recent open requests (uncounted, held as backfill); every later pass drains retryable gaps and repairs `refs`.
   * Returns what it did; writes at most `sweepPerTick` cards.
   */
  sweep(): { written: number; linked: number; skipped: number; refused: number; enabledAt: string | null; pending: number } {
    const s = this.d.settings();
    const out = { written: 0, linked: 0, skipped: 0, refused: 0, enabledAt: null as string | null, pending: 0 };
    if (!s.requestCards.enabled) return out;
    const teamKey = this.d.teamKey();
    let enabled = this.d.svc.enabledAt(teamKey);
    if (!enabled) {
      // The first run waits until the holder has heard from every live peer, so the backfill sees every commitment.
      if (this.d.caughtUpWithAllPeers && !this.d.caughtUpWithAllPeers()) return out;
      const w = this.d.svc.markEnabledAt(teamKey);
      if (!w.ok) { this.d.log?.('work-board-enabled-at-failed', { error: w.error }); return out; }
      enabled = this.d.svc.enabledAt(teamKey);
    }
    out.enabledAt = enabled?.at ?? null;
    const enabledMs = enabled ? Date.parse(enabled.at) : Number.NaN;
    const maxAgeMs = s.requestCards.backfillMaxAgeDays * 86_400_000;
    let budget = s.requestCards.sweepPerTick;
    const todo = this.needsCard();
    for (const c of todo) {
      if (budget <= 0) { out.pending++; continue; }
      const own = c.originMachineId === this.d.machineId;
      const createdMs = Date.parse(c.createdAt);
      const backfill = Number.isFinite(enabledMs) && Number.isFinite(createdMs) && createdMs < enabledMs;
      if (backfill && Number.isFinite(createdMs) && enabledMs - createdMs > maxAgeMs) {
        // Too old for a card of its own (§3 "The first run"): it stays in promise-review and gets a card when the agent records on it or delivers it.
        this.skipped.add(`${c.originMachineId}:${c.id}`);
        if (own) this.d.commitments.annotate(c.id, { cardPending: false, cardReason: 'backfill-skipped-stale' });
        this.stats.backfillSkipped++; out.skipped++;
        continue;
      }
      const eligible = this.eligible(c);
      if (!eligible.ok) {
        if (own) this.d.commitments.annotate(c.id, { cardPending: false, cardReason: 'not-operator-conversation' });
        else this.skipped.add(`${c.originMachineId}:${c.id}`);
        out.skipped++;
        continue;
      }
      budget--;
      const r = this.writeCard(c, { backfill, own });
      if (r.written) out.written++;
      else if (r.linked) out.linked++;
      else if (r.reason) out.refused++;
    }
    // The card side is repaired too (§3): a card that exists by derived id but whose `refs` no longer names its
    // commitment gets the entry back, within the same budget (the index is authoritative; the origin keeps its cache).
    for (const c of this.d.commitments.list()) {
      if (budget <= 0) break;
      if (!OPEN_STATUSES.has(c.status) || (c.source !== 'agent' && c.source !== 'manual')) continue;
      const refId = commitmentRefId(c.originMachineId, c.id);
      if (this.d.svc.cardForRef('commitment', refId)) continue;
      const derived = requestCardId(c.originMachineId, c.id);
      if (!this.d.svc.view(derived)?.card.created) continue;
      if (this.ensureRef(derived, refId)) { budget--; out.linked++; }
    }
    return out;
  }

  /**
   * Delivering a commitment (§2 "Delivering a commitment"): the gate first when the commitment has no card; then a note
   * "Delivered: …"; evidence ONLY when the body names the item (and carries text); a claim only if that was the last item.
   */
  onDeliver(c: GateCommitmentRow, input: { deliveryMessageId?: string; evidence?: string; itemId?: string }): { cardId: string | null; noted: boolean; evidenced: boolean; claimed: boolean; refusal?: string } {
    if (!this.d.settings().requestCards.enabled) return { cardId: null, noted: false, evidenced: false, claimed: false };
    let cardId = this.cardFor(c);
    if (!cardId) {
      const r = this.writeCard(c, { own: c.originMachineId === this.d.machineId });
      cardId = r.written || r.linked || this.d.svc.view(r.cardId)?.card.created ? r.cardId : null;
      if (!cardId) return { cardId: null, noted: false, evidenced: false, claimed: false, refusal: r.reason };
    }
    const summary = input.deliveryMessageId ? `message ${String(input.deliveryMessageId).slice(0, 120)}` : (input.evidence ? cutAtWord(input.evidence, 300) : 'the reply was sent');
    let noted = false;
    if (this.d.writeNote) { const n = this.d.writeNote(cardId, `Delivered: ${summary}`, 'server:commitment-deliver'); noted = n.ok; }
    let evidenced = false; let claimed = false; let refusal: string | undefined;
    if (typeof input.itemId === 'string' && input.itemId && typeof input.evidence === 'string' && input.evidence.trim()) {
      const e = this.d.svc.addEvidence({ kind: 'agent', server: true }, cardId, { itemId: input.itemId, text: input.evidence.slice(0, SCHEMA_MAX.evidence) });
      evidenced = e.ok;
      if (!e.ok) refusal = e.error;
      else {
        const v = this.d.svc.view(cardId)!;
        const latest = new Set(v.card.evidence.filter((x) => x.counts).map((x) => x.itemId));
        if (v.card.doneWhen.every((d) => latest.has(d.id))) { const cl = this.d.svc.claimDone({ kind: 'agent', server: true }, cardId); claimed = cl.ok; if (!cl.ok) refusal = cl.error; }
      }
    }
    return { cardId, noted, evidenced, claimed, ...(refusal ? { refusal } : {}) };
  }
}
