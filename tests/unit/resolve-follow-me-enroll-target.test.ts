/**
 * Unit test — WS5.2 §5.3/S7 resolveFollowMeEnrollTarget: the operator-approved enrollment target
 * is resolved AUTHORITATIVELY from real pool state (local pool first, then peer views), and FAILS
 * CLOSED when no holder reports a usable email. The email must NEVER come from a request body.
 */

import { describe, it, expect } from 'vitest';
import { resolveFollowMeEnrollTarget } from '../../src/core/resolveFollowMeEnrollTarget.js';
import type { MachinePoolView } from '../../src/core/accountFollowMeDepth.js';

describe('resolveFollowMeEnrollTarget', () => {
  it('resolves from the LOCAL pool (most authoritative), carrying provider/framework/label', () => {
    const r = resolveFollowMeEnrollTarget({
      accountId: 'a1',
      localAccounts: [{ id: 'a1', email: 'approved@x.com', nickname: 'main', provider: 'anthropic', framework: 'claude-code' }],
      peerViews: [],
    });
    expect(r).toEqual({ resolved: true, expectedEmail: 'approved@x.com', provider: 'anthropic', framework: 'claude-code', label: 'main' });
  });

  it('resolves from a PEER view when the account is not held locally (replicated meta projection)', () => {
    const peerViews: MachinePoolView[] = [
      { machineId: 'mini', nickname: 'the Mini', accounts: [{ accountId: 'a1', email: 'approved@x.com', status: 'active', locallyHeld: false }] },
    ];
    const r = resolveFollowMeEnrollTarget({ accountId: 'a1', localAccounts: [], peerViews });
    expect(r).toMatchObject({ resolved: true, expectedEmail: 'approved@x.com', provider: 'anthropic', framework: 'claude-code', label: 'a1' });
  });

  it('prefers the local pool over a peer view (no override from a peer)', () => {
    const peerViews: MachinePoolView[] = [
      { machineId: 'mini', nickname: 'the Mini', accounts: [{ accountId: 'a1', email: 'peer@x.com', status: 'active', locallyHeld: false }] },
    ];
    const r = resolveFollowMeEnrollTarget({
      accountId: 'a1',
      localAccounts: [{ id: 'a1', email: 'local@x.com', nickname: 'main', provider: 'anthropic', framework: 'claude-code' }],
      peerViews,
    });
    expect(r).toMatchObject({ resolved: true, expectedEmail: 'local@x.com' });
  });

  it('FAILS CLOSED when no holder reports an email', () => {
    const peerViews: MachinePoolView[] = [
      { machineId: 'mini', nickname: 'the Mini', accounts: [{ accountId: 'a1', status: 'active', locallyHeld: false }] },
    ];
    const r = resolveFollowMeEnrollTarget({ accountId: 'a1', localAccounts: [{ id: 'a1' }], peerViews });
    expect(r).toEqual({ resolved: false, reason: 'cannot resolve approved account email' });
  });

  it('FAILS CLOSED for an unknown account', () => {
    const r = resolveFollowMeEnrollTarget({
      accountId: 'nope',
      localAccounts: [{ id: 'a1', email: 'approved@x.com' }],
      peerViews: [{ machineId: 'mini', nickname: 'm', accounts: [{ accountId: 'a1', email: 'approved@x.com', status: 'active', locallyHeld: false }] }],
    });
    expect(r.resolved).toBe(false);
  });

  it('treats a blank/whitespace email as unresolvable (fail-closed)', () => {
    const r = resolveFollowMeEnrollTarget({ accountId: 'a1', localAccounts: [{ id: 'a1', email: '   ' }], peerViews: [] });
    expect(r.resolved).toBe(false);
  });
});
