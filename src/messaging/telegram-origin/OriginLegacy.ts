import type { PendingRelayRow } from '../pending-relay-store.js';
import { originDigest } from './CanonicalOrigin.js';

export interface OriginLegacySnapshot {
  deliveryId: string; topicId: number; text: string; format: string | null;
  preparedAt: number; attempts: number; nextAttemptAt: string | null;
  state: string; snapshotDigest: string; replaySafe: boolean;
}
/** Old queue rows do not prove their author or transport phase. Only a complete
 * history of explicit pre-dispatch HTTP refusals permits automatic recovery. */
export function snapshotLegacyOrigin(row: PendingRelayRow): OriginLegacySnapshot {
  const rawText = Buffer.from(row.text), text = rawText.toString('utf8');
  let history: Array<{ at?: unknown; http_code?: unknown; state?: unknown }> = [];
  try { const value = JSON.parse(row.status_history); if (Array.isArray(value)) history = value; } catch { /* Missing evidence remains uncertain. */ }
  const times = [Date.parse(row.attempted_at), ...history.map(item => typeof item?.at === 'string' ? Date.parse(item.at) : NaN)];
  const preparedAt = Number.isFinite(times[0]) && times[0] >= 0 ? Math.min(...times.filter(value => Number.isFinite(value) && value >= 0)) : 0;
  const attempts = Number.isSafeInteger(row.attempts) && row.attempts >= 0 ? row.attempts : 9;
  // Authentication/path refusals precede the reply handler. 409/200, 5xx,
  // HTTP 0 and claimed-only history cannot establish definite non-delivery.
  const refused = (code: unknown) => code === 401 || code === 404;
  const replaySafe = row.state === 'queued' && row.claimed_by === null && !row.truncated &&
    rawText.equals(Buffer.from(text)) && text.length > 0 && preparedAt > 0 &&
    (attempts === 0 || (refused(row.http_code) && history.length === attempts && history.every(item => item && refused(item.http_code))));
  return { deliveryId: row.delivery_id, topicId: row.topic_id, text, format: row.format,
    preparedAt, attempts, nextAttemptAt: row.next_attempt_at, state: row.state,
    snapshotDigest: originDigest({ ...row, text: rawText.toString('base64') }), replaySafe };
}
