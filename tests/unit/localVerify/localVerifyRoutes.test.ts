import { describe, expect, it } from 'vitest';
import { parsePostBody, statusForResult } from '../../../src/localVerify/localVerifyRoutes.js';

describe('parsePostBody', () => {
  it('accepts exactly {pr: positive integer}', () => {
    expect(parsePostBody({ pr: 7 })).toBe(7);
  });
  it('refuses anything else', () => {
    for (const b of [null, undefined, [], 'x', {}, { pr: 0 }, { pr: -3 }, { pr: 1.5 }, { pr: '7' }, { pr: 7, repo: 'x' }, { repo: 'x' }, { pr: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(parsePostBody(b)).toBeNull();
    }
  });
});

describe('statusForResult', () => {
  it('maps outcomes to HTTP statuses', () => {
    expect(statusForResult({ ok: true, status: 'queued', position: 0 })).toBe(202);
    expect(statusForResult({ ok: true, status: 'already-queued' })).toBe(202);
    expect(statusForResult({ ok: true, status: 'in-flight' })).toBe(202);
    expect(statusForResult({ ok: true, status: 'recorded', record: {} as never })).toBe(200);
    expect(statusForResult({ ok: false, code: 'invalid-pr' })).toBe(400);
    expect(statusForResult({ ok: false, code: 'untrusted-head' })).toBe(403);
    expect(statusForResult({ ok: false, code: 'queue-full' })).toBe(429);
    expect(statusForResult({ ok: false, code: 'pr-unreadable' })).toBe(502);
    expect(statusForResult({ ok: false, code: 'pr-invalid-shas' })).toBe(502);
  });
});
