import { describe, it, expect } from 'vitest';
import { selectArchivePage } from '../../src/server/conversationArchiveSelection.js';
import { capturePreferenceView } from '../../src/server/conversationPreferenceView.js';
import { mergeConversationPages, listCursorFor, isAfterListCursor, parseListCursor } from '../../src/server/mobileConversationRoutes.js';
import type { ConversationListRow } from '../../src/server/mobileConversationRoutes.js';
import type { ConversationPreferencesStore } from '../../src/core/ConversationPreferences.js';
describe('archive consumed prefix selection', () => {
  it('unknown Telegram namespaces remain distinct per holder and their cursor can advance within a timestamp', () => {
    const base = { id: 42, platform: 'telegram' as const, title: null, lastActivity: '2020-01-01T00:00:00.000Z', lastPreview: null };
    const page = mergeConversationPages([{ rows: [{ ...base, machine: 'm1' }, { ...base, machine: 'm2' }], more: false }], 1);
    expect(page.rows).toHaveLength(1); expect(page.nextCursor).toContain('telegram:machine:');
    const remaining = [{ ...base, machine: 'm1' }, { ...base, machine: 'm2' }].filter((row) => isAfterListCursor(row, parseListCursor(listCursorFor(page.rows[0]))));
    expect(remaining).toHaveLength(1); expect(remaining[0].machine).not.toBe(page.rows[0].machine);
  });
  it('does not consume merged lookahead when the selected page fills', async () => {
    const result = await selectArchivePage({ cursor: null, limit: 2, admitted: () => true, cursorFor: String, select: () => true, fetch: async () => ({ rows: [100, 90, 80], more: false }) });
    expect(result).toMatchObject({ rows: [100, 90], nextCursor: '90', moreCandidates: true });
  });
  it('budget exhaustion consumes excluded candidates only to its exact ordered boundary', async () => {
    let consumed = 0;
    const result = await selectArchivePage({ cursor: null, limit: 2, admitted: () => consumed < 2, cursorFor: String, select: () => { consumed++; return false; }, fetch: async () => ({ rows: [100, 90, 80], more: true }) });
    expect(result).toMatchObject({ rows: [], nextCursor: '90', moreCandidates: true, archiveSelectionComplete: false });
  });
  it('continues through wholly excluded pages and resumes without loss', async () => {
    const seen: Array<string | null> = [];
    const result = await selectArchivePage({ cursor: null, limit: 1, admitted: () => true, cursorFor: String, select: (x: number) => x === 2, fetch: async (cursor) => { seen.push(cursor); return cursor === null ? { rows: [5, 4], more: true } : { rows: [3, 2, 1], more: false }; } });
    expect(seen).toEqual([null, '4']); expect(result).toMatchObject({ rows: [2], nextCursor: '2' });
  });
  it('unavailable identity preserves ordinary rows, omits archived-only rows and strips peer assertions', () => {
    const row: ConversationListRow = { id: -4, platform: 'slack', title: null, lastActivity: null, lastPreview: null, muted: true, archived: true };
    const store = { isReadable: () => true, rows: () => [] } as unknown as ConversationPreferencesStore;
    const ordinary = capturePreferenceView(store, 'owner', null, 'exclude');
    const clean = ordinary.overlay(row);
    expect(clean.archived).toBeUndefined(); expect(clean.muted).toBeUndefined(); expect(ordinary.includes(clean)).toBe(true); expect(ordinary.status()).toMatchObject({ preferencesState: 'partial', archiveSelectionComplete: false });
    expect(capturePreferenceView(store, 'owner', null, 'only').includes(clean)).toBe(false);
  });
  it('rejects verified preferences belonging to another platform or a different App row', () => {
    const store = { isReadable: () => true, rows: () => [] } as unknown as ConversationPreferencesStore;
    for (const [row, ref] of [
      [{ id: 42, platform: 'telegram', title: null, lastActivity: null, lastPreview: null }, 'slack:workspace:channel:thread'],
      [{ id: 'actual', platform: 'app', title: null, lastActivity: null, lastPreview: null }, 'app:other'],
    ] as const) {
      const view = capturePreferenceView(store, 'owner', { version: '1', resolve: () => ({ ref, accessRef: ref }) }, 'exclude');
      const clean = view.overlay(row);
      expect(clean.preferenceRef).toBeUndefined(); expect(clean.muted).toBeUndefined(); expect(clean.archived).toBeUndefined(); expect(view.status().preferencesState).toBe('partial');
    }
  });
  it('captures preference state once and recomputes identity/readiness recovery without an event change', () => {
    const row: ConversationListRow = { id: 'x', platform: 'app', title: null, lastActivity: null, lastPreview: null };
    let ready = false;
    const store = { isReadable: () => ready, rows: () => [] } as unknown as ConversationPreferencesStore;
    const identity = { version: '1', resolve: () => ({ ref: 'app:x', accessRef: 'x' }) };
    const old = capturePreferenceView(store, 'owner', identity, 'exclude'); ready = true;
    expect(old.overlay(row).archived).toBeUndefined();
    expect(capturePreferenceView(store, 'owner', identity, 'exclude').overlay(row).archived).toBe(false);
  });
});
