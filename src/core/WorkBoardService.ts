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
import type { HlcTimestamp } from './HybridLogicalClock.js';
import {
  buildRecord, toFoldRecords, partitionRecords, foldCard, deriveStatus, laneFor, derivePickupCauses, foldPickups,
  materialHashOf, cardConversationKey, sameValue, sha256Hex, isCardId, isRecordId, mintRecordKey, isRestrictingTap, foldOrder, compareHlc, workCardRecordStoreSchema,
  MATERIAL_FIELDS, WORK_BOARD_STORE_KEY,
  type UnionEntry, type FoldRecord, type CardFold, type CardStatus, type Lane, type PickupState, type TapAction,
  type WorkRecordType, type By, type ApprovalPolicy, type DoneWhenItem, type CardLink, type Carrier, type Principal,
} from './WorkCardStore.js';

export interface WorkBoardLimits { recordBytes: number; title: number; need: number; recommendation: number; doneItemText: number; optionText: number }
export interface WorkBoardPickupSettings { tickSeconds: number; freeCheckMinSeconds: number; freeCheckMaxSeconds: number; maxSpendingAttempts: number; surfaceAfterHours: number; ownerCatchUpSeconds: number }
export interface WorkBoardSettings { softOpenCards: number; maxAgentCardsPerDay: number; quietAfterHours: number; limits: WorkBoardLimits; pickup: WorkBoardPickupSettings }

export const DEFAULT_WORK_BOARD_SETTINGS: WorkBoardSettings = Object.freeze({
  softOpenCards: 30, maxAgentCardsPerDay: 200, quietAfterHours: 24,
  limits: Object.freeze({ recordBytes: 32768, title: 300, need: 4000, recommendation: 2000, doneItemText: 500, optionText: 200 }),
  pickup: Object.freeze({ tickSeconds: 60, freeCheckMinSeconds: 60, freeCheckMaxSeconds: 1800, maxSpendingAttempts: 3, surfaceAfterHours: 24, ownerCatchUpSeconds: 600 }),
}) as WorkBoardSettings;

/** Merge a partial config block over the defaults, keeping only positive whole numbers. */
export function resolveWorkBoardSettings(raw: unknown): WorkBoardSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pos = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : d);
  const lim = (r.limits && typeof r.limits === 'object' ? r.limits : {}) as Record<string, unknown>;
  const pk = (r.pickup && typeof r.pickup === 'object' ? r.pickup : {}) as Record<string, unknown>;
  const D = DEFAULT_WORK_BOARD_SETTINGS;
  return {
    softOpenCards: pos(r.softOpenCards, D.softOpenCards), maxAgentCardsPerDay: pos(r.maxAgentCardsPerDay, D.maxAgentCardsPerDay), quietAfterHours: pos(r.quietAfterHours, D.quietAfterHours),
    limits: {
      recordBytes: pos(lim.recordBytes, D.limits.recordBytes), title: pos(lim.title, D.limits.title), need: pos(lim.need, D.limits.need),
      recommendation: pos(lim.recommendation, D.limits.recommendation), doneItemText: pos(lim.doneItemText, D.limits.doneItemText), optionText: pos(lim.optionText, D.limits.optionText),
    },
    pickup: {
      tickSeconds: pos(pk.tickSeconds, D.pickup.tickSeconds), freeCheckMinSeconds: Math.max(60, pos(pk.freeCheckMinSeconds, D.pickup.freeCheckMinSeconds)),
      freeCheckMaxSeconds: pos(pk.freeCheckMaxSeconds, D.pickup.freeCheckMaxSeconds), maxSpendingAttempts: Math.max(1, pos(pk.maxSpendingAttempts, D.pickup.maxSpendingAttempts)),
      surfaceAfterHours: pos(pk.surfaceAfterHours, D.pickup.surfaceAfterHours), ownerCatchUpSeconds: pos(pk.ownerCatchUpSeconds, D.pickup.ownerCatchUpSeconds),
    },
  };
}

const SETTING_GROUPS: ReadonlySet<string> = new Set(['limits', 'pickup']);
const SETTING_NAMES: ReadonlySet<string> = new Set([
  'softOpenCards', 'maxAgentCardsPerDay', 'quietAfterHours',
  ...Object.keys(DEFAULT_WORK_BOARD_SETTINGS.limits).map((k) => `limits.${k}`),
  ...Object.keys(DEFAULT_WORK_BOARD_SETTINGS.pickup).map((k) => `pickup.${k}`),
]);

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
      if (!(typeof v === 'number' && Number.isInteger(v) && v > 0)) return name;
      if (name === 'pickup.freeCheckMinSeconds' && v < 60) return name;
    }
    return null;
  };
  const bad = walk(patch as Record<string, unknown>, '');
  return bad ? { ok: false, field: bad } : { ok: true };
}

export type WorkPrincipal =
  | { kind: 'agent' }
  | { kind: 'session'; conversationKey: string }
  | { kind: 'person'; personKey: string; proof: 'pin' | 'presence'; isOwner: boolean };

export interface Refusal { ok: false; status: number; error: string; detail?: Record<string, unknown> }
export type Result<T> = ({ ok: true } & T) | Refusal;

const refuse = (status: number, error: string, detail?: Record<string, unknown>): Refusal => ({ ok: false, status, error, ...(detail ? { detail } : {}) });

export interface WorkBoardDeps {
  machineId: string;
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

/** Deterministic transcript-line id for a record (so a repeat append is a no-op and a surface can recognise the line). */
export function lineIdFor(recordId: string): string {
  return `wb-${createHash('sha256').update(recordId).digest('hex').slice(0, 24)}`;
}

export function newCardId(): string { return `wc_${randomBytes(8).toString('hex')}`; }

const CREATE_FIELDS = ['title', 'need', 'doneWhen', 'carrier', 'outward', 'links', 'recommendation', 'due', 'projectKey', 'source'] as const;
const EDIT_FIELDS = ['title', 'need', 'doneWhen', 'carrier', 'outward', 'links', 'recommendation', 'due', 'projectKey'] as const;

export class WorkBoardService {
  private records: FoldRecord[] = [];
  private byCard = new Map<string, FoldRecord[]>();
  private policies: FoldRecord[] = [];
  private views = new Map<string, { card: CardFold; pickups: PickupState[] }>();
  private keys = new Set<string>();
  /** Capacity-wait bookkeeping (in memory on the acting machine, §Multi-machine). */
  readonly capacityWait = new Map<string, { since: number; nextCheckAt: number; delayMs: number; reason: string; checkedAt?: number }>();

  constructor(private readonly deps: WorkBoardDeps) {}

  // ── index ────────────────────────────────────────────────────────────────

  rebuild(): void {
    this.records = toFoldRecords(this.deps.loadUnion());
    this.keys = new Set(this.records.map((r) => r.id));
    const { byCard, policies } = partitionRecords(this.records);
    this.byCard = byCard; this.policies = policies;
    this.views.clear();
    for (const id of byCard.keys()) this.refold(id);
  }

  /** Apply committed entries (own or a peer's) to the index. Returns the card ids that changed. */
  apply(entries: UnionEntry[]): string[] {
    const fresh = toFoldRecords(entries).filter((r) => !this.keys.has(r.id) || this.replaces(r));
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
  }

  cardIds(): string[] { return [...this.views.keys()]; }
  policy(): ApprovalPolicy { const last = this.policies[this.policies.length - 1]; return last && last.d.policy === 'outward-only' ? 'outward-only' : 'every-agent-card'; }
  recordsOf(cardId: string): FoldRecord[] { return this.byCard.get(cardId) ?? []; }
  policyRecords(): FoldRecord[] { return this.policies; }
  newestHlc(): HlcTimestamp | null { return this.records.length ? this.records[this.records.length - 1].hlc : null; }
  totalRecords(): number { return this.records.length; }

  view(cardId: string): CardView | null {
    const v = this.views.get(cardId);
    if (!v) return null;
    const s = this.deps.settings();
    const now = this.deps.now();
    const active = v.pickups.filter((p) => p.status === 'pending' || p.status === 'parked');
    const parked = active.some((p) => p.status === 'parked');
    const status = deriveStatus(v.card, { pendingOrParked: active.length > 0, parked }, now, s.quietAfterHours);
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
    return laneFor(v.status, viewer.isOwner, v.card, viewer.personKey, v.capacityWaitSurfaced);
  }

  /** The conversation keys of archived or removed cards (the conversation lists leave these out, §2). */
  hiddenConversationKeys(): Set<string> {
    const out = new Set<string>();
    for (const [, v] of this.views) if (v.card.archives.length || v.card.redacted) out.add(v.card.conversationKey);
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

  private byOf(p: WorkPrincipal): By {
    return p.kind === 'person' ? { kind: 'person', personKey: p.personKey, proof: p.proof } : { kind: 'agent' };
  }

  private textFields(fields: Record<string, unknown>): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    const push = (k: string, v: unknown) => { if (typeof v === 'string') out.push([k, v]); };
    for (const k of ['title', 'need', 'recommendation', 'reason', 'text', 'answer'] as const) push(k, fields[k]);
    if (Array.isArray(fields.doneWhen)) (fields.doneWhen as Array<Record<string, unknown>>).forEach((d, i) => push(`doneWhen[${i}].text`, d?.text));
    if (Array.isArray(fields.links)) (fields.links as Array<Record<string, unknown>>).forEach((l, i) => { push(`links[${i}].label`, l?.label); push(`links[${i}].url`, l?.url); });
    const q = fields.question as Record<string, unknown> | undefined;
    if (q) { push('question.text', q.text); if (Array.isArray(q.options)) (q.options as unknown[]).forEach((o, i) => push(`question.options[${i}]`, o)); }
    // Identifier-shaped free strings are checked too: nothing a caller types lands unchecked.
    const src = fields.source as Record<string, unknown> | undefined;
    if (src) { push('source.conversationKey', src.conversationKey); push('source.messageId', src.messageId); }
    push('projectKey', fields.projectKey);
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
    const checks: Array<Refusal | null> = [over('title', fields.title, L.title), over('need', fields.need, L.need), over('recommendation', fields.recommendation, L.recommendation)];
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
  private write(recordType: WorkRecordType, cardId: string | null, fields: Record<string, unknown>, recordKey?: string): Result<{ recordId: string; data: Record<string, unknown> }> {
    const key = recordKey ?? mintRecordKey(recordType, cardId, { for: fields.for as string | undefined, attempt: fields.attempt as number | undefined, outcome: fields.outcome as string | undefined });
    // Shape check BEFORE the emit, with the store's own schema: a malformed write is the caller's
    // mistake (400, with the kind named), never "the store is unavailable" (which invites a blind retry).
    const probe = buildRecord(recordType, cardId, fields, key)({ physical: 0, logical: 0, node: this.deps.machineId }, this.deps.machineId);
    if (!probe || !workCardRecordStoreSchema.validate(probe, { countDroppedField: () => { /* counted by the envelope layer at the real write */ } } as never)) {
      return refuse(400, 'invalid-record', { recordType, message: 'The record is not in the shape the work board accepts. Check the field types: a need and a title are text, each done item needs an id and text, links are https, a due date is YYYY-MM-DD.' });
    }
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

  createCard(p: WorkPrincipal, input: Record<string, unknown>): Result<{ cardId: string; conversationKey: string; overSoftBudget?: { waiting: number; softOpenCards: number } }> {
    if (p.kind === 'session') return refuse(403, 'scoped-session-cannot-create');
    if (p.kind === 'person' && !p.isOwner) return refuse(403, 'owner-required');
    const fields: Record<string, unknown> = {};
    for (const k of CREATE_FIELDS) if (input[k] !== undefined) fields[k] = input[k];
    if (fields.carrier !== undefined) fields.carrier = this.resolveOwnerAlias(fields.carrier);
    if (Array.isArray(fields.doneWhen) && fields.doneWhen.length === 0) return refuse(400, 'done-item-required');
    if (!Array.isArray(fields.doneWhen)) return refuse(400, 'done-item-required');
    const owner = this.deps.ownerPersonKey();
    if (fields.carrier !== undefined && fields.carrier !== 'agent') {
      const ck = (fields.carrier as { personKey?: string })?.personKey;
      if (!owner || ck !== owner) return refuse(400, 'carrier-not-allowed', { message: 'In this phase a card is carried by the agent or by the team owner.' });
    }
    if (fields.outward === undefined) fields.outward = true; // default when unsure: true (Decision points)
    if (fields.carrier === undefined) fields.carrier = 'agent';
    const t = this.checkText(fields); if (t) return t;
    const linkErr = this.checkAttachmentLinks(undefined, fields.links); if (linkErr) return linkErr;
    if (p.kind === 'agent') {
      const s = this.deps.settings();
      const { day, resetsAt } = this.deps.dayOf(this.deps.now());
      if (this.agentCardsCreatedOn(day) >= s.maxAgentCardsPerDay) {
        return refuse(429, 'daily-card-ceiling', { limit: s.maxAgentCardsPerDay, resetsAt, waysThrough: ['the team owner raises the limit on the Work page', 'the team owner writes the card (person-written cards are not counted)'] });
      }
    }
    const cardId = newCardId();
    const w = this.write('created', cardId, { ...fields, by: this.byOf(p), at: new Date(this.deps.now()).toISOString() });
    if (!w.ok) return w;
    return { ok: true, cardId, conversationKey: cardConversationKey(cardId), ...this.softBudget() };
  }

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

  private guardCard(p: WorkPrincipal, cardId: string): Refusal | { v: CardView } {
    if (!isCardId(cardId)) return refuse(404, 'not-found');
    const v = this.view(cardId);
    if (!v || !v.card.created) return refuse(404, 'not-found');
    if (p.kind === 'session' && p.conversationKey !== v.card.conversationKey) return refuse(404, 'not-found');
    if (v.card.redacted) return refuse(409, 'card-removed');
    return { v };
  }

  edit(p: WorkPrincipal, cardId: string, input: Record<string, unknown>): Result<{ recordId: string; changed: string[] }> {
    if (p.kind === 'person' && !p.isOwner) return refuse(403, 'owner-required');
    const g = this.guardCard(p, cardId); if ('ok' in g) return g;
    const card = g.v.card;
    const changed: Record<string, unknown> = {};
    for (const k of EDIT_FIELDS) {
      if (input[k] === undefined) continue;
      const next = k === 'carrier' ? this.resolveOwnerAlias(input[k]) : input[k];
      const cur = (card as unknown as Record<string, unknown>)[k];
      if (!sameValue(cur ?? null, next)) changed[k] = next;
    }
    const names = Object.keys(changed);
    if (!names.length) return { ok: true, recordId: '', changed: [] };
    const material = names.filter((n) => (MATERIAL_FIELDS as ReadonlyArray<string>).includes(n));
    if (p.kind !== 'person' && material.length && card.done) return refuse(409, 'reopen-required', { message: 'A finished card can be unfinished only by a person.' });
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

  addEvidence(p: WorkPrincipal, cardId: string, input: { itemId?: unknown; text?: unknown; attachmentIds?: unknown }): Result<{ evidenceId: string }> {
    if (p.kind === 'person') return refuse(403, 'agent-only');
    const g = this.guardCard(p, cardId); if ('ok' in g) return g;
    const card = g.v.card;
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
    const w = this.write('evidence', cardId, { ...fields, by: this.byOf(p), at: new Date(this.deps.now()).toISOString() });
    if (!w.ok) return w;
    return { ok: true, evidenceId: w.recordId };
  }

  claimDone(p: WorkPrincipal, cardId: string): Result<{ claimId: string; needsConfirm: boolean }> {
    if (p.kind === 'person') return refuse(403, 'agent-only');
    const g = this.guardCard(p, cardId); if ('ok' in g) return g;
    const card = g.v.card;
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
    const w = this.write('claimed-done', cardId, { materialHash: card.materialHash, reopens: card.reopens, evidenceIds, by: this.byOf(p), at: new Date(this.deps.now()).toISOString() });
    if (!w.ok) return w;
    const after = this.view(cardId);
    return { ok: true, claimId: w.recordId, needsConfirm: !!after?.card.needsConfirm };
  }

  /**
   * A person's tap (§4). Permitting taps are checked against the current card and refused
   * `stale-card` (or `question-replaced`) when what they bind to is not current; restricting
   * taps are always accepted. The fold applies the same test and is the authority.
   */
  tap(p: WorkPrincipal, cardId: string, input: { action?: unknown; materialHash?: unknown; questionId?: unknown; answer?: unknown; claimId?: unknown; retryOf?: unknown; names?: unknown; titleHash?: unknown }): Result<{ recordId: string }> {
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
      case 'hold': case 'withdraw-approval': case 'archive': case 'redact': break;
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
    for (const [, v] of this.views) { const t = v.card.createdAt ? Date.parse(v.card.createdAt) : NaN; if (Number.isFinite(t) && (first === null || t < first)) first = t; }
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
    for (const [id, v] of this.views) {
      if (!v.card.createdAt || Date.parse(v.card.createdAt) < since) continue;
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
      parks: parks.slice(0, 50), medianAskToTapMs: median, agentAttestedFinishes: agentAttested, agentAttestedReopened,
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
        case 'archive': return `Work board: archived by ${who}`;
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
