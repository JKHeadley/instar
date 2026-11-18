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
  'device-acceptance', 'device-acceptance-withdrawn', 'device-approval', 'apply-outcome'] as const;
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

/**
 * Which lease run a grant belongs to (SEC-088 part 2, docs/specs/trust-records-holder-authored.md
 * decision 3). A grant counts only where it was written and only inside the writer's current run of
 * the lease. On a single machine the run never ends.
 */
export interface TrustRunView {
  /** True when the agent has more than one machine. */
  multiMachine(): boolean;
  /**
   * The lease epoch to put in a grant key written now; null when it is not known (no grant is written
   * then). A negative value `-1 - N` means "written at N while not holding the lease": the key is
   * marked `s<N>` and never counts in any run.
   */
  writeEpoch(): number | null;
  /** True when an own grant keyed at `epoch` is inside the current run (null: a key with no epoch, written before this build). */
  inRun(epoch: number | null): boolean;
}

/** A single machine: no epochs in keys, the run never ends (today's behaviour). */
export const SINGLE_MACHINE_RUN: TrustRunView = { multiMachine: () => false, writeEpoch: () => null, inRun: () => true };

/** `ignore`: peer grants are evidence only (this spec). `fold`: today's behaviour, every writer's grant counts. */
export type PeerGrantsMode = 'ignore' | 'fold';

export interface TrustJourneyStoreOptions {
  /** This machine's id: the writer of its own records. */
  self?: string;
  run?: TrustRunView;
  peerGrants?: PeerGrantsMode;
}

/** A record as it reaches the store, with the machine that wrote it (taken from the transport, never the payload). */
export interface WrittenRecord { writer: string; recordKey: string; data: Record<string, unknown> }

/** Record types whose own-writer side grants something; their keys carry the epoch on a multi-machine agent. */
export const TRUST_GRANT_TYPES: ReadonlySet<TrustRecordType> = new Set<TrustRecordType>(['request', 'acceptance-sent', 'acceptance', 'change', 'legacy-grant', 'action-approval', 'device-acceptance', 'device-approval']);

/** The epoch an own key carries (`tj:<type>:e<N>:...`), or null for a key written before this build. */
export function keyEpoch(recordKey: string): number | null {
  const m = /^tj:[^:]+:e(\d{1,15}):/.exec(recordKey);
  return m ? Number(m[1]) : null; // a standby write (`s<N>`) or a pre-build key has none: outside every run
}

/** The key a grant is written under on a multi-machine agent: the epoch goes after the type segment. */
export function epochKey(recordKey: string, epoch: number): string {
  const tag = epoch >= 0 ? `e${epoch}` : `s${-1 - epoch}`;
  const m = /^(tj:[^:]+:)(.*)$/.exec(recordKey);
  return m ? `${m[1]}${tag}:${m[2]}` : `tj:${tag}:${recordKey}`;
}

type Run = { epoch: number | null };

/** The index: every fold is over immutable records, rebuilt at boot and updated on each commit. */
export class TrustJourneyStore {
  /** Every record, as evidence, keyed by (writer, recordKey). */
  private records = new Map<string, TrustRecord>();
  private requests = new Map<string, RequestRecord & { change: TrustChange; summary: string[] }>();
  /** Each own request's epoch, kept apart from the record so a re-written card never carries it. */
  private requestEpochs = new Map<string, number | null>();
  private peerRequestCodes = new Set<string>();
  private receiptsByKey = new Map<string, Receipt>();
  private consumedReceiptKeys = new Set<string>();
  /** Used state from consumption records, independent of load order (a consumption may fold first). */
  private consumedReceiptIds = new Set<string>();
  private consumedRequestIds = new Set<string>();
  /** Requests a record from another machine closed or used (for the honest denial line). */
  private peerNarrowedRequests = new Set<string>();
  /** Terminal request states from request-status records, also order-independent. */
  private closedRequests = new Map<string, RequestRecord['status']>();
  private withdrawnAcceptanceIds = new Set<string>();
  private acceptances = new Map<string, Array<AcceptanceRecord & Run & { seq: number }>>();
  private acceptanceSent = new Map<string, Array<{ statementMessageId: string; at: string } & Run & { seq: number }>>();
  private consumptions = new Map<string, ConsumptionRecord>();
  private changes: Array<ChangeLogRecord & Run & { seq: number }> = [];
  /** Legacy grants by kind key (own records only). */
  private legacy = new Map<string, Array<{ machine: string; behaviour: string; at: string; afterChange: string | null } & Run & { seq: number }>>();
  /** Acceptance ids per subject (`principal|adapter`) from every writer: evidence only, so a withdrawal can name them. */
  private acceptanceIdsAnyWriter = new Map<string, Set<string>>();
  /** Kind keys with a legacy grant from any writer (evidence only: who has imported). */
  private legacyAnyWriter = new Map<string, Set<string>>();
  private deviceAcceptances = new Map<string, DeviceAcceptanceRecord & Run & { own: boolean; writer: string }>();
  private deviceApprovals = new Map<string, DeviceApprovalRecord & Run>();
  /** Device approvals already used by an acceptance (order-independent). */
  private usedDeviceApprovals = new Set<string>();
  private outcomes = new Map<string, ApplyOutcomeRecord>();
  private consumptionByRequest = new Map<string, ConsumptionRecord>();
  private actionApprovals = new Map<string, Array<{ approvalId: string; consumptionId: string; expiresAt?: string } & Run>>();
  private dispatchedApprovals = new Set<string>();
  /** Keys being written right now (reserved before the durable wait), both as called and as stored. */
  private pendingKeys = new Set<string>();
  /** Records kept as evidence but not used for permission (reader rule). */
  unreadable = 0;
  /** Keys whose change history holds a record this build cannot read: treated as "Ask me first". */
  private unreadableKeys = new Set<string>();
  /** Peer grant records kept but not counted, by `${type}|${writer}`. */
  private peerIgnored = new Map<string, number>();
  private seq = 0;
  private readonly self: string;
  private readonly run: TrustRunView;
  private readonly foldAll: boolean;

  constructor(private readonly sink: TrustRecordSink, private readonly now: () => Date = () => new Date(), opts: TrustJourneyStoreOptions = {}) {
    this.self = opts.self ?? 'self';
    this.run = opts.run ?? SINGLE_MACHINE_RUN;
    this.foldAll = opts.peerGrants === 'fold';
    for (const r of sink.loadAll()) {
      const { writer: w, ...data } = r as unknown as TrustRecord & { writer?: unknown };
      // A sink names the writer of each record it loads (the replica file's machine); none means own.
      const writer = typeof w === 'string' && w ? w : this.self;
      this.fold(writer, String(r.recordKey ?? ''), data as TrustRecord);
    }
  }

  get sinkDescription(): string { return this.sink.description; }
  get selfId(): string { return this.self; }
  get peerGrantsMode(): PeerGrantsMode { return this.foldAll ? 'fold' : 'ignore'; }

  /** Applies records committed elsewhere, each with the machine that wrote it (own commit or a peer's, from the transport). */
  applyCommitted(records: WrittenRecord[]): void {
    for (const { writer, recordKey, data } of records) this.fold(writer || this.self, recordKey, data as TrustRecord);
  }

  private readable(r: TrustRecord): boolean {
    const mr = typeof r.minReader === 'number' ? r.minReader : 1;
    if (mr > TRUST_READER_VERSION) return false;
    for (const k of Object.keys(r)) if (!KNOWN.has(k)) return false;
    return true;
  }

  private inRun(epoch: number | null): boolean { return this.foldAll || this.run.inRun(epoch); }

  /** The id-keyed narrowing every writer applies (closed, used, withdrawn). */
  private narrow(r: TrustRecord, own: boolean): void {
    switch (r.recordType) {
      case 'request-status': if (typeof r.requestId === 'string' && r.status !== 'open') { this.closedRequests.set(r.requestId, (r.status as RequestRecord['status']) ?? 'superseded'); if (!own) this.peerNarrowedRequests.add(r.requestId); } break;
      case 'consumption':
        if (typeof r.receiptId === 'string') this.consumedReceiptIds.add(r.receiptId);
        if (typeof r.requestId === 'string') { this.consumedRequestIds.add(r.requestId); if (!own) this.peerNarrowedRequests.add(r.requestId); }
        break;
      case 'acceptance-withdrawn': case 'device-acceptance-withdrawn': if (typeof r.acceptanceId === 'string') this.withdrawnAcceptanceIds.add(r.acceptanceId); break;
      case 'device-acceptance': if (typeof r.approvalId === 'string') this.usedDeviceApprovals.add(r.approvalId); break;
      case 'dispatch': if (typeof r.approvalId === 'string') this.dispatchedApprovals.add(r.approvalId); break;
    }
  }

  private fold(writer: string, recordKey: string, r: TrustRecord): void {
    if (!recordKey) return;
    const own = this.foldAll || writer === this.self;
    // Records are keyed by (writer, recordKey): a peer cannot occupy a key this machine writes.
    const id = this.foldAll ? recordKey : `${writer}\u0000${recordKey}`;
    if (this.records.has(id)) return;
    this.records.set(id, r);
    const seq = ++this.seq;
    if (!this.readable(r)) {
      this.unreadable++;
      // Only an own unreadable change puts a kind into unreadable history; a peer's keeps its id-keyed narrowing only.
      if (own && r.recordType === 'change' && typeof r.key === 'string') this.unreadableKeys.add(r.key);
      this.narrow(r, own);
      if (r.recordType === 'request' && typeof r.requestId === 'string') { this.closedRequests.set(r.requestId, 'superseded'); if (!own) this.peerNarrowedRequests.add(r.requestId); }
      return;
    }
    this.narrow(r, own);
    if (r.recordType === 'acceptance' && typeof r.acceptanceId === 'string') {
      const k = `${r.principal}|${r.adapter}`;
      const ids = this.acceptanceIdsAnyWriter.get(k) ?? new Set<string>();
      ids.add(r.acceptanceId); this.acceptanceIdsAnyWriter.set(k, ids);
    }
    if (r.recordType === 'legacy-grant' && typeof r.key === 'string') {
      const w = this.legacyAnyWriter.get(r.key) ?? new Set<string>();
      w.add(writer); this.legacyAnyWriter.set(r.key, w);
    }
    if (!own) {
      if (r.recordType === 'request' && typeof r.code === 'string') this.peerRequestCodes.add(r.code);
      if (TRUST_GRANT_TYPES.has(r.recordType)) {
        const k = `${r.recordType}|${writer}`;
        this.peerIgnored.set(k, (this.peerIgnored.get(k) ?? 0) + 1);
      }
      if (r.recordType === 'device-acceptance') {
        // Kept for the device record the owner sees ("from <machine>, not counted here"); never current.
        const a = r as unknown as DeviceAcceptanceRecord;
        if (typeof a.acceptanceId === 'string' && !this.deviceAcceptances.has(a.acceptanceId)) this.deviceAcceptances.set(a.acceptanceId, { ...a, epoch: null, own: false, writer });
      }
      return;
    }
    const epoch = this.foldAll ? null : keyEpoch(recordKey);
    switch (r.recordType) {
      case 'request': {
        // The card record (with its message id) wins over the first write, in any load order; the
        // earlier epoch of the two governs (a request outside the run stays outside).
        const id = r.requestId as string;
        const prev = this.requests.get(id);
        const pe = this.requestEpochs.get(id);
        this.requestEpochs.set(id, prev ? (pe === null || pe === undefined || epoch === null ? null : Math.min(pe, epoch)) : epoch);
        if (prev && prev.cardMessageId && !r.cardMessageId) break;
        this.requests.set(id, { ...(r as unknown as RequestRecord), change: r.change as TrustChange, summary: (r.summary as string[]) ?? [] });
        break;
      }
      case 'receipt': this.receiptsByKey.set(r.uniqueKey as string, r as unknown as Receipt); break;
      case 'acceptance-sent': {
        const k = `${r.principal}|${r.adapter}`;
        const list = this.acceptanceSent.get(k) ?? [];
        list.push({ statementMessageId: r.statementMessageId as string, at: r.at, epoch, seq });
        this.acceptanceSent.set(k, list);
        break;
      }
      case 'acceptance': {
        const k = `${r.principal}|${r.adapter}`;
        const list = this.acceptances.get(k) ?? [];
        list.push({ ...(r as unknown as AcceptanceRecord), epoch, seq });
        this.acceptances.set(k, list);
        break;
      }
      case 'consumption': {
        const c = r as unknown as ConsumptionRecord;
        this.consumptions.set(c.consumptionId, c);
        this.consumptionByRequest.set(c.requestId, c);
        break;
      }
      case 'device-acceptance': {
        const a = r as unknown as DeviceAcceptanceRecord;
        this.deviceAcceptances.set(a.acceptanceId, { ...a, epoch, own: true, writer });
        break;
      }
      case 'device-approval': { const a = r as unknown as DeviceApprovalRecord; this.deviceApprovals.set(a.approvalId, { ...a, epoch }); break; }
      case 'apply-outcome': {
        const o = r as unknown as ApplyOutcomeRecord;
        if (!this.outcomes.has(o.requestId)) this.outcomes.set(o.requestId, o);
        break;
      }
      case 'change': this.changes.push({ ...(r as unknown as ChangeLogRecord), epoch, seq }); break;
      case 'legacy-grant': {
        const list = this.legacy.get(r.key as string) ?? [];
        list.push({ machine: String(r.machine), behaviour: String(r.behaviour), at: r.at, afterChange: typeof r.afterChange === 'string' ? r.afterChange : null, epoch, seq });
        this.legacy.set(r.key as string, list);
        break;
      }
      case 'action-approval': {
        const list = this.actionApprovals.get(r.actionIdentity as string) ?? [];
        list.push({ approvalId: String(r.approvalId), consumptionId: String(r.consumptionId), ...(typeof r.expiresAt === 'string' ? { expiresAt: r.expiresAt } : {}), epoch });
        this.actionApprovals.set(r.actionIdentity as string, list);
        break;
      }
    }
  }

  /**
   * Writes a record. On a multi-machine agent a grant's key carries the current lease epoch; when that
   * epoch is not known no grant is written (the caller treats it as a failed write and asks).
   */
  async write(recordType: TrustRecordType, fields: Record<string, unknown>, recordKey?: string): Promise<{ ok: boolean; recordKey: string }> {
    const called = recordKey ?? `tj:${recordType}:${crypto.randomBytes(8).toString('hex')}`;
    let key = called;
    if (!this.foldAll && TRUST_GRANT_TYPES.has(recordType) && this.run.multiMachine()) {
      const ep = this.run.writeEpoch();
      if (ep === null) return { ok: false, recordKey: called };
      key = epochKey(called, ep);
    }
    // Records are immutable: a second write to an existing key is a failed write, never a success.
    // The key is reserved before the durable wait, so two concurrent writers of one key (two
    // identical calls racing for one approval) cannot both succeed.
    const id = this.foldAll ? key : `${this.self}\u0000${key}`;
    if (this.records.has(id) || this.pendingKeys.has(key) || this.pendingKeys.has(called)) return { ok: false, recordKey: key };
    this.pendingKeys.add(key); this.pendingKeys.add(called);
    const rec = { minReader: 1, ...fields, recordType, at: (fields.at as string) ?? this.now().toISOString() } as TrustRecord;
    let ok = false;
    try { ok = await this.sink.append(key, rec); } finally { this.pendingKeys.delete(key); this.pendingKeys.delete(called); }
    if (ok) this.fold(this.self, key, rec);
    return { ok, recordKey: key };
  }

  // ── reads ──
  private withStatus<T extends RequestRecord>(r: T): T {
    const status = this.consumedRequestIds.has(r.requestId) ? 'consumed' : (this.closedRequests.get(r.requestId) ?? r.status);
    return status === r.status ? r : { ...r, status };
  }
  private requestInRun(id: string) { return this.inRun(this.requestEpochs.get(id) ?? null); }
  private runRequests() { return [...this.requests.values()].filter((r) => this.requestInRun(r.requestId)); }
  request(id: string) { const r = this.requests.get(id); return r && this.requestInRun(id) ? this.withStatus(r) : null; }
  /** An own request from any run: only to tell the owner it was made earlier (decision 6). */
  requestAnyRun(id: string) { const r = this.requests.get(id); return r ? this.withStatus(r) : null; }
  /** True when a record from another machine closed or used this request (decision 7, the honest denial line). */
  requestNarrowedByPeer(id: string) { return this.peerNarrowedRequests.has(id) && !this.consumptionByRequest.has(id); }
  openRequests() { return this.runRequests().map((r) => this.withStatus(r)).filter((r) => r.status === 'open'); }
  allRequests() { return this.runRequests().map((r) => this.withStatus(r)); }
  requestByCode(code: string) { return this.openRequests().find((r) => r.code === code) ?? null; }
  requestByCard(adapter: AdapterKind, cardMessageId: string) { const r = this.runRequests().find((x) => x.adapter === adapter && x.cardMessageId === cardMessageId); return r ? this.withStatus(r) : null; }
  /** An own request from any run with this card (for the "made earlier" line). */
  requestByCardAnyRun(adapter: AdapterKind, cardMessageId: string) { const r = [...this.requests.values()].find((x) => x.adapter === adapter && x.cardMessageId === cardMessageId); return r ? this.withStatus(r) : null; }
  /** Every writer's requests: blocks a code only, never grants, so a new holder never reuses an earlier holder's code. */
  codeTaken(code: string) { return this.peerRequestCodes.has(code) || [...this.requests.values()].some((r) => r.code === code); }
  receipt(uniqueKey: string) { return this.receiptsByKey.get(uniqueKey) ?? null; }
  receiptConsumed(uniqueKey: string) {
    if (this.consumedReceiptKeys.has(uniqueKey)) return true;
    const rec = this.receiptsByKey.get(uniqueKey);
    return !!rec && this.consumedReceiptIds.has(rec.receiptId);
  }
  acceptance(principal: string, adapter: AdapterKind): AcceptanceRecord | null {
    const list = (this.acceptances.get(`${principal}|${adapter}`) ?? []).filter((a) => this.inRun(a.epoch));
    const a = list[list.length - 1];
    if (!a || a.withdrawnAt || this.withdrawnAcceptanceIds.has(a.acceptanceId)) return null;
    const { epoch: _e, seq: _s, ...rec } = a; void _e; void _s;
    return rec;
  }
  /**
   * Evidence only: every not-yet-withdrawn acceptance id for the subject, from any machine and any run.
   * A withdrawal names each, so an owner's withdrawal made on a machine that is not in charge still
   * reaches the holder's acceptance. It can only narrow.
   */
  acceptanceIdsToWithdraw(principal: string, adapter: AdapterKind): string[] {
    return [...(this.acceptanceIdsAnyWriter.get(`${principal}|${adapter}`) ?? [])].filter((id) => !this.withdrawnAcceptanceIds.has(id));
  }
  /** Evidence only: every not-yet-withdrawn device acceptance from any machine and any run (for withdrawals). */
  deviceAcceptancesToWithdraw(): DeviceAcceptanceRecord[] {
    return [...this.deviceAcceptances.values()].filter((a) => !a.withdrawnAt && !this.withdrawnAcceptanceIds.has(a.acceptanceId)).map((a) => TrustJourneyStore.plainDevice(a));
  }
  acceptanceStatementSent(principal: string, adapter: AdapterKind) {
    const list = (this.acceptanceSent.get(`${principal}|${adapter}`) ?? []).filter((a) => this.inRun(a.epoch));
    const a = list[list.length - 1];
    return a ? { statementMessageId: a.statementMessageId, at: a.at } : null;
  }
  consumption(id: string) { return this.consumptions.get(id) ?? null; }
  /** The one consumption of a request (its key is `tj:consumption:<requestId>`), or null. */
  consumptionOf(requestId: string) { return this.consumptionByRequest.get(requestId) ?? null; }
  /** True while a consumption of this request is recorded (by any machine) or being written right now. */
  requestConsumedOrPending(requestId: string) { return this.consumedRequestIds.has(requestId) || this.pendingKeys.has(`tj:consumption:${requestId}`); }
  /** The apply outcome recorded after an own consumption, or null (with a consumption: `unknown`). */
  applyOutcome(requestId: string) { return this.outcomes.get(requestId) ?? null; }

  // ── device acceptances (app-trust-approval §A) ──
  private deviceAcceptanceCurrent(a: DeviceAcceptanceRecord & Run & { own: boolean }): boolean {
    return a.own && this.inRun(a.epoch) && !a.withdrawnAt && !this.withdrawnAcceptanceIds.has(a.acceptanceId);
  }
  private static plainDevice(a: DeviceAcceptanceRecord & Run & { own: boolean; writer: string }): DeviceAcceptanceRecord {
    const { epoch: _e, own: _o, writer: _w, ...rec } = a; void _e; void _o; void _w;
    return rec;
  }
  /** The device's acceptance on record that is not withdrawn (the latest), or null. Key checks are the caller's. */
  deviceAcceptance(deviceId: string): DeviceAcceptanceRecord | null {
    const mine = [...this.deviceAcceptances.values()].filter((a) => a.deviceId === deviceId && this.deviceAcceptanceCurrent(a));
    mine.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    return mine.length ? TrustJourneyStore.plainDevice(mine[mine.length - 1]) : null;
  }
  /** Every device acceptance that counts here (own, current run, not withdrawn). */
  currentDeviceAcceptances(): DeviceAcceptanceRecord[] { return [...this.deviceAcceptances.values()].filter((a) => this.deviceAcceptanceCurrent(a)).map((a) => TrustJourneyStore.plainDevice(a)); }
  /** Every device acceptance ever recorded, with `withdrawn` and where it counts (newest first), for the record the devices show. */
  deviceAcceptanceHistory(): Array<DeviceAcceptanceRecord & { withdrawn: boolean; countedHere: boolean; writtenBy: string }> {
    return [...this.deviceAcceptances.values()].map((a) => ({
      ...TrustJourneyStore.plainDevice(a),
      withdrawn: !!a.withdrawnAt || this.withdrawnAcceptanceIds.has(a.acceptanceId),
      countedHere: this.deviceAcceptanceCurrent(a),
      writtenBy: a.writer,
    })).sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
  }
  /** True when this device has ever had an own acceptance that is now withdrawn. */
  deviceAcceptanceWithdrawn(deviceId: string): boolean {
    return [...this.deviceAcceptances.values()].some((a) => a.own && a.deviceId === deviceId && (!!a.withdrawnAt || this.withdrawnAcceptanceIds.has(a.acceptanceId)));
  }
  deviceApproval(approvalId: string) { const a = this.deviceApprovals.get(approvalId); if (!a || !this.inRun(a.epoch)) return null; const { epoch: _e, ...rec } = a; void _e; return rec; }
  /** Unused approvals naming exactly this device, key and disclosure (expiry is the caller's check). */
  unusedDeviceApprovals(deviceId: string, keyFingerprint: string, disclosureHash: string): DeviceApprovalRecord[] {
    return [...this.deviceApprovals.values()].filter((a) => this.inRun(a.epoch) && a.deviceId === deviceId && a.keyFingerprint === keyFingerprint
      && a.disclosureHash === disclosureHash && !this.usedDeviceApprovals.has(a.approvalId)
      && !this.pendingKeys.has(`tj:device-acceptance:approval:${a.approvalId}`))
      .map((a) => { const { epoch: _e, ...rec } = a; void _e; return rec; });
  }
  /** Own changes in the current run, in this machine's own write order (never a payload time). */
  changeLog(): ChangeLogRecord[] {
    if (this.foldAll) return [...this.changes].sort((a, b) => a.at.localeCompare(b.at)).map(TrustJourneyStore.plainChange);
    return this.changes.filter((c) => this.inRun(c.epoch)).sort((a, b) => a.seq - b.seq).map(TrustJourneyStore.plainChange);
  }
  private static plainChange(c: ChangeLogRecord & Run & { seq: number }): ChangeLogRecord { const { epoch: _e, seq: _s, ...rec } = c; void _e; void _s; return rec; }
  /** This machine's legacy grants for a kind key in the current run (empty when none). */
  legacyGrants(key: string) {
    return (this.legacy.get(key) ?? []).filter((g) => this.inRun(g.epoch)).map(({ machine, behaviour, at, afterChange }) => ({ machine, behaviour, at, afterChange }));
  }
  /** Every kind key holding a legacy grant here in the current run. */
  legacyKeys(): string[] { return [...this.legacy.keys()].filter((k) => this.legacyGrants(k).length > 0); }
  /** Evidence only: true when any machine (this one included) has written a legacy grant. Decides joining-machine status, never grants. */
  legacyImportedAnywhere(excludeWriter?: string): boolean {
    for (const writers of this.legacyAnyWriter.values()) for (const w of writers) if (w !== excludeWriter) return true;
    return false;
  }
  /** An approval for this exact action not yet used for a dispatch, if any. */
  unusedActionApproval(actionIdentity: string, now: Date = this.now()) {
    const a = (this.actionApprovals.get(actionIdentity) ?? []).find((x) => this.inRun(x.epoch) && !this.dispatchedApprovals.has(x.approvalId)
      && !this.pendingKeys.has(`tj:dispatch:${x.approvalId}`)
      && (!x.expiresAt || new Date(x.expiresAt) > now));
    if (!a) return null;
    const { epoch: _e, ...rec } = a; void _e;
    return rec;
  }

  /**
   * True when this machine's legacy grant for the kind still holds: it is in the current run and no own
   * change for the kind was written after it (own write order). Changes other machines wrote are not read.
   */
  legacyUnchanged(key: string, machine: string = this.self): boolean {
    if (this.foldAll) {
      // Today's rule (`fold`): the last change, by its recorded time, must be the one the import saw.
      const mine = (this.legacy.get(key) ?? []).filter((g) => g.machine === machine);
      if (!mine.length) return false;
      const last = this.lastChange(key);
      return (last?.changeId ?? null) === mine[mine.length - 1].afterChange;
    }
    if (machine !== this.self) return false;
    const grants = (this.legacy.get(key) ?? []).filter((g) => this.inRun(g.epoch));
    if (!grants.length) return false;
    const g = grants[grants.length - 1];
    // A grant imported before this build names the change it saw; changes up to that one are history.
    const anchorSeq = g.afterChange ? (this.changes.find((c) => c.key === key && c.changeId === g.afterChange)?.seq ?? 0) : 0;
    const floor = Math.max(g.seq, anchorSeq);
    return !this.changes.some((c) => c.key === key && c.seq > floor);
  }
  /** Kinds whose legacy grant still holds here. */
  unchangedLegacyKeys(): string[] {
    // "fold" keeps today's rule: unchanged on at least one machine (what a joining machine imports).
    if (this.foldAll) return this.legacyKeys().filter((k) => [...new Set((this.legacy.get(k) ?? []).map((g) => g.machine))].some((m) => this.legacyUnchanged(k, m)));
    return this.legacyKeys().filter((k) => this.legacyUnchanged(k));
  }

  /** A key whose own history this build cannot fully read: admission and rebuild treat it as "Ask me first". */
  hasUnreadableHistory(key: string): boolean { return this.unreadableKeys.has(key); }

  /** The last own change for one key in the current run, or null when none was recorded. */
  lastChange(key: string): ChangeLogRecord | null {
    const all = this.changeLog().filter((c) => c.key === key);
    return all.length ? all[all.length - 1] : null;
  }

  /** Counts for `GET /trust/summary` (decision 8). */
  summary(): { peerGrants: PeerGrantsMode; peerGrantsIgnored: Array<{ type: string; writer: string; count: number }>; outsideRun: Record<string, number> } {
    const peerGrantsIgnored = [...this.peerIgnored.entries()].map(([k, count]) => { const [type, writer] = k.split('|'); return { type, writer, count }; });
    const outsideRun: Record<string, number> = {};
    const bump = (t: string) => { outsideRun[t] = (outsideRun[t] ?? 0) + 1; };
    if (!this.foldAll) {
      for (const r of this.requests.values()) if (!this.requestInRun(r.requestId)) bump('request');
      for (const l of this.acceptances.values()) for (const a of l) if (!this.inRun(a.epoch)) bump('acceptance');
      for (const a of this.deviceAcceptances.values()) if (a.own && !this.inRun(a.epoch)) bump('device-acceptance');
      for (const a of this.deviceApprovals.values()) if (!this.inRun(a.epoch)) bump('device-approval');
      for (const l of this.actionApprovals.values()) for (const a of l) if (!this.inRun(a.epoch)) bump('action-approval');
      for (const c of this.changes) if (!this.inRun(c.epoch)) bump('change');
      for (const l of this.legacy.values()) for (const g of l) if (!this.inRun(g.epoch)) bump('legacy-grant');
    }
    return { peerGrants: this.peerGrantsMode, peerGrantsIgnored, outsideRun };
  }
}
