import fs from 'node:fs';
import path from 'node:path';

/**
 * Fallback record for a Telegram acceptance whose receipt the origin store
 * could not save (held-reply outcome lookup, Echo Bugs topic 10000000967).
 *
 * Telegram answered with a message id, so the message WAS delivered; only the
 * store write failed. Without this file that fact lived nowhere, the caller
 * saw "held, outcome unknown", resent, and the user got the message twice.
 *
 * One small append-only JSONL file outside the store worker: a `receipt` row
 * when the acceptance is captured, a `reconciled` row once the store holds it.
 * Plain synchronous fs with fsync, so it works exactly when the worker does not.
 */
export interface UnrecordedReceiptEntry {
  operationId: string;
  originId: string;
  childId: string;
  attemptId: string;
  receiptJson: string;
  messageId: string | null;
  chatId: string | null;
  topicId: string | null;
  at: number;
}

type Row = ({ kind: 'receipt' } & UnrecordedReceiptEntry) | { kind: 'reconciled'; operationId: string; childId: string; at: number };

const MAX_BYTES = 2 * 1024 * 1024;
const RETENTION_MS = 14 * 24 * 60 * 60_000;

export class OriginUnrecordedReceipts {
  readonly file: string;
  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'state', 'telegram-origin-unrecorded-receipts.jsonl');
  }

  /** Durable before return; throws only when the disk itself refuses. */
  append(entry: UnrecordedReceiptEntry): void {
    this.#write({ kind: 'receipt', ...entry });
  }

  markReconciled(operationId: string, childId: string, now = Date.now()): void {
    this.#write({ kind: 'reconciled', operationId, childId, at: now });
  }

  /** Every captured acceptance for one operation (reconciled or not). */
  forOperation(operationId: string): UnrecordedReceiptEntry[] {
    return this.#receipts().filter(row => row.operationId === operationId);
  }

  /** Acceptances the store does not hold yet, oldest first. */
  pending(): UnrecordedReceiptEntry[] {
    const rows = this.#rows();
    const done = new Set(rows.filter(row => row.kind === 'reconciled').map(row => `${row.operationId}:${row.childId}`));
    return this.#receiptsFrom(rows).filter(row => !done.has(`${row.operationId}:${row.childId}`));
  }

  #receipts(): UnrecordedReceiptEntry[] { return this.#receiptsFrom(this.#rows()); }
  #receiptsFrom(rows: Row[]): UnrecordedReceiptEntry[] {
    const out: UnrecordedReceiptEntry[] = [];
    for (const row of rows) if (row.kind === 'receipt') { const { kind: _kind, ...entry } = row; out.push(entry); }
    return out;
  }

  #rows(): Row[] {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const rows: Row[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as Row;
        if ((row.kind === 'receipt' || row.kind === 'reconciled') && typeof row.operationId === 'string' && typeof row.childId === 'string') rows.push(row);
      } catch { /* a torn final line from a crash mid-append is skipped, never fatal */ }
    }
    return rows;
  }

  #write(row: Row): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.#compactIfLarge(row.at);
    // A crash mid-append leaves a line with no newline; start on a fresh line
    // so this row is not glued onto (and lost with) the torn one.
    const fd = fs.openSync(this.file, 'a+', 0o600);
    try {
      const size = fs.fstatSync(fd).size;
      const last = Buffer.alloc(1);
      const torn = size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
      fs.writeSync(fd, (torn ? '\n' : '') + JSON.stringify(row) + '\n'); fs.fsyncSync(fd);
    }
    finally { fs.closeSync(fd); }
  }

  /** Bounded: drop reconciled pairs and anything past retention once the file grows. */
  #compactIfLarge(now: number): void {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < MAX_BYTES) return;
    const rows = this.#rows();
    const done = new Set(rows.filter(row => row.kind === 'reconciled').map(row => `${row.operationId}:${row.childId}`));
    const keep = rows.filter(row => row.kind === 'receipt' && now - row.at < RETENTION_MS && !done.has(`${row.operationId}:${row.childId}`));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, keep.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
