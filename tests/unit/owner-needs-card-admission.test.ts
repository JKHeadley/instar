import { describe, expect, it, vi } from 'vitest';
import { admitOwnerNeedsCard, ownerNeedsPresentation, type OwnerNeedsCandidate } from '../../src/core/OwnerNeedsCardAdmission.js';

const approval = { kind: 'approval', requestId: 'approval-1' };
const credential = { kind: 'credential', requestId: 'secret-1' };
const owner: OwnerNeedsCandidate = { responsibility: 'owner-required', ownerAction: 'approve', actions: [approval], handoffs: [] };

describe('Owner Needs-you card admission', () => {
  it.each([approval, { kind: 'approval-batch', disclosureId: 'completion-1' }, credential])('admits exactly one in-place action of kind $kind', action => {
    const verifiesCurrentOwnerRequest = vi.fn(() => true);
    const ownerAction = action.kind === 'credential' ? 'credential' : 'approve';
    expect(admitOwnerNeedsCard({ ...owner, ownerAction, actions: [action], verifiesCurrentOwnerRequest })).toEqual({ disposition: 'show', ownerAction, action });
    expect(verifiesCurrentOwnerRequest).toHaveBeenCalledWith(action);
  });

  it('holds an action when its owner or current request cannot be verified', () => {
    expect(admitOwnerNeedsCard(owner)).toEqual({ disposition: 'hold', reason: 'request-unavailable' });
    const verify = vi.fn(() => true);
    const candidate = { ...owner, verifiesCurrentOwnerRequest: verify };
    expect(admitOwnerNeedsCard(candidate)).toEqual({ disposition: 'show', ownerAction: 'approve', action: approval });
    verify.mockReturnValueOnce(false).mockImplementationOnce(() => { throw new Error('source unavailable'); });
    expect(admitOwnerNeedsCard(candidate)).toEqual({ disposition: 'hold', reason: 'request-unavailable' });
    expect(admitOwnerNeedsCard(candidate)).toEqual({ disposition: 'hold', reason: 'source-unavailable' });
  });

  it('accepts only reviewed templates of the matching action class', () => {
    expect(ownerNeedsPresentation('trust-change', 'approval')?.title).toBe('Review a trust change');
    expect(ownerNeedsPresentation('trust-change', 'credential')).toBeNull();
    expect(ownerNeedsPresentation('constructor', 'approval')).toBeNull();
    expect(ownerNeedsPresentation({ title: 'Review', why: 'Open the dashboard to approve it.' }, 'approval')).toBeNull();
  });

  it('renders the reviewed phone update template in place', () => {
    expect(admitOwnerNeedsCard({ ...owner, ownerAction: 'physical', actions: [{ kind: 'instructions', template: 'update-instar-phone' }] }))
      .toEqual({ disposition: 'show', ownerAction: 'physical', action: { kind: 'instructions', steps: [
        'Open TestFlight on your iPhone and select Instar.',
        'Tap Update if TestFlight offers an update. If you see Open, you already have the latest version available to you.',
        'Open Instar again.',
      ] } });
  });

  it.each([undefined, 'physical', 'credential'] as const)('holds an approval with a missing or mismatched declaration (%s)', ownerAction => {
    expect(admitOwnerNeedsCard({ ...owner, ownerAction, verifiesCurrentOwnerRequest: () => true }))
      .toEqual({ disposition: 'hold', reason: 'invalid-action' });
  });

  it('routes agent-owned work to the agent even if it has a plausible approval action', () => {
    expect(admitOwnerNeedsCard({ ...owner, responsibility: 'agent' })).toEqual({ disposition: 'route-to-agent' });
  });

  it('holds an unverified owner dependency', () => {
    expect(admitOwnerNeedsCard({ ...owner, responsibility: 'unknown' }))
      .toEqual({ disposition: 'hold', reason: 'owner-dependency-unknown' });
  });

  it('holds a dashboard handoff even alongside a legitimate action', () => {
    expect(admitOwnerNeedsCard({ ...owner, handoffs: ['#/capacity/accounts'] }))
      .toEqual({ disposition: 'hold', reason: 'handoff' });
  });

  it.each([[], [approval, credential]])('requires exactly one action', (...actions) => {
    expect(admitOwnerNeedsCard({ ...owner, actions }))
      .toEqual({ disposition: 'hold', reason: 'action-required' });
  });

  it.each([
    { kind: 'href', href: '/dashboard' },
    { ...approval, href: '/dashboard' },
    { kind: 'instructions', steps: ['Open the dashboard to finish.'] },
    { kind: 'instructions', steps: ['Go to https://example.test.'] },
    { kind: 'instructions', steps: [] },
    { kind: 'instructions', steps: ['Open Instar again.'] },
    { kind: 'instructions', template: 'update-instar-phone', params: { app: 'Run this command.' } },
    { kind: 'instructions', template: 'unreviewed-template' },
  ])('rejects unsupported or externally routed actions', action => {
    expect(admitOwnerNeedsCard({ ...owner, actions: [action] }))
      .toEqual({ disposition: 'hold', reason: 'invalid-action' });
  });
});
