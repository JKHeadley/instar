import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

export interface QuietNotification {
  id: string; machineId: string; category: string; sourceContext: string; topicId?: number;
  topicIds?: number[]; text: string; count: number; createdAt: string; updatedAt: string; read: boolean;
  coalescedApprox?: boolean;
}
/** Single server writer; bounded index, append-only acknowledgements, bounded coalescing keys. */
export class QuietNotificationStore {
  private rows = new Map<string, QuietNotification>();
  private windows = new Map<string, { id: string; until: number; dirty: boolean }>();
  private mutations: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private bytes = 0;
  private timer: ReturnType<typeof setInterval>;
  readonly ready: Promise<void>;
  readonly file: string;
  health = { healthy: true, lost: 0, tornLines: 0, pruned: 0, fallback: 0, error: '' };
  constructor(private root: string, public machineId: string, private now = Date.now,
    private limits = { retentionDays: 30, maxEntries: 20000 }) {
    this.file = path.join(root, 'state', 'quiet-notifications.jsonl');
    this.ready = this.load();
    this.timer = setInterval(() => { void this.serialize(() => this.flushSerial(false)).catch(error => this.fail(error)); }, 60000);
    this.timer.unref();
  }
  private fail(error: unknown): void { this.health.healthy = false; this.health.error = error instanceof Error ? error.message : String(error); }
  private async load(): Promise<void> {
    try {
      const stat = await fs.promises.stat(this.file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) return;
      this.bytes = stat.size;
      if (stat.size) { const file = await fs.promises.open(this.file, 'r'); try { const tail = Buffer.alloc(1); await file.read(tail, 0, 1, stat.size - 1); if (tail[0] !== 10) { await fs.promises.appendFile(this.file, '\n'); this.bytes++; } } finally { await file.close(); } }
      for await (const line of createInterface({ input: fs.createReadStream(this.file), crlfDelay: Infinity })) {
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'ack') { const row = this.rows.get(event.id); if (row) row.read = true; }
          else if (event.row && typeof event.row.id === 'string' && typeof event.row.text === 'string' && typeof event.row.category === 'string' && typeof event.row.sourceContext === 'string' && typeof event.row.machineId === 'string' && typeof event.row.read === 'boolean' && Number.isSafeInteger(event.row.count) && event.row.count > 0 && typeof event.row.createdAt === 'string' && typeof event.row.updatedAt === 'string' && Number.isFinite(Date.parse(event.row.createdAt)) && Number.isFinite(Date.parse(event.row.updatedAt)) && (event.row.topicIds === undefined || Array.isArray(event.row.topicIds) && event.row.topicIds.length <= 1000 && event.row.topicIds.every((id: unknown) => Number.isSafeInteger(id)))) this.rows.set(event.row.id, event.row);
          else this.health.tornLines++;
        } catch { this.health.tornLines++; }
        if (this.rows.size > this.limits.maxEntries) this.rows.delete(this.rows.keys().next().value!);
      }
      this.prune();
    } catch (error) { this.fail(error); }
  }
  private prune(): void {
    const cutoff = this.now() - this.limits.retentionDays * 86400000;
    for (const [id, row] of this.rows) if (Date.parse(row.updatedAt) < cutoff) { this.rows.delete(id); this.health.pruned++; }
    while (this.rows.size > this.limits.maxEntries) { this.rows.delete(this.rows.keys().next().value!); this.health.pruned++; }
  }
  private append(event: unknown): Promise<void> {
    const encoded = JSON.stringify(event) + '\n';
    const operation = this.writes.then(async () => {
      const line = encoded.slice(0, -1) + '\n';
      await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
      if (this.bytes > 8 * 1024 * 1024) {
        this.prune();
        const snapshot = [...this.rows.values()].map(row => JSON.stringify({ type: 'put', row })).join('\n') + '\n';
        await fs.promises.writeFile(this.file + '.next', snapshot);
        await fs.promises.rename(this.file + '.next', this.file);
        this.bytes = 0; // Appended-byte budget; a large retained snapshot must not trigger per-row compaction.
      }
      await fs.promises.appendFile(this.file, line);
      this.bytes += Buffer.byteLength(line);
      this.health.healthy = true; this.health.error = '';
    });
    this.writes = operation.catch(error => this.fail(error));
    return operation;
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.mutations.then(fn); this.mutations = operation.catch(error => this.fail(error)); return operation;
  }
  record(input: Pick<QuietNotification, 'category' | 'sourceContext' | 'text' | 'topicId'>): Promise<QuietNotification> {
    return this.serialize(() => this.recordSerial(input));
  }
  private async recordSerial(input: Pick<QuietNotification, 'category' | 'sourceContext' | 'text' | 'topicId'>): Promise<QuietNotification> {
    await this.ready;
    const now = this.now();
    for (const [key, value] of this.windows) if (value.until <= now) {
      if (value.dirty) { const row = this.rows.get(value.id); if (row) await this.append({ type: 'put', row }); }
      this.windows.delete(key);
    }
    const prefix = input.category + ':';
    const source = input.sourceContext.slice(0, 160);
    const categoryKeys = [...this.windows.keys()].filter(key => key.startsWith(prefix));
    let key = prefix + source + ':' + (input.topicId ?? 'unbound');
    if (!this.windows.has(key) && categoryKeys.length >= 100) key = prefix + '*';
    const window = this.windows.get(key);
    const row = window && this.rows.get(window.id);
    if (row) { if (input.topicId !== undefined && !row.topicIds?.includes(input.topicId)) row.topicIds = [...(row.topicIds ?? [row.topicId!]), input.topicId].slice(-1000); row.count++; row.updatedAt = new Date(now).toISOString(); row.read = false; window!.dirty = true; return { ...row }; }
    const created: QuietNotification = { ...input, ...(input.topicId === undefined ? {} : { topicIds: [input.topicId] }), sourceContext: source, text: input.text.slice(0, 16000),
      id: randomUUID(), machineId: this.machineId, count: 1, read: false,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), coalescedApprox: true };
    await this.append({ type: 'put', row: created });
    this.rows.set(created.id, created); this.windows.set(key, { id: created.id, until: now + 60000, dirty: false });
    this.prune();
    return { ...created };
  }
  list(options: { category?: string; unread?: boolean; topicId?: number; limit?: number; before?: string } = {}): QuietNotification[] {
    this.prune();
    return [...this.rows.values()].filter(row => (!options.category || row.category === options.category)
      && (!options.unread || !row.read) && (options.topicId === undefined || (row.topicId === options.topicId || row.topicIds?.includes(options.topicId)))
      && (!options.before || row.createdAt < options.before.split('|')[0] || (row.createdAt === options.before.split('|')[0] && row.id < (options.before.split('|')[1] ?? ''))))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, Math.min(200, Math.max(1, options.limit ?? 50))).map(row => ({ ...row }));
  }
  ack(id: string): Promise<boolean> { return this.serialize(() => this.ackSerial(id)); }
  private async ackSerial(id: string): Promise<boolean> {
    await this.ready; const row = this.rows.get(id); if (!row) return false;
    await this.append({ type: 'ack', id, at: new Date(this.now()).toISOString() }); row.read = true; return true;
  }
  summarySince(since: number): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.rows.values()) if (Date.parse(row.createdAt) >= since) counts[row.category] = (counts[row.category] ?? 0) + row.count;
    return counts;
  }
  counters(): { unread: number; unreadAging: number; total: number } {
    const rows = [...this.rows.values()];
    return { total: rows.length, unread: rows.filter(row => !row.read).length,
      unreadAging: rows.filter(row => !row.read && this.now() - Date.parse(row.createdAt) > 72 * 3600000).length };
  }
  flush(): Promise<void> { return this.serialize(() => this.flushSerial()); }
  private async flushSerial(force = true): Promise<void> {
    await this.ready;
    for (const value of this.windows.values()) if (value.dirty && (force || value.until <= this.now())) {
      const row = this.rows.get(value.id); if (row) await this.append({ type: 'put', row }); value.dirty = false;
    }
    await this.writes;
  }
  async close(): Promise<void> { clearInterval(this.timer); await this.flush(); }
}

export type QuietNotificationSink = Pick<QuietNotificationStore, 'record' | 'list' | 'ack' | 'summarySince' | 'counters' | 'flush' | 'close' | 'ready' | 'health' | 'file' | 'machineId'>;
