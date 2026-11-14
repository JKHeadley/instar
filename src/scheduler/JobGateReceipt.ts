/** Optional gate→session handoff. Queuing and failed spawns retain reservations. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export interface JobGateReceipt { batchId: string; admitted: unknown[]; consumed?: boolean; at?: string; }
export function jobGateReceiptPath(stateDir: string, slug: string): string {
  return path.join(stateDir, 'state', 'job-gate-receipts', createHash('sha256').update(slug).digest('hex') + '.json');
}
export function readJobGateReceipt(file: string): JobGateReceipt | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const bytes = Buffer.alloc(16385);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 16384) return null;
    const value = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (!value || typeof value.batchId !== 'string' || value.batchId.length > 100 || !Array.isArray(value.admitted) || value.admitted.length > 3) return null;
    return value;
  } catch { return null; /* @silent-fallback-ok — existing gates do not produce receipts */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export function consumeJobGateReceipt(file: string, batchId: string): void {
  const current = readJobGateReceipt(file);
  if (!current || current.batchId !== batchId || current.consumed) throw new Error('gate receipt is missing, changed or already consumed');
  fs.writeFileSync(file + '.tmp', JSON.stringify({ ...current, consumed: true }) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

/** Refund only a failed pre-session launch of this exact batch. */
export function restoreJobGateReceipt(file: string, batchId: string): void {
  const current = readJobGateReceipt(file);
  if (!current || current.batchId !== batchId || !current.consumed) return;
  fs.writeFileSync(file + '.tmp', JSON.stringify({ ...current, consumed: false }) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
