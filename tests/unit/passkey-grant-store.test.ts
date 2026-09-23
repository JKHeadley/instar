import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PasskeyGrantStore, PASSKEY_GRANTS_FILE, PASSKEY_REVOKE_HWM_FILE } from '../../src/core/PasskeyGrantStore.js';

// Spec docs/specs/agent-held-google-passkey.md §3.2 / §6 — grants are local, per cell, sequenced;
// a revoke covers instances by sequence; the revoke high-water mark outlives a restore.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'passkey-grant-store.test cleanup' }); });
const mk = (now = Date.parse('2026-09-23T00:00:00Z')) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-grants-')); dirs.push(stateDir);
  return { stateDir, store: new PasskeyGrantStore({ stateDir, machineId: 'm_self', now: () => now }) };
};

describe('PasskeyGrantStore', () => {
  it('grants deny by default: an unknown cell has no grant; a grant is per (email × THIS machine), canonicalised, sequenced, 0600', () => {
    const { stateDir, store } = mk();
    expect(store.has('Justin@Example.com')).toBe(false);
    const a = store.grant({ email: ' Justin@Example.com ', grantedBy: 'uid:7812716706', origin: 'local-pin' });
    expect(a).toMatchObject({ created: true, grant: { canonicalEmail: 'justin@example.com', machineId: 'm_self', localSeq: 1, status: 'active', origin: 'local-pin' } });
    expect(store.has('justin@example.com')).toBe(true);
    expect(store.grant({ email: 'justin@example.com', grantedBy: 'someone-else', origin: 'local-pin' })).toMatchObject({ created: false, grant: { localSeq: 1, grantedBy: 'uid:7812716706' } });
    const b = store.grant({ email: 'other@example.com', grantedBy: 'uid:7812716706', origin: 'mandate' });
    expect(b.grant.localSeq).toBe(2);
    expect((fs.statSync(path.join(stateDir, PASSKEY_GRANTS_FILE)).mode & 0o777)).toBe(0o600);
    expect(() => store.grant({ email: '', grantedBy: 'x', origin: 'local-pin' })).toThrow('passkey-grant-email-required');
    expect(() => store.grant({ email: 'a@b.c', grantedBy: ' ', origin: 'local-pin' })).toThrow('passkey-grant-principal-required');
  });

  it('a revoke covers instances by SEQUENCE: a re-grant issued after the revoke was signed survives it', () => {
    const { store } = mk();
    const first = store.grant({ email: 'a@example.com', grantedBy: 'op', origin: 'local-pin' }).grant; // seq 1
    // Operator re-grants BEFORE the (old) revoke arrives: the revoke names seq 1 only.
    store.revoke({ email: 'a@example.com', revokedBy: 'op', nonce: 'n0', cutoffSeq: 1 });
    const second = store.grant({ email: 'a@example.com', grantedBy: 'op', origin: 'local-pin' }).grant; // seq 2
    expect(second.localSeq).toBe(2);
    const late = store.revoke({ email: 'a@example.com', revokedBy: 'op', nonce: 'n1', cutoffSeq: first.localSeq });
    expect(late).toMatchObject({ nothingToRevoke: true, covered: [] });
    expect(store.get('a@example.com')?.localSeq).toBe(2);
    // A revoke with an UNKNOWN cutoff covers everything present (restrictive).
    const all = store.revoke({ email: 'a@example.com', revokedBy: 'op', nonce: 'n2' });
    expect(all.covered.map((g) => g.localSeq)).toEqual([2]);
    expect(all.appliedCutoffSeq).toBe(2);
    expect(store.has('a@example.com')).toBe(false);
    expect(store.list().filter((g) => g.status === 'revoked').map((g) => g.revokeNonce)).toEqual(['n0', 'n2']);
  });

  it('the revoke high-water mark lives under secrets/passkeys (outside the backup manifest) and a restore cannot resurrect a revoked grant', () => {
    const { stateDir, store } = mk();
    store.grant({ email: 'a@example.com', grantedBy: 'op', origin: 'local-pin' }); // seq 1
    store.grant({ email: 'b@example.com', grantedBy: 'op', origin: 'local-pin' }); // seq 2
    store.revoke({ email: 'b@example.com', revokedBy: 'op', nonce: 'n' });
    expect(store.revokeHighWater()).toBe(2);
    expect(fs.existsSync(path.join(stateDir, PASSKEY_REVOKE_HWM_FILE))).toBe(true);
    // Simulate a restore of an OLDER backup that still holds b's grant at seq 2, plus a legit newer one at seq 3.
    const restored = store.admitRestoredGrants([
      { canonicalEmail: 'b@example.com', machineId: 'm_self', grantedBy: 'op', grantedAt: 'x', localSeq: 2, origin: 'local-pin', status: 'active' },
      { canonicalEmail: 'c@example.com', machineId: 'm_self', grantedBy: 'op', grantedAt: 'x', localSeq: 3, origin: 'local-pin', status: 'active' },
      { canonicalEmail: 'd@example.com', machineId: 'm_other', grantedBy: 'op', grantedAt: 'x', localSeq: 9, origin: 'local-pin', status: 'active' },
    ]);
    expect(restored.kept.map((g) => g.canonicalEmail)).toEqual(['c@example.com']);
    expect(restored.dropped.map((g) => g.canonicalEmail).sort()).toEqual(['b@example.com', 'd@example.com']);
    expect(store.has('b@example.com')).toBe(false);
    expect(store.get('c@example.com')).toMatchObject({ origin: 'restore', localSeq: 3 });
    // The sequence continues above the restored one.
    expect(store.grant({ email: 'e@example.com', grantedBy: 'op', origin: 'local-pin' }).grant.localSeq).toBe(4);
  });

  it('keeps a non-secret local copy of grants issued to peers and can forget them', () => {
    const { store } = mk();
    store.recordIssuedPeerGrant({ canonicalEmail: 'A@Example.com', targetMachineId: 'm_peer', issuedAt: 'x', nonce: 'n1' });
    store.recordIssuedPeerGrant({ canonicalEmail: 'a@example.com', targetMachineId: 'm_peer', issuedAt: 'y', nonce: 'n2', targetLocalSeq: 7, googleCreatedAt: '2026-09-23T00:00:00Z' });
    expect(store.listIssuedPeerGrants()).toEqual([{ canonicalEmail: 'a@example.com', targetMachineId: 'm_peer', issuedAt: 'y', nonce: 'n2', targetLocalSeq: 7, googleCreatedAt: '2026-09-23T00:00:00Z' }]);
    expect(store.forgetIssuedPeerGrant('a@example.com', 'm_peer')).toBe(true);
    expect(store.forgetIssuedPeerGrant('a@example.com', 'm_peer')).toBe(false);
  });

  it('a corrupt grants file FAILS CLOSED: no grant is readable and no write clobbers it', () => {
    const { stateDir, store } = mk();
    store.grant({ email: 'a@example.com', grantedBy: 'op', origin: 'local-pin' });
    fs.writeFileSync(path.join(stateDir, PASSKEY_GRANTS_FILE), '{not json');
    expect(() => store.has('a@example.com')).toThrow('passkey-grants-unreadable');
    expect(() => store.grant({ email: 'b@example.com', grantedBy: 'op', origin: 'local-pin' })).toThrow('passkey-grants-unreadable');
    expect(fs.readFileSync(path.join(stateDir, PASSKEY_GRANTS_FILE), 'utf8')).toBe('{not json');
  });
});
