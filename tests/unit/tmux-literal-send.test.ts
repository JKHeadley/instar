import { describe, it, expect } from 'vitest';
import {
  chunkLiteralForTmux,
  buildLiteralSendArgs,
  exceedsSingleSend,
  TMUX_SEND_KEYS_CHUNK_BYTES,
} from '../../src/core/tmuxLiteralSend.js';

const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe('chunkLiteralForTmux', () => {
  // ---- The defect side: oversized payloads MUST be split ----

  it('splits a payload larger than the ceiling (the 2026-08-04 outage shape)', () => {
    // ~40 KB — the real prompt size that produced `command too long` and was
    // then misreported as `provider rate-limited`.
    const prompt = 'X'.repeat(39_992);
    const chunks = chunkLiteralForTmux(prompt);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(bytes(c)).toBeLessThanOrEqual(TMUX_SEND_KEYS_CHUNK_BYTES);
    }
  });

  it('reassembles byte-exact — no character is lost, duplicated or reordered', () => {
    const prompt = `HEAD_MARKER_7f3a${'X'.repeat(39_960)}TAIL_MARKER_9c2b`;
    expect(chunkLiteralForTmux(prompt).join('')).toBe(prompt);
  });

  // ---- The compliant side: a shredder would pass the size assertion alone ----
  // These pin that the helper does NOT chunk what already fits, so a
  // "always return one byte per chunk" regression cannot pass this suite.

  it('returns a SINGLE chunk for text that already fits', () => {
    const small = 'send this as one call';
    expect(chunkLiteralForTmux(small)).toEqual([small]);
  });

  it('returns a single chunk at exactly the ceiling (boundary, inclusive)', () => {
    const exact = 'a'.repeat(TMUX_SEND_KEYS_CHUNK_BYTES);
    expect(chunkLiteralForTmux(exact)).toHaveLength(1);
  });

  it('splits at exactly one byte over the ceiling (boundary, exclusive)', () => {
    const over = 'a'.repeat(TMUX_SEND_KEYS_CHUNK_BYTES + 1);
    expect(chunkLiteralForTmux(over)).toHaveLength(2);
  });

  it('returns [] for empty input rather than one empty chunk', () => {
    expect(chunkLiteralForTmux('')).toEqual([]);
  });

  // ---- Encoding safety: the ceiling is a BYTE limit ----

  it('measures in bytes, not characters (multi-byte text still splits)', () => {
    // 4 bytes each -> 3,000 chars is 12,000 bytes, over an 8,000-byte ceiling
    // even though the character count is well under it.
    const emoji = '😀'.repeat(3_000);
    expect(emoji.length).toBeLessThan(TMUX_SEND_KEYS_CHUNK_BYTES);
    expect(bytes(emoji)).toBeGreaterThan(TMUX_SEND_KEYS_CHUNK_BYTES);
    const chunks = chunkLiteralForTmux(emoji);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(bytes(c)).toBeLessThanOrEqual(TMUX_SEND_KEYS_CHUNK_BYTES);
  });

  it('never splits a multi-byte code point across chunks', () => {
    const emoji = '😀'.repeat(3_000);
    const chunks = chunkLiteralForTmux(emoji);
    // A split surrogate pair would surface as U+FFFD on re-decode, and the
    // rejoined string would no longer equal the original.
    expect(chunks.join('')).toBe(emoji);
    for (const c of chunks) expect(c).not.toContain('�');
  });

  it('handles a chunk size that cannot fit one code point', () => {
    expect(() => chunkLiteralForTmux('😀', 2)).toThrow(/single code point/);
  });

  it('rejects a nonsensical chunk size instead of looping forever', () => {
    expect(() => chunkLiteralForTmux('abc', 0)).toThrow(/chunkBytes/);
  });
});

describe('buildLiteralSendArgs', () => {
  it('terminates option parsing so a leading dash is never read as a flag', () => {
    const args = buildLiteralSendArgs('=sess:', '-l --dangerous');
    expect(args).toEqual(['send-keys', '-t', '=sess:', '-l', '--', '-l --dangerous']);
    // `--` must precede the payload, or tmux parses the payload as options.
    expect(args.indexOf('--')).toBeLessThan(args.length - 1);
  });

  it('passes the target through verbatim (the =session: form is load-bearing)', () => {
    expect(buildLiteralSendArgs('=my-session:', 'hi')[2]).toBe('=my-session:');
  });
});

describe('exceedsSingleSend', () => {
  it('is false at the ceiling and true one byte over', () => {
    expect(exceedsSingleSend('a'.repeat(TMUX_SEND_KEYS_CHUNK_BYTES))).toBe(false);
    expect(exceedsSingleSend('a'.repeat(TMUX_SEND_KEYS_CHUNK_BYTES + 1))).toBe(true);
  });

  it('agrees with chunkLiteralForTmux on whether splitting is needed', () => {
    for (const text of ['', 'short', 'a'.repeat(7_999), 'a'.repeat(8_001), '😀'.repeat(3_000)]) {
      const needsSplit = exceedsSingleSend(text);
      const chunked = chunkLiteralForTmux(text);
      expect(chunked.length > 1).toBe(needsSplit);
    }
  });
});
