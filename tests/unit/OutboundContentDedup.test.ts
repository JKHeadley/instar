// safe-fs-allow: test file — no fs.

/**
 * Unit tests for OutboundContentDedup (duplicate-message suppression).
 *
 * Grounded in the real 2026-06-06 EXO incident: the same status text went out
 * byte-identical 13.5 minutes apart. The dedup must catch that, while never
 * suppressing brief acks or messages the caller flagged allowDuplicate.
 */

import { describe, it, expect } from 'vitest';
import {
  OutboundContentDedup,
  normalizeForDedup,
  fingerprint,
} from '../../src/messaging/OutboundContentDedup.js';

// A realistic ≥40-char status message (the kind that was duplicated).
const STATUS =
  '✅ The vault-GitHub-token security piece (your option C) just landed clean on the main branch.';

describe('OutboundContentDedup — the duplicate it catches', () => {
  it('suppresses the SAME long text to the same topic within the window', () => {
    let t = 1_000_000;
    const d = new OutboundContentDedup({ windowMs: 15 * 60 * 1000 }, () => t);

    expect(d.isDuplicate(19437, STATUS)).toBe(false); // first time
    d.record(19437, STATUS);

    t += 13.5 * 60 * 1000; // the real 13.5-minute gap
    expect(d.isDuplicate(19437, STATUS)).toBe(true); // identical, within window
  });

  it('treats whitespace-only differences as the same message', () => {
    let t = 0;
    const d = new OutboundContentDedup({}, () => t);
    d.record(7, STATUS);
    t += 60_000;
    expect(d.isDuplicate(7, '  ' + STATUS.replace(' ', '  ') + '\n')).toBe(true);
  });
});

describe('OutboundContentDedup — what it must NOT suppress', () => {
  it('lets the identical text through AFTER the window expires', () => {
    let t = 0;
    const d = new OutboundContentDedup({ windowMs: 10 * 60 * 1000 }, () => t);
    d.record(1, STATUS);
    t += 11 * 60 * 1000; // past the window
    expect(d.isDuplicate(1, STATUS)).toBe(false);
  });

  it('never suppresses brief acks (below the length floor)', () => {
    let t = 0;
    const d = new OutboundContentDedup({ minLength: 40 }, () => t);
    const ack = 'Got it, looking into this now.'; // < 40 chars
    d.record(1, ack);
    t += 10_000;
    expect(d.isDuplicate(1, ack)).toBe(false);
  });

  it('does not cross topics — same text to a different topic is allowed', () => {
    let t = 0;
    const d = new OutboundContentDedup({}, () => t);
    d.record(1, STATUS);
    t += 60_000;
    expect(d.isDuplicate(2, STATUS)).toBe(false);
  });

  it('different long text to the same topic is allowed', () => {
    let t = 0;
    const d = new OutboundContentDedup({}, () => t);
    d.record(1, STATUS);
    t += 60_000;
    expect(d.isDuplicate(1, STATUS + ' Now wiring the next piece in.')).toBe(false);
  });

  it('disabled → never suppresses', () => {
    let t = 0;
    const d = new OutboundContentDedup({ enabled: false }, () => t);
    d.record(1, STATUS);
    expect(d.isDuplicate(1, STATUS)).toBe(false);
  });

  it('isDuplicate is a pure read — calling it does not register the text', () => {
    let t = 0;
    const d = new OutboundContentDedup({}, () => t);
    expect(d.isDuplicate(1, STATUS)).toBe(false);
    t += 60_000;
    // Still not a duplicate because the first isDuplicate did not record.
    expect(d.isDuplicate(1, STATUS)).toBe(false);
  });
});

describe('OutboundContentDedup — ring bounds + pruning', () => {
  it('enforces the per-topic cap (oldest evicted)', () => {
    let t = 0;
    const d = new OutboundContentDedup({ maxPerTopic: 3, windowMs: 60 * 60 * 1000 }, () => t);
    for (let i = 0; i < 5; i++) { d.record(1, `${STATUS} variant number ${i} of the message`); t += 1000; }
    // The first two are evicted (cap 3); the most recent are still remembered.
    expect(d.isDuplicate(1, `${STATUS} variant number 0 of the message`)).toBe(false);
    expect(d.isDuplicate(1, `${STATUS} variant number 4 of the message`)).toBe(true);
  });
});

describe('helpers', () => {
  it('normalizeForDedup collapses whitespace + trims', () => {
    expect(normalizeForDedup('  a\n\n b   c  ')).toBe('a b c');
  });
  it('fingerprint is stable + length-tagged', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'));
    expect(fingerprint('abc')).not.toBe(fingerprint('abcd'));
    expect(fingerprint('abc').endsWith(':3')).toBe(true);
  });
});
