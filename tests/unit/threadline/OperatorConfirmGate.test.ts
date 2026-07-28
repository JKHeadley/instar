import { describe, it, expect } from 'vitest';
import {
  evaluateOperatorConfirm,
  OperatorAuthorization,
  isHighTrustTransfer,
  evaluateTransferAuthorization,
  type TransferTrustContext,
} from '../../../src/threadline/OperatorConfirmGate.js';

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

describe('Trust-gated transfer authorization (R2 — Justin 2026-06-01: high trust = no approval)', () => {
  const REQUESTER = 'aaaa1111';
  const HOLDER = 'bbbb2222';
  const OPERATOR = 'operator:justin';
  const REQ = 'req-xyz';
  const validAuth: OperatorAuthorization = {
    holderFingerprint: HOLDER, authorizedBy: OPERATOR, requestId: REQ, confirmedAt: '2026-06-01T00:00:00Z',
  };

  function decide(trust: TransferTrustContext, auth: OperatorAuthorization | null = null,
                  over: Partial<{ requester: string; holder: string }> = {}) {
    return evaluateTransferAuthorization({
      requesterFingerprint: over.requester ?? REQUESTER,
      holderFingerprint: over.holder ?? HOLDER,
      requestId: REQ,
      authorization: auth,
      trust,
    });
  }

  // ── isHighTrustTransfer boundary table ──
  it('high trust requires BOTH axes at/above threshold (peer ≥ trusted AND op ≥ log)', () => {
    expect(isHighTrustTransfer({ peerTrust: 'trusted', opAutonomy: 'log' })).toBe(true);        // exactly the bar
    expect(isHighTrustTransfer({ peerTrust: 'autonomous', opAutonomy: 'autonomous' })).toBe(true); // above
    expect(isHighTrustTransfer({ peerTrust: 'verified', opAutonomy: 'log' })).toBe(false);       // peer too low
    expect(isHighTrustTransfer({ peerTrust: 'trusted', opAutonomy: 'approve-first' })).toBe(false); // op too low
    expect(isHighTrustTransfer({ peerTrust: 'untrusted', opAutonomy: 'autonomous' })).toBe(false);
  });

  it('fails closed on an unrecognized trust level (never clears the bar)', () => {
    expect(isHighTrustTransfer({ peerTrust: 'bogus' as any, opAutonomy: 'log' })).toBe(false);
    expect(isHighTrustTransfer({ peerTrust: 'trusted', opAutonomy: 'bogus' as any })).toBe(false);
  });

  // ── high-trust path: no operator approval needed ──
  it('HIGH trust on both → allows with NO operator authorization record (path=high-trust)', () => {
    const d = decide({ peerTrust: 'trusted', opAutonomy: 'log' }, null);
    expect(d.allow).toBe(true);
    expect(d.path).toBe('high-trust');
    expect(d.reason).toContain('no operator approval needed');
  });

  it('HIGH trust allows even when the operator-confirm gate WOULD have blocked (trust bypass)', () => {
    // requester === authorizer would block operator-confirm, but high trust never consults it.
    const d = decide({ peerTrust: 'autonomous', opAutonomy: 'autonomous' }, null, { requester: OPERATOR });
    expect(d.allow).toBe(true);
    expect(d.path).toBe('high-trust');
  });

  // ── low-trust path: falls back to the explicit operator-confirm gate ──
  it('LOW peer trust → requires operator-confirm: blocked without a record', () => {
    const d = decide({ peerTrust: 'verified', opAutonomy: 'log' }, null);
    expect(d.allow).toBe(false);
    expect(d.path).toBe('blocked');
  });

  it('LOW peer trust → allowed WITH a valid operator authorization (path=operator-confirm)', () => {
    const d = decide({ peerTrust: 'verified', opAutonomy: 'log' }, validAuth);
    expect(d.allow).toBe(true);
    expect(d.path).toBe('operator-confirm');
  });

  it('LOW op-autonomy → requires operator-confirm even when peer is trusted', () => {
    const blocked = decide({ peerTrust: 'trusted', opAutonomy: 'approve-first' }, null);
    expect(blocked.allow).toBe(false);
    expect(blocked.path).toBe('blocked');
    const allowed = decide({ peerTrust: 'trusted', opAutonomy: 'approve-first' }, validAuth);
    expect(allowed.allow).toBe(true);
    expect(allowed.path).toBe('operator-confirm');
  });

  it('LOW trust + operator-confirm that fails (requester is the authorizer) → blocked', () => {
    const d = decide({ peerTrust: 'verified', opAutonomy: 'approve-first' },
      { ...validAuth, authorizedBy: REQUESTER }, { requester: REQUESTER });
    expect(d.allow).toBe(false);
    expect(d.path).toBe('blocked');
  });

  it('Phase-1 shape: Dawn trusted + op raised to autonomous → no approval needed', () => {
    const d = decide({ peerTrust: 'trusted', opAutonomy: 'autonomous' }, null);
    expect(d.allow).toBe(true);
    expect(d.path).toBe('high-trust');
  });
});
