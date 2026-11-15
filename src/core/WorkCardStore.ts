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
 *
 * This module is PURE: schema, builders and folds. No I/O.
 */

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

export const WORK_RECORD_TYPES = ['created', 'edited', 'waiting-on', 'tap', 'evidence', 'claimed-done', 'dispatching', 'dispatched', 'policy', 'graduation'] as const;
export type WorkRecordType = typeof WORK_RECORD_TYPES[number];

export const MATERIAL_FIELDS = ['title', 'need', 'doneWhen', 'carrier', 'outward', 'links'] as const;
export type MaterialField = typeof MATERIAL_FIELDS[number];
const EDITABLE_FIELDS = [...MATERIAL_FIELDS, 'recommendation', 'due', 'projectKey'] as const;
export type EditableField = typeof EDITABLE_FIELDS[number];

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
export const SCHEMA_MAX = { title: 2000, need: 64000, recommendation: 32000, doneItemText: 8000, optionText: 2000, linkLabel: 300, url: 2000, reason: 2000, evidence: 32000, answer: 8000, question: 8000 } as const;

// ── identity ────────────────────────────────────────────────────────────────

const CARD_ID_RE = /^wc_[0-9a-f]{16}$/;
const PERSON_KEY_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MACHINE_RE = /^[\w-]{1,64}$/;
const ITEM_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RECORD_ID_RE = /^(wc:wc_[0-9a-f]{16}:[A-Za-z0-9_.:-]{1,200}|wb-policy:[A-Za-z0-9_.:-]{1,120}|wb-graduation:day(7|14))$/;
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const CONVERSATION_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT_KEY_RE = /^(telegram|app|slack|imessage|whatsapp):[A-Za-z0-9_.:-]{1,128}$/;

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
export type By = { kind: 'person'; personKey: string; proof: 'pin' | 'presence' } | { kind: 'agent' } | { kind: 'system' };

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
  if (b.kind === 'person' && typeof b.personKey === 'string' && PERSON_KEY_RE.test(b.personKey) && (b.proof === 'pin' || b.proof === 'presence')) return { kind: 'person', personKey: b.personKey, proof: b.proof };
  return null;
}

function vIdList(v: unknown, max = 256): string[] | null {
  if (!Array.isArray(v) || v.length > max) return null;
  for (const x of v) if (!isRecordId(x)) return null;
  return [...new Set(v as string[])].sort();
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
  return out;
}

// ── schema ──────────────────────────────────────────────────────────────────

const KNOWN_FIELDS = [
  'recordType', 'cardId', 'by', 'at',
  'title', 'need', 'doneWhen', 'carrier', 'outward', 'links', 'recommendation', 'due', 'projectKey', 'source', 'conversationKey',
  'principal', 'question', 'supersedes', 'reason',
  'action', 'materialHash', 'questionId', 'answer', 'claimId', 'retryOf', 'names', 'titleHash', 'policy',
  'itemId', 'text', 'attachmentIds', 'reopens', 'evidenceIds',
  'for', 'attempt', 'machineId', 'outcome', 'recovery', 'causeKind',
  'day', 'decision', 'metrics',
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
        return { ...base, ...f, ...(source ? { source } : {}) };
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
        const a = r.action as TapAction;
        if (a === 'approve' && !out.materialHash) return null;
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
export function mintRecordKey(recordType: WorkRecordType, cardId: string | null, extra?: { for?: string; attempt?: number; outcome?: string }): string {
  const rnd = randomBytes(8).toString('hex');
  switch (recordType) {
    case 'policy': return `wb-policy:${rnd}`;
    case 'graduation': return `wb-graduation:day${extra?.attempt ?? 7}`;
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
  const key = recordKey ?? mintRecordKey(recordType, cardId, { for: fields.for as string | undefined, attempt: fields.attempt as number | undefined, outcome: fields.outcome as string | undefined });
  return (hlc, origin, observed) => {
    if (recordType !== 'policy' && recordType !== 'graduation' && !isCardId(cardId)) return null;
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
export function tapActionLine(t: { action: string; cardId: string; materialHash?: string; questionId?: string; answer?: string; claimId?: string; retryOf?: string; names?: string; titleHash?: string }): string {
  const digest = sha256Hex(canonicalJson({
    action: t.action, cardId: t.cardId, materialHash: t.materialHash ?? null, questionId: t.questionId ?? null,
    answer: t.answer ?? null, claimId: t.claimId ?? null, retryOf: t.retryOf ?? null, names: t.names ?? null, titleHash: t.titleHash ?? null,
  }));
  return `Work card ${t.cardId}: ${t.action} [${digest}]`;
}

// ── the fold ────────────────────────────────────────────────────────────────

export interface UnionEntry { data: Record<string, unknown>; origin: string }

/** A record as the fold sees it: validated, with its record id (= record key) and HLC. */
export interface FoldRecord { id: string; hlc: HlcTimestamp; origin: string; d: Record<string, unknown> }

export type CardStatus = 'removed' | 'unknown' | 'archived' | 'held' | 'needs-approval' | 'claims-done' | 'done' | 'parked'
  | 'waiting-on-person' | 'with-person' | 'quiet' | 'with-agent';

export interface QuestionState { id: string; text: string; options?: string[]; principal: Principal; state: 'open' | 'answered' | 'replaced'; replacedBy?: string; reason?: string; answer?: string; answeredBy?: string; at: string }
export interface EvidenceState { id: string; itemId: string; text: string; attachmentIds?: string[]; materialHash: string; reopens: string[]; at: string; by: By; counts: boolean }
export interface ClaimState { id: string; materialHash: string; reopens: string[]; evidenceIds: string[]; at: string; counts: boolean; confirmedBy?: string }
export interface TapState { id: string; action: TapAction; by: By; at: string; hlc: HlcTimestamp; materialHash?: string; questionId?: string; answer?: string; claimId?: string; retryOf?: string; names?: string }

export interface CardFold {
  cardId: string;
  conversationKey: string;
  created: boolean;
  createdBy: By | null;
  createdAt: string | null;
  // fields
  title: string; need: string; doneWhen: DoneWhenItem[]; carrier: Carrier; outward: boolean; links: CardLink[];
  recommendation: string | null; due: string | null; projectKey: string | null; source: { conversationKey: string; messageId: string } | null;
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
  redacted: { by: By; at: string } | null;
  approvalRequired: boolean;
  approvalValid: boolean;
  approvedBy: { by: By; at: string; id: string } | null;
  withdrawn: boolean;
  currentClaim: ClaimState | null;
  needsConfirm: boolean;
  done: boolean;
  doneByAgentOwnEvidence: boolean;
  unknown: string[];
  newestRecordAt: number;
  newestHlc: HlcTimestamp | null;
  /** Ids of records that changed a material field (fold order), for the transcript line. */
  lastMaterialChangeFields: string[];
  /** The index (fold order) of the last record that changed a material field; -1 when none after creation. */
  lastMaterialIdx: number;
  workable: boolean;
  policy: ApprovalPolicy;
}

const EMPTY_LAST_WRITER = (): Record<MaterialField, 'person' | 'agent'> => ({ title: 'agent', need: 'agent', doneWhen: 'agent', carrier: 'agent', outward: 'agent', links: 'agent' });

export function toFoldRecords(entries: UnionEntry[]): FoldRecord[] {
  const byKey = new Map<string, FoldRecord>();
  for (const e of entries) {
    const d = e.data;
    if (typeof d.recordKey !== 'string' || !isHlc(d.hlc)) continue;
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
    waitingOn: 'agent', materialHash: '', lastWriter: EMPTY_LAST_WRITER(), carrierTrail: [], questions: [], openQuestion: null,
    evidence: [], claims: [], taps: [], reopens: [], holds: [], archives: [], redacted: null,
    approvalRequired: true, approvalValid: false, approvedBy: null, withdrawn: false, currentClaim: null, needsConfirm: false, done: false, doneByAgentOwnEvidence: false,
    unknown: [], newestRecordAt: 0, newestHlc: null, lastMaterialChangeFields: [], lastMaterialIdx: -1, workable: false, policy: 'every-agent-card',
  };
  const validate = workCardRecordStoreSchema.validate;
  const ctx: StoreValidateContext = { countDroppedField: () => { /* counted by the envelope layer */ } } as unknown as StoreValidateContext;
  // Approval bookkeeping (fold order index of each relevant record).
  let approveIdx = -1; let approveRec: TapState | null = null; let withdrawIdx = -1;
  const releasedHolds = new Set<string>(); const holdIds: string[] = [];
  const releasedArchives = new Set<string>(); const archiveIds: string[] = [];
  const evidenceIdx = new Map<string, number>(); const claimIdx = new Map<string, number>();
  const confirms: Array<{ tap: TapState; idx: number; reopens: string[] }> = [];
  let idx = -1;
  for (const rec of records) {
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
    // After a redact, only person taps and the pickup controller's closing records count.
    if (f.redacted && !(type === 'tap' || type === 'dispatched')) continue;
    switch (type) {
      case 'created': {
        if (f.created) break;
        f.created = true; f.createdBy = by; f.createdAt = at;
        for (const k of EDITABLE_FIELDS) if (v[k] !== undefined) (f as unknown as Record<string, unknown>)[k] = v[k];
        if (v.source) f.source = v.source as CardFold['source'];
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
          const cur = (f as unknown as Record<string, unknown>)[k];
          if (sameValue(cur, v[k])) continue;
          (f as unknown as Record<string, unknown>)[k] = v[k];
          if ((MATERIAL_FIELDS as ReadonlyArray<string>).includes(k)) {
            changed.push(k);
            f.lastWriter[k as MaterialField] = byIsPerson(by) ? 'person' : 'agent';
          }
        }
        if (v.carrier !== undefined && changed.includes('carrier')) f.carrierTrail.push({ carrier: f.carrier, by, at });
        if (changed.length) { f.lastMaterialIdx = idx; f.lastMaterialChangeFields = changed; }
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
          ...(v.retryOf ? { retryOf: v.retryOf as string } : {}), ...(v.names ? { names: v.names as string } : {}) };
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
          case 'archive': archiveIds.push(t.id); break;
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
      case 'dispatching': case 'dispatched': case 'policy': case 'graduation': break;
    }
  }
  f.reopens.sort();
  f.holds = holdIds.filter((h) => !releasedHolds.has(h));
  f.archives = archiveIds.filter((a) => !releasedArchives.has(a));
  f.materialHash = f.created ? materialHashOf(f) : '';
  // The caller passes the policy records that apply (all of them for a read; the prefix seen so far when deriving causes).
  f.policy = opts?.policyOverride ?? policyAt(policies);
  if (!f.created) f.unknown.push(`wc:${cardId}:created`);

  // ── approval (§4) ──
  f.withdrawn = withdrawIdx > approveIdx && withdrawIdx >= 0;
  const allPerson = MATERIAL_FIELDS.every((k) => f.lastWriter[k] === 'person');
  if (f.withdrawn) f.approvalRequired = true;
  else if (f.outward) f.approvalRequired = true; // an outward card always needs its own approve tap
  else if (f.policy === 'outward-only') f.approvalRequired = false;
  else f.approvalRequired = !allPerson;
  f.approvalValid = !f.withdrawn && approveIdx >= 0 && approveIdx > f.lastMaterialIdx && approveRec !== null;
  if (f.approvalValid && approveRec) f.approvedBy = { by: approveRec.by, at: approveRec.at, id: approveRec.id };
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
    f.needsConfirm = f.doneWhen.some((it) => it.certify === 'owner-confirms') || f.reopens.length > 0;
    const claim = f.currentClaim;
    const cIdx = claimIdx.get(claim.id) ?? -1;
    const confirm = confirms.find((x) => x.tap.claimId === claim.id && x.tap.materialHash === f.materialHash && currentGen(x.reopens) && x.idx > f.lastMaterialIdx && x.idx > cIdx);
    if (confirm) claim.confirmedBy = (confirm.tap.by as { personKey?: string }).personKey;
    f.done = !f.needsConfirm || !!confirm;
    f.doneByAgentOwnEvidence = f.done && !f.needsConfirm;
  }
  f.openQuestion = f.questions.find((q) => q.state === 'open') ?? null;
  if (f.done) f.waitingOn = 'none';
  f.workable = f.carrier === 'agent' && f.unknown.length === 0 && !f.redacted && !held && f.archives.length === 0 && !f.done && approvalOk;
  return f;
}

/** Status precedence (§5) — the pickup state and the clock are inputs, never stored. */
export function deriveStatus(f: CardFold, pickup: { pendingOrParked: boolean; parked: boolean }, now: number, quietAfterHours: number): CardStatus {
  if (f.redacted) return 'removed';
  if (f.unknown.length) return 'unknown';
  if (f.archives.length) return 'archived';
  if (f.holds.length) return 'held';
  if (f.approvalRequired && !f.approvalValid) return 'needs-approval';
  if (f.currentClaim && f.needsConfirm && !f.done) return 'claims-done';
  if (f.done) return 'done';
  if (pickup.parked) return 'parked';
  if (f.openQuestion && typeof f.openQuestion.principal === 'object') return 'waiting-on-person';
  if (typeof f.carrier === 'object') return 'with-person';
  if (!pickup.pendingOrParked && now - f.newestRecordAt > quietAfterHours * 3_600_000) return 'quiet';
  return 'with-agent';
}

export type Lane = 'waiting-on-you' | 'with-agent' | 'waiting-on-others' | 'done' | 'archived';

const WAITING_STATUSES: ReadonlySet<CardStatus> = new Set<CardStatus>(['unknown', 'held', 'needs-approval', 'claims-done', 'parked', 'waiting-on-person', 'with-person', 'quiet']);

/** The lane for a viewer. Phase 1: only the team owner acts, so only the owner has "Waiting on you". */
export function laneFor(status: CardStatus, viewerIsOwner: boolean, f: CardFold, viewerPersonKey: string | null, capacityWaitSurfaced = false): Lane {
  if (status === 'removed' || status === 'archived') return 'archived';
  if (status === 'done') return 'done';
  if (viewerIsOwner) {
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
export interface PickupCause { id: string; cardId: string; kind: CauseKind; agentCaused: boolean; at: string; hlc: HlcTimestamp; by: By; answerOnly?: boolean; redact?: boolean }

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
  const causes: PickupCause[] = [];
  let prevWorkable = false; let prevDone = false;
  let last: CardFold | null = null;
  const seenCard: FoldRecord[] = []; const seenPol: FoldRecord[] = [];
  for (const rec of timeline) {
    if (rec.d.recordType === 'policy') seenPol.push(rec); else seenCard.push(rec);
    if (!seenCard.length) continue;
    const type = rec.d.recordType;
    if (type === 'dispatching' || type === 'dispatched') continue;
    // Evidence and questions can never change whether a card is workable (a finish needs a claim, an
    // answer is a tap), so no fold is needed at them: the walk is quadratic only in taps, edits and
    // claims, not in a long run of evidence.
    if (type === 'evidence' || type === 'waiting-on') continue;
    const f = foldCard(cardId, seenCard, seenPol);
    const by = (rec.d.by as By) ?? { kind: 'system' };
    const at = String(rec.d.at ?? '');
    if (f.workable && !prevWorkable) {
      causes.push({ id: rec.id, cardId, kind: 'work', agentCaused: by.kind !== 'person', at, hlc: rec.hlc, by });
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
    title: `removed by ${name}`, need: '', doneWhen: [], links: [], recommendation: null, questions: [], openQuestion: null, evidence: [], claims: [],
  };
}

export function isValidConversationKey(v: unknown): boolean { return typeof v === 'string' && CONVERSATION_KEY_RE.test(v); }
