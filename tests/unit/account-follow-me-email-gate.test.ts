/**
 * Unit tests for WS5.2 §5.3/S7 — email-validation-before-selectable (AccountFollowMeEmailGate).
 * An enrolled account is selectable ONLY when its email provably matches the operator's
 * expectation; any mismatch / missing email fails closed with a HIGH attention item.
 */

import { describe, it, expect } from 'vitest';
import { validateEnrolledAccountEmail } from '../../src/core/AccountFollowMeEmailGate.js';

const base = { accountId: 'acct-1', targetMachineNickname: 'the Mini' };

describe('validateEnrolledAccountEmail (WS5.2 S7)', () => {
  it('selectable when the completed email matches the expected (case/space-insensitive)', () => {
    const r = validateEnrolledAccountEmail({ ...base, completedEmail: ' Justin@Example.com ', expectedEmail: 'justin@example.com' });
    expect(r.selectable).toBe(true);
    if (r.selectable) expect(r.email).toBe('Justin@Example.com');
  });

  it('NOT selectable on email mismatch → HIGH attention item, account not auto-used', () => {
    const r = validateEnrolledAccountEmail({ ...base, completedEmail: 'adriana@example.com', expectedEmail: 'justin@example.com' });
    expect(r.selectable).toBe(false);
    if (!r.selectable) {
      expect(r.reason).toBe('email-mismatch');
      expect(r.attentionItem.priority).toBe('high');
      expect(r.attentionItem.body).toContain('DIFFERENT account');
      expect(r.attentionItem.body).toContain('NOT auto-selected');
    }
  });

  it('fails closed when the completed login has no verifiable email', () => {
    const r = validateEnrolledAccountEmail({ ...base, completedEmail: null, expectedEmail: 'justin@example.com' });
    expect(r.selectable).toBe(false);
    if (!r.selectable) expect(r.reason).toBe('missing-completed-email');
  });

  it('fails closed when there is no operator-expected email to validate against', () => {
    const r = validateEnrolledAccountEmail({ ...base, completedEmail: 'justin@example.com', expectedEmail: undefined });
    expect(r.selectable).toBe(false);
    if (!r.selectable) expect(r.reason).toBe('missing-expected-email');
  });

  it('the attention item is stable per (account, target) for dedup', () => {
    const a = validateEnrolledAccountEmail({ ...base, completedEmail: 'x@y.com', expectedEmail: 'z@y.com' });
    const b = validateEnrolledAccountEmail({ ...base, completedEmail: 'q@y.com', expectedEmail: 'z@y.com' });
    if (!a.selectable && !b.selectable) expect(a.attentionItem.id).toBe(b.attentionItem.id);
  });
});
