/**
 * Unit tests for the captured-fixture redaction helper (scripts/redact-captured-fixture.mjs).
 *
 * The helper is part of the realness chain (FD2 / gemini #2): a redaction bug
 * must not silently produce a passing-but-FAKE fixture. So these tests prove it
 * preserves STRUCTURAL bytes (length, line positions, wrapping) and
 * GRAMMAR-VALIDITY (a redacted URL still parses; encoding form intact), and
 * REJECTS any redaction that would change length.
 */

import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs script without type declarations; pure JS helper.
import { redactCapture, REDACTION_CLASSES } from '../../scripts/redact-captured-fixture.mjs';

describe('redactCapture — same-shape secret redaction', () => {
  it('preserves length for every supported class', () => {
    const cases: Array<{ find: string; cls: string }> = [
      { find: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', cls: 'uuid' },
      { find: 'deadbeefcafe', cls: 'hex' },
      { find: 'K9pItOrURdZZjsD2XdIssdaVUOr7tT-oCJ1s1LnYadY', cls: 'base64url' },
      { find: 'AbC123xyz', cls: 'alnum' },
      { find: 'tok_live-abc.def', cls: 'token' },
    ];
    for (const { find, cls } of cases) {
      const { redacted } = redactCapture(`value=${find};`, [{ find, class: cls }]);
      // Whole-string length unchanged (so wrapping is byte-identical).
      expect(redacted.length).toBe(`value=${find};`.length);
      // The placeholder itself is the same length as the secret.
      const placeholder = redacted.slice('value='.length, redacted.length - 1);
      expect(placeholder.length).toBe(find.length);
      // And it no longer contains the real secret.
      expect(redacted).not.toContain(find);
    }
  });

  it('preserves UUID hyphen positions (delimiters kept)', () => {
    const find = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
    const { redacted } = redactCapture(find, [{ find, class: 'uuid' }]);
    // Hyphens at the same offsets.
    const hyphenPos = (s: string) => [...s].map((c, i) => (c === '-' ? i : -1)).filter((i) => i >= 0);
    expect(hyphenPos(redacted)).toEqual(hyphenPos(find));
    expect(redacted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('preserves line positions and wrapping in a multi-line capture', () => {
    const find = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
    const raw = [
      'line one',
      `rue&client_id=${find}&response_type=code&redirect_u`,
      'line three',
    ].join('\n');
    const { redacted } = redactCapture(raw, [{ find, class: 'uuid' }]);
    const rawLines = raw.split('\n');
    const redLines = redacted.split('\n');
    expect(redLines.length).toBe(rawLines.length);
    for (let i = 0; i < rawLines.length; i++) {
      expect(redLines[i].length).toBe(rawLines[i].length); // wrapping byte-identical
    }
  });

  it('keeps a redacted URL grammar-valid (still parses via new URL)', () => {
    const clientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
    const state = 'K9pItOrURdZZjsD2XdIssdaVUOr7tT-oCJ1s1LnYadY';
    const url = `https://claude.com/cai/oauth/authorize?code=true&client_id=${clientId}&scope=user%3Aprofile&state=${state}`;
    const { redacted } = redactCapture(url, [
      { find: clientId, class: 'uuid' },
      { find: state, class: 'base64url' },
    ]);
    // Still a valid URL.
    expect(() => new URL(redacted)).not.toThrow();
    const parsed = new URL(redacted);
    // Percent-escapes intact (encoding form preserved).
    expect(parsed.searchParams.get('scope')).toBe('user:profile');
    // The query params still present with same-length redacted values.
    expect(parsed.searchParams.get('client_id')!.length).toBe(clientId.length);
    expect(parsed.searchParams.get('state')!.length).toBe(state.length);
    expect(redacted).not.toContain(clientId);
    expect(redacted).not.toContain(state);
  });

  it('records each redaction with what/strategy/length/class', () => {
    const find = 'deadbeef';
    const { redactions } = redactCapture(`x=${find}`, [{ find, class: 'hex' }]);
    expect(redactions).toHaveLength(1);
    expect(redactions[0]).toMatchObject({ what: find, length: find.length, class: 'hex' });
    expect(redactions[0].strategy).toContain('same-length');
  });

  it('rejects an unknown redaction class', () => {
    expect(() => redactCapture('abc', [{ find: 'abc', class: 'nonsense' }])).toThrow(/unknown class/);
  });

  it('rejects a `find` that is not present in the capture', () => {
    expect(() => redactCapture('hello world', [{ find: 'not-here', class: 'alnum' }])).toThrow(/not found/);
  });

  it('exposes the supported class set', () => {
    expect(REDACTION_CLASSES.has('uuid')).toBe(true);
    expect(REDACTION_CLASSES.has('base64url')).toBe(true);
    expect(REDACTION_CLASSES.has('token')).toBe(true);
  });
});
