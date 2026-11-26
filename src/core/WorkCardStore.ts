/**
 * WorkCardStore — the `work-card-record` replicated-store kind (store key `workBoard`)
 * for the Work Board, phase 1 (docs/specs/work-board-asks.md).
 *
 * A card is a work agreement between named principals. It is not a conversation: it
 * holds the facts code must enforce (who must act, what an approval covers, when a card
 * is finished) and owns ONE app conversation for everything else (§2).
 *
 * Substrate rule (same as ChiefOfStaffStore): the replicated substrate merges one whole
 * record per key by highest HLC, so every record is IMMUTABLE and EVENT-KEYED, and every
 * view is a pure FOLD over the union, in HLC order with ties broken by origin machine id.
 * No record carries a value the fold trusts: the material hash, approval validity, the
 * derived status and the lane are recomputed by the fold on every machine (§3, §5).
 *
 * Record kinds (`recordType`):
 *   created       the card's first material fields; key `wc:<id>:created`
 *   edited        changed fields only; key `wc:<id>:e:<hlc>`
 *   waiting-on    principal + question; its record key IS the question id
 *   tap           a person-proven action (§4); key `wc:<id>:t:<hlc>`
 *   evidence      per done item, bound to the material hash + reopens seen
 *   claimed-done  the agent's claim, bound the same way
 *   dispatching   the pickup controller's durable intent (system only)
 *   dispatched    the pickup controller's closing record (system only)
 *   policy        board-level approval policy (person only); key `wb-policy:<id>`
 *   graduation    the pilot's day-7 / day-14 measurement (system only); key `wb-graduation:day<N>`
 *   note          the lease holder's pointer to a progress-note conversation event (system only;
 *                 agent-work-cards-default §2); key `wc:<id>:n:<eventId hash>`
 *   hold-lifted   the pickup hold on a gate-written card was lifted (system only; §3); key `wc:<id>:hl:once`
 *   quiet-repickup the one automatic re-pickup of a quiet card (system only; §3); key `wc:<id>:qr:<newest agent record hash>`
 *   enabled-at    the request-to-card gate's first run for a team (system only, non-card; §3); key `wb-request-cards:enabled-at:<teamKey>`
 *
 * This module is PURE: schema, builders and folds. No I/O.
 */

import { decodeWorkBoardApprovalEvent } from './WorkBoardApprovalWriter.js';
import { createHash, randomBytes } from 'node:crypto';
import type { StoreFieldSchema, StoreValidateContext } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import { compareHlc } from './TopicPinReplicatedStore.js';
import { resolveDevAgentGate } from './devAgentGate.js';

export { compareHlc };

export const WORK_CARD_RECORD_KIND = 'work-card-record';
export const WORK_BOARD_STORE_KEY = 'workBoard';

/** `workBoard.enabled` omitted ⇒ live on a development agent, dark on the fleet (§Migration). */
export function workBoardEnabled(config: { developmentAgent?: boolean; workBoard?: { enabled?: boolean } } | undefined): boolean {
  return resolveDevAgentGate(config?.workBoard?.enabled, config);
}

export const WORK_RECORD_TYPES = ['created', 'edited', 'waiting-on', 'tap', 'evidence', 'claimed-done', 'dispatching', 'dispatched', 'policy', 'graduation', 'note', 'hold-lifted', 'quiet-repickup', 'enabled-at'] as const;
export type WorkRecordType = typeof WORK_RECORD_TYPES[number];
/** Record kinds that name no card (board-level). */
export const NON_CARD_RECORD_TYPES: ReadonlySet<string> = new Set(['policy', 'graduation', 'enabled-at']);
/** System-written record kinds the lease holder's runtime writes (never a route). */
export type SystemRecordType = 'dispatching' | 'dispatched' | 'note' | 'hold-lifted' | 'quiet-repickup' | 'enabled-at';

export const MATERIAL_FIELDS = ['title', 'need', 'doneWhen', 'carrier', 'outward', 'links'] as const;
export type MaterialField = typeof MATERIAL_FIELDS[number];
/** `refs` is NON-material (agent-work-cards-default §3): internal references, never part of the approval hash. */
const EDITABLE_FIELDS = [...MATERIAL_FIELDS, 'recommendation', 'due', 'projectKey', 'whyYou', 'covers', 'mirror', 'brief', 'refs'] as const;
export type EditableField = typeof EDITABLE_FIELDS[number];

/** Fields only the in-process request-to-card gate may write (agent-work-cards-default §3 "Gate-only fields"). */
export const GATE_ONLY_FIELDS = ['requester', 'requestTextHash', 'recordedAsHash', 'pickupHold'] as const;
export const REF_KINDS = ['commitment', 'blocker-ledger', 'parent-card'] as const;
export type RefKind = typeof REF_KINDS[number];
export interface CardRef { kind: RefKind; id: string }
export const MAX_REFS = 20;
const REF_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
/** The fixed prefix a progress-note conversation event carries; `SCHEMA_MAX.noteText` is the store's text ceiling minus it. */
export const NOTE_EVENT_PREFIX = 'Work board: the agent noted: ';
/** The app-conversation store's `MAX_STORED_TEXT` (kept in step by tests/unit/agent-work-cards-store.test.ts). */
const APP_CONVERSATION_MAX_STORED_TEXT = 16_000;
/** Hold lifts and quiet re-pickups wait this long past `quietAfterHours` before the clock alone derives `quiet`: the holder's self-heal gets first (§3 "Quiet, with one self-heal first"). */
export const QUIET_CLOCK_GRACE_MS = 5 * 60_000;
/** The reasons a `hold-lifted` record may carry. */
export const HOLD_LIFT_REASONS = ['quiet', 'person-cause', 'system-cause'] as const;
export type HoldLiftReason = typeof HOLD_LIFT_REASONS[number];

export const PERMITTING_TAPS = ['approve', 'answer', 'confirm-done', 'unhold', 'retry', 'unarchive'] as const;
export const RESTRICTING_TAPS = ['hold', 'withdraw-approval', 'reopen', 'archive', 'redact'] as const;
export const TAP_ACTIONS = [...PERMITTING_TAPS, ...RESTRICTING_TAPS] as const;
export type TapAction = typeof TAP_ACTIONS[number];
export function isRestrictingTap(a: string): boolean { return (RESTRICTING_TAPS as ReadonlyArray<string>).includes(a); }

export const POLICIES = ['every-agent-card', 'outward-only'] as const;
export type ApprovalPolicy = typeof POLICIES[number];

export const DISPATCH_OUTCOMES = ['injected', 'spawned', 'refused', 'void', 'parked', 'stopped', 'not-delivered', 'rearmed'] as const;
export type DispatchOutcome = typeof DISPATCH_OUTCOMES[number];

/** Absolute schema ceilings (every machine must accept what any owner-raised limit allows).
 *  The owner-set per-field limits (`workBoard.limits`) are enforced at the write route. */
export const SCHEMA_MAX = { title: 2000, need: 64000, recommendation: 32000, whyYou: 32000, coverKeys: 256, doneItemText: 8000, optionText: 2000, linkLabel: 300, url: 2000, reason: 2000, evidence: 32000, answer: 8000, question: 8000, closeNote: 2000, noteText: APP_CONVERSATION_MAX_STORED_TEXT - NOTE_EVENT_PREFIX.length } as const;

/**
 * How a person closes a card (work-front-doors §6, Luna's board): "Done" with a closeout note, or "Not
 * important" with a reason the agent learns from. Both are an `archive` tap carrying `closeAs` + `note`, so a
 * machine on an older build still folds the card as archived (it drops the two unknown fields) instead of
 * reading the card as unreadable; `unarchive` (naming the tap) reopens it.
 */
export const CLOSE_AS = ['done', 'not-important'] as const;
export type CloseAs = typeof CLOSE_AS[number];

// ── identity ────────────────────────────────────────────────────────────────

const CARD_ID_RE = /^wc_[0-9a-f]{16}$/;
const PERSON_KEY_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MACHINE_RE = /^[\w-]{1,64}$/;
export const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RECORD_ID_RE = /^(wc:wc_[0-9a-f]{16}:[A-Za-z0-9_.:-]{1,200}|wb-policy:[A-Za-z0-9_.:-]{1,120}|wb-graduation:day(7|14)|wb-request-cards:[A-Za-z0-9_.:-]{1,160})$/;
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const CONVERSATION_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `general` is the reserved home of a task with no project (agent-work-cards-default §4); not a conversation. */
export const GENERAL_PROJECT_KEY = 'general';
const PROJECT_KEY_RE = /^((telegram|app|slack|imessage|whatsapp):[A-Za-z0-9_.:-]{1,128}|general)$/;
/** A recording conversation named by a pickup hold or a card source: an app key, `telegram:<topic>` or `slack:<channel>:<thread>`. */
const SOURCE_CONVERSATION_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|telegram:-?\d{1,20}|slack:[A-Za-z0-9_.:-]{1,160})$/;
export function isSourceConversationKey(v: unknown): v is string { return typeof v === 'string' && SOURCE_CONVERSATION_RE.test(v); }
/** A Needs-you item key a card says it is about (docs/specs/work-board-cards-appear.md §3). Which ones a writer may use is the service's rule. */
export const NEED_REF_RE = /^[a-z][a-z0-9-]*:[A-Za-z0-9_.:#@-]{1,200}$/;
const MIRROR_REF_MAX = 300;
/** The opening check's note a wait card keeps (the Chief of Staff store records at most 500 characters). */
const MIRROR_NOTE_MAX = 2000;

export function isCardId(v: unknown): v is string { return typeof v === 'string' && CARD_ID_RE.test(v); }
export function isRecordId(v: unknown): v is string { return typeof v === 'string' && RECORD_ID_RE.test(v); }

export function hlcKey(h: HlcTimestamp): string { return `${h.physical}.${h.logical}.${h.node}`; }

/** §2: the card's conversation key is a pure function of the card id, formatted as the
 *  app-conversation store's UUID key — every machine names the same conversation. */
export function cardConversationKey(cardId: string): string {
  const h = createHash('sha256').update(`work-card:${cardId}`).digest('hex');
  // Shaped exactly as the store.s own keys (version nibble 4, variant 8..b) so its validator accepts it.
  const v = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ── value types ─────────────────────────────────────────────────────────────

export interface DoneWhenItem { id: string; text: string; certify: 'owner-confirms' | 'agent-may-certify' }
export type CardLink = { label: string; url: string } | { label: string; attachmentId: string; sha256: string };
export type Carrier = 'agent' | { personKey: string };
export type Principal = 'agent' | 'none' | { personKey: string };
/**
 * `isOwner` on a person write is stamped by the SERVER from the team record (agent-work-cards-default §3
 * "Gate-only fields"), never accepted from a body; absent on records older than this field.
 */
export type By = { kind: 'person'; personKey: string; proof: 'pin' | 'presence'; isOwner?: boolean } | { kind: 'agent' } | { kind: 'system' };
/** Who asked for a gate-written card, read from the durable message row (§3); gate-only. */
export interface CardRequester { personKey: string; isOwner: boolean }
/** Why a gate-written card's pickup is held (§3 "Pickup hold"). */
export type PickupHold = { kind: 'recording-session'; conversationKey: string } | { kind: 'backfill' };
export interface CardMirror { ref: string; hlc: HlcTimestamp; waitSince?: string; note?: string; waitRef?: string; cleared?: boolean }

/** A done-when item's state as a card's brief shows it. */
export const BRIEF_CHECK_STATUSES = ['passes', 'needs-you', 'unknown', 'fails'] as const;
export type BriefCheckStatus = typeof BRIEF_CHECK_STATUSES[number];
/**
 * The structured, plain-text summary a server-owned card carries next to its prose `need` (a Chief of Staff wait
 * card: what is asked, the goal, the done-when items with their state, the check's own words, when the wait
 * started). Display only and NOT material: it is outside the material hash, so writing or changing it voids no
 * approval, evidence or finish. Only the server's own writer sets it.
 */
export interface CardBrief { ask: string; goal?: string; checks?: Array<{ text: string; status: BriefCheckStatus }>; chiefSaid?: string; waitingSince?: string }
export const BRIEF_MAX = { ask: 2000, goal: 8000, checks: 256, chiefSaid: 8000 } as const;

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_RE.test(v);
const isHlc = (v: unknown): v is HlcTimestamp => {
  if (!v || typeof v !== 'object') return false;
  const h = v as Record<string, unknown>;
  return Number.isFinite(h.physical) && Number.isInteger(h.logical) && typeof h.node === 'string' && MACHINE_RE.test(h.node);
};

function vDoneWhen(v: unknown): DoneWhenItem[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 256) return null;
  const seen = new Set<string>();
  const out: DoneWhenItem[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return null;
    const it = raw as Record<string, unknown>;
    if (typeof it.id !== 'string' || !ITEM_ID_RE.test(it.id) || seen.has(it.id)) return null;
    if (!isStr(it.text, SCHEMA_MAX.doneItemText)) return null;
    const certify = it.certify === undefined ? 'owner-confirms' : it.certify;
    if (certify !== 'owner-confirms' && certify !== 'agent-may-certify') return null;
    seen.add(it.id);
    out.push({ id: it.id, text: it.text, certify });
  }
  return out;
}

function vLinks(v: unknown): CardLink[] | null {
  if (!Array.isArray(v) || v.length > 256) return null;
  const out: CardLink[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return null;
    const l = raw as Record<string, unknown>;
    if (!isStr(l.label, SCHEMA_MAX.linkLabel)) return null;
    if (typeof l.url === 'string') {
      if (l.attachmentId !== undefined) return null;
      if (!isStr(l.url, SCHEMA_MAX.url)) return null;
      let u: URL; try { u = new URL(l.url); } catch { return null; /* @silent-fallback-ok: not a URL means the link is invalid, which rejects the whole record */ }
      if (u.protocol !== 'https:' || !u.hostname) return null;
      out.push({ label: l.label, url: l.url });
    } else if (typeof l.attachmentId === 'string') {
      if (!ATTACHMENT_ID_RE.test(l.attachmentId) || typeof l.sha256 !== 'string' || !SHA256_RE.test(l.sha256)) return null;
      out.push({ label: l.label, attachmentId: l.attachmentId, sha256: l.sha256 });
    } else return null;
  }
  return out;
}

function vCarrier(v: unknown): Carrier | null {
  if (v === 'agent') return 'agent';
  if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).personKey === 'string' && PERSON_KEY_RE.test((v as Record<string, string>).personKey)) return { personKey: (v as Record<string, string>).personKey };
  return null;
}

function vPrincipal(v: unknown): Principal | null {
  if (v === 'agent' || v === 'none') return v;
  return vCarrier(v) as Principal | null;
}

function vBy(v: unknown): By | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Record<string, unknown>;
  if (b.kind === 'agent') return { kind: 'agent' };
  if (b.kind === 'system') return { kind: 'system' };
  if (b.kind === 'person' && typeof b.personKey === 'string' && PERSON_KEY_RE.test(b.personKey) && (b.proof === 'pin' || b.proof === 'presence')) {
    return { kind: 'person', personKey: b.personKey, proof: b.proof, ...(typeof b.isOwner === 'boolean' ? { isOwner: b.isOwner } : {}) };
  }
  return null;
}

function vRefs(v: unknown): CardRef[] | null {
  if (!Array.isArray(v) || v.length > MAX_REFS) return null;
  const out: CardRef[] = []; const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (!(REF_KINDS as ReadonlyArray<string>).includes(r.kind as string) || typeof r.id !== 'string' || !REF_ID_RE.test(r.id)) return null;
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: r.kind as RefKind, id: r.id });
  }
  return out;
}

function vRequester(v: unknown): CardRequester | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.personKey !== 'string' || !PERSON_KEY_RE.test(r.personKey) || typeof r.isOwner !== 'boolean') return null;
  return { personKey: r.personKey, isOwner: r.isOwner };
}

function vPickupHold(v: unknown): PickupHold | null {
  if (!v || typeof v !== 'object') return null;
  const h = v as Record<string, unknown>;
  if (h.kind === 'backfill') return { kind: 'backfill' };
  if (h.kind === 'recording-session' && isSourceConversationKey(h.conversationKey)) return { kind: 'recording-session', conversationKey: h.conversationKey };
  return null;
}

function vIdList(v: unknown, max = 256): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  for (const x of v) if (!isRecordId(x)) return null;
  return [...new Set(v as string[])].sort();
}

function vBrief(v: unknown): CardBrief | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const b = v as Record<string, unknown>;
  if (!isStr(b.ask, BRIEF_MAX.ask)) return null;
  const out: CardBrief = { ask: b.ask };
  if (b.goal !== undefined) { if (!isStr(b.goal, BRIEF_MAX.goal)) return null; out.goal = b.goal; }
  if (b.checks !== undefined) {
    if (!Array.isArray(b.checks) || b.checks.length > BRIEF_MAX.checks) return null;
    const checks: NonNullable<CardBrief['checks']> = [];
    for (const raw of b.checks) {
      const c = raw as Record<string, unknown> | null;
      if (!c || typeof c !== 'object' || !isStr(c.text, SCHEMA_MAX.doneItemText) || !(BRIEF_CHECK_STATUSES as ReadonlyArray<string>).includes(c.status as string)) return null;
      checks.push({ text: c.text, status: c.status as BriefCheckStatus });
    }
    out.checks = checks;
  }
  if (b.chiefSaid !== undefined) { if (!isStr(b.chiefSaid, BRIEF_MAX.chiefSaid)) return null; out.chiefSaid = b.chiefSaid; }
  if (b.waitingSince !== undefined) { if (!isIso(b.waitingSince)) return null; out.waitingSince = b.waitingSince; }
  return out;
}

/** Validates the editable-field subset present on a `created` / `edited` record. */
function vFields(raw: Record<string, unknown>, requireAll: boolean): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const has = (k: string) => raw[k] !== undefined;
  if (requireAll) for (const k of ['title', 'need', 'doneWhen', 'carrier', 'outward'] as const) if (!has(k)) return null;
  if (has('title')) { if (!isStr(raw.title, SCHEMA_MAX.title)) return null; out.title = raw.title; }
  if (has('need')) { if (!isStr(raw.need, SCHEMA_MAX.need)) return null; out.need = raw.need; }
  if (has('doneWhen')) { const d = vDoneWhen(raw.doneWhen); if (!d) return null; out.doneWhen = d; }
  if (has('carrier')) { const c = vCarrier(raw.carrier); if (!c) return null; out.carrier = c; }
  if (has('outward')) { if (typeof raw.outward !== 'boolean') return null; out.outward = raw.outward; }
  if (has('links')) { const l = vLinks(raw.links); if (!l) return null; out.links = l; }
  else if (requireAll) out.links = [];
  if (has('recommendation')) {
    if (raw.recommendation !== null && !isStr(raw.recommendation, SCHEMA_MAX.recommendation)) return null;
    out.recommendation = raw.recommendation;
  }
  if (has('due')) { if (raw.due !== null && !(typeof raw.due === 'string' && DATE_RE.test(raw.due))) return null; out.due = raw.due; }
  if (has('projectKey')) { if (raw.projectKey !== null && !(typeof raw.projectKey === 'string' && PROJECT_KEY_RE.test(raw.projectKey))) return null; out.projectKey = raw.projectKey; }
  if (has('whyYou')) {
    if (raw.whyYou !== null && !isStr(raw.whyYou, SCHEMA_MAX.whyYou)) return null;
    out.whyYou = raw.whyYou;
  }
  if (has('covers')) {
    const c = raw.covers;
    if (!Array.isArray(c) || c.length > SCHEMA_MAX.coverKeys || !c.every((k) => typeof k === 'string' && NEED_REF_RE.test(k))) return null;
    out.covers = [...new Set(c as string[])];
  }
  if (has('mirror')) {
    // The source record a server-owned card mirrors (work-board-cards-appear §1 Fencing). Null clears it.
    const m = raw.mirror as Record<string, unknown> | null;
    if (m !== null) {
      if (!m || typeof m !== 'object' || !isStr(m.ref, MIRROR_REF_MAX) || !isHlc(m.hlc)) return null;
      if (m.waitSince !== undefined && !isIso(m.waitSince)) return null;
      if (m.note !== undefined && !(typeof m.note === 'string' && m.note.length <= MIRROR_NOTE_MAX)) return null;
      if (m.waitRef !== undefined && !isStr(m.waitRef, MIRROR_REF_MAX)) return null;
      if (m.cleared !== undefined && typeof m.cleared !== 'boolean') return null;
      const h = m.hlc as HlcTimestamp;
      out.mirror = { ref: m.ref, hlc: { physical: h.physical, logical: h.logical, node: h.node }, ...(m.waitSince !== undefined ? { waitSince: m.waitSince } : {}), ...(m.note !== undefined ? { note: m.note } : {}), ...(m.waitRef !== undefined ? { waitRef: m.waitRef } : {}), ...(m.cleared === true ? { cleared: true } : {}) };
    } else out.mirror = null;
  }
  if (has('brief')) {
    // Display only (not material). Null clears it. An older machine drops the unknown field and keeps the record.
    if (raw.brief === null) out.brief = null;
    else { const b = vBrief(raw.brief); if (!b) return null; out.brief = b; }
  }
  if (has('refs')) {
    // Non-material internal references (agent-work-cards-default §3): bounded, typed, never a URL. An older
    // machine drops the unknown field and keeps the record.
    const r = vRefs(raw.refs); if (!r) return null; out.refs = r;
  }
  return out;
}

// ── schema ──────────────────────────────────────────────────────────────────

const KNOWN_FIELDS = [
  'recordType', 'cardId', 'by', 'at',
  'title', 'need', 'doneWhen', 'carrier', 'outward', 'links', 'recommendation', 'due', 'projectKey', 'source', 'conversationKey',
  'whyYou', 'covers', 'mirror', 'brief',
  'principal', 'question', 'supersedes', 'reason',
  'action', 'materialHash', 'questionId', 'answer', 'claimId', 'retryOf', 'names', 'titleHash', 'policy',
  'itemId', 'text', 'attachmentIds', 'reopens', 'evidenceIds',
  'for', 'attempt', 'machineId', 'outcome', 'recovery', 'causeKind',
  'day', 'decision', 'metrics',
  // agent-work-cards-default: request-to-card fields, notes, holds, re-pickups and the gate's first run.
  'refs', 'requester', 'requestTextHash', 'recordedAsHash', 'pickupHold', 'eventId', 'eventIds', 'writerBinding', 'approvalBinding', 'teamKey', 'newestAgentRecordId',
] as const;

export const workCardRecordStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN_FIELDS as unknown as ReadonlyArray<string>,
  pathSensitiveFields: ['machineId'],
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    if (raw.op === 'delete') return null; // every record is immutable; nothing is ever tombstoned
    const r = raw as Record<string, unknown>;
    const type = r.recordType;
    if (typeof type !== 'string' || !(WORK_RECORD_TYPES as ReadonlyArray<string>).includes(type)) return null;
    const by = vBy(r.by);
    if (!by || !isIso(r.at)) return null;
    if (type === 'policy') {
      if (by.kind !== 'person') return null;
      if (typeof r.policy !== 'string' || !(POLICIES as ReadonlyArray<string>).includes(r.policy)) return null;
      return { recordType: type, by, at: r.at, policy: r.policy };
    }
    if (type === 'graduation') {
      // Maturation plan: written by the scheduled job's pass, never by a caller's body. An incomplete week is `incomplete`, never a pass.
      if (by.kind !== 'system') return null;
      if (r.day !== 7 && r.day !== 14) return null;
      if (r.decision !== 'measured' && r.decision !== 'incomplete') return null;
      if (!r.metrics || typeof r.metrics !== 'object' || Array.isArray(r.metrics) || JSON.stringify(r.metrics).length > 16_000) return null;
      return { recordType: type, by, at: r.at, day: r.day, decision: r.decision, metrics: r.metrics };
    }
    if (type === 'enabled-at') {
      // The request-to-card gate's first run for a team (agent-work-cards-default §3 "The first run"); the lease holder's own record.
      if (by.kind !== 'system') return null;
      if (!isStr(r.teamKey, 128)) return null;
      return { recordType: type, by, at: r.at, teamKey: r.teamKey };
    }
    if (!isCardId(r.cardId)) return null;
    const base = { recordType: type, cardId: r.cardId, by, at: r.at };
    switch (type as WorkRecordType) {
      case 'created': {
        if (by.kind === 'system') return null;
        const f = vFields(r, true); if (!f) return null;
        let source: { conversationKey: string; messageId: string } | undefined;
        if (r.source !== undefined) {
          const s = r.source as Record<string, unknown> | null;
          if (!s || typeof s !== 'object' || !isStr(s.conversationKey, 200) || !isStr(s.messageId, 200)) return null;
          source = { conversationKey: s.conversationKey as string, messageId: s.messageId as string };
        }
        // Gate-only fields (§3): validated here; WHO may write them is the service's rule.
        const gate: Record<string, unknown> = {};
        if (r.requester !== undefined) { const q = vRequester(r.requester); if (!q) return null; gate.requester = q; }
        if (r.requestTextHash !== undefined) { if (typeof r.requestTextHash !== 'string' || !SHA256_RE.test(r.requestTextHash)) return null; gate.requestTextHash = r.requestTextHash; }
        if (r.recordedAsHash !== undefined) { if (typeof r.recordedAsHash !== 'string' || !SHA256_RE.test(r.recordedAsHash)) return null; gate.recordedAsHash = r.recordedAsHash; }
        if (r.pickupHold !== undefined) { const h = vPickupHold(r.pickupHold); if (!h) return null; gate.pickupHold = h; }
        return { ...base, ...f, ...(source ? { source } : {}), ...gate };
      }
      case 'note': {
        // The holder's pointer to one note event, or to the events of one coalesced interval (§2). Ids only, never text.
        if (by.kind !== 'system') return null;
        if (r.eventId !== undefined) { if (!isStr(r.eventId, 200) || r.eventIds !== undefined) return null; return { ...base, eventId: r.eventId }; }
        if (!Array.isArray(r.eventIds) || r.eventIds.length === 0 || r.eventIds.length > 2000 || !r.eventIds.every((x) => isStr(x, 200))) return null;
        return { ...base, eventIds: [...new Set(r.eventIds as string[])] };
      }
      case 'hold-lifted': {
        if (by.kind !== 'system') return null;
        if (typeof r.reason !== 'string' || !(HOLD_LIFT_REASONS as ReadonlyArray<string>).includes(r.reason)) return null;
        return { ...base, reason: r.reason };
      }
      case 'quiet-repickup': {
        if (by.kind !== 'system') return null;
        if (!isRecordId(r.newestAgentRecordId)) return null;
        return { ...base, newestAgentRecordId: r.newestAgentRecordId };
      }
      case 'edited': {
        if (by.kind === 'system') return null;
        const f = vFields(r, false); if (!f || Object.keys(f).length === 0) return null;
        return { ...base, ...f };
      }
      case 'waiting-on': {
        if (by.kind === 'system') return null;
        const p = vPrincipal(r.principal); if (!p) return null;
        let question: { text: string; options?: string[] } | undefined;
        if (r.question !== undefined && r.question !== null) {
          const q = r.question as Record<string, unknown>;
          if (!q || typeof q !== 'object' || !isStr(q.text, SCHEMA_MAX.question)) return null;
          if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 64 || !q.options.every((o) => isStr(o, SCHEMA_MAX.optionText)))) return null;
          question = { text: q.text as string, ...(q.options !== undefined ? { options: q.options as string[] } : {}) };
        }
        if (typeof p === 'object' && !question) return null; // a person is waited on only with a question
        if (r.supersedes !== undefined && !isRecordId(r.supersedes)) return null;
        if (r.supersedes !== undefined && !isStr(r.reason, SCHEMA_MAX.reason)) return null;
        return { ...base, principal: p, ...(question ? { question } : {}), ...(r.supersedes !== undefined ? { supersedes: r.supersedes, reason: r.reason } : {}) };
      }
      case 'tap': {
        if (by.kind !== 'person') return null;
        if (typeof r.action !== 'string' || !(TAP_ACTIONS as ReadonlyArray<string>).includes(r.action)) return null;
        const out: Record<string, unknown> = { ...base, action: r.action };
        if (r.materialHash !== undefined) { if (typeof r.materialHash !== 'string' || !SHA256_RE.test(r.materialHash)) return null; out.materialHash = r.materialHash; }
        if (r.questionId !== undefined) { if (!isRecordId(r.questionId)) return null; out.questionId = r.questionId; }
        if (r.answer !== undefined) { if (!isStr(r.answer, SCHEMA_MAX.answer)) return null; out.answer = r.answer; }
        if (r.claimId !== undefined) { if (!isRecordId(r.claimId)) return null; out.claimId = r.claimId; }
        if (r.retryOf !== undefined) { if (!isRecordId(r.retryOf)) return null; out.retryOf = r.retryOf; }
        if (r.names !== undefined) { if (!isRecordId(r.names)) return null; out.names = r.names; }
        if (r.reopens !== undefined) { const l = vIdList(r.reopens); if (!l) return null; out.reopens = l; }
        if (r.titleHash !== undefined) { if (typeof r.titleHash !== 'string' || !SHA256_RE.test(r.titleHash)) return null; out.titleHash = r.titleHash; }
        if (r.closeAs !== undefined || r.note !== undefined) {
          // A close is an archive with its note: both fields together, never on another action, never an empty note.
          if (r.action !== 'archive' || typeof r.closeAs !== 'string' || !(CLOSE_AS as ReadonlyArray<string>).includes(r.closeAs)) return null;
          if (!isStr(r.note, SCHEMA_MAX.closeNote) || !(r.note as string).trim()) return null;
          out.closeAs = r.closeAs; out.note = r.note;
        }
        const a = r.action as TapAction;
        if (a === 'approve' && !out.materialHash) return null;
        if (r.approvalBinding !== undefined) {
          const binding = decodeWorkBoardApprovalEvent(r);
          if (!binding) return null;
          out.approvalBinding = binding.request;
        }
        if (a === 'answer' && (!out.questionId || !out.answer)) return null;
        if ((a === 'confirm-done' || a === 'reopen') && !out.claimId) return null;
        if ((a === 'unhold' || a === 'unarchive') && !out.names) return null;
        if (a === 'retry' && !out.retryOf) return null;
        if (a === 'confirm-done' && (!out.materialHash || !out.reopens)) return null;
        return out;
      }
      case 'evidence': {
        if (by.kind === 'system') return null;
        if (typeof r.itemId !== 'string' || !ITEM_ID_RE.test(r.itemId)) return null;
        if (!isStr(r.text, SCHEMA_MAX.evidence)) return null;
        if (typeof r.materialHash !== 'string' || !SHA256_RE.test(r.materialHash)) return null;
        const reopens = vIdList(r.reopens); if (!reopens) return null;
        let attachmentIds: string[] | undefined;
        if (r.attachmentIds !== undefined) {
          if (!Array.isArray(r.attachmentIds) || r.attachmentIds.length > 64 || !r.attachmentIds.every((x) => typeof x === 'string' && ATTACHMENT_ID_RE.test(x))) return null;
          attachmentIds = r.attachmentIds as string[];
        }
        return { ...base, itemId: r.itemId, text: r.text, materialHash: r.materialHash, reopens, ...(attachmentIds ? { attachmentIds } : {}) };
      }
      case 'claimed-done': {
        if (by.kind === 'system') return null;
        if (typeof r.materialHash !== 'string' || !SHA256_RE.test(r.materialHash)) return null;
        const reopens = vIdList(r.reopens); if (!reopens) return null;
        const evidenceIds = vIdList(r.evidenceIds); if (!evidenceIds || evidenceIds.length === 0) return null;
        return { ...base, materialHash: r.materialHash, reopens, evidenceIds };
      }
      case 'dispatching': {
        if (by.kind !== 'system') return null;
        if (!isRecordId(r.for) || !(Number.isInteger(r.attempt) && (r.attempt as number) >= 1) || typeof r.machineId !== 'string' || !MACHINE_RE.test(r.machineId)) return null;
        return { ...base, for: r.for, attempt: r.attempt, machineId: r.machineId, ...(r.recovery === true ? { recovery: true } : {}) };
      }
      case 'dispatched': {
        if (by.kind !== 'system') return null;
        if (!isRecordId(r.for)) return null;
        if (typeof r.outcome !== 'string' || !(DISPATCH_OUTCOMES as ReadonlyArray<string>).includes(r.outcome)) return null;
        if (r.attempt !== undefined && !(Number.isInteger(r.attempt) && (r.attempt as number) >= 0)) return null;
        if (r.reason !== undefined && !isStr(r.reason, 500)) return null;
        if (typeof r.machineId !== 'string' || !MACHINE_RE.test(r.machineId)) return null;
        return { ...base, for: r.for, outcome: r.outcome, machineId: r.machineId, ...(r.attempt !== undefined ? { attempt: r.attempt } : {}), ...(r.reason !== undefined ? { reason: r.reason } : {}), ...(r.recovery === true ? { recovery: true } : {}) };
      }
    }
    return null;
  },
};

export const WORK_CARD_KIND_REGISTRATION = { kind: WORK_CARD_RECORD_KIND, store: WORK_BOARD_STORE_KEY, schema: workCardRecordStoreSchema } as const;

// ── record keys + builders ──────────────────────────────────────────────────

export type Build = (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> | null;

/**
 * The record key for a new record. Event records get a minted id (the emitter needs the key
 * before it ticks the clock, for its witness read); `created` is fixed per card, and the
 * pickup controller's records are derived from the cause and attempt so a repeat is a no-op.
 */
export function mintRecordKey(recordType: WorkRecordType, cardId: string | null, extra?: { for?: string; attempt?: number; outcome?: string; eventId?: string; teamKey?: string; newestAgentRecordId?: string }): string {
  const rnd = randomBytes(8).toString('hex');
  switch (recordType) {
    case 'policy': return `wb-policy:${rnd}`;
    case 'graduation': return `wb-graduation:day${extra?.attempt ?? 7}`;
    case 'enabled-at': return `wb-request-cards:enabled-at:${(extra?.teamKey ?? 'team').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120)}`;
    // A note pointer is keyed by its event (one event, one pointer); a coalesced pointer by its first event.
    case 'note': return `wc:${cardId}:n:${shortId(extra?.eventId ?? rnd)}`;
    // A card is never re-held (§3), so its one lift has one key: two holders racing on a split lease write one record.
    case 'hold-lifted': return `wc:${cardId}:hl:once`;
    // Idempotent per newest agent-written record (§3 "Quiet"): a park's own system record cannot mint a new key.
    case 'quiet-repickup': return `wc:${cardId}:qr:${shortId(extra?.newestAgentRecordId ?? rnd)}`;
    case 'created': return `wc:${cardId}:created`;
    case 'edited': return `wc:${cardId}:e:${rnd}`;
    case 'waiting-on': return `wc:${cardId}:q:${rnd}`;
    case 'tap': return `wc:${cardId}:t:${rnd}`;
    case 'evidence': return `wc:${cardId}:v:${rnd}`;
    case 'claimed-done': return `wc:${cardId}:c:${rnd}`;
    case 'dispatching': return `wc:${cardId}:d:${shortId(extra?.for ?? '')}:${extra?.attempt ?? 0}`;
    case 'dispatched': return `wc:${cardId}:x:${shortId(extra?.for ?? '')}:${extra?.attempt ?? 0}:${extra?.outcome ?? 'x'}:${rnd}`;
  }
}

function shortId(id: string): string { return createHash('sha256').update(id).digest('hex').slice(0, 16); }

/** Builder for the emitter: (hlc, origin, observed) → envelope data. */
export function buildRecord(recordType: WorkRecordType, cardId: string | null, fields: Record<string, unknown>, recordKey?: string): Build {
  const key = recordKey ?? mintRecordKey(recordType, cardId, { for: fields.for as string | undefined, attempt: fields.attempt as number | undefined, outcome: fields.outcome as string | undefined, eventId: fields.eventId as string | undefined, teamKey: fields.teamKey as string | undefined, newestAgentRecordId: fields.newestAgentRecordId as string | undefined });
  return (hlc, origin, observed) => {
    if (!NON_CARD_RECORD_TYPES.has(recordType) && !isCardId(cardId)) return null;
    return { ...fields, recordType, ...(cardId ? { cardId } : {}), recordKey: key, hlc, op: 'put', origin, ...(observed ? { observed } : {}) };
  };
}

// ── canonical JSON + hashes ─────────────────────────────────────────────────

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

export function sha256Hex(s: string): string { return createHash('sha256').update(s).digest('hex'); }

export interface MaterialFields { title: string; need: string; doneWhen: DoneWhenItem[]; carrier: Carrier; outward: boolean; links: CardLink[] }

export function materialHashOf(m: MaterialFields): string {
  return sha256Hex(canonicalJson({ title: m.title, need: m.need, doneWhen: m.doneWhen, carrier: m.carrier, outward: m.outward, links: m.links }));
}

export function sameValue(a: unknown, b: unknown): boolean { return canonicalJson(a) === canonicalJson(b); }

/** The closed set of fields a phone presence signature covers (§4). */
export function tapActionLine(t: { action: string; cardId: string; materialHash?: string; questionId?: string; answer?: string; claimId?: string; retryOf?: string; names?: string; titleHash?: string; closeAs?: string; note?: string }): string {
  // `closeAs` and `note` enter the digest only when present, so every line an existing app signs is unchanged.
  const close = t.closeAs !== undefined || t.note !== undefined ? { closeAs: t.closeAs ?? null, note: t.note ?? null } : {};
  const digest = sha256Hex(canonicalJson({
    action: t.action, cardId: t.cardId, materialHash: t.materialHash ?? null, questionId: t.questionId ?? null,
    answer: t.answer ?? null, claimId: t.claimId ?? null, retryOf: t.retryOf ?? null, names: t.names ?? null, titleHash: t.titleHash ?? null,
    ...close,
  }));
  const label = t.closeAs === 'done' ? 'close as done' : t.closeAs === 'not-important' ? 'close as not important' : t.action;
  return `Work card ${t.cardId}: ${label} [${digest}]`;
}

// ── the fold ────────────────────────────────────────────────────────────────

export interface UnionEntry { data: Record<string, unknown>; origin: string }

/** A record as the fold sees it: validated, with its record id (= record key) and HLC. */
export interface FoldRecord { id: string; hlc: HlcTimestamp; origin: string; d: Record<string, unknown> }

export type CardStatus = 'removed' | 'unknown' | 'archived' | 'held' | 'needs-approval' | 'not-started' | 'claims-done' | 'done' | 'parked'
  | 'waiting-on-person' | 'with-person' | 'quiet' | 'with-agent';

export interface QuestionState { id: string; text: string; options?: string[]; principal: Principal; state: 'open' | 'answered' | 'replaced'; replacedBy?: string; reason?: string; answer?: string; answeredBy?: string; at: string }
export interface EvidenceState { id: string; itemId: string; text: string; attachmentIds?: string[]; materialHash: string; reopens: string[]; at: string; by: By; counts: boolean }
export interface ClaimState { id: string; materialHash: string; reopens: string[]; evidenceIds: string[]; at: string; counts: boolean; confirmedBy?: string }
export interface TapState { id: string; action: TapAction; by: By; at: string; hlc: HlcTimestamp; materialHash?: string; questionId?: string; answer?: string; claimId?: string; retryOf?: string; names?: string; closeAs?: CloseAs; note?: string; titleHash?: string }

/** The person's close in force (the newest archive tap still standing that carries a note). */
/**
 * `title`: the title the person closed (SEC-122). When the closing tap carries the hash of the title on
 * the person's screen, it is the title that matches that hash; otherwise the fold's title at the tap.
 * `titleUnconfirmed`: the tap carried no hash, or one that matches no title the card has had, so the
 * title shown is the fold's and may not be what the person saw.
 */
export interface CloseoutState { as: CloseAs; note: string; by: By; at: string; tapId: string; title: string; titleUnconfirmed?: true }

export interface CardFold {
  cardId: string;
  conversationKey: string;
  created: boolean;
  createdBy: By | null;
  createdAt: string | null;
  // fields
  title: string; need: string; doneWhen: DoneWhenItem[]; carrier: Carrier; outward: boolean; links: CardLink[];
  recommendation: string | null; due: string | null; projectKey: string | null; source: { conversationKey: string; messageId: string } | null;
  /** Why this needs the person (required on agent-written cards, work-board-cards-appear §2). */
  whyYou: string | null;
  /** The Needs-you item keys this card is about (§3). */
  covers: string[];
  /** The source record a server-owned card mirrors (§1 Fencing); null on every other card. */
  mirror: CardMirror | null;
  /** A server-owned card's structured summary (display only, not material); null on every other card. */
  brief: CardBrief | null;
  waitingOn: Principal;
  materialHash: string;
  lastWriter: Record<MaterialField, 'person' | 'agent'>;
  carrierTrail: Array<{ carrier: Carrier; by: By; at: string }>;
  questions: QuestionState[];
  openQuestion: QuestionState | null;
  evidence: EvidenceState[];
  claims: ClaimState[];
  taps: TapState[];
  reopens: string[];
  holds: string[];
  archives: string[];
  /** The newest standing archive when it was a person's Done or Not important close; null otherwise. */
  closeout: CloseoutState | null;
  redacted: { by: By; at: string } | null;
  approvalRequired: boolean;
  approvalValid: boolean;
  /**
   * The approval in force: a person's tap (`source: 'tap'`), or the team owner's own sender-verified request
   * (`source: 'requester-message'`, agent-work-cards-default §1 "The owner's own request is the yes"), whose
   * `by` names the requester with `proof: 'message'`.
   */
  approvedBy: { by: By | { kind: 'person'; personKey: string; proof: 'message' }; at: string; id: string; source: 'tap' | 'requester-message'; conversationKey?: string; messageId?: string } | null;
  withdrawn: boolean;
  currentClaim: ClaimState | null;
  needsConfirm: boolean;
  done: boolean;
  doneByAgentOwnEvidence: boolean;
  unknown: string[];
  newestRecordAt: number;
  /** The physical time of the newest AGENT-written record (a `note` pointer counts; a person's tap does not): the quiet clock (§3). */
  newestAgentRecordAt: number;
  /** The id of that newest agent-written record (the quiet re-pickup's idempotent key names it). */
  newestAgentRecordId: string | null;
  newestHlc: HlcTimestamp | null;
  /** Ids of records that changed a material field (fold order), for the transcript line. */
  lastMaterialChangeFields: string[];
  /** The index (fold order) of the last record that changed a material field; -1 when none after creation. */
  lastMaterialIdx: number;
  workable: boolean;
  policy: ApprovalPolicy;
  // ── agent-work-cards-default ──
  /** Internal references (non-material, §3): the commitment this card tracks, a Blocker Ledger entry, a parent card. */
  refs: CardRef[];
  /** Who asked, as the durable message row named them (gate-only; null = unverified or agent-initiated). */
  requester: CardRequester | null;
  requestTextHash: string | null;
  recordedAsHash: string | null;
  pickupHold: PickupHold | null;
  /** Held: `pickupHold` on `created` with no `hold-lifted` record after it (§3 "Pickup hold"). */
  pickupHeld: boolean;
  /** `need` is the owner's whole message and cannot be edited (§1 `need-locked-to-request`). */
  needLockedToRequest: boolean;
  /** Approval rests on the owner's own request (§1): valid while inward, agent-carried and not withdrawn. */
  requestApproved: boolean;
  /** `recordedAsHash ≠ requestTextHash`: the agent recorded the request in its own words (a label, not a judgment). */
  recordedInAgentWords: boolean;
  /** An agent `edited` touched `title` or `doneWhen` after creation (§1 "changed since asked"). */
  changedSinceAsked: boolean;
  /** An agent-work card (§1): agent-carried, inward, no recommendation, agent-written. */
  agentWork: boolean;
  /** `note` pointer records in fold order (ids only; the words are in the conversation). */
  notes: Array<{ id: string; eventIds: string[]; at: string }>;
  /** `quiet-repickup` records in fold order. */
  quietRepickups: Array<{ id: string; newestAgentRecordId: string; at: string }>;
  /** The `hold-lifted` record, when one exists. */
  holdLifted: { id: string; reason: HoldLiftReason; at: string } | null;
}

const EMPTY_LAST_WRITER = (): Record<MaterialField, 'person' | 'agent'> => ({ title: 'agent', need: 'agent', doneWhen: 'agent', carrier: 'agent', outward: 'agent', links: 'agent' });

export function toFoldRecords(entries: UnionEntry[], verifiedApprovalKey?: string): FoldRecord[] {
  const byKey = new Map<string, FoldRecord>();
  for (const e of entries) {
    const d = e.data;
    if (typeof d.recordKey !== 'string' || !isHlc(d.hlc)) continue;
    // Writer-bound approvals require an enrolled writer and durable projection gate.
    // Legacy callers omit the key and cannot fold the writer-bound namespace.
    if (d.recordKey !== verifiedApprovalKey
      && (d.approvalBinding !== undefined || /^wc:wc_[a-f0-9]{16}:approve:/.test(d.recordKey))) continue;
    const cur = byKey.get(d.recordKey);
    const rec: FoldRecord = { id: d.recordKey, hlc: d.hlc as HlcTimestamp, origin: String(d.origin ?? e.origin), d };
    if (!cur || compareHlc(rec.hlc, cur.hlc) > 0) byKey.set(d.recordKey, rec);
  }
  return [...byKey.values()].sort(foldOrder);
}

export function foldOrder(a: FoldRecord, b: FoldRecord): number {
  const c = compareHlc(a.hlc, b.hlc);
  if (c !== 0) return c;
  return a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The board policy at a point in fold order: the newest readable policy record, else `every-agent-card`. */
export function policyAt(policies: FoldRecord[], upTo?: HlcTimestamp): ApprovalPolicy {
  let p: ApprovalPolicy = 'every-agent-card';
  for (const r of policies) {
    if (upTo && compareHlc(r.hlc, upTo) > 0) break;
    const v = r.d.policy;
    p = v === 'outward-only' ? 'outward-only' : 'every-agent-card';
  }
  return p;
}

const byIsPerson = (b: By | null | undefined): b is Extract<By, { kind: 'person' }> => !!b && b.kind === 'person';

/**
 * Fold one card from its records (fold order) and the board's policy records.
 * `records` may include records past which a caller wants a prefix — pass a slice.
 */
export function foldCard(cardId: string, records: FoldRecord[], policies: FoldRecord[], opts?: { policyOverride?: ApprovalPolicy }): CardFold {
  const f: CardFold = {
    cardId, conversationKey: cardConversationKey(cardId), created: false, createdBy: null, createdAt: null,
    title: '', need: '', doneWhen: [], carrier: 'agent', outward: true, links: [], recommendation: null, due: null, projectKey: null, source: null,
    whyYou: null, covers: [], mirror: null, brief: null,
    waitingOn: 'agent', materialHash: '', lastWriter: EMPTY_LAST_WRITER(), carrierTrail: [], questions: [], openQuestion: null,
    evidence: [], claims: [], taps: [], reopens: [], holds: [], archives: [], closeout: null, redacted: null,
    approvalRequired: true, approvalValid: false, approvedBy: null, withdrawn: false, currentClaim: null, needsConfirm: false, done: false, doneByAgentOwnEvidence: false,
    unknown: [], newestRecordAt: 0, newestAgentRecordAt: 0, newestAgentRecordId: null, newestHlc: null, lastMaterialChangeFields: [], lastMaterialIdx: -1, workable: false, policy: 'every-agent-card',
    refs: [], requester: null, requestTextHash: null, recordedAsHash: null, pickupHold: null, pickupHeld: false, needLockedToRequest: false, requestApproved: false,
    recordedInAgentWords: false, changedSinceAsked: false, agentWork: false, notes: [], quietRepickups: [], holdLifted: null,
  };
  const validate = workCardRecordStoreSchema.validate;
  const ctx: StoreValidateContext = { countDroppedField: () => { /* counted by the envelope layer */ } } as unknown as StoreValidateContext;
  // Approval bookkeeping (fold order index of each relevant record).
  let approveIdx = -1; let approveRec: TapState | null = null; let withdrawIdx = -1;
  const releasedHolds = new Set<string>(); const holdIds: string[] = [];
  const releasedArchives = new Set<string>(); const archiveIds: string[] = [];
  // SEC-122: the title each archive tap closed: the one matching the hash the person's screen sent, else the
  // fold's title at the tap. `titlesSeen` is every title the card has had, in fold order.
  const titleAtArchive = new Map<string, { title: string; unconfirmed: boolean }>();
  const titlesSeen: string[] = [];
  const evidenceIdx = new Map<string, number>(); const claimIdx = new Map<string, number>();
  const confirms: Array<{ tap: TapState; idx: number; reopens: string[] }> = [];
  let idx = -1;
  // A card's `created` record is folded first whatever its clock: a fixed-id card's `created` written
  // again in a lease race (before the first replicated) takes the newer clock under its one key, and must
  // not make the card's earlier records read as written before the card existed (work-board-cards-appear §1).
  const createdAt = records.findIndex((r) => r.d.cardId === cardId && r.d.recordType === 'created');
  const ordered = createdAt > 0 ? [records[createdAt], ...records.slice(0, createdAt), ...records.slice(createdAt + 1)] : records;
  for (const rec of ordered) {
    idx++;
    if (rec.d.cardId !== cardId) continue;
    const v = validate(rec.d, ctx);
    const physical = rec.hlc.physical;
    if (physical > f.newestRecordAt) f.newestRecordAt = physical;
    if (!f.newestHlc || compareHlc(rec.hlc, f.newestHlc) > 0) f.newestHlc = rec.hlc;
    if (!v) { f.unknown.push(rec.id); continue; }
    const by = v.by as By;
    const at = v.at as string;
    const type = v.recordType as WorkRecordType;
    // The quiet clock reads the AGENT's activity (agent-work-cards-default §3): its own records, the holder's note
    // pointers (presence in the card's conversation), the card's creation (the baseline: a new card is never quiet at
    // birth) and a delivered hand-over (the agent was just given the card). A person's tap does not reset it.
    const handedOver = type === 'dispatched' && (v.outcome === 'injected' || v.outcome === 'spawned');
    if (by.kind === 'agent' || type === 'note' || type === 'created' || handedOver) {
      if (physical >= f.newestAgentRecordAt) { f.newestAgentRecordAt = physical; f.newestAgentRecordId = rec.id; }
    }
    // After a redact, only person taps and the pickup controller's closing records count.
    if (f.redacted && !(type === 'tap' || type === 'dispatched')) continue;
    switch (type) {
      case 'created': {
        if (f.created) break;
        f.created = true; f.createdBy = by; f.createdAt = at;
        for (const k of EDITABLE_FIELDS) if (v[k] !== undefined) (f as unknown as Record<string, unknown>)[k] = v[k];
        titlesSeen.push(f.title);
        if (v.source) f.source = v.source as CardFold['source'];
        if (v.requester) f.requester = v.requester as CardRequester;
        if (typeof v.requestTextHash === 'string') f.requestTextHash = v.requestTextHash;
        if (typeof v.recordedAsHash === 'string') f.recordedAsHash = v.recordedAsHash;
        if (v.pickupHold) f.pickupHold = v.pickupHold as PickupHold;
        // The owner's yes is anchored to the row's whole text: `need` is then immutable (§1).
        f.needLockedToRequest = !!(f.requester?.isOwner && f.requestTextHash);
        const w = byIsPerson(by) ? 'person' : 'agent';
        for (const k of MATERIAL_FIELDS) f.lastWriter[k] = w;
        f.carrierTrail.push({ carrier: f.carrier, by, at });
        f.lastMaterialIdx = idx; // creation is the first material write
        break;
      }
      case 'edited': {
        if (!f.created) { f.unknown.push(rec.id); break; }
        const changed: string[] = [];
        for (const k of EDITABLE_FIELDS) {
          if (v[k] === undefined) continue;
          // A locked `need` never moves, whichever machine's record says so (the route refuses; the fold is the authority).
          if (k === 'need' && f.needLockedToRequest) continue;
          const cur = (f as unknown as Record<string, unknown>)[k];
          if (sameValue(cur, v[k])) continue;
          (f as unknown as Record<string, unknown>)[k] = v[k];
          if ((MATERIAL_FIELDS as ReadonlyArray<string>).includes(k)) {
            changed.push(k);
            f.lastWriter[k as MaterialField] = byIsPerson(by) ? 'person' : 'agent';
          }
        }
        if (v.title !== undefined && titlesSeen[titlesSeen.length - 1] !== f.title) titlesSeen.push(f.title);
        if (v.carrier !== undefined && changed.includes('carrier')) f.carrierTrail.push({ carrier: f.carrier, by, at });
        if (changed.length) { f.lastMaterialIdx = idx; f.lastMaterialChangeFields = changed; }
        // "changed since asked" (§1): a deterministic label on a request-approved card, never a judgment of meaning.
        if (!byIsPerson(by) && (changed.includes('title') || changed.includes('doneWhen'))) f.changedSinceAsked = true;
        break;
      }
      case 'note': {
        if (!f.created) break;
        f.notes.push({ id: rec.id, eventIds: Array.isArray(v.eventIds) ? (v.eventIds as string[]) : [String(v.eventId)], at });
        break;
      }
      case 'hold-lifted': {
        if (!f.created) break;
        if (!f.holdLifted) f.holdLifted = { id: rec.id, reason: v.reason as HoldLiftReason, at };
        break;
      }
      case 'quiet-repickup': {
        if (!f.created) break;
        f.quietRepickups.push({ id: rec.id, newestAgentRecordId: String(v.newestAgentRecordId), at });
        break;
      }
      case 'waiting-on': {
        const open = f.questions.find((q) => q.state === 'open');
        const q = v.question as { text: string; options?: string[] } | undefined;
        if (open) {
          // The WRITE route requires a replacement to name the open question and give a reason. A record
          // that does not (two machines asked at once, neither having seen the other) still replaces the
          // earlier one here, visibly: an unreadable card that nothing could ever clear would be worse.
          open.state = 'replaced'; open.replacedBy = rec.id;
          open.reason = v.supersedes === open.id ? (v.reason as string) : 'another question was asked at the same time on another machine';
        }
        f.waitingOn = v.principal as Principal;
        if (q) f.questions.push({ id: rec.id, text: q.text, ...(q.options ? { options: q.options } : {}), principal: v.principal as Principal, state: 'open', at });
        break;
      }
      case 'tap': {
        const t: TapState = { id: rec.id, action: v.action as TapAction, by, at, hlc: rec.hlc,
          ...(v.materialHash ? { materialHash: v.materialHash as string } : {}), ...(v.questionId ? { questionId: v.questionId as string } : {}),
          ...(v.answer ? { answer: v.answer as string } : {}), ...(v.claimId ? { claimId: v.claimId as string } : {}),
          ...(v.retryOf ? { retryOf: v.retryOf as string } : {}), ...(v.names ? { names: v.names as string } : {}),
          ...(v.closeAs ? { closeAs: v.closeAs as CloseAs, note: v.note as string } : {}), ...(v.titleHash ? { titleHash: v.titleHash as string } : {}) };
        f.taps.push(t);
        switch (t.action) {
          case 'approve': {
            // Permitting: counts only when it covers the card as folded at this point.
            const hashNow = f.created ? materialHashOf(f) : '';
            if (t.materialHash === hashNow) { approveIdx = idx; approveRec = t; }
            break;
          }
          case 'withdraw-approval': withdrawIdx = idx; break;
          case 'answer': {
            const q = f.questions.find((x) => x.id === t.questionId);
            if (q && q.state === 'open') {
              q.state = 'answered'; q.answer = t.answer; q.answeredBy = (by as { personKey?: string }).personKey;
              if (typeof f.waitingOn === 'object') f.waitingOn = 'agent';
            }
            break;
          }
          case 'hold': holdIds.push(t.id); break;
          case 'unhold': if (t.names) releasedHolds.add(t.names); break;
          case 'archive': {
            archiveIds.push(t.id);
            // No hash from the person's screen: the fold's title is a guess, so it is marked unconfirmed.
            let closed = { title: f.title, unconfirmed: !t.titleHash };
            if (t.titleHash && sha256Hex(f.title) !== t.titleHash) {
              const seen = [...titlesSeen].reverse().find((x) => sha256Hex(x) === t.titleHash);
              closed = seen !== undefined ? { title: seen, unconfirmed: false } : { title: f.title, unconfirmed: true };
            }
            titleAtArchive.set(t.id, closed);
            break;
          }
          case 'unarchive': if (t.names) releasedArchives.add(t.names); break;
          case 'reopen': f.reopens.push(t.id); break;
          case 'confirm-done': confirms.push({ tap: t, idx, reopens: (v.reopens as string[]) ?? [] }); break;
          case 'redact': if (!f.redacted) f.redacted = { by, at }; break;
          case 'retry': break;
        }
        break;
      }
      case 'evidence': {
        f.evidence.push({ id: rec.id, itemId: v.itemId as string, text: v.text as string, ...(v.attachmentIds ? { attachmentIds: v.attachmentIds as string[] } : {}), materialHash: v.materialHash as string, reopens: v.reopens as string[], at, by, counts: false });
        evidenceIdx.set(rec.id, idx);
        break;
      }
      case 'claimed-done': {
        f.claims.push({ id: rec.id, materialHash: v.materialHash as string, reopens: v.reopens as string[], evidenceIds: v.evidenceIds as string[], at, counts: false });
        claimIdx.set(rec.id, idx);
        break;
      }
      case 'dispatching': case 'dispatched': case 'policy': case 'graduation': case 'enabled-at': break;
    }
  }
  f.reopens.sort();
  f.holds = holdIds.filter((h) => !releasedHolds.has(h));
  f.archives = archiveIds.filter((a) => !releasedArchives.has(a));
  // The close in force is the newest standing archive (fold order); a plain archive after a close replaces it.
  const standing = f.archives.length ? f.taps.find((t) => t.id === f.archives[f.archives.length - 1]) : undefined;
  const closedTitle = standing ? titleAtArchive.get(standing.id) : undefined;
  f.closeout = standing?.closeAs && standing.note ? { as: standing.closeAs, note: standing.note, by: standing.by, at: standing.at, tapId: standing.id, title: closedTitle?.title ?? f.title, ...(closedTitle?.unconfirmed ? { titleUnconfirmed: true as const } : {}) } : null;
  f.materialHash = f.created ? materialHashOf(f) : '';
  // The caller passes the policy records that apply (all of them for a read; the prefix seen so far when deriving causes).
  f.policy = opts?.policyOverride ?? policyAt(policies);
  if (!f.created) f.unknown.push(`wc:${cardId}:created`);

  // ── approval (§4) ──
  f.withdrawn = withdrawIdx > approveIdx && withdrawIdx >= 0;
  const allPerson = MATERIAL_FIELDS.every((k) => f.lastWriter[k] === 'person');
  if (f.withdrawn) f.approvalRequired = true;
  else if (f.outward) f.approvalRequired = true; // an outward card always needs its own approve tap
  // A card a person carries that sends nothing outward has no agent work for an approval to cover
  // (workable needs carrier: agent), so it needs no approve tap (work-board-cards-appear §2, the
  // narrowest part of the approved rule C). Moving the carrier to the agent is a material edit and
  // brings the rule below back before any agent work.
  else if (typeof f.carrier === 'object') f.approvalRequired = false;
  else if (f.policy === 'outward-only') f.approvalRequired = false;
  else f.approvalRequired = !allPerson;
  // A tap counts only when it covers the card as folded now (the hash). The owner's own sender-verified request
  // (agent-work-cards-default §1) counts while the card stays inward and agent-carried with no withdrawal: it
  // approved "do what I asked" (the locked `need`), so the agent's edits to title, items and links keep it.
  const tapValid = approveIdx >= 0 && approveIdx > f.lastMaterialIdx && approveRec !== null;
  f.requestApproved = !f.withdrawn && !!f.requester?.isOwner && f.needLockedToRequest && f.carrier === 'agent' && !f.outward;
  f.approvalValid = !f.withdrawn && (tapValid || f.requestApproved);
  if (f.approvalValid && tapValid && approveRec) f.approvedBy = { by: approveRec.by, at: approveRec.at, id: approveRec.id, source: 'tap' };
  else if (f.approvalValid && f.requestApproved && f.requester) {
    f.approvedBy = { by: { kind: 'person', personKey: f.requester.personKey, proof: 'message' }, at: f.createdAt ?? '', id: `wc:${cardId}:created`, source: 'requester-message', ...(f.source ? { conversationKey: f.source.conversationKey, messageId: f.source.messageId } : {}) };
  }
  f.recordedInAgentWords = !!(f.requestTextHash && f.recordedAsHash && f.requestTextHash !== f.recordedAsHash);
  f.agentWork = f.createdBy?.kind === 'agent' && f.carrier === 'agent' && !f.outward && f.recommendation === null;
  f.pickupHeld = !!f.pickupHold && !f.holdLifted;
  const approvalOk = !f.approvalRequired || f.approvalValid;

  // ── evidence, claims and sign-off: one hash, one generation (§3) ──
  const gen = canonicalJson(f.reopens);
  const currentGen = (r: string[]) => canonicalJson([...r].sort()) === gen;
  for (const e of f.evidence) e.counts = e.materialHash === f.materialHash && currentGen(e.reopens) && (evidenceIdx.get(e.id) ?? -1) > f.lastMaterialIdx;
  const held = f.holds.length > 0;
  const blocked = held || f.unknown.length > 0 || !!f.redacted || !approvalOk;
  for (const c of f.claims) {
    const cIdx = claimIdx.get(c.id) ?? -1;
    if (c.materialHash !== f.materialHash || !currentGen(c.reopens) || cIdx <= f.lastMaterialIdx) continue;
    const listed = new Map(f.evidence.filter((e) => c.evidenceIds.includes(e.id)).map((e) => [e.id, e]));
    const allItems = f.doneWhen.every((it) => [...listed.values()].some((e) => e.itemId === it.id && e.counts && e.text.length > 0 && (evidenceIdx.get(e.id) ?? -1) < cIdx));
    c.counts = allItems && !blocked;
  }
  f.currentClaim = [...f.claims].reverse().find((c) => c.counts) ?? null;
  if (f.currentClaim) {
    // A card a person carries and that sends nothing outward needs no approve tap (above), so the agent's
    // claim on it is finished only by that person's Confirm done, whatever its items say: the agent never
    // opens and closes an ask the person never saw. The one exception is a server-owned card (it covers a
    // `cos:` key), whose single item rests on a recorded source verdict (work-board-cards-appear §2).
    const personCarriedInward = typeof f.carrier === 'object' && !f.outward && !f.covers.some((k) => k.startsWith('cos:'));
    f.needsConfirm = f.doneWhen.some((it) => it.certify === 'owner-confirms') || f.reopens.length > 0 || personCarriedInward;
    const claim = f.currentClaim;
    const cIdx = claimIdx.get(claim.id) ?? -1;
    const confirm = confirms.find((x) => x.tap.claimId === claim.id && x.tap.materialHash === f.materialHash && currentGen(x.reopens) && x.idx > f.lastMaterialIdx && x.idx > cIdx);
    if (confirm) claim.confirmedBy = (confirm.tap.by as { personKey?: string }).personKey;
    f.done = !f.needsConfirm || !!confirm;
    f.doneByAgentOwnEvidence = f.done && !f.needsConfirm;
  }
  f.openQuestion = f.questions.find((q) => q.state === 'open') ?? null;
  if (f.done) f.waitingOn = 'none';
  // A held card (§3 "Pickup hold") is not handed to a card session: the recording conversation owns the work.
  // Its `hold-lifted` record is the transition into workable, and so the pickup's cause.
  f.workable = f.carrier === 'agent' && f.unknown.length === 0 && !f.redacted && !held && f.archives.length === 0 && !f.done && approvalOk && !f.pickupHeld;
  return f;
}

/**
 * Status precedence (§5) — the pickup state and the clock are inputs, never stored.
 * `pickup.quietParked`: the churn brake parked a quiet re-pickup (agent-work-cards-default §3 "Quiet, with one
 * self-heal first"): that park, not the clock, is what makes a card `quiet`. The clock still derives `quiet` for a
 * card no holder has re-picked-up yet, after a grace past `quietAfterHours` so the self-heal comes first.
 */
export function deriveStatus(f: CardFold, pickup: { pendingOrParked: boolean; parked: boolean; quietParked?: boolean }, now: number, quietAfterHours: number): CardStatus {
  if (f.redacted) return 'removed';
  if (f.unknown.length) return 'unknown';
  if (f.archives.length) return 'archived';
  if (f.holds.length) return 'held';
  // An agent-work card without approval is `not-started` (not an ask: no per-card row); a withdrawn approval,
  // an outward card or a person-written card the agent will carry stays `needs-approval` (§1).
  if (f.approvalRequired && !f.approvalValid) return f.agentWork && !f.withdrawn ? 'not-started' : 'needs-approval';
  if (f.currentClaim && f.needsConfirm && !f.done) return 'claims-done';
  if (f.done) return 'done';
  if (pickup.quietParked) return 'quiet';
  if (pickup.parked) return 'parked';
  if (f.openQuestion && typeof f.openQuestion.principal === 'object') return 'waiting-on-person';
  if (typeof f.carrier === 'object') return 'with-person';
  // A held card does not derive `quiet` (§3): the recording conversation is doing the work.
  if (f.pickupHeld) return 'with-agent';
  if (!pickup.pendingOrParked && !f.quietRepickups.some((q) => q.newestAgentRecordId === f.newestAgentRecordId) && now - f.newestAgentRecordAt > quietAfterHours * 3_600_000 + QUIET_CLOCK_GRACE_MS) return 'quiet';
  return 'with-agent';
}

export type Lane = 'waiting-on-you' | 'with-agent' | 'waiting-on-others' | 'done' | 'archived';

/** `not-started` is deliberately NOT here (§1): it is never a per-card Needs-you row; its lane is `with-agent`. */
export const WAITING_STATUSES: ReadonlySet<CardStatus> = new Set<CardStatus>(['unknown', 'held', 'needs-approval', 'claims-done', 'parked', 'waiting-on-person', 'with-person', 'quiet']);

/** Internal origin is not the same as agent-carried work: verified requests and actual person decisions stay public. */
export function isAgentInternalCard(f: CardFold): boolean {
  return f.createdBy?.kind === 'agent' && !f.requester && !f.outward && f.carrier === 'agent'
    && typeof f.waitingOn !== 'object'
    && !(f.openQuestion && typeof f.openQuestion.principal === 'object')
    // A future owner-certified milestone becomes actionable when a claim exists.
    && !(f.currentClaim && f.needsConfirm && !f.done);
}

/** The lane for a viewer. Phase 1: only the team owner acts, so only the owner has "Waiting on you". */
export function laneFor(status: CardStatus, viewerIsOwner: boolean, f: CardFold, viewerPersonKey: string | null, capacityWaitSurfaced = false): Lane {
  if (status === 'removed') return 'archived';
  // A person's "Done" close shows with the done cards; "Not important" and a plain archive stay archived.
  if (status === 'archived') return f.closeout?.as === 'done' ? 'done' : 'archived';
  if (status === 'done') return 'done';
  if (viewerIsOwner) {
    // Execution state belongs to the agent. Only a structured person action can put it on the owner's list.
    if (f.carrier === 'agent') {
      const question = f.openQuestion && typeof f.openQuestion.principal === 'object' ? f.openQuestion.principal.personKey : null;
      const waiting = typeof f.waitingOn === 'object' ? f.waitingOn.personKey : null;
      const approval = f.approvalRequired && !f.approvalValid && !isAgentInternalCard(f);
      const confirmation = status === 'claims-done' && f.needsConfirm && !f.done;
      if (approval || confirmation || question !== null && (viewerPersonKey === null || question === viewerPersonKey) || waiting !== null && (viewerPersonKey === null || waiting === viewerPersonKey)) return 'waiting-on-you';
      return question || waiting ? 'waiting-on-others' : 'with-agent';
    }
    if (WAITING_STATUSES.has(status) || capacityWaitSurfaced) return 'waiting-on-you';
    return 'with-agent';
  }
  // A member or guest: a question addressed to them would be theirs; phase 1 never addresses one.
  const addressed = f.openQuestion && typeof f.openQuestion.principal === 'object' && f.openQuestion.principal.personKey === viewerPersonKey;
  if (addressed) return 'waiting-on-you';
  return WAITING_STATUSES.has(status) ? 'waiting-on-others' : 'with-agent';
}

// ── pickups (§6): derived from transitions into and out of `workable` ───────

/** Closing outcomes after which a pickup is finished (a refusal, a park and a re-arm are not). */
const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set(['injected', 'spawned', 'void', 'stopped', 'not-delivered']);

export type CauseKind = 'work' | 'answer' | 'retry' | 'stop';
/**
 * `repickup`: a `work` cause minted by the holder's `quiet-repickup` record (agent-work-cards-default §3): the one
 * automatic re-pickup of a quiet card, counted inside the churn budget as its own kind, so the first one runs and
 * the second parks into the quiet row. `holdLift`: the cause is a `hold-lifted` record.
 */
export interface PickupCause { id: string; cardId: string; kind: CauseKind; agentCaused: boolean; at: string; hlc: HlcTimestamp; by: By; answerOnly?: boolean; redact?: boolean; repickup?: boolean; holdLift?: boolean }

/**
 * Walk the card's records in fold order and emit one cause per transition: a record after
 * which the card is workable and before which it was not is a `work` cause; the reverse
 * (except finishing) is a `stop` cause; an `answer` tap is an `answer` cause; a `retry` tap on
 * a quiet card is a `retry` cause. Board policy records interleave by HLC. O(n²) in the card's
 * record count, which is small (≈12).
 */
export function derivePickupCauses(cardId: string, records: FoldRecord[], policies: FoldRecord[]): PickupCause[] {
  const card = records.filter((r) => r.d.cardId === cardId);
  const timeline = [...card, ...policies].sort(foldOrder);
  // The card's `created` record first, as foldCard folds it (work-board-cards-appear §1 Create).
  // Only among the card's own records: policy records keep their place in the walk.
  const ci = timeline.findIndex((r) => r.d.recordType === 'created' && r.d.cardId === cardId);
  const first = timeline.findIndex((r) => r.d.cardId === cardId);
  if (ci > first && first >= 0) timeline.splice(first, 0, ...timeline.splice(ci, 1));
  const causes: PickupCause[] = [];
  let prevWorkable = false; let prevDone = false;
  let last: CardFold | null = null;
  const seenCard: FoldRecord[] = []; const seenPol: FoldRecord[] = [];
  for (const rec of timeline) {
    if (rec.d.recordType === 'policy') seenPol.push(rec); else seenCard.push(rec);
    if (!seenCard.length) continue;
    const type = rec.d.recordType;
    if (type === 'dispatching' || type === 'dispatched') continue;
    // Evidence, questions and note pointers can never change whether a card is workable (a finish needs a
    // claim, an answer is a tap), so no fold is needed at them: the walk is quadratic only in taps, edits
    // and claims, not in a long run of evidence or notes (agent-work-cards-default §2 excludes `note`).
    if (type === 'evidence' || type === 'waiting-on' || type === 'note') continue;
    const f = foldCard(cardId, seenCard, seenPol);
    const by = (rec.d.by as By) ?? { kind: 'system' };
    const at = String(rec.d.at ?? '');
    // The holder's one automatic re-pickup (§3 "Quiet"): a work cause on a card that is already workable,
    // keyed by the record id so the churn brake and foldPickups see it.
    if (type === 'quiet-repickup') {
      if (f.workable) causes.push({ id: rec.id, cardId, kind: 'work', agentCaused: true, at, hlc: rec.hlc, by, repickup: true });
      prevWorkable = f.workable; prevDone = f.done; last = f;
      continue;
    }
    if (f.workable && !prevWorkable) {
      causes.push({ id: rec.id, cardId, kind: 'work', agentCaused: by.kind !== 'person', at, hlc: rec.hlc, by, ...(type === 'hold-lifted' ? { holdLift: true } : {}) });
    } else if (!f.workable && prevWorkable && !(f.done && !prevDone)) {
      causes.push({ id: rec.id, cardId, kind: 'stop', agentCaused: by.kind !== 'person', at, hlc: rec.hlc, by, ...(f.redacted ? { redact: true } : {}) });
    }
    if (type === 'tap' && rec.d.action === 'answer') {
      causes.push({ id: rec.id, cardId, kind: 'answer', agentCaused: false, at, hlc: rec.hlc, by, answerOnly: !f.workable });
    }
    // A retry is its own cause only on a QUIET card (it names the card's newest record); a retry
    // on a park or a capacity wait releases that pickup instead (foldPickups counts it there).
    if (type === 'tap' && rec.d.action === 'retry') {
      const prior = seenCard.length >= 2 ? seenCard[seenCard.length - 2] : null;
      // ...and never when it names a cause that is still open (a pickup waiting for capacity): that tap
      // releases the wait on the SAME pickup, or the card would be handed over twice.
      const namesOpenCause = causes.some((c) => c.id === rec.d.retryOf && c.kind !== 'stop' && !seenCard.some((r) => r.d.recordType === 'dispatched' && r.d.for === c.id && TERMINAL_OUTCOMES.has(String(r.d.outcome))));
      if (prior && rec.d.retryOf === prior.id && !namesOpenCause && !(prior.d.recordType === 'dispatched' && prior.d.outcome === 'parked')) causes.push({ id: rec.id, cardId, kind: 'retry', agentCaused: false, at, hlc: rec.hlc, by });
    }
    prevWorkable = f.workable; prevDone = f.done;
    last = f;
  }
  // A hand-over that was DELIVERED on a card that is not workable now must be stopped, even when
  // no transition in fold order shows it: a record from another machine can arrive late and sort
  // BEFORE the approval, so the approval never counted and there is no workable→not-workable step
  // to see (§6 "What a tap on one machine cannot know"). One stop per delivery, unless a stop was
  // already closed, or is already owed, after it.
  if (last && !last.workable && !last.done) {
    // Only a WORK hand-over is stopped: an answer-only brief on a card that is not workable is the
    // supported flow, and a stop after it would tell the session to stop something it never started.
    const answerCauseIds = new Set(causes.filter((c) => c.kind === 'answer').map((c) => c.id));
    const delivered = card.filter((r) => r.d.recordType === 'dispatched' && (r.d.outcome === 'injected' || r.d.outcome === 'spawned') && !answerCauseIds.has(String(r.d.for))).sort(foldOrder);
    const d = delivered.length ? delivered[delivered.length - 1] : null;
    if (d) {
      const stopClosed = card.some((r) => r.d.recordType === 'dispatched' && (r.d.outcome === 'stopped' || r.d.outcome === 'not-delivered') && compareHlc(r.hlc, d.hlc) > 0);
      const stopOwed = causes.some((c) => c.kind === 'stop' && compareHlc(c.hlc, d.hlc) > 0);
      if (!stopClosed && !stopOwed) causes.push({ id: d.id, cardId, kind: 'stop', agentCaused: false, at: String(d.d.at ?? ''), hlc: d.hlc, by: { kind: 'system' }, ...(last.redacted ? { redact: true } : {}) });
    }
  }
  return causes;
}

export interface PickupState {
  cause: PickupCause;
  /** `dispatching` records for this cause (attempts made, closed or not). */
  attempts: number;
  closed: DispatchOutcome | null;
  closedReason: string | null;
  /** True when a `dispatching` exists with no later closing record — possibly delivered. */
  uncertain: boolean;
  parkKind: 'failure' | 'decision' | null;
  parkId: string | null;
  rearmed: boolean;
  /** A person's retry tap released this park (attempts allowed: +1). */
  retriesGranted: number;
  status: 'pending' | 'parked' | 'settled' | 'void';
}

/** The pickup state of every cause on a card, from its dispatch records and retry taps. */
export function foldPickups(cardId: string, records: FoldRecord[], causes: PickupCause[]): PickupState[] {
  const card = records.filter((r) => r.d.cardId === cardId);
  const out: PickupState[] = [];
  for (const cause of causes) {
    const dispatching = card.filter((r) => r.d.recordType === 'dispatching' && r.d.for === cause.id);
    const closings = card.filter((r) => r.d.recordType === 'dispatched' && r.d.for === cause.id).sort(foldOrder);
    const parks = closings.filter((r) => r.d.outcome === 'parked');
    const lastPark = parks.length ? parks[parks.length - 1] : null;
    const retries = card.filter((r) => r.d.recordType === 'tap' && r.d.action === 'retry' && (r.d.retryOf === cause.id || (lastPark && r.d.retryOf === lastPark.id)) && (!lastPark || compareHlc(r.hlc, lastPark.hlc) > 0));
    const rearm = closings.find((r) => r.d.outcome === 'rearmed' && lastPark && compareHlc(r.hlc, lastPark.hlc) > 0);
    const terminal = closings.filter((r) => r.d.outcome !== 'parked' && r.d.outcome !== 'rearmed' && r.d.outcome !== 'refused');
    const lastTerminal = terminal.length ? terminal[terminal.length - 1] : null;
    const attemptsClosed = new Set(closings.filter((r) => r.d.attempt !== undefined).map((r) => r.d.attempt as number));
    const uncertain = dispatching.some((r) => !attemptsClosed.has(r.d.attempt as number));
    const parkReason = lastPark ? String(lastPark.d.reason ?? '') : '';
    const parkKind: PickupState['parkKind'] = lastPark ? (/^decision:/.test(parkReason) ? 'decision' : 'failure') : null;
    // After a park, exactly one attempt is granted per person retry and one for the single ownership
    // re-arm. When those are used up the pickup is parked again WITHOUT a new park record, so a failed
    // re-try can never earn another automatic one.
    const sincePark = lastPark ? dispatching.filter((r) => compareHlc(r.hlc, lastPark.hlc) > 0).length : 0;
    const granted = retries.length + (rearm ? 1 : 0);
    let status: PickupState['status'];
    if (lastTerminal && lastTerminal.d.outcome === 'void') status = 'void';
    else if (lastTerminal) status = 'settled';
    else if (lastPark && granted - sincePark <= 0) status = 'parked';
    else status = 'pending';
    out.push({
      cause, attempts: dispatching.length, closed: lastTerminal ? (lastTerminal.d.outcome as DispatchOutcome) : null,
      closedReason: lastTerminal ? (lastTerminal.d.reason as string | undefined) ?? null : (lastPark ? parkReason : null),
      uncertain, parkKind, parkId: lastPark ? lastPark.id : null, rearmed: !!rearm, retriesGranted: retries.length, status,
    });
  }
  return out;
}

/** Group a union of records by card id, with the board's policy records separate. */
export function partitionRecords(records: FoldRecord[]): { byCard: Map<string, FoldRecord[]>; policies: FoldRecord[] } {
  const byCard = new Map<string, FoldRecord[]>(); const policies: FoldRecord[] = [];
  for (const r of records) {
    if (r.d.recordType === 'policy') { policies.push(r); continue; }
    if (r.d.recordType === 'enabled-at' || r.d.recordType === 'graduation') continue; // board-level, read by the service directly
    const id = r.d.cardId;
    if (!isCardId(id)) continue;
    (byCard.get(id) ?? byCard.set(id, []).get(id)!).push(r);
  }
  return { byCard, policies };
}

/** §3 redaction: a removed card's text is dropped from every read. */
export function redactedView(f: CardFold, name: string): Partial<CardFold> & { removedBy: string } {
  return {
    cardId: f.cardId, conversationKey: f.conversationKey, redacted: f.redacted, removedBy: name,
    title: `removed by ${name}`, need: '', doneWhen: [], links: [], recommendation: null, whyYou: null, covers: [], mirror: null, brief: null, questions: [], openQuestion: null, evidence: [], claims: [], refs: [],
  };
}

export function isValidConversationKey(v: unknown): boolean { return typeof v === 'string' && CONVERSATION_KEY_RE.test(v); }

// ── request-to-card helpers (agent-work-cards-default §3) ───────────────────

/**
 * The card a commitment gets: a pure function of the commitment's replicated identity `(originMachineId, id)`, so the
 * origin's gate, the holder's sweep and any machine that sees the replicated commitment write the SAME `created` record.
 */
export function requestCardId(originMachineId: string, commitmentId: string): string {
  return `wc_${createHash('sha256').update(`commitment:${originMachineId}:${commitmentId}`).digest('hex').slice(0, 16)}`;
}

/** The `refs` id of a commitment: `<originMachineId>:<id>`. */
export function commitmentRefId(originMachineId: string, commitmentId: string): string { return `${originMachineId}:${commitmentId}`; }

/** One normalisation for `requestTextHash` and `recordedAsHash`, so the two labels compare wording, not whitespace or case. */
export function normalizeRequestText(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}
export function requestTextHashOf(text: string): string { return sha256Hex(normalizeRequestText(text)); }

/** Cut at a word boundary with "…", never past `limit` (the gate never writes an over-limit field). */
export function cutAtWord(text: string, limit: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= limit) return t;
  const room = Math.max(1, limit - 1);
  const head = t.slice(0, room);
  const sp = head.lastIndexOf(' ');
  return `${(sp > room * 0.5 ? head.slice(0, sp) : head).trimEnd()}…`;
}
