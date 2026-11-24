/** Typed, reader-bound push evidence. Old senders never inspect this sidecar. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PushTrigger } from './MobilePush.js';

export const TYPED_PUSH_PENDING_FILE = 'mobile-push-pending-v1.json';
export type PushAdmissionReason = 'eligible' | 'muted' | 'reader-changed' | 'reader-unavailable' | 'witness-unreadable' | 'preferences-unavailable' | 'legacy-unbound' | 'device-unavailable' | 'device-standing-unavailable';
export interface PushAdmissionFacts {
  intendedReader: string | null; currentReader: string | null; active: boolean; standingKnown?: boolean;
  kind: 'reply' | 'notice' | 'legacy'; witnessReadable: boolean; muted: boolean | null;
}
export function evaluatePushAdmission(f: PushAdmissionFacts): { disposition: 'send' | 'hold' | 'discard'; reason: PushAdmissionReason } {
  if (!f.active) return { disposition: 'discard', reason: 'device-unavailable' };
  if (f.standingKnown === false) return { disposition: 'hold', reason: 'device-standing-unavailable' };
  if (f.kind === 'legacy' || f.intendedReader === null) return { disposition: 'hold', reason: 'legacy-unbound' };
  if (f.currentReader === null) return { disposition: 'hold', reason: 'reader-unavailable' };
  if (f.currentReader !== f.intendedReader) return { disposition: 'hold', reason: 'reader-changed' };
  if (!f.witnessReadable) return { disposition: 'hold', reason: 'witness-unreadable' };
  if (f.kind === 'reply' && f.muted === null) return { disposition: 'hold', reason: 'preferences-unavailable' };
  if (f.kind === 'reply' && f.muted === true) return { disposition: 'discard', reason: 'muted' };
  return { disposition: 'send', reason: 'eligible' };
}
export interface BoundPushContribution {
  key: string; version: number; deviceId: string; intendedReader: string | null;
  ref: string | null; kind: 'reply' | 'notice'; count: number; trigger: PushTrigger;
}
export interface LegacyPushSlot { pending: { count: number; hasUrgent: boolean }; dueAt: number | null; version?: string }
interface LegacyCapture { deviceId: string; fingerprint: string; count: number; hasUrgent: boolean }
interface PendingState {
  v: 1; sequence: number; receipts: Record<string, number>; contributions: Record<string, BoundPushContribution>;
  legacy: Record<string, LegacyCapture & { episodeId: string }>;
  migration: { id: string; phase: 'capture' | 'copied' | 'complete'; captures: LegacyCapture[] } | null;
}
export function legacyPushFingerprint(slot: LegacyPushSlot): string {
  return crypto.createHash('sha256').update(JSON.stringify(slot)).digest('hex');
}
/** File and parent directory are synced before the caller acknowledges durability. */
export function savePushJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export class MobilePushPending {
  private state: PendingState | null = null;
  private unreadable = false;
  constructor(readonly file: string, private readonly checkpoint?: (stage: string) => void) {}
  private load(): PendingState | null {
    if (this.state) return this.state;
    if (this.unreadable) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as PendingState;
      if (raw.v !== 1 || !Number.isSafeInteger(raw.sequence) || !raw.contributions || !raw.legacy || !(raw.migration === null || ['capture', 'copied', 'complete'].includes(raw.migration.phase))) throw new Error('typed-pending-invalid');
      if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 0 || Array.isArray(raw.contributions) || Array.isArray(raw.legacy)) throw new Error('typed-pending-invalid');
      for (const [key, c] of Object.entries(raw.contributions)) {
        if (!c || c.key !== key || !Number.isSafeInteger(c.version) || c.version < 1 || c.version > raw.sequence || typeof c.deviceId !== 'string' || !(c.intendedReader === null || typeof c.intendedReader === 'string') || !(c.ref === null || typeof c.ref === 'string') || !['reply', 'notice'].includes(c.kind) || !Number.isSafeInteger(c.count) || c.count < 1 || !c.trigger || !['reply', 'notice', 'item', 'document'].includes(c.trigger.kind) || typeof c.trigger.dedupeKey !== 'string' || typeof c.trigger.sourceMachine !== 'string' || (c.kind === 'reply') !== (c.trigger.kind === 'reply') || (c.kind === 'reply' && c.count !== 1)) throw new Error('typed-pending-invalid');
      }
      for (const c of Object.values(raw.legacy)) if (!c || typeof c.deviceId !== 'string' || typeof c.episodeId !== 'string' || typeof c.fingerprint !== 'string' || !Number.isSafeInteger(c.count) || c.count < 1 || typeof c.hasUrgent !== 'boolean') throw new Error('typed-pending-invalid');
      if (raw.migration && (typeof raw.migration.id !== 'string' || !Array.isArray(raw.migration.captures) || raw.migration.captures.some(c => !c || typeof c.deviceId !== 'string' || typeof c.fingerprint !== 'string' || !Number.isSafeInteger(c.count) || c.count < 1 || typeof c.hasUrgent !== 'boolean'))) throw new Error('typed-pending-invalid');
      raw.receipts ??= {};
      if (Array.isArray(raw.receipts) || Object.values(raw.receipts).some(at => typeof at !== 'number' || !Number.isFinite(at))) throw new Error('typed-pending-invalid');
      this.state = raw;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') { this.unreadable = true; return null; }
      this.state = { v: 1, sequence: 0, receipts: {}, contributions: {}, legacy: {}, migration: null };
    }
    return this.state;
  }
  private save(): void { if (this.state) try { savePushJson(this.file, this.state); } catch (err) { this.state = null; this.unreadable = true; throw err; } }
  /** Mutation/boot path only. Read/status paths never run migration. */
  migrate(readLegacy: () => Record<string, LegacyPushSlot>, clear: (captures: ReadonlyArray<LegacyCapture>) => boolean): boolean {
    const st = this.load(); if (!st) return false;
    if (st.migration?.phase === 'complete' && Object.keys(readLegacy()).length === 0) return true;
    if (!st.migration || st.migration.phase === 'complete') {
      st.migration = { id: crypto.randomUUID(), phase: 'capture', captures: [] };
      this.save(); this.checkpoint?.('episode-durable');
    }
    const episode = st.migration;
    if (episode.phase === 'capture') {
      const slots = readLegacy();
      episode.captures = Object.entries(slots).map(([deviceId, slot]) => {
        if (!Number.isSafeInteger(slot.pending.count) || slot.pending.count < 1 || typeof slot.pending.hasUrgent !== 'boolean') throw new Error('legacy-pending-unreadable');
        return { deviceId, fingerprint: legacyPushFingerprint(slot), count: slot.pending.count, hasUrgent: slot.pending.hasUrgent };
      });
      for (const capture of episode.captures) {
        const prior = st.legacy[capture.deviceId];
        if (prior?.episodeId === episode.id && prior.fingerprint === capture.fingerprint) continue;
        const count = (prior?.count ?? 0) + capture.count;
        if (!Number.isSafeInteger(count)) throw new Error('legacy-pending-count-overflow');
        st.legacy[capture.deviceId] = { ...capture, count, hasUrgent: (prior?.hasUrgent ?? false) || capture.hasUrgent, episodeId: episode.id };
      }
      episode.phase = 'copied'; this.save(); this.checkpoint?.('copy-durable');
    }
    if (episode.phase === 'copied') {
      for (const capture of episode.captures) {
        const recorded = st.legacy[capture.deviceId];
        if (!recorded || recorded.episodeId !== episode.id || recorded.fingerprint !== capture.fingerprint || recorded.count < capture.count || (capture.hasUrgent && !recorded.hasUrgent)) return false;
      }
      const current = readLegacy();
      if (episode.captures.some((capture) => current[capture.deviceId] && legacyPushFingerprint(current[capture.deviceId]!) !== capture.fingerprint)) return false;
      if (!clear(episode.captures)) return false;
      this.checkpoint?.('old-clear-durable');
      episode.phase = 'complete'; this.save(); this.checkpoint?.('complete-durable');
    }
    return Object.keys(readLegacy()).length === 0;
  }
  ready(): boolean { return this.load()?.migration?.phase === 'complete'; }
  enqueue(deviceId: string, reader: string | null, ref: string | null, trigger: PushTrigger): BoundPushContribution | null {
    const st = this.load(); if (!st || st.migration?.phase !== 'complete') return null;
    const next = this.prepare(st, deviceId, reader, ref, trigger); this.save(); return next;
  }
  /** One durable transaction publishes all intended recipients and its dedupe receipt together. */
  enqueueBatch(recipients: ReadonlyArray<{ deviceId: string; reader: string | null; ref: string | null }>, trigger: PushTrigger, now: number, windowMs = 600_000): 'accepted' | 'deduped' | 'unavailable' {
    const st = this.load(); if (!st || st.migration?.phase !== 'complete') return 'unavailable';
    const recorded = st.receipts[trigger.dedupeKey];
    if (recorded !== undefined && now - recorded <= windowMs) return 'deduped';
    const draft = structuredClone(st);
    for (const [key, at] of Object.entries(draft.receipts)) if (now - at > windowMs) delete draft.receipts[key];
    for (const r of recipients) { this.prepare(draft, r.deviceId, r.reader, r.ref, trigger); this.checkpoint?.('batch-recipient-prepared'); }
    draft.receipts[trigger.dedupeKey] = now;
    this.checkpoint?.('batch-before-persist');
    this.state = draft; this.save(); this.checkpoint?.('batch-durable');
    return 'accepted';
  }
  private prepare(st: PendingState, deviceId: string, reader: string | null, ref: string | null, trigger: PushTrigger): BoundPushContribution {
    const identity = trigger.kind === 'reply' ? ['reply', ref ?? trigger.conversationKey ?? 'unknown']
      : [trigger.kind, trigger.itemId ?? '', trigger.commentKey ?? '', trigger.decide ?? '', trigger.subject ?? '', trigger.sourceMachine];
    const key = crypto.createHash('sha256').update(JSON.stringify([deviceId, reader, identity])).digest('hex');
    if (st.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('typed-pending-sequence-overflow');
    const old = st.contributions[key];
    if (trigger.kind !== 'reply' && (old?.count ?? 0) >= Number.MAX_SAFE_INTEGER) throw new Error('typed-pending-count-overflow');
    const next: BoundPushContribution = {
      key, version: ++st.sequence, deviceId, intendedReader: reader, ref, kind: trigger.kind === 'reply' ? 'reply' : 'notice',
      count: trigger.kind === 'reply' ? 1 : (old?.count ?? 0) + 1,
      trigger: { kind: trigger.kind, dedupeKey: trigger.dedupeKey, sourceMachine: trigger.sourceMachine,
        ...(trigger.itemId === undefined ? {} : { itemId: trigger.itemId }), ...(trigger.commentKey === undefined ? {} : { commentKey: trigger.commentKey }),
        ...(trigger.decide === undefined ? {} : { decide: trigger.decide }), ...(trigger.conversationKey === undefined ? {} : { conversationKey: trigger.conversationKey }),
        ...(trigger.messageId === undefined ? {} : { messageId: trigger.messageId }), ...(trigger.subject === undefined ? {} : { subject: trigger.subject }),
        ...(trigger.kind !== 'reply' && ((old?.trigger.priority ?? '').toUpperCase() === 'URGENT' || (trigger.priority ?? '').toUpperCase() === 'URGENT') ? { priority: 'URGENT' } : trigger.priority === undefined ? {} : { priority: trigger.priority }) },
    };
    st.contributions[key] = next; return next;
  }
  forDevice(id: string): BoundPushContribution[] { return Object.values(this.load()?.contributions ?? {}).filter((item) => item.deviceId === id).map((item) => ({ ...item, trigger: { ...item.trigger } })); }
  deviceIds(): string[] { return [...new Set(Object.values(this.load()?.contributions ?? {}).map((item) => item.deviceId))]; }
  acknowledge(items: ReadonlyArray<Pick<BoundPushContribution, 'key' | 'version'>>): void {
    const st = this.load(); if (!st) return;
    let changed = false;
    for (const item of items) if (st.contributions[item.key]?.version === item.version) { delete st.contributions[item.key]; changed = true; }
    if (changed) this.save();
  }
  legacyCount(deviceId?: string): number | null {
    const st = this.load(); if (!st) return null;
    return Object.values(st.legacy).filter((item) => deviceId === undefined || item.deviceId === deviceId).reduce((sum, item) => sum + item.count, 0);
  }
  unboundCount(): number | null { const st = this.load(); const legacy = this.legacyCount(); return !st || legacy === null ? null : legacy + Object.values(st.contributions).filter(c => c.intendedReader === null).reduce((n, c) => n + c.count, 0); }
  status(): { readable: boolean; migrationComplete: boolean; legacyCount: number | null; pending: number } {
    const st = this.load();
    return { readable: !!st, migrationComplete: st?.migration?.phase === 'complete', legacyCount: this.legacyCount(), pending: st ? Object.values(st.contributions).reduce((sum, item) => sum + item.count, 0) : 0 };
  }
}
