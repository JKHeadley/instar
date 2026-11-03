import type { PendingRelayRow } from '../pending-relay-store.js';
import { originDigest } from './CanonicalOrigin.js';
import type { OriginEvidence, TelegramOriginRecord } from './types.js';

/** What the importing machine can truthfully claim about a queued row's author. */
export interface OriginLegacyAttribution {
  machine: OriginEvidence;
  session: { sessionId: string; sessionIncarnation: string; turnId: string | null; harnessId: string; harnessName: string;
    harness: OriginEvidence; model: OriginEvidence } | null;
}

export interface OriginLegacySnapshot {
  deliveryId: string; topicId: number; text: string; format: string | null;
  preparedAt: number; attempts: number; nextAttemptAt: string | null;
  state: string; snapshotDigest: string; replaySafe: boolean;
  /** SHA-256 hex of the queuing session's origin credential, when the reply
   * script recorded one. Attribution input only; never authority. */
  originSessionDigest: string | null;
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
  // HTTP 0 and claimed-only history cannot establish definite non-delivery,
  // with two exceptions whose exact bodies prove nothing was sent: the boot
  // beacon's 503 (it answers before the real server listens, so no reply
  // handler ran) and a refusal raised while the send was still being prepared
  // (before admission, before any network call). The row keeps only the
  // latest body, so only the latest attempt can carry that proof.
  const refused = (code: unknown) => code === 401 || code === 404;
  const preDispatchRefused = (row.http_code === 503 && isBootBeaconBody(row.error_body))
    || isPreDispatchRefusal(row.http_code, row.error_body);
  const refusedAt = (item: { http_code?: unknown } | null | undefined, index: number) =>
    !!item && (refused(item.http_code) || (preDispatchRefused && index === history.length - 1 && item.http_code === row.http_code));
  const replaySafe = row.state === 'queued' && row.claimed_by === null && !row.truncated &&
    rawText.equals(Buffer.from(text)) && text.length > 0 && preparedAt > 0 &&
    (attempts === 0 || ((refused(row.http_code) || preDispatchRefused) && history.length === attempts && history.every(refusedAt)));
  return { deliveryId: row.delivery_id, topicId: row.topic_id, text, format: row.format,
    preparedAt, attempts, nextAttemptAt: row.next_attempt_at, state: row.state,
    snapshotDigest: originDigest({ ...row, text: rawText.toString('base64') }), replaySafe,
    originSessionDigest: typeof row.origin_session_digest === 'string' && /^[a-f0-9]{64}$/.test(row.origin_session_digest)
      ? row.origin_session_digest : null };
}

/** The exact body BootHealthBeacon sends for every non-health request. */
export function isBootBeaconBody(body: unknown): boolean {
  if (typeof body !== 'string' || body.length > 200) return false;
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 2
      && value.status === 'warming' && value.phase === 'booting';
  } catch { return false; }
}

/** The reply route's exact body for a send it refused while preparing it:
 * 500 `issues-chat-not-configured: …` (config read, no issues group), 500
 * `origin-display-authority-unavailable` (the bare body earlier releases gave
 * when config could not be read; thrown only by display resolution) or 503
 * `origin-config-unavailable` (config could not be read). Both come from
 * destination/display resolution, which runs before a send is admitted or
 * dispatched. A body relayed from another machine, or with extra keys, does not qualify. */
export function isPreDispatchRefusal(code: unknown, body: unknown): boolean {
  if ((code !== 500 && code !== 503) || typeof body !== 'string' || body.length > 1024) return false;
  let value: Record<string, unknown>;
  try { value = JSON.parse(body) as Record<string, unknown>; } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.error !== 'string') return false;
  const keys = Object.keys(value).sort().join(',');
  if (code === 500) return keys === 'error' && (value.error === 'origin-display-authority-unavailable'
    || /^issues-chat-not-configured: topic \d+ belongs to the issues group/.test(value.error));
  return keys === 'error,message,reason,retryable' && value.error === 'origin-config-unavailable' && value.retryable === true;
}

/** What an imported legacy record may claim about its author. The importer
 * holds the queue row in its own local custody, so it may state its own
 * machine. Harness and model are claimed only together with the session they
 * were observed from (a queued credential digest that matched a live session);
 * without a session they stay unknown. Shared by the attestation verifier and
 * the store's import fence so the two can never disagree. */
export function legacyAttributionValid(record: Pick<TelegramOriginRecord, 'sessionId' | 'machine' | 'harness' | 'model'>): boolean {
  const ok = (status: string) => status === 'unknown' || status === 'observed' || status === 'configured';
  if (record.machine.status !== 'unknown' && record.machine.status !== 'observed') return false;
  if (!ok(record.harness.status) || !ok(record.model.status)) return false;
  if (record.sessionId === null && (record.harness.status !== 'unknown' || record.model.status !== 'unknown')) return false;
  return true;
}
