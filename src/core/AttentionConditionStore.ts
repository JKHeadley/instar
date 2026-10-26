/**
 * Durable lifecycle identity for level-triggered Attention conditions.
 *
 * Producers describe semantic identity; this store owns episode numbering.
 * Re-observing an active condition (including after a process restart) reuses
 * the current item id. Only an explicit positive-evidence clear permits a later
 * observation to mint a new episode id.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface AttentionConditionIdentity {
  producer: string;
  conditionType: string;
  subject: string;
  scope?: string;
}

export interface AttentionConditionObservation {
  itemId: string;
  episode: number;
  shouldRaise: boolean;
}

interface AttentionConditionRecord {
  key: string;
  producer: string;
  conditionType: string;
  subject: string;
  scope: string;
  active: boolean;
  episode: number;
  itemId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  clearedAt?: string;
}

interface AttentionConditionFile {
  version: 1;
  conditions: Record<string, AttentionConditionRecord>;
}

export interface AttentionConditionStoreDeps {
  filePath: string;
  now?: () => number;
  logger?: (message: string) => void;
  maxRecords?: number;
  /**
   * Fired when a condition clears (`clear` / `clearSubject`). `baseKey` is the
   * record key WITHOUT the `:ep-N` suffix, so the consumer can close every
   * episode's attention item with the delimiter-bounded prefix `${baseKey}:ep-`.
   * Clearing a condition used to only flip the record inactive — the item it
   * minted stayed OPEN forever (attention-lifecycle-close-on-cause §3.2).
   */
  onClear?: (baseKey: string, itemId: string) => void;
}

const MAX_RECORDS = 2_000;

function segment(value: string): string {
  return encodeURIComponent(value.trim() || 'unknown');
}

export function attentionConditionKey(identity: AttentionConditionIdentity): string {
  return [
    segment(identity.producer),
    segment(identity.conditionType),
    segment(identity.subject),
    segment(identity.scope ?? 'global'),
  ].join(':');
}

/** `producer:type:subject:scope:ep-N` (or `:capacity`) → `producer:type:subject:scope`. */
export function baseKeyOfItemId(itemId: string): string {
  return itemId.replace(/:(?:ep-\d+|capacity)$/, '');
}

export class AttentionConditionStore {
  private readonly d: AttentionConditionStoreDeps;
  private readonly conditions = new Map<string, AttentionConditionRecord>();

  constructor(deps: AttentionConditionStoreDeps) {
    this.d = deps;
    this.load();
  }

  observe(identity: AttentionConditionIdentity): AttentionConditionObservation {
    const key = attentionConditionKey(identity);
    const now = new Date((this.d.now ?? Date.now)()).toISOString();
    const current = this.conditions.get(key);
    if (current?.active) {
      current.lastSeenAt = now;
      this.persist();
      return { itemId: current.itemId, episode: current.episode, shouldRaise: false };
    }

    if (!current && !this.makeRoomForNewRecord()) {
      // Capacity degradation stays restart-idempotent: exact-id Attention
      // dedupe still prevents a flood, while the loud log makes lost recurrence
      // counting visible. Never evict an ACTIVE condition to admit a new one.
      const itemId = `${key}:capacity`;
      this.d.logger?.(`[AttentionConditionStore] capacity reached; using stable degraded id ${itemId}`);
      return { itemId, episode: 1, shouldRaise: true };
    }

    const episode = (current?.episode ?? 0) + 1;
    const itemId = `${key}:ep-${episode}`;
    const next: AttentionConditionRecord = {
      key,
      producer: identity.producer,
      conditionType: identity.conditionType,
      subject: identity.subject,
      scope: identity.scope ?? 'global',
      active: true,
      episode,
      itemId,
      firstSeenAt: current?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
    this.conditions.set(key, next);
    this.persist();
    return { itemId, episode, shouldRaise: true };
  }

  clear(identity: AttentionConditionIdentity): boolean {
    const key = attentionConditionKey(identity);
    const current = this.conditions.get(key);
    if (!current?.active) return false;
    current.active = false;
    current.clearedAt = new Date((this.d.now ?? Date.now)()).toISOString();
    this.persist();
    this.fireClear(current);
    return true;
  }

  clearSubject(producer: string, subject: string): number {
    const now = new Date((this.d.now ?? Date.now)()).toISOString();
    let cleared = 0;
    const fired: AttentionConditionRecord[] = [];
    for (const record of this.conditions.values()) {
      if (record.producer !== producer || record.subject !== subject || !record.active) continue;
      record.active = false;
      record.clearedAt = now;
      cleared++;
      fired.push(record);
    }
    if (cleared > 0) this.persist();
    for (const record of fired) this.fireClear(record);
    return cleared;
  }

  /** Is the condition that minted `itemId` (an `…:ep-N` id) still active? Unknown ids → false. */
  isItemActive(itemId: string): boolean {
    const record = this.conditions.get(baseKeyOfItemId(itemId));
    return record?.active === true && record.itemId === itemId;
  }

  /**
   * Base keys (`producer:type:subject:scope`) of every INACTIVE record — the
   * reconciliation pass closes any attention item still open under
   * `${baseKey}:ep-` for them (a crash between the record write and the item
   * close, or a clear from before `onClear` existed, leaves such rows behind).
   */
  inactiveBaseKeys(): string[] {
    return [...this.conditions.values()].filter((r) => !r.active).map((r) => r.key);
  }

  private fireClear(record: AttentionConditionRecord): void {
    try {
      this.d.onClear?.(record.key, record.itemId);
    } catch (err) {
      this.d.logger?.(`[AttentionConditionStore] onClear failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.d.filePath, 'utf8')) as Partial<AttentionConditionFile>;
      if (raw.version !== 1 || !raw.conditions || typeof raw.conditions !== 'object') return;
      for (const [key, value] of Object.entries(raw.conditions)) {
        if (!value || typeof value !== 'object') continue;
        const record = value as AttentionConditionRecord;
        if (
          record.key !== key || typeof record.producer !== 'string' ||
          typeof record.conditionType !== 'string' || typeof record.subject !== 'string' ||
          typeof record.scope !== 'string' || typeof record.active !== 'boolean' ||
          !Number.isSafeInteger(record.episode) || record.episode < 1 ||
          typeof record.itemId !== 'string' || typeof record.firstSeenAt !== 'string' ||
          typeof record.lastSeenAt !== 'string'
        ) continue;
        this.conditions.set(key, record);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.d.logger?.(`[AttentionConditionStore] unreadable state ignored: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private makeRoomForNewRecord(): boolean {
    const limit = Math.max(1, Math.floor(this.d.maxRecords ?? MAX_RECORDS));
    if (this.conditions.size < limit) return true;
    const inactive = [...this.conditions.values()]
      .filter((record) => !record.active)
      .sort((a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt));
    for (const record of inactive) {
      if (this.conditions.size < limit) break;
      this.conditions.delete(record.key);
    }
    return this.conditions.size < limit;
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.d.filePath), { recursive: true });
      const file: AttentionConditionFile = {
        version: 1,
        conditions: Object.fromEntries(this.conditions),
      };
      const tmp = `${this.d.filePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.d.filePath);
    } catch (err) {
      this.d.logger?.(`[AttentionConditionStore] state write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
