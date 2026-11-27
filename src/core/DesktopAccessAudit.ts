/** Screen and keystroke free local audit for operator desktop sessions. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface DesktopAuditEvent {
  kind: 'start' | 'stop' | 'leave-unlocked' | 'secret-refused' | 'display-wake';
  grantId: string;
  machineId: string;
  operatorUid: string;
  authMethod?: 'pin' | 'telegram';
  inputBucket?: 'none' | '1-9' | '10-99' | '100+';
  /** leave-unlocked only: true when the tap beat the relock guard. */
  acknowledged?: boolean;
  /** secret-refused: the refusal word (never the password or its length).
   * display-wake: woke-ready, woke-not-ready, console-locked or unknown. */
  reason?: string;
}

/** A refusal word as the helper and the target name them; anything else is recorded as "other". */
export function auditReason(reason: string): string {
  return /^[a-z][a-z0-9-]{0,47}$/.test(reason) ? reason : 'other';
}

export class DesktopAccessAudit {
  private readonly dir: string;
  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'logs');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.prune();
  }

  record(event: DesktopAuditEvent): void {
    const at = new Date().toISOString();
    const file = path.join(this.dir, `desktop-access-${at.slice(0, 10)}.jsonl`);
    const entry = {
      at, kind: event.kind, machineId: event.machineId,
      grantRef: crypto.createHash('sha256').update(event.grantId).digest('hex').slice(0, 16),
      operatorRef: crypto.createHash('sha256').update(event.operatorUid).digest('hex').slice(0, 16),
      ...(event.authMethod ? { authMethod: event.authMethod } : {}),
      ...(event.inputBucket ? { inputBucket: event.inputBucket } : {}),
      ...(event.acknowledged !== undefined ? { acknowledged: event.acknowledged } : {}),
      ...(event.reason !== undefined ? { reason: auditReason(event.reason) } : {}),
    };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  /**
   * True when a desktop session started on this agent within `windowMs`. Reads
   * only the dated files that can hold such an entry; an unreadable file counts
   * as no evidence. Used to decide whether a desktop problem is worth the
   * operator's attention at all.
   */
  hasStartWithin(windowMs: number, now: number = Date.now()): boolean {
    const since = now - windowMs;
    const sinceDay = new Date(since).toISOString().slice(0, 10);
    let names: string[];
    try { names = fs.readdirSync(this.dir); } catch { return false; } // @silent-fallback-ok — no log dir means no recorded use.
    for (const name of names) {
      const date = /^desktop-access-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
      if (!date || date < sinceDay) continue;
      let text: string;
      try { text = fs.readFileSync(path.join(this.dir, name), 'utf8'); } catch { continue; } // @silent-fallback-ok — an unreadable day is no evidence of use.
      for (const line of text.split('\n')) {
        if (!line.includes('"start"')) continue;
        try {
          const entry = JSON.parse(line) as { kind?: string; at?: string };
          if (entry.kind === 'start' && entry.at && Date.parse(entry.at) >= since) return true;
        } catch { /* @silent-fallback-ok — a torn line is skipped */ }
      }
    }
    return false;
  }

  private prune(): void {
    const cutoff = Date.now() - 30 * 24 * 60 * 60_000;
    for (const name of fs.readdirSync(this.dir)) {
      const date = /^desktop-access-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
      if (date && Date.parse(`${date}T00:00:00Z`) < cutoff) {
        SafeFsExecutor.safeUnlinkSync(path.join(this.dir, name), { operation: 'desktop-access audit retention' });
      }
    }
  }
}
