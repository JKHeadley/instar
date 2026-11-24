import { comparePreferenceEvents, type ConversationPreferencesStore } from '../core/ConversationPreferences.js';
import type { ConversationListRow } from './mobileConversationRoutes.js';
export type PreferenceIdentityView = { version: string; resolve: (raw: string, row?: ConversationListRow) => { ref: string; accessRef: string } | null };
/** One captured reader view for the entire response, including every awaited peer page. */
export function capturePreferenceView(store: ConversationPreferencesStore | null | undefined, reader: string | null, identity: PreferenceIdentityView | null, selection: 'exclude' | 'only' | 'all') {
  const readable = !!store?.isReadable() && !!reader;
  const latest = new Map<string, ReturnType<ConversationPreferencesStore['rows']>[number]>();
  if (readable) for (const row of store!.rows()) {
    if (row.reader !== reader) continue;
    const key = `${row.ref}\0${row.field}`;
    const current = latest.get(key);
    if (!current || comparePreferenceEvents(row, current) > 0) latest.set(key, row);
  }
  let uncertain = !readable || !identity;
  const overlay = (row: ConversationListRow): ConversationListRow => {
    const { muted: _m, archived: _a, preferenceRef: candidate, ...clean } = row;
    const raw = candidate ?? (row.platform === 'app' ? `app:${row.id}` : row.platform === 'telegram' ? `telegram:${row.id}` : `slack:${row.machine}:${row.id}`);
    let resolved: ReturnType<PreferenceIdentityView['resolve']> = null;
    try { resolved = identity?.resolve(raw, row) ?? null; } catch { /* Unverified identity stays unavailable. */ }
    if (!resolved || !resolved.ref.startsWith(`${row.platform}:`) || (row.platform === 'app' && resolved.ref !== `app:${row.id}`)) { uncertain = true; return clean; }
    if (!readable) return { ...clean, preferenceRef: resolved.ref };
    return { ...clean, preferenceRef: resolved.ref, muted: latest.get(`${resolved.ref}\0muted`)?.value ?? false, archived: latest.get(`${resolved.ref}\0archived`)?.value ?? false };
  };
  return {
    overlay,
    includes: (row: ConversationListRow): boolean => selection === 'all' || (row.archived === undefined ? selection === 'exclude' : selection === 'only' ? row.archived : !row.archived),
    status: () => ({ preferencesState: !readable ? 'unavailable' as const : uncertain ? 'partial' as const : 'ready' as const, archiveSelectionComplete: !uncertain }),
  };
}
