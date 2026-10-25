/**
 * logs/feedback-triage.jsonl (docs/specs/feedback-triage-and-execution.md §2, "Audit").
 *
 * One line per decision, floor, transition and self-heal event: ids, dispositions, reasons,
 * scores and floors — never report text. Rotated at 20 MB; rotated segments are kept 90 days.
 * Also owns the scrubbed packet files (14-day retention, never served raw over HTTP).
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

export const TRIAGE_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const TRIAGE_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const TRIAGE_PACKET_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

const SAFE_VALUE = /^[\w.:/@#+=-]*$/;

/** Only ids, enums, numbers and booleans pass through; any other string is reduced to its length. */
function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length <= 200 && SAFE_VALUE.test(value) ? value : `[text:${value.length}]`;
  if (depth > 3) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>).slice(0, 60)) out[key.slice(0, 60)] = sanitize(v, depth + 1);
    return out;
  }
  return String(value);
}

export class FeedbackTriageAuditLog {
  private readonly logPath: string;
  constructor(logsDir: string, private readonly packetsDir: string, private readonly now: () => number = Date.now) {
    this.logPath = path.join(logsDir, 'feedback-triage.jsonl');
  }

  path(): string { return this.logPath; }

  append(event: string, fields: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      this.rotateIfNeeded();
      const row = { ts: new Date(this.now()).toISOString(), event, ...(sanitize(fields) as Record<string, unknown>) };
      fs.appendFileSync(this.logPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    } catch (error) {
      // @silent-fallback-ok: the durable decision lives in feedback-drain.db; the jsonl is a secondary audit copy.
      console.warn('[feedback-triage] audit append failed:', error instanceof Error ? error.message : String(error));
    }
  }

  private rotateIfNeeded(): void {
    let size = 0;
    try { size = fs.statSync(this.logPath).size; } catch { return; }
    if (size < TRIAGE_LOG_MAX_BYTES) return;
    const stamp = new Date(this.now()).toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    fs.renameSync(this.logPath, `${this.logPath}.${stamp}`);
    this.pruneRotated();
  }

  /** Remove rotated segments older than 90 days. */
  pruneRotated(): number {
    const dir = path.dirname(this.logPath);
    const base = path.basename(this.logPath);
    let removed = 0;
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return 0; }
    for (const name of names) {
      if (!name.startsWith(`${base}.`)) continue;
      const full = path.join(dir, name);
      try {
        if (this.now() - fs.statSync(full).mtimeMs > TRIAGE_LOG_RETENTION_MS) {
          SafeFsExecutor.safeUnlinkSync(full, { operation: 'feedback-triage audit log retention' });
          removed++;
        }
      } catch { /* @silent-fallback-ok: a segment that vanished or cannot be stat'ed is retried next prune */ }
    }
    return removed;
  }

  writePacket(packetRef: string, packet: unknown): void {
    if (!/^pkt-[a-f0-9]{24}$/.test(packetRef)) throw new Error('invalid packet ref');
    fs.mkdirSync(this.packetsDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.packetsDir, `${packetRef}.json`);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(packet), { mode: 0o600 });
    fs.renameSync(tmp, target);
  }

  readPacket(packetRef: string): unknown | null {
    if (!/^pkt-[a-f0-9]{24}$/.test(packetRef)) return null;
    try { return JSON.parse(fs.readFileSync(path.join(this.packetsDir, `${packetRef}.json`), 'utf8')); } catch { return null; }
  }

  /** 14-day packet retention. Bounded per call. */
  prunePackets(limit = 500): number {
    let names: string[] = [];
    try { names = fs.readdirSync(this.packetsDir); } catch { return 0; }
    let removed = 0;
    for (const name of names) {
      if (removed >= limit) break;
      if (!/^pkt-[a-f0-9]{24}\.json$/.test(name)) continue;
      const full = path.join(this.packetsDir, name);
      try {
        if (this.now() - fs.statSync(full).mtimeMs > TRIAGE_PACKET_RETENTION_MS) {
          SafeFsExecutor.safeUnlinkSync(full, { operation: 'feedback-triage packet retention' });
          removed++;
        }
      } catch { /* @silent-fallback-ok: retried next prune */ }
    }
    return removed;
  }
}
