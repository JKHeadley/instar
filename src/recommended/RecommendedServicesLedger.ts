/**
 * The record of a person's choices about recommended outside services
 * (docs/specs/recommended-services.md).
 *
 * Append-only and signed per row by the writing machine's identity key, because auth tokens
 * differ between machines. Rows replicate as the `recommendedServices` store and fold into one
 * effective choice: a no stands until a yes names it in `supersedes`, so delayed replication
 * and clock skew cannot undo a refusal. Imported legacy declines only suppress offers. They
 * never count in the merge and never stop a running service.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ledgerRowPayload, readJsonlLines, verifyMachineSignature,
  type MachineKeyLookup, type MachineSigner,
} from '../core/AppRecordSignatures.js';

export const NO_REASONS = ['cost', 'privacy', 'not-needed', 'have-another', 'other', 'none'] as const;
export type NoReason = (typeof NO_REASONS)[number];
export const CHOICE_ORIGINS = ['first-offer', 'change', 'cool-off', 'person-asked', 'owner-surface'] as const;
export type ChoiceOrigin = (typeof CHOICE_ORIGINS)[number] | `event:${string}`;

interface RowSignature { machineId: string; signerKeyHash: string; sig: string }

export interface ChoiceRow extends RowSignature {
  type: 'choice';
  eventId: string;
  service: string;
  choice: 'yes' | 'no';
  shutdown: 'none' | 'authorized';
  reason: NoReason;
  origin: ChoiceOrigin;
  offerTextHash: string;
  supersedes: string[];
  at: string;
  /** On a yes: the machine it authorizes setup on. The yes is the grant, so neither can exist alone. */
  grantMachine?: string;
  /** On a yes: the owner it was confirmed for. Today's PIN can't prove who typed it. */
  principal?: string;
  /** On a yes: every no its writer knew of. A no outside this list came later, whatever the clocks say. */
  knownNos?: string[];
}

export interface LegacyImportRow extends RowSignature {
  type: 'legacy-import';
  eventId: string;
  service: string;
  at: string;
}

/**
 * One offer of a service to an owner (docs/specs/recommended-services.md, Offers: "sent once"). `pending`
 * is written before the send; `offered` only once the platform returned a message id for it. A service with
 * an `offered` row for this owner is never offered again. A `pending` row with no `offered` row is resumed
 * (sent again) until it is a week old, and then released. Offer rows never touch the choice fold.
 */
export interface OfferRow extends RowSignature {
  type: 'offer';
  eventId: string;
  service: string;
  owner: string;
  /** Every row sent in one message shares a list id. */
  listId: string;
  state: 'pending' | 'offered';
  origin: 'first-offer';
  messageId?: string;
  at: string;
}

export type LedgerRow = ChoiceRow | LegacyImportRow | OfferRow;

export type OfferState = 'none' | 'pending' | 'offered';
/** A pending offer older than this is treated as never sent. */
export const OFFER_PENDING_TTL_MS = 7 * 24 * 60 * 60_000;
/** At most one list a week per owner. */
export const OFFER_LIST_EVERY_MS = 7 * 24 * 60 * 60_000;

export interface EffectiveChoice {
  service: string;
  choice: 'unset' | 'yes' | 'no';
  origin: ChoiceOrigin | null;
  /** A no refuses offers. Only an authorized shutdown stops a running service. */
  shutdown: 'none' | 'authorized';
  reason: NoReason | null;
  /** An imported legacy decline: suppresses offers, grants and stops nothing. */
  legacyDeclined: boolean;
  at: string | null;
}

const SERVICE_RE = /^[a-z][a-z0-9-]{0,63}$/;
const ID_RE = /^[0-9a-f]{32}$/;
const ORIGIN_RE = /^event:[a-z][a-z0-9-]{0,63}$/;
const MAX_ROWS = 10_000;

function signature(r: Record<string, unknown>): RowSignature | null {
  const { machineId, signerKeyHash, sig } = r;
  if (typeof machineId !== 'string' || !machineId || machineId.length > 128) return null;
  if (typeof signerKeyHash !== 'string' || !signerKeyHash || signerKeyHash.length > 128) return null;
  if (typeof sig !== 'string' || !sig || sig.length > 512) return null;
  return { machineId, signerKeyHash, sig };
}

/** Validate a row's shape, not its signature. Exact fields only. */
export function validateRow(raw: unknown): LedgerRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const s = signature(r);
  if (!s) return null;
  const { eventId, service, at } = r;
  if (typeof eventId !== 'string' || !ID_RE.test(eventId)) return null;
  if (typeof service !== 'string' || !SERVICE_RE.test(service)) return null;
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) return null;
  if (r.type === 'legacy-import') return { type: 'legacy-import', eventId, service, at, ...s };
  if (r.type === 'offer') {
    const { owner, listId, state, origin, messageId } = r;
    if (typeof owner !== 'string' || !owner || owner.length > 128) return null;
    if (typeof listId !== 'string' || !ID_RE.test(listId)) return null;
    if (state !== 'pending' && state !== 'offered') return null;
    if (origin !== 'first-offer') return null;
    if (messageId !== undefined && (typeof messageId !== 'string' || !messageId || messageId.length > 64)) return null;
    if (state === 'offered' && messageId === undefined) return null;
    return { type: 'offer', eventId, service, owner, listId, state, origin, at, ...(messageId === undefined ? {} : { messageId }), ...s };
  }
  if (r.type !== 'choice') return null;
  const { choice, shutdown, reason, origin, offerTextHash, supersedes } = r;
  if (choice !== 'yes' && choice !== 'no') return null;
  if (shutdown !== 'none' && shutdown !== 'authorized') return null;
  if (!NO_REASONS.includes(reason as NoReason)) return null;
  if (typeof origin !== 'string') return null;
  if (!(CHOICE_ORIGINS as readonly string[]).includes(origin) && !ORIGIN_RE.test(origin)) return null;
  if (typeof offerTextHash !== 'string' || offerTextHash.length > 128) return null;
  if (!Array.isArray(supersedes) || supersedes.length > 256) return null;
  if (!supersedes.every((id) => typeof id === 'string' && ID_RE.test(id))) return null;
  const { grantMachine, principal, knownNos } = r;
  if (grantMachine !== undefined || principal !== undefined || knownNos !== undefined) {
    if (choice !== 'yes') return null;
    for (const v of [grantMachine, principal]) {
      if (typeof v !== 'string' || !v || v.length > 128) return null;
    }
    if (!Array.isArray(knownNos) || knownNos.length > MAX_ROWS) return null;
    if (!knownNos.every((id) => typeof id === 'string' && ID_RE.test(id))) return null;
  }
  return {
    type: 'choice', eventId, service, choice, shutdown, reason: reason as NoReason,
    origin: origin as ChoiceOrigin, offerTextHash, supersedes: supersedes as string[], at,
    ...(grantMachine === undefined ? {} : { grantMachine: grantMachine as string, principal: principal as string, knownNos: knownNos as string[] }),
    ...s,
  };
}

/** One effective choice per service. A pure fold, so every machine reaches the same answer. */
export function foldChoice(service: string, rows: readonly LedgerRow[]): EffectiveChoice {
  const own = rows.filter((r) => r.service === service);
  const choices = own.filter((r): r is ChoiceRow => r.type === 'choice');
  const replaced = new Set(choices.filter((c) => c.choice === 'yes').flatMap((c) => c.supersedes));
  const byNewest = (a: ChoiceRow, b: ChoiceRow) => (a.at === b.at ? (a.eventId < b.eventId ? 1 : -1) : a.at < b.at ? 1 : -1);
  const liveNos = choices.filter((c) => c.choice === 'no' && !replaced.has(c.eventId)).sort(byNewest);
  const yeses = choices.filter((c) => c.choice === 'yes').sort(byNewest);
  const legacyDeclined = own.some((r) => r.type === 'legacy-import');
  const winner = liveNos[0] ?? yeses[0];
  if (!winner) return { service, choice: 'unset', origin: null, shutdown: 'none', reason: null, legacyDeclined, at: null };
  const shutdown = liveNos.some((n) => n.shutdown === 'authorized') ? 'authorized' : 'none';
  return {
    service, choice: winner.choice, origin: winner.origin,
    shutdown: winner.choice === 'no' ? shutdown : 'none',
    reason: winner.choice === 'no' ? winner.reason : null, legacyDeclined, at: winner.at,
  };
}

export function recommendedServicesDir(stateDir: string): string {
  return path.join(stateDir, 'state', 'recommended-services');
}

export type IngestResult = 'added' | 'duplicate' | 'invalid' | 'bad-signature' | 'unverifiable' | 'full';

export interface RecommendedServicesLedgerOptions {
  stateDir: string;
  signer: MachineSigner;
  keyLookup: MachineKeyLookup;
  now?: () => Date;
}

export class RecommendedServicesLedger {
  private readonly file: string;
  private readonly rows = new Map<string, LedgerRow>();
  private hook: ((row: LedgerRow) => void) | null = null;
  private replicating = false;

  constructor(private readonly opts: RecommendedServicesLedgerOptions) {
    this.file = path.join(recommendedServicesDir(opts.stateDir), 'ledger.jsonl');
    for (const line of readJsonlLines(this.file)) {
      try {
        const row = validateRow(JSON.parse(line));
        if (row) this.rows.set(row.eventId, row);
      } catch { /* @silent-fallback-ok — one torn line; the row is re-read from peer streams at boot */ }
    }
  }

  setReplicationHook(hook: (row: LedgerRow) => void): void {
    this.hook = hook;
  }

  /** Set by the server from the store's real state: its emission is on, and peers pull. */
  setReplicating(on: boolean): void {
    this.replicating = on;
  }

  /** False when choices stay on this machine. */
  isReplicating(): boolean {
    return this.replicating;
  }

  all(): LedgerRow[] {
    return [...this.rows.values()];
  }

  effective(service: string): EffectiveChoice {
    return foldChoice(service, this.all());
  }

  /** The person's no. Sticky until a confirmed yes names it. */
  recordNo(input: { service: string; shutdown: 'none' | 'authorized'; reason: NoReason; origin: ChoiceOrigin; offerTextHash?: string }): ChoiceRow {
    return this.appendChoice({ ...input, choice: 'no', supersedes: [] });
  }

  /** A confirmed yes replaces every no standing at this moment, and only those. */
  recordYes(input: { service: string; origin: ChoiceOrigin; offerTextHash: string; grantMachine: string; principal: string }): ChoiceRow {
    const replaced = new Set(this.all().flatMap((r) => (r.type === 'choice' && r.choice === 'yes' ? r.supersedes : [])));
    const supersedes = this.all()
      .filter((r): r is ChoiceRow => r.type === 'choice' && r.service === input.service && r.choice === 'no' && !replaced.has(r.eventId))
      .map((r) => r.eventId);
    return this.appendChoice({ ...input, choice: 'yes', shutdown: 'none', reason: 'none', supersedes, knownNos: this.knownNoIds(input.service) });
  }

  /**
   * The yes that authorizes setup on this machine, if one still stands. A recipe needs it to run or
   * resume. Every no for the service must be one that yes knew about, so a later no voids it even if
   * another yes replaced that no, and clock skew can't bring it back.
   */
  activeGrant(service: string, machineId: string): ChoiceRow | null {
    if (this.effective(service).choice !== 'yes') return null;
    const nos = this.knownNoIds(service);
    const standing = this.all().filter((r): r is ChoiceRow => r.type === 'choice' && r.service === service && r.choice === 'yes'
      && r.grantMachine === machineId && nos.every((id) => r.knownNos?.includes(id)));
    return standing.sort((a, b) => (a.at === b.at ? (a.eventId < b.eventId ? 1 : -1) : a.at < b.at ? 1 : -1))[0] ?? null;
  }

  /** Every no this machine knows of for a service, standing or replaced. */
  knownNoIds(service: string): string[] {
    return this.all().filter((r): r is ChoiceRow => r.type === 'choice' && r.service === service && r.choice === 'no').map((r) => r.eventId);
  }

  /** The machine writing here, which is the machine a confirm page's yes authorizes. */
  machineId(): string {
    return this.opts.signer.machineId();
  }

  /** Idempotent per service: one import row is enough, whichever machine wrote it. */
  recordLegacyImport(service: string): LegacyImportRow | null {
    if (this.all().some((r) => r.type === 'legacy-import' && r.service === service)) return null;
    return this.signAndStore({ type: 'legacy-import', eventId: newId(), service, at: this.at() }) as LegacyImportRow;
  }

  /** Written before a list is sent, so a crash between send and record repeats at most this one offer. */
  recordOfferPending(input: { service: string; owner: string; listId: string }): OfferRow {
    return this.signAndStore({ type: 'offer', eventId: newId(), service: input.service, owner: input.owner, listId: input.listId, state: 'pending', origin: 'first-offer', at: this.at() }) as OfferRow;
  }

  /** Written only from the platform's own message id: the proof the offer reached the person. */
  recordOfferDelivered(input: { service: string; owner: string; listId: string; messageId: string | number }): OfferRow {
    return this.signAndStore({ type: 'offer', eventId: newId(), service: input.service, owner: input.owner, listId: input.listId, state: 'offered', origin: 'first-offer', messageId: String(input.messageId), at: this.at() }) as OfferRow;
  }

  offerRows(owner?: string): OfferRow[] {
    return this.all().filter((r): r is OfferRow => r.type === 'offer' && (owner === undefined || r.owner === owner));
  }

  /** `offered` once any delivery row exists; `pending` while a recent pending row has no delivery; else `none`. */
  offerState(service: string, owner: string, nowMs: number = this.opts.now?.()?.getTime() ?? Date.now()): OfferState {
    const rows = this.offerRows(owner).filter((r) => r.service === service);
    if (rows.some((r) => r.state === 'offered')) return 'offered';
    if (rows.some((r) => r.state === 'pending' && nowMs - Date.parse(r.at) < OFFER_PENDING_TTL_MS)) return 'pending';
    return 'none';
  }

  /** The pending rows a new lease holder (or this one, after a failed send) must send again, by list. */
  pendingOffers(owner: string, nowMs: number = this.opts.now?.()?.getTime() ?? Date.now()): OfferRow[] {
    return this.offerRows(owner).filter((r) => r.state === 'pending' && this.offerState(r.service, owner, nowMs) === 'pending');
  }

  /** When the newest list was sent to this owner, or null. Pending rows count: a list in flight is a list. */
  lastListAt(owner: string): number | null {
    const ats = this.offerRows(owner).map((r) => Date.parse(r.at)).filter((n) => Number.isFinite(n));
    return ats.length ? Math.max(...ats) : null;
  }

  /** A peer's row lands only when it verifies under the pinned key of the machine it names. */
  ingestReplicated(raw: unknown): IngestResult {
    const row = validateRow(raw);
    if (!row) return 'invalid';
    if (this.rows.has(row.eventId)) return 'duplicate';
    if (this.rows.size >= MAX_ROWS) return 'full';
    const { sig, ...unsigned } = row;
    const verdict = verifyMachineSignature(
      this.opts.keyLookup,
      { machineId: row.machineId, signerKeyHash: row.signerKeyHash, sig },
      ledgerRowPayload(unsigned),
      Date.parse(row.at),
    );
    if (verdict === 'bad') return 'bad-signature';
    if (verdict !== 'ok') return 'unverifiable';
    this.store(row);
    return 'added';
  }

  private appendChoice(input: Omit<ChoiceRow, keyof RowSignature | 'type' | 'eventId' | 'at' | 'offerTextHash'> & { offerTextHash?: string }): ChoiceRow {
    return this.signAndStore({
      type: 'choice', eventId: newId(), service: input.service, choice: input.choice, shutdown: input.shutdown,
      reason: input.reason, origin: input.origin, offerTextHash: input.offerTextHash ?? '', supersedes: input.supersedes, at: this.at(),
      ...(input.grantMachine === undefined ? {} : { grantMachine: input.grantMachine, principal: input.principal, knownNos: input.knownNos }),
    }) as ChoiceRow;
  }

  private signAndStore(fields: Record<string, unknown>): LedgerRow {
    const unsigned = { ...fields, machineId: this.opts.signer.machineId(), signerKeyHash: this.opts.signer.signerKeyHash() };
    const { sig } = this.opts.signer.sign(ledgerRowPayload(unsigned));
    const row = validateRow({ ...unsigned, sig });
    if (!row) throw new Error('recommended-services: refused to write a malformed row');
    this.store(row);
    this.hook?.(row);
    return row;
  }

  private store(row: LedgerRow): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`);
    this.rows.set(row.eventId, row);
  }

  private at(): string {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }
}

function newId(): string {
  return crypto.randomBytes(16).toString('hex');
}
