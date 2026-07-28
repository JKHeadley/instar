/**
 * Unit tests — WS5.2 R4a ONE-DASHBOARD cross-machine mandate delivery (target side):
 *   - DeliveredMandateStore persistence (put/get/remove, idempotent by id, retains the portable
 *     bundle + the operator key + the authenticated deliverer).
 *   - acceptMandateDelivery: a valid R4a-signed mandate from the trusted operator key is accepted
 *     + persisted; a bad signature, a wrong operator key, a target-machine mismatch, a non-follow-me
 *     mandate, a feature-dark agent, and a missing operator key are all REFUSED (fail-closed) and
 *     NEVER persist.
 */

import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageMandateForDelivery } from '../../src/coordination/AccountFollowMeMandateBridge.js';
import { DeliveredMandateStore } from '../../src/coordination/DeliveredMandateStore.js';
import { acceptMandateDelivery } from '../../src/coordination/AccountFollowMeMandateDelivery.js';
import type { CoordinationMandate } from '../../src/coordination/types.js';

const OP_FP = 'm_operator_machine';
const THIS_MACHINE = 'm_target_machine';

function mandate(over: Partial<CoordinationMandate> = {}): CoordinationMandate {
  return {
    id: 'MND-deliver-1',
    scope: 'account-follow-me',
    agents: ['fp-op-agent', 'fp-target-agent'],
    authorities: [{ action: 'account-follow-me', bounds: { accountId: 'acct-1', targetMachineId: THIS_MACHINE, mechanism: 're-mint' } }],
    author: 'justin',
    createdAt: '2026-06-17T00:00:00Z',
    expiresAt: '2099-01-01T00:00:00Z',
    revoked: null,
    authProof: 'local-hmac-irrelevant-cross-machine',
    ...over,
  };
}

function pemOf(key: crypto.KeyObject): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

let dirs: string[] = [];
function freshStore(): DeliveredMandateStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-deliver-'));
  dirs.push(dir);
  return new DeliveredMandateStore({ filePath: path.join(dir, 'delivered-mandates.json') });
}

afterEach(() => {
  for (const d of dirs) { try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/account-follow-me-mandate-delivery.test.ts:cleanup' }); } catch { /* @silent-fallback-ok: best-effort temp-dir cleanup */ } }
  dirs = [];
});

describe('DeliveredMandateStore', () => {
  it('persists + reads back a delivered mandate by id (idempotent put)', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const store = freshStore();
    const portable = packageMandateForDelivery(mandate(), OP_FP, op.privateKey);
    store.put(portable, OP_FP, pemOf(op.publicKey));
    const rec = store.get('MND-deliver-1');
    expect(rec).toBeDefined();
    expect(rec!.deliveredBy).toBe(OP_FP);
    expect(rec!.operatorPublicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(rec!.portable.mandate.id).toBe('MND-deliver-1');
    // Re-put overwrites (idempotent by id) — never duplicates.
    store.put(portable, OP_FP, pemOf(op.publicKey));
    expect(store.list()).toHaveLength(1);
  });

  it('remove() drops a delivered mandate (idempotent)', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const store = freshStore();
    store.put(packageMandateForDelivery(mandate(), OP_FP, op.privateKey), OP_FP, pemOf(op.publicKey));
    store.remove('MND-deliver-1');
    expect(store.get('MND-deliver-1')).toBeUndefined();
    store.remove('MND-deliver-1'); // no throw
  });

  it('missing file → empty list (deny-by-default safe state)', () => {
    const store = new DeliveredMandateStore({ filePath: path.join(os.tmpdir(), 'does-not-exist-xyz', 'd.json') });
    expect(store.list()).toEqual([]);
    expect(store.get('any')).toBeUndefined();
  });
});

describe('acceptMandateDelivery (WS5.2 R4a target-side gate)', () => {
  function deps(store: DeliveredMandateStore, over: Partial<Parameters<typeof acceptMandateDelivery>[0]> = {}) {
    return {
      enabled: () => true,
      selfMachineId: () => THIS_MACHINE,
      operatorMachinePublicKey: (_s: string) => pemOf(crypto.generateKeyPairSync('ed25519').publicKey),
      store,
      ...over,
    };
  }

  it('ACCEPTS a valid R4a-signed mandate from the trusted operator key → persists it', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const store = freshStore();
    const portable = packageMandateForDelivery(mandate(), OP_FP, op.privateKey);
    const r = acceptMandateDelivery(deps(store, { operatorMachinePublicKey: () => pemOf(op.publicKey) }), OP_FP, portable);
    expect(r.accepted).toBe(true);
    if (r.accepted) expect(r.mandateId).toBe('MND-deliver-1');
    expect(store.get('MND-deliver-1')).toBeDefined();
  });

  it('REFUSES (fail-closed) when the feature is dark → persists nothing', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const store = freshStore();
    const portable = packageMandateForDelivery(mandate(), OP_FP, op.privateKey);
    const r = acceptMandateDelivery(deps(store, { enabled: () => false, operatorMachinePublicKey: () => pemOf(op.publicKey) }), OP_FP, portable);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe('feature-disabled');
    expect(store.list()).toHaveLength(0);
  });

  it('REFUSES when no operator key is registered (cannot ground the trust anchor)', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const store = freshStore();
    const portable = packageMandateForDelivery(mandate(), OP_FP, op.privateKey);
    const r = acceptMandateDelivery(deps(store, { operatorMachinePublicKey: () => null }), OP_FP, portable);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe('no-operator-key-registered');
    expect(store.list()).toHaveLength(0);
  });

  it('REFUSES a mandate signed by an UNTRUSTED key (bad signature against the registered key)', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const attacker = crypto.generateKeyPairSync('ed25519');
    const store = freshStore();
    // Signed by the attacker, but the registered operator key is op → signature verify fails.
    const portable = packageMandateForDelivery(mandate(), OP_FP, attacker.privateKey);
    const r = acceptMandateDelivery(deps(store, { operatorMachinePublicKey: () => pemOf(op.publicKey) }), OP_FP, portable);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toMatch(/issuance-verify-failed/);
    expect(store.list()).toHaveLength(0);
  });

  it('REFUSES when the authenticated sender ≠ the signed issuer fingerprint (issuer-not-trusted)', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const store = freshStore();
    // Mandate signed binding issuer fingerprint OP_FP, but it is delivered by a DIFFERENT sender.
    const portable = packageMandateForDelivery(mandate(), OP_FP, op.privateKey);
    const r = acceptMandateDelivery(deps(store, { operatorMachinePublicKey: () => pemOf(op.publicKey) }), 'm_other_machine', portable);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toMatch(/issuer-not-trusted/);
    expect(store.list()).toHaveLength(0);
  });

  it('REFUSES a mandate targeting a DIFFERENT machine (exact-bounds, cannot be replayed)', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const store = freshStore();
    const m = mandate({ authorities: [{ action: 'account-follow-me', bounds: { accountId: 'acct-1', targetMachineId: 'm_some_other_target', mechanism: 're-mint' } }] });
    const portable = packageMandateForDelivery(m, OP_FP, op.privateKey);
    const r = acceptMandateDelivery(deps(store, { operatorMachinePublicKey: () => pemOf(op.publicKey) }), OP_FP, portable);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe('target-not-this-machine');
    expect(store.list()).toHaveLength(0);
  });

  it('REFUSES a non-account-follow-me mandate', () => {
    const op = crypto.generateKeyPairSync('ed25519');
    const store = freshStore();
    const m = mandate({ authorities: [{ action: 'sign-code-review', bounds: { artifact: 'x' } }] });
    const portable = packageMandateForDelivery(m, OP_FP, op.privateKey);
    const r = acceptMandateDelivery(deps(store, { operatorMachinePublicKey: () => pemOf(op.publicKey) }), OP_FP, portable);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe('not-an-account-follow-me-mandate');
    expect(store.list()).toHaveLength(0);
  });

  it('REFUSES a malformed portable mandate (fail-closed)', () => {
    const store = freshStore();
    const r = acceptMandateDelivery(deps(store), OP_FP, null);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe('malformed-portable-mandate');
  });
});
