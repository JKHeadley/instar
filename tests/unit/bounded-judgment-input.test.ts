/**
 * Tier 1 — *Never Silently Cut the Data a Decision Depends On*.
 *
 * Covers BOTH sides of every decision boundary the standard draws, with realistic
 * inputs: direction of the cut, disclosure to the consumer, refusal of a bound too
 * small to disclose in, and the load-bearing refusal that returns no verdict.
 */
import { describe, it, expect } from 'vitest';
import {
  boundedTail,
  boundedHead,
  BOUNDED_INPUT_MIN_CHARS,
} from '../../src/core/boundedInput.js';
import {
  isLoadBearingContext,
  LOAD_BEARING_CONTEXT_SUBSTRINGS,
} from '../../src/core/crossModelReviewer.js';

describe('boundedInput — direction of the cut', () => {
  it('boundedTail keeps the END: the newest content survives, the preamble goes', () => {
    // A conversation assembled oldest-first — the shape every history builder produces.
    const history = ['OLDEST-PREAMBLE', 'x'.repeat(4000), 'NEWEST-EVIDENCE'].join('\n');
    const out = boundedTail(history, 1000);
    expect(out).toContain('NEWEST-EVIDENCE');
    expect(out).not.toContain('OLDEST-PREAMBLE');
  });

  it('the bare idiom does the OPPOSITE — this is the failure being replaced', () => {
    const history = ['OLDEST-PREAMBLE', 'x'.repeat(4000), 'NEWEST-EVIDENCE'].join('\n');
    const bare = history.slice(0, 1000);
    // `.slice(0, N)` keeps the preamble and discards the evidence, and what it
    // leaves behind still reads like ordinary content — which is why it hid.
    expect(bare).toContain('OLDEST-PREAMBLE');
    expect(bare).not.toContain('NEWEST-EVIDENCE');
  });

  it('boundedHead keeps the START — available, but only under its own name', () => {
    const doc = ['TITLE-AND-ABSTRACT', 'y'.repeat(4000), 'APPENDIX'].join('\n');
    const out = boundedHead(doc, 1000);
    expect(out).toContain('TITLE-AND-ABSTRACT');
    expect(out).not.toContain('APPENDIX');
  });
});

describe('boundedInput — disclosure reaches the consumer', () => {
  it('writes the disclosure INTO the value, naming the direction of the loss', () => {
    const out = boundedTail('z'.repeat(5000), 1000);
    expect(out).toContain('BOUNDED INPUT');
    expect(out).toContain('EARLIER content was omitted');
    // It must say how much, so a reader can weigh the size of what it lost.
    expect(out).toMatch(/\d+ characters removed/);
  });

  it('boundedHead names the OTHER direction — the two are not interchangeable', () => {
    const out = boundedHead('z'.repeat(5000), 1000);
    expect(out).toContain('LATER content was omitted');
    expect(out).not.toContain('EARLIER content was omitted');
  });

  it('does NOT disclose when nothing was cut — a marker is always a true statement', () => {
    const short = 'a short value that fits comfortably';
    expect(boundedTail(short, 1000)).toBe(short);
    expect(boundedHead(short, 1000)).toBe(short);
  });

  it('respects the bound INCLUDING its own disclosure — the marker cannot overflow it', () => {
    const out = boundedTail('q'.repeat(50_000), 1200);
    expect(out.length).toBeLessThanOrEqual(1200);
  });
});

describe('boundedInput — a bound too small to disclose in is REFUSED', () => {
  it('throws rather than returning a value that is all marker and no content', () => {
    // The old ResumeValidator idiom applied to a tiny bound would silently
    // produce something; this refuses at the call site, where it gets fixed.
    expect(() => boundedTail('x'.repeat(5000), 40)).toThrow(/too small to hold the truncation disclosure/);
    expect(() => boundedHead('x'.repeat(5000), 40)).toThrow(/too small to hold the truncation disclosure/);
  });

  it('accepts exactly the floor and refuses one below it', () => {
    const text = 'x'.repeat(5000);
    expect(() => boundedTail(text, BOUNDED_INPUT_MIN_CHARS - 1)).toThrow();
    expect(() => boundedTail(text, BOUNDED_INPUT_MIN_CHARS)).not.toThrow();
  });

  it('holds the bound AT the floor — the degenerate slice must not return everything', () => {
    // Regression: at marker+1 the retained slice was `slice(-0)`, i.e. the whole
    // string, so the one function whose job is to hold a bound exceeded it. A
    // bound that fails at its own boundary is the defect in miniature.
    const text = 'x'.repeat(50_000);
    const out = boundedTail(text, BOUNDED_INPUT_MIN_CHARS);
    expect(out.length).toBeLessThanOrEqual(BOUNDED_INPUT_MIN_CHARS);
    expect(out.length).toBeLessThan(text.length);
    expect(boundedHead(text, BOUNDED_INPUT_MIN_CHARS).length).toBeLessThanOrEqual(BOUNDED_INPUT_MIN_CHARS);
  });

  it('refuses a nonsensical bound rather than coercing it', () => {
    expect(() => boundedTail('x', 0)).toThrow(/positive finite/);
    expect(() => boundedTail('x', -5)).toThrow(/positive finite/);
    expect(() => boundedTail('x', Number.NaN)).toThrow(/positive finite/);
  });
});

describe('load-bearing context classification', () => {
  it('recognises the constitutional and lessons docs a review is not valid without', () => {
    expect(isLoadBearingContext('docs/STANDARDS-REGISTRY.md')).toBe(true);
    expect(isLoadBearingContext('docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md')).toBe(true);
    expect(isLoadBearingContext('docs/specs/signal-vs-authority.md')).toBe(true);
  });

  it('does NOT sweep in an ordinary referenced doc — the refusal must stay narrow', () => {
    // A refusal that fires on everything is a broken pipeline, not a guard.
    expect(isLoadBearingContext('docs/specs/some-ordinary-spec.md')).toBe(false);
    expect(isLoadBearingContext('README.md')).toBe(false);
  });

  it('is case-insensitive on the path — a casing difference must not silently exempt a doc', () => {
    expect(isLoadBearingContext('DOCS/standards-registry.MD')).toBe(true);
  });

  it('has a non-empty definition — an empty set would make the refusal unreachable', () => {
    expect(LOAD_BEARING_CONTEXT_SUBSTRINGS.length).toBeGreaterThan(0);
  });
});

describe('boundedInput — a cut must not produce malformed text', () => {
  it('does not leave half an astral character at the seam', () => {
    // Found in the Phase-5 adversarial self-review, not by the happy path.
    // JS slices by UTF-16 code unit, so a cut can land inside an emoji and
    // leave a lone surrogate — which has no valid UTF-8 encoding, so a bounded
    // input becomes a malformed one on the way to a CLI over a pipe.
    const emoji = '🙂'; // one astral char = two code units
    for (let pad = 0; pad < 4; pad++) {
      const text = 'a'.repeat(5000 + pad) + emoji.repeat(500);
      for (const out of [boundedTail(text, 1200), boundedHead(text, 1200)]) {
        expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // lone high
        expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/); // lone low
      }
    }
  });

  it('still holds the bound after trimming the seam', () => {
    const text = '🙂'.repeat(5000);
    expect(boundedTail(text, 1200).length).toBeLessThanOrEqual(1200);
    expect(boundedHead(text, 1200).length).toBeLessThanOrEqual(1200);
  });
});
