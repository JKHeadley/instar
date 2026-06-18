/**
 * buildFollowMeIssuePayload — the Approve-card → issue-for-machine payload builder
 * (ws52-operator-tap-not-text Part A). Pure; the operator never types the agent
 * fingerprints (they come from the held offer). Fail-closed on a missing offer or
 * a missing FD2 agent pair; {error} on a missing PIN.
 */
// @ts-nocheck — exercises the browser-native ESM dashboard module.
import { describe, it, expect } from 'vitest';
import { buildFollowMeIssuePayload } from '../../dashboard/subscriptions.js';

const mockCard = (accountId, targetMachineId) => ({
  getAttribute: (k) =>
    k === 'data-account-id' ? accountId : k === 'data-target-machine-id' ? targetMachineId : null,
});
const OFFERS = [
  { accountId: 'adriana', targetMachineId: 'm_4cbc', agents: ['fpA', 'fpB'] },
  { accountId: 'gmail', targetMachineId: 'm_xyz', agents: ['fpC', 'fpD'] },
];

describe('buildFollowMeIssuePayload', () => {
  it('builds the payload from the matched offer + PIN (agents from state, not the operator)', () => {
    const p = buildFollowMeIssuePayload(mockCard('adriana', 'm_4cbc'), OFFERS, '123456');
    expect(p).toEqual({ pin: '123456', accountId: 'adriana', targetMachineId: 'm_4cbc', agents: ['fpA', 'fpB'] });
  });

  it('{error:pin-required} when the PIN is empty/whitespace', () => {
    expect(buildFollowMeIssuePayload(mockCard('adriana', 'm_4cbc'), OFFERS, '   ')).toEqual({ error: 'pin-required' });
    expect(buildFollowMeIssuePayload(mockCard('adriana', 'm_4cbc'), OFFERS, undefined)).toEqual({ error: 'pin-required' });
  });

  it('null (fail-closed) when no offer matches the card', () => {
    expect(buildFollowMeIssuePayload(mockCard('unknown', 'm_4cbc'), OFFERS, '123456')).toBeNull();
  });

  it('null (fail-closed) when the matched offer lacks a valid FD2 agent pair', () => {
    const offers = [{ accountId: 'adriana', targetMachineId: 'm_4cbc', agents: ['only-one'] }];
    expect(buildFollowMeIssuePayload(mockCard('adriana', 'm_4cbc'), offers, '123456')).toBeNull();
    const offers2 = [{ accountId: 'adriana', targetMachineId: 'm_4cbc' }]; // no agents
    expect(buildFollowMeIssuePayload(mockCard('adriana', 'm_4cbc'), offers2, '123456')).toBeNull();
  });

  it('null on a bad card / missing ids', () => {
    expect(buildFollowMeIssuePayload(null, OFFERS, '123456')).toBeNull();
    expect(buildFollowMeIssuePayload(mockCard(null, null), OFFERS, '123456')).toBeNull();
  });
});
