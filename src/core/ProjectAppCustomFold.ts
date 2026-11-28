/**
 * ProjectAppCustomFold — the part-2 record types on `project-app-record` and the folds that decide
 * which custom-app version runs and which app keys are destroyed
 * (docs/specs/project-apps-sandbox.md §3.2 "Erasing", §3.3 and §3.4).
 *
 * PURE: validators, builders, deterministic card ids and folds. No I/O.
 *
 * Record types (discriminator `recordType`):
 *   project-app-version-card     vcard:<appId>:<purpose>:<contentSha|target|->:<gen>   immutable; the lease
 *                                holder's binding of a server-owned Work Board card generation to the exact
 *                                material it showed (materialHash)
 *   project-app-version-answer   vanswer:<appId>:<contentSha>:<hlc>                      reject | disable | enable
 *   project-app-summary          appsum:<appId>                                         last-writer by HLC; sealed
 *   project-app-key-revoked      keyrev:<appId>:<keyKind>:<gen>                         no key material
 *   project-app-revoke-confirm   keyrevok:<appId>:<keyKind>:<gen>:<machineId>           a machine's durable ack
 *   project-app-custom           appdef:<appId>                                         immutable; the app itself
 *                                (its project conversation, title and spec path), written by POST /project-apps
 *
 * The served version is DERIVED, never written. "Yes" lives on the Work Board: an approve tap
 * (recordType 'tap', action 'approve', by {kind:'person', personKey, proof}) whose materialHash
 * equals a version-card record's. Only proof 'presence' by an owner counts; a PIN tap or a
 * member's phone never serves. A withdraw-approval tap on any of an app's version cards stops it.
 */

import { createHash } from 'node:crypto';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import { compareHlc } from './TopicPinReplicatedStore.js';
import { workCardRecordStoreSchema, type By } from './WorkCardStore.js';
import type { StoreValidateContext } from './ReplicatedRecordEnvelope.js';

export const CUSTOM_RECORD_TYPES = [
  'project-app-version-card', 'project-app-version-answer', 'project-app-summary', 'project-app-key-revoked', 'project-app-revoke-confirm',
  'project-app-custom',
] as const;
export type CustomRecordType = typeof CUSTOM_RECORD_TYPES[number];

export const CARD_PURPOSES = ['serve', 'allow-again', 'enable', 'budget', 'erase-data', 'delete-app'] as const;
export type CardPurpose = typeof CARD_PURPOSES[number];
export const VERSION_ANSWERS = ['reject', 'disable', 'enable'] as const;
export type VersionAnswer = typeof VERSION_ANSWERS[number];
export const KEY_KINDS = ['data', 'source', 'hmac'] as const;
export type KeyKind = typeof KEY_KINDS[number];
export const VERSION_ANSWER_VIA = ['console', 'desktop', 'phone', 'bearer', 'system'] as const;

/** Fields this module adds to the `project-app-record` schema's knownFields. */
export const CUSTOM_KNOWN_FIELDS = [
  'appId', 'contentSha', 'gen', 'purpose', 'target', 'cardId', 'materialHash', 'keyGen', 'sealed', 'asOf', 'keyKind', 'machineId',
  'title', 'specPath',
] as const;

/** The app's title on its row, its bar and its version card (§3.1). */
export const APP_TITLE_MAX = 60;
const CONVERSATION_KEY_RE = /^(telegram|app|slack|imessage|whatsapp):[A-Za-z0-9_.:-]{1,128}$/;
const SPEC_PATH_RE = /^(docs\/specs|\.instar\/specs)\/[A-Za-z0-9_./-]{1,200}\.md$/;

const APP_ID_RE = /^pa_[0-9a-f]{16}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const CARD_ID_RE = /^wc_[0-9a-f]{16}$/;
const MACHINE_RE = /^[\w-]{1,64}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** The summary's sealed headline + counts stays well inside the kind's 64 KiB line. */
const SUMMARY_CT_B64_MAX = 48 * 1024;

const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_RE.test(v);
const isGen = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 1_000_000;
const isSha = (v: unknown): v is string => typeof v === 'string' && SHA_RE.test(v);
const isAppId = (v: unknown): v is string => typeof v === 'string' && APP_ID_RE.test(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const inList = <T extends string>(l: ReadonlyArray<T>, v: unknown): v is T => (l as ReadonlyArray<unknown>).includes(v);

/** The deterministic Work Board card id for an app's card of one purpose. */
export function versionCardId(appId: string, purpose: CardPurpose): string {
  return 'wc_' + createHash('sha256').update(`${appId}:${purpose}`).digest('hex').slice(0, 16);
}

/**
 * The muted "For support" line the server writes on every version card. It names the generation,
 * so two generations of a card never render the same material (an old approve can never match a
 * newer request even when the rest of the wording is identical).
 */
export function versionCardSupportLine(appId: string, contentSha: string | undefined, gen: number): string {
  return `For support: app ${appId}${contentSha ? `, version ${contentSha}` : ''}, request ${gen}`;
}

/**
 * The generation marker is part of the stored approval material. Omit only the
 * exact server-generated suffix for this card from the words shown to a person.
 */
export function versionCardDisplayNeed(cardId: string, need: string): string {
  const support = /\n\nFor support: app (pa_[0-9a-f]{16}), version [0-9a-f]{64}, request [1-9][0-9]*$/.exec(need);
  if (!support || support.index + support[0].length !== need.length || versionCardId(support[1], 'serve') !== cardId) return need;
  return need.slice(0, support.index);
}

/** The key segment after the purpose: the content hash, the target, or '-'. */
const cardSubject = (contentSha: string | undefined, target: number | undefined) => contentSha ?? (target !== undefined ? String(target) : '-');

export const versionCardKey = (c: { appId: string; purpose: CardPurpose; contentSha?: string; target?: number; gen: number }) =>
  `vcard:${c.appId}:${c.purpose}:${cardSubject(c.contentSha, c.target)}:${c.gen}`;

export const summaryKey = (appId: string) => `appsum:${appId}`;
export const keyRevokedKey = (appId: string, keyKind: KeyKind, gen: number) => `keyrev:${appId}:${keyKind}:${gen}`;
export const revokeConfirmKey = (appId: string, keyKind: KeyKind, gen: number, machineId: string) => `keyrevok:${appId}:${keyKind}:${gen}:${machineId}`;
export const appDefKey = (appId: string) => `appdef:${appId}`;
const hlcKey = (h: HlcTimestamp) => `${h.physical}.${h.logical}.${h.node}`;

// ── validation ──────────────────────────────────────────────────────────────

/**
 * Validate a part-2 record. Null = not a well-formed record of this build's shape; the
 * `project-app-record` schema then keeps it as an inert stub (forward compatibility), so no fold
 * here ever reads it.
 */
export function validateCustomRecord(raw: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  const type = raw.recordType;
  if (!inList(CUSTOM_RECORD_TYPES, type) || !isAppId(raw.appId) || !isIso(raw.at)) return null;
  const base = { recordType: type, appId: raw.appId, at: raw.at };
  const rk = raw.recordKey;
  switch (type) {
    case 'project-app-version-card': {
      if (!inList(CARD_PURPOSES, raw.purpose) || !isGen(raw.gen) || !isSha(raw.materialHash)) return null;
      if (raw.cardId !== versionCardId(raw.appId, raw.purpose)) return null;
      const p = raw.purpose;
      const needsSha = p === 'serve' || p === 'allow-again';
      const needsTarget = p === 'budget' || p === 'erase-data';
      if (raw.contentSha !== undefined && !isSha(raw.contentSha)) return null;
      if (needsSha && raw.contentSha === undefined) return null;
      if (!needsSha && p !== 'enable' && raw.contentSha !== undefined) return null;
      // An erase-data target is a key-generation watermark: the same isGen check its consumer
      // (ProjectAppKeyStore.eraseData) applies, so a record the consumer would refuse never folds.
      // A budget target is a byte count (above a million), a positive safe integer.
      const targetOk = p === 'erase-data' ? isGen(raw.target) : typeof raw.target === 'number' && Number.isSafeInteger(raw.target) && raw.target >= 1;
      if (needsTarget ? !targetOk : raw.target !== undefined) return null;
      const out = {
        ...base, purpose: p, gen: raw.gen, cardId: raw.cardId, materialHash: raw.materialHash,
        ...(raw.contentSha !== undefined ? { contentSha: raw.contentSha } : {}), ...(raw.target !== undefined ? { target: raw.target } : {}),
      };
      if (rk !== undefined && rk !== versionCardKey(out as unknown as Parameters<typeof versionCardKey>[0])) return null;
      return out;
    }
    case 'project-app-version-answer': {
      if (!isSha(raw.contentSha) || !inList(VERSION_ANSWERS, raw.answer) || !isText(raw.by, 120) || !inList(VERSION_ANSWER_VIA, raw.via)) return null;
      if (rk !== undefined && (typeof rk !== 'string' || !rk.startsWith(`vanswer:${raw.appId}:${raw.contentSha}:`))) return null;
      return { ...base, contentSha: raw.contentSha, answer: raw.answer, by: raw.by, via: raw.via };
    }
    case 'project-app-summary': {
      if (!isGen(raw.keyGen) || !isIso(raw.asOf) || !inList(['app', 'agent'] as const, raw.by)) return null;
      if (raw.asOf > raw.at) return null; // asOf later than at is refused
      const s = raw.sealed as Record<string, unknown> | undefined;
      if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
      if (typeof s.nonce !== 'string' || s.nonce.length !== 16 || !B64_RE.test(s.nonce)) return null;
      if (typeof s.ct !== 'string' || s.ct.length === 0 || s.ct.length > SUMMARY_CT_B64_MAX || s.ct.length % 4 !== 0 || !B64_RE.test(s.ct)) return null;
      if (rk !== undefined && rk !== summaryKey(raw.appId)) return null;
      return { ...base, keyGen: raw.keyGen, sealed: { nonce: s.nonce, ct: s.ct }, asOf: raw.asOf, by: raw.by };
    }
    case 'project-app-key-revoked': {
      if (!inList(KEY_KINDS, raw.keyKind) || !isGen(raw.gen)) return null;
      if (rk !== undefined && rk !== keyRevokedKey(raw.appId, raw.keyKind, raw.gen)) return null;
      return { ...base, keyKind: raw.keyKind, gen: raw.gen };
    }
    case 'project-app-custom': {
      const ck = raw.conversationKey; const t = raw.title; const sp = raw.specPath;
      if (typeof ck !== 'string' || !CONVERSATION_KEY_RE.test(ck)) return null;
      if (typeof t !== 'string' || t.trim().length === 0 || t.length > APP_TITLE_MAX || /[\u0000-\u001f]/.test(t)) return null;
      if (typeof sp !== 'string' || !SPEC_PATH_RE.test(sp) || sp.split('/').includes('..')) return null;
      if (rk !== undefined && rk !== appDefKey(raw.appId)) return null;
      return { ...base, conversationKey: ck, title: t, specPath: sp };
    }
    case 'project-app-revoke-confirm': {
      if (!inList(KEY_KINDS, raw.keyKind) || !isGen(raw.gen) || typeof raw.machineId !== 'string' || !MACHINE_RE.test(raw.machineId)) return null;
      if (rk !== undefined && rk !== revokeConfirmKey(raw.appId, raw.keyKind, raw.gen, raw.machineId)) return null;
      return { ...base, keyKind: raw.keyKind, gen: raw.gen, machineId: raw.machineId };
    }
  }
  return null;
}

// ── builders ────────────────────────────────────────────────────────────────

type Build = (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> | null;

function make(key: (hlc: HlcTimestamp) => string, fields: Record<string, unknown>): Build {
  return (hlc, origin, observed) => {
    const rec = { ...fields, recordKey: key(hlc), hlc, op: 'put', origin, ...(observed !== undefined ? { observed } : {}) };
    return validateCustomRecord(rec) ? rec : null;
  };
}

export interface VersionCardInput { appId: string; purpose: CardPurpose; gen: number; materialHash: string; contentSha?: string; target?: number; at: string }

export function buildVersionCard(c: VersionCardInput): Build {
  return make(() => versionCardKey(c), { recordType: 'project-app-version-card', ...c, cardId: versionCardId(c.appId, c.purpose) });
}

export function buildVersionAnswer(a: { appId: string; contentSha: string; answer: VersionAnswer; by: string; via: typeof VERSION_ANSWER_VIA[number]; at: string }): Build {
  return make((h) => `vanswer:${a.appId}:${a.contentSha}:${hlcKey(h)}`, { recordType: 'project-app-version-answer', ...a });
}

export function buildSummary(s: { appId: string; keyGen: number; sealed: { nonce: string; ct: string }; asOf: string; by: 'app' | 'agent'; at: string }): Build {
  return make(() => summaryKey(s.appId), { recordType: 'project-app-summary', ...s });
}

export function buildKeyRevoked(r: { appId: string; keyKind: KeyKind; gen: number; at: string }): Build {
  return make(() => keyRevokedKey(r.appId, r.keyKind, r.gen), { recordType: 'project-app-key-revoked', ...r });
}

export function buildRevokeConfirm(r: { appId: string; keyKind: KeyKind; gen: number; machineId: string; at: string }): Build {
  return make(() => revokeConfirmKey(r.appId, r.keyKind, r.gen, r.machineId), { recordType: 'project-app-revoke-confirm', ...r });
}

export function buildAppDef(a: { appId: string; conversationKey: string; title: string; specPath: string; at: string }): Build {
  return make(() => appDefKey(a.appId), { recordType: 'project-app-custom', ...a });
}

// ── fold inputs ─────────────────────────────────────────────────────────────

export interface UnionEntry { data: Record<string, unknown>; origin: string }

interface Rec { d: Record<string, unknown>; hlc: HlcTimestamp; origin: string }

function hlcOf(d: Record<string, unknown>): HlcTimestamp | null {
  const h = d.hlc as HlcTimestamp | undefined;
  return h && Number.isFinite(h.physical) && Number.isInteger(h.logical) && typeof h.node === 'string' ? h : null;
}

const order = (a: Rec, b: Rec) => compareHlc(a.hlc, b.hlc) || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0);

function customRecords(union: UnionEntry[], appId?: string): Rec[] {
  const out: Rec[] = [];
  for (const e of union) {
    const h = hlcOf(e.data); if (!h) continue;
    const v = validateCustomRecord(e.data); if (!v) continue;
    if (appId && v.appId !== appId) continue;
    out.push({ d: v, hlc: h, origin: e.origin });
  }
  return out.sort(order);
}

const WB_CTX = { countDroppedField: () => { /* counted by the envelope layer */ }, countJailReject: () => { /* idem */ } } as unknown as StoreValidateContext;

interface Tap { cardId: string; action: string; by: By; materialHash?: string; hlc: HlcTimestamp; origin: string; id: string }

/** Work Board tap records (validated with the Work Board's own schema), oldest first. */
function workBoardTaps(workBoard: UnionEntry[]): Tap[] {
  const out: Tap[] = [];
  for (const e of workBoard) {
    if (e.data.recordType !== 'tap') continue;
    const h = hlcOf(e.data); if (!h) continue;
    const v = workCardRecordStoreSchema.validate(e.data, WB_CTX); if (!v) continue;
    out.push({ cardId: v.cardId as string, action: v.action as string, by: v.by as By, ...(v.materialHash ? { materialHash: v.materialHash as string } : {}), hlc: h, origin: e.origin, id: String(e.data.recordKey ?? '') });
  }
  return out.sort((a, b) => compareHlc(a.hlc, b.hlc) || (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0));
}

export type IsOwner = (personKey: string) => boolean;

/** An approve that counts for a version card: an owner, proven by phone presence. */
function isOwnerPresence(t: Tap, isOwner: IsOwner): boolean {
  return t.by.kind === 'person' && t.by.proof === 'presence' && isOwner(t.by.personKey);
}

export interface CardBinding { purpose: CardPurpose; gen: number; contentSha?: string; target?: number; materialHash: string; cardId: string; hlc: HlcTimestamp }

/** An owner-presence approve matched to the version-card generation whose material it signed. */
export interface CardApproval { binding: CardBinding; hlc: HlcTimestamp; personKey: string; tapId: string }

/**
 * Match every owner-presence approve on the app's version cards to the card generation it signed:
 * same card id, same material hash, and the approve is later than that generation's record. When
 * several generations share a material hash the newest one written before the approve is used.
 */
export function matchApprovals(appId: string, records: UnionEntry[], workBoard: UnionEntry[], isOwner: IsOwner): CardApproval[] {
  const bindings: CardBinding[] = customRecords(records, appId)
    .filter((r) => r.d.recordType === 'project-app-version-card')
    .map((r) => ({
      purpose: r.d.purpose as CardPurpose, gen: r.d.gen as number, materialHash: r.d.materialHash as string, cardId: r.d.cardId as string, hlc: r.hlc,
      ...(r.d.contentSha !== undefined ? { contentSha: r.d.contentSha as string } : {}), ...(r.d.target !== undefined ? { target: r.d.target as number } : {}),
    }));
  const ids = new Set(CARD_PURPOSES.map((p) => versionCardId(appId, p)));
  const out: CardApproval[] = [];
  for (const t of workBoardTaps(workBoard)) {
    if (t.action !== 'approve' || !ids.has(t.cardId) || !t.materialHash || !isOwnerPresence(t, isOwner)) continue;
    let best: CardBinding | null = null;
    for (const b of bindings) {
      if (b.cardId !== t.cardId || b.materialHash !== t.materialHash || compareHlc(b.hlc, t.hlc) >= 0) continue;
      if (!best || compareHlc(b.hlc, best.hlc) > 0) best = b;
    }
    if (best) out.push({ binding: best, hlc: t.hlc, personKey: (t.by as { personKey: string }).personKey, tapId: t.id });
  }
  return out;
}

// ── the served-version fold ─────────────────────────────────────────────────

/** A source revision as the served fold needs it (from ProjectAppBlobStore's fold + completeness). */
export interface SourceCandidate { id: string; contentSha: string; hlc: HlcTimestamp; complete: boolean; fenced?: boolean }

export interface ContentDecision { approved: boolean; rejected: boolean }

export interface ServedView {
  /** The revision every machine serves, or null (nothing approved, disabled, deleted, or not copied yet). */
  served: SourceCandidate | null;
  /** A newer approved revision is still copying to this machine (the frame bar says so). */
  newerApprovedCopying: boolean;
  disabled: boolean;
  deleted: boolean;
  /** Per content hash: approved by an owner's phone, and whether a reject currently blocks it. */
  contents: Map<string, ContentDecision>;
}

/**
 * Which source version runs (spec §3.3–3.4). Pure; every machine computes the same answer from
 * the replicated records and the Work Board's replicated taps.
 *  - Approved: an owner-presence approve on a `serve` or `allow-again` generation for that content
 *    hash (any generation), matching the generation's material hash.
 *  - Rejected: decisions on a content hash fold by HLC. A reject blocks it; only a LATER approve on
 *    an `allow-again` generation written after that reject unblocks it; a later reject blocks again.
 *  - Disabled: the newest of {a `disable` answer, a withdraw-approval tap (any person, any proof)
 *    on any of the app's version cards} vs {an owner-presence approve on an `enable` card}. An
 *    `enable` ANSWER alone never enables (it is the record of the decision, not the authority).
 *  - Deleted: an owner-presence approve on the `delete-app` card.
 *  - Served: the newest approved, not-rejected, complete, non-fenced candidate.
 */
export function foldServedVersion(input: {
  appId: string;
  records: UnionEntry[];
  workBoard: UnionEntry[];
  isOwner: IsOwner;
  candidates: SourceCandidate[];
}): ServedView {
  const { appId } = input;
  const recs = customRecords(input.records, appId);
  const approvals = matchApprovals(appId, input.records, input.workBoard, input.isOwner);

  // Decisions per content hash, in HLC order.
  type Ev = { hlc: HlcTimestamp; kind: 'approve' | 'allow-again' | 'reject'; cardHlc?: HlcTimestamp };
  const evs = new Map<string, Ev[]>();
  const push = (sha: string, e: Ev) => { const l = evs.get(sha); if (l) l.push(e); else evs.set(sha, [e]); };
  for (const a of approvals) {
    const sha = a.binding.contentSha;
    if (!sha) continue;
    if (a.binding.purpose === 'serve') push(sha, { hlc: a.hlc, kind: 'approve' });
    else if (a.binding.purpose === 'allow-again') push(sha, { hlc: a.hlc, kind: 'allow-again', cardHlc: a.binding.hlc });
  }
  for (const r of recs) if (r.d.recordType === 'project-app-version-answer' && r.d.answer === 'reject') push(r.d.contentSha as string, { hlc: r.hlc, kind: 'reject' });

  const contents = new Map<string, ContentDecision>();
  for (const [sha, list] of evs) {
    list.sort((a, b) => compareHlc(a.hlc, b.hlc));
    let approved = false; let rejected = false; let lastReject: HlcTimestamp | null = null;
    for (const e of list) {
      if (e.kind === 'reject') { rejected = true; lastReject = e.hlc; }
      else if (e.kind === 'approve') { approved = true; }
      else {
        // allow-again: it lifts a reject only when its card generation was written after that reject.
        approved = true;
        if (rejected && lastReject && e.cardHlc && compareHlc(e.cardHlc, lastReject) > 0) rejected = false;
      }
    }
    contents.set(sha, { approved, rejected });
  }

  // Disable / enable, by HLC.
  type Sw = { hlc: HlcTimestamp; on: boolean };
  const sw: Sw[] = [];
  for (const r of recs) if (r.d.recordType === 'project-app-version-answer' && r.d.answer === 'disable') sw.push({ hlc: r.hlc, on: false });
  const ids = new Set(CARD_PURPOSES.map((p) => versionCardId(appId, p)));
  for (const t of workBoardTaps(input.workBoard)) if (t.action === 'withdraw-approval' && ids.has(t.cardId)) sw.push({ hlc: t.hlc, on: false });
  for (const a of approvals) if (a.binding.purpose === 'enable') sw.push({ hlc: a.hlc, on: true });
  sw.sort((a, b) => compareHlc(a.hlc, b.hlc));
  const disabled = sw.length > 0 && !sw[sw.length - 1].on;
  const deleted = approvals.some((a) => a.binding.purpose === 'delete-app');

  const eligible = (c: SourceCandidate) => { const d = contents.get(c.contentSha); return !c.fenced && !!d && d.approved && !d.rejected; };
  const sorted = [...input.candidates].sort((a, b) => compareHlc(a.hlc, b.hlc));
  let served: SourceCandidate | null = null; let newerApprovedCopying = false;
  if (!disabled && !deleted) {
    for (let i = sorted.length - 1; i >= 0; i--) {
      const c = sorted[i];
      if (!eligible(c)) continue;
      if (c.complete) { served = c; break; }
      newerApprovedCopying = true;
    }
  }
  return { served, newerApprovedCopying, disabled, deleted, contents };
}

// ── revoked key generations ─────────────────────────────────────────────────

export interface RevokedView {
  /** Explicit (appId, kind, gen) revocations from revoke records. */
  revoked: Array<{ appId: string; keyKind: KeyKind; gen: number }>;
  /** Per app: every data generation ≤ this is revoked (from erase-data approves and data revoke records). */
  eraseWatermarks: Record<string, number>;
  /** Apps whose delete-app card an owner approved on the phone: every generation of every kind. */
  deletedApps: Set<string>;
  isRevoked(appId: string, keyKind: KeyKind, gen: number): boolean;
}

/**
 * Which key generations are destroyed. A `project-app-key-revoked` record OR the owner's
 * phone-presence approve on an `erase-data` / `delete-app` card (the approve itself revokes, so a
 * revocation is never lost with a holder that died after the approve).
 */
export function foldRevokedKeys(input: { records: UnionEntry[]; workBoard: UnionEntry[]; isOwner: IsOwner }): RevokedView {
  const revoked: RevokedView['revoked'] = [];
  const seen = new Set<string>();
  const appIds = new Set<string>();
  for (const r of customRecords(input.records)) {
    appIds.add(r.d.appId as string);
    if (r.d.recordType !== 'project-app-key-revoked') continue;
    const k = `${r.d.appId}:${r.d.keyKind}:${r.d.gen}`;
    if (seen.has(k)) continue; seen.add(k);
    revoked.push({ appId: r.d.appId as string, keyKind: r.d.keyKind as KeyKind, gen: r.d.gen as number });
  }
  const eraseWatermarks: Record<string, number> = {};
  const deletedApps = new Set<string>();
  for (const appId of appIds) {
    for (const a of matchApprovals(appId, input.records, input.workBoard, input.isOwner)) {
      if (a.binding.purpose === 'erase-data' && isGen(a.binding.target)) eraseWatermarks[appId] = Math.max(eraseWatermarks[appId] ?? 0, a.binding.target);
      else if (a.binding.purpose === 'delete-app') deletedApps.add(appId);
    }
  }
  const isRevoked = (appId: string, keyKind: KeyKind, gen: number) =>
    deletedApps.has(appId) || seen.has(`${appId}:${keyKind}:${gen}`) || (keyKind === 'data' && gen <= (eraseWatermarks[appId] ?? 0));
  return { revoked, eraseWatermarks, deletedApps, isRevoked };
}

/**
 * Erase progress for a set of revoked generations: done only when every live machine has a confirm
 * record for every generation (spec §3.2: "An erase is not done until every live machine has it").
 */
export function eraseProgress(records: UnionEntry[], appId: string, gens: Array<{ keyKind: KeyKind; gen: number }>, liveMachines: string[]): { done: boolean; waitingOn: string[] } {
  const confirmed = new Set<string>();
  for (const r of customRecords(records, appId)) {
    if (r.d.recordType === 'project-app-revoke-confirm') confirmed.add(`${r.d.keyKind}:${r.d.gen}:${r.d.machineId}`);
  }
  const waitingOn = liveMachines.filter((m) => gens.some((g) => !confirmed.has(`${g.keyKind}:${g.gen}:${m}`)));
  return { done: waitingOn.length === 0, waitingOn };
}

// ── the apps themselves ─────────────────────────────────────────────────────

export interface AppDef { appId: string; conversationKey: string; title: string; specPath: string; at: string }

/** Every custom app (first writer by HLC per app id; the record is immutable). */
export function foldAppDefs(records: UnionEntry[]): Map<string, AppDef> {
  const out = new Map<string, AppDef>();
  for (const r of customRecords(records)) {
    if (r.d.recordType !== 'project-app-custom' || out.has(r.d.appId as string)) continue;
    out.set(r.d.appId as string, { appId: r.d.appId as string, conversationKey: r.d.conversationKey as string, title: r.d.title as string, specPath: r.d.specPath as string, at: r.d.at as string });
  }
  return out;
}

// ── summary ─────────────────────────────────────────────────────────────────

export interface SummaryView { keyGen: number; sealed: { nonce: string; ct: string }; asOf: string; by: 'app' | 'agent'; at: string; erased: boolean }

/** The app's newest summary (last-writer by HLC); `erased` when its data key generation is revoked. */
export function foldSummary(records: UnionEntry[], appId: string, revoked?: Pick<RevokedView, 'isRevoked'>): SummaryView | null {
  let last: Rec | null = null;
  for (const r of customRecords(records, appId)) if (r.d.recordType === 'project-app-summary') last = r;
  if (!last) return null;
  const d = last.d;
  return {
    keyGen: d.keyGen as number, sealed: d.sealed as SummaryView['sealed'], asOf: d.asOf as string, by: d.by as 'app' | 'agent', at: d.at as string,
    erased: !!revoked?.isRevoked(appId, 'data', d.keyGen as number),
  };
}
