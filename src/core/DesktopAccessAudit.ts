/** Screen and keystroke free local audit for operator desktop sessions. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export interface DesktopAuditEvent {
  kind: 'start' | 'stop';
  grantId: string;
  machineId: string;
  operatorUid: string;
  inputBucket?: 'none' | '1-9' | '10-99' | '100+';
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
      ...(event.inputBucket ? { inputBucket: event.inputBucket } : {}),
    };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
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
