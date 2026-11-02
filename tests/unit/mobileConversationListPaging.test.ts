/**
 * The unified conversation list order and cursor (docs/specs/mobile-native-conversations.md §4.1,
 * §4.8): one total order across app conversations and Telegram topics, a cursor strictly after a
 * row, and a lossless merge of several sources' pages (this machine and its peers).
 */
import { describe, it, expect } from 'vitest';
import {
  compareConversationRows, isAfterListCursor, listCursorFor, mergeConversationPages, parseListCursor, type ConversationListRow,
} from '../../src/server/mobileConversationRoutes.js';
import { hideCredentialSpans } from '../../src/core/appConversationText.js';

const app = (id: string, at: string | null): ConversationListRow => ({ id, platform: 'app', title: id, lastActivity: at, lastPreview: null });
const tg = (id: number, at: string | null): ConversationListRow => ({ id, platform: 'telegram', title: String(id), lastActivity: at, lastPreview: null });

/** Page a single sorted universe through the merge, `limit` at a time, with sources split arbitrarily. */
function pageAll(sources: ConversationListRow[][], limit: number): Array<string | number> {
  const out: Array<string | number> = [];
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const c = parseListCursor(cursor);
    const pages = sources.map((rows) => {
      const after = rows.filter((r) => isAfterListCursor(r, c)).sort(compareConversationRows);
      return { rows: after.slice(0, limit), more: after.length > limit };
    });
    const m = mergeConversationPages(pages, limit);
    out.push(...m.rows.map((r) => r.id));
    cursor = m.nextCursor;
    if (!cursor) break;
  }
  return out;
}

describe('conversation list paging', () => {
  it('orders newest first, ties by sort key, missing activity last', () => {
    const rows = [app('b', '2026-01-01T00:00:00.000Z'), tg(5, '2026-01-01T00:00:00.000Z'), app('a', null), tg(1, '2026-02-01T00:00:00.000Z')];
    expect(rows.sort(compareConversationRows).map((r) => r.id)).toEqual([1, 5, 'b', 'a']);
  });

  it('the cursor is strictly after its own row and before everything older', () => {
    const r = tg(5, '2026-01-01T00:00:00.000Z');
    const c = parseListCursor(listCursorFor(r));
    expect(c).toEqual({ activity: '2026-01-01T00:00:00.000Z', key: 'telegram:5' });
    expect(isAfterListCursor(r, c)).toBe(false);
    expect(isAfterListCursor(app('z', '2026-01-01T00:00:00.000Z'), c)).toBe(true); // 'app:z' < 'telegram:5'
    expect(isAfterListCursor(tg(4, '2026-01-01T00:00:00.000Z'), c)).toBe(true);
    expect(isAfterListCursor(tg(6, '2026-01-01T00:00:00.000Z'), c)).toBe(false);
    expect(isAfterListCursor(app('n', null), c)).toBe(true);
    expect(parseListCursor(null)).toBeNull();
    expect(parseListCursor('garbage')).toBeNull();
  });

  it('pages several sources losslessly, every row exactly once, whatever the page size', () => {
    const universe: ConversationListRow[] = [];
    for (let i = 0; i < 40; i++) universe.push(tg(100 + i, new Date(Date.UTC(2026, 0, 1, 0, i % 7)).toISOString()));
    for (let i = 0; i < 25; i++) universe.push(app(`k${String(i).padStart(2, '0')}`, i % 5 ? new Date(Date.UTC(2026, 0, 1, 0, i % 9)).toISOString() : null));
    const expected = [...universe].sort(compareConversationRows).map((r) => r.id);
    const split = [universe.filter((_, i) => i % 3 === 0), universe.filter((_, i) => i % 3 === 1), universe.filter((_, i) => i % 3 === 2)];
    for (const limit of [1, 3, 7, 200]) expect(pageAll(split, limit)).toEqual(expected);
  });

  it('collapses the same conversation from two machines to its newest copy', () => {
    const older = { ...app('k1', '2026-01-01T00:00:00.000Z'), machine: 'm1' };
    const newer = { ...app('k1', '2026-01-02T00:00:00.000Z'), machine: 'm2' };
    const m = mergeConversationPages([{ rows: [older], more: false }, { rows: [newer], more: false }], 10);
    expect(m.rows).toEqual([newer]);
    expect(m.nextCursor).toBeNull();
  });

  it('a source with more rows keeps the cursor even when the merged page is short', () => {
    const m = mergeConversationPages([{ rows: [tg(1, '2026-01-01T00:00:00.000Z')], more: true }], 10);
    expect(m.nextCursor).toBe('2026-01-01T00:00:00.000Z|telegram:1');
  });
});

describe('hideCredentialSpans (the mirror copy)', () => {
  it('hides a credential span and leaves ordinary text alone', () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
    const out = hideCredentialSpans(`my key is ${secret} ok`);
    expect(out).toContain('[credential hidden]');
    expect(out).not.toContain(secret);
    expect(hideCredentialSpans('see you at 5pm')).toBe('see you at 5pm');
  });
});
