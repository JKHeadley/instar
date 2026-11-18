import { createHash } from 'node:crypto';

interface Position { at: string; ref: string; messageId: string }
export interface DateCursor { at: string; key: string }

const identities = new WeakMap<Position, string>();
function identity(hit: Position): string {
  const cached = identities.get(hit);
  if (cached) return cached;
  const key = 'h' + createHash('sha256').update(JSON.stringify([hit.ref, hit.messageId])).digest('hex');
  identities.set(hit, key);
  return key;
}

export function setTelegramDateKey(hit: Position, rowId: number): void {
  identities.set(hit, 't' + rowId.toString(16).padStart(16, '0'));
}

const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Newest first; the digest breaks ties across platforms without placing a private reference in the cursor. */
export function newestFirst(a: Position, b: Position): number {
  return compare(b.at, a.at) || compare(identity(a), identity(b));
}

export function afterDateCursor(hit: Position, cursor: DateCursor): boolean {
  return hit.at < cursor.at || (hit.at === cursor.at && identity(hit) > cursor.key);
}

export function dateCursor(hit: Position): string {
  return Buffer.from(JSON.stringify([hit.at, identity(hit)])).toString('base64url');
}

export function parseDateCursor(raw: unknown): DateCursor | null {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(raw)) return null;
  try {
    const pair: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [at, key] = pair;
    if (typeof at !== 'string' || (at !== '' && (!Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at))) return null;
    return typeof key === 'string' && /^(?:h[0-9a-f]{64}|t[0-9a-f]{16})$/.test(key) ? { at, key } : null;
  } catch {
    return null;
  }
}
