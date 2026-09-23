import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PasskeyGrantStore } from '../../src/core/PasskeyGrantStore.js';
import { PasskeyIssuerSet } from '../../src/core/PasskeyIssuerSet.js';
import { PasskeyNonceLedger } from '../../src/core/PasskeyNonceLedger.js';
import { mintPasskeyCellBody, signPasskeyCellMandate } from '../../src/core/PasskeyCellMandate.js';
import { applyLocalPasskeyCellAction, receivePasskeyCellMandate, sweepReceivedPasskeyRevokes, type PasskeyCellActionDeps } from '../../src/core/PasskeyCellActions.js';

// Spec docs/specs/agent-held-google-passkey.md §3.2 / §3.3 — the ONE apply funnel: nonce written
// (with the revoke cutoff) BEFORE acting, read-back before `applied`, duplicates honest, issuer
// bootstrap before the first multi-machine grant, unavailable ops named.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'passkey-cell-actions.test cleanup' }); });

function world(opts: { peers?: boolean } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-actions-')); dirs.push(stateDir);
  const op = crypto.generateKeyPairSync('ed25519');
  const grants = new PasskeyGrantStore({ stateDir, machineId: 'm_self' });
  const issuers = new PasskeyIssuerSet({ stateDir, selfMachineId: 'm_self', machineStatus: (id) => ['m_self', 'm_op', 'm_peer2'].includes(id) ? 'active' : 'missing' });
  const nonces = new PasskeyNonceLedger({ stateDir });
  const revertMethod = vi.fn(() => [{ reverted: true, to: 'password', bindingMissing: true }]);
  const onRevoked = vi.fn(async () => ({ changed: ['credential-removed'] }));
  const deps: PasskeyCellActionDeps = { selfMachineId: 'm_self', grants, issuers, nonces, revertMethod, onRevoked, hasActivePeers: () => opts.peers ?? false };
  const verify = { issuerPublicKeyPem: (id: string) => id === 'm_op' ? op.publicKey.export({ type: 'spki', format: 'pem' }).toString() : null };
  const mandate = (o: Parameters<typeof mintPasskeyCellBody>[0]) => signPasskeyCellMandate(mintPasskeyCellBody(o), 'm_op', op.privateKey);
  return { grants, issuers, nonces, deps, verify, mandate, revertMethod, onRevoked };
}

describe('passkey-cell actions — the apply funnel', () => {
  it('local PIN grant on a single-machine agent: applied, nonce received→applied, grant readable', async () => {
    const w = world();
    const body = mintPasskeyCellBody({ principal: 'uid:1', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant' });
    const r = await applyLocalPasskeyCellAction(w.deps, body);
    expect(r).toMatchObject({ applied: true, op: 'grant', result: { localSeq: 1, created: true, grantedBy: 'uid:1' } });
    expect(w.nonces.get(body.nonce)?.state).toBe('applied');
    expect(w.grants.has('a@example.com')).toBe(true);
    // Same nonce again ⇒ duplicate, no second instance.
    expect(await applyLocalPasskeyCellAction(w.deps, body)).toMatchObject({ applied: true, duplicate: true });
    expect(w.grants.list()).toHaveLength(1);
    // A local action addressed to another machine is refused.
    expect(await applyLocalPasskeyCellAction(w.deps, { ...body, nonce: 'x', targetMachineId: 'm_other' })).toMatchObject({ applied: false, reason: 'target-not-this-machine' });
  });

  it('FD21 issuer bootstrap: with active peers and NO confirmed peer issuer, the first grant is refused; confirming one peer unlocks it', async () => {
    const w = world({ peers: true });
    const grant = () => applyLocalPasskeyCellAction(w.deps, mintPasskeyCellBody({ principal: 'uid:1', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant' }));
    expect(await grant()).toMatchObject({ applied: false, reason: 'issuer-bootstrap-required' });
    expect(w.grants.has('a@example.com')).toBe(false);
    const add = await applyLocalPasskeyCellAction(w.deps, mintPasskeyCellBody({ principal: 'uid:1', canonicalEmail: '', targetMachineId: 'm_self', op: 'issuer-add', args: { machineId: 'm_op' } }));
    expect(add).toMatchObject({ applied: true, result: { machineId: 'm_op', added: true } });
    expect(w.issuers.peerIssuers().map((i) => [i.machineId, i.addedVia])).toEqual([['m_op', 'operator-confirmed']]);
    expect(await grant()).toMatchObject({ applied: true });
  });

  it('a VERIFIED peer mandate grants with origin=mandate; issuer-add via mandate records who added it; issuer-remove works; unavailable ops are named', async () => {
    const w = world();
    w.issuers.add({ machineId: 'm_op', addedVia: 'operator-confirmed' });
    const g = await receivePasskeyCellMandate({ ...w.deps, verify: w.verify }, w.mandate({ principal: 'uid:1', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'grant', args: { googleCreatedAt: '2026-09-23T00:00:00Z' } }));
    expect(g).toMatchObject({ applied: true, op: 'grant' });
    expect(w.grants.get('a@example.com')).toMatchObject({ origin: 'mandate', grantedBy: 'uid:1', googleCreatedAt: '2026-09-23T00:00:00Z' });
    const add = await receivePasskeyCellMandate({ ...w.deps, verify: w.verify }, w.mandate({ principal: 'uid:1', canonicalEmail: '', targetMachineId: 'm_self', op: 'issuer-add', args: { machineId: 'm_peer2' } }));
    expect(add).toMatchObject({ applied: true });
    expect(w.issuers.list().find((i) => i.machineId === 'm_peer2')).toMatchObject({ addedVia: 'issuer-add', addedByIssuer: 'm_op' });
    // issuer-add of a machine that is NOT active in THIS registry is refused for both origins.
    expect(await receivePasskeyCellMandate({ ...w.deps, verify: w.verify }, w.mandate({ principal: 'uid:1', canonicalEmail: '', targetMachineId: 'm_self', op: 'issuer-add', args: { machineId: 'm_unknown' } }))).toMatchObject({ applied: false, reason: 'machine-not-active' });
    expect(await applyLocalPasskeyCellAction(w.deps, mintPasskeyCellBody({ principal: 'p', canonicalEmail: '', targetMachineId: 'm_self', op: 'issuer-add', args: { machineId: 'm_unknown' } }))).toMatchObject({ applied: false, reason: 'machine-not-active' });
    expect(w.issuers.isListed('m_unknown')).toBe(false);
    const rm = await receivePasskeyCellMandate({ ...w.deps, verify: w.verify }, w.mandate({ principal: 'uid:1', canonicalEmail: '', targetMachineId: 'm_self', op: 'issuer-remove', args: { machineId: 'm_peer2' } }));
    expect(rm).toMatchObject({ applied: true, result: { removed: true } });
    const enroll = w.mandate({ principal: 'uid:1', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'enroll' });
    expect(await receivePasskeyCellMandate({ ...w.deps, verify: w.verify }, enroll)).toMatchObject({ applied: false, reason: 'op-not-available-on-this-build' });
    expect(w.nonces.get(enroll.body.nonce)?.state).toBe('received');
    // An unverified bundle never touches state.
    expect(await receivePasskeyCellMandate({ ...w.deps, verify: w.verify }, { body: {}, signature: {} })).toMatchObject({ applied: false, reason: 'not-a-passkey-cell-mandate' });
  });

  it('revoke: the cutoff is stored with the RECEIVED nonce before acting; the binding/credential hooks run; a replay of a received-but-unapplied revoke re-applies the STORED cutoff', async () => {
    const w = world();
    w.issuers.add({ machineId: 'm_op', addedVia: 'operator-confirmed' });
    w.grants.grant({ email: 'a@example.com', grantedBy: 'op', origin: 'local-pin' }); // seq 1
    const revoke = w.mandate({ principal: 'uid:1', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'revoke', args: { revokesGrantSeq: 1 } });
    const r = await receivePasskeyCellMandate({ ...w.deps, verify: w.verify }, revoke);
    expect(r).toMatchObject({ applied: true, op: 'revoke', result: { covered: [1], appliedCutoffSeq: 1, changed: ['credential-removed'], reverted: [{ reverted: true, to: 'password' }] } });
    expect(w.nonces.get(revoke.body.nonce)).toMatchObject({ state: 'applied', appliedCutoffSeq: 1 });
    expect(w.onRevoked).toHaveBeenCalledTimes(1);
    expect(w.grants.has('a@example.com')).toBe(false);
    // The operator re-grants (seq 2). A redelivery of the SAME signed revoke must NOT remove it.
    w.grants.grant({ email: 'a@example.com', grantedBy: 'op', origin: 'local-pin' });
    expect(await receivePasskeyCellMandate({ ...w.deps, verify: w.verify }, revoke)).toMatchObject({ applied: true, duplicate: true });
    expect(w.grants.get('a@example.com')?.localSeq).toBe(2);

    // Crash simulation: a revoke left RECEIVED (cutoff stored, never applied) is finished on replay with the stored cutoff.
    const w2 = world();
    w2.issuers.add({ machineId: 'm_op', addedVia: 'operator-confirmed' });
    w2.grants.grant({ email: 'b@example.com', grantedBy: 'op', origin: 'local-pin' }); // seq 1
    const rv = w2.mandate({ principal: 'uid:1', canonicalEmail: 'b@example.com', targetMachineId: 'm_self', op: 'revoke' });
    w2.nonces.receive({ nonce: rv.body.nonce, op: 'revoke', cellKey: 'b@example.com@m_self', issuerMachineId: 'm_op', expiresAt: rv.body.expiresAt, appliedCutoffSeq: 1 });
    w2.grants.grant({ email: 'c@example.com', grantedBy: 'op', origin: 'local-pin' }); // unrelated seq 2
    const again = await receivePasskeyCellMandate({ ...w2.deps, verify: w2.verify }, rv);
    expect(again).toMatchObject({ applied: true, duplicate: true, op: 'revoke', result: { covered: [1] } });
    expect(w2.nonces.get(rv.body.nonce)?.state).toBe('applied');
    expect(w2.grants.has('c@example.com')).toBe(true);
  });

  it('an UNKNOWN-cutoff revoke stores a CONCRETE cutoff with the received nonce: a crash after the write, a re-grant, then a redelivery never removes the new grant; the boot sweep finishes it', async () => {
    const w = world();
    w.issuers.add({ machineId: 'm_op', addedVia: 'operator-confirmed' });
    w.grants.grant({ email: 'a@example.com', grantedBy: 'op', origin: 'local-pin' }); // seq 1
    const rv = w.mandate({ principal: 'uid:1', canonicalEmail: 'a@example.com', targetMachineId: 'm_self', op: 'revoke' }); // no revokesGrantSeq
    // First delivery: the ledger write lands, then the revert hook throws (crash between write and read-back).
    w.revertMethod.mockImplementationOnce(() => { throw new Error('boom'); });
    await expect(receivePasskeyCellMandate({ ...w.deps, verify: w.verify }, rv)).rejects.toThrow('boom');
    expect(w.nonces.get(rv.body.nonce)).toMatchObject({ state: 'received', appliedCutoffSeq: 1 }); // CONCRETE, not null
    // The operator re-grants (seq 2) before the redelivery arrives.
    w.grants.grant({ email: 'a@example.com', grantedBy: 'op', origin: 'local-pin' });
    expect(w.grants.get('a@example.com')?.localSeq).toBe(2);
    // Redelivery of the SAME signed revoke re-applies the STORED cutoff (1): seq 2 survives.
    const again = await receivePasskeyCellMandate({ ...w.deps, verify: w.verify }, rv);
    expect(again).toMatchObject({ applied: true, duplicate: true, op: 'revoke' });
    expect(w.grants.get('a@example.com')?.localSeq).toBe(2);
    expect(w.nonces.get(rv.body.nonce)?.state).toBe('applied');

    // Boot sweep: a revoke left received (with its concrete cutoff) is finished without a redelivery.
    const w2 = world();
    w2.grants.grant({ email: 'b@example.com', grantedBy: 'op', origin: 'local-pin' }); // seq 1
    w2.nonces.receive({ nonce: 'left', op: 'revoke', cellKey: 'b@example.com@m_self', issuerMachineId: 'm_op', expiresAt: new Date().toISOString(), appliedCutoffSeq: 1 });
    w2.grants.grant({ email: 'c@example.com', grantedBy: 'op', origin: 'local-pin' }); // seq 2, unrelated
    expect(await sweepReceivedPasskeyRevokes(w2.deps)).toEqual({ finished: ['left'] });
    expect(w2.grants.has('b@example.com')).toBe(false);
    expect(w2.grants.has('c@example.com')).toBe(true);
    expect(w2.nonces.get('left')?.state).toBe('applied');
    expect(await sweepReceivedPasskeyRevokes(w2.deps)).toEqual({ finished: [] });
  });
});
