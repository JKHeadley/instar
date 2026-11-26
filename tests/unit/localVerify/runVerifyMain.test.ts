/**
 * Tier-1 tests for the local-verify child entry's argument contract: the
 * attempt token on argv is what boot uses to corroborate a group's identity.
 */
import { describe, expect, it } from 'vitest';
import { parseMainArgs } from '../../../src/localVerify/runVerifyMain.js';

describe('parseMainArgs', () => {
  it('reads input, result and a hex attempt token', () => {
    expect(parseMainArgs(['--input', '/s/i.json', '--result', '/s/r.json', '--attempt-token', 'ab'.repeat(16)]))
      .toEqual({ input: '/s/i.json', result: '/s/r.json', attemptToken: 'ab'.repeat(16) });
  });
  it('refuses a missing flag or a malformed token', () => {
    expect(parseMainArgs(['--input', '/s/i.json', '--result', '/s/r.json'])).toBeNull();
    expect(parseMainArgs(['--input', '/s/i.json', '--result', '/s/r.json', '--attempt-token', 'not-hex!'])).toBeNull();
    expect(parseMainArgs(['--input', '--result', '/s/r.json', '--attempt-token', 'ab'.repeat(16)])).toMatchObject({ input: '--result' });
  });
});
