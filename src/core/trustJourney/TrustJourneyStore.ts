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

export const TRUST_RECORD_TYPES = ['request', 'request-status', 'receipt', 'acceptance-sent', 'acceptance', 'acceptance-withdrawn', 'consumption', 'change'] as const;
export type TrustRecordType = typeof TRUST_RECORD_TYPES[number];

/** A change the person can approve, as structured data the server renders and hashes. */
export type TrustChange =
  | { kind: 'trust-grant'; service: string; operation: 'read' | 'write' | 'modify' | 'delete'; level: string }
  | { kind: 'autonomy-profile'; from: string; to: string }
  | { kind: 'config-patch'; patch: Record<string, unknown>; /** Hash of the settings it was written against (the expected revision). */ basedOn?: string }
  | { kind: 'slack-role'; slackUserId: string; displayName: string; role: string; mode: 'register' | 'approve' }
  | { kind: 'board-policy'; policy: string }
  | { kind: 'trust-recovery'; incidentId: string };

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
      if (r.recordType === 'acceptance-withdrawn' && typeof r.acceptanceId === 'string') this.withdrawnAcceptanceIds.add(r.acceptanceId);
      if (r.recordType === 'consumption') {
        if (typeof r.receiptId === 'string') this.consumedReceiptIds.add(r.receiptId);
        if (typeof r.requestId === 'string') this.consumedRequestIds.add(r.requestId);
      }
      if (r.recordType === 'request-status' && typeof r.requestId === 'string') this.closedRequests.set(r.requestId, 'superseded');
      if (r.recordType === 'request' && typeof r.requestId === 'string') this.closedRequests.set(r.requestId, 'superseded');
      return;
    }
    switch (r.recordType) {
      case 'request': {
        // The card record (with its message id) wins over the first write, in any load order.
        const prev = this.requests.get(r.requestId as string);
        if (prev && prev.cardMessageId && !r.cardMessageId) break;
        this.requests.set(r.requestId as string, { ...(r as unknown as RequestRecord), change: r.change as TrustChange, summary: (r.summary as string[]) ?? [] });
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
        break;
      }
      case 'change': this.changes.push(r as unknown as ChangeLogRecord); break;
    }
  }

  async write(recordType: TrustRecordType, fields: Record<string, unknown>, recordKey?: string): Promise<{ ok: boolean; recordKey: string }> {
    const key = recordKey ?? `tj:${recordType}:${crypto.randomBytes(8).toString('hex')}`;
    // Records are immutable: a second write to an existing key is a failed write, never a success.
    if (this.records.has(key)) return { ok: false, recordKey: key };
    const rec = { minReader: 1, ...fields, recordType, at: (fields.at as string) ?? this.now().toISOString() } as TrustRecord;
    const ok = await this.sink.append(key, rec);
    if (ok) this.fold(key, rec);
    return { ok, recordKey: key };
  }

  // ── reads ──
  private withStatus<T extends RequestRecord>(r: T): T {
    const status = this.consumedRequestIds.has(r.requestId) ? 'consumed' : (this.closedRequests.get(r.requestId) ?? r.status);
    return status === r.status ? r : { ...r, status };
  }
  request(id: string) { const r = this.requests.get(id); return r ? this.withStatus(r) : null; }
  openRequests() { return [...this.requests.values()].map((r) => this.withStatus(r)).filter((r) => r.status === 'open'); }
  allRequests() { return [...this.requests.values()].map((r) => this.withStatus(r)); }
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
  changeLog(): ChangeLogRecord[] { return [...this.changes].sort((a, b) => a.at.localeCompare(b.at)); }
  /** A key whose history this build cannot fully read: admission and rebuild treat it as "Ask me first". */
  hasUnreadableHistory(key: string): boolean { return this.unreadableKeys.has(key); }

  /** The last committed change for one key, or null when none was ever recorded. */
  lastChange(key: string): ChangeLogRecord | null {
    const all = this.changeLog().filter((c) => c.key === key);
    return all.length ? all[all.length - 1] : null;
  }
}
