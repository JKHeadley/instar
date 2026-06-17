/**
 * Unit tests for WS5.2 §5.2 — the request-never-self-authorize orchestrator
 * (AccountFollowMeOrchestrator.ts). The load-bearing safety: the agent NEVER enrolls a
 * machine on its own; only a real operator mandate authorizes, else it surfaces phone-first
 * consent and does not proceed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  AccountFollowMeOrchestrator,
  type MandateGateLike,
  type FollowMeRequest,
} from '../../src/core/AccountFollowMeOrchestrator.js';

function make(gate: MandateGateLike, link = 'https://dash/mandates?account=acct-1&target=mini&mechanism=re-mint') {
  return new AccountFollowMeOrchestrator({
    gate,
    agentFp: () => 'fp-self',
    mandatesDeepLink: () => link,
  });
}

const baseReq: FollowMeRequest = {
  accountId: 'acct-1',
  accountEmail: 'justin@example.com',
  targetMachineId: 'mini',
  targetMachineNickname: 'the Mini',
};

const allowGate: MandateGateLike = { evaluate: () => ({ decision: 'allow', reason: 'authority granted' }) };
const denyGate: MandateGateLike = { evaluate: () => ({ decision: 'deny', reason: 'mandate not found' }) };

describe('AccountFollowMeOrchestrator (WS5.2 §5.2)', () => {
  it('NEVER self-authorizes: no mandateId → consent-required, does not proceed', () => {
    const gate = { evaluate: vi.fn(() => ({ decision: 'allow' as const, reason: 'x' })) };
    const r = make(gate).requestEnrollment(baseReq); // no mandateId
    expect(r.proceed).toBe(false);
    if (!r.proceed) {
      expect(r.outcome).toBe('consent-required');
      expect(r.reason).toBe('no-mandate');
      expect(r.consent.kind).toBe('account-follow-me-consent');
    }
    // The gate is never even consulted without a mandate id (deny-by-default short-circuit).
    expect(gate.evaluate).not.toHaveBeenCalled();
  });

  it('proceeds ONLY when a real mandate authorizes (allow)', () => {
    const r = make(allowGate).requestEnrollment({ ...baseReq, mandateId: 'MND-1' });
    expect(r.proceed).toBe(true);
    if (r.proceed) {
      expect(r.accountId).toBe('acct-1');
      expect(r.targetMachineId).toBe('mini');
      expect(r.mechanism).toBe('re-mint'); // default
    }
  });

  it('a gate deny (no/expired/revoked/forged mandate, or out-of-bounds) → consent, never proceed', () => {
    const r = make(denyGate).requestEnrollment({ ...baseReq, mandateId: 'MND-bad' });
    expect(r.proceed).toBe(false);
    if (!r.proceed) {
      expect(r.outcome).toBe('consent-required');
      expect(r.reason).toMatch(/denied:mandate not found/);
    }
  });

  it('the consent surface is phone-first (a dashboard deep-link), NEVER a CLI instruction', () => {
    const r = make(denyGate).requestEnrollment({ ...baseReq, mandateId: 'MND-bad' });
    expect(r.proceed).toBe(false);
    if (!r.proceed) {
      expect(r.consent.dashboardDeepLink).toMatch(/^https?:\/\//);
      expect(r.consent.message).not.toMatch(/instar |npm |run |CLI|terminal/i);
      expect(r.consent.message).toContain('the Mini');
      expect(r.consent.message).toContain('justin@example.com');
    }
  });

  it('passes the exact (account, target, mechanism) to the gate — deny-by-default bounds matching', () => {
    const gate = { evaluate: vi.fn(() => ({ decision: 'deny' as const, reason: 'params exceed bounds' })) };
    make(gate).requestEnrollment({ ...baseReq, mandateId: 'MND-1', mechanism: 're-mint' });
    expect(gate.evaluate).toHaveBeenCalledWith({
      action: 'account-follow-me',
      params: { accountId: 'acct-1', targetMachineId: 'mini', mechanism: 're-mint' },
      agentFp: 'fp-self',
      mandateId: 'MND-1',
    });
  });

  it('credential-transport mechanism is carried through the gate (so an Anthropic/unallowlisted bound denies)', () => {
    const gate = { evaluate: vi.fn(() => ({ decision: 'deny' as const, reason: 'no authority for mechanism' })) };
    const r = make(gate).requestEnrollment({ ...baseReq, mandateId: 'MND-1', mechanism: 'credential-transport' });
    expect(gate.evaluate).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ mechanism: 'credential-transport' }) }));
    expect(r.proceed).toBe(false); // denied → no credential-transport without an explicit allowlisted mandate
  });
});
