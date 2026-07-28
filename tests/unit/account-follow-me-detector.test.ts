/**
 * Unit tests for WS5.2 §5.2/R7 — depth-zero enrollment-offer detector (AccountFollowMeDetector).
 */
import { describe, it, expect } from 'vitest';
import { detectEnrollmentOffers, type DetectInput } from '../../src/core/AccountFollowMeDetector.js';

const acct = (accountId: string, email: string, heldByMachineIds: string[] = []) => ({ accountId, email, heldByMachineIds });

describe('detectEnrollmentOffers (WS5.2 §5.2/R7)', () => {
  it('offers the operator account to a depth-zero machine; never to a machine that already serves', () => {
    const input: DetectInput = {
      machines: [
        { machineId: 'laptop', nickname: 'Laptop', usableAccountCount: 1 },
        { machineId: 'mini', nickname: 'the Mini', usableAccountCount: 0 },
      ],
      accounts: [acct('acct-1', 'justin@example.com', ['laptop'])],
      maxFollowMachines: 5,
    };
    const offers = detectEnrollmentOffers(input);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ accountId: 'acct-1', targetMachineId: 'mini', accountEmail: 'justin@example.com' });
  });

  it('respects the per-account max-follow-machines cap', () => {
    const input: DetectInput = {
      machines: [
        { machineId: 'm2', nickname: 'M2', usableAccountCount: 0 },
        { machineId: 'm3', nickname: 'M3', usableAccountCount: 0 },
      ],
      accounts: [acct('acct-1', 'j@x.com', ['laptop', 'mini'])], // already on 2
      maxFollowMachines: 2, // cap reached
    };
    expect(detectEnrollmentOffers(input)).toHaveLength(0);
  });

  it('emits at most ONE offer per depth-zero machine (one account stops depth-zero)', () => {
    const input: DetectInput = {
      machines: [{ machineId: 'mini', nickname: 'the Mini', usableAccountCount: 0 }],
      accounts: [acct('acct-1', 'a@x.com', ['laptop']), acct('acct-2', 'b@x.com', ['laptop'])],
      maxFollowMachines: 5,
    };
    const offers = detectEnrollmentOffers(input);
    expect(offers).toHaveLength(1);
    expect(offers[0].targetMachineId).toBe('mini');
  });

  it('does not re-offer an (account, target) already in flight', () => {
    const input: DetectInput = {
      machines: [{ machineId: 'mini', nickname: 'the Mini', usableAccountCount: 0 }],
      accounts: [acct('acct-1', 'a@x.com', ['laptop'])],
      maxFollowMachines: 5,
      inFlight: new Set(['acct-1::mini']),
    };
    expect(detectEnrollmentOffers(input)).toHaveLength(0);
  });

  it('prefers the most-held account (the operator main), stable tie-break by id', () => {
    const input: DetectInput = {
      machines: [{ machineId: 'mini', nickname: 'the Mini', usableAccountCount: 0 }],
      accounts: [acct('acct-z', 'z@x.com', ['laptop']), acct('acct-a', 'a@x.com', ['laptop', 'desktop'])],
      maxFollowMachines: 5,
    };
    expect(detectEnrollmentOffers(input)[0].accountId).toBe('acct-a'); // held by 2 > 1
  });

  it('no depth-zero machines → no offers', () => {
    const input: DetectInput = {
      machines: [{ machineId: 'laptop', nickname: 'Laptop', usableAccountCount: 2 }],
      accounts: [acct('acct-1', 'a@x.com', ['laptop'])],
      maxFollowMachines: 5,
    };
    expect(detectEnrollmentOffers(input)).toEqual([]);
  });
});
