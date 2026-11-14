/**
 * LocalAttentionItems — a small, durable attention list for an agent with no
 * Telegram adapter.
 *
 * The ordinary attention list lives inside TelegramAdapter (its items become
 * Telegram topics). An agent without Telegram therefore had no attention list
 * at all, and a security event that must reach the owner (for example "a Mac
 * may still be unlocked" after a remote-desktop session) was dropped with a
 * console warning. This store holds those items on disk so `GET /attention`,
 * `GET /attention/:id`, `PATCH /attention/:id` and the iPhone app can show
 * them, and a paired phone can be pushed.
 *
 * Deliberately narrow: one row per id (a re-raise refreshes the row and
 * reopens it), bounded size, atomic writes, and `raise()` reports `true` only
 * when the row is on disk, so a caller that retries on `false` keeps retrying.
 */
import fs from 'node:fs';
import path from 'node:path';

export type LocalAttentionPriority = 'URGENT' | 'HIGH' | 'NORMAL' | 'LOW';
export type LocalAttentionStatus = 'OPEN' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'DONE' | 'WONT_DO';

export interface LocalAttentionItem {
  id: string;
  title: string;
  summary: string;
  description?: string;
  category: string;
  priority: LocalAttentionPriority;
  status: LocalAttentionStatus;
  sourceContext?: string;
  source?: string;
  createdAt: string;
  updatedAt: string;
  resolution?: string;
  /** How many times this condition was raised. */
  raisedCount: number;
  /** Always 'local': the item has no Telegram topic. */
  surface: 'local';
}

export interface LocalAttentionRaise {
  id: string;
  title: string;
  summary: string;
  description?: string;
  category?: string;
  priority?: LocalAttentionPriority;
  sourceContext?: string;
  source?: string;
}

/** Oldest closed rows are dropped first; open rows are never dropped. */
export const LOCAL_ATTENTION_MAX_ITEMS = 200;

export class LocalAttentionItems {
  private readonly file: string;
  private readonly now: () => Date;

  constructor(stateDir: string, now: () => Date = () => new Date()) {
    this.file = path.join(stateDir, 'state', 'local-attention-items.json');
    this.now = now;
  }

  get filePath(): string { return this.file; }

  private load(): LocalAttentionItem[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as unknown;
      return Array.isArray(raw) ? raw.filter((r): r is LocalAttentionItem =>
        !!r && typeof r === 'object' && typeof (r as LocalAttentionItem).id === 'string') : [];
    } catch {
      // @silent-fallback-ok — a missing file is the empty list; a corrupt one is replaced on the next raise
      return [];
    }
  }

  private save(items: LocalAttentionItem[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Newest first, optionally filtered by status. */
  list(status?: string): LocalAttentionItem[] {
    const items = this.load();
    const filtered = status ? items.filter(i => i.status === status) : items;
    return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): LocalAttentionItem | undefined {
    return this.load().find(i => i.id === id);
  }

  /** Create or refresh one row. Returns false when the row could not be written. */
  raise(input: LocalAttentionRaise): boolean {
    try {
      const items = this.load();
      const at = this.now().toISOString();
      const existing = items.find(i => i.id === input.id);
      if (existing) {
        existing.title = input.title;
        existing.summary = input.summary;
        existing.description = input.description;
        existing.priority = input.priority ?? existing.priority;
        existing.status = 'OPEN';
        delete existing.resolution;
        existing.updatedAt = at;
        existing.raisedCount = (existing.raisedCount ?? 1) + 1;
      } else {
        items.push({
          id: input.id, title: input.title, summary: input.summary, description: input.description,
          category: input.category ?? 'general', priority: input.priority ?? 'NORMAL', status: 'OPEN',
          sourceContext: input.sourceContext, source: input.source,
          createdAt: at, updatedAt: at, raisedCount: 1, surface: 'local',
        });
      }
      this.save(this.bounded(items));
      return true;
    } catch {
      // @silent-fallback-ok — reported as false so the caller retries; the caller owns the warning
      return false;
    }
  }

  /** Change one row's status. Returns the updated row, or undefined when unknown. */
  setStatus(id: string, status: LocalAttentionStatus, resolution?: string): LocalAttentionItem | undefined {
    const items = this.load();
    const item = items.find(i => i.id === id);
    if (!item) return undefined;
    item.status = status;
    if (resolution !== undefined) item.resolution = resolution;
    item.updatedAt = this.now().toISOString();
    this.save(items);
    return item;
  }

  private bounded(items: LocalAttentionItem[]): LocalAttentionItem[] {
    if (items.length <= LOCAL_ATTENTION_MAX_ITEMS) return items;
    const open = items.filter(i => i.status === 'OPEN' || i.status === 'ACKNOWLEDGED' || i.status === 'IN_PROGRESS');
    const closed = items.filter(i => !open.includes(i)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return [...open, ...closed.slice(0, Math.max(0, LOCAL_ATTENTION_MAX_ITEMS - open.length))];
  }
}
