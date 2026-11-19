/**
 * ChiefOfStaffStore — the `chief-of-staff-record` replicated-store kind (store key
 * `chiefOfStaff`) for the Chief of Staff conversation (docs/specs/chief-of-staff-topic.md).
 *
 * §1.2 of the spec: the substrate merges ONE whole record per key by highest HLC and has
 * no field-wise merge, so every record two machines could write concurrently is an
 * IMMUTABLE, EVENT-KEYED record and every mutable view is DERIVED by folding the union.
 * That is what makes the posture honestly "unified": nothing authoritative lives only in
 * memory or only on one machine, and arrival order cannot change a derived view.
 *
 * Record types carried by this one kind (discriminator `recordType`):
 *   tree              parent link; key = conversationKey; last-writer by HLC; tombstone on unparent
 *   binding           goal/doneDefinition/cadence/linked/initiative; key = conversationKey;
 *                     last-writer by HLC; written ONLY by owner taps; identity = its record HLC
 *   binding-lifecycle closed|reopened|unpark; key = conversationKey:hlc; immutable;
 *                     closed valid iff bindingHlc === winning binding's HLC; reopened/unpark
 *                     valid iff by === 'owner-tap'
 *   check-event       verdict + evidence hash + progressSeen + highWater; key = conversationKey:hlc
 *   intent            action claim; key = conversationKey:leaseEpoch:sequence; immutable
 *   outcome           transition log; key = intentKey:outcome:<transition>; immutable
 *   renewal           operator check-in; key = renewal:hlc; immutable; machine-signed
 *   graduation        pilot metrics snapshot; key = date
 *   last-tick         loop liveness marker; key = last-tick:<machineId>
 *
 * This module is PURE: schema, builders, transition rules and folds. It performs no I/O
 * and emits nothing. Emission and the §2.4 action protocol land in the follow-on PRs.
 */

import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import crypto from 'node:crypto';
import { compareHlc } from './TopicPinReplicatedStore.js';
import { resolveDevAgentGate } from './devAgentGate.js';

export { compareHlc };

/** The JournalKind string this store rides (dynamic half of the dual registry; the static
 *  half is CoherenceJournal.JOURNAL_KINDS, which lists 'chief-of-staff-record'). */
export const CHIEF_OF_STAFF_RECORD_KIND = 'chief-of-staff-record';
/** The stateSync config sub-key (`multiMachine.stateSync.chiefOfStaff`). */
export const CHIEF_OF_STAFF_STORE_KEY = 'chiefOfStaff';

/**
 * Whether this machine emits and receives `chief-of-staff-record` (spec §1.2: "the
 * `multiMachine.stateSync.chiefOfStaff` flag is forced on whenever `chiefOfStaff.enabled` is true").
 * It follows the feature switch alone: the Chief of Staff's state — check-ins, bindings, notes,
 * last-tick — is the agent's, never one machine's, so there is no machine-local mode to fall back to.
 * Echo Bugs topic 10000002562 (2026-11-11): the flag was never set, every record was refused
 * 'disabled', and the owner's check-in was saved on no machine at all.
 */
export function chiefOfStaffStoreEnabled(config: { developmentAgent?: boolean; chiefOfStaff?: { enabled?: boolean } } | undefined): boolean {
  return resolveDevAgentGate(config?.chiefOfStaff?.enabled, config);
}

export const COS_RECORD_TYPES = [
  'tree', 'binding', 'binding-lifecycle', 'check-event', 'intent', 'outcome', 'renewal', 'graduation', 'last-tick', 'note',
] as const;
export type CosRecordType = typeof COS_RECORD_TYPES[number];

/** §2.5 closed verdict set (+ the two record-only states the loop writes). */
export const COS_VERDICTS = [
  'moving', 'moving-under-existing-owner', 'stalled', 'drifting', 'waiting-on-user', 'claims-done', 'done-verified', 'unknown',
] as const;
export type CosVerdict = typeof COS_VERDICTS[number];

/** §2.4 action protocol transitions (the `outcome` transition log). */
export const COS_TRANSITIONS = ['claimed', 'executing', 'started', 'superseded', 'rejected', 'lost', 'aborted'] as const;
export type CosTransition = typeof COS_TRANSITIONS[number];

/** Who may write a transition (§1.2): the ownership machine writes every transition except
 *  `lost`, which only the lease holder writes (and only after a `rejected`). */
export const COS_TRANSITION_WRITER: Readonly<Record<Exclude<CosTransition, 'claimed'>, 'ownership-machine' | 'holder'>> = Object.freeze({
  executing: 'ownership-machine',
  started: 'ownership-machine',
  superseded: 'ownership-machine',
  rejected: 'ownership-machine',
  aborted: 'ownership-machine',
  lost: 'holder',
});

/** Legal transitions, from → to (§1.2 table). `claimed` is the intent record itself.
 *  `lost` is reachable ONLY through `rejected` (the ownership machine's tombstone + ack). */
export const LEGAL_TRANSITIONS: Readonly<Record<CosTransition, ReadonlyArray<CosTransition>>> = Object.freeze({
  claimed: ['executing', 'superseded', 'rejected'],
  executing: ['started', 'rejected', 'aborted'],
  started: ['superseded', 'aborted'],
  superseded: ['aborted'],
  rejected: ['lost'],
  lost: [],
  aborted: [],
});

/** Rank used to pick "the furthest legal transition present" deterministically. Terminal
 *  states rank highest; `lost` outranks `rejected` because it can only follow one. */
const TRANSITION_RANK: Readonly<Record<CosTransition, number>> = Object.freeze({
  claimed: 0, executing: 1, started: 2, superseded: 3, rejected: 4, lost: 5, aborted: 6,
});

export function isLegalTransition(from: CosTransition, to: CosTransition): boolean {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export const COS_LIFECYCLE_EVENTS = ['closed', 'reopened', 'unpark', 'owner-pause', 'owner-resume', 'owner-item-check', 'check-requested'] as const;
export type CosLifecycleEvent = typeof COS_LIFECYCLE_EVENTS[number];
/** The owner's pause on a project (docs/specs/cos-owner-pause-record.md). */
export interface OwnerPauseRecord { who: string; at: string; quote: string; messageRef: string }
/** The owner's own check on one judgment done item (docs/specs/work-door-project-rows.md §3.3). */
export interface OwnerItemCheckRecord { who: string; at: string; messageRef: string; itemId: string; checked: boolean; checkRef: string }

/**
 * What an owner item check is bound to (work-door-project-rows §3.3): the SHA-256 (hex) of the UTF-8 JSON array
 * `[goal, itemId, itemText]`. Changing the goal or the item voids the check.
 */
export function doneItemCheckRef(goal: string, itemId: string, itemText: string): string {
  // JSON array encoding: unambiguous for any text (a newline inside the goal or the text cannot shift a boundary).
  return crypto.createHash('sha256').update(JSON.stringify([goal, itemId, itemText]), 'utf8').digest('hex');
}
/** A done item id as the binding validator bounds one (1–64 characters). */
export const DONE_ITEM_ID_MAX = 64;
/** §3.5: Telegram's own message limit, so a whole owner message always fits. */
export const OWNER_PAUSE_QUOTE_MAX = 4096;
/** Server-produced fields (owner name, parsed marker); the merged reader's bound. */
export const OWNER_PAUSE_FIELD_MAX = 2000;

export const COS_ACTIONS = ['restart-inject', 'restart-run', 'redirect', 'close', 'mirror-status'] as const;
export type CosAction = typeof COS_ACTIONS[number];

// ── identity surfaces ───────────────────────────────────────────────────────

/** `platform:id` — `conversationSortKey` from the mobile list, the one identity that spans
 *  every conversation kind today (§1.2). Clamped: no paths, no whitespace, bounded. */
const CONVERSATION_KEY_RE = /^(telegram|app|slack|imessage|whatsapp):[A-Za-z0-9_.:-]{1,128}$/;
const MACHINE_ID_RE = /^[\w-]{1,64}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidConversationKey(k: unknown): k is string {
  return typeof k === 'string' && CONVERSATION_KEY_RE.test(k);
}

export function hlcKey(h: HlcTimestamp): string {
  return `${h.physical}.${h.logical}.${h.node}`;
}

export function deriveIntentKey(conversationKey: string, leaseEpoch: number, sequence: number): string | null {
  if (!isValidConversationKey(conversationKey) || !Number.isInteger(leaseEpoch) || leaseEpoch < 0 || !Number.isInteger(sequence) || sequence < 0) return null;
  return `${conversationKey}:${leaseEpoch}:${sequence}`;
}

export function deriveOutcomeKey(intentKey: string, transition: CosTransition): string {
  return `${intentKey}:outcome:${transition}`;
}

// ── schema ──────────────────────────────────────────────────────────────────

const KNOWN_FIELDS = [
  'recordType', 'conversationKey', 'parentConversationKey', 'role', 'deletedAt',
  'goal', 'doneDefinition', 'checkCadenceHours', 'linked', 'initiativeId', 'confirmedBy', 'confirmedAt',
  'event', 'bindingHlc', 'by', 'at', 'who', 'quote', 'messageRef', 'askId', 'itemId', 'itemChecked', 'checkRef',
  'verdict', 'evidenceHash', 'evidenceIds', 'progressSeen', 'netDiffHighWater', 'machine', 'note',
  'action', 'leaseEpoch', 'sequence', 'claimedAt', 'holderSignature', 'intentKey', 'transition', 'writer', 'runId', 'injectId', 'reason',
  'renewedAt', 'renewedVia', 'principal', 'eventRef', 'machineSignature',
  'date', 'metrics', 'decision',
  'tickAt',
] as const;

/** A lifecycle event name a later build may add: one or more lower-case words joined by '-'. */
const UNKNOWN_EVENT_RE = /^[a-z]+(-[a-z]+)*$/;
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_RE.test(v);
const isMachine = (v: unknown): v is string => typeof v === 'string' && MACHINE_ID_RE.test(v);
const isShortText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isHlc = (v: unknown): v is HlcTimestamp => {
  if (!v || typeof v !== 'object') return false;
  const h = v as Record<string, unknown>;
  return Number.isFinite(h.physical) && Number.isInteger(h.logical) && typeof h.node === 'string' && MACHINE_ID_RE.test(h.node);
};

interface DoneItem { id: string; kind: 'deterministic' | 'judgment'; text: string; certify?: 'owner-confirms' | 'agent-may-certify' }

function validateDoneDefinition(v: unknown): DoneItem[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > 64) return null;
  const out: DoneItem[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') return null;
    const it = raw as Record<string, unknown>;
    if (!isShortText(it.id, 64) || !isShortText(it.text, 2000)) return null;
    if (it.kind !== 'deterministic' && it.kind !== 'judgment') return null;
    const item: DoneItem = { id: it.id, kind: it.kind, text: it.text };
    if (it.kind === 'judgment') {
      if (it.certify !== undefined && it.certify !== 'owner-confirms' && it.certify !== 'agent-may-certify') return null;
      item.certify = (it.certify as DoneItem['certify']) ?? 'owner-confirms';
    }
    out.push(item);
  }
  return out;
}

function validateLinked(v: unknown): { repos: string[]; branches: string[]; domains: string[] } | null {
  if (!v || typeof v !== 'object') return null;
  const l = v as Record<string, unknown>;
  const list = (x: unknown, max: number, re: RegExp): string[] | null => {
    if (x === undefined) return [];
    if (!Array.isArray(x) || x.length > max) return null;
    const out: string[] = [];
    for (const s of x) { if (typeof s !== 'string' || !re.test(s)) return null; out.push(s); }
    return out;
  };
  const repos = list(l.repos, 16, /^[\w.-]{1,64}\/[\w.-]{1,100}$/);
  const branches = list(l.branches, 32, /^[^\s~^:?*[\\]{1,200}$/);
  const domains = list(l.domains, 16, /^[a-z0-9.-]{1,253}$/i);
  if (!repos || !branches || !domains) return null;
  return { repos, branches, domains };
}

export const chiefOfStaffRecordStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN_FIELDS as unknown as ReadonlyArray<string>,
  pathSensitiveFields: ['machine', 'by', 'writer', 'principal', 'role', 'renewedVia'],
  validate(raw: Readonly<Record<string, unknown>>, ctx: StoreValidateContext): Record<string, unknown> | null {
    if (raw.op === 'delete') {
      // Only `tree` is ever tombstoned (unparent). Everything else is immutable.
      const deletedAt = isIso(raw.deletedAt) ? raw.deletedAt : undefined;
      for (const k of Object.keys(raw)) {
        if (k === 'op' || k === 'deletedAt' || k === 'recordType') continue;
        if ((KNOWN_FIELDS as ReadonlyArray<string>).includes(k)) ctx.countDroppedField();
      }
      return { recordType: 'tree', ...(deletedAt !== undefined ? { deletedAt } : {}) };
    }
    const type = raw.recordType;
    if (typeof type !== 'string' || !(COS_RECORD_TYPES as ReadonlyArray<string>).includes(type)) return null;
    const ck = raw.conversationKey;
    switch (type as CosRecordType) {
      case 'tree': {
        if (!isValidConversationKey(ck)) return null;
        const parent = raw.parentConversationKey;
        if (parent !== null && parent !== undefined && !isValidConversationKey(parent)) return null;
        const role = raw.role;
        if (role !== undefined && role !== 'chief-of-staff' && role !== 'project' && role !== 'sub-topic') return null;
        return { recordType: type, conversationKey: ck, parentConversationKey: parent ?? null, ...(role !== undefined ? { role } : {}) };
      }
      case 'binding': {
        if (!isValidConversationKey(ck)) return null;
        if (!isShortText(raw.goal, 4000)) return null;
        const done = validateDoneDefinition(raw.doneDefinition);
        if (!done) return null;
        if (!(typeof raw.checkCadenceHours === 'number' && Number.isFinite(raw.checkCadenceHours) && raw.checkCadenceHours >= 1)) return null;
        const linked = validateLinked(raw.linked);
        if (!linked) return null;
        if (raw.initiativeId !== undefined && !isShortText(raw.initiativeId, 200)) return null;
        if (raw.confirmedBy !== undefined && raw.confirmedBy !== 'owner') return null;
        if (raw.confirmedAt !== undefined && !isIso(raw.confirmedAt)) return null;
        return {
          recordType: type, conversationKey: ck, goal: raw.goal, doneDefinition: done, checkCadenceHours: raw.checkCadenceHours, linked,
          ...(raw.initiativeId !== undefined ? { initiativeId: raw.initiativeId } : {}),
          ...(raw.confirmedBy !== undefined ? { confirmedBy: raw.confirmedBy } : {}),
          ...(raw.confirmedAt !== undefined ? { confirmedAt: raw.confirmedAt } : {}),
        };
      }
      case 'binding-lifecycle': {
        if (!isValidConversationKey(ck)) return null;
        if (typeof raw.event !== 'string') return null;
        if (!isHlc(raw.bindingHlc)) return null;
        if (!isIso(raw.at)) return null;
        // Forward-compatible reader (spec cos-owner-pause-record, Multi-machine posture): an event this build does
        // not know is stored and IGNORED by every fold, never rejected. A rejected record stalls the whole
        // peer stream on an older machine, so rejecting would turn every later addition (and a rollback) into a freeze.
        if (!(COS_LIFECYCLE_EVENTS as ReadonlyArray<string>).includes(raw.event)) {
          if (raw.event.length > 200 || !UNKNOWN_EVENT_RE.test(raw.event) || !isShortText(raw.by, 200)) return null;
          return { recordType: type, conversationKey: ck, event: raw.event, bindingHlc: raw.bindingHlc, by: raw.by, at: raw.at };
        }
        if (raw.event === 'owner-pause' || raw.event === 'owner-resume') {
          // Only the owner's own tap pauses or resumes (spec cos-owner-pause-record §3.1): never the Chief of Staff.
          if (raw.by !== 'owner-tap') return null;
          if (!isShortText(raw.who, OWNER_PAUSE_FIELD_MAX) || !isShortText(raw.quote, OWNER_PAUSE_QUOTE_MAX) || !isShortText(raw.messageRef, OWNER_PAUSE_FIELD_MAX) || !isShortText(raw.askId, 64)) return null;
          return { recordType: type, conversationKey: ck, event: raw.event, bindingHlc: raw.bindingHlc, by: raw.by, at: raw.at, who: raw.who, quote: raw.quote, messageRef: raw.messageRef, askId: raw.askId };
        }
        if (raw.event === 'owner-item-check') {
          // Only the owner's own tap checks a judged done item (work-door-project-rows §3.3): never the Chief of Staff.
          if (raw.by !== 'owner-tap' || typeof raw.itemChecked !== 'boolean' || typeof raw.checkRef !== 'string' || !SHA256_HEX_RE.test(raw.checkRef)) return null;
          if (!isShortText(raw.itemId, DONE_ITEM_ID_MAX) || !isShortText(raw.who, OWNER_PAUSE_FIELD_MAX) || !isShortText(raw.messageRef, OWNER_PAUSE_FIELD_MAX) || !isShortText(raw.askId, 64)) return null;
          return { recordType: type, conversationKey: ck, event: raw.event, bindingHlc: raw.bindingHlc, by: raw.by, at: raw.at, who: raw.who, messageRef: raw.messageRef, askId: raw.askId, itemId: raw.itemId, itemChecked: raw.itemChecked, checkRef: raw.checkRef };
        }
        if (raw.by !== 'owner-tap' && raw.by !== 'chief-of-staff') return null;
        return { recordType: type, conversationKey: ck, event: raw.event, bindingHlc: raw.bindingHlc, by: raw.by, at: raw.at };
      }
      case 'check-event': {
        if (!isValidConversationKey(ck)) return null;
        if (typeof raw.verdict !== 'string' || !(COS_VERDICTS as ReadonlyArray<string>).includes(raw.verdict)) return null;
        if (typeof raw.evidenceHash !== 'string' || !SHA256_HEX_RE.test(raw.evidenceHash)) return null;
        if (!Array.isArray(raw.evidenceIds) || raw.evidenceIds.length > 256 || !raw.evidenceIds.every((x) => isShortText(x, 128))) return null;
        if (typeof raw.progressSeen !== 'boolean') return null;
        if (raw.netDiffHighWater !== undefined && !(Number.isInteger(raw.netDiffHighWater) && (raw.netDiffHighWater as number) >= 0)) return null;
        if (!isMachine(raw.machine)) return null;
        if (!isIso(raw.at)) return null;
        if (raw.note !== undefined && !isShortText(raw.note, 500)) return null;
        let doneItems: Record<string, 'pass' | 'fail' | 'unknown'> | undefined;
        if (raw.doneItems !== undefined) {
          if (!raw.doneItems || typeof raw.doneItems !== 'object' || Array.isArray(raw.doneItems)) return null;
          const entries = Object.entries(raw.doneItems as Record<string, unknown>);
          if (entries.length > 64 || !entries.every(([k, v]) => isShortText(k, 64) && (v === 'pass' || v === 'fail' || v === 'unknown'))) return null;
          doneItems = Object.fromEntries(entries) as Record<string, 'pass' | 'fail' | 'unknown'>;
        }
        return {
          recordType: type, conversationKey: ck, verdict: raw.verdict, evidenceHash: raw.evidenceHash, evidenceIds: raw.evidenceIds,
          progressSeen: raw.progressSeen, machine: raw.machine, at: raw.at,
          ...(raw.netDiffHighWater !== undefined ? { netDiffHighWater: raw.netDiffHighWater } : {}),
          ...(raw.note !== undefined ? { note: raw.note } : {}),
          ...(doneItems !== undefined ? { doneItems } : {}),
        };
      }
      case 'intent': {
        if (!isValidConversationKey(ck)) return null;
        if (typeof raw.action !== 'string' || !(COS_ACTIONS as ReadonlyArray<string>).includes(raw.action)) return null;
        if (!(Number.isInteger(raw.leaseEpoch) && (raw.leaseEpoch as number) >= 0)) return null;
        if (!(Number.isInteger(raw.sequence) && (raw.sequence as number) >= 0)) return null;
        if (!isIso(raw.claimedAt)) return null;
        if (!isMachine(raw.machine)) return null;
        if (!isShortText(raw.holderSignature, 1024)) return null;
        return { recordType: type, conversationKey: ck, action: raw.action, leaseEpoch: raw.leaseEpoch, sequence: raw.sequence, claimedAt: raw.claimedAt, machine: raw.machine, holderSignature: raw.holderSignature };
      }
      case 'outcome': {
        if (!isShortText(raw.intentKey, 300)) return null;
        if (typeof raw.transition !== 'string' || raw.transition === 'claimed' || !(COS_TRANSITIONS as ReadonlyArray<string>).includes(raw.transition)) return null;
        if (raw.writer !== 'ownership-machine' && raw.writer !== 'holder') return null;
        if (!isMachine(raw.machine)) return null;
        if (!isIso(raw.at)) return null;
        if (raw.runId !== undefined && !isShortText(raw.runId, 200)) return null;
        if (raw.injectId !== undefined && !isShortText(raw.injectId, 200)) return null;
        if (raw.reason !== undefined && !isShortText(raw.reason, 200)) return null;
        return {
          recordType: type, intentKey: raw.intentKey, transition: raw.transition, writer: raw.writer, machine: raw.machine, at: raw.at,
          ...(raw.runId !== undefined ? { runId: raw.runId } : {}),
          ...(raw.injectId !== undefined ? { injectId: raw.injectId } : {}),
          ...(raw.reason !== undefined ? { reason: raw.reason } : {}),
        };
      }
      case 'renewal': {
        if (!isIso(raw.renewedAt)) return null;
        if (raw.renewedVia !== 'telegram' && raw.renewedVia !== 'app' && raw.renewedVia !== 'console') return null;
        if (!isShortText(raw.principal, 200)) return null;
        if (raw.eventRef !== undefined && !isShortText(raw.eventRef, 300)) return null;
        if (!isMachine(raw.machine)) return null;
        if (!isShortText(raw.machineSignature, 1024)) return null;
        return { recordType: type, renewedAt: raw.renewedAt, renewedVia: raw.renewedVia, principal: raw.principal, machine: raw.machine, machineSignature: raw.machineSignature, ...(raw.eventRef !== undefined ? { eventRef: raw.eventRef } : {}) };
      }
      case 'graduation': {
        if (typeof raw.date !== 'string' || !DATE_RE.test(raw.date)) return null;
        if (!raw.metrics || typeof raw.metrics !== 'object' || Array.isArray(raw.metrics)) return null;
        if (raw.decision !== 'pass' && raw.decision !== 'incomplete' && raw.decision !== 'fail') return null;
        return { recordType: type, date: raw.date, metrics: raw.metrics, decision: raw.decision };
      }
      case 'last-tick': {
        if (!isMachine(raw.machine)) return null;
        if (!isIso(raw.tickAt)) return null;
        return { recordType: type, machine: raw.machine, tickAt: raw.tickAt };
      }
      case 'note': {
        // §3 / CMT-1416: a sent note or immediate message, so the cadence and the daily cap fold from records on every machine.
        if (!isMachine(raw.machine)) return null;
        if (!isIso(raw.at)) return null;
        if (raw.kind !== 'note' && raw.kind !== 'immediate') return null;
        if (!Array.isArray(raw.itemKeys) || raw.itemKeys.length > 64 || !raw.itemKeys.every((x) => isShortText(x, 160))) return null;
        return { recordType: type, machine: raw.machine, at: raw.at, kind: raw.kind, itemKeys: raw.itemKeys };
      }
    }
    return null;
  },
};

export const CHIEF_OF_STAFF_KIND_REGISTRATION = {
  kind: CHIEF_OF_STAFF_RECORD_KIND,
  store: CHIEF_OF_STAFF_STORE_KEY,
  schema: chiefOfStaffRecordStoreSchema,
} as const;

export function chiefOfStaffContributingKinds(): string[] {
  return [CHIEF_OF_STAFF_RECORD_KIND];
}

// ── builders (BuildRecordData shape: (hlc, origin, observed?) => data | null) ─

type Build = (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp) => Record<string, unknown> | null;

function envelope(recordKey: string, hlc: HlcTimestamp, origin: string, observed: HlcTimestamp | undefined, op: ReplicatedOp, fields: Record<string, unknown>): Record<string, unknown> {
  return { ...fields, recordKey, hlc, op, origin, ...(observed !== undefined ? { observed } : {}) };
}

export function buildTreePut(conversationKey: string, parentConversationKey: string | null, role?: 'chief-of-staff' | 'project' | 'sub-topic'): Build {
  return (hlc, origin, observed) => {
    if (!isValidConversationKey(conversationKey)) return null;
    return envelope(conversationKey, hlc, origin, observed, 'put', { recordType: 'tree', conversationKey, parentConversationKey, ...(role ? { role } : {}) });
  };
}

export function buildTreeTombstone(conversationKey: string, deletedAt: string): Build {
  return (hlc, origin, observed) => {
    if (!isValidConversationKey(conversationKey)) return null;
    return envelope(conversationKey, hlc, origin, observed, 'delete', { recordType: 'tree', deletedAt });
  };
}

export interface BindingInput {
  conversationKey: string; goal: string; doneDefinition: DoneItem[]; checkCadenceHours: number;
  linked: { repos?: string[]; branches?: string[]; domains?: string[] }; initiativeId?: string; confirmedBy?: 'owner'; confirmedAt?: string;
}

export function buildBindingPut(b: BindingInput): Build {
  return (hlc, origin, observed) => {
    if (!isValidConversationKey(b.conversationKey)) return null;
    return envelope(`binding:${b.conversationKey}`, hlc, origin, observed, 'put', { recordType: 'binding', ...b });
  };
}

export function buildLifecycleEvent(conversationKey: string, event: CosLifecycleEvent, bindingHlc: HlcTimestamp, by: 'owner-tap' | 'chief-of-staff', at: string): Build {
  return (hlc, origin, observed) => {
    if (!isValidConversationKey(conversationKey)) return null;
    return envelope(`lifecycle:${conversationKey}:${hlcKey(hlc)}`, hlc, origin, observed, 'put', { recordType: 'binding-lifecycle', conversationKey, event, bindingHlc, by, at });
  };
}

/** An owner pause / resume (spec cos-owner-pause-record §3.1), written only from the owner's own tap. */
export function buildOwnerPauseEvent(conversationKey: string, event: 'owner-pause' | 'owner-resume', bindingHlc: HlcTimestamp, rec: OwnerPauseRecord, askId: string): Build {
  return (hlc, origin, observed) => {
    if (!isValidConversationKey(conversationKey)) return null;
    return envelope(`lifecycle:${conversationKey}:${hlcKey(hlc)}`, hlc, origin, observed, 'put', { recordType: 'binding-lifecycle', conversationKey, event, bindingHlc, by: 'owner-tap', at: rec.at, who: rec.who, quote: rec.quote, messageRef: rec.messageRef, askId });
  };
}

/** The owner checks or unchecks one judgment done item (work-door-project-rows §3.3), written only from the owner's own tap. */
export function buildOwnerItemCheckEvent(conversationKey: string, bindingHlc: HlcTimestamp, rec: OwnerItemCheckRecord, askId: string): Build {
  return (hlc, origin, observed) => {
    if (!isValidConversationKey(conversationKey)) return null;
    return envelope(`lifecycle:${conversationKey}:${hlcKey(hlc)}`, hlc, origin, observed, 'put', { recordType: 'binding-lifecycle', conversationKey, event: 'owner-item-check', bindingHlc, by: 'owner-tap', at: rec.at, who: rec.who, messageRef: rec.messageRef, askId, itemId: rec.itemId, itemChecked: rec.checked, checkRef: rec.checkRef });
  };
}

/** "Ask for an update" that could not run at once (work-door-project-rows §3.2): the holder's next tick checks it. */
export function buildCheckRequestedEvent(conversationKey: string, bindingHlc: HlcTimestamp, by: 'owner-tap' | 'chief-of-staff', at: string): Build {
  return (hlc, origin, observed) => {
    if (!isValidConversationKey(conversationKey)) return null;
    return envelope(`lifecycle:${conversationKey}:${hlcKey(hlc)}`, hlc, origin, observed, 'put', { recordType: 'binding-lifecycle', conversationKey, event: 'check-requested', bindingHlc, by, at });
  };
}

export interface CheckEventInput {
  conversationKey: string; verdict: CosVerdict; evidenceHash: string; evidenceIds: string[]; progressSeen: boolean; netDiffHighWater?: number; machine: string; at: string; note?: string;
  /** The deterministic done-item results at this check — the DURABLE baseline the next check's progress detection compares against (never an in-memory map). */
  doneItems?: Record<string, 'pass' | 'fail' | 'unknown'>;
}

export function buildCheckEvent(c: CheckEventInput): Build {
  return (hlc, origin, observed) => {
    if (!isValidConversationKey(c.conversationKey)) return null;
    return envelope(`check:${c.conversationKey}:${hlcKey(hlc)}`, hlc, origin, observed, 'put', { recordType: 'check-event', ...c });
  };
}

export interface IntentInput { conversationKey: string; action: CosAction; leaseEpoch: number; sequence: number; claimedAt: string; machine: string; holderSignature: string }

export function buildIntent(i: IntentInput): Build {
  return (hlc, origin, observed) => {
    const key = deriveIntentKey(i.conversationKey, i.leaseEpoch, i.sequence);
    if (!key) return null;
    return envelope(key, hlc, origin, observed, 'put', { recordType: 'intent', ...i });
  };
}

export interface OutcomeInput { intentKey: string; transition: Exclude<CosTransition, 'claimed'>; writer: 'ownership-machine' | 'holder'; machine: string; at: string; runId?: string; injectId?: string; reason?: string }

export function buildOutcome(o: OutcomeInput): Build {
  return (hlc, origin, observed) => {
    if (!isShortText(o.intentKey, 300) || o.transition === ('claimed' as string)) return null;
    return envelope(deriveOutcomeKey(o.intentKey, o.transition), hlc, origin, observed, 'put', { recordType: 'outcome', ...o });
  };
}

export interface RenewalInput { renewedAt: string; renewedVia: 'telegram' | 'app' | 'console'; principal: string; eventRef?: string; machine: string; machineSignature: string }

export function buildRenewal(r: RenewalInput): Build {
  return (hlc, origin, observed) => envelope(`renewal:${hlcKey(hlc)}`, hlc, origin, observed, 'put', { recordType: 'renewal', ...r });
}

export function buildGraduation(date: string, metrics: Record<string, unknown>, decision: 'pass' | 'incomplete' | 'fail'): Build {
  return (hlc, origin, observed) => DATE_RE.test(date) ? envelope(`graduation:${date}`, hlc, origin, observed, 'put', { recordType: 'graduation', date, metrics, decision }) : null;
}

/** One record per send; `nonce` makes two sends in the same millisecond two records (the caller passes the same key to the emitter). */
export function noteRecordKey(n: { machine: string; at: string; kind: 'note' | 'immediate'; nonce: string }): string { return `note:${n.kind}:${n.at}:${n.machine}:${n.nonce}`; }
export function buildNoteSent(n: { machine: string; at: string; kind: 'note' | 'immediate'; itemKeys: string[]; nonce: string }): Build {
  const { nonce, ...rec } = n;
  return (hlc, origin, observed) => isMachine(n.machine) ? envelope(noteRecordKey({ ...n, nonce }), hlc, origin, observed, 'put', { recordType: 'note', ...rec }) : null;
}

export interface NoteState { lastNoteAt: string | null; immediatesLast24h: number }
/** CMT-1416: the note cadence and the immediate cap, derived from `note` records (never process memory). */
export function foldNoteState(entries: UnionEntry[], now: Date): NoteState {
  let lastNoteAt: string | null = null; let immediates = 0;
  const dayAgo = now.getTime() - 24 * 3_600_000;
  for (const [, w] of latestPerKey(entries)) {
    if (w.data.recordType !== 'note' || !isIso(w.data.at)) continue;
    const at = w.data.at as string;
    if (w.data.kind === 'note') { if (!lastNoteAt || at > lastNoteAt) lastNoteAt = at; }
    else if (w.data.kind === 'immediate' && Date.parse(at) > dayAgo) immediates++;
  }
  return { lastNoteAt, immediatesLast24h: immediates };
}

/** Trailing `unknown` verdicts for one conversation (newest backwards), for the "can't see" line derived at note time. */
export function trailingUnknownChecks(entries: UnionEntry[], conversationKey: string): number {
  const checks: Array<{ at: string; verdict: string }> = [];
  for (const [, w] of latestPerKey(entries)) if (w.data.recordType === 'check-event' && w.data.conversationKey === conversationKey && isIso(w.data.at)) checks.push({ at: w.data.at as string, verdict: String(w.data.verdict) });
  checks.sort((a, b) => b.at.localeCompare(a.at));
  let n = 0; for (const c of checks) { if (c.verdict === 'unknown') n++; else break; }
  return n;
}

export function buildLastTick(machine: string, tickAt: string): Build {
  return (hlc, origin, observed) => isMachine(machine) ? envelope(`last-tick:${machine}`, hlc, origin, observed, 'put', { recordType: 'last-tick', machine, tickAt }) : null;
}

// ── folds (pure; input = already-envelope-validated records from the union) ──

export interface UnionEntry { data: Record<string, unknown>; origin: string }

function hlcOf(d: Record<string, unknown>): HlcTimestamp | null {
  return isHlc(d.hlc) ? (d.hlc as HlcTimestamp) : null;
}

/** Highest-HLC record per recordKey (put or delete) — the substrate's own merge rule. */
export function latestPerKey(entries: UnionEntry[]): Map<string, { data: Record<string, unknown>; origin: string; hlc: HlcTimestamp }> {
  const winner = new Map<string, { data: Record<string, unknown>; origin: string; hlc: HlcTimestamp }>();
  for (const e of entries) {
    const hlc = hlcOf(e.data);
    const key = typeof e.data.recordKey === 'string' ? e.data.recordKey : null;
    if (!hlc || key === null) continue;
    const cur = winner.get(key);
    if (!cur || compareHlc(hlc, cur.hlc) > 0) winner.set(key, { data: e.data, origin: e.origin, hlc });
  }
  return winner;
}

export interface TreeNode { conversationKey: string; parentConversationKey: string | null; role?: 'chief-of-staff' | 'project' | 'sub-topic' }

/** §1.1/§1.4: the parent link per conversation (last-writer by HLC; a tombstone removes the node). */
export function foldTreeState(entries: UnionEntry[]): Map<string, TreeNode> {
  const out = new Map<string, TreeNode>();
  for (const [, w] of latestPerKey(entries)) {
    if (w.data.recordType !== 'tree' || w.data.op === 'delete') continue;
    const ck = w.data.conversationKey; if (typeof ck !== 'string') continue;
    const parent = typeof w.data.parentConversationKey === 'string' ? w.data.parentConversationKey : null;
    const role = w.data.role;
    out.set(ck, { conversationKey: ck, parentConversationKey: parent, ...(role === 'chief-of-staff' || role === 'project' || role === 'sub-topic' ? { role } : {}) });
  }
  return out;
}

export interface BindingState {
  conversationKey: string;
  /** The winning binding record (null when none confirmed). */
  binding: Record<string, unknown> | null;
  bindingHlc: HlcTimestamp | null;
  confirmed: boolean;
  /** Derived from the newest VALID lifecycle event. */
  closed: boolean;
  /** A breaker/attempt park is cleared ONLY by an owner `unpark` (§2.7); this is the `at` of the newest valid unpark. */
  lastUnparkAt: string | null;
  /** The owner's pause (spec cos-owner-pause-record): the newest owner pause/resume tap wins; null when not paused. */
  pausedBy: OwnerPauseRecord | null;
  /** The owner's checks on judgment done items (work-door-project-rows §3.3): item id → when and who; only checks whose
   *  goal + item still match, made after the newest owner reopen. */
  ownerChecks: Record<string, { at: string; who: string }>;
  /** The newest "Ask for an update" queued for this project (work-door-project-rows §3.2); null when none. */
  lastCheckRequestAt: string | null;
  /** That request's record HLC: compared with the last check-event's HLC, never two machines' wall clocks. */
  lastCheckRequestHlc: HlcTimestamp | null;
  /** The newest owner pause / resume decision's `at` (a Telegram ask older than it no longer applies). */
  lastOwnerDecisionAt: string | null;
}

/**
 * Open/closed per conversation (§1.2): newest lifecycle event wins, but a `closed` event is
 * valid only when its `bindingHlc` equals the winning binding's HLC (a closure verified
 * against an older checklist never overrides a concurrent owner edit), and `reopened` /
 * `unpark` are valid only when written by an owner tap (the CoS never reopens or unparks).
 */
export function foldBindingState(entries: UnionEntry[]): Map<string, BindingState> {
  const latest = latestPerKey(entries);
  const out = new Map<string, BindingState>();
  for (const [key, w] of latest) {
    if (w.data.recordType !== 'binding' || !key.startsWith('binding:')) continue;
    const ck = w.data.conversationKey as string;
    out.set(ck, { conversationKey: ck, binding: w.data, bindingHlc: w.hlc, confirmed: w.data.confirmedBy === 'owner', closed: false, lastUnparkAt: null, pausedBy: null, ownerChecks: {}, lastCheckRequestAt: null, lastCheckRequestHlc: null, lastOwnerDecisionAt: null });
  }
  // Lifecycle events are immutable (unique keys), so read them all, not just the latest per key.
  const byConv = new Map<string, Array<{ data: Record<string, unknown>; hlc: HlcTimestamp }>>();
  for (const e of entries) {
    if (e.data.recordType !== 'binding-lifecycle') continue;
    const hlc = hlcOf(e.data); const ck = e.data.conversationKey;
    if (!hlc || typeof ck !== 'string') continue;
    (byConv.get(ck) ?? byConv.set(ck, []).get(ck)!).push({ data: e.data, hlc });
  }
  for (const [ck, events] of byConv) {
    const st = out.get(ck);
    if (!st || !st.bindingHlc) continue;
    events.sort((a, b) => compareHlc(a.hlc, b.hlc));
    // Owner pause / resume (spec cos-owner-pause-record §3.1): the newest owner tap wins, by record HLC like every
    // lifecycle event here. Never written by the Chief of Staff; the validator already refuses that.
    // One ask decides once: a second event carrying an askId already seen (a crash between write and ask-delete,
    // or a redelivered callback) is ignored, so it can never re-pause over a later resume.
    const seenAsks = new Set<string>();
    for (const ev of events) {
      const d = ev.data;
      if ((d.event !== 'owner-pause' && d.event !== 'owner-resume') || d.by !== 'owner-tap') continue;
      if (typeof d.askId !== 'string' || seenAsks.has(d.askId)) continue;
      seenAsks.add(d.askId);
      if (isIso(d.at) && (!st.lastOwnerDecisionAt || (d.at as string) > st.lastOwnerDecisionAt)) st.lastOwnerDecisionAt = d.at as string;
      if (d.event === 'owner-resume') { st.pausedBy = null; continue; }
      if (isIso(d.at) && typeof d.who === 'string' && typeof d.quote === 'string' && typeof d.messageRef === 'string') st.pausedBy = { who: d.who, at: d.at, quote: d.quote, messageRef: d.messageRef };
    }
    // Owner item checks (work-door-project-rows §3.3): per item the newest event by record HLC wins; an event counts
    // only while the CURRENT goal and item text give its checkRef (changing either voids it); an askId decides once.
    const goal = String(st.binding?.goal ?? '');
    const items = Array.isArray(st.binding?.doneDefinition) ? st.binding!.doneDefinition as Array<Record<string, unknown>> : [];
    const idCount = new Map<string, number>();
    for (const it of items) if (it && typeof it.id === 'string') idCount.set(it.id, (idCount.get(it.id) ?? 0) + 1);
    const refs = new Map<string, string>();
    // An id used twice cannot be checked on its own (the fold could not tell the two items apart).
    for (const it of items) if (it && typeof it.id === 'string' && it.kind === 'judgment' && idCount.get(it.id) === 1) refs.set(it.id, doneItemCheckRef(goal, it.id, String(it.text ?? '')));
    // A reopen starts the judgments afresh: only checks newer than the newest owner reopen count.
    let reopenedHlc: HlcTimestamp | null = null;
    for (const ev of events) if (ev.data.event === 'reopened' && ev.data.by === 'owner-tap') reopenedHlc = ev.hlc;
    const seenItemAsks = new Set<string>();
    const newestItem = new Map<string, Record<string, unknown>>();
    for (const ev of events) {
      const d = ev.data;
      if (d.event === 'check-requested' && (d.by === 'owner-tap' || d.by === 'chief-of-staff') && isIso(d.at)) {
        if (!st.lastCheckRequestHlc || compareHlc(ev.hlc, st.lastCheckRequestHlc) > 0) { st.lastCheckRequestHlc = ev.hlc; st.lastCheckRequestAt = d.at as string; }
        continue;
      }
      if (d.event !== 'owner-item-check' || d.by !== 'owner-tap' || typeof d.itemId !== 'string' || typeof d.itemChecked !== 'boolean') continue;
      if (reopenedHlc && compareHlc(ev.hlc, reopenedHlc) < 0) continue;
      if (typeof d.askId !== 'string' || seenItemAsks.has(d.askId)) continue;
      seenItemAsks.add(d.askId);
      // Newest per item FIRST (whatever content it was made on), then it counts only if made on the current content:
      // an uncheck under other wording is never skipped, so a withdrawn check cannot come back after a revert.
      newestItem.set(d.itemId, d);
    }
    for (const [itemId, d] of newestItem) {
      if (!d.itemChecked || refs.get(itemId) !== d.checkRef || !isIso(d.at)) continue;
      st.ownerChecks[itemId] = { at: d.at as string, who: typeof d.who === 'string' ? d.who : 'owner' };
    }
    for (const ev of events) {
      const valid =
        (ev.data.event === 'closed' && isHlc(ev.data.bindingHlc) && compareHlc(ev.data.bindingHlc as HlcTimestamp, st.bindingHlc) === 0) ||
        ((ev.data.event === 'reopened' || ev.data.event === 'unpark') && ev.data.by === 'owner-tap');
      if (!valid) continue;
      if (ev.data.event === 'closed') st.closed = true;
      else if (ev.data.event === 'reopened') st.closed = false;
      else if (ev.data.event === 'unpark' && isIso(ev.data.at) && (!st.lastUnparkAt || (ev.data.at as string) > st.lastUnparkAt)) st.lastUnparkAt = ev.data.at as string;
    }
  }
  return out;
}

/**
 * Lifecycle events this build does not know, counted by name (spec cos-owner-pause-record, Multi-machine posture;
 * maintainer approval condition). The validator keeps them and every fold ignores them, so this count is what makes
 * an older machine skipping a newer machine's events visible instead of silent. Surfaced in the loop's status.
 */
export function unknownLifecycleEvents(entries: UnionEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    const d = e.data;
    if (d.recordType !== 'binding-lifecycle' || typeof d.event !== 'string') continue;
    if ((COS_LIFECYCLE_EVENTS as ReadonlyArray<string>).includes(d.event)) continue;
    out[d.event] = (out[d.event] ?? 0) + 1;
  }
  return out;
}

/** The owner pause/resume event already written for an ask, if any (tap idempotency, spec cos-owner-pause-record §3.2). */
export function ownerPauseEventForAsk(entries: UnionEntry[], askId: string): 'owner-pause' | 'owner-resume' | null {
  for (const e of entries) {
    const d = e.data;
    if (d.recordType === 'binding-lifecycle' && d.askId === askId && (d.event === 'owner-pause' || d.event === 'owner-resume')) return d.event;
  }
  return null;
}

export interface IntentState {
  intentKey: string;
  conversationKey: string;
  action: CosAction;
  leaseEpoch: number;
  sequence: number;
  intentHlc: HlcTimestamp;
  /** The furthest LEGAL transition reached along a legal chain from `claimed`. */
  state: CosTransition;
  runId?: string;
  injectId?: string;
  /** True when no terminal/settling transition exists: the intent still BLOCKS other producers (§2.4). */
  open: boolean;
}

const SETTLED: ReadonlySet<CosTransition> = new Set<CosTransition>(['started', 'superseded', 'rejected', 'lost', 'aborted']);

/**
 * Per-intent derived state (§1.2): walk the recorded transitions in rank order and accept
 * each only if it is a legal move from the current state AND written by the role allowed to
 * write it (`lost` only by the holder, only after `rejected`; everything else only by the
 * ownership machine). Illegal or wrong-writer transitions are ignored, so write ORDER cannot
 * change the terminal state, and two machines' streams fold identically in any order.
 */
export function foldIntentState(entries: UnionEntry[]): Map<string, IntentState> {
  const latest = latestPerKey(entries);
  const intents = new Map<string, IntentState>();
  for (const [key, w] of latest) {
    if (w.data.recordType !== 'intent') continue;
    intents.set(key, {
      intentKey: key, conversationKey: w.data.conversationKey as string, action: w.data.action as CosAction,
      leaseEpoch: w.data.leaseEpoch as number, sequence: w.data.sequence as number, intentHlc: w.hlc, state: 'claimed', open: true,
    });
  }
  const outcomes = new Map<string, Array<Record<string, unknown>>>();
  for (const [, w] of latest) {
    if (w.data.recordType !== 'outcome') continue;
    const ik = w.data.intentKey as string;
    (outcomes.get(ik) ?? outcomes.set(ik, []).get(ik)!).push(w.data);
  }
  for (const [ik, st] of intents) {
    const list = (outcomes.get(ik) ?? []).slice().sort((a, b) => TRANSITION_RANK[a.transition as CosTransition] - TRANSITION_RANK[b.transition as CosTransition]);
    // Apply in rank order; a transition is accepted only when legal from the current state.
    // Because `lost` requires `rejected` first, and `rejected`/`superseded` require the right
    // predecessor, the rank walk reproduces the only legal chain the records support.
    let progressed = true;
    const pending = new Set(list);
    while (progressed) {
      progressed = false;
      for (const o of Array.from(pending)) {
        const to = o.transition as CosTransition;
        const writerOk = COS_TRANSITION_WRITER[to as Exclude<CosTransition, 'claimed'>] === o.writer;
        if (!writerOk) { pending.delete(o); continue; }
        if (isLegalTransition(st.state, to)) {
          st.state = to;
          if (typeof o.runId === 'string') st.runId = o.runId;
          if (typeof o.injectId === 'string') st.injectId = o.injectId;
          pending.delete(o);
          progressed = true;
        }
      }
    }
    st.open = !SETTLED.has(st.state);
  }
  return intents;
}

export interface CheckStateConfig {
  checkCadenceHours: number;
  maxRestartsWithoutProgress: number;
  breakerRestartsPerWeek: number;
  /** Deterministic jitter seed (0..1) applied as ±10% to the cadence. */
  jitter?: number;
}

export interface ProjectCheckState {
  conversationKey: string;
  lastCheckAt: string | null;
  lastVerdict: CosVerdict | null;
  lastEvidenceHash: string | null;
  lastProgressAt: string | null;
  netDiffHighWater: number;
  /** Restart/redirect attempts (started | lost) since the last progress. */
  restartsWithoutProgress: number;
  /** Attempts in the rolling 7-day window ending at `now`, regardless of progress. */
  restartsInWindow: number;
  parked: boolean;
  breakerTripped: boolean;
  nextCheckAt: string | null;
  nextActionAllowedAt: string | null;
  /** Done-item results recorded on the newest check (the durable progress baseline); null when the newest check carried none. */
  lastDoneItems: Record<string, 'pass' | 'fail' | 'unknown'> | null;
  /** The newest check-event's record HLC (null when none or unreadable). */
  lastCheckHlc: HlcTimestamp | null;
}

const ACTION_ATTEMPT_ACTIONS: ReadonlySet<CosAction> = new Set<CosAction>(['restart-inject', 'restart-run', 'redirect']);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * §2.3/§2.7 derived check state for one conversation. An "attempt" is an intent for a
 * restart or redirect whose derived state is `started` or `lost`. A progress check-event
 * resets `restartsWithoutProgress`; activity never does. A park (attempts without progress
 * ≥ max) is cleared by progress or an owner unpark; the breaker (attempts in a rolling 7 days
 * > breakerRestartsPerWeek, progress or not) is cleared ONLY by an owner unpark newer than the
 * attempts that tripped it. `nextActionAllowedAt` doubles with each attempt without progress
 * and is independent of `nextCheckAt`, so a dirty event can bring a CHECK forward but never
 * an ACTION.
 */
export function foldProjectCheckState(entries: UnionEntry[], conversationKey: string, cfg: CheckStateConfig, now: Date, bindingState?: BindingState): ProjectCheckState {
  const checks: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    if (e.data.recordType === 'check-event' && e.data.conversationKey === conversationKey && isIso(e.data.at)) checks.push(e.data);
  }
  checks.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const intents = foldIntentState(entries);
  const attempts: Array<{ at: string; hlc: HlcTimestamp }> = [];
  for (const st of intents.values()) {
    if (st.conversationKey !== conversationKey || !ACTION_ATTEMPT_ACTIONS.has(st.action)) continue;
    if (st.state === 'started' || st.state === 'lost') {
      const claim = latestPerKey(entries).get(st.intentKey);
      const at = claim && isIso(claim.data.claimedAt) ? (claim.data.claimedAt as string) : new Date(st.intentHlc.physical).toISOString();
      attempts.push({ at, hlc: st.intentHlc });
    }
  }
  attempts.sort((a, b) => a.at.localeCompare(b.at));

  const last = checks.length ? checks[checks.length - 1] : null;
  let lastProgressAt: string | null = null;
  let highWater = 0;
  for (const c of checks) {
    if (c.progressSeen === true) lastProgressAt = c.at as string;
    if (typeof c.netDiffHighWater === 'number') highWater = Math.max(highWater, c.netDiffHighWater);
  }
  const unparkAt = bindingState?.lastUnparkAt ?? null;
  const sinceProgress = attempts.filter((a) => (!lastProgressAt || a.at > lastProgressAt) && (!unparkAt || a.at > unparkAt));
  const nowMs = now.getTime();
  const inWindow = attempts.filter((a) => nowMs - Date.parse(a.at) <= WEEK_MS && (!unparkAt || a.at > unparkAt));
  const restartsWithoutProgress = sinceProgress.length;
  const breakerTripped = inWindow.length > cfg.breakerRestartsPerWeek;
  const parked = breakerTripped || restartsWithoutProgress >= cfg.maxRestartsWithoutProgress;

  const cadenceMs = cfg.checkCadenceHours * 3_600_000;
  const jitter = cfg.jitter === undefined ? 0 : (Math.min(1, Math.max(0, cfg.jitter)) - 0.5) * 0.2; // ±10%
  const nextCheckAt = last ? new Date(Date.parse(last.at as string) + cadenceMs * (1 + jitter)).toISOString() : null;
  const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;
  const backoffMs = lastAttempt ? cadenceMs * Math.pow(2, Math.max(0, restartsWithoutProgress - 1)) : 0;
  const nextActionAllowedAt = lastAttempt ? new Date(Date.parse(lastAttempt.at) + backoffMs).toISOString() : null;

  return {
    conversationKey,
    lastCheckAt: last ? (last.at as string) : null,
    lastVerdict: last ? (last.verdict as CosVerdict) : null,
    lastEvidenceHash: last ? (last.evidenceHash as string) : null,
    lastProgressAt,
    netDiffHighWater: highWater,
    restartsWithoutProgress,
    restartsInWindow: inWindow.length,
    parked,
    breakerTripped,
    nextCheckAt,
    nextActionAllowedAt,
    lastDoneItems: last && last.doneItems && typeof last.doneItems === 'object' ? (last.doneItems as Record<string, 'pass' | 'fail' | 'unknown'>) : null,
    lastCheckHlc: last ? hlcOf(last) : null,
  };
}

export interface LeaseState {
  /** Latest signature-valid renewal, or null. */
  renewedAt: string | null;
  expiresAt: string | null;
  live: boolean;
  /** Renewals ignored because their signature did not verify or their time was implausible. */
  ignored: number;
}

/**
 * §1.2/§4 derived operator lease: `expiresAt = max(renewedAt of signature-valid renewals)
 * + operatorLeaseHours`. No stored expiry is ever trusted; no renewals, an unverifiable
 * signature, or a `renewedAt` further in the future than `clockToleranceMs` resolves to
 * EXPIRED (paused), never live.
 */
export function deriveLeaseExpiry(
  entries: UnionEntry[],
  verifySignature: (renewal: Record<string, unknown>) => boolean,
  operatorLeaseHours: number,
  now: Date,
  clockToleranceMs = 2 * 60 * 60 * 1000,
): LeaseState {
  let best: string | null = null;
  let ignored = 0;
  const nowMs = now.getTime();
  for (const e of entries) {
    const d = e.data;
    if (d.recordType !== 'renewal' || !isIso(d.renewedAt)) continue;
    const t = Date.parse(d.renewedAt as string);
    if (t - nowMs > clockToleranceMs) { ignored++; continue; }
    let ok = false;
    try { ok = verifySignature(d) === true; } catch { ok = false; }
    if (!ok) { ignored++; continue; }
    if (best === null || t > Date.parse(best)) best = d.renewedAt as string;
  }
  if (best === null) return { renewedAt: null, expiresAt: null, live: false, ignored };
  const expiresAt = new Date(Date.parse(best) + operatorLeaseHours * 3_600_000).toISOString();
  return { renewedAt: best, expiresAt, live: Date.parse(expiresAt) > nowMs, ignored };
}

/** Per-machine last-tick markers (the §2.9 liveness input; classification happens on the
 *  poller's LOCAL monotonic receipt time, never on these wall-clock values). */
export function foldLastTicks(entries: UnionEntry[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, w] of latestPerKey(entries)) {
    if (w.data.recordType === 'last-tick' && isMachine(w.data.machine) && isIso(w.data.tickAt)) out.set(w.data.machine as string, w.data.tickAt as string);
  }
  return out;
}
