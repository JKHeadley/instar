/**
 * Trust states for verified pairing by invite link (docs/specs/a2a-pairing-invite-link.md §4.3–4.4).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';

const tm = () => new AgentTrustManager({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), 'invite-trust-')) });
const peer = () => {
  const key = crypto.randomBytes(32).toString('hex');
  return { key, fp: key.slice(0, 32) };
};

describe('invite trust states', () => {
  it('invite-accepted pins the key but is NOT credential-eligible', () => {
    const t = tm(); const p = peer();
    expect(t.recordInviteAccepted(p.fp, { peerIdentityPub: p.key, displayName: 'Scout' })).toBe(true);
    expect(t.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'invite-accepted', peerIdentityPub: p.key });
    expect(t.isCredentialShareAllowedByFingerprint(p.fp)).toBe(false);
  });

  it('markInviteVerified makes the pairing credential-eligible (source mutual-verified, level trusted)', () => {
    const t = tm(); const p = peer();
    t.recordInviteAccepted(p.fp, { peerIdentityPub: p.key });
    expect(t.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'finish' })).toBe(true);
    const prof = t.getProfileByFingerprint(p.fp)!;
    expect(prof).toMatchObject({ pairingState: 'mutual-verified', source: 'mutual-verified', level: 'trusted' });
    expect(t.isCredentialShareAllowedByFingerprint(p.fp)).toBe(true);
  });

  it('A side can verify a peer it never saw before (no prior profile)', () => {
    const t = tm(); const p = peer();
    expect(t.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'operator finish' })).toBe(true);
    expect(t.isCredentialShareAllowedByFingerprint(p.fp)).toBe(true);
  });

  it('never silently swaps a pinned key', () => {
    const t = tm(); const p = peer();
    t.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'x' });
    const imposter = p.fp + crypto.randomBytes(16).toString('hex'); // same fingerprint, different key tail
    expect(t.markInviteVerified(p.fp, { peerIdentityPub: imposter, via: 'x' })).toBe(false);
    expect(t.getProfileByFingerprint(p.fp)!.peerIdentityPub).toBe(p.key);
  });

  it('rejects a key whose fingerprint does not match, and a self-pair', () => {
    const t = tm(); const p = peer(); const q = peer();
    expect(t.recordInviteAccepted(p.fp, { peerIdentityPub: q.key })).toBe(false);
    expect(t.markInviteVerified(p.fp, { peerIdentityPub: q.key, via: 'x' })).toBe(false);
    expect(t.recordInviteAccepted(p.fp, { peerIdentityPub: p.key, ownFp: p.fp })).toBe(false);
  });

  it('recordInviteAccepted does not downgrade an existing verified pairing for the same key', () => {
    const t = tm(); const p = peer();
    t.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'x' });
    expect(t.recordInviteAccepted(p.fp, { peerIdentityPub: p.key })).toBe(true);
    expect(t.isCredentialShareAllowedByFingerprint(p.fp)).toBe(true);
  });

  it('demoteInvitePairing removes credential eligibility even after Finish, and revokes replicated copies', () => {
    const t = tm(); const p = peer();
    const replication = { emitVerified: vi.fn(), emitRevoke: vi.fn() };
    (t as unknown as { pairingReplication: unknown }).pairingReplication = replication;
    t.markInviteVerified(p.fp, { peerIdentityPub: p.key, via: 'finish' });
    expect(replication.emitVerified).toHaveBeenCalledTimes(1);
    expect(t.demoteInvitePairing(p.fp, 'second accept')).toBe(true);
    expect(t.getProfileByFingerprint(p.fp)).toMatchObject({ pairingState: 'invite-accepted' });
    // The credential-authorization bit itself is dropped, not just the state.
    expect(t.getProfileByFingerprint(p.fp)!.source).not.toBe('mutual-verified');
    expect(t.isCredentialShareAllowedByFingerprint(p.fp)).toBe(false);
    expect(replication.emitRevoke).toHaveBeenCalledWith(p.fp, expect.any(String), p.key); // step 5b: the revoke names the key
  });

  it('states persist across a reload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-trust-'));
    const p = peer();
    new AgentTrustManager({ stateDir: dir }).recordInviteAccepted(p.fp, { peerIdentityPub: p.key });
    expect(new AgentTrustManager({ stateDir: dir }).getProfileByFingerprint(p.fp)?.pairingState).toBe('invite-accepted');
  });
});
