/**
 * Unit tests for WS5.2 depth adapter (accountFollowMeDepth.buildDepthInput) — maps per-machine
 * pool views into the detector input; only locally-held + active/warming accounts count as usable.
 */
import { describe, it, expect } from 'vitest';
import { buildDepthInput, type MachinePoolView } from '../../src/core/accountFollowMeDepth.js';
import { detectEnrollmentOffers } from '../../src/core/AccountFollowMeDetector.js';

describe('buildDepthInput (WS5.2 depth adapter)', () => {
  it('counts only locally-held + active/warming accounts as usable; meta-only does not count', () => {
    const views: MachinePoolView[] = [
      { machineId: 'laptop', nickname: 'Laptop', accounts: [{ accountId: 'a1', email: 'j@x.com', status: 'active', locallyHeld: true }] },
      { machineId: 'mini', nickname: 'the Mini', accounts: [
        { accountId: 'a1', email: 'j@x.com', status: 'active', locallyHeld: false }, // meta-only — knows but can't serve
      ] },
    ];
    const { machines, accounts } = buildDepthInput(views);
    expect(machines.find((m) => m.machineId === 'laptop')!.usableAccountCount).toBe(1);
    expect(machines.find((m) => m.machineId === 'mini')!.usableAccountCount).toBe(0); // meta-only ⇒ depth-zero
    expect(accounts).toHaveLength(1);
    expect(accounts[0].heldByMachineIds).toEqual(['laptop']); // only the real holder
  });

  it('a rate-limited / needs-reauth locally-held account is NOT usable', () => {
    const views: MachinePoolView[] = [
      { machineId: 'm', nickname: 'M', accounts: [
        { accountId: 'a1', status: 'rate-limited', locallyHeld: true },
        { accountId: 'a2', status: 'needs-reauth', locallyHeld: true },
      ] },
    ];
    expect(buildDepthInput(views).machines[0].usableAccountCount).toBe(0);
  });

  it('feeds the detector end-to-end: meta-only Mini is detected depth-zero and offered the real account', () => {
    const views: MachinePoolView[] = [
      { machineId: 'laptop', nickname: 'Laptop', accounts: [{ accountId: 'a1', email: 'j@x.com', status: 'active', locallyHeld: true }] },
      { machineId: 'mini', nickname: 'the Mini', accounts: [{ accountId: 'a1', email: 'j@x.com', status: 'active', locallyHeld: false }] },
    ];
    const input = buildDepthInput(views);
    const offers = detectEnrollmentOffers({ ...input, maxFollowMachines: 5 });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ accountId: 'a1', targetMachineId: 'mini', accountEmail: 'j@x.com' });
  });

  it('collapses the same account across machines into one entry with both real holders', () => {
    const views: MachinePoolView[] = [
      { machineId: 'm1', nickname: 'M1', accounts: [{ accountId: 'a1', status: 'active', locallyHeld: true }] },
      { machineId: 'm2', nickname: 'M2', accounts: [{ accountId: 'a1', status: 'warming', locallyHeld: true }] },
    ];
    const { accounts } = buildDepthInput(views);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].heldByMachineIds.sort()).toEqual(['m1', 'm2']);
  });
});
