import { expect, it, vi } from 'vitest';
import { createPairedCoordinationPolicy, pairedCoordinationGrantDigest } from '../../src/threadline/pairedCoordinationPolicy.js';

const key = 'a'.repeat(32) + 'b'.repeat(32);
const fp = key.slice(0, 32);
const recipient = { fingerprint: fp, authenticatedKeyHex: key };
const action = { coordinationId: 'handoff-1', messageDigest: 'e'.repeat(64) };
const sender = { operatorId: 'operator-1', ownerRevision: 'revision-1' };

function fixture() {
  const change = { ...sender, expectedRevision: 0, action: 'allow' as const };
  const scope = 'threadline.own-paired-agents.work-coordination.v1' as const;
  const state = {
    sender, blocked: false, work: { ...action, recipientKeyHex: key },
    peer: { ...sender, authenticatedKeyHex: key, pairedKeyHex: key, pairingState: 'mutual-verified' as const },
    grant: { ...sender, scope, revision: 1, state: 'allowed' as 'allowed' | 'revoked' },
  };
  const readRecipient = vi.fn(() => state);
  const readPinApproval = vi.fn((authorizationId: string) => authorizationId === 'pin-approval-1' ? {
    authorizationId, operatorId: sender.operatorId, requestDigest: pairedCoordinationGrantDigest(change),
  } : null);
  const commitGrantChange = vi.fn(() => true);
  const deps = { readRecipient, readPinApproval, commitGrantChange };
  return { policy: createPairedCoordinationPolicy({ ...deps, enabled: true }), deps, state, change };
}

it('is off by default and accepts only an exact authenticated recipient with an active grant', () => {
  const f = fixture();
  expect(createPairedCoordinationPolicy(f.deps).admitsWorkCoordination(recipient, action)).toBe(false);
  expect(f.policy.admitsWorkCoordination({ ...recipient, fingerprint: 'Luna' }, action)).toBe(false);
  expect(f.policy.admitsWorkCoordination({ ...recipient, fingerprint: fp.slice(0, 16) }, action)).toBe(false);
  expect(f.deps.readRecipient).not.toHaveBeenCalled();
  expect(f.policy.admitsWorkCoordination(recipient, action)).toBe(true);
  expect(f.policy.admitsWorkCoordination({ ...recipient, authenticatedKeyHex: fp + 'd'.repeat(32) }, action)).toBe(false);
  expect(f.policy.admitsWorkCoordination(recipient, { ...action, messageDigest: 'f'.repeat(64) })).toBe(false);
  f.state.peer.pairedKeyHex = fp + 'c'.repeat(32);
  expect(f.policy.admitsWorkCoordination(recipient, action)).toBe(false);
});

it('checks current membership, explicit blocks, and revocation for each send', () => {
  const f = fixture();
  f.state.peer.operatorId = 'other-operator';
  expect(f.policy.admitsWorkCoordination(recipient, action)).toBe(false);
  f.state.peer.operatorId = sender.operatorId;
  f.state.blocked = true;
  expect(f.policy.admitsWorkCoordination(recipient, action)).toBe(false);
  f.state.blocked = false;
  f.state.grant.state = 'revoked';
  expect(f.policy.admitsWorkCoordination(recipient, action)).toBe(false);
});

it('binds a PIN authorization to one exact grant change and leaves consumption to the serialized writer', () => {
  const f = fixture();
  expect(f.policy.changeGrant(f.change, 'caller-says-yes')).toBe(false);
  expect(f.policy.changeGrant({ ...f.change, expectedRevision: 1 }, 'pin-approval-1')).toBe(false);
  expect(f.policy.changeGrant({ ...f.change, action: 'revoke' }, 'pin-approval-1')).toBe(false);
  expect(f.deps.commitGrantChange).not.toHaveBeenCalled();
  expect(f.policy.changeGrant(f.change, 'pin-approval-1')).toBe(true);
  expect(f.deps.commitGrantChange).toHaveBeenCalledOnce();
});
