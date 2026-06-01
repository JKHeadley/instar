import { describe, it, expect } from 'vitest';
import { evaluateOperatorConfirm, OperatorAuthorization } from '../../../src/threadline/OperatorConfirmGate.js';

describe('OperatorConfirmGate (R2 — requester ≠ authorizer)', () => {
  const REQUESTER = 'aaaa1111';   // the agent that requested the secret (receiver)
  const HOLDER = 'bbbb2222';      // the agent submitting the secret (sender)
  const OPERATOR = 'operator:justin';
  const REQ = 'req-xyz';

  const validAuth: OperatorAuthorization = {
    holderFingerprint: HOLDER,
    authorizedBy: OPERATOR,
    requestId: REQ,
    confirmedAt: '2026-06-01T00:00:00Z',
  };

  function run(over: Partial<{ requester: string; holder: string; requestId: string; auth: OperatorAuthorization | null }>) {
    return evaluateOperatorConfirm({
      requesterFingerprint: over.requester ?? REQUESTER,
      holderFingerprint: over.holder ?? HOLDER,
      requestId: over.requestId ?? REQ,
      authorization: over.auth === undefined ? validAuth : over.auth,
    });
  }

  it('allows when operator-authorized for this request + holder, requester ≠ authorizer', () => {
    const d = run({});
    expect(d.allow).toBe(true);
  });

  it('blocks when there is no authorization record (relayed "go" is not authorization)', () => {
    const d = run({ auth: null });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('No operator authorization');
  });

  it('blocks when the authorization is for a different request id (no cross-request reuse)', () => {
    const d = run({ auth: { ...validAuth, requestId: 'req-OTHER' } });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('different request');
  });

  it('blocks when the authorization names a different holder than the submitter', () => {
    const d = run({ auth: { ...validAuth, holderFingerprint: 'cccc3333' } });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('different holder');
  });

  it('blocks when the requester IS the authorizer (agent self-authorizes / impersonates operator)', () => {
    const d = run({ requester: OPERATOR });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('Requester is the authorizer');
  });

  it('blocks when the holder IS the authorizer (sending agent claims operator role)', () => {
    const d = run({ auth: { ...validAuth, holderFingerprint: OPERATOR }, holder: OPERATOR });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('Holder is the authorizer');
  });
});
