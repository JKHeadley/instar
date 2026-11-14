/**
 * ConversationListPins — whole conversations a person pinned to the top of their conversation list
 * (docs/specs/conversation-list-pins.md). Not pinned MESSAGES inside a conversation (that is
 * ConversationPins.ts / docs/specs/conversation-pinned-messages.md).
 *
 * A pin belongs to a reader — the same identity unread counts use (`owner`, `msp:<machine>:<user>`,
 * `team:<personKey>`, see ConversationReadMarkers.ts) — and names a conversation by its canonical
 * ref (`app:<uuid>`, `telegram:<topicId>`, `slack:<machineId>:<negative id>`).
 *
 * Every change is an IMMUTABLE event row `{eventId, reader, ref, pinned, atMs}`. For each
 * (reader, ref) the latest event wins: larger `atMs`, then larger `eventId` by code units. The
 * fold is order-independent, so the union of every machine's rows has no conflicts. Rows replicate
 * through the `conversation-list-pin` kind (store key `listPins`), keyed by eventId, the shape of
 * RecommendedServicesReplicatedStore. The store keeps only the latest row per (reader, ref) —
 * an unpin row stays as the tombstone that stops an older pin from coming back.
 *
 * The state file `state/conversation-list-pins.json` (atomic tmp + fsync + rename, mode 0600) is
 * the outbox: each row remembers whether it was shared; a row whose emit was refused is sent again
 * by `flushEmits()` at the next boot.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { InstarConfig } from './types.js';
import { canonicalConversationRef, isReaderKey } from './ConversationReadMarkers.js';

export const LIST_PIN_RECORD_KIND = 'conversation-list-pin';
export const LIST_PINS_STORE_KEY = 'listPins';
/** The most conversations one person may have pinned; a further pin is refused (`pin-limit`). */
export const MAX_LIST_PINS_PER_READER = 50;

/** `mobilePairing.native.listPins.enabled`: omitted ⇒ on wherever native conversations are on. Read live. */
export function isConversationListPinsEnabled(config: InstarConfig): boolean {
  return (config.mobilePairing as { native?: { listPins?: { enabled?: unknown } } } | undefined)?.native?.listPins?.enabled !== false;
}

export interface ListPinEvent { eventId: string; reader: string; ref: string; pinned: boolean; atMs: number }
export interface PinnedRef { ref: string; atMs: number }

const EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A row from untrusted data (a replicated record, the state file), or null. Strict: exact shapes only. */
export function validateListPinEvent(raw: unknown): ListPinEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.eventId !== 'string' || !EVENT_ID_RE.test(r.eventId)) return null;
  if (!isReaderKey(r.reader)) return null;
  const ref = canonicalConversationRef(r.ref);
  if (!ref || ref !== r.ref) return null;
  if (typeof r.pinned !== 'boolean') return null;
  if (typeof r.atMs !== 'number' || !Number.isSafeInteger(r.atMs) || r.atMs < 0) return null;
  return { eventId: r.eventId, reader: r.reader, ref, pinned: r.pinned, atMs: r.atMs };
}

/** >0 ⇒ `a` wins over `b` for the same (reader, ref): later `atMs`, then larger `eventId`. */
export function compareListPinEvents(a: Pick<ListPinEvent, 'atMs' | 'eventId'>, b: Pick<ListPinEvent, 'atMs' | 'eventId'>): number {
  if (a.atMs !== b.atMs) return a.atMs - b.atMs;
  return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
}

function pinKey(reader: string, ref: string): string { return `${reader}\u0000${ref}`; }

/** The fold: the latest event per (reader, ref). Order-independent. */
export function foldListPins(events: Iterable<ListPinEvent>): Map<string, ListPinEvent> {
  const out = new Map<string, ListPinEvent>();
  for (const e of events) {
    const k = pinKey(e.reader, e.ref);
    const cur = out.get(k);
    if (!cur || compareListPinEvents(e, cur) > 0) out.set(k, e);
  }
  return out;
}

/** A reader's pinned refs from folded events: newest pin first (ties by ref, so the order is total). */
export function pinnedRefsOf(folded: Iterable<ListPinEvent>, reader: string): PinnedRef[] {
  const out: PinnedRef[] = [];
  for (const e of folded) if (e.reader === reader && e.pinned) out.push({ ref: e.ref, atMs: e.atMs });
  out.sort((a, b) => (b.atMs - a.atMs) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return out;
}

// ── Replicated kind ────────────────────────────────────────────────────────────────────────────

export function deriveListPinRecordKey(eventId: string): string {
  return crypto.createHash('sha256').update(`conversation-list-pins\u0000${eventId}`).digest('hex');
}

const KNOWN = ['row'] as const;

export const listPinStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN as unknown as ReadonlyArray<string>,
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    // Rows are immutable: an unpin is a new row, never a delete.
    if (raw.op === 'delete') return null;
    const row = validateListPinEvent(raw.row);
    return row ? { row } : null;
  },
};

export function buildListPinRecordData(row: ListPinEvent) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => ({
    row,
    recordKey: deriveListPinRecordKey(row.eventId),
    hlc, op: 'put' as ReplicatedOp, origin,
    ...(observed !== undefined ? { observed } : {}),
  });
}

export const LIST_PINS_KIND_REGISTRATION = {
  kind: LIST_PIN_RECORD_KIND,
  store: LIST_PINS_STORE_KEY,
  schema: listPinStoreSchema,
} as const;

// ── The store ──────────────────────────────────────────────────────────────────────────────────

interface StoredEvent extends ListPinEvent { emitted: boolean }
interface StateFile { v: 1; events: StoredEvent[] }

/** 'emitted' ⇒ shared (or already held by the journal); 'refused' ⇒ send again at the next boot. */
export type ListPinEmitHook = (row: ListPinEvent) => 'emitted' | 'refused';
export type SetPinnedOutcome = 'changed' | 'unchanged' | 'pin-limit';

export interface ListPinStoreDeps {
  stateDir: string;
  now?: () => number;
  newEventId?: () => string;
  report?: (what: string, detail: string) => void;
  maxPerReader?: number;
}

export class ConversationListPinStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly newEventId: () => string;
  private readonly maxPerReader: number;
  /** The latest event per (reader, ref). */
  private readonly latest = new Map<string, StoredEvent>();
  private hook: ListPinEmitHook | null = null;

  constructor(private readonly deps: ListPinStoreDeps) {
    this.file = path.join(deps.stateDir, 'state', 'conversation-list-pins.json');
    this.now = deps.now ?? Date.now;
    this.newEventId = deps.newEventId ?? (() => crypto.randomUUID());
    this.maxPerReader = deps.maxPerReader ?? MAX_LIST_PINS_PER_READER;
    this.load();
  }

  // ── Reads ──

  pinnedFor(reader: string): PinnedRef[] { return pinnedRefsOf(this.latest.values(), reader); }

  isPinned(reader: string, ref: string): boolean { return this.latest.get(pinKey(reader, ref))?.pinned === true; }

  /** Every stored row (the latest per reader × ref), for tests and diagnostics. */
  rows(): ListPinEvent[] { return [...this.latest.values()].map(({ emitted: _e, ...e }) => e); }

  // ── Local writes ──

  /**
   * Pin or unpin one conversation for one reader. Idempotent: a call that matches the current
   * state writes nothing. A 51st pin is refused. A new row's `atMs` is after the row it replaces,
   * so a local change always wins over what this machine already holds, whatever its clock says.
   */
  setPinned(reader: string, ref: string, pinned: boolean): { outcome: SetPinnedOutcome; pinned: PinnedRef[] } {
    if (!isReaderKey(reader)) throw new Error('bad reader key');
    const canonical = canonicalConversationRef(ref);
    if (!canonical || canonical !== ref) throw new Error('bad conversation ref');
    const k = pinKey(reader, ref);
    const cur = this.latest.get(k);
    if ((cur?.pinned ?? false) === pinned) return { outcome: 'unchanged', pinned: this.pinnedFor(reader) };
    if (pinned && this.pinnedFor(reader).length >= this.maxPerReader) return { outcome: 'pin-limit', pinned: this.pinnedFor(reader) };
    const atMs = Math.max(Math.floor(this.now()), cur ? cur.atMs + 1 : 0);
    const row: StoredEvent = { eventId: this.newEventId(), reader, ref, pinned, atMs, emitted: false };
    if (!validateListPinEvent(row)) throw new Error('bad pin row');
    this.latest.set(k, row);
    this.emitOne(row);
    this.flush();
    return { outcome: 'changed', pinned: this.pinnedFor(reader) };
  }

  // ── Landing ──

  /** Land a row from a peer. Never emits. A row that does not win its key is ignored. */
  ingestReplicated(raw: unknown): 'accepted' | 'ignored' | 'invalid' {
    const e = validateListPinEvent(raw);
    if (!e) return 'invalid';
    const k = pinKey(e.reader, e.ref);
    const cur = this.latest.get(k);
    if (cur && compareListPinEvents(e, cur) <= 0) return 'ignored';
    this.latest.set(k, { ...e, emitted: true });
    this.flush();
    return 'accepted';
  }

  ingestReplicatedAll(rows: Iterable<unknown>): number {
    let n = 0;
    for (const r of rows) if (this.ingestReplicated(r) === 'accepted') n++;
    return n;
  }

  // ── Replication out ──

  setReplicationHook(hook: ListPinEmitHook | null): void { this.hook = hook; }

  /** Rows written here and not yet shared. */
  dueCount(): number { let n = 0; for (const e of this.latest.values()) if (!e.emitted) n++; return n; }

  /** Send every row not yet shared (the boot re-send). */
  flushEmits(): { emitted: number; held: number } {
    let emitted = 0; let held = 0;
    if (!this.hook) return { emitted, held: this.dueCount() };
    for (const e of this.latest.values()) {
      if (e.emitted) continue;
      if (this.emitOne(e)) emitted++; else held++;
    }
    if (emitted > 0) this.flush();
    return { emitted, held };
  }

  private emitOne(e: StoredEvent): boolean {
    if (!this.hook) return false;
    let out: 'emitted' | 'refused' = 'refused';
    const { emitted: _e, ...row } = e;
    try { out = this.hook(row); } catch (err) {
      // @silent-fallback-ok — reported; the row stays unshared and is sent again at the next boot
      this.deps.report?.('ConversationListPins.emit', err instanceof Error ? err.message : String(err));
    }
    if (out === 'emitted') e.emitted = true;
    return e.emitted;
  }

  // ── Persistence ──

  private load(): void {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return; } // @silent-fallback-ok — no file yet is the first boot
    try {
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      for (const r of Array.isArray(parsed.events) ? parsed.events : []) {
        const e = validateListPinEvent(r);
        if (!e) continue;
        const k = pinKey(e.reader, e.ref);
        const cur = this.latest.get(k);
        if (!cur || compareListPinEvents(e, cur) > 0) this.latest.set(k, { ...e, emitted: (r as { emitted?: unknown }).emitted === true });
      }
    } catch (err) {
      // @silent-fallback-ok — reported; an unreadable file starts empty and peers' rows land again from the journal
      this.deps.report?.('ConversationListPins.load', `state file unreadable, starting empty: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Write the state file now (tmp + fsync + rename, mode 0600). Memory stays authoritative on failure. */
  flush(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const state: StateFile = { v: 1, events: [...this.latest.values()] };
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      // @silent-fallback-ok — reported; memory stays authoritative and the next change retries the write
      this.deps.report?.('ConversationListPins.flush', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  get filePath(): string { return this.file; }
}
