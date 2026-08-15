/**
 * Unit tests — grok's JSON envelope carries RAW control characters (round-17).
 *
 * THE DEFECT: grok's `--output-format json` embeds raw newlines inside its JSON
 * string values instead of escaping them as `\n`. That is invalid JSON, so
 * `JSON.parse` throws — on EVERY multi-line response, which is essentially
 * every real one. The one-shot lane is the ONLY live lane in this spec, so the
 * deliverable did not work for realistic output.
 *
 * WHY THE LIVE PROOF MISSED IT — and this is the part worth keeping: the
 * earlier end-to-end verification used a one-line reply ("Reply with exactly:
 * OK"). A single-line envelope contains no raw newline, parses cleanly, and
 * certifies nothing about the shape the lane actually carries. A live proof
 * whose input is narrower than production is the same "passing condition
 * narrower than what it certifies" class as a unit test that cannot fail —
 * running it against a REAL binary does not rescue it.
 *
 * Measured on a real reviewer-shaped run before the fix: 109 raw newlines
 * inside string values, zero escaped, JSON.parse failing at the first one.
 */

import { describe, it, expect } from 'vitest';
import {
  parseGrokEnvelope,
  repairGrokEnvelopeJson,
} from '../../src/providers/adapters/grok-build/transport/oneShotCompletion.js';

/** The real shape grok emits: raw newlines inside the string value. */
const MULTILINE_RAW =
  '{\n  "text": "line one\nline two\n\nline four",\n  "stopReason": "end_turn",\n'
  + '  "usage": { "input_tokens": 10, "output_tokens": 20 }\n}';

describe('grok envelope repair — the multi-line defect', () => {
  it('the raw envelope is genuinely INVALID JSON (the premise, asserted not assumed)', () => {
    // If this ever starts passing, grok fixed its output and the repair below
    // becomes a no-op rather than a fix — worth knowing either way.
    expect(() => JSON.parse(MULTILINE_RAW)).toThrow();
  });

  it('parses a multi-line response that previously returned null', () => {
    const parsed = parseGrokEnvelope(MULTILINE_RAW);
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe('line one\nline two\n\nline four');
    expect(parsed!.stopReason).toBe('end_turn');
    expect(parsed!.usage?.input_tokens).toBe(10);
  });

  it('CONTROL: the single-line shape the old live proof used still parses', () => {
    // Without this the fix could regress the one case that DID work.
    const parsed = parseGrokEnvelope('{"text":"OK","stopReason":"end_turn"}');
    expect(parsed!.text).toBe('OK');
  });

  it('CONTROL: valid JSON passes through the repair byte-identical', () => {
    // The repair must not rewrite well-formed input — an escaped \n inside a
    // string is already correct and must survive untouched.
    const valid = '{"text":"already\\nescaped","n":1,"s":" spaced "}';
    expect(repairGrokEnvelopeJson(valid)).toBe(valid);
    expect(JSON.parse(repairGrokEnvelopeJson(valid)).text).toBe('already\nescaped');
  });

  it('does not corrupt an escaped backslash preceding a newline', () => {
    // `"a\\"` ends with a literal backslash; the following raw newline is still
    // inside the string and must be escaped, not treated as escaped-already.
    const tricky = '{"text":"a\\\\\n b"}';
    const parsed = JSON.parse(repairGrokEnvelopeJson(tricky));
    expect(parsed.text).toBe('a\\\n b');
  });

  it('escapes tabs and carriage returns too, not only newlines', () => {
    const parsed = parseGrokEnvelope('{"text":"a\tb\rc"}');
    expect(parsed!.text).toBe('a\tb\rc');
  });

  it('CONTROL: genuinely unparseable output still returns null', () => {
    // The repair must not turn "no envelope" into a false success.
    expect(parseGrokEnvelope('no json here at all')).toBeNull();
    expect(parseGrokEnvelope('{ "unterminated": ')).toBeNull();
  });
});
