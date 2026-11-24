/** Personal preferences are historical choices, never conversation access grants. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isReaderKey } from './ConversationReadMarkers.js';
import { APP_CONVERSATION_KEY_RE } from './appConversationText.js';
import { parseCanonicalKey, WORKSPACE_PLACEHOLDER } from './conversationIdentity.js';
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
export const PREFERENCE_RECORD_KIND = 'conversation-preference';
export const PREFERENCES_STORE_KEY = 'conversationPreferences';
export type PreferenceField = 'muted' | 'archived';
export interface PreferenceEvent { eventId: string; reader: string; ref: string; field: PreferenceField; value: boolean; atMs: number }
export type PreferenceEmissionStatus = 'pending' | 'emitted' | 'superseded' | 'unavailable';
export function canonicalPreferenceRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const app = raw.startsWith('app:') ? raw.slice(4) : raw;
  if (APP_CONVERSATION_KEY_RE.test(app)) return `app:${app}`;
  const tg = /^telegram:(-?[1-9][0-9]*):([1-9][0-9]*)$/.exec(raw);
  if (tg && Number.isSafeInteger(Number(tg[1])) && Number.isSafeInteger(Number(tg[2]))) return raw;
  const slack = parseCanonicalKey(raw);
  return slack && slack.workspaceId !== WORKSPACE_PLACEHOLDER ? raw : null;
}
export function validatePreferenceEvent(raw: unknown): PreferenceEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).some(k => !['eventId', 'reader', 'ref', 'field', 'value', 'atMs'].includes(k))) return null;
  if (typeof r.eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(r.eventId) || !isReaderKey(r.reader)) return null;
  if (!canonicalPreferenceRef(r.ref) || canonicalPreferenceRef(r.ref) !== r.ref || (r.field !== 'muted' && r.field !== 'archived') || typeof r.value !== 'boolean' || !Number.isSafeInteger(r.atMs) || (r.atMs as number) < 0) return null;
  return { eventId: r.eventId, reader: r.reader, ref: r.ref as string, field: r.field, value: r.value, atMs: r.atMs as number };
}
export function comparePreferenceEvents(a: PreferenceEvent, b: PreferenceEvent): number { return a.atMs - b.atMs || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0); }
export const derivePreferenceRecordKey = (id: string): string => crypto.createHash('sha256').update(`conversation-preferences\0${id}`).digest('hex');
export const preferenceStoreSchema: StoreFieldSchema = { knownFields: ['row'], validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext) { const row = raw.op === 'delete' ? null : validatePreferenceEvent(raw.row); return row ? { row } : null; } };
export const PREFERENCES_KIND_REGISTRATION = { kind: PREFERENCE_RECORD_KIND, store: PREFERENCES_STORE_KEY, schema: preferenceStoreSchema } as const;
export function buildPreferenceRecordData(row: PreferenceEvent) { return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> => ({ row, recordKey: derivePreferenceRecordKey(row.eventId), hlc, op: 'put' as ReplicatedOp, origin, ...(observed ? { observed } : {}) }); }
interface Stored { row: PreferenceEvent; emitted: boolean }
export interface PreferenceStoreDeps { stateDir: string; now?: () => number; newEventId?: () => string; report?: (what: string, detail: string) => void }
export class ConversationPreferencesStore {
  private state = new Map<string, Stored>();
  private winners = new Map<string, PreferenceEvent>();
  private pendingCount = 0;
  private hook: ((row: PreferenceEvent) => 'emitted' | 'refused') | null = null;
  private ready = false;
  private version = 0;
  private readiness = 0;
  readonly filePath: string;
  constructor(private readonly deps: PreferenceStoreDeps) { this.filePath = path.join(deps.stateDir, 'state', 'conversation-preferences.json'); this.reload(); }
  get readable(): boolean { return this.ready; }
  isReadable(): boolean { return this.ready; }
  get generation(): number { return this.version; }
  get readinessVersion(): number { return this.readiness; }
  /** Retain exactly the field winner, including false tombstones and its outbox bit. */
  private compact(rows: Map<string, Stored>): Map<string, Stored> {
    const fields = new Map<string, Stored>();
    for (const held of rows.values()) { const r = held.row; const key = `${r.reader}\0${r.ref}\0${r.field}`; const prior = fields.get(key); if (!prior || comparePreferenceEvents(r, prior.row) > 0) fields.set(key, held); }
    return new Map([...fields.values()].map(held => [held.row.eventId, held]));
  }
  /** Replace durable state and its derived read index together after a successful load or save. */
  private installState(state: Map<string, Stored>): void {
    const winners = new Map<string, PreferenceEvent>();
    let pending = 0;
    for (const held of state.values()) {
      const row = held.row;
      winners.set(this.fieldKey(row.reader, row.ref, row.field), row);
      if (!held.emitted) pending++;
    }
    this.state = state;
    this.winners = winners;
    this.pendingCount = pending;
  }
  private fieldKey(reader: string, ref: string, field: PreferenceField): string {
    return `${reader}\0${ref}\0${field}`;
  }
  private latest(reader: string, ref: string, field: PreferenceField): PreferenceEvent | undefined {
    return this.winners.get(this.fieldKey(reader, ref, field));
  }
  get(reader: string, ref: string): { muted: boolean; archived: boolean } | null { return this.ready ? { muted: this.latest(reader, ref, 'muted')?.value ?? false, archived: this.latest(reader, ref, 'archived')?.value ?? false } : null; }
  rows(): PreferenceEvent[] { return [...this.state.values()].map(e => ({ ...e.row })); }
  prepareOperation(reader: string, ref: string, changes: Partial<Record<PreferenceField, boolean>>): PreferenceEvent[] {
    if (!this.ready) throw new Error('preferences unavailable');
    if (!isReaderKey(reader) || canonicalPreferenceRef(ref) !== ref || !Object.keys(changes).length || Object.keys(changes).some(k => !['muted', 'archived'].includes(k))) throw new Error('invalid preference operation');
    return (['muted', 'archived'] as const).filter(field => Object.hasOwn(changes, field)).map(field => {
      const row: PreferenceEvent = { eventId: this.deps.newEventId?.() ?? crypto.randomUUID(), reader, ref, field, value: changes[field]!, atMs: Math.max(Math.floor(this.deps.now?.() ?? Date.now()), (this.latest(reader, ref, field)?.atMs ?? -1) + 1) };
      if (!validatePreferenceEvent(row)) throw new Error('invalid or overflowing preference event');
      return row;
    });
  }
  applyReserved(rows: readonly PreferenceEvent[]): void {
    if (!this.ready) throw new Error('preferences unavailable');
    const next = new Map(this.state);
    for (const raw of rows) { const row = validatePreferenceEvent(raw); if (!row) throw new Error('invalid reserved preference event'); const prior = next.get(row.eventId); if (prior && JSON.stringify(prior.row) !== JSON.stringify(row)) throw new Error('preference event identity conflict'); if (!prior) next.set(row.eventId, { row, emitted: false }); }
    const folded = this.compact(next);
    if (JSON.stringify([...folded]) !== JSON.stringify([...this.state])) this.persist(folded);
    this.flushEmits();
  }
  ingestReplicated(raw: unknown): 'accepted' | 'ignored' | 'invalid' {
    const row = validatePreferenceEvent(raw); if (!row || !this.ready) return 'invalid';
    const prior = this.state.get(row.eventId); if (prior) return JSON.stringify(prior.row) === JSON.stringify(row) ? 'ignored' : 'invalid';
    const next = new Map(this.state); next.set(row.eventId, { row, emitted: true }); const folded = this.compact(next); if (!folded.has(row.eventId)) return 'ignored'; this.persist(folded); return 'accepted';
  }
  emissionStatus(row: PreferenceEvent): PreferenceEmissionStatus {
    if (!this.ready) return 'unavailable';
    const winner = this.latest(row.reader, row.ref, row.field); if (winner && comparePreferenceEvents(winner, row) > 0) return 'superseded';
    const held = this.state.get(row.eventId); if (!held || JSON.stringify(held.row) !== JSON.stringify(row)) return 'unavailable'; return held.emitted ? 'emitted' : 'pending';
  }
  setReplicationHook(hook: ((row: PreferenceEvent) => 'emitted' | 'refused') | null): void { this.hook = hook; }
  confirmEmitted(eventId: string): boolean { return this.confirmEmittedBatch([eventId]) > 0; }
  /** Commit only durable acknowledgments that still identify the current field winners. */
  confirmEmittedBatch(eventIds: Iterable<string>): number {
    if (!this.ready) return 0;
    const next = new Map(this.state);
    let confirmed = 0;
    for (const eventId of new Set(eventIds)) {
      const held = next.get(eventId);
      if (!held || held.emitted || this.latest(held.row.reader, held.row.ref, held.row.field)?.eventId !== eventId) continue;
      next.set(eventId, { ...held, emitted: true }); confirmed++;
    }
    if (confirmed > 0) this.persist(next);
    return confirmed;
  }
  dueCount(): number { return this.pendingCount; }
  flushEmits(): { emitted: number; held: number } {
    if (!this.ready || !this.hook) return { emitted: 0, held: this.dueCount() };
    const acknowledged = new Set<string>();
    for (const stored of [...this.state.values()]) {
      // A hook can reenter this store; inspect the current winner before every emit.
      const current = this.state.get(stored.row.eventId);
      if (!current || current.emitted || this.latest(current.row.reader, current.row.ref, current.row.field)?.eventId !== current.row.eventId) continue;
      try {
        if (this.hook({ ...current.row }) === 'emitted') acknowledged.add(current.row.eventId);
      } catch (err) {
        // @silent-fallback-ok — durable outbox remains pending for a later retry
        this.deps.report?.('ConversationPreferences.emit', String(err));
      }
    }
    // Merge into the latest state, rather than a pre-hook copy: reentrant confirmations
    // and new field winners must survive this one acknowledgment save.
    const next = new Map(this.state);
    let emitted = 0;
    for (const eventId of acknowledged) {
      const held = next.get(eventId);
      if (!held || held.emitted || this.latest(held.row.reader, held.row.ref, held.row.field)?.eventId !== eventId) continue;
      next.set(eventId, { ...held, emitted: true });
      emitted++;
    }
    if (emitted > 0) this.persist(next);
    return { emitted, held: this.dueCount() };
  }
  reload(): boolean {
    try { const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as { v?: unknown; events?: unknown }; if (parsed.v !== 1 || !Array.isArray(parsed.events)) throw new Error('invalid preference state'); const next = new Map<string, Stored>(); for (const raw of parsed.events) { const r = raw as Stored; const row = validatePreferenceEvent(r.row); if (!row || typeof r.emitted !== 'boolean' || next.has(row.eventId)) throw new Error('invalid preference row'); next.set(row.eventId, { row, emitted: r.emitted }); } this.installState(this.compact(next)); this.ready = true; this.version++; this.readiness++; return true;
    } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') { try { this.persist(new Map()); this.ready = true; this.readiness++; return true; } catch { /* @silent-fallback-ok — persist reported failure; remain unavailable */ } } else this.deps.report?.('ConversationPreferences.load', String(err)); this.ready = false; this.readiness++; return false; }
  }
  private persist(next: Map<string, Stored>): void {
    const tmp = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    try { fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 }); const fd = fs.openSync(tmp, 'wx', 0o600); try { fs.writeFileSync(fd, JSON.stringify({ v: 1, events: [...next.values()] })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(tmp, this.filePath); const dir = fs.openSync(path.dirname(this.filePath), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } this.installState(next); this.version++; }
    catch (err) { this.ready = false; this.readiness++; this.deps.report?.('ConversationPreferences.persist', String(err)); throw err; }
  }
}
export { ConversationPreferencesStore as ConversationPreferenceStore };
