import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PasskeyIssuerSet, type IssuerMachineStatus } from '../../src/core/PasskeyIssuerSet.js';
import { PasskeyNonceLedger } from '../../src/core/PasskeyNonceLedger.js';
import { PASSKEY_MANDATE_SKEW_MS, PASSKEY_MANDATE_TTL_MS, mintPasskeyCellBody, signPasskeyCellMandate, verifyPasskeyCellMandate, canonicalPasskeyCellBody } from '../../src/core/PasskeyCellMandate.js';
import { acceptDeliveredMandate, packageMandateForDelivery } from '../../src/coordination/AccountFollowMeMandateBridge.js';
import { acceptMandateDelivery } from '../../src/coordination/AccountFollowMeMandateDelivery.js';
import type { CoordinationMandate } from '../../src/coordination/types.js';

// Spec docs/specs/agent-held-google-passkey.md §3.3 / FD12 — signing + acceptance: expected-issuer
// set (no TOFU), signature bound to the issuer fingerprint, target == self, 15-minute expiry with
// ±2-minute skew (revoke exempt), nonce ledger (replay), and ISOLATION BOTH WAYS from account-follow-me.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'passkey-cell-mandate.test cleanup' }); });
const T0 = Date.parse('2026-09-23T00:00:00Z');

function world(status: Record<string, IssuerMachineStatus> = { m_op: 'active', m_self: 'active' }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-mandate-')); dirs.push(stateDir);
  const keys: Record<string, crypto.KeyPairKeyObjectResult> = { m_op: crypto.generateKeyPairSync('ed25519'), m_rogue: crypto.generateKeyPairSync('ed25519') };
  let now = T0;
  const issuers = new PasskeyIssuerSet({ stateDir, selfMachineId: 'm_self', machineStatus: (id) => status[id] ?? 'missing' });
  const nonces = new PasskeyNonceLedger({ stateDir, now: () => now });
  const deps = {
    selfMachineId: 'm_self',
    issuerPublicKeyPem: (id: string) => keys[id] ? keys[id].publicKey.export({ type: 'spki', format: 'pem' }).toString() : null,
    issuers, nonces, now: () => now,
  };
  return { keys, issuers, nonces, deps, tick: (ms: number) => { now += ms; }, now: () => now };
}

describe('passkey-cell mandate — sign + verify', () => {
  it('a mandate from a CONFIRMED issuer, addressed to this machine, fresh and unseen, verifies; every field is covered by the signature', () => {
    const w = world();
    w.issuers.add({ machineId: 'm_op', addedVia: 'operator-confirmed' });
    const body = mintPasskeyCellBody({ principal: 'uid:1', canonicalEmail: 'A@Example.com', targetMachineId: 'm_self', op: 'grant', now: w.now() });
    expect(body.canonicalEmail).toBe('a@example.com');
    const portable = signPasskeyCellMandate(body, 'm_op', w.keys.m_op.privateKey);
    expect(verifyPasskeyCellMandate(portable, w.deps)).toMatchObject({ ok: true, issuerMachineId: 'm_op' });
    // Tamper with ANY field ⇒ bad signature.
    for (const patch of [{ op: 'revoke' }, { canonicalEmail: 'b@example.com' }, { targetMachineId: 'm_self' + '' , args: { x: 1 } }, { principal: 'uid:2' }, { nonce: 'other' }]) {
      const tampered = { ...portable, body: { ...portable.body, ...patch } };
      expect(verifyPasskeyCellMandate(tampered, w.deps)).toMatchObject({ ok: false, reason: 'bad-signature' });
    }
    // Canonical form is key-order independent.
    const reordered = JSON.parse(JSON.stringify(body, Object.keys(body).sort().reverse()));
    expect(canonicalPasskeyCellBody(reordered)).toBe(canonicalPasskeyCellBody(body));
  });

  it('refuses: an unlisted issuer (no TOFU) even with a valid key, a listed issuer signing with the WRONG key, a mis-targeted mandate, and a signer with no registered key', () => {
    const w = world({ m_op: 'active', m_rogue: 'active', m_self: 'active' });
    const body = mintPasskeyCellBody({ principal: 'uid:1', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant', now: w.now() });
    expect(verifyPasskeyCellMandate(signPasskeyCellMandate(body, 'm_op', w.keys.m_op.privateKey), w.deps)).toMatchObject({ ok: false, reason: 'issuer-not-trusted', issuerVerdict: { reason: 'not-an-issuer' } });
    w.issuers.add({ machineId: 'm_op', addedVia: 'operator-confirmed' });
    // A rogue machine claiming to be m_op but signing with its own key.
    expect(verifyPasskeyCellMandate(signPasskeyCellMandate(body, 'm_op', w.keys.m_rogue.privateKey), w.deps)).toMatchObject({ ok: false, reason: 'bad-signature' });
    // A listed issuer with no key in THIS machine's registry.
    w.issuers.add({ machineId: 'm_nokey', addedVia: 'operator-confirmed' });
    (w.deps as { issuerPublicKeyPem: (id: string) => string | null }).issuerPublicKeyPem = (id) => id === 'm_op' ? w.keys.m_op.publicKey.export({ type: 'spki', format: 'pem' }).toString() : null;
    const status = { m_nokey: 'active' as const };
    void status;
    const other = signPasskeyCellMandate({ ...body, targetMachineId: 'm_other' }, 'm_op', w.keys.m_op.privateKey);
    expect(verifyPasskeyCellMandate(other, w.deps)).toMatchObject({ ok: false, reason: 'target-not-this-machine' });
  });

  it('a revoked issuer is refused AND dropped from the set; a pending one is refused but kept', () => {
    const status: Record<string, IssuerMachineStatus> = { m_op: 'active', m_self: 'active' };
    const w = world(status);
    w.issuers.add({ machineId: 'm_op', addedVia: 'operator-confirmed' });
    const portable = signPasskeyCellMandate(mintPasskeyCellBody({ principal: 'p', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant', now: w.now() }), 'm_op', w.keys.m_op.privateKey);
    status.m_op = 'pending';
    expect(verifyPasskeyCellMandate(portable, w.deps)).toMatchObject({ ok: false, reason: 'issuer-not-trusted', issuerVerdict: { reason: 'issuer-pending' } });
    expect(w.issuers.isListed('m_op')).toBe(true);
    status.m_op = 'revoked';
    expect(verifyPasskeyCellMandate(portable, w.deps)).toMatchObject({ ok: false, reason: 'issuer-not-trusted', issuerVerdict: { reason: 'issuer-revoked', removed: true } });
    expect(w.issuers.isListed('m_op')).toBe(false);
  });

  it('expiry: 15 minutes ±2 minutes skew for every op EXCEPT revoke; not-yet-valid beyond the skew', () => {
    const w = world();
    w.issuers.add({ machineId: 'm_op', addedVia: 'operator-confirmed' });
    const grant = signPasskeyCellMandate(mintPasskeyCellBody({ principal: 'p', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant', now: w.now() }), 'm_op', w.keys.m_op.privateKey);
    const revoke = signPasskeyCellMandate(mintPasskeyCellBody({ principal: 'p', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'revoke', now: w.now() }), 'm_op', w.keys.m_op.privateKey);
    w.tick(PASSKEY_MANDATE_TTL_MS + PASSKEY_MANDATE_SKEW_MS - 1);
    expect(verifyPasskeyCellMandate(grant, w.deps).ok).toBe(true);
    w.tick(2);
    expect(verifyPasskeyCellMandate(grant, w.deps)).toMatchObject({ ok: false, reason: 'expired' });
    w.tick(20 * 24 * 60 * 60_000); // 20 days later the SAME signed revoke still verifies
    expect(verifyPasskeyCellMandate(revoke, w.deps).ok).toBe(true);
    // An issuer cannot stretch expiresAt: a year-long grant mandate is refused.
    const stretched = signPasskeyCellMandate(mintPasskeyCellBody({ principal: 'p', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant', now: w.now(), ttlMs: 365 * 24 * 60 * 60_000 }), 'm_op', w.keys.m_op.privateKey);
    expect(verifyPasskeyCellMandate(stretched, w.deps)).toMatchObject({ ok: false, reason: 'ttl-too-long' });
    // Issued in the future beyond skew ⇒ not yet valid.
    const future = signPasskeyCellMandate(mintPasskeyCellBody({ principal: 'p', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant', now: w.now() + PASSKEY_MANDATE_SKEW_MS + 1000 }), 'm_op', w.keys.m_op.privateKey);
    expect(verifyPasskeyCellMandate(future, w.deps)).toMatchObject({ ok: false, reason: 'not-yet-valid' });
  });

  it('replay: a nonce already in the ledger (or the nonce a re-signed copy replaces) is refused with the original nonce named', () => {
    const w = world();
    w.issuers.add({ machineId: 'm_op', addedVia: 'operator-confirmed' });
    const body = mintPasskeyCellBody({ principal: 'p', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant', now: w.now() });
    const portable = signPasskeyCellMandate(body, 'm_op', w.keys.m_op.privateKey);
    expect(verifyPasskeyCellMandate(portable, w.deps).ok).toBe(true);
    w.nonces.receive({ nonce: body.nonce, op: 'grant', cellKey: 'a@example.com@m_self', issuerMachineId: 'm_op', expiresAt: body.expiresAt });
    expect(verifyPasskeyCellMandate(portable, w.deps)).toMatchObject({ ok: false, reason: 'replay', replayOf: body.nonce });
    const resigned = signPasskeyCellMandate({ ...mintPasskeyCellBody({ principal: 'p', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant', now: w.now() }), replacesNonce: body.nonce }, 'm_op', w.keys.m_op.privateKey);
    expect(verifyPasskeyCellMandate(resigned, w.deps)).toMatchObject({ ok: false, reason: 'replay', replayOf: body.nonce });
  });

  it('ISOLATION both ways: a follow-me bundle is not a passkey-cell mandate, and a passkey-cell bundle is refused by the follow-me acceptors — even under the SAME issuer key', () => {
    const w = world();
    w.issuers.add({ machineId: 'm_op', addedVia: 'operator-confirmed' });
    const opPub = w.keys.m_op.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    // (1) follow-me → passkey receiver
    const fm: CoordinationMandate = { id: 'mand-1', scope: 'account-follow-me', agents: ['a', 'b'], author: 'justin', issuedAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + 3_600_000).toISOString(),
      authorities: [{ action: 'account-follow-me', bounds: { accountId: 'acct', targetMachineId: 'm_self', mechanism: 're-mint' } }], revoked: false } as unknown as CoordinationMandate;
    const fmPortable = packageMandateForDelivery(fm, 'm_op', w.keys.m_op.privateKey);
    expect(verifyPasskeyCellMandate(fmPortable, w.deps)).toMatchObject({ ok: false, reason: 'malformed' });
    // A follow-me bundle re-shaped to LOOK like a passkey body but signed with the follow-me domain tag.
    const disguised = { body: { ...mintPasskeyCellBody({ principal: 'p', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant', now: w.now() }) }, signature: { alg: 'ed25519', issuerFingerprint: 'm_op', sig: fmPortable.issuanceSignature.sig } };
    expect(verifyPasskeyCellMandate(disguised, w.deps)).toMatchObject({ ok: false, reason: 'bad-signature' });
    // (2) passkey-cell → follow-me acceptors
    const pk = signPasskeyCellMandate(mintPasskeyCellBody({ principal: 'p', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant', now: w.now() }), 'm_op', w.keys.m_op.privateKey);
    expect(acceptDeliveredMandate({ portable: pk as never, operatorEd25519PublicKey: opPub, expectedOperatorMachineFingerprint: 'm_op' })).toMatchObject({ accepted: false, reason: 'malformed-portable-mandate' });
    // Even a passkey body smuggled INTO a follow-me envelope shape fails the follow-me signature AND has no follow-me authority.
    const smuggled = { mandate: { ...fm, authorities: [] , passkey: pk.body } as unknown as CoordinationMandate, issuanceSignature: { alg: 'ed25519' as const, issuerFingerprint: 'm_op', sig: pk.signature.sig } };
    const store = { put: () => { throw new Error('must not persist'); } } as never;
    expect(acceptMandateDelivery({ enabled: () => true, selfMachineId: () => 'm_self', operatorMachinePublicKey: () => opPub, store }, 'm_op', smuggled)).toMatchObject({ accepted: false });
  });
});
