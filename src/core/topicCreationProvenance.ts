/**
 * identity-security-creation-provenance: each owner request counts for what it asked.
 *
 * - A change to conversation B that the owner asked for in conversation A is PROPOSED in A (the
 *   §10.1 propose lane with `confirmIn`) and applied only on the owner's live "yes" there. No model
 *   and no logged message decides authority; `crossTopicEligible` only decides whether B may be
 *   reached (checked at arm and again at confirm).
 * - A new topic may carry `onBehalfOf`, a message the agent LINKS as the reason it was created,
 *   identity-checked by `checkCitation`. It is a record only: it grants nothing, claims no
 *   approval, and is never posted into a conversation.
 *
 * The shared operator verifier and the topic-operator store are untouched. Machine-local: a
 * message can only be verified against the log of the machine that received it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { topicRef } from '../messaging/shared/topicRef.js';

/** A cited message is accepted only if it is at most this old (spec: Floors). */
export const CITATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type CitationRefusal =
  | 'bad-request'
  | 'source-unverified'
  | 'not-owner'
  | 'log-unreadable'
  | 'message-not-found'
  | 'message-not-from-operator'
  | 'message-too-old'
  | 'log-window-exceeded';

export interface CitedMessage {
  topicId: number;
  messageId: number;
  /** The owner's Telegram id (a citation is accepted only from the configured owner). */
  uid: string;
  at: string;
}

export interface ProvenanceRow {
  topicId: number;
  createdAt: string;
  session: string | null;
  source: { kind: 'linked-message'; linked: CitedMessage; authorship: 'unverified' } | { kind: 'source-unknown' };
  /** The session header the caller sent: asserted by the caller, not verified. */
  sessionAsserted?: boolean;
  /** Later reuses of the same topic by name: appended, never replacing the original record. */
  reuses?: Array<{ at: string; session: string | null; linked: CitedMessage | null }>;
}

/** The slice of a Telegram log row the check reads. */
export interface LogRowLike {
  messageId: number;
  text?: string;
  topicId: number | null;
  fromUser: boolean;
  timestamp: string;
  telegramUserId?: number;
  forwarded?: boolean;
  rowOrigin?: string;
  teamPhone?: boolean;
  via?: string;
  authorship?: string;
}

export interface CitationDeps {
  /** The source topic's VERIFIED operator uid (TopicOperatorStore.getOperator), or null. */
  verifiedOperatorUid: (topicId: number) => string | null;
  /** Find one message in a topic's log at or after `notBeforeMs`. `unreadable` when the log can't be read. */
  findMessage: (topicId: number, messageId: number, notBeforeMs: number) => { entry: LogRowLike | null; unreadable?: boolean; budgetExceeded?: boolean };
  /** The agent's configured owner Telegram id, or null when none is configured. */
  ownerUid: () => string | null;
  now: () => number;
}

/** Parse `onBehalfOf` from a request body. `undefined` when absent; `null` when malformed. */
export function parseOnBehalfOf(raw: unknown): { topicId: number; messageId: number } | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { topicId, messageId } = raw as { topicId?: unknown; messageId?: unknown };
  const t = typeof topicId === 'string' && /^\d+$/.test(topicId) ? Number(topicId) : topicId;
  const m = typeof messageId === 'string' && /^\d+$/.test(messageId) ? Number(messageId) : messageId;
  if (!Number.isSafeInteger(t) || (t as number) <= 0 || !Number.isSafeInteger(m) || (m as number) <= 0) return null;
  return { topicId: t as number, messageId: m as number };
}

/**
 * Check a citation. Identity only: the agent judged the meaning when it chose the message; the
 * owner sees the quote. Deterministic and side-effect free.
 */
export function checkCitation(
  ref: { topicId: number; messageId: number },
  deps: CitationDeps,
): { ok: true; cited: CitedMessage; text: string } | { ok: false; reason: CitationRefusal } {
  const operator = deps.verifiedOperatorUid(ref.topicId);
  if (!operator) return { ok: false, reason: 'source-unverified' };
  const owner = deps.ownerUid();
  if (!owner || owner !== operator) return { ok: false, reason: 'not-owner' };
  const now = deps.now();
  const found = deps.findMessage(ref.topicId, ref.messageId, now - CITATION_MAX_AGE_MS);
  if (found.unreadable) return { ok: false, reason: 'log-unreadable' };
  if (found.budgetExceeded) return { ok: false, reason: 'log-window-exceeded' };
  const e = found.entry;
  if (!e) return { ok: false, reason: 'message-not-found' };
  const at = Date.parse(String(e.timestamp));
  if (!Number.isFinite(at) || now - at > CITATION_MAX_AGE_MS || at - now > 60_000) return { ok: false, reason: 'message-too-old' };
  const fromOperator = e.fromUser === true
    && String(e.telegramUserId ?? '') === operator
    && e.forwarded === false
    && !e.rowOrigin
    && !e.teamPhone
    && e.via === undefined
    && e.authorship === 'human';
  if (!fromOperator) return { ok: false, reason: 'message-not-from-operator' };
  return { ok: true, cited: { topicId: ref.topicId, messageId: ref.messageId, uid: operator, at: new Date(at).toISOString() }, text: String(e.text ?? '') };
}

export type CrossTopicRefusal = 'source-not-owner' | 'source-shared' | 'destination-unknown' | 'destination-bound' | 'destination-confined';

/**
 * identity-security-creation-provenance v5: may a change confirmed by the owner in conversation A
 * apply to conversation B? Deterministic, checked when the proposal is armed AND again when the
 * owner's "yes" arrives. The authority is the owner's live, authenticated yes to a server-rendered
 * proposal; this decides only whether B is a conversation that yes may reach.
 */
export function crossTopicEligible(input: {
  ownerUid: string | null;
  /** The verified operator of A (where the owner confirms), or the confirming sender. */
  confirmerUid: string | null;
  destKnown: boolean;
  /** B's raw binding, if any (verified or not). */
  destBinding: { platform: string; uid: string } | null;
  /** B's VERIFIED operator, if any. */
  destVerifiedUid: string | null;
  /** TeamConfinement.isConfined('telegram:B'): false = known not confined, true = confined, null = unknown. */
  destConfined: boolean | null;
  /**
   * The same for A. The proposal names B and the change inside A, so A must be the owner's own
   * conversation, not one shared with team members who may not be entitled to see B.
   */
  sourceConfined: boolean | null;
}): { ok: true } | { ok: false; reason: CrossTopicRefusal } {
  if (!input.ownerUid || !input.confirmerUid || input.confirmerUid !== input.ownerUid) return { ok: false, reason: 'source-not-owner' };
  if (input.sourceConfined !== false) return { ok: false, reason: 'source-shared' };
  if (!input.destKnown) return { ok: false, reason: 'destination-unknown' };
  if (input.destBinding) {
    const sameOwner = input.destBinding.platform === 'telegram' && input.destBinding.uid === input.ownerUid && input.destVerifiedUid === input.ownerUid;
    if (!sameOwner) return { ok: false, reason: 'destination-bound' };
  }
  if (input.destConfined === null) return { ok: false, reason: 'destination-unknown' };
  if (input.destConfined === true) return { ok: false, reason: 'destination-confined' };
  return { ok: true };
}

/** The only fields a cross-conversation yes may change: everyday run settings. */
export const CROSS_TOPIC_FIELDS: readonly string[] = ['model', 'modelTier', 'thinkingMode', 'effort'];

/** A conversation name as shown inside the proposal: no quotes or line breaks, bounded. */
export function safeConversationName(name: string | null, topicKey: string): string {
  const cleaned = (name ?? '').replace(/["\u201c\u201d\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  // No name known: the shared rendering (id plus name, or a plain 'name unresolved'), never a bare id.
  return cleaned || topicRef(topicKey).replace(/"/g, '');
}

/**
 * The owner's "yes" in conversation A to a proposal targeting conversation B: re-check, then write.
 * Extracted so the authority-granting branch is tested with its dependencies as arguments.
 */
export async function applyCrossTopicConfirm(input: {
  sourceTopicKey: string;
  targetTopicKey: string;
  patch: Record<string, unknown>;
  agentComposed: boolean;
  principal: { kind: 'operator'; platform: string; uid: string };
  eligibility: (confirmerUid: string, destKey: string, sourceKey: string) => { ok: true } | { ok: false; reason: string };
  applyWrite: (req: {
    topicKey: string; patch: Record<string, unknown>; principal: { kind: 'operator'; platform: string; uid: string };
    origin: 'propose-confirm'; agentComposedPayload: boolean; discloseInReply: true; crossTopicConfirm: { sourceTopicId: number };
  }) => Promise<{ reply: string }>;
}): Promise<{ written: boolean; reply: string }> {
  const eligible = input.eligibility(input.principal.uid, input.targetTopicKey, input.sourceTopicKey);
  if (!eligible.ok) return { written: false, reply: crossTopicRefusalText(eligible.reason) };
  const result = await input.applyWrite({
    topicKey: input.targetTopicKey,
    patch: input.patch,
    principal: input.principal,
    origin: 'propose-confirm',
    agentComposedPayload: input.agentComposed,
    discloseInReply: true,
    crossTopicConfirm: { sourceTopicId: Number(input.sourceTopicKey) },
  });
  return { written: true, reply: result.reply };
}

/** Plain words for a cross-conversation yes that could not be applied (said in the conversation where the yes came). */
export function crossTopicRefusalText(reason: string): string {
  const why: Record<string, string> = {
    'destination-bound': 'someone else runs that conversation',
    'destination-confined': 'that conversation belongs to a team member',
    'destination-unknown': 'I could not confirm who runs that conversation',
    'source-not-owner': "only the agent's owner can confirm a change to another conversation",
    'source-shared': 'this conversation is shared with other people, so I keep changes to other conversations out of it',
    'switch-off': 'changing one conversation from another is switched off right now',
  };
  return `I didn't make that change: ${why[reason] ?? 'I could not confirm it is allowed right now'}. You can ask for it in that conversation instead.`;
}

/** Machine-local store, keyed by topic. A row is removed only when its topic is deleted. */
export class TopicCreationProvenanceStore {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'state', 'topic-creation-provenance.json');
  }

  // Read fresh every time: the route writes and the topic-profile surface reads through separate
  // instances, and reads are rare (a refused profile write, an explicit lookup).
  private load(): Record<string, ProvenanceRow> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { rows?: Record<string, ProvenanceRow> };
      return raw && typeof raw.rows === 'object' && raw.rows ? raw.rows : {};
    } catch {
      // @silent-fallback-ok: no file yet, or unreadable: empty. An empty store grants nothing.
      return {};
    }
  }

  get(topicId: number): ProvenanceRow | null {
    return this.load()[String(topicId)] ?? null;
  }

  /** Record a new topic; a topic already recorded keeps its original row and gains a reuse event. */
  record(row: ProvenanceRow): void {
    const existing = this.load()[String(row.topicId)];
    const next: ProvenanceRow = existing
      ? { ...existing, reuses: [...(existing.reuses ?? []), { at: row.createdAt, session: row.session, linked: row.source.kind === 'linked-message' ? row.source.linked : null }].slice(-50) }
      : row;
    const rows = { ...this.load(), [String(row.topicId)]: next };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    SafeFsExecutor.atomicWriteJsonSync(this.file, { version: 1, rows }, { operation: 'TopicCreationProvenanceStore.record' });
  }

  remove(topicId: number): void {
    const rows = { ...this.load() };
    if (!(String(topicId) in rows)) return;
    delete rows[String(topicId)];
    SafeFsExecutor.atomicWriteJsonSync(this.file, { version: 1, rows }, { operation: 'TopicCreationProvenanceStore.remove' });
  }
}
