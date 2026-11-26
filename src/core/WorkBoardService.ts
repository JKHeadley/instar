/**
 * WorkBoardService — the Work Board's one in-memory index and its write rules
 * (docs/specs/work-board-asks.md §3–§5, Fixed limits).
 *
 * The index (card id → folded card, its lanes inputs, its pickups) is built at boot from the
 * whole stream (live file and every archive) and updated on each local write and each
 * replicated apply. Every read is served from it; no request folds the journal.
 *
 * Writes: the route decides WHO the caller is from how the request authenticated and passes a
 * `WorkPrincipal`; this module decides WHAT that principal may write, enforces the owner-set
 * limits and the credential check, compares an edit with the folded value so only changed
 * fields are recorded, and refuses with the spec's named reasons. Node runs one request
 * handler at a time and every write here is synchronous up to the emit, so the read-then-append
 * of one call is atomic per card without an explicit lock (the spec's "per-card lock").
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  WorkBoardApprovalWriter, approvalEventId, decodeWorkBoardApprovalEvent, sameProof, sameVersion,
  type WorkBoardApprovalEvent, type WorkBoardApprovalRequest, type WorkBoardApprovalResult,
  type WorkBoardApprovalVersion, type WorkBoardApprovalWriterPorts,
} from './WorkBoardApprovalWriter.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import {
  buildRecord, toFoldRecords, partitionRecords, foldCard, deriveStatus, laneFor, derivePickupCauses, foldPickups,
  materialHashOf, canonicalJson, cardConversationKey, sameValue, sha256Hex, isCardId, isRecordId, mintRecordKey, isRestrictingTap, foldOrder, compareHlc, workCardRecordStoreSchema,
  normalizeRequestText, isAgentInternalCard,
  MATERIAL_FIELDS, WORK_BOARD_STORE_KEY, CLOSE_AS, SCHEMA_MAX, GATE_ONLY_FIELDS, MAX_REFS, NOTE_EVENT_PREFIX,
  type UnionEntry, type FoldRecord, type CardFold, type CardStatus, type Lane, type PickupState, type TapAction,
  type WorkRecordType, type SystemRecordType, type By, type ApprovalPolicy, type DoneWhenItem, type CardLink, type Carrier, type Principal, type CardRef, type HoldLiftReason,
} from './WorkCardStore.js';

export interface WorkBoardLimits { recordBytes: number; title: number; need: number; recommendation: number; doneItemText: number; optionText: number; /** agent-work-cards-default §2: a progress note's text ceiling (owner-set, hard-capped by `SCHEMA_MAX.noteText`). */ noteText: number }
export interface WorkBoardPickupSettings { tickSeconds: number; freeCheckMinSeconds: number; freeCheckMaxSeconds: number; maxSpendingAttempts: number; surfaceAfterHours: number; ownerCatchUpSeconds: number }
/** agent-work-cards-default §3/§Migration: the request-to-card gate and sweep. `enabled` omitted ⇒ on where the board is on. */
export interface WorkBoardRequestCardSettings { enabled: boolean; duplicateHintHours: number; backfillMaxAgeDays: number; sweepPerTick: number; unrecordedWorkMinutes: number; floorRecentHours: number }
export interface WorkBoardSettings {
  softOpenCards: number; maxAgentCardsPerDay: number; quietAfterHours: number; limits: WorkBoardLimits; pickup: WorkBoardPickupSettings;
  requestCards: WorkBoardRequestCardSettings;
  /** §2 "Note rate and the drain set". */
  maxNotesPerCardPerDay: number; noteCoalesceMinutes: number; noteDrainPerTick: number;
  /** §9 (slice 2/3 reads them; owner-set now so the settings surface is complete). */
  softOpenBlockers: number; maxOpenAsksPerCard: number;
}

/** The replicated journal's per-kind rate bucket (`takeToken`: capacity 100): the sweep and the note drain together never exceed it. */
export const JOURNAL_BUCKET_CAPACITY = 100;

export const DEFAULT_WORK_BOARD_SETTINGS: WorkBoardSettings = Object.freeze({
  softOpenCards: 30, maxAgentCardsPerDay: 200, quietAfterHours: 24,
  limits: Object.freeze({ recordBytes: 32768, title: 300, need: 4000, recommendation: 2000, doneItemText: 500, optionText: 200, noteText: 4000 }),
  pickup: Object.freeze({ tickSeconds: 60, freeCheckMinSeconds: 60, freeCheckMaxSeconds: 1800, maxSpendingAttempts: 3, surfaceAfterHours: 24, ownerCatchUpSeconds: 600 }),
  requestCards: Object.freeze({ enabled: true, duplicateHintHours: 24, backfillMaxAgeDays: 14, sweepPerTick: 25, unrecordedWorkMinutes: 10, floorRecentHours: 72 }),
  maxNotesPerCardPerDay: 50, noteCoalesceMinutes: 60, noteDrainPerTick: 25,
  softOpenBlockers: 10, maxOpenAsksPerCard: 5,
}) as WorkBoardSettings;

/** Merge a partial config block over the defaults, keeping only positive whole numbers. */
export function resolveWorkBoardSettings(raw: unknown): WorkBoardSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pos = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : d);
  const lim = (r.limits && typeof r.limits === 'object' ? r.limits : {}) as Record<string, unknown>;
  const pk = (r.pickup && typeof r.pickup === 'object' ? r.pickup : {}) as Record<string, unknown>;
  const rc = (r.requestCards && typeof r.requestCards === 'object' ? r.requestCards : {}) as Record<string, unknown>;
  const D = DEFAULT_WORK_BOARD_SETTINGS;
  // The sweep and the drain share one journal bucket: clamp their sum to its capacity, sweep first (Fixed limits).
  let sweep = pos(rc.sweepPerTick, D.requestCards.sweepPerTick);
  let drain = pos(r.noteDrainPerTick, D.noteDrainPerTick);
  if (sweep + drain > JOURNAL_BUCKET_CAPACITY) { sweep = Math.min(sweep, JOURNAL_BUCKET_CAPACITY - 1); drain = Math.max(1, JOURNAL_BUCKET_CAPACITY - sweep); }
  return {
    softOpenCards: pos(r.softOpenCards, D.softOpenCards), maxAgentCardsPerDay: pos(r.maxAgentCardsPerDay, D.maxAgentCardsPerDay), quietAfterHours: pos(r.quietAfterHours, D.quietAfterHours),
    limits: {
      recordBytes: pos(lim.recordBytes, D.limits.recordBytes), title: pos(lim.title, D.limits.title), need: pos(lim.need, D.limits.need),
      recommendation: pos(lim.recommendation, D.limits.recommendation), doneItemText: pos(lim.doneItemText, D.limits.doneItemText), optionText: pos(lim.optionText, D.limits.optionText),
      // A maximal note is valid on every replica: the owner may raise it only to the hard ceiling.
      noteText: Math.min(SCHEMA_MAX.noteText, pos(lim.noteText, D.limits.noteText)),
    },
    pickup: {
      tickSeconds: pos(pk.tickSeconds, D.pickup.tickSeconds), freeCheckMinSeconds: Math.max(60, pos(pk.freeCheckMinSeconds, D.pickup.freeCheckMinSeconds)),
      freeCheckMaxSeconds: pos(pk.freeCheckMaxSeconds, D.pickup.freeCheckMaxSeconds), maxSpendingAttempts: Math.max(1, pos(pk.maxSpendingAttempts, D.pickup.maxSpendingAttempts)),
      surfaceAfterHours: pos(pk.surfaceAfterHours, D.pickup.surfaceAfterHours), ownerCatchUpSeconds: pos(pk.ownerCatchUpSeconds, D.pickup.ownerCatchUpSeconds),
    },
    requestCards: {
      enabled: rc.enabled !== false, duplicateHintHours: pos(rc.duplicateHintHours, D.requestCards.duplicateHintHours), backfillMaxAgeDays: pos(rc.backfillMaxAgeDays, D.requestCards.backfillMaxAgeDays),
      sweepPerTick: sweep, unrecordedWorkMinutes: pos(rc.unrecordedWorkMinutes, D.requestCards.unrecordedWorkMinutes), floorRecentHours: pos(rc.floorRecentHours, D.requestCards.floorRecentHours),
    },
    maxNotesPerCardPerDay: pos(r.maxNotesPerCardPerDay, D.maxNotesPerCardPerDay), noteCoalesceMinutes: Math.max(1, pos(r.noteCoalesceMinutes, D.noteCoalesceMinutes)), noteDrainPerTick: drain,
    softOpenBlockers: pos(r.softOpenBlockers, D.softOpenBlockers), maxOpenAsksPerCard: pos(r.maxOpenAsksPerCard, D.maxOpenAsksPerCard),
  };
}

const SETTING_GROUPS: ReadonlySet<string> = new Set(['limits', 'pickup', 'requestCards']);
const SETTING_NAMES: ReadonlySet<string> = new Set([
  'softOpenCards', 'maxAgentCardsPerDay', 'quietAfterHours', 'maxNotesPerCardPerDay', 'noteCoalesceMinutes', 'noteDrainPerTick', 'softOpenBlockers', 'maxOpenAsksPerCard',
  ...Object.keys(DEFAULT_WORK_BOARD_SETTINGS.limits).map((k) => `limits.${k}`),
  ...Object.keys(DEFAULT_WORK_BOARD_SETTINGS.pickup).map((k) => `pickup.${k}`),
  ...Object.keys(DEFAULT_WORK_BOARD_SETTINGS.requestCards).map((k) => `requestCards.${k}`),
]);
/** The one boolean setting; every other setting is a positive whole number. */
const BOOLEAN_SETTINGS: ReadonlySet<string> = new Set(['requestCards.enabled']);

/**
 * Validate a settings change from the Work page (§7: positive whole numbers; a free-check delay
 * below 60 seconds and a spending-attempt cap below 1 are refused). Returns the field at fault.
 */
export function validateSettingsPatch(patch: unknown): { ok: true } | { ok: false; field: string } {
  if (!patch || typeof patch !== 'object') return { ok: false, field: 'body' };
  const walk = (o: Record<string, unknown>, prefix: string): string | null => {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'policy') continue;
      const name = prefix ? `${prefix}.${k}` : k;
      // Only a known setting is stored: a mistyped name is refused, never saved beside the real one.
      if (!SETTING_NAMES.has(name) && !SETTING_GROUPS.has(name)) return name;
      if (v && typeof v === 'object' && !Array.isArray(v)) { const bad = walk(v as Record<string, unknown>, name); if (bad) return bad; continue; }
      if (BOOLEAN_SETTINGS.has(name)) { if (typeof v !== 'boolean') return name; continue; }
      if (!(typeof v === 'number' && Number.isInteger(v) && v > 0)) return name;
      if (name === 'pickup.freeCheckMinSeconds' && v < 60) return name;
      if (name === 'limits.noteText' && v > SCHEMA_MAX.noteText) return name;
    }
    return null;
  };
  const bad = walk(patch as Record<string, unknown>, '');
  return bad ? { ok: false, field: bad } : { ok: true };
}

export type WorkPrincipal =
  /** `server`: the server's own in-process writer of server-owned cards (Chief of Staff wait cards). No route builds it. */
  | { kind: 'agent'; server?: true }
  | { kind: 'session'; conversationKey: string }
  | { kind: 'person'; personKey: string; proof: 'pin' | 'presence'; isOwner: boolean };

export interface Refusal { ok: false; status: number; error: string; detail?: Record<string, unknown> }
export type Result<T> = ({ ok: true } & T) | Refusal;

const refuse = (status: number, error: string, detail?: Record<string, unknown>): Refusal => ({ ok: false, status, error, ...(detail ? { detail } : {}) });

export interface WorkBoardDeps {
  machineId: string;
  approvalAuthority?: Pick<WorkBoardApprovalWriterPorts, 'currentWriter' | 'readEvent' | 'awaitDurable'>;
  /** Emit through the replicated-record emitter for store `workBoard`. */
  emit: (recordKey: string, build: ReturnType<typeof buildRecord>) => { outcome: string; seq?: number; hlc?: HlcTimestamp };
  /** Every work-card record this machine holds: own live file + archives, and every peer stream. */
  loadUnion: () => UnionEntry[];
  now: () => number;
  settings: () => WorkBoardSettings;
  /** The team owner's personKey, or null when no team record names one. */
  ownerPersonKey: () => string | null;
  /** Deterministic credential detector (the outbound guard); returns the matched kind or null. */
  detectCredential: (text: string) => string | null;
  /** The agent's configured timezone day for the daily ceiling (YYYY-MM-DD), and when it resets. */
  dayOf: (ms: number) => { day: string; resetsAt: string };
  displayName: (personKey: string) => string;
  /** Called after a local write lands; the pickup controller and transcript writer hook here. */
  onLocalWrite?: (cardId: string, recordType: WorkRecordType, data: Record<string, unknown>) => void;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface CardView {
  card: CardFold;
  status: CardStatus;
  pickups: PickupState[];
  /** True when a pickup is waiting for capacity long enough to surface in "Waiting on you". */
  capacityWaitSurfaced: boolean;
  /** Card was marked uncertain (a dispatching with no close) and has not had a recovery pickup succeed. */
  mayHaveBeenHandedOver: boolean;
}

/** Why the holder did not write a requested card yet (agent-work-cards-default §3): terminal reasons leave the needs-card set; retryable ones stay. */
export const TERMINAL_CARD_REASONS: ReadonlySet<string> = new Set(['not-operator-conversation', 'backfill-skipped-stale', 'card-exists-linked', 'invalid-record', 'over-limit', 'credential-refused', 'done-item-required']);
export const RETRYABLE_CARD_REASONS: ReadonlySet<string> = new Set(['mixed-versions', 'daily-card-ceiling', 'store-unavailable', 'rate-limited', 'crash-before-gate']);

/** Deterministic transcript-line id for a record (so a repeat append is a no-op and a surface can recognise the line). */
export function lineIdFor(recordId: string): string {
  return `wb-${createHash('sha256').update(recordId).digest('hex').slice(0, 24)}`;
}

export function newCardId(): string { return `wc_${randomBytes(8).toString('hex')}`; }

const CREATE_FIELDS = ['title', 'need', 'doneWhen', 'carrier', 'outward', 'links', 'recommendation', 'due', 'projectKey', 'source', 'whyYou', 'covers', 'mirror', 'brief', 'refs', ...GATE_ONLY_FIELDS] as const;
const EDIT_FIELDS = ['title', 'need', 'doneWhen', 'carrier', 'outward', 'links', 'recommendation', 'due', 'projectKey', 'whyYou', 'covers', 'mirror', 'brief', 'refs'] as const;

/** An agent-work card (agent-work-cards-default §1) as the WRITE sees it: agent-carried, inward, no recommendation, no owner-confirms item. */
export function isAgentWorkInput(fields: Record<string, unknown>): boolean {
  if (fields.outward === true) return false;
  if (fields.carrier !== undefined && fields.carrier !== 'agent') return false;
  if (Array.isArray(fields.doneWhen) && (fields.doneWhen as Array<Record<string, unknown>>).some((d) => d?.certify !== 'agent-may-certify')) return false;
  return true;
}

/**
 * The Needs-you item keys a card may say it is about (work-board-cards-appear §3): sources whose keys are
 * stable item ids and whose rows carry no credential, money or security state. `cos:` is reserved to the
 * server's own Chief of Staff wait cards. Every other key is refused.
 */
export const COVERABLE_PREFIXES: ReadonlyArray<string> = ['plan:', 'pr:'];
export const SERVER_COVERABLE_PREFIXES: ReadonlyArray<string> = ['cos:waiting:'];
/** A card is server-owned when it covers a `cos:` key: only the in-process server writer writes its records. */
export function isServerOwnedCard(card: { covers?: string[] | null }): boolean {
  return Array.isArray(card.covers) && card.covers.some((k) => k.startsWith('cos:'));
}
const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

function approvalRevision(records: FoldRecord[]): string {
  return sha256Hex(canonicalJson(records.map(({ id, hlc, origin }) => [id, hlc, origin])));
}

export class WorkBoardService {
  private records: FoldRecord[] = [];
  private byCard = new Map<string, FoldRecord[]>();
  private policies: FoldRecord[] = [];
  private views = new Map<string, { card: CardFold; pickups: PickupState[] }>();
  private keys = new Set<string>();
  /** Capacity-wait bookkeeping (in memory on the acting machine, §Multi-machine). */
  readonly capacityWait = new Map<string, { since: number; nextCheckAt: number; delayMs: number; reason: string; checkedAt?: number }>();
  /**
   * agent-work-cards-default §3 "The card index is the truth": `<kind>:<id>` of every `refs` entry → the card whose
   * `refs` names it. Rebuilt with the index; `commitment.cardId` is only a cache of what this says.
   */
  private refIndex = new Map<string, string>();
  /** The index keys each card currently holds, so a refold drops the entries an edit removed. */
  private refsByCard = new Map<string, string[]>();
  /** Counted refusals the graduation record reads (§1: refused agent writes on `not-started` cards). */
  readonly stats = { notStartedRefusals: 0 };

  private readonly approvalWriter?: WorkBoardApprovalWriter;
  private readonly approvalReservations = new Set<string>();

  constructor(private readonly deps: WorkBoardDeps) {
    const authority = deps.approvalAuthority;
    if (authority) {
      this.approvalWriter = new WorkBoardApprovalWriter({
        currentWriter: () => authority.currentWriter(),
        currentEligibleVersion: (cardId) => this.approvalSnapshot(cardId)?.version ?? null,
        readEvent: (eventId) => {
          const result = authority.readEvent(eventId);
          if (result.status === 'durable' && result.event.eventId === eventId) {
            this.approvalReservations.delete(eventId);
          }
          return result.status !== 'durable' && this.approvalReservations.has(eventId)
            ? { status: 'unknown' } : result;
        },
        append: (event) => this.appendBoundApproval(event),
        awaitDurable: (sequence) => authority.awaitDurable(sequence),
      });
    }
  }

  /** Accept a request from an in-process owner authorization adapter. */
  async approveBound(principal: WorkPrincipal, request: WorkBoardApprovalRequest): Promise<WorkBoardApprovalResult> {
    const proof = request.source === 'console' || request.source === 'bulk' ? 'pin' : 'presence';
    if (principal.kind !== 'person' || !principal.isOwner || principal.proof !== proof
      || principal.personKey !== request.proof.ownerPersonKey || principal.personKey !== this.deps.ownerPersonKey()) {
      return { status: 'unavailable' };
    }
    return this.approvalWriter?.approve(request) ?? { status: 'unavailable' };
  }

  private appendBoundApproval({ eventId, request }: WorkBoardApprovalEvent): number | null {
    const { version, proof, source } = request;
    if (!sameProof(proof, this.deps.approvalAuthority?.currentWriter() ?? null)
      || proof.ownerPersonKey !== this.deps.ownerPersonKey()
      || !sameVersion(version, this.approvalSnapshot(version.cardId)?.version ?? null)
      || eventId !== approvalEventId(request)) return null;
    const fields = {
      action: 'approve',
      by: {
        kind: 'person', personKey: proof.ownerPersonKey, isOwner: true,
        proof: source === 'console' || source === 'bulk' ? 'pin' : 'presence',
      },
      at: new Date(this.deps.now()).toISOString(),
      materialHash: version.materialHash, titleHash: version.titleHash, approvalBinding: request,
    };
    if (this.shapeRefusal('tap', version.cardId, fields, eventId)) return null;
    // Reserve before emit. A missing sequence or timeout cannot prove absence.
    if (this.approvalReservations.has(eventId)) return null;
    this.approvalReservations.add(eventId);
    // An enqueued bound approval never takes the legacy immediate projection path.
    const result = this.deps.emit(eventId, buildRecord('tap', version.cardId, fields, eventId));
    return result.outcome === 'emitted' ? result.seq ?? null : null;
  }

  /** Expose only an exact durable approval and only under its current enrolled writer. */
  projectBoundApproval(winner: WorkBoardApprovalEvent, recovering = false): boolean {
    const authority = this.deps.approvalAuthority;
    const { proof, version, decisionId, source } = winner.request;
    const current = () => proof.ownerPersonKey === this.deps.ownerPersonKey()
      && sameProof(proof, authority?.currentWriter() ?? null);
    if (!authority || !current()) return false;
    const durable = authority.readEvent(winner.eventId);
    if (durable.status !== 'durable' || !durable.record) return false;
    const event = decodeWorkBoardApprovalEvent(durable.record);
    if (!event || event.eventId !== winner.eventId || !sameProof(proof, event.request.proof)
      || !sameVersion(version, event.request.version) || decisionId !== event.request.decisionId
      || source !== event.request.source || !current()) return false;
    const existing = this.view(version.cardId)?.card.approvedBy;
    if (existing?.id === winner.eventId) return true;
    if (this.keys.has(winner.eventId)) return false;
    const rows = toFoldRecords([{ data: durable.record, origin: this.deps.machineId }], winner.eventId);
    const record = rows[0];
    if (!record || record.origin !== this.deps.machineId) return false;
    // Refuse an event ordered before an already-observed card or policy mutation.
    const snapshot = this.approvalSnapshot(version.cardId);
    if (!snapshot) return false;
    const history = this.recordsOf(version.cardId);
    const policy = this.policies.at(-1);
    if (policy && compareHlc(record.hlc, policy.hlc) <= 0) return false;
    const later = history.filter((prior) => compareHlc(prior.hlc, record.hlc) >= 0);
    if (later.length) {
      if (!recovering || later.some((row) => compareHlc(row.hlc, record.hlc) === 0
        || (row.d.recordType !== 'dispatching' && row.d.recordType !== 'dispatched'))) return false;
      snapshot.version.cardRevision = approvalRevision(history.filter((prior) => compareHlc(prior.hlc, record.hlc) < 0));
    }
    if (!sameVersion(version, snapshot.version)) return false;
    this.applyFoldRecords(rows);
    if (this.view(version.cardId)?.card.approvedBy?.id !== winner.eventId) return false;
    this.deps.onLocalWrite?.(version.cardId, 'tap', durable.record);
    return true;
  }

  // ── index ────────────────────────────────────────────────────────────────

  rebuild(): void {
    this.records = toFoldRecords(this.deps.loadUnion());
    this.keys = new Set(this.records.map((r) => r.id));
    const { byCard, policies } = partitionRecords(this.records);
    this.byCard = byCard; this.policies = policies;
    this.views.clear();
    this.refIndex.clear(); this.refsByCard.clear();
    for (const id of byCard.keys()) this.refold(id);
  }

  /** Apply committed entries (own or a peer's) to the index. Returns the card ids that changed. */
  apply(entries: UnionEntry[]): string[] {
    return this.applyFoldRecords(toFoldRecords(entries));
  }

  private applyFoldRecords(records: FoldRecord[]): string[] {
    const fresh = records.filter((r) => !this.keys.has(r.id) || this.replaces(r));
    if (!fresh.length) return [];
    const changed = new Set<string>();
    let policyChanged = false;
    for (const r of fresh) {
      if (this.keys.has(r.id)) { this.records = this.records.filter((x) => x.id !== r.id); }
      this.keys.add(r.id);
      this.records.push(r);
      if (r.d.recordType === 'policy') policyChanged = true;
      else if (isCardId(r.d.cardId)) changed.add(r.d.cardId as string);
    }
    this.records.sort(foldOrder); // the ONE order every fold uses
    const { byCard, policies } = partitionRecords(this.records);
    this.byCard = byCard; this.policies = policies;
    const ids = policyChanged ? [...byCard.keys()] : [...changed];
    for (const id of ids) this.refold(id);
    return ids;
  }

  private replaces(r: FoldRecord): boolean {
    const cur = this.records.find((x) => x.id === r.id);
    return !!cur && (r.hlc.physical > cur.hlc.physical || (r.hlc.physical === cur.hlc.physical && r.hlc.logical > cur.hlc.logical));
  }

  private refold(cardId: string): void {
    const recs = this.byCard.get(cardId) ?? [];
    const card = foldCard(cardId, recs, this.policies);
    const causes = derivePickupCauses(cardId, recs, this.policies);
    const pickups = foldPickups(cardId, recs, causes);
    this.views.set(cardId, { card, pickups });
    for (const k of this.refsByCard.get(cardId) ?? []) if (this.refIndex.get(k) === cardId) this.refIndex.delete(k);
    const keys = card.refs.map((r) => `${r.kind}:${r.id}`);
    for (const k of keys) this.refIndex.set(k, cardId);
    this.refsByCard.set(cardId, keys);
  }

  cardIds(): string[] { return [...this.views.keys()]; }
  policy(): ApprovalPolicy { const last = this.policies[this.policies.length - 1]; return last && last.d.policy === 'outward-only' ? 'outward-only' : 'every-agent-card'; }
  recordsOf(cardId: string): FoldRecord[] { return this.byCard.get(cardId) ?? []; }
  policyRecords(): FoldRecord[] { return this.policies; }
  newestHlc(): HlcTimestamp | null { return this.records.length ? this.records[this.records.length - 1].hlc : null; }
  totalRecords(): number { return this.records.length; }

  /** The exact card disclosure and version used by the owner approval writer. */
  approvalSnapshot(cardId: string) {
    const view = this.view(cardId);
    if (!view || (view.status !== 'not-started' && view.status !== 'needs-approval')
      || !view.card.approvalRequired || view.card.approvalValid) return null;
    const c = view.card;
    const disclosure = structuredClone({
      title: c.title, need: c.need, recommendation: c.recommendation, whyYou: c.whyYou,
      doneWhen: c.doneWhen, brief: c.brief, carrier: c.carrier, outward: c.outward,
      links: c.links, due: c.due, projectKey: c.projectKey,
    });
    const version: WorkBoardApprovalVersion = {
      cardId, cardRevision: approvalRevision(this.recordsOf(cardId)), policyRevision: approvalRevision(this.policies),
      visibleTextHash: sha256Hex(canonicalJson(disclosure)), materialHash: c.materialHash, titleHash: sha256Hex(c.title),
    };
    return { version, disclosure };
  }

  /** The card whose `refs` names this reference (agent-work-cards-default §3), or null. */
  cardForRef(kind: CardRef['kind'], id: string): string | null { return this.refIndex.get(`${kind}:${id}`) ?? null; }

  /** The gate's first-run record for a team (§3 "The first run"), or null before the first pass. */
  enabledAt(teamKey: string): { at: string; id: string } | null {
    const key = mintRecordKey('enabled-at', null, { teamKey });
    const r = this.records.find((x) => x.id === key && x.d.recordType === 'enabled-at');
    return r ? { at: String(r.d.at), id: r.id } : null;
  }

  /** Every `not-started` card (§1 "One aggregated row, not zero"), oldest first. */
  notStartedCardIds(): string[] {
    const out: Array<{ id: string; at: string }> = [];
    for (const id of this.views.keys()) { const v = this.view(id); if (v && v.status === 'not-started') out.push({ id, at: v.card.createdAt ?? '' }); }
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1)).map((x) => x.id);
  }

  /**
   * Duplicate HINT (§3, never a merge): another open card in the same source conversation with the same verified
   * message id, or (absent one) the same normalised title within `requestCards.duplicateHintHours`.
   */
  possibleDuplicateOf(cardId: string): string[] {
    const me = this.views.get(cardId)?.card; if (!me || !me.source) return [];
    const hours = this.deps.settings().requestCards.duplicateHintHours * 3_600_000;
    const myAt = me.createdAt ? Date.parse(me.createdAt) : NaN;
    const out: string[] = [];
    for (const [id, v] of this.views) {
      if (id === cardId) continue;
      const c = v.card;
      if (!c.created || c.redacted || c.archives.length || c.done || !c.source || c.source.conversationKey !== me.source.conversationKey) continue;
      if (c.source.messageId === me.source.messageId) { out.push(id); continue; }
      const at = c.createdAt ? Date.parse(c.createdAt) : NaN;
      if (Number.isFinite(myAt) && Number.isFinite(at) && Math.abs(myAt - at) <= hours && normalizeRequestText(c.title) === normalizeRequestText(me.title)) out.push(id);
    }
    return out.sort();
  }

  view(cardId: string): CardView | null {
    const v = this.views.get(cardId);
    if (!v) return null;
    const s = this.deps.settings();
    const now = this.deps.now();
    const active = v.pickups.filter((p) => p.status === 'pending' || p.status === 'parked');
    const parked = active.some((p) => p.status === 'parked');
    // The churn brake's park on a quiet re-pickup is what derives `quiet` (agent-work-cards-default §3).
    const quietParked = active.some((p) => p.status === 'parked' && p.cause.repickup === true && /^decision:agent-churn/.test(p.closedReason ?? ''));
    const status = deriveStatus(v.card, { pendingOrParked: active.length > 0, parked, quietParked }, now, s.quietAfterHours);
    const wait = active.map((p) => this.capacityWait.get(p.cause.id)).filter(Boolean) as Array<{ since: number }>;
    const capacityWaitSurfaced = wait.some((w) => now - w.since > s.pickup.surfaceAfterHours * 3_600_000);
    return { card: v.card, status, pickups: v.pickups, capacityWaitSurfaced, mayHaveBeenHandedOver: this.uncertainHandOver(cardId) };
  }

  /** The ids of the transcript lines the board wrote for a card (a surface styles a line as a card event only when its id is here, §2). */
  lineIds(cardId: string): string[] {
    return this.recordsOf(cardId).filter((r) => lineWorthy(r)).map((r) => lineIdFor(r.id));
  }

  /**
   * §6 "Uncertainty belongs to the card": true from the newest hand-over that may have landed (a
   * `dispatching` with no closing record, whatever became of its cause, or a park for uncertain
   * delivery) until a recovery-brief pickup closes `injected` or `spawned` AFTER it. An earlier
   * recovery never clears a later uncertainty.
   */
  private uncertainHandOver(cardId: string): boolean {
    const recs = this.recordsOf(cardId);
    const closed = new Set(recs.filter((r) => r.d.recordType === 'dispatched' && r.d.attempt !== undefined).map((r) => `${String(r.d.for)}#${String(r.d.attempt)}`));
    let newest: HlcTimestamp | null = null;
    for (const r of recs) {
      const open = r.d.recordType === 'dispatching' && !closed.has(`${String(r.d.for)}#${String(r.d.attempt)}`);
      const parkedUncertain = r.d.recordType === 'dispatched' && r.d.outcome === 'parked' && /^decision:uncertain/.test(String(r.d.reason ?? ''));
      if ((open || parkedUncertain) && (!newest || compareHlc(r.hlc, newest) > 0)) newest = r.hlc;
    }
    if (!newest) return false;
    const mark = newest;
    return !recs.some((r) => r.d.recordType === 'dispatched' && r.d.recovery === true && (r.d.outcome === 'injected' || r.d.outcome === 'spawned') && compareHlc(r.hlc, mark) > 0);
  }

  lane(v: CardView, viewer: { isOwner: boolean; personKey: string | null }): Lane {
    // A stopped project app's serve card has nothing left to do in this build: it is settled, not waiting.
    if (!v.card.redacted && v.card.archives.length === 0 && this.isStoppedAppCard(v.card.cardId)) return 'done';
    return laneFor(v.status, viewer.isOwner, v.card, viewer.personKey, v.capacityWaitSurfaced);
  }

  /**
   * When work on a card started (work-front-doors §6, "untouched first"): the first person tap, hand-over to
   * the agent, evidence or done claim after its creation. An agent's own edits and questions do not start it.
   * Null = untouched.
   */
  startedAt(cardId: string): string | null {
    const v = this.view(cardId);
    if (!v) return null;
    // From the fold (records that passed the store's checks), plus the pickup controller's hand-over records.
    const times: string[] = [];
    for (const t of v.card.taps) if (t.by.kind === 'person') times.push(t.at);
    for (const e of v.card.evidence) times.push(e.at);
    for (const c of v.card.claims) times.push(c.at);
    for (const r of this.recordsOf(cardId)) if (r.d.recordType === 'dispatching' && typeof r.d.at === 'string') times.push(r.d.at);
    return times.length ? times.reduce((x, y) => (x < y ? x : y)) : null;
  }

  /**
   * Dismissal lessons (work-front-doors §6): every card a person closed as "Not important" and that is still
   * closed, newest first, with who said it and a pointer to the card and its tap (rule 121: rechecked on every
   * read, so a reopened card's reason drops out). The agent reads these before it raises a new card.
   */
  dismissalLessons(limit = 50): Array<{ cardId: string; tapId: string; title: string; currentTitle?: string; titleUnconfirmed?: true; reason: string; by: By; at: string; conversationKey: string }> {
    const out: Array<{ cardId: string; tapId: string; title: string; currentTitle?: string; titleUnconfirmed?: true; reason: string; by: By; at: string; conversationKey: string }> = [];
    for (const [id, v] of this.views) {
      const c = v.card.closeout;
      if (!c || c.as !== 'not-important' || v.card.redacted) continue;
      // SEC-122: the reason belongs to the title the person closed (matched by the hash their screen sent when
      // there is one). A card retitled since keeps that title here with its current title beside it; a close
      // whose title could not be confirmed says so.
      out.push({ cardId: id, tapId: c.tapId, title: c.title, ...(v.card.title !== c.title ? { currentTitle: v.card.title } : {}), ...(c.titleUnconfirmed ? { titleUnconfirmed: true as const } : {}), reason: c.note, by: c.by, at: c.at, conversationKey: v.card.conversationKey });
    }
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return out.slice(0, Math.max(0, limit));
  }

  private stoppedAppCheck: ((cardId: string) => boolean) | null = null;

  /**
   * Project apps part 2 (docs/specs/project-apps-sandbox.md §3.4): which cards are the serve card of a
   * custom app the owner stopped. Turning the app back on is a separate card (stage 2, CMT-1882), so
   * such a card reads as settled (the Done lane, never Needs-you) and an approve on it is refused.
   * Set once by the server when custom apps are wired; absent ⇒ no card is one.
   */
  setStoppedAppCardCheck(fn: ((cardId: string) => boolean) | null): void { this.stoppedAppCheck = fn; }

  isStoppedAppCard(cardId: string): boolean {
    if (!this.stoppedAppCheck) return false;
    try { return this.stoppedAppCheck(cardId) === true; }
    catch (err) {
      // @silent-fallback-ok — an unreadable app fold leaves the card as the Work Board folds it (in Needs-you, visible), and is logged.
      this.deps.log?.('work-board-stopped-app-check-failed', { cardId, error: (err as Error)?.message });
      return false;
    }
  }

  /** Default human discovery excludes internal work, archived cards and removed cards; history is retained. */
  hiddenConversationKeys(): Set<string> {
    const out = new Set<string>();
    for (const [, v] of this.views) if (v.card.archives.length || v.card.redacted || isAgentInternalCard(v.card)) out.add(v.card.conversationKey);
    return out;
  }

  cardIdForConversation(conversationKey: string): string | null {
    for (const [id, v] of this.views) if (v.card.conversationKey === conversationKey) return id;
    return null;
  }

  /** Cards waiting on the team owner (for the soft budget and Home). */
  waitingOnOwnerCount(): number {
    let n = 0;
    for (const id of this.views.keys()) { const v = this.view(id); if (v && this.lane(v, { isOwner: true, personKey: this.deps.ownerPersonKey() }) === 'waiting-on-you') n++; }
    return n;
  }

  agentCardsCreatedOn(day: string): number {
    let n = 0;
    for (const [, v] of this.views) if (v.card.createdBy?.kind === 'agent' && v.card.createdAt && this.deps.dayOf(Date.parse(v.card.createdAt)).day === day) n++;
    return n;
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /**
   * The agent names the team owner as `"owner"`; the server resolves who that is. A caller never
   * needs to know (or guess) a person's key to ask them something or hand them a card.
   */
  private resolveOwnerAlias(v: unknown): unknown {
    if (v !== 'owner') return v;
    const owner = this.deps.ownerPersonKey();
    return owner ? { personKey: owner } : v;
  }

  /** `isOwner` is stamped here from the resolved principal, never from a body (agent-work-cards-default §3 "Gate-only fields"). */
  private byOf(p: WorkPrincipal): By {
    return p.kind === 'person' ? { kind: 'person', personKey: p.personKey, proof: p.proof, isOwner: p.isOwner } : { kind: 'agent' };
  }

  /** `created.requester`, the two hashes and `pickupHold` are the in-process gate's alone (§3). */
  private gateOnlyRefusal(p: WorkPrincipal, fields: Record<string, unknown>): Refusal | null {
    if (p.kind === 'agent' && p.server === true) return null;
    const hit = GATE_ONLY_FIELDS.find((k) => fields[k] !== undefined);
    return hit ? refuse(400, 'gate-only-field', { field: hit, message: 'This field is written only by the request-to-card gate when a commitment is recorded (POST /commitments). It cannot be set by hand.' }) : null;
  }

  /** `not-started` (§1): an agent-work card the owner has not let start refuses the agent's work records, counted. */
  private notStartedRefusal(p: WorkPrincipal, cardId: string): Refusal | null {
    if (p.kind === 'person') return null;
    const v = this.view(cardId);
    if (!v || v.status !== 'not-started') return null;
    this.stats.notStartedRefusals++;
    return refuse(409, 'not-started', { message: 'This card is waiting for the team owner\'s approval (or a board setting) before the agent works it. Tell the requester it is waiting, and do nothing else on it.' });
  }

  private textFields(fields: Record<string, unknown>): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const push = (k: string, v: unknown) => { if (typeof v === 'string') out.push([k, v]); };
    for (const k of ['title', 'need', 'recommendation', 'whyYou', 'reason', 'text', 'answer'] as const) push(k, fields[k]);
    if (Array.isArray(fields.covers)) (fields.covers as unknown[]).forEach((c, i) => push(`covers[${i}]`, c));
    if (Array.isArray(fields.doneWhen)) (fields.doneWhen as Array<Record<string, unknown>>).forEach((d, i) => push(`doneWhen[${i}].text`, d?.text));
    if (Array.isArray(fields.links)) (fields.links as Array<Record<string, unknown>>).forEach((l, i) => { push(`links[${i}].label`, l?.label); push(`links[${i}].url`, l?.url); });
    const q = fields.question as Record<string, unknown> | undefined;
    if (q) { push('question.text', q.text); if (Array.isArray(q.options)) (q.options as unknown[]).forEach((o, i) => push(`question.options[${i}]`, o)); }
    // Identifier-shaped free strings are checked too: nothing a caller types lands unchecked.
    const src = fields.source as Record<string, unknown> | undefined;
    if (src) { push('source.conversationKey', src.conversationKey); push('source.messageId', src.messageId); }
    push('projectKey', fields.projectKey);
    if (Array.isArray(fields.refs)) (fields.refs as Array<Record<string, unknown>>).forEach((r, i) => push(`refs[${i}].id`, r?.id));
    const brief = fields.brief as Record<string, unknown> | null | undefined;
    if (brief && typeof brief === 'object') {
      push('brief.ask', brief.ask); push('brief.goal', brief.goal); push('brief.chiefSaid', brief.chiefSaid);
      if (Array.isArray(brief.checks)) (brief.checks as Array<Record<string, unknown>>).forEach((c, i) => push(`brief.checks[${i}].text`, c?.text));
    }
    if (Array.isArray(fields.attachmentIds)) (fields.attachmentIds as unknown[]).forEach((a, i) => push(`attachmentIds[${i}]`, a));
    return out;
  }

  /** Credential check + owner-set limits (§3, Fixed limits). Nothing is truncated. */
  private checkText(fields: Record<string, unknown>): Refusal | null {
    for (const [name, text] of this.textFields(fields)) {
      const kind = this.deps.detectCredential(text);
      if (kind) return refuse(422, 'credential-refused', { field: name, credentialKind: kind, message: `The ${name} looks like it contains a credential (${kind}). Reword it, or send the secret through Secret Drop.` });
    }
    const L = this.deps.settings().limits;
    const over = (field: string, v: unknown, limit: number) => (typeof v === 'string' && v.length > limit ? refuse(413, 'over-limit', { field, limit, length: v.length }) : null);
    const checks: Array<Refusal | null> = [over('title', fields.title, L.title), over('need', fields.need, L.need), over('recommendation', fields.recommendation, L.recommendation), over('whyYou', fields.whyYou, L.recommendation)];
    if (Array.isArray(fields.doneWhen)) (fields.doneWhen as Array<Record<string, unknown>>).forEach((d, i) => checks.push(over(`doneWhen[${i}].text`, d?.text, L.doneItemText)));
    const q = fields.question as Record<string, unknown> | undefined;
    if (q && Array.isArray(q.options)) (q.options as unknown[]).forEach((o, i) => checks.push(over(`question.options[${i}]`, o, L.optionText)));
    const hit = checks.find(Boolean);
    if (hit) return hit;
    const bytes = Buffer.byteLength(JSON.stringify(fields), 'utf8');
    if (bytes > L.recordBytes) return refuse(413, 'over-limit', { field: 'record', limit: L.recordBytes, length: bytes });
    return null;
  }

  /** Emit one record and fold it into the index at once (the commit observer's later apply is a no-op). */
  /** The store's own schema check for one record, with nothing emitted (the write and the create's dry run share it). */
  private shapeRefusal(recordType: WorkRecordType, cardId: string | null, fields: Record<string, unknown>, key: string): Refusal | null {
    const probe = buildRecord(recordType, cardId, fields, key)({ physical: 0, logical: 0, node: this.deps.machineId }, this.deps.machineId);
    if (!probe || !workCardRecordStoreSchema.validate(probe, { countDroppedField: () => { /* counted by the envelope layer at the real write */ } } as never)) {
      return refuse(400, 'invalid-record', { recordType, message: 'The record is not in the shape the work board accepts. Check the field types: a need and a title are text, each done item needs an id and text, links are https, a due date is YYYY-MM-DD.' });
    }
    return null;
  }

  private write(recordType: WorkRecordType, cardId: string | null, fields: Record<string, unknown>, recordKey?: string): Result<{ recordId: string; data: Record<string, unknown> }> {
    const key = recordKey ?? mintRecordKey(recordType, cardId, { for: fields.for as string | undefined, attempt: fields.attempt as number | undefined, outcome: fields.outcome as string | undefined });
    // Shape check BEFORE the emit, with the store's own schema: a malformed write is the caller's
    // mistake (400, with the kind named), never "the store is unavailable" (which invites a blind retry).
    const shape = this.shapeRefusal(recordType, cardId, fields, key); if (shape) return shape;
    let built: Record<string, unknown> | null = null;
    const inner = buildRecord(recordType, cardId, fields, key);
    const r = this.deps.emit(key, (hlc, origin, observed) => { built = inner(hlc, origin, observed); return built; });
    if (r.outcome !== 'emitted' || !built) {
      this.deps.log?.('work-board-emit-failed', { recordType, outcome: r.outcome });
      return refuse(503, 'store-unavailable', { outcome: r.outcome });
    }
    const data = built as Record<string, unknown>;
    this.apply([{ data, origin: this.deps.machineId }]);
    if (cardId) this.deps.onLocalWrite?.(cardId, recordType, data);
    return { ok: true, recordId: key, data, ...(r.seq !== undefined ? { seq: r.seq } : {}) } as Result<{ recordId: string; data: Record<string, unknown> }>;
  }

  /** The pickup controller's own records (`dispatching`, `dispatched`), written in-process only. */
  writeSystem(recordType: 'dispatching' | 'dispatched', cardId: string, fields: Record<string, unknown>): Result<{ recordId: string; data: Record<string, unknown>; seq?: number }> {
    // A refusal reason can carry another component's error text; it is replicated and shown, so it is checked too.
    const safe = typeof fields.reason === 'string' && this.deps.detectCredential(fields.reason) ? { ...fields, reason: 'the reason was withheld (it looked like it contained a credential)' } : fields;
    return this.write(recordType, cardId, { ...safe, by: { kind: 'system' }, at: new Date(this.deps.now()).toISOString(), machineId: this.deps.machineId }) as Result<{ recordId: string; data: Record<string, unknown>; seq?: number }>;
  }

  /**
   * The lease holder's records (agent-work-cards-default): a `note` pointer, a `hold-lifted`, a `quiet-repickup`, the team's
   * `enabled-at`. Idempotent where the key is derived (a repeat answers `card-exists`-style `duplicate-record`, writes nothing).
   */
  writeHolder(recordType: Exclude<SystemRecordType, 'dispatching' | 'dispatched'>, cardId: string | null, fields: Record<string, unknown>, keyFrom?: { eventId?: string }): Result<{ recordId: string; data: Record<string, unknown>; seq?: number; duplicate?: boolean }> {
    const key = mintRecordKey(recordType, cardId, { eventId: (keyFrom?.eventId ?? fields.eventId) as string | undefined, teamKey: fields.teamKey as string | undefined, newestAgentRecordId: fields.newestAgentRecordId as string | undefined });
    if (this.keys.has(key)) return { ok: true, recordId: key, data: this.records.find((r) => r.id === key)?.d ?? {}, duplicate: true };
    return this.write(recordType, cardId, { ...fields, by: { kind: 'system' }, at: new Date(this.deps.now()).toISOString() }, key) as Result<{ recordId: string; data: Record<string, unknown>; seq?: number; duplicate?: boolean }>;
  }

  /** The hold on a gate-written card is lifted (§3 "Pickup hold"): one record, the pickup's cause. */
  liftHold(cardId: string, reason: HoldLiftReason): Result<{ recordId: string }> {
    const v = this.view(cardId);
    if (!v || !v.card.created) return refuse(404, 'not-found');
    if (!v.card.pickupHeld) return refuse(409, 'not-held');
    return this.writeHolder('hold-lifted', cardId, { reason });
  }

  /** The one automatic re-pickup of a quiet card (§3 "Quiet"): keyed on the newest agent-written record. */
  quietRepickup(cardId: string): Result<{ recordId: string; duplicate?: boolean }> {
    const v = this.view(cardId);
    if (!v || !v.card.created || !v.card.newestAgentRecordId) return refuse(404, 'not-found');
    return this.writeHolder('quiet-repickup', cardId, { newestAgentRecordId: v.card.newestAgentRecordId });
  }

  /** A `note` pointer for one event, or one coalesced interval's events (§2). */
  notePointer(cardId: string, eventIds: string[]): Result<{ recordId: string; duplicate?: boolean }> {
    if (!eventIds.length) return refuse(400, 'event-required');
    const v = this.view(cardId);
    if (!v || !v.card.created) return refuse(404, 'not-found');
    // One event, one pointer; a coalesced interval's pointer is keyed by its first event (idempotent either way).
    return this.writeHolder('note', cardId, eventIds.length === 1 ? { eventId: eventIds[0] } : { eventIds }, { eventId: eventIds[0] });
  }

  /** The gate's first-run record for a team: earliest `at` wins by the store's merge; a second write answers duplicate. */
  markEnabledAt(teamKey: string): Result<{ recordId: string; duplicate?: boolean }> { return this.writeHolder('enabled-at', null, { teamKey }); }

  /** Every event id the card's `note` pointers name (the drain reconciles its pending set against this, §2). */
  notedEventIds(cardId: string): Set<string> {
    const out = new Set<string>();
    const v = this.views.get(cardId); if (!v) return out;
    for (const n of v.card.notes) for (const e of n.eventIds) out.add(e);
    return out;
  }

  /** `note` pointers written today for a card (the daily ceiling, §2). */
  notePointersOn(cardId: string, day: string): number {
    const v = this.views.get(cardId); if (!v) return 0;
    return v.card.notes.filter((n) => this.deps.dayOf(Date.parse(n.at)).day === day).length;
  }

  /** The text a progress note is checked and written with (§2): the credential guard, the owner-set limit, the hard ceiling. */
  checkNoteText(text: unknown): Refusal | { ok: true; text: string } {
    if (typeof text !== 'string' || !text.trim()) return refuse(400, 'text-required');
    // The credential guard first (a secret is refused whatever its length), then the owner-set limit.
    const kind = this.deps.detectCredential(text);
    if (kind) return refuse(422, 'credential-refused', { field: 'text', credentialKind: kind, message: `The note looks like it contains a credential (${kind}). Reword it, or send the secret through Secret Drop.` });
    const limit = this.deps.settings().limits.noteText;
    if (text.length > limit) return refuse(413, 'over-limit', { field: 'text', limit, length: text.length, message: `A note is at most ${limit} characters here. Split it, or write substantive progress as evidence on the card.` });
    return { ok: true, text: `${NOTE_EVENT_PREFIX}${text}` };
  }

  /** Every record in the index as journal union entries (a reader that folds the board itself, e.g. project apps' served version). */
  entries(): UnionEntry[] { return this.records.map((r) => ({ data: r.d, origin: r.origin })); }

  /**
   * `serverCard`: a card the server writes on the agent's behalf with a deterministic id (project apps'
   * version cards, docs/specs/project-apps-sandbox.md §3.4): the caller names the id, and it is not
   * counted against the agent's daily ceiling (each app has at most one open card per purpose). The owner's
   * phone create names its id the same way (derived from the owner and the request id), so a retry finds one card.
   * `dryRun`: run every check (including the store's record shape) and write nothing.
   */
  createCard(p: WorkPrincipal, input: Record<string, unknown>, serverCard?: { cardId: string; counted?: boolean }, opts?: { dryRun?: boolean }): Result<{ cardId: string; conversationKey: string; overSoftBudget?: { waiting: number; softOpenCards: number } }> {
    if (p.kind === 'session') return refuse(403, 'scoped-session-cannot-create');
    if (p.kind === 'person' && !p.isOwner) return refuse(403, 'owner-required');
    const fields: Record<string, unknown> = {};
    for (const k of CREATE_FIELDS) if (input[k] !== undefined) fields[k] = input[k];
    const own = this.ownershipRefusal(p, fields, null); if (own) return own;
    const gateOnly = this.gateOnlyRefusal(p, fields); if (gateOnly) return gateOnly;
    if (fields.carrier !== undefined) fields.carrier = this.resolveOwnerAlias(fields.carrier);
    if (Array.isArray(fields.doneWhen) && fields.doneWhen.length === 0) return refuse(400, 'done-item-required');
    if (!Array.isArray(fields.doneWhen)) return refuse(400, 'done-item-required');
    const owner = this.deps.ownerPersonKey();
    if (fields.carrier !== undefined && fields.carrier !== 'agent') {
      const ck = (fields.carrier as { personKey?: string })?.personKey;
      if (!owner || ck !== owner) return refuse(400, 'carrier-not-allowed', { message: 'In this phase a card is carried by the agent or by the team owner.' });
    }
    // `outward` defaults to `false` for the agent and `true` for a person (agent-work-cards-default §1, amending
    // work-board-asks §1): the external-operation gate and the outbound guards hold whatever the flag says, so a wrong
    // `false` cannot by itself send or spend; the awareness entry tells the agent to set `true` when unsure.
    if (fields.outward === undefined) fields.outward = p.kind === 'person';
    if (fields.carrier === undefined) fields.carrier = 'agent';
    if (Array.isArray(fields.refs) && (fields.refs as unknown[]).length > MAX_REFS) return refuse(400, 'too-many-refs', { limit: MAX_REFS });
    const t = this.checkText(fields); if (t) return t;
    const linkErr = this.checkAttachmentLinks(undefined, fields.links); if (linkErr) return linkErr;
    // A named id: the server's own cards (agent), or the owner's idempotent phone create (docs/specs/phone-work-cards.md).
    if (serverCard && (!(p.kind === 'agent' || (p.kind === 'person' && p.isOwner)) || !isCardId(serverCard.cardId))) return refuse(400, 'bad-server-card');
    if (serverCard && this.view(serverCard.cardId)?.card.created) return refuse(409, 'card-exists');
    if (p.kind === 'agent' && (!serverCard || serverCard.counted)) {
      const s = this.deps.settings();
      const { day, resetsAt } = this.deps.dayOf(this.deps.now());
      if (this.agentCardsCreatedOn(day) >= s.maxAgentCardsPerDay) {
        return refuse(429, 'daily-card-ceiling', { limit: s.maxAgentCardsPerDay, resetsAt, waysThrough: ['the team owner raises the limit on the Work page', 'the team owner writes the card (person-written cards are not counted)'] });
      }
    }
    const cardId = serverCard?.cardId ?? newCardId();
    const record = { ...fields, by: this.byOf(p), at: new Date(this.deps.now()).toISOString() };
    if (opts?.dryRun) {
      // Every check above plus the store's own record shape, with nothing emitted (the phone's preflight,
      // docs/specs/phone-work-cards.md: a refusal known before Face ID is shown before Face ID).
      const shape = this.shapeRefusal('created', cardId, record, mintRecordKey('created', cardId)); if (shape) return shape;
      return { ok: true, cardId, conversationKey: cardConversationKey(cardId) };
    }
    const w = this.write('created', cardId, record);
    if (!w.ok) return w;
    return { ok: true, cardId, conversationKey: cardConversationKey(cardId), ...this.softBudget() };
  }

  /** The owner-set field limits now in force (a server writer composes within them). */
  limits(): WorkBoardLimits { return this.deps.settings().limits; }

  /** True when the owner's "Waiting on you" lane already holds `softOpenCards` cards (a server writer opens no more). */
  atSoftBudget(): boolean { return this.waitingOnOwnerCount() >= this.deps.settings().softOpenCards; }

  private softBudget(): { overSoftBudget?: { waiting: number; softOpenCards: number } } {
    const s = this.deps.settings();
    const waiting = this.waitingOnOwnerCount();
    return waiting >= s.softOpenCards ? { overSoftBudget: { waiting, softOpenCards: s.softOpenCards } } : {};
  }

  /** Attachment links must name a file in the card's own conversation; the route resolves the file. */
  attachmentResolver: ((conversationKey: string | null, attachmentId: string) => { sha256: string } | null) | null = null;
  private checkAttachmentLinks(cardId: string | undefined, links: unknown): Refusal | null {
    if (!Array.isArray(links)) return null;
    for (const l of links as Array<Record<string, unknown>>) {
      if (typeof l?.attachmentId !== 'string') continue;
      // A new card has no conversation yet, so it cannot cite a file in it.
      if (!cardId) return refuse(400, 'attachment-not-in-card', { attachmentId: l.attachmentId });
      const f = this.attachmentResolver?.(cardConversationKey(cardId), l.attachmentId) ?? null;
      if (!f) return refuse(400, 'attachment-not-in-card', { attachmentId: l.attachmentId });
      if (f.sha256 !== l.sha256) return refuse(400, 'attachment-hash-mismatch', { attachmentId: l.attachmentId });
    }
    return null;
  }

  /**
   * Who may write what on a server-owned card, and which Needs-you keys a writer may cover (work-board-cards-appear
   * §1 Server-owned, §3). Only the in-process server writer writes a server-owned card's records or sets `mirror`
   * and `cos:` covers; a person's taps still work (taps do not come through here), a person's edits do not.
   */
  private ownershipRefusal(p: WorkPrincipal, fields: Record<string, unknown>, card: CardFold | null): Refusal | null {
    const server = p.kind === 'agent' && p.server === true;
    if (card && isServerOwnedCard(card) && !server) return refuse(409, 'server-owned-card', { message: 'The Chief of Staff writes this card itself. Act on the project in its own conversation; the card follows.' });
    if (fields.mirror !== undefined && !server) return refuse(400, 'mirror-not-allowed');
    if (fields.brief !== undefined && !server) return refuse(400, 'brief-not-allowed');
    if (fields.covers !== undefined) {
      if (!Array.isArray(fields.covers)) return refuse(400, 'covers-not-allowed');
      const allowed = server ? [...COVERABLE_PREFIXES, ...SERVER_COVERABLE_PREFIXES] : COVERABLE_PREFIXES;
      const bad = (fields.covers as unknown[]).find((k) => typeof k !== 'string' || !allowed.some((pre) => k.startsWith(pre)));
      if (bad !== undefined) return refuse(400, 'covers-not-allowed', { key: String(bad), allowed, message: 'A card may say it is about a plan (plan:<id>) or a pull request (pr:<n>) in Needs-you; other items keep their own row and action.' });
    }
    return null;
  }

  /**
   * work-board-cards-appear §2: a card the agent (or a session) writes through the route says what it recommends
   * and why it needs the person, and an edit never clears either on an agent-written card. The route calls this;
   * in-process server cards are not route writes (the wait cards always carry both; a project app's version card
   * is exempt, its recommendation would only restate the approve button). A person's own card is unaffected.
   */
  askFieldsRefusal(p: WorkPrincipal, fields: Record<string, unknown>, cardId: string | null): Refusal | null {
    if (p.kind === 'person') return null;
    const why = { recommendation: 'A card the agent writes that asks the person says what it recommends. Add a recommendation.', whyYou: 'A card the agent writes that asks the person says why it needs them and not the agent. Add whyYou.' };
    if (cardId === null) {
      // agent-work-cards-default §1 (amending work-board-cards-appear §2): an AGENT-WORK card asks nothing, so it
      // needs neither field. The requirement stands for every card that is an ask at creation: `outward: true`, a
      // person carrier, or any done item that a person must confirm (`certify` defaults to owner-confirms).
      if (isAgentWorkInput(fields)) {
        if (fields.recommendation !== undefined && fields.recommendation !== null && !nonEmpty(fields.recommendation)) return refuse(400, 'recommendation-required', { message: why.recommendation });
        if (fields.whyYou !== undefined && fields.whyYou !== null && !nonEmpty(fields.whyYou)) return refuse(400, 'why-you-required', { message: why.whyYou });
        return null;
      }
      if (!nonEmpty(fields.recommendation)) return refuse(400, 'recommendation-required', { message: why.recommendation });
      if (!nonEmpty(fields.whyYou)) return refuse(400, 'why-you-required', { message: why.whyYou });
      return null;
    }
    const card = this.view(cardId)?.card;
    if (!card || card.createdBy?.kind !== 'agent') return null;
    // An edit that makes an agent-work card an ask (outward, a person carrier, an owner-confirms item) re-runs the
    // same check on the record that makes it one (§1): the fields must be present on the card or on the edit.
    const becomesAsk = fields.outward === true
      || (fields.carrier !== undefined && fields.carrier !== 'agent')
      || (Array.isArray(fields.doneWhen) && (fields.doneWhen as Array<Record<string, unknown>>).some((d) => d?.certify !== 'agent-may-certify'));
    const has = (k: 'recommendation' | 'whyYou') => (fields[k] !== undefined ? nonEmpty(fields[k]) : nonEmpty(card[k]));
    if (becomesAsk) {
      if (!has('recommendation')) return refuse(400, 'recommendation-required', { message: why.recommendation });
      if (!has('whyYou')) return refuse(400, 'why-you-required', { message: why.whyYou });
    }
    if (fields.recommendation !== undefined && !nonEmpty(fields.recommendation) && !card.agentWork) return refuse(400, 'recommendation-required', { message: why.recommendation });
    if (fields.whyYou !== undefined && !nonEmpty(fields.whyYou) && !card.agentWork) return refuse(400, 'why-you-required', { message: why.whyYou });
    return null;
  }

  /** A `waiting-on` a person on an agent-work card makes it an ask (§1): both fields must be on the card or on the record. */
  waitingOnAskRefusal(p: WorkPrincipal, cardId: string, input: { principal?: unknown; recommendation?: unknown; whyYou?: unknown }): Refusal | null {
    if (p.kind === 'person') return null;
    const card = this.view(cardId)?.card;
    if (!card || card.createdBy?.kind !== 'agent') return null;
    const principal = this.resolveOwnerAlias(input.principal);
    if (!principal || typeof principal !== 'object') return null;
    if (!(input.recommendation !== undefined ? nonEmpty(input.recommendation) : nonEmpty(card.recommendation))) return refuse(400, 'recommendation-required', { message: 'Waiting on a person makes this card an ask: say what you recommend (recommendation) on this record or on the card first.' });
    if (!(input.whyYou !== undefined ? nonEmpty(input.whyYou) : nonEmpty(card.whyYou))) return refuse(400, 'why-you-required', { message: 'Waiting on a person makes this card an ask: say why it needs them (whyYou) on this record or on the card first.' });
    return null;
  }

  private serverOwnedBlocks(p: WorkPrincipal, card: CardFold): boolean {
    return isServerOwnedCard(card) && !(p.kind === 'agent' && p.server === true);
  }

  /** A deterministic record key is the server writer's only; it must name this card. */
  private serverKey(p: WorkPrincipal, cardId: string, recordKey: string | undefined): string | Refusal | null {
    if (recordKey === undefined) return null;
    if (!(p.kind === 'agent' && p.server === true)) return refuse(400, 'record-key-not-allowed');
    if (!isRecordId(recordKey) || !recordKey.startsWith(`wc:${cardId}:`)) return refuse(400, 'bad-record-key');
    return recordKey;
  }

  private guardCard(p: WorkPrincipal, cardId: string): Refusal | { v: CardView } {
    if (!isCardId(cardId)) return refuse(404, 'not-found');
    const v = this.view(cardId);
    if (!v || !v.card.created) return refuse(404, 'not-found');
    if (p.kind === 'session' && p.conversationKey !== v.card.conversationKey) return refuse(404, 'not-found');
    if (v.card.redacted) return refuse(409, 'card-removed');
    return { v };
  }

  /**
   * `serverOwnedRewrite` is for the server's own card classes only (a project app's version card,
   * project-apps-sandbox §3.4): the server rewrites the one card per app to the newest version, and a
   * new version is a new request, so it may rewrite a finished card. The rewrite changes the material,
   * which by itself voids the old approval and the old finish (the fold binds both to the material
   * hash), so the card reads as needing approval again. No HTTP route passes it.
   */
  edit(p: WorkPrincipal, cardId: string, input: Record<string, unknown>, opts: { serverOwnedRewrite?: boolean } = {}): Result<{ recordId: string; changed: string[] }> {
    if (p.kind === 'person' && !p.isOwner) return refuse(403, 'owner-required');
    const g = this.guardCard(p, cardId); if ('ok' in g) return g;
    const card = g.v.card;
    const own = this.ownershipRefusal(p, input, card); if (own) return own;
    const gateOnly = this.gateOnlyRefusal(p, input); if (gateOnly) return gateOnly;
    const changed: Record<string, unknown> = {};
    for (const k of EDIT_FIELDS) {
      if (input[k] === undefined) continue;
      const next = k === 'carrier' ? this.resolveOwnerAlias(input[k]) : input[k];
      const cur = (card as unknown as Record<string, unknown>)[k];
      if (!sameValue(cur ?? null, next)) changed[k] = next;
    }
    // The owner approved "do what I asked", whole: `need` on such a card is immutable (agent-work-cards-default §1).
    if (changed.need !== undefined && card.needLockedToRequest) return refuse(409, 'need-locked-to-request', { message: 'This card\'s need is the owner\'s own request, word for word, and cannot be changed. Refine the title, the done items or the links; different work is its own card.' });
    if (Array.isArray(changed.refs) && (changed.refs as unknown[]).length > MAX_REFS) return refuse(400, 'too-many-refs', { limit: MAX_REFS });
    const names = Object.keys(changed);
    if (!names.length) return { ok: true, recordId: '', changed: [] };
    const material = names.filter((n) => (MATERIAL_FIELDS as ReadonlyArray<string>).includes(n));
    if (p.kind !== 'person' && material.length && card.done && !(opts.serverOwnedRewrite && p.kind === 'agent')) return refuse(409, 'reopen-required', { message: 'A finished card can be unfinished only by a person.' });
    if (changed.carrier !== undefined && changed.carrier !== 'agent') {
      const owner = this.deps.ownerPersonKey();
      if (!owner || (changed.carrier as { personKey?: string })?.personKey !== owner) return refuse(400, 'carrier-not-allowed');
    }
    if (Array.isArray(changed.doneWhen) && (changed.doneWhen as DoneWhenItem[]).length === 0) return refuse(400, 'done-item-required');
    const t = this.checkText(changed); if (t) return t;
    const le = this.checkAttachmentLinks(cardId, changed.links); if (le) return le;
    const w = this.write('edited', cardId, { ...changed, by: this.byOf(p), at: new Date(this.deps.now()).toISOString() });
    if (!w.ok) return w;
    return { ok: true, recordId: w.recordId, changed: names };
  }

  setWaitingOn(p: WorkPrincipal, cardId: string, input: { principal?: unknown; question?: unknown; supersedes?: unknown; reason?: unknown }): Result<{ questionId: string; overSoftBudget?: { waiting: number; softOpenCards: number } }> {
    if (p.kind === 'person') return refuse(403, 'agent-only');
    const g = this.guardCard(p, cardId); if ('ok' in g) return g;
    const card = g.v.card;
    if (this.serverOwnedBlocks(p, card)) return refuse(409, 'server-owned-card');
    const principal = this.resolveOwnerAlias(input.principal) as Principal | undefined;
    if (!principal) return refuse(400, 'principal-required');
    if (typeof principal === 'object') {
      const owner = this.deps.ownerPersonKey();
      if (!owner || principal.personKey !== owner) return refuse(400, 'principal-not-allowed', { message: 'In this phase the agent waits only on the team owner.' });
      if (!input.question) return refuse(400, 'question-required');
    }
    const open = card.openQuestion;
    if (open && input.supersedes !== open.id) return refuse(409, 'question-open', { openQuestionId: open.id, message: 'A question is already open. Replacing it needs supersedes and a reason.' });
    if (open && (typeof input.reason !== 'string' || !input.reason.trim())) return refuse(400, 'reason-required');
    if (!open && input.supersedes !== undefined) return refuse(409, 'nothing-to-supersede');
    const fields: Record<string, unknown> = { principal, ...(input.question ? { question: input.question } : {}), ...(open ? { supersedes: input.supersedes, reason: input.reason } : {}) };
    const t = this.checkText(fields); if (t) return t;
    const w = this.write('waiting-on', cardId, { ...fields, by: this.byOf(p), at: new Date(this.deps.now()).toISOString() });
    if (!w.ok) return w;
    return { ok: true, questionId: w.recordId, ...this.softBudget() };
  }

  /** `recordKey`: the server's own writer names a deterministic key so a retried close is one record (work-board-cards-appear §1). */
  addEvidence(p: WorkPrincipal, cardId: string, input: { itemId?: unknown; text?: unknown; attachmentIds?: unknown }, opts: { recordKey?: string } = {}): Result<{ evidenceId: string }> {
    if (p.kind === 'person') return refuse(403, 'agent-only');
    const g = this.guardCard(p, cardId); if ('ok' in g) return g;
    const card = g.v.card;
    if (this.serverOwnedBlocks(p, card)) return refuse(409, 'server-owned-card');
    const ns = this.notStartedRefusal(p, cardId); if (ns) return ns;
    const key = this.serverKey(p, cardId, opts.recordKey); if (key && typeof key !== 'string') return key;
    if (typeof input.itemId !== 'string' || !card.doneWhen.some((d) => d.id === input.itemId)) return refuse(400, 'unknown-item');
    if (typeof input.text !== 'string' || !input.text.trim()) return refuse(400, 'evidence-text-required');
    if (Array.isArray(input.attachmentIds)) {
      for (const a of input.attachmentIds) {
        // Evidence cites files in the card's own conversation only.
        if (typeof a !== 'string' || !this.attachmentResolver?.(card.conversationKey, a)) return refuse(400, 'attachment-not-in-card', { attachmentId: String(a) });
      }
    }
    const fields: Record<string, unknown> = { itemId: input.itemId, text: input.text, materialHash: card.materialHash, reopens: card.reopens, ...(Array.isArray(input.attachmentIds) ? { attachmentIds: input.attachmentIds } : {}) };
    const t = this.checkText(fields); if (t) return t;
    const w = this.write('evidence', cardId, { ...fields, by: this.byOf(p), at: new Date(this.deps.now()).toISOString() }, key || undefined);
    if (!w.ok) return w;
    return { ok: true, evidenceId: w.recordId };
  }

  claimDone(p: WorkPrincipal, cardId: string, opts: { recordKey?: string } = {}): Result<{ claimId: string; needsConfirm: boolean }> {
    if (p.kind === 'person') return refuse(403, 'agent-only');
    const g = this.guardCard(p, cardId); if ('ok' in g) return g;
    const card = g.v.card;
    if (this.serverOwnedBlocks(p, card)) return refuse(409, 'server-owned-card');
    const ns = this.notStartedRefusal(p, cardId); if (ns) return ns;
    const key = this.serverKey(p, cardId, opts.recordKey); if (key && typeof key !== 'string') return key;
    if (card.holds.length) return refuse(409, 'held');
    if (card.unknown.length) return refuse(409, 'card-unreadable');
    if (card.approvalRequired && !card.approvalValid) return refuse(409, 'not-approved');
    const latestPerItem = new Map<string, string>();
    for (const e of card.evidence) if (e.counts) latestPerItem.set(e.itemId, e.id);
    const missing = card.doneWhen.filter((d) => !latestPerItem.has(d.id)).map((d) => d.id);
    if (missing.length) {
      const stale = card.evidence.some((e) => !e.counts && missing.includes(e.itemId) && e.materialHash === card.materialHash);
      return refuse(409, stale ? 'reopened-since' : 'evidence-missing', { items: missing });
    }
    const evidenceIds = [...latestPerItem.values()];
    const w = this.write('claimed-done', cardId, { materialHash: card.materialHash, reopens: card.reopens, evidenceIds, by: this.byOf(p), at: new Date(this.deps.now()).toISOString() }, key || undefined);
    if (!w.ok) return w;
    const after = this.view(cardId);
    return { ok: true, claimId: w.recordId, needsConfirm: !!after?.card.needsConfirm };
  }

  /**
   * A person's tap (§4). Permitting taps are checked against the current card and refused
   * `stale-card` (or `question-replaced`) when what they bind to is not current; restricting
   * taps are always accepted. The fold applies the same test and is the authority.
   */
  tap(p: WorkPrincipal, cardId: string, input: { action?: unknown; materialHash?: unknown; questionId?: unknown; answer?: unknown; claimId?: unknown; retryOf?: unknown; names?: unknown; titleHash?: unknown; closeAs?: unknown; note?: unknown }): Result<{ recordId: string }> {
    if (p.kind !== 'person') return refuse(403, 'person-required');
    if (!p.isOwner) return refuse(403, 'owner-required', { message: 'In this phase only the team owner taps.' });
    if (!isCardId(cardId)) return refuse(404, 'not-found');
    const v = this.view(cardId);
    if (!v || !v.card.created) return refuse(404, 'not-found');
    const action = input.action as TapAction;
    const card = v.card;
    const restricting = isRestrictingTap(String(action));
    if (card.redacted && action !== 'redact') return refuse(409, 'card-removed');
    if (card.redacted && action === 'redact') return { ok: true, recordId: '' };
    const fields: Record<string, unknown> = { action };
    const stale = (detail?: Record<string, unknown>) => refuse(409, 'stale-card', detail);
    switch (action) {
      case 'approve':
        if (this.deps.approvalAuthority) return refuse(409, 'bound-approval-required');
        if (input.materialHash !== card.materialHash) return stale({ materialHash: card.materialHash });
        fields.materialHash = card.materialHash; break;
      case 'answer': {
        const q = card.questions.find((x) => x.id === input.questionId);
        if (!q) return stale();
        if (q.state === 'replaced') return refuse(409, 'question-replaced', { replacement: card.openQuestion?.id ?? null });
        if (q.state !== 'open') return stale();
        if (typeof input.answer !== 'string' || !input.answer.trim()) return refuse(400, 'answer-required');
        const t = this.checkText({ answer: input.answer }); if (t) return t;
        fields.questionId = q.id; fields.answer = input.answer; break;
      }
      case 'confirm-done':
        if (!card.currentClaim || card.currentClaim.id !== input.claimId || input.materialHash !== card.materialHash) return stale();
        fields.claimId = card.currentClaim.id; fields.materialHash = card.materialHash; fields.reopens = card.reopens; break;
      case 'unhold':
        if (typeof input.names !== 'string' || !card.holds.includes(input.names)) return stale({ holds: card.holds });
        fields.names = input.names; break;
      case 'unarchive':
        if (typeof input.names !== 'string' || !card.archives.includes(input.names)) return stale({ archives: card.archives });
        fields.names = input.names; break;
      case 'retry': {
        if (!isRecordId(input.retryOf)) return refuse(400, 'retry-of-required');
        const target = this.retryTarget(cardId, input.retryOf);
        if (!target) return stale();
        fields.retryOf = input.retryOf; break;
      }
      case 'reopen':
        if (!isRecordId(input.claimId)) return refuse(400, 'claim-required');
        fields.claimId = input.claimId; break; // restricting: recorded even when not current
      case 'archive': {
        // A person's close (work-front-doors §6): "Done" needs its closeout note, "Not important" its reason.
        if (input.closeAs === undefined && input.note === undefined) break;
        if (typeof input.closeAs !== 'string' || !(CLOSE_AS as ReadonlyArray<string>).includes(input.closeAs)) return refuse(400, 'unknown-close', { allowed: [...CLOSE_AS] });
        if (typeof input.note !== 'string' || !input.note.trim()) {
          return input.closeAs === 'done'
            ? refuse(400, 'note-required', { message: 'Say in a line what was done before closing this card.' })
            : refuse(400, 'reason-required', { message: 'Say why this is not important. The agent reads these reasons before it raises a new card.' });
        }
        if (input.note.length > SCHEMA_MAX.closeNote) return refuse(413, 'over-limit', { field: 'note', limit: SCHEMA_MAX.closeNote, length: input.note.length });
        const kind = this.deps.detectCredential(input.note);
        if (kind) return refuse(422, 'credential-refused', { field: 'note', credentialKind: kind, message: `The note looks like it contains a credential (${kind}). Reword it, or send the secret through Secret Drop.` });
        fields.closeAs = input.closeAs; fields.note = input.note; break;
      }
      case 'hold': case 'withdraw-approval': case 'redact': break;
      default: return refuse(400, 'unknown-action');
    }
    if (typeof input.titleHash === 'string' && /^[0-9a-f]{64}$/.test(input.titleHash)) {
      if (!restricting && input.titleHash !== sha256Hex(card.title)) return stale();
      fields.titleHash = input.titleHash;
    }
    const w = this.write('tap', cardId, { ...fields, by: this.byOf(p), at: new Date(this.deps.now()).toISOString() });
    if (!w.ok) return w;
    return { ok: true, recordId: w.recordId };
  }

  /** A retry binds to a park's record id, a waiting pickup's cause id, or a quiet card's newest record id. */
  private retryTarget(cardId: string, retryOf: string): 'park' | 'waiting' | 'quiet' | null {
    const v = this.view(cardId); if (!v) return null;
    if (v.pickups.some((x) => x.status === 'parked' && x.parkId === retryOf)) return 'park';
    if (v.pickups.some((x) => x.status === 'pending' && x.cause.id === retryOf)) return 'waiting';
    if (v.status === 'quiet') {
      const recs = this.recordsOf(cardId);
      if (recs.length && recs[recs.length - 1].id === retryOf) return 'quiet';
    }
    return null;
  }

  setPolicy(p: WorkPrincipal, policy: unknown): Result<{ recordId: string; wouldStart: number }> {
    if (p.kind !== 'person' || !p.isOwner) return refuse(403, 'owner-required');
    if (policy !== 'every-agent-card' && policy !== 'outward-only') return refuse(400, 'unknown-policy');
    const wouldStart = this.cardsStartingUnder(policy);
    const w = this.write('policy', null, { policy, by: this.byOf(p), at: new Date(this.deps.now()).toISOString() });
    if (!w.ok) return w;
    return { ok: true, recordId: w.recordId, wouldStart };
  }

  // ── graduation (Maturation plan) ─────────────────────────────────────────

  /** When the pilot began (the first card), the day-7 / day-14 records written so far, and which are due. */
  graduationState(): { pilotStartedAt: string | null; records: Array<Record<string, unknown>>; due: number[] } {
    let first: number | null = null;
    // Server-owned cards (Chief of Staff wait cards) are a mechanical mirror: they neither start the pilot nor count in it (work-board-cards-appear §1 Measurement).
    for (const [, v] of this.views) { if (isServerOwnedCard(v.card)) continue; const t = v.card.createdAt ? Date.parse(v.card.createdAt) : NaN; if (Number.isFinite(t) && (first === null || t < first)) first = t; }
    const records = this.records.filter((r) => r.d.recordType === 'graduation').map((r) => ({ day: r.d.day, decision: r.d.decision, metrics: r.d.metrics, at: r.d.at }));
    const have = new Set(records.map((r) => r.day));
    const due: number[] = [];
    if (first !== null) for (const day of [7, 14]) if (!have.has(day) && this.deps.now() - first >= day * 86_400_000) due.push(day);
    return { pilotStartedAt: first === null ? null : new Date(first).toISOString(), records, due };
  }

  /**
   * The graduation criterion, measured from the store over the window ending now (Maturation plan):
   * every pickup cause and whether it reached a closing record, each park and how it ended, the
   * median time from ask to tap, and the share of agent-attested finishes the owner reopened.
   * Whether evidence was TRUE is a person's reading; the store cannot tell.
   */
  graduationMetrics(days: number): { decision: 'measured' | 'incomplete'; metrics: Record<string, unknown> } {
    const since = this.deps.now() - days * 86_400_000;
    let cards = 0; let causes = 0; let closed = 0; let agentAttested = 0; let agentAttestedReopened = 0;
    const parks: Array<{ cardId: string; reason: string; ended: string }> = [];
    const askToTap: number[] = [];
    let serverOwnedCards = 0;
    for (const [id, v] of this.views) {
      if (!v.card.createdAt || Date.parse(v.card.createdAt) < since) continue;
      if (isServerOwnedCard(v.card)) { serverOwnedCards++; continue; }
      cards++;
      for (const p of v.pickups) {
        causes++;
        if (p.status === 'settled' || p.status === 'void') closed++;
        if (p.parkId) parks.push({ cardId: id, reason: p.closedReason ?? '', ended: p.status === 'parked' ? 'still parked' : p.retriesGranted > 0 ? "a person's Try again" : p.rearmed ? 'an ownership change' : 'closed' });
      }
      for (const q of v.card.questions) {
        if (q.state !== 'answered') continue;
        const tap = v.card.taps.find((t) => t.action === 'answer' && t.questionId === q.id);
        if (tap) askToTap.push(Date.parse(tap.at) - Date.parse(q.at));
      }
      const firstApprove = v.card.taps.find((t) => t.action === 'approve');
      if (firstApprove && v.card.createdAt) askToTap.push(Date.parse(firstApprove.at) - Date.parse(v.card.createdAt));
      const allAgentCertify = v.card.doneWhen.length > 0 && v.card.doneWhen.every((d) => d.certify === 'agent-may-certify');
      if (allAgentCertify && v.card.claims.length > 0) { agentAttested++; if (v.card.reopens.length > 0) agentAttestedReopened++; }
    }
    askToTap.sort((a, b) => a - b);
    const median = askToTap.length ? askToTap[Math.floor((askToTap.length - 1) / 2)] : null;
    const metrics = {
      windowDays: days, cards, pickupCauses: causes, pickupCausesClosed: closed, everyCauseClosed: causes > 0 && causes === closed + parks.filter((p) => p.ended === 'still parked').length,
      parks: parks.slice(0, 50), medianAskToTapMs: median, agentAttestedFinishes: agentAttested, agentAttestedReopened, serverOwnedCards,
      needsAPersonsReading: 'whether evidence was true (up to ten agent-attested finishes), who saw a card, and defects found on the first screen',
    };
    return { decision: cards === 0 || causes === 0 ? 'incomplete' : 'measured', metrics };
  }

  /** Write each due graduation record (idempotent: the key is fixed per day). */
  graduationPass(): { written: number[]; due: number[] } {
    const { due } = this.graduationState();
    const written: number[] = [];
    for (const day of due) {
      const g = this.graduationMetrics(day);
      const w = this.write('graduation', null, { day, decision: g.decision, metrics: g.metrics, attempt: day, by: { kind: 'system' }, at: new Date(this.deps.now()).toISOString() }, `wb-graduation:day${day}`);
      if (w.ok) written.push(day);
    }
    return { written, due };
  }

  /** How many waiting cards would become workable at once under a policy (the PIN prompt says so, §7). */
  cardsStartingUnder(policy: ApprovalPolicy): number {
    let n = 0;
    for (const id of this.views.keys()) {
      const now = this.views.get(id)!.card;
      if (now.workable || now.redacted) continue;
      const under = foldCard(id, this.recordsOf(id), this.policies, { policyOverride: policy });
      if (under.workable) n++;
    }
    return n;
  }
}

/** Whether the agent may write a progress note on this card now (§1/§2): the card is readable and not `not-started`. */
export function noteRefusalFor(svc: WorkBoardService, p: WorkPrincipal, cardId: string): Refusal | null {
  if (p.kind === 'person') return refuse(403, 'agent-only', { message: 'A person writes in the card\'s conversation directly.' });
  if (!isCardId(cardId)) return refuse(404, 'not-found');
  const v = svc.view(cardId);
  if (!v || !v.card.created) return refuse(404, 'not-found');
  if (v.card.redacted) return refuse(409, 'card-removed');
  if (v.status === 'not-started') { svc.stats.notStartedRefusals++; return refuse(409, 'not-started', { message: 'This card is waiting for the team owner\'s approval (or a board setting) before the agent works it.' }); }
  return null;
}

/** Records that leave one `Work board:` line in the card's conversation (§2). */
export function lineWorthy(r: FoldRecord): boolean {
  const t = r.d.recordType;
  if (t === 'tap') return true;
  if (t === 'edited') return true; // only material edits produce a line; the writer decides (see transcriptLineFor)
  if (t === 'waiting-on') return !!r.d.supersedes;
  if (t === 'dispatched') return r.d.outcome === 'parked' || r.d.outcome === 'void';
  return false;
}

/** Fixed `Work board:` templates (§2). Returns null when the record leaves no line. */
export function transcriptLineFor(recordType: WorkRecordType, data: Record<string, unknown>, ctx: { name: (personKey: string) => string; when: (iso: string) => string; materialChanged?: string[]; voidedApproval?: boolean }): string | null {
  const by = data.by as By;
  const who = by?.kind === 'person' ? ctx.name(by.personKey) : 'the agent';
  const when = typeof data.at === 'string' ? ctx.when(data.at) : '';
  switch (recordType) {
    case 'tap': {
      switch (data.action) {
        case 'approve': return `Work board: approved by ${who} · ${when}`;
        case 'withdraw-approval': return `Work board: approval withdrawn by ${who} · ${when}`;
        case 'answer': { const a = String(data.answer ?? ''); return `Work board: ${who} answered "${a.length > 120 ? `${a.slice(0, 120)}…` : a}" · ${when}`; }
        case 'hold': return `Work board: held by ${who}`;
        case 'unhold': return `Work board: hold released by ${who}`;
        case 'confirm-done': return `Work board: confirmed done by ${who} · ${when}`;
        case 'reopen': return `Work board: reopened by ${who} · ${when}`;
        case 'archive': {
          const n = String(data.note ?? ''); const note = n.length > 200 ? `${n.slice(0, 200)}…` : n;
          if (data.closeAs === 'done') return `Work board: ${who} closed this as done: "${note}" · ${when}`;
          if (data.closeAs === 'not-important') return `Work board: ${who} closed this as not important: "${note}" · ${when}`;
          return `Work board: archived by ${who}`;
        }
        case 'unarchive': return `Work board: restored by ${who}`;
        case 'retry': return `Work board: ${who} asked the agent to try again · ${when}`;
        case 'redact': return null; // the conversation itself is removed
      }
      return null;
    }
    case 'edited':
      if (ctx.materialChanged && ctx.materialChanged.length && ctx.voidedApproval) return `Work board: the card changed (${ctx.materialChanged.join(', ')}); the earlier approval no longer applies`;
      return null;
    case 'waiting-on': {
      if (!data.supersedes) return null;
      const r = String(data.reason ?? '');
      return `Work board: the earlier question was replaced. The agent's reason: "${r.length > 120 ? `${r.slice(0, 120)}…` : r}"`;
    }
    case 'dispatched':
      if (data.outcome === 'parked') return `Work board: this could not be handed to the agent (${plainParkReason(String(data.reason ?? ''))})`;
      return null;
    case 'policy': return `Work board: ${who} changed how approval works; this card can start now`;
    default: return null;
  }
}

export function plainParkReason(reason: string): string {
  if (reason.startsWith('decision:uncertain')) return 'this may already have been picked up before a machine change; check the chat first';
  if (reason.startsWith('decision:agent-churn')) return 'the agent keeps changing this card';
  if (reason.startsWith('failure:')) return reason.slice('failure:'.length).trim() || 'it failed three times';
  return reason || 'it failed three times';
}

export type { CardLink, Carrier };
export { WORK_BOARD_STORE_KEY };
