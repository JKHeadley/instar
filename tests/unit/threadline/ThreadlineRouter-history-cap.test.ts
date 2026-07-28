/**
 * Byte-cap guards for the Threadline a2a spawn prompt.
 *
 * Regression coverage for the "command too long" fleet bug: the a2a reply-spawn
 * embeds the thread history + latest message into a prompt that is passed as a
 * `tmux new-session ... <command>` ARGUMENT. tmux's command-line limit is ~16 KB
 * (empirically: 15 KB OK, 16 KB → "command too long"), so an unbounded,
 * ever-growing history made long-thread reply-spawns fail outright — silently
 * breaking agent-to-agent communication. These tests pin the byte budget that
 * bounds the assembled prompt regardless of thread length or message size.
 */
import { describe, it, expect } from 'vitest';
import {
  capMessageBody,
  buildBoundedHistorySection,
} from '../../../src/threadline/ThreadlineRouter.js';

describe('capMessageBody', () => {
  it('is a no-op when the body is within budget', () => {
    expect(capMessageBody('short', 100)).toBe('short');
    const exact = 'x'.repeat(100);
    expect(capMessageBody(exact, 100)).toBe(exact);
  });

  it('truncates over-budget bodies and reports the dropped char count', () => {
    const body = 'y'.repeat(5000);
    const out = capMessageBody(body, 1500);
    expect(out.startsWith('y'.repeat(1500))).toBe(true);
    expect(out).toContain('[truncated 3500 chars]');
    // bounded: budget + a small fixed marker, never the full 5000
    expect(out.length).toBeLessThan(1600);
  });
});

describe('buildBoundedHistorySection', () => {
  const opts = { maxBytes: 6000, perMessageBytes: 1500 };

  function msgs(n: number, bodyLen: number) {
    return Array.from({ length: n }, (_, i) => ({
      agent: i % 2 === 0 ? 'echo' : 'instar-codey',
      createdAt: `2026-05-30T10:0${i % 10}:00.000Z`,
      body: `m${i}-${'a'.repeat(bodyLen)}`,
    }));
  }

  it('returns empty string for no messages', () => {
    expect(buildBoundedHistorySection([], 0, opts)).toBe('');
  });

  it('includes all messages and numbers them when within budget', () => {
    const out = buildBoundedHistorySection(msgs(3, 20), 3, opts);
    expect(out).toContain('Recent thread history (3 of 3 messages):');
    expect(out).toContain('[1] echo');
    expect(out).toContain('[2] instar-codey');
    expect(out).toContain('[3] echo');
    expect(out).not.toContain('older omitted');
  });

  it('bounds total size and keeps the NEWEST messages when over budget', () => {
    // 50 messages × ~2000 chars each = ~100 KB of raw history.
    const out = buildBoundedHistorySection(msgs(50, 2000), 50, opts);
    // Hard size guarantee: total ≤ maxBytes + one per-message cap + headers slack.
    expect(out.length).toBeLessThan(opts.maxBytes + opts.perMessageBytes + 500);
    // Newest message (m49) survives; an old one (m0) is dropped.
    expect(out).toContain('m49-');
    expect(out).not.toContain('m0-');
    // Header reflects truncation and an accurate included-count.
    expect(out).toMatch(/Recent thread history \(\d+ of 50 messages, older omitted to fit\):/);
  });

  it('truncates a single oversized message via the per-message cap', () => {
    const out = buildBoundedHistorySection(
      [{ agent: 'echo', createdAt: '2026-05-30T10:00:00.000Z', body: 'z'.repeat(9000) }],
      1,
      opts,
    );
    expect(out).toContain('[truncated');
    expect(out.length).toBeLessThan(opts.perMessageBytes + 200);
  });

  it('always keeps at least the newest message even if it alone exceeds maxBytes', () => {
    // perMessageBytes caps each entry; with a tiny maxBytes the newest still lands.
    const out = buildBoundedHistorySection(msgs(5, 1200), 5, { maxBytes: 100, perMessageBytes: 1500 });
    expect(out).toContain('m4-'); // newest
    expect(out).toContain('[1]');
    expect(out).toContain('older omitted to fit');
  });
});
