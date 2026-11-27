/**
 * The trust journey's authority store (trust-journey spec, Multi-machine posture): one replicated
 * store, `trustJourney`, one kind, `trust-grant-record`. It holds requests, platform receipts,
 * acceptances, consumptions and the durable trust change log. Records are immutable; the index
 * folds them.
 *
 * Persistence is a sink. Where the coherence journal runs, records go through the replicated
 * emitter, so every machine applies the same stream. Where it does not (a single machine with the
 * journal off), a local append-only file is the sink. An emitter answer other than `emitted` is a
 * failed write, never a silent one.
 *
 * The reader rule (spec 6a): a record whose `minReader` is above this build's reader version, or
 * that carries a field this build does not know, is treated as absent for permission and kept as
 * evidence. A record that only restricts is never dropped for being unreadable; the caller treats an
 * unreadable change as "Ask me first".
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { StoreFieldSchema } from '../ReplicatedRecordEnvelope.js';
import type { AcceptanceRecord, AdapterKind, Receipt, RequestRecord } from './accountPath.js';

export const TRUST_GRANT_RECORD_KIND = 'trust-grant-record';
export const TRUST_JOURNEY_STORE_KEY = 'trustJourney';
/** The highest `minReader` this build understands. */
export const TRUST_READER_VERSION = 1;

export const TRUST_RECORD_TYPES = ['request', 'request-status', 'receipt', 'acceptance-sent', 'acceptance', 'acceptance-withdrawn', 'consumption', 'change', 'legacy-grant', 'action-approval', 'dispatch',
  // Approving from the Instar app (docs/specs/app-trust-approval.md): a device's acceptance, its
  // withdrawal, an accepted device's approval of a new device, and the outcome of an applied raise.
  'device-acceptance', 'device-acceptance-withdrawn', 'device-approval', 'apply-outcome',
  // Delivery metadata only: an older reader's schema rejects this unknown record type and its
  // fold has no matching case. The original request and approval checks remain valid; no grant,
  // acceptance or consumption meaning changes, so this does not raise minReader.
  'request-carrier'] as const;
export type TrustRecordType = typeof TRUST_RECORD_TYPES[number];

/** A change the person can approve, as structured data the server renders and hashes. */
export type TrustChange =
  | { kind: 'trust-grant'; service: string; operation: 'read' | 'write' | 'modify' | 'delete'; level: string }
  | { kind: 'autonomy-profile'; from: string; to: string }
  | { kind: 'config-patch'; patch: Record<string, unknown>; /** Hash of the settings it was written against (the expected revision). */ basedOn?: string }
  | { kind: 'slack-role'; slackUserId: string; displayName: string; role: string; mode: 'register' | 'approve' }
  | { kind: 'board-policy'; policy: string }
  | { kind: 'trust-recovery'; incidentId: string }
  /** One exact action, once (spec section 2, the ask): bound to its action identity. */
  | { kind: 'one-action'; actionIdentity: string; toolName: string; effectKind: string; input: string };

export interface ChangeLogRecord {
  changeId: string;
  /** What changed: for a trust level, `${service}.${operation}`. */
  key: string;
  from: string | null;
  to: string;
  direction: 'raise' | 'lower' | 'same';
  /** The consumption that proved a raise; absent for a narrowing. */
  consumptionId?: string;
  source: string;
  at: string;
  minReader: number;
}

export interface ConsumptionRecord {
  consumptionId: string;
  requestId: string;
  receiptId: string;
  acceptanceId: string;
  proposalHash: string;
  principal: string;
  at: string;
  /** Present on a device approval: `accepted-device`, with the approving device. Absent on the chat path. */
  kind?: 'accepted-device';
  deviceId?: string;
}

/**
 * A paired device's recorded acceptance (app-trust-approval §A): its approvals count for `principal`
 * while it is current. It belongs to one key: the device key fingerprint and the presence key's hash.
 */
export interface DeviceAcceptanceRecord {
  acceptanceId: string;
  principal: string;
  deviceId: string;
  /** The device key's fingerprint (`deviceFingerprint`, the one shown at pairing). */
  keyFingerprint: string;
  /** SHA-256 hex of the presence key the device approves with. */
  presenceKeyHash: string;
  /** The presence key's access policy, as the app reports it. */
  keyPolicy: 'biometryCurrentSet' | 'userPresence';
  /** SHA-256 hex of the disclosure text the app showed. */
  disclosureHash: string;
  /** How it was allowed: the first local pairing, another accepted device's approval, or the local key replacement. */
  via: 'local-install' | 'accept-device' | 'local-override';
  /** For `accept-device`: the approval it used (single use). */
  approvalId?: string;
  acceptedAt: string;
  withdrawnAt?: string;
}

/** An accepted device's approval of a new device's acceptance (single use, short-lived). */
export interface DeviceApprovalRecord {
  approvalId: string;
  approverDeviceId: string;
  approverAcceptanceId: string;
  deviceId: string;
  keyFingerprint: string;
  disclosureHash: string;
  expiresAt: string;
  at: string;
}

/** A device delivery marker, bound to an existing immutable request rather than replacing it. */
interface RequestCarrierRecord {
  requestId: string;
  principal: string;
  proposalHash: string;
  expiresAt: string;
  adapter: 'device';
}

/** What happened after a consumption: written once the apply returns. A consumption without one is `unknown`. */
export interface ApplyOutcomeRecord {
  requestId: string;
  consumptionId: string;
  outcome: 'applied' | 'not-applied';
  detail?: string;
  at: string;
}

const KNOWN = new Set([
  'recordType', 'recordKey', 'hlc', 'op', 'origin', 'observed', 'at', 'minReader',
  // request
  'requestId', 'code', 'proposalHash', 'principal', 'adapter', 'approverPlatformId', 'cardMessageId', 'cardChatId',
  'expiresAt', 'status', 'change', 'summary',
  // receipt
  'receiptId', 'senderId', 'chatId', 'chatType', 'messageId', 'replyToMessageId', 'text', 'senderIsBot', 'forwarded',
  'uniqueKey', 'receivedAt', 'receivedBy',
  // acceptance
  'acceptanceId', 'accountId', 'acceptedAt', 'withdrawnAt', 'statementMessageId',
  // consumption / change
  'consumptionId', 'changeId', 'key', 'from', 'to', 'direction', 'source',
  // legacy grants, one-action approvals, dispatches
  'machine', 'behaviour', 'actionIdentity', 'approvalId', 'afterChange',
  // device acceptances, device approvals, apply outcomes (app-trust-approval)
  'deviceId', 'keyFingerprint', 'presenceKeyHash', 'keyPolicy', 'disclosureHash', 'via', 'approverDeviceId',
  'approverAcceptanceId', 'reason', 'outcome', 'detail', 'kind',
]);

const str = (v: unknown, max = 4000): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Envelope-store schema: shape checks only; the index applies the reader rule. */
export const trustGrantRecordStoreSchema: StoreFieldSchema = {
  knownFields: [...KNOWN].filter((k) => !['recordKey', 'hlc', 'op', 'origin', 'observed'].includes(k)),
  validate(raw) {
    if (raw.op === 'delete') return null; // immutable
    const t = raw.recordType;
    if (typeof t !== 'string' || !(TRUST_RECORD_TYPES as readonly string[]).includes(t)) return null;
    if (!str(raw.at, 40)) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) if (!['recordKey', 'hlc', 'op', 'origin', 'observed'].includes(k)) out[k] = v;
    return out;
  },
};

export const TRUST_GRANT_KIND_REGISTRATION = { kind: TRUST_GRANT_RECORD_KIND, store: TRUST_JOURNEY_STORE_KEY, schema: trustGrantRecordStoreSchema } as const;

export type TrustRecord = Record<string, unknown> & { recordType: TrustRecordType; at: string };

/** Where records are written. `append` resolves to true only when the record is durable. */
export interface TrustRecordSink {
  append(recordKey: string, rec: TrustRecord): Promise<boolean>;
  loadAll(): TrustRecord[];
  readonly description: string;
}

/** Local append-only file, fsynced per write. Used where the coherence journal is off. */
export class LocalFileTrustSink implements TrustRecordSink {
  readonly description: string;
  constructor(private readonly file: string) { this.description = `local file ${path.basename(file)}`; }
  async append(recordKey: string, rec: TrustRecord): Promise<boolean> {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const fd = fs.openSync(this.file, 'a', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ ...rec, recordKey }) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      return true;
    } catch { // @silent-fallback-ok: the caller treats false as a failed write and refuses the action
      return false;
    }
  }
  loadAll(): TrustRecord[] {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; } // @silent-fallback-ok: no file yet is an empty store
    const out: TrustRecord[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r && typeof r === 'object' && typeof r.recordType === 'string') out.push(r); } catch { /* @silent-fallback-ok: torn trailing line after a crash */ }
    }
    return out;
  }
}

/** The index: every fold is over immutable records, rebuilt at boot and updated on each commit. */
export class TrustJourneyStore {
  private records = new Map<string, TrustRecord>();
  private requests = new Map<string, RequestRecord & { change: TrustChange; summary: string[] }>();
  // Keep raw base/card records above for chat receipt verification. Markers may arrive first,
  // but are never requests themselves. Keep each marker so a mismatched one cannot shadow a
  // matching one merely because replication presented it later.
  private requestCarriers = new Map<string, RequestCarrierRecord[]>();
  private receiptsByKey = new Map<string, Receipt>();
  private consumedReceiptKeys = new Set<string>();
  /** Used state from consumption records, independent of load order (a consumption may fold first). */
  private consumedReceiptIds = new Set<string>();
  private consumedRequestIds = new Set<string>();
  /** Terminal request states from request-status records, also order-independent. */
  private closedRequests = new Map<string, RequestRecord['status']>();
  private withdrawnAcceptanceIds = new Set<string>();
  private acceptances = new Map<string, AcceptanceRecord>();
  private acceptanceSent = new Map<string, { statementMessageId: string; at: string }>();
  private consumptions = new Map<string, ConsumptionRecord>();
  private changes: ChangeLogRecord[] = [];
  /** Legacy grants by kind key: the machines whose gate config defines today's behaviour. */
  private legacy = new Map<string, Array<{ machine: string; behaviour: string; at: string; afterChange: string | null }>>();
  private deviceAcceptances = new Map<string, DeviceAcceptanceRecord>();
  private deviceApprovals = new Map<string, DeviceApprovalRecord>();
  /** Device approvals already used by an acceptance (order-independent). */
  private usedDeviceApprovals = new Set<string>();
  private outcomes = new Map<string, ApplyOutcomeRecord>();
  private consumptionByRequest = new Map<string, ConsumptionRecord>();
  private actionApprovals = new Map<string, Array<{ approvalId: string; consumptionId: string; expiresAt?: string }>>();
  private dispatchedApprovals = new Set<string>();
  /** Keys being written right now (reserved before the durable wait). */
  private pendingKeys = new Set<string>();
  /** Records kept as evidence but not used for permission (reader rule). */
  unreadable = 0;
  /** Keys whose change history holds a record this build cannot read: treated as "Ask me first". */
  private unreadableKeys = new Set<string>();

  constructor(private readonly sink: TrustRecordSink, private readonly now: () => Date = () => new Date()) {
    for (const r of sink.loadAll()) this.fold(String(r.recordKey ?? ''), r);
  }

  get sinkDescription(): string { return this.sink.description; }

  /** Applies records committed elsewhere (a peer, or this machine's own journal commit). */
  applyCommitted(records: Array<{ recordKey: string; data: Record<string, unknown> }>): void {
    for (const { recordKey, data } of records) this.fold(recordKey, data as TrustRecord);
  }

  private readable(r: TrustRecord): boolean {
    const mr = typeof r.minReader === 'number' ? r.minReader : 1;
    if (mr > TRUST_READER_VERSION) return false;
    for (const k of Object.keys(r)) if (!KNOWN.has(k)) return false;
    return true;
  }

  private fold(recordKey: string, r: TrustRecord): void {
    if (!recordKey || this.records.has(recordKey)) return;
    this.records.set(recordKey, r);
    if (!this.readable(r)) {
      this.unreadable++;
      if (r.recordType === 'change' && typeof r.key === 'string') this.unreadableKeys.add(r.key);
      // A record that only restricts is never dropped for being unreadable (spec 6a reader rule):
      // its restricting effect applies, keyed by id.
      if ((r.recordType === 'acceptance-withdrawn' || r.recordType === 'device-acceptance-withdrawn') && typeof r.acceptanceId === 'string') this.withdrawnAcceptanceIds.add(r.acceptanceId);
      // An unreadable acceptance grants nothing, but the approval it used stays used.
      if (r.recordType === 'device-acceptance' && typeof r.approvalId === 'string') this.usedDeviceApprovals.add(r.approvalId);
      if (r.recordType === 'consumption') {
        if (typeof r.receiptId === 'string') this.consumedReceiptIds.add(r.receiptId);
        if (typeof r.requestId === 'string') this.consumedRequestIds.add(r.requestId);
      }
      if (r.recordType === 'request-status' && typeof r.requestId === 'string') this.closedRequests.set(r.requestId, 'superseded');
      if (r.recordType === 'dispatch' && typeof r.approvalId === 'string') this.dispatchedApprovals.add(r.approvalId);
      if (r.recordType === 'request' && typeof r.requestId === 'string') this.closedRequests.set(r.requestId, 'superseded');
      return;
    }
    switch (r.recordType) {
      case 'request': {
        // The card record (with its message id) wins over the first write, in any load order.
        const prev = this.requests.get(r.requestId as string);
        if (prev && prev.cardMessageId && !r.cardMessageId) break;
        // SEC-141: a request's change and proposal hash are fixed by the first record seen for it. A
        // later record may add the card's message and chat ids, and only when it names the same hash;
        // it can never replace what the request would change.
        if (prev) {
          if (r.proposalHash !== prev.proposalHash) break;
          this.requests.set(r.requestId as string, { ...prev, cardMessageId: (r.cardMessageId as string) ?? prev.cardMessageId, cardChatId: (r.cardChatId as string) ?? prev.cardChatId });
          break;
        }
        this.requests.set(r.requestId as string, { ...(r as unknown as RequestRecord), change: r.change as TrustChange, summary: (r.summary as string[]) ?? [] });
        break;
      }
      case 'request-carrier': {
        if (r.adapter !== 'device' || !str(r.requestId) || !str(r.principal)
          || !str(r.proposalHash) || !str(r.expiresAt, 40)) break;
        const carriers = this.requestCarriers.get(r.requestId) ?? [];
        carriers.push({ requestId: r.requestId, principal: r.principal,
          proposalHash: r.proposalHash, expiresAt: r.expiresAt, adapter: 'device' });
        this.requestCarriers.set(r.requestId, carriers);
        break;
      }
      case 'request-status': {
        if (r.status !== 'open') this.closedRequests.set(r.requestId as string, r.status as RequestRecord['status']);
        break;
      }
      case 'receipt': this.receiptsByKey.set(r.uniqueKey as string, r as unknown as Receipt); break;
      case 'acceptance-sent': this.acceptanceSent.set(`${r.principal}|${r.adapter}`, { statementMessageId: r.statementMessageId as string, at: r.at }); break;
      case 'acceptance': this.acceptances.set(`${r.principal}|${r.adapter}`, r as unknown as AcceptanceRecord); break;
      case 'acceptance-withdrawn': this.withdrawnAcceptanceIds.add(r.acceptanceId as string); break;
      case 'consumption': {
        const c = r as unknown as ConsumptionRecord;
        this.consumptions.set(c.consumptionId, c);
        this.consumedReceiptIds.add(c.receiptId);
        this.consumedRequestIds.add(c.requestId);
        this.consumptionByRequest.set(c.requestId, c);
        break;
      }
      case 'device-acceptance': {
        const a = r as unknown as DeviceAcceptanceRecord;
        this.deviceAcceptances.set(a.acceptanceId, a);
        if (a.approvalId) this.usedDeviceApprovals.add(a.approvalId);
        break;
      }
      case 'device-acceptance-withdrawn': this.withdrawnAcceptanceIds.add(r.acceptanceId as string); break;
      case 'device-approval': { const a = r as unknown as DeviceApprovalRecord; this.deviceApprovals.set(a.approvalId, a); break; }
      case 'apply-outcome': {
        const o = r as unknown as ApplyOutcomeRecord;
        if (!this.outcomes.has(o.requestId)) this.outcomes.set(o.requestId, o);
        break;
      }
      case 'change': this.changes.push(r as unknown as ChangeLogRecord); break;
      case 'legacy-grant': {
        const list = this.legacy.get(r.key as string) ?? [];
        list.push({ machine: String(r.machine), behaviour: String(r.behaviour), at: r.at, afterChange: typeof r.afterChange === 'string' ? r.afterChange : null });
        this.legacy.set(r.key as string, list);
        break;
      }
      case 'action-approval': {
        const list = this.actionApprovals.get(r.actionIdentity as string) ?? [];
        list.push({ approvalId: String(r.approvalId), consumptionId: String(r.consumptionId), ...(typeof r.expiresAt === 'string' ? { expiresAt: r.expiresAt } : {}) });
        this.actionApprovals.set(r.actionIdentity as string, list);
        break;
      }
      case 'dispatch': this.dispatchedApprovals.add(r.approvalId as string); break;
    }
  }

  async write(recordType: TrustRecordType, fields: Record<string, unknown>, recordKey?: string): Promise<{ ok: boolean; recordKey: string }> {
    const key = recordKey ?? `tj:${recordType}:${crypto.randomBytes(8).toString('hex')}`;
    // Records are immutable: a second write to an existing key is a failed write, never a success.
    // The key is reserved before the durable wait, so two concurrent writers of one key (two
    // identical calls racing for one approval) cannot both succeed.
    if (this.records.has(key) || this.pendingKeys.has(key)) return { ok: false, recordKey: key };
    this.pendingKeys.add(key);
    const rec = { minReader: 1, ...fields, recordType, at: (fields.at as string) ?? this.now().toISOString() } as TrustRecord;
    let ok = false;
    try { ok = await this.sink.append(key, rec); } finally { this.pendingKeys.delete(key); }
    if (ok) this.fold(key, rec);
    return { ok, recordKey: key };
  }

  // ── reads ──
  private withStatus<T extends RequestRecord>(r: T): T {
    const status = this.consumedRequestIds.has(r.requestId) ? 'consumed' : (this.closedRequests.get(r.requestId) ?? r.status);
    return status === r.status ? r : { ...r, status };
  }
  /** Delivery metadata cannot replace request contents or supersede confirmed chat evidence. */
  private withCarrier<T extends RequestRecord>(r: T): T {
    const matches = !r.cardMessageId && this.requestCarriers.get(r.requestId)?.some((c) =>
      c.principal === r.principal && c.proposalHash === r.proposalHash && c.expiresAt === r.expiresAt);
    return matches && r.adapter !== 'device' ? { ...r, adapter: 'device' } : r;
  }
  request(id: string) { const r = this.requests.get(id); return r ? this.withStatus(this.withCarrier(r)) : null; }
  openRequests() { return this.allRequests().filter((r) => r.status === 'open'); }
  allRequests() { return [...this.requests.values()].map((r) => this.withStatus(this.withCarrier(r))); }
  requestByCode(code: string) { return this.openRequests().find((r) => r.code === code) ?? null; }
  requestByCard(adapter: AdapterKind, cardMessageId: string) { const r = [...this.requests.values()].find((x) => x.adapter === adapter && x.cardMessageId === cardMessageId); return r ? this.withStatus(r) : null; }
  codeTaken(code: string) { return [...this.requests.values()].some((r) => r.code === code); }
  receipt(uniqueKey: string) { return this.receiptsByKey.get(uniqueKey) ?? null; }
  receiptConsumed(uniqueKey: string) {
    if (this.consumedReceiptKeys.has(uniqueKey)) return true;
    const rec = this.receiptsByKey.get(uniqueKey);
    return !!rec && this.consumedReceiptIds.has(rec.receiptId);
  }
  acceptance(principal: string, adapter: AdapterKind): AcceptanceRecord | null {
    const a = this.acceptances.get(`${principal}|${adapter}`);
    return a && !a.withdrawnAt && !this.withdrawnAcceptanceIds.has(a.acceptanceId) ? a : null;
  }
  acceptanceStatementSent(principal: string, adapter: AdapterKind) { return this.acceptanceSent.get(`${principal}|${adapter}`) ?? null; }
  consumption(id: string) { return this.consumptions.get(id) ?? null; }
  /** The one consumption of a request (its key is `tj:consumption:<requestId>`), or null. */
  consumptionOf(requestId: string) { return this.consumptionByRequest.get(requestId) ?? null; }
  /** True while a consumption of this request is recorded or being written right now. */
  requestConsumedOrPending(requestId: string) { return this.consumedRequestIds.has(requestId) || this.pendingKeys.has(`tj:consumption:${requestId}`); }
  /** The apply outcome recorded after a request's consumption, or null (with a consumption: `unknown`). */
  applyOutcome(requestId: string) { return this.outcomes.get(requestId) ?? null; }

  // ── device acceptances (app-trust-approval §A) ──
  private deviceAcceptanceCurrent(a: DeviceAcceptanceRecord): boolean { return !a.withdrawnAt && !this.withdrawnAcceptanceIds.has(a.acceptanceId); }
  /** The device's acceptance on record that is not withdrawn (the latest), or null. Key checks are the caller's. */
  deviceAcceptance(deviceId: string): DeviceAcceptanceRecord | null {
    const mine = [...this.deviceAcceptances.values()].filter((a) => a.deviceId === deviceId && this.deviceAcceptanceCurrent(a));
    mine.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    return mine.length ? mine[mine.length - 1] : null;
  }
  /** Every device acceptance not withdrawn. */
  currentDeviceAcceptances(): DeviceAcceptanceRecord[] { return [...this.deviceAcceptances.values()].filter((a) => this.deviceAcceptanceCurrent(a)); }
  /** Every device acceptance ever recorded, with `withdrawn` (newest first), for the record the devices show. */
  deviceAcceptanceHistory(): Array<DeviceAcceptanceRecord & { withdrawn: boolean }> {
    return [...this.deviceAcceptances.values()].map((a) => ({ ...a, withdrawn: !this.deviceAcceptanceCurrent(a) }))
      .sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  }
  /** One fixed key for every candidate in the same first-device generation.
   * Pending writes deliberately do not advance it. They compete for this key.
   */
  firstDeviceAcceptanceKey(): string {
    let generation = this.deviceAcceptanceHistory().filter(acceptance => acceptance.via === 'local-install').length;
    while (this.records.has(`tj:device-acceptance:first:${generation}`)) generation++;
    return `tj:device-acceptance:first:${generation}`;
  }

  /** Compare the prepared generation and claim its immutable key without yielding. */
  writeFirstDeviceAcceptance(
    fields: Record<string, unknown>,
    expectedKey: string,
  ): Promise<{ ok: boolean; recordKey: string }> {
    if (expectedKey !== this.firstDeviceAcceptanceKey() || this.currentDeviceAcceptances().length > 0) {
      return Promise.resolve({ ok: false, recordKey: expectedKey });
    }
    return this.write('device-acceptance', fields, expectedKey);
  }

  /** True when this device has ever had an acceptance that is now withdrawn. */
  deviceAcceptanceWithdrawn(deviceId: string): boolean {
    return [...this.deviceAcceptances.values()].some((a) => a.deviceId === deviceId && !this.deviceAcceptanceCurrent(a));
  }
  deviceApproval(approvalId: string) { return this.deviceApprovals.get(approvalId) ?? null; }
  /** Unused approvals naming exactly this device, key and disclosure (expiry is the caller's check). */
  unusedDeviceApprovals(deviceId: string, keyFingerprint: string, disclosureHash: string): DeviceApprovalRecord[] {
    return [...this.deviceApprovals.values()].filter((a) => a.deviceId === deviceId && a.keyFingerprint === keyFingerprint
      && a.disclosureHash === disclosureHash && !this.usedDeviceApprovals.has(a.approvalId)
      && !this.pendingKeys.has(`tj:device-acceptance:approval:${a.approvalId}`));
  }
  changeLog(): ChangeLogRecord[] { return [...this.changes].sort((a, b) => a.at.localeCompare(b.at)); }
  /** Legacy grants for a kind key (empty when the kind has none). */
  legacyGrants(key: string) { return this.legacy.get(key) ?? []; }
  /** Every kind key holding a legacy grant from any machine. */
  legacyKeys(): string[] { return [...this.legacy.keys()]; }
  /** An approval for this exact action not yet used for a dispatch, if any. */
  unusedActionApproval(actionIdentity: string, now: Date = this.now()) {
    return (this.actionApprovals.get(actionIdentity) ?? []).find((a) => !this.dispatchedApprovals.has(a.approvalId)
      && !this.pendingKeys.has(`tj:dispatch:${a.approvalId}`)
      && (!a.expiresAt || new Date(a.expiresAt) > now)) ?? null;
  }

  /**
   * True when the kind's legacy grant on `machine` is unchanged: no change was committed after the one
   * the import observed (compared by change id, never by clocks across machines).
   */
  legacyUnchanged(key: string, machine: string): boolean {
    const mine = this.legacyGrants(key).filter((g) => g.machine === machine);
    if (!mine.length) return false;
    const last = this.lastChange(key);
    return (last?.changeId ?? null) === mine[mine.length - 1].afterChange;
  }
  /** Kinds whose legacy grant is still unchanged on at least one machine (what a joining machine may import). */
  unchangedLegacyKeys(): string[] {
    return this.legacyKeys().filter((k) => [...new Set(this.legacyGrants(k).map((g) => g.machine))].some((m) => this.legacyUnchanged(k, m)));
  }

  /** A key whose history this build cannot fully read: admission and rebuild treat it as "Ask me first". */
  hasUnreadableHistory(key: string): boolean { return this.unreadableKeys.has(key); }

  /** The last committed change for one key, or null when none was ever recorded. */
  lastChange(key: string): ChangeLogRecord | null {
    const all = this.changeLog().filter((c) => c.key === key);
    return all.length ? all[all.length - 1] : null;
  }
}
