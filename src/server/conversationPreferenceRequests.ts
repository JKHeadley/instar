import { validatePreferenceEvent, type ConversationPreferencesStore, type PreferenceEvent } from '../core/ConversationPreferences.js';
import type { ChatRecord, MobileChatRequestStore } from '../core/MobileChatRequests.js';
export interface PreferenceReceipt { requestId: string; ref: string; events: Array<Pick<PreferenceEvent, 'field' | 'eventId' | 'value' | 'atMs'>> }
export function preferenceReceipt(requestId: string, ref: string, events: readonly PreferenceEvent[]): PreferenceReceipt {
  return { requestId, ref, events: events.map(({ field, eventId, value, atMs }) => ({ field, eventId, value, atMs })) };
}
export function reservedPreferenceEvents(record: ChatRecord): PreferenceEvent[] | null {
  const x = record.extra;
  if (x?.op !== 'preferences' || !x.reader || !x.ref) return null;
  try {
    const rows: unknown = JSON.parse(x.events);
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 2) return null;
    const valid = rows.map(validatePreferenceEvent);
    if (valid.some((row) => !row || row.reader !== x.reader || row.ref !== x.ref)) return null;
    const events = valid as PreferenceEvent[];
    return new Set(events.map((row) => row.field)).size === events.length ? events : null;
  } catch { return null; /* @silent-fallback-ok: invalid reserved evidence is rejected, never reconstructed or acknowledged. */ }
}
/** Recovery uses only the exact durable operation; no new identity lookup, timestamp or event id. */
export function recoverPreferenceRequests(store: ConversationPreferencesStore, requests: MobileChatRequestStore): void {
  for (const record of requests.stranded(0)) {
    const events = reservedPreferenceEvents(record);
    if (!events) continue;
    try {
      store.applyReserved(events);
      requests.finish(record.deviceId, record.requestId, { status: 200, body: { ok: true, saveReceipt: preferenceReceipt(record.requestId, record.extra!.ref, events) } });
    } catch { /* A failed durable preference save remains recoverable; never mark it done. */ }
  }
}
