/**
 * standby-durable-forward-without-token §10 — maturation evidence for the token-less
 * durable forward, carried to the machine where the ladder review runs.
 *
 * The maturation review reads only local logs and runs only on the lease holder,
 * but the events it needs (a held reply that expired undelivered, a relay failure before anything was prepared
 * while the gate was live) happen on the token-less standby. So the standby keeps
 * a small OUTBOX of such events and rides them on its next mesh `capabilities` or
 * `submit` as a command-level `forwardContext`. The holder records each event once
 * per (sender, id) in its feature-evidence log and acknowledges the ids; the
 * standby then stops resending them.
 *
 * Signal only: nothing here changes how a command is handled. The contents are
 * self-reported by the agent's own authenticated machines.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const TOKENLESS_FORWARD_FEATURE_ID = 'telegram.tokenlessDurableForward';
export type TokenlessEventKind = 'expired-undelivered' | 'not-sent-while-live';
const EVENT_KINDS: ReadonlySet<string> = new Set<TokenlessEventKind>(['expired-undelivered', 'not-sent-while-live']);
/** Per-command bound (§10 decision row): 50 events, 16 KB. Excess waits for the next command. */
export const FORWARD_CONTEXT_MAX_EVENTS = 50;
export const FORWARD_CONTEXT_MAX_BYTES = 16 * 1024;
/** Seen-id retention matches the ladder window (14 days). */
export const SEEN_ID_RETENTION_MS = 14 * 24 * 60 * 60_000;

export interface TokenlessEvent { id: string; kind: TokenlessEventKind; at: number }
export interface ForwardContext { tokenless: true; resealed?: boolean; heldMs?: number; events?: TokenlessEvent[] }

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; } // @silent-fallback-ok — a missing/corrupt evidence file starts empty; evidence is a signal, never authority
}
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/** Validate and bound an incoming `forwardContext`. Anything malformed is ignored. */
export function sanitizeForwardContext(raw: unknown): ForwardContext | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.tokenless !== true) return null;
  const events: TokenlessEvent[] = [];
  let bytes = 0;
  for (const e of Array.isArray(r.events) ? r.events : []) {
    if (events.length >= FORWARD_CONTEXT_MAX_EVENTS) break;
    const ev = e as Record<string, unknown>;
    if (typeof ev?.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(ev.id) || typeof ev.kind !== 'string' || !EVENT_KINDS.has(ev.kind) ||
      typeof ev.at !== 'number' || !Number.isFinite(ev.at)) continue;
    bytes += ev.id.length + 64;
    if (bytes > FORWARD_CONTEXT_MAX_BYTES) break;
    events.push({ id: ev.id, kind: ev.kind as TokenlessEventKind, at: ev.at });
  }
  return { tokenless: true, ...(typeof r.resealed === 'boolean' ? { resealed: r.resealed } : {}),
    ...(typeof r.heldMs === 'number' && Number.isFinite(r.heldMs) && r.heldMs >= 0 ? { heldMs: r.heldMs } : {}), events };
}

/** Standby side: events waiting to reach the holder. Ids are fixed when written. */
export class StandbyEvidenceOutbox {
  private readonly file: string;
  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, 'state', 'tokenless-forward-evidence-outbox.json');
  }
  /** `key` (for example the operation id) makes the id deterministic, so a retried report of the
   * same event (an expiry whose hub post threw and is re-run) is written once here and counted
   * once on the holder, whose seen-id file dedupes per (sender, id). */
  add(kind: TokenlessEventKind, key?: string): string {
    const id = key ? `${kind}-${crypto.createHash('sha256').update(`${kind}\0${key}`).digest('hex').slice(0, 24)}` : crypto.randomUUID();
    const rows = readJson<TokenlessEvent[]>(this.file, []);
    if (rows.some(r => r.id === id)) return id;
    rows.push({ id, kind, at: this.now() });
    writeJsonAtomic(this.file, rows);
    return id;
  }
  /** At most one command's worth, oldest first. */
  pending(): TokenlessEvent[] { return readJson<TokenlessEvent[]>(this.file, []).slice(0, FORWARD_CONTEXT_MAX_EVENTS); }
  ack(ids: readonly string[]): void {
    if (!ids.length) return;
    const drop = new Set(ids);
    const rows = readJson<TokenlessEvent[]>(this.file, []);
    const kept = rows.filter(r => !drop.has(r.id));
    if (kept.length !== rows.length) writeJsonAtomic(this.file, kept);
  }
}

/** Holder side: write each event and each delivered operation once, then ack. */
export class HolderEvidenceRecorder {
  private readonly file: string;
  constructor(stateDir: string, private readonly record: (featureId: string, input: { kind: 'fired' | 'error'; reason: string; context?: Record<string, string | number | boolean | null> }) => unknown,
    private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, 'state', 'tokenless-forward-evidence-seen.json');
  }
  /** Returns the event ids now recorded (newly or before): the ack the standby needs. */
  observe(sender: string, ctx: ForwardContext, delivered?: { operationId: string }): string[] {
    const seen = readJson<Record<string, number>>(this.file, {});
    const cutoff = this.now() - SEEN_ID_RETENTION_MS;
    for (const [k, at] of Object.entries(seen)) if (at < cutoff) delete seen[k];
    const ack: string[] = [];
    let changed = false;
    for (const ev of ctx.events ?? []) {
      const key = `${sender}:${ev.id}`;
      if (!(key in seen)) {
        this.record(TOKENLESS_FORWARD_FEATURE_ID, { kind: 'error', reason: ev.kind, context: { originMachineId: sender, eventId: ev.id, at: ev.at } });
        seen[key] = this.now(); changed = true;
      }
      ack.push(ev.id);
    }
    if (delivered) {
      const key = `${sender}:op:${delivered.operationId}`;
      if (!(key in seen)) {
        this.record(TOKENLESS_FORWARD_FEATURE_ID, { kind: 'fired', reason: ctx.resealed === true ? 'resealed-delivery' : 'forwarded-delivery',
          context: { originMachineId: sender, operationId: delivered.operationId, resealed: ctx.resealed === true, heldMs: ctx.heldMs ?? 0 } });
        seen[key] = this.now(); changed = true;
      }
    }
    if (changed) writeJsonAtomic(this.file, seen);
    return ack;
  }
}
