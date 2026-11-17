/**
 * ProjectAppStore — the `project-app-record` replicated kind (store key `projectApps`)
 * for project apps (docs/specs/project-apps.md).
 *
 * A project (a Chief of Staff bound conversation) can have apps: pages one tap from its Work row
 * and its conversation. This module is PURE: the builtin app list, the record schema, builders and
 * the folds. It performs no I/O.
 *
 * Record types (discriminator `recordType`), all immutable and event-keyed except the offer:
 *   project-app-offer   key appoffer:<conversationKey>:<appRef>          the agent's one suggestion
 *   project-app-answer  key appanswer:<conversationKey>:<appRef>:<hlc>   attach | decline | detach (owner)
 *                                                                        withdraw (the agent, offers only)
 *   project-app-pin     key apppin:<conversationKey>:<appRef>:<hlc>      the lease holder's link-pin steps
 *
 * Part 2 (docs/specs/project-apps-sandbox.md §3.3) adds the custom-app types — version cards,
 * version answers, summaries, key revocations and their per-machine confirms. Their validation and
 * folds live in ProjectAppCustomFold.ts; a malformed one is kept as an inert stub, like any type a
 * later build may add, so a peer's stream never stalls on it.
 *
 * Why a NEW kind (spec §3.2): JournalSyncApplier stops a peer batch at the first record a
 * store refuses, so new record types on `chief-of-staff-record` would hold back bindings and
 * check-ins on a machine still on an older build. An unknown KIND is skipped instead.
 *
 * Records never carry URLs: a builtin app's title, page and summary come from BUILTIN_APPS.
 */

import type { StoreFieldSchema } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import { compareHlc } from './TopicPinReplicatedStore.js';
import { isValidConversationKey, hlcKey, chiefOfStaffStoreEnabled } from './ChiefOfStaffStore.js';
import { resolveDevAgentGate } from './devAgentGate.js';
import { CUSTOM_RECORD_TYPES, CUSTOM_KNOWN_FIELDS, validateCustomRecord } from './ProjectAppCustomFold.js';
import { fitsRecordLine } from './ProjectAppBlobStore.js';

export const PROJECT_APP_RECORD_KIND = 'project-app-record';
/** The stateSync config sub-key (`multiMachine.stateSync.projectApps`). */
export const PROJECT_APP_STORE_KEY = 'projectApps';

/** The feature switch (spec §10): dev-gated, and only where the Chief of Staff (projects) is on. */
export function projectAppsEnabled(config: { developmentAgent?: boolean; projectApps?: { enabled?: boolean }; chiefOfStaff?: { enabled?: boolean } } | undefined): boolean {
  return resolveDevAgentGate(config?.projectApps?.enabled, config) && chiefOfStaffStoreEnabled(config);
}

// ── the builtin apps (closed list; spec §3.1) ───────────────────────────────

export interface BuiltinApp {
  id: string;
  /** Shown on buttons, the strip and the pinned link. From code, never from the agent. */
  title: string;
  /** The console route (hash) that opens it. */
  consoleRoute: string;
  /** The native phone screen that opens it. */
  nativeScreen: string;
}

export const BUILTIN_APPS: ReadonlyArray<BuiltinApp> = Object.freeze([
  Object.freeze({ id: 'maturation-board', title: 'Feature maturation board', consoleRoute: '#/work/maturation', nativeScreen: 'maturation' }),
]);

export const APP_REF_RE = /^builtin:[a-z0-9-]{1,40}$/;
export const CUSTOM_APP_REF_RE = /^custom:pa_[0-9a-f]{16}$/;

export function builtinApp(appRef: string): BuiltinApp | null {
  const m = /^builtin:([a-z0-9-]{1,40})$/.exec(appRef);
  if (!m) return null;
  return BUILTIN_APPS.find((a) => a.id === m[1]) ?? null;
}

/** Spec §6: an offer record stays within an 8 KiB serialized budget (the journal's entry bound is 80 KiB). */
export const OFFER_RECORD_MAX_BYTES = 8 * 1024;
export const OFFER_WHY_MAX = 6 * 1024;

export const PROJECT_APP_RECORD_TYPES = ['project-app-offer', 'project-app-answer', 'project-app-pin'] as const;
export type ProjectAppRecordType = typeof PROJECT_APP_RECORD_TYPES[number];

export const OWNER_ANSWERS = ['attach', 'decline', 'detach'] as const;
export const AGENT_ANSWERS = ['withdraw'] as const;
export type AppAnswer = typeof OWNER_ANSWERS[number] | typeof AGENT_ANSWERS[number];
export const ANSWER_VIA = ['console', 'desktop', 'phone', 'bearer'] as const;
export type AnswerVia = typeof ANSWER_VIA[number];

export const PIN_STATES = ['act', 'pending', 'posted', 'pinned', 'edited', 'unpinned', 'failed'] as const;
export const PIN_ACTS = ['attach', 'detach', 'retry', 'update-link', 'post-again'] as const;
export type PinState = typeof PIN_STATES[number];
export const PIN_PLATFORMS = ['telegram', 'slack'] as const;
export type PinPlatform = typeof PIN_PLATFORMS[number];

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const OP_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MESSAGE_ID_RE = /^[0-9.]{1,40}$/;
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_RE.test(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const isAppRef = (v: unknown): v is string => typeof v === 'string' && APP_REF_RE.test(v);

const KNOWN_FIELDS = [
  'recordType', 'conversationKey', 'appRef', 'why', 'at',
  'answer', 'by', 'via', 'principal',
  'platform', 'state', 'act', 'answerRef', 'opId', 'messageId', 'baseUrl', 'reason', 'replacesMessageId', 'inert',
  ...CUSTOM_KNOWN_FIELDS,
] as const;

/** Only an http(s) origin with no path, query or credentials: the server's own public base. */
function isBaseUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 200) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password && (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
  } catch { return false; } // @silent-fallback-ok — an unparseable base is refused, the record is dropped
}

export const projectAppRecordStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN_FIELDS as unknown as ReadonlyArray<string>,
  pathSensitiveFields: ['by', 'via', 'principal', 'platform', 'state', 'act', 'opId', 'machineId', 'keyKind', 'purpose'],
  validate(raw) {
    if (raw.op === 'delete') return null; // every record here is immutable or last-writer; nothing is tombstoned
    const type = raw.recordType;
    if (typeof type !== 'string' || !/^project-app-[a-z-]{1,40}$/.test(type)) return null;
    // Part-2 custom-app types (ProjectAppCustomFold.ts). Within the kind's 64 KiB serialized line.
    if ((CUSTOM_RECORD_TYPES as ReadonlyArray<string>).includes(type)) {
      const v = fitsRecordLine(raw) ? validateCustomRecord(raw) : null;
      return v ?? { recordType: type };
    }
    // Forward compatibility (part 2, docs/specs/project-apps-sandbox.md): a record type or app ref this
    // build does not know yet is ACCEPTED as an inert stub and ignored by every fold. Refusing it would
    // mark the peer's whole stream suspect and stall replication on a machine still on this build.
    if (!(PROJECT_APP_RECORD_TYPES as ReadonlyArray<string>).includes(type)) return { recordType: type };
    const ck = raw.conversationKey;
    if (!isValidConversationKey(ck) || !isIso(raw.at)) return null;
    // Part 2 (project-apps-sandbox §3.1): a `custom:` ref is now validated like a builtin one. A build that
    // predates part 2 keeps it as an inert stub; whether a custom app shows is the runtime's decision.
    if (!isAppRef(raw.appRef) && !(typeof raw.appRef === 'string' && CUSTOM_APP_REF_RE.test(raw.appRef))) return null;
    const base = { recordType: type, conversationKey: ck, appRef: raw.appRef, at: raw.at };
    switch (type as ProjectAppRecordType) {
      case 'project-app-offer': {
        if (!isText(raw.why, OFFER_WHY_MAX)) return null;
        return { ...base, why: raw.why };
      }
      case 'project-app-answer': {
        const answer = raw.answer;
        const by = raw.by;
        if (by === 'owner') { if (!(OWNER_ANSWERS as ReadonlyArray<unknown>).includes(answer)) return null; }
        else if (by === 'agent') { if (!(AGENT_ANSWERS as ReadonlyArray<unknown>).includes(answer)) return null; }
        else return null;
        if (!(ANSWER_VIA as ReadonlyArray<unknown>).includes(raw.via)) return null;
        // An owner attach/decline/detach never comes from a plain Bearer (spec §3.3).
        if (by === 'owner' && raw.via === 'bearer') return null;
        if (raw.principal !== undefined && !isText(raw.principal, 120)) return null;
        return { ...base, answer, by, via: raw.via, ...(raw.principal !== undefined ? { principal: raw.principal } : {}) };
      }
      case 'project-app-pin': {
        if (!(PIN_PLATFORMS as ReadonlyArray<unknown>).includes(raw.platform)) return null;
        if (!(PIN_STATES as ReadonlyArray<unknown>).includes(raw.state)) return null;
        if (typeof raw.opId !== 'string' || !OP_ID_RE.test(raw.opId)) return null;
        if (raw.messageId !== undefined && (typeof raw.messageId !== 'string' || !MESSAGE_ID_RE.test(raw.messageId))) return null;
        if (raw.replacesMessageId !== undefined && (typeof raw.replacesMessageId !== 'string' || !MESSAGE_ID_RE.test(raw.replacesMessageId))) return null;
        if (raw.baseUrl !== undefined && !isBaseUrl(raw.baseUrl)) return null;
        if (raw.reason !== undefined && !isText(raw.reason, 300)) return null;
        if ((raw.state === 'posted' || raw.state === 'pinned' || raw.state === 'edited' || raw.state === 'unpinned') && raw.messageId === undefined) return null;
        // An act names what was asked for; only act steps carry one.
        if (raw.state === 'act' ? !(PIN_ACTS as ReadonlyArray<unknown>).includes(raw.act) : raw.act !== undefined) return null;
        if (raw.answerRef !== undefined && (typeof raw.answerRef !== 'string' || raw.answerRef.length > 300 || !raw.answerRef.startsWith('appanswer:'))) return null;
        return {
          ...base, platform: raw.platform, state: raw.state, opId: raw.opId,
          ...(raw.act !== undefined ? { act: raw.act } : {}),
          ...(raw.answerRef !== undefined ? { answerRef: raw.answerRef } : {}),
          ...(raw.messageId !== undefined ? { messageId: raw.messageId } : {}),
          ...(raw.replacesMessageId !== undefined ? { replacesMessageId: raw.replacesMessageId } : {}),
          ...(raw.baseUrl !== undefined ? { baseUrl: raw.baseUrl } : {}),
          ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
        };
      }
    }
    return null;
  },
};

export const PROJECT_APP_KIND_REGISTRATION = {
  kind: PROJECT_APP_RECORD_KIND,
  store: PROJECT_APP_STORE_KEY,
  schema: projectAppRecordStoreSchema,
} as const;

// ── builders (BuildRecordData shape) ────────────────────────────────────────

type Build = (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> | null;

function envelope(recordKey: string, hlc: HlcTimestamp, origin: string, observed: HlcTimestamp | undefined, fields: Record<string, unknown>): Record<string, unknown> {
  return { ...fields, recordKey, hlc, op: 'put', origin, ...(observed !== undefined ? { observed } : {}) };
}

export const offerKey = (conversationKey: string, appRef: string): string => `appoffer:${conversationKey}:${appRef}`;

export function buildOffer(o: { conversationKey: string; appRef: string; why: string; at: string }): Build {
  return (hlc, origin, observed) => envelope(offerKey(o.conversationKey, o.appRef), hlc, origin, observed, { recordType: 'project-app-offer', ...o });
}

export function buildAnswer(a: { conversationKey: string; appRef: string; answer: AppAnswer; by: 'owner' | 'agent'; via: AnswerVia; principal?: string; at: string }): Build {
  return (hlc, origin, observed) => envelope(`appanswer:${a.conversationKey}:${a.appRef}:${hlcKey(hlc)}`, hlc, origin, observed, { recordType: 'project-app-answer', ...a });
}

export interface PinEventInput {
  conversationKey: string; appRef: string; platform: PinPlatform; state: PinState; opId: string;
  act?: PinAct; answerRef?: string;
  messageId?: string; replacesMessageId?: string; baseUrl?: string; reason?: string; at: string;
}

export function buildPinEvent(p: PinEventInput): Build {
  return (hlc, origin, observed) => envelope(`apppin:${p.conversationKey}:${p.appRef}:${hlcKey(hlc)}`, hlc, origin, observed, { recordType: 'project-app-pin', ...p });
}

// ── folds ───────────────────────────────────────────────────────────────────

export interface UnionEntry { data: Record<string, unknown>; origin: string }

type Hlc = HlcTimestamp;
function hlcOf(d: Record<string, unknown>): Hlc | null {
  const h = d.hlc as Hlc | undefined;
  return h && Number.isFinite(h.physical) && Number.isInteger(h.logical) && typeof h.node === 'string' ? h : null;
}

export type AttachState = 'attached' | 'declined' | 'detached' | 'offered' | 'withdrawn' | 'none';

export interface PairState {
  conversationKey: string; appRef: string;
  state: AttachState;
  /** The agent may not offer again: any offer exists, or the owner said no / removed it. */
  offerBlocked: boolean;
  offer: { why: string; at: string } | null;
  /** The newest owner answer (what decides attachment). */
  ownerAnswer: { answer: AppAnswer; via: AnswerVia; principal?: string; at: string; hlc: Hlc } | null;
  attachedAt: string | null;
  /** Every answer, newest first (shown on the row so an answer the owner did not make is visible). */
  answers: Array<{ answer: AppAnswer; by: 'owner' | 'agent'; via: AnswerVia; at: string }>;
}

const pairKey = (ck: string, ref: string) => `${ck}\u0000${ref}`;

/**
 * The attachment fold (spec §3.2). Owner answers decide attachment, newest HLC first. The
 * agent's `withdraw` only withdraws an offer the owner has not answered: it can never undo an
 * owner's attach, whatever its HLC (round-3 finding: a Bearer decline must not detach).
 */
export function foldPairs(union: UnionEntry[]): Map<string, PairState> {
  const out = new Map<string, PairState>();
  const get = (ck: string, ref: string): PairState => {
    const k = pairKey(ck, ref);
    let p = out.get(k);
    if (!p) { p = { conversationKey: ck, appRef: ref, state: 'none', offerBlocked: false, offer: null, ownerAnswer: null, attachedAt: null, answers: [] }; out.set(k, p); }
    return p;
  };
  const offers: Array<{ d: Record<string, unknown>; h: Hlc }> = [];
  const answers: Array<{ d: Record<string, unknown>; h: Hlc }> = [];
  for (const e of union) {
    const d = e.data; const h = hlcOf(d);
    // Only records this build understands are folded (inert stubs from a later build are skipped).
    if (!h || d.inert || typeof d.conversationKey !== 'string' || typeof d.appRef !== 'string' || !(APP_REF_RE.test(d.appRef) || CUSTOM_APP_REF_RE.test(d.appRef))) continue;
    if (d.recordType === 'project-app-offer') offers.push({ d, h });
    else if (d.recordType === 'project-app-answer') answers.push({ d, h });
  }
  for (const { d } of offers) {
    const p = get(String(d.conversationKey), String(d.appRef));
    p.offer = { why: String(d.why ?? ''), at: String(d.at ?? '') };
  }
  answers.sort((a, b) => compareHlc(b.h, a.h));
  const withdrawnPairs = new Set<string>();
  for (const { d, h } of answers) {
    const ck = String(d.conversationKey); const ref = String(d.appRef);
    const p = get(ck, ref);
    const by = d.by === 'owner' ? 'owner' : 'agent';
    p.answers.push({ answer: d.answer as AppAnswer, by, via: d.via as AnswerVia, at: String(d.at ?? '') });
    if (by === 'owner') {
      if (!p.ownerAnswer) p.ownerAnswer = { answer: d.answer as AppAnswer, via: d.via as AnswerVia, ...(typeof d.principal === 'string' ? { principal: d.principal } : {}), at: String(d.at ?? ''), hlc: h };
    } else if (d.answer === 'withdraw') withdrawnPairs.add(pairKey(ck, ref));
  }
  for (const [k, p] of out) {
    if (p.ownerAnswer) {
      const a = p.ownerAnswer.answer;
      p.state = a === 'attach' ? 'attached' : a === 'decline' ? 'declined' : 'detached';
      if (a === 'attach') p.attachedAt = p.ownerAnswer.at;
    } else if (p.offer) p.state = withdrawnPairs.has(k) ? 'withdrawn' : 'offered';
    p.offerBlocked = !!p.offer || p.state === 'declined' || p.state === 'detached' || p.state === 'attached';
  }
  return out;
}

export interface PinView {
  platform: PinPlatform;
  /** The message that should be pinned now (newest pinned whose base matches), or null. */
  current: { messageId: string; baseUrl: string | null; at: string } | null;
  /** Every message this kind ever posted or pinned that has not been recorded unpinned. */
  live: Array<{ messageId: string; state: 'posted' | 'pinned'; baseUrl: string | null }>;
  /** The newest step: a `pending` with no later step means the last attempt's outcome is unknown. */
  last: { state: PinState; opId: string; reason?: string; at: string } | null;
  /** Consecutive failures of the newest run of `failed` steps (for back-off); a `retry` step resets it. */
  failures: number;
  /** Messages whose newest step is a failure naming them (an edit that did not take). */
  editFailed: string[];
}

/** The pin fold for one (conversation, app) pair (spec §3.6). */
export function foldPins(union: UnionEntry[], conversationKey: string, appRef: string): PinView | null {
  const evs = union
    .map((e) => ({ d: e.data, h: hlcOf(e.data) }))
    .filter((x): x is { d: Record<string, unknown>; h: Hlc } => !!x.h && x.d.recordType === 'project-app-pin' && x.d.conversationKey === conversationKey && x.d.appRef === appRef)
    .sort((a, b) => compareHlc(a.h, b.h));
  if (!evs.length) return null;
  const platform = evs[evs.length - 1].d.platform as PinPlatform;
  const msgs = new Map<string, { state: 'posted' | 'pinned' | 'unpinned'; baseUrl: string | null; at: string }>();
  let failures = 0;
  const editFailed = new Set<string>();
  for (const { d } of evs) {
    const id = typeof d.messageId === 'string' ? d.messageId : null;
    if (id && (d.state === 'posted' || d.state === 'pinned' || d.state === 'unpinned')) {
      const prev = msgs.get(id);
      const baseUrl = typeof d.baseUrl === 'string' ? d.baseUrl : prev?.baseUrl ?? null;
      msgs.set(id, { state: d.state, baseUrl, at: String(d.at ?? '') });
      editFailed.delete(id);
    } else if (id && d.state === 'edited') {
      const prev = msgs.get(id);
      if (prev) msgs.set(id, { ...prev, baseUrl: typeof d.baseUrl === 'string' ? d.baseUrl : prev.baseUrl, at: String(d.at ?? '') });
      editFailed.delete(id);
    } else if (id && d.state === 'failed') editFailed.add(id);
    if (d.state === 'failed') failures++;
    else if (d.state === 'retry') failures = 0;
    else if (d.state !== 'pending') failures = 0;
  }
  const nonAct = evs.filter((x) => x.d.state !== 'act');
  const lastD = (nonAct.length ? nonAct[nonAct.length - 1] : evs[evs.length - 1]).d;
  const live = [...msgs.entries()].filter(([, m]) => m.state !== 'unpinned').map(([messageId, m]) => ({ messageId, state: m.state as 'posted' | 'pinned', baseUrl: m.baseUrl }));
  const pinned = [...msgs.entries()].filter(([, m]) => m.state === 'pinned');
  const cur = pinned.length ? pinned[pinned.length - 1] : null;
  return {
    platform,
    current: cur ? { messageId: cur[0], baseUrl: cur[1].baseUrl, at: cur[1].at } : null,
    live,
    last: { state: lastD.state as PinState, opId: String(lastD.opId), ...(typeof lastD.reason === 'string' ? { reason: lastD.reason } : {}), at: String(lastD.at ?? '') },
    failures,
    editFailed: [...editFailed],
  };
}

export type PinAction =
  | { kind: 'none'; why?: 'uncertain' | 'no-public-address' | 'nothing-to-do' | 'out-of-date' }
  | { kind: 'post'; replacesMessageId?: string }
  | { kind: 'pin'; messageId: string }
  | { kind: 'edit'; messageId: string }
  | { kind: 'unpin'; messageId: string };

/** The deliberate act that asked for a pin step (spec §3.6). Nothing acts without one. */
export type PinAct = 'attach' | 'detach' | 'retry' | 'update-link' | 'post-again';

/** Whether the newest step leaves the last send's outcome unknown (a `pending` with nothing after it). */
export function pinUncertain(pins: PinView | null): boolean {
  return pins?.last?.state === 'pending';
}

/** Whether a pinned link points at an address other than the current public one. */
export function pinOutOfDate(pins: PinView | null, baseUrl: string | null): boolean {
  return !!baseUrl && !!pins?.current && pins.current.baseUrl !== null && pins.current.baseUrl !== baseUrl;
}

/**
 * The one platform step a deliberate act causes (spec §3.6). Pure. There is no background loop:
 * the caller runs this only for an act (the owner's Attach/Detach/Try again/Update link/Post the
 * link again, or the agent's Try again), records `pending` before acting and the outcome after.
 *  - A `posted` message is pinned by its id rather than sent again (a crash after `posted` cannot
 *    make a second message).
 *  - A `pending` with nothing after it is `uncertain`: only `post-again` sends in that state.
 *  - An address change is only flagged (`out-of-date`); `update-link` edits the pinned message in
 *    place, and posts a replacement only after an edit of that message failed.
 */
export function nextPinAction(act: PinAct | null, attached: boolean, pins: PinView | null, baseUrl: string | null): PinAction {
  const live = pins?.live ?? [];
  if (act === 'detach' || !attached) {
    if (!act && pins?.last?.state === 'failed') return { kind: 'none', why: 'nothing-to-do' };
    const any = live[0];
    return any ? { kind: 'unpin', messageId: any.messageId } : { kind: 'none', why: 'nothing-to-do' };
  }
  if (pinUncertain(pins) && act !== 'post-again') return { kind: 'none', why: 'uncertain' };
  // After a failure nothing runs on its own: only a fresh act makes the next platform call, so a
  // pin the bot is not allowed to make is not retried on every journal write (second-pass review).
  if (!act && pins?.last?.state === 'failed') return { kind: 'none', why: 'nothing-to-do' };
  if (!baseUrl) return { kind: 'none', why: 'no-public-address' };
  const fresh = live.filter((m) => m.baseUrl === baseUrl);
  const stale = live.filter((m) => m.baseUrl !== baseUrl);
  const pinnedFresh = fresh.find((m) => m.state === 'pinned');
  if (pinnedFresh) {
    // The right link is pinned; clear every other link this kind left behind (sends nothing new).
    const other = live.find((m) => m.messageId !== pinnedFresh.messageId);
    return other ? { kind: 'unpin', messageId: other.messageId } : { kind: 'none', why: 'nothing-to-do' };
  }
  const postedFresh = fresh.find((m) => m.state === 'posted');
  if (postedFresh) return { kind: 'pin', messageId: postedFresh.messageId };
  const pinnedStale = [...stale].reverse().find((m) => m.state === 'pinned');
  if (pinnedStale) {
    const failed = new Set(pins?.editFailed ?? []);
    const missing = pins?.last?.state === 'failed' && pins.last.reason === 'message-missing';
    // Edit in place on its own (no new message); after an edit failed, only an act may recover:
    // Update link edits again, unless the message is gone, when it posts a replacement.
    if (!failed.has(pinnedStale.messageId)) return { kind: 'edit', messageId: pinnedStale.messageId };
    if (act === 'update-link' || act === 'post-again' || act === 'retry') {
      return missing || act === 'post-again' ? { kind: 'post', replacesMessageId: pinnedStale.messageId } : { kind: 'edit', messageId: pinnedStale.messageId };
    }
    return { kind: 'none', why: 'out-of-date' };
  }
  if (!act) return { kind: 'none', why: 'nothing-to-do' };
  return stale.length ? { kind: 'post', replacesMessageId: stale[stale.length - 1].messageId } : { kind: 'post' };
}
