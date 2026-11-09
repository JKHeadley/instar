import { describe, expect, it } from 'vitest';
import {
  decodeSourceId,
  encodeSourceId,
  findLabels,
  formatMarker,
  normalizeQuote,
  parseMarkers,
  quoteIsInRecord,
} from '../../../src/core/attribution/marker.js';

describe('parseMarkers', () => {
  it('reads a well-formed marker', () => {
    const { markers, malformed } = parseMarkers('Justin: "words" [source: telegram 102965/123160 2026-10-08]');
    expect(malformed).toEqual([]);
    expect(markers[0].ref).toEqual({ channel: 'telegram', conversation: '102965', message: '123160', date: '2026-10-08' });
  });

  it('reports an unknown channel instead of accepting it', () => {
    expect(parseMarkers('[source: fax 1/2 2026-10-08]').malformed[0].reason).toBe('unknown-channel');
  });

  it('requires the date, because a ref must stay classifiable after rotation', () => {
    expect(parseMarkers('[source: telegram 1/2]').malformed[0].reason).toBe('bad-shape');
  });

  it('rejects an impossible date', () => {
    expect(parseMarkers('[source: telegram 1/2 2026-02-31]').malformed[0].reason).toBe('bad-date');
  });

  it('leaves prose and the unsourced labels alone', () => {
    const { markers, malformed } = parseMarkers('the source: unknown [source unknown] [my inference]');
    expect(markers).toEqual([]);
    expect(malformed).toEqual([]);
  });

  it('finds several markers with their positions', () => {
    const text = 'a [source: slack C1/1.5 2026-01-01] b [source: app c/e 2026-01-02]';
    const { markers } = parseMarkers(text);
    expect(markers.map((m) => m.ref.channel)).toEqual(['slack', 'app']);
    expect(text.slice(markers[1].index).startsWith('[source: app')).toBe(true);
  });
});

describe('ids', () => {
  it('round-trips an id holding characters outside the grammar', () => {
    const id = 'thread/with space+é';
    const ref = { channel: 'whatsapp' as const, conversation: id, message: 'm1', date: '2026-01-01' };
    expect(parseMarkers(formatMarker(ref)).markers[0].ref.conversation).toBe(id);
  });

  it('keeps plain ids readable', () => {
    expect(encodeSourceId('1793.55:ab-c')).toBe('1793.55:ab-c');
    expect(decodeSourceId('1793.55:ab-c')).toBe('1793.55:ab-c');
  });

  it('survives a bad escape instead of throwing', () => {
    expect(decodeSourceId('100%zz')).toBe('100%zz');
  });
});

describe('findLabels', () => {
  it('tells the two labels apart', () => {
    expect(findLabels('x [source unknown] y [my inference]').map((l) => l.label)).toEqual(['source-unknown', 'my-inference']);
  });
});

describe('quoteIsInRecord', () => {
  it('ignores case, spacing and curly quotes', () => {
    expect(quoteIsInRecord('don’t  do that', "Please DON'T do\nthat today")).toBe(true);
  });

  it('refuses words the record does not hold, on both sides of a drift', () => {
    expect(quoteIsInRecord('any Codex account', 'the last coddex account')).toBe(false);
    expect(quoteIsInRecord('the last coddex account', 'the last coddex account')).toBe(true);
  });

  it('refuses an empty quote', () => {
    expect(quoteIsInRecord('   ', 'anything')).toBe(false);
    expect(normalizeQuote('  A  B ')).toBe('a b');
  });
});
