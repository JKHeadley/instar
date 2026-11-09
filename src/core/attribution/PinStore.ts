/**
 * Pins: a copy of a row taken on its first verified resolve, so a good citation stays checkable
 * after the log rotates that row out. Spec section 2. Separate from the ledger so ledger rotation
 * cannot carry them forward. Nothing is evicted from the file: the in-memory map holds the newest
 * 20k, and older pins are read from the file on a miss.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MessageAuthorship } from '../AspAuthorshipJoin.js';
import { SafeFsExecutor } from '../SafeFsExecutor.js';
import type { SourceRef } from './marker.js';

export interface PinRow {
  key: string;
  ref: SourceRef;
  row: Record<string, unknown>;
  authorship?: MessageAuthorship;
  pinnedAt: string;
}

/**
 * What a pin keeps: the words, and the fields eligibility reads. An allow-list, so a store that adds a
 * field holding message text (a signed body, say) cannot put it in this file unscrubbed.
 */
const PINNED_FIELDS = [
  'messageId', 'topicId', 'channelId', 'text', 'fromUser', 'timestamp', 'telegramUserId', 'platformUserId', 'forwarded',
  'provenance', 'via', 'role', 'senderRole', 'senderPerson', 'direction', 'peerFingerprint', 'seq', 'threadId', 'eventId', 'at',
];

function pinnedCopy(row: Record<string, unknown>, scrub: (text: string) => string): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const field of PINNED_FIELDS) if (row[field] !== undefined) copy[field] = row[field];
  if (typeof copy.text === 'string') copy.text = scrub(copy.text);
  // Eligibility asks only whether an app message was device-signed, never what was signed.
  if (row.origin !== undefined) copy.origin = { present: true };
  return copy;
}

function pinKey(ref: SourceRef): string {
  return `${ref.channel}|${ref.conversation}|${ref.message}`;
}

export class PinStore {
  private readonly file: string;
  private readonly memory = new Map<string, PinRow>();
  private loaded = false;
  private fileRows = 0;

  constructor(private readonly options: { stateDir: string; scrub?: (text: string) => string; maxInMemory?: number; now?: () => Date }) {
    this.file = path.join(options.stateDir, 'attribution', 'pins.jsonl');
  }

  has(ref: SourceRef): boolean {
    return this.read(ref) !== null;
  }

  get size(): number {
    this.load();
    return this.fileRows;
  }

  read(ref: SourceRef): Record<string, unknown> | null {
    return this.readPin(ref)?.row ?? null;
  }

  readPin(ref: SourceRef): PinRow | null {
    this.load();
    const key = pinKey(ref);
    const held = this.memory.get(key);
    if (held) return held;
    if (this.fileRows <= this.maxInMemory) return null;
    return this.parseFile().find((pin) => pin.key === key) ?? null;
  }

  /** Copies the row once. The text is scrubbed before it is written. */
  pin(ref: SourceRef, row: Record<string, unknown>, authorship: MessageAuthorship | undefined): void {
    if (this.has(ref)) return;
    const scrub = this.options.scrub ?? ((text: string) => text);
    const clean = pinnedCopy(row, scrub);
    const stored: PinRow = {
      key: pinKey(ref),
      ref,
      row: clean,
      ...(authorship ? { authorship } : {}),
      pinnedAt: (this.options.now?.() ?? new Date()).toISOString(),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.file, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    this.fileRows += 1;
    this.remember(stored);
  }

  /** The person deleted the message: the copy goes too. */
  drop(ref: SourceRef): void {
    this.load();
    const key = pinKey(ref);
    const rows = this.parseFile();
    const kept = rows.filter((pin) => pin.key !== key);
    this.memory.delete(key);
    if (kept.length === rows.length) return;
    SafeFsExecutor.atomicWriteFileSync(this.file, kept.map((pin) => JSON.stringify(pin)).join('\n') + (kept.length ? '\n' : ''), { mode: 0o600, operation: 'attribution-pin-drop' });
    this.fileRows = kept.length;
  }

  private get maxInMemory(): number {
    return this.options.maxInMemory ?? 20_000;
  }

  private remember(pin: PinRow): void {
    this.memory.delete(pin.key);
    this.memory.set(pin.key, pin);
    if (this.memory.size > this.maxInMemory) {
      const oldest = this.memory.keys().next().value;
      if (oldest !== undefined) this.memory.delete(oldest);
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const rows = this.parseFile();
    this.fileRows = rows.length;
    for (const pin of rows) this.remember(pin);
  }

  private parseFile(): PinRow[] {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return [];
    }
    const rows: PinRow[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as PinRow);
      } catch {
        // A torn last line from a crash loses that one pin, never the file.
      }
    }
    return rows;
  }
}
