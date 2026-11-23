import { describe, it, expect } from 'vitest';
import { filterKnownRows, parseKnownRows, CHANGE_FEED_MAX_KNOWN_CHARS } from '../../src/server/changeFeed.js';

describe('history page payload diff', () => {
  it('keeps plain reads plain and uses an empty set for an initial baseline', () => {
    expect(parseKnownRows(undefined)).toBeNull();
    expect(parseKnownRows('')).toEqual(new Set());
    expect(filterKnownRows([{ text: 'hello' }], null)).toEqual({ messages: [{ text: 'hello' }] });
  });
  it('validates exact digest shape and bounded input including both sides of the count boundary', () => {
    const hash = 'a'.repeat(64);
    expect(parseKnownRows(Array(100).fill(hash).join(','))).toEqual(new Set([hash]));
    for (const raw of [null, [], {}, 12, 'a'.repeat(63), 'A'.repeat(64), `${hash},`, Array(101).fill(hash).join(','), 'x'.repeat(CHANGE_FEED_MAX_KNOWN_CHARS + 1)]) {
      expect(parseKnownRows(raw)).toBe('invalid');
    }
  });
  it('omits exact duplicates, preserves row order and includes the full ordered page hash set', () => {
    const rows = [{ text: 'one' }, { text: 'two' }, { text: 'three' }];
    const baseline = filterKnownRows(rows, new Set());
    const hashes = baseline.changeFeed!.rowHashes;
    expect(hashes.every((h) => /^[a-f0-9]{64}$/.test(h))).toBe(true);
    const delta = filterKnownRows(rows, new Set([hashes[1]!]));
    expect(delta.messages).toEqual([rows[0], rows[2]]);
    expect(delta.changeFeed!.rowHashes).toEqual(hashes);
  });
  it('includes late rows and any changed rendering field regardless of displayed time', () => {
    const row = { id: 'one', at: '2099-01-01', text: 'hello', deliveryState: 'pending', originVerified: 'unknown' };
    const hashes = new Set(filterKnownRows([row], new Set()).changeFeed!.rowHashes);
    for (const update of [{ deliveryState: 'delivered' }, { originVerified: 'verified' }, { attachments: [{ name: 'photo.png' }] }, { text: 'edited' }]) {
      expect(filterKnownRows([{ ...row, ...update }], hashes).messages).toHaveLength(1);
    }
    expect(filterKnownRows([{ id: 'late', at: '2020-01-01', text: 'arrived late' }], hashes).messages).toHaveLength(1);
  });
});
