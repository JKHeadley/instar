/**
 * checkDeliveredMandateUsableForEnroll — the point-of-use temporal + revocation gate
 * (convergence critical #3: revoked/expired delivered mandates auto-enrolled). Pure
 * predicate; tests pin both sides of every check + the fail-closed paths.
 */
import { describe, it, expect } from 'vitest';
import { checkDeliveredMandateUsableForEnroll } from '../../src/coordination/enrollPointOfUseCheck.js';

const BASE = {
  mandateId: 'mandate-1',
  expiresAt: new Date(2_000_000_000_000).toISOString(), // far future
  bounds: { accountId: 'adriana', targetMachineId: 'm_4cbc' },
  requested: { accountId: 'adriana', targetMachineId: 'm_4cbc' },
  now: 1_000_000_000_000,
  isRevoked: () => false,
};

describe('checkDeliveredMandateUsableForEnroll', () => {
  it('OK when bounds match, not expired, not revoked', () => {
    expect(checkDeliveredMandateUsableForEnroll(BASE)).toEqual({ ok: true, reason: 'ok' });
  });

  it('DENY bounds-mismatch when requested account differs from the signed bounds', () => {
    const r = checkDeliveredMandateUsableForEnroll({ ...BASE, requested: { accountId: 'someone-else', targetMachineId: 'm_4cbc' } });
    expect(r).toEqual({ ok: false, reason: 'bounds-mismatch' });
  });

  it('DENY bounds-mismatch when requested target differs', () => {
    const r = checkDeliveredMandateUsableForEnroll({ ...BASE, requested: { accountId: 'adriana', targetMachineId: 'm_other' } });
    expect(r.reason).toBe('bounds-mismatch');
  });

  it('DENY expired when now is past expiry (the #3 critical — no enroll on an expired mandate)', () => {
    const r = checkDeliveredMandateUsableForEnroll({ ...BASE, expiresAt: new Date(500).toISOString(), now: 1_000 });
    expect(r).toEqual({ ok: false, reason: 'expired' });
  });

  it('DENY bad-expiry on a missing/garbage expiry (fail-closed)', () => {
    const r = checkDeliveredMandateUsableForEnroll({ ...BASE, expiresAt: 'not-a-date' });
    expect(r.reason).toBe('bad-expiry');
  });

  it('DENY revoked when the live oracle says revoked (the #3 critical — no enroll on a revoked mandate)', () => {
    const r = checkDeliveredMandateUsableForEnroll({ ...BASE, isRevoked: () => true });
    expect(r).toEqual({ ok: false, reason: 'revoked' });
  });

  it('DENY revocation-unknown (fail-closed) when the revocation oracle throws', () => {
    const r = checkDeliveredMandateUsableForEnroll({ ...BASE, isRevoked: () => { throw new Error('oracle down'); } });
    expect(r).toEqual({ ok: false, reason: 'revocation-unknown' });
  });

  it('checks bounds BEFORE expiry/revocation (a mismatched pair never reaches the oracle)', () => {
    let oracleCalled = false;
    checkDeliveredMandateUsableForEnroll({
      ...BASE,
      requested: { accountId: 'x', targetMachineId: 'y' },
      isRevoked: () => { oracleCalled = true; return false; },
    });
    expect(oracleCalled).toBe(false);
  });
});
