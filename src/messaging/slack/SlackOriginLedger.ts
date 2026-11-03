// message-origin-all-platforms §3 (Slack): every Slack send writes its origin before it leaves.
// Governed by "Telegram Message Origin Is Mandatory; Its Display Is Optional" as extended to every
// platform. One file, append + fsync, synchronous in one process: rotation never interleaves an
// append, and the index is rebuilt from the retained files by the same rule the live path uses.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  originEvidenceWithoutSession, validateMessageOriginEvidence, type MessageOriginEvidence,
} from '../messageOrigin.js';

/** Slack methods that put words in front of a user (the adapter's outbound chokepoints). */
export const RECORDED_SLACK_METHODS: ReadonlySet<string> = new Set(['chat.postMessage', 'chat.postEphemeral', 'chat.update', 'files.completeUploadExternal']);
const POST_METHODS: ReadonlySet<string> = new Set(['chat.postMessage', 'files.completeUploadExternal']);

export const ORIGIN_OUTAGE_NOTICE_TEXT = 'A message to this conversation was not sent because I could not record which machine and model wrote it. Ask me again if you were expecting a reply.';
const NOTICE_INTERVAL_MS = 15 * 60_000;
const UNLINKED_WINDOW_MS = 60_000;
const MAX_INDEX = 50_000;
const MAX_PENDING = 1_000;
const RETRY_MS = 5_000;
/** Only a refused post sends a notice: an ephemeral refusal must not be published, an edit was not "a message not sent", and a refused share already reports `mirror: "failed"`. */
const NOTICE_METHODS: ReadonlySet<string> = new Set(['chat.postMessage']);
export function refusalWarrantsNotice(method: string): boolean { return NOTICE_METHODS.has(method); }

export class SlackOriginRecordingError extends Error {
  readonly notSent = true;
  constructor(readonly reason: string) { super(`origin-recording-unavailable: ${reason}`); this.name = 'SlackOriginRecordingError'; }
}

/** The reply route's scope: one adapter call, to one target, with the session's evidence. */
interface SendScope { evidence: MessageOriginEvidence; channel: string; threadTs: string | null; used: boolean }
const scopeStore = new AsyncLocalStorage<SendScope>();

export interface SlackOriginLedgerOptions {
  file: string;
  /** This machine (for automation evidence). */
  machine?: () => { id: string | null; name: string | null };
  /** Read live; false = the operator-set exception: a failed append is reported and the send proceeds. */
  failClosed?: () => boolean;
  report?: (feature: string, detail: string) => void;
  maxBytes?: number;
  now?: () => number;
}

interface Row { v: 1; kind: 'intent' | 'receipt' | 'reserve'; id: string; bootId?: string; method?: string; channel?: string; threadTs?: string | null;
  ts?: string | null; origin?: unknown; at: number; reserveId?: string }

export interface SlackOriginCounters { intents: number; receipts: number; refused: number; intentFailures: number; receiptFailures: number; notices: number; noticeUnavailable: number }

export class SlackOriginLedger {
  readonly bootId = randomUUID();
  private readonly maxBytes: number;
  private posts = new Map<string, MessageOriginEvidence>();
  private revisions = new Map<string, MessageOriginEvidence>();
  private pending = new Map<string, { channel: string; at: number }>();
  /** Reserved outage notices of THIS process incarnation, by conversation; consumed at most once. */
  private reserves = new Map<string, { id: string; consumed: boolean }>();
  private lastNotice = new Map<string, number>();
  private coversSinceMs: number | null = null;
  private outage = false;
  private lastFailedWriteAt: number | null = null;
  readonly counters: SlackOriginCounters = { intents: 0, receipts: 0, refused: 0, intentFailures: 0, receiptFailures: 0, notices: 0, noticeUnavailable: 0 };

  constructor(private readonly options: SlackOriginLedgerOptions) {
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
    // Opening never throws to the adapter: an unreadable ledger starts empty and the next write decides.
    try { this.rebuild(); } catch { /* @silent-fallback-ok — rebuild skips bad lines; an fs error leaves an empty index */ }
  }

  /** Run `fn` (one adapter send) with a session's evidence, bound to its target conversation. */
  static runInScope<T>(scope: { evidence: MessageOriginEvidence; channel: string; threadTs: string | null }, fn: () => T): T {
    return scopeStore.run({ ...scope, used: false }, fn);
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private key(channel: string, ts: string): string { return `${channel}:${ts}`; }
  private conv(channel: string, threadTs: string | null): string { return `${channel}:${threadTs ?? ''}`; }

  private automation(): MessageOriginEvidence {
    const m = this.options.machine?.() ?? { id: null, name: null };
    return originEvidenceWithoutSession({ machineId: m.id, machineName: m.name, at: this.now(), kind: 'server-automation' });
  }

  /** The evidence for this call: the scope's when it is the scope's one call to its own target. */
  private evidenceFor(channel: string, threadTs: string | null): MessageOriginEvidence {
    const scope = scopeStore.getStore();
    if (scope && !scope.used && scope.channel === channel && (scope.threadTs ?? null) === (threadTs ?? null)) {
      scope.used = true;
      return scope.evidence;
    }
    return this.automation();
  }

  private append(row: Row): void {
    // Unavailable: retry the write at most once per 5 s; until then refuse without touching the disk.
    if (this.lastFailedWriteAt !== null && this.now() - this.lastFailedWriteAt < RETRY_MS) throw new Error('ledger-unavailable');
    try { this.write(row); this.lastFailedWriteAt = null; }
    catch (err) { this.lastFailedWriteAt = this.now(); throw err; }
  }

  private write(row: Row): void {
    fs.mkdirSync(path.dirname(this.options.file), { recursive: true, mode: 0o700 });
    let size = 0;
    try { size = fs.statSync(this.options.file).size; } catch { size = 0; }
    if (size > this.maxBytes) {
      fs.renameSync(this.options.file, `${this.options.file}.1`);
      // Same rule as a restart: the live index is what the retained files say.
      try { this.rebuild(); } catch { /* @silent-fallback-ok — an unreadable generation leaves what was read */ }
    }
    const fd = fs.openSync(this.options.file, 'a', 0o600);
    try { fs.writeSync(fd, JSON.stringify(row) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  /** Before the API call. Throws SlackOriginRecordingError when the record cannot be written (fail-closed). */
  beginIntent(method: string, channel: string, threadTs: string | null): { id: string; method: string; channel: string; threadTs: string | null; evidence: MessageOriginEvidence; recorded: boolean } {
    const evidence = this.evidenceFor(channel, threadTs);
    const id = randomUUID();
    try {
      this.append({ v: 1, kind: 'intent', id, bootId: this.bootId, method, channel, threadTs, origin: evidence, at: this.now() });
    } catch (err) {
      this.counters.intentFailures++;
      const detail = err instanceof Error ? err.message : String(err);
      const failClosed = this.options.failClosed?.() ?? true;
      if (!this.outage) {
        this.outage = true;
        this.options.report?.('SlackAdapter.originRecording', `Slack origin record could not be written (${detail}); ${failClosed ? 'sends are refused until it can' : 'sends continue unrecorded (messageOrigin.recording.slackFailClosed is false)'}.`);
      }
      if (failClosed) { this.counters.refused++; throw new SlackOriginRecordingError(detail); }
      return { id, method, channel, threadTs, evidence, recorded: false };
    }
    // The record is written: nothing below can turn this send into a refusal.
    this.counters.intents++;
    if (this.coversSinceMs === null) this.coversSinceMs = this.now();
    this.pending.set(id, { channel, at: this.now() });
    if (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value as string);
    if (this.outage) {
      this.outage = false;
      try { this.options.report?.('SlackAdapter.originRecording', 'Slack origin recording recovered.'); } catch { /* @silent-fallback-ok — reporting never affects a send */ }
    }
    try { this.ensureReserve(channel, threadTs); } catch { /* @silent-fallback-ok — the next successful send writes the reserve */ }
    return { id, method, channel, threadTs, evidence, recorded: true };
  }

  /** After Slack accepted. Self-contained (carries channel and evidence), so rotation never splits it from its intent. */
  completeReceipt(intent: { id: string; method: string; channel: string; threadTs: string | null; evidence: MessageOriginEvidence }, ts: string | null, reserveId?: string): void {
    this.pending.delete(intent.id);
    const row: Row = { v: 1, kind: 'receipt', id: intent.id, method: intent.method, channel: intent.channel, threadTs: intent.threadTs,
      ts, origin: intent.evidence, at: this.now(), ...(reserveId ? { reserveId } : {}) };
    try {
      this.append(row);
      this.counters.receipts++;
      this.index(row, intent.evidence);
    } catch (err) {
      this.counters.receiptFailures++;
      this.options.report?.('SlackAdapter.originReceipt', `A Slack message was sent but its origin receipt could not be written (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  private index(row: Row, evidence: MessageOriginEvidence): void {
    if (!row.channel || !row.ts) return;
    const k = this.key(row.channel, row.ts);
    if (row.method && POST_METHODS.has(row.method)) { if (!this.posts.has(k)) this.posts.set(k, evidence); }
    else if (row.method === 'chat.update') this.revisions.set(k, evidence);
    for (const map of [this.posts, this.revisions]) {
      while (map.size > MAX_INDEX) map.delete(map.keys().next().value as string);
    }
  }

  /** A conversation's pre-recorded outage notice, written while recording works (one per conversation per incarnation). */
  private ensureReserve(channel: string, threadTs: string | null): void {
    const c = this.conv(channel, threadTs);
    if (this.reserves.has(c)) return;
    const id = randomUUID();
    const m = this.options.machine?.() ?? { id: null, name: null };
    const fixed: MessageOriginEvidence = {
      ...originEvidenceWithoutSession({ machineId: m.id, machineName: m.name, at: this.now(), kind: 'server-automation' }),
      harness: { value: null, status: 'not-applicable', sourceEventRef: null, observedAt: null, reason: 'deterministic-automation' },
      model: { value: null, status: 'not-applicable', sourceEventRef: null, observedAt: null, reason: 'deterministic-automation' },
    };
    try {
      this.append({ v: 1, kind: 'reserve', id, bootId: this.bootId, method: 'chat.postMessage', channel, threadTs, origin: fixed, at: this.now() });
      this.reserves.set(c, { id, consumed: false });
      if (this.reserves.size > MAX_PENDING) this.reserves.delete(this.reserves.keys().next().value as string);
    } catch { /* @silent-fallback-ok — the next successful send in this conversation writes it */ }
  }

  /** Take this conversation's reserved notice: once per incarnation and at most once per 15 minutes. Null when unavailable. */
  takeOutageNotice(channel: string, threadTs: string | null): { reserveId: string; evidence: MessageOriginEvidence } | null {
    const c = this.conv(channel, threadTs);
    const last = this.lastNotice.get(c);
    if (last !== undefined && this.now() - last < NOTICE_INTERVAL_MS) return null;
    const reserve = this.reserves.get(c);
    if (!reserve || reserve.consumed) {
      this.counters.noticeUnavailable++;
      this.options.report?.('SlackAdapter.originNotice', 'A Slack send was refused for lack of an origin record and no pre-recorded notice was available for that conversation.');
      return null;
    }
    reserve.consumed = true;
    this.lastNotice.set(c, this.now());
    this.counters.notices++;
    const m = this.options.machine?.() ?? { id: null, name: null };
    return { reserveId: reserve.id, evidence: {
      ...originEvidenceWithoutSession({ machineId: m.id, machineName: m.name, at: this.now(), kind: 'server-automation' }),
      harness: { value: null, status: 'not-applicable', sourceEventRef: null, observedAt: null, reason: 'deterministic-automation' },
      model: { value: null, status: 'not-applicable', sourceEventRef: null, observedAt: null, reason: 'deterministic-automation' },
    } };
  }

  /** The origin of the post that created this Slack message, or why there is none. */
  lookup(channel: string, ts: string): { evidence: MessageOriginEvidence } | { missing: 'not-retained' | 'other-machine' | 'unlinked' } {
    const hit = this.posts.get(this.key(channel, ts));
    if (hit) return { evidence: hit };
    const atMs = Number(ts) * 1000;
    if (this.coversSinceMs === null || !Number.isFinite(atMs) || atMs < this.coversSinceMs) return { missing: 'not-retained' };
    for (const p of this.pending.values()) {
      if (p.channel === channel && Math.abs(p.at - atMs) <= UNLINKED_WINDOW_MS) return { missing: 'unlinked' };
    }
    return { missing: 'other-machine' };
  }

  get coversSince(): number | null { return this.coversSinceMs; }

  /** The live index and the restart index come from this one rule: receipts in the retained files. */
  private rebuild(): void {
    const posts = new Map<string, MessageOriginEvidence>(), revisions = new Map<string, MessageOriginEvidence>();
    const pending = new Map<string, { channel: string; at: number }>();
    let oldest: number | null = null;
    for (const file of [`${this.options.file}.1`, this.options.file]) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line) continue;
        let row: Row;
        try { row = JSON.parse(line) as Row; } catch { continue; } // @silent-fallback-ok — a torn last line is skipped
        if (!row || row.v !== 1 || typeof row.at !== 'number') continue;
        if (row.kind === 'intent' || row.kind === 'receipt') oldest = oldest === null ? row.at : Math.min(oldest, row.at);
        if (row.kind === 'intent' && typeof row.channel === 'string') pending.set(row.id, { channel: row.channel, at: row.at });
        if (row.kind !== 'receipt') continue;
        pending.delete(row.id);
        const evidence = validateMessageOriginEvidence(row.origin);
        if (!evidence || !row.channel || !row.ts) continue;
        const k = this.key(row.channel, row.ts);
        if (row.method && POST_METHODS.has(row.method)) { if (!posts.has(k)) posts.set(k, evidence); }
        else if (row.method === 'chat.update') revisions.set(k, evidence);
      }
    }
    // Reserves of an earlier incarnation are never reused (they are not loaded).
    while (posts.size > MAX_INDEX) posts.delete(posts.keys().next().value as string);
    while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value as string);
    this.posts = posts; this.revisions = revisions; this.pending = pending; this.coversSinceMs = oldest;
  }
}
