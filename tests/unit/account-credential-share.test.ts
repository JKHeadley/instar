/**
 * Unit tests for the WS5.2 `account-credential-share` mesh verb + RBAC-gated handler
 * (AccountCredentialShare.ts) — spec R3a, §5.4, §6.5, §8.1/§8.2.
 *
 * Proves the RBAC gate runs BEFORE decrypt, single-use grants are consumed, the recipient
 * binding holds, and the legacy SecretShareHandler refuses credential-class data.
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  buildAccountCredentialShareCommand,
  AccountCredentialShareHandler,
  type AccountCredentialShareHandlerDeps,
  type AccountCredentialSharePeer,
} from '../../src/core/AccountCredentialShare.js';
import { SecretShareHandler } from '../../src/core/SecretSync.js';

function makeX25519(): { peer: AccountCredentialSharePeer; privateKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const raw = spki.subarray(spki.length - 32);
  return {
    peer: { machineId: 'mini', fingerprint: 'fp-mini', encryptionPublicKey: raw.toString('base64') },
    privateKey,
  };
}

const SECRET = { claudeAiOauth: 'opaque-token' };
const FUTURE = 4_000_000_000_000; // far-future expiry

function makeDeps(
  privateKey: crypto.KeyObject,
  over: Partial<AccountCredentialShareHandlerDeps> = {},
): AccountCredentialShareHandlerDeps {
  return {
    ownEncryptionPrivateKey: () => privateKey,
    currentRecipientFingerprint: () => 'fp-mini',
    currentPairingEpoch: () => 0,
    verifyMandate: () => ({ ok: true }),
    consumeGrant: () => ({ ok: true }),
    now: () => 1_000_000_000_000,
    ...over,
  };
}

function cmd(peer: AccountCredentialSharePeer, over: Record<string, unknown> = {}) {
  return buildAccountCredentialShareCommand({
    secrets: SECRET,
    recipient: peer,
    accountId: 'acct-1',
    mandateId: 'MND-1',
    grantId: 'grant-1',
    pairingEpoch: 0,
    expiresAt: FUTURE,
    ...over,
  });
}

describe('account-credential-share handler (WS5.2 R3a)', () => {
  it('accepts a well-formed, mandated, addressed share and decrypts it (writer unwired in PR1)', () => {
    const { peer, privateKey } = makeX25519();
    const h = new AccountCredentialShareHandler(makeDeps(privateKey));
    const r = h.handle(cmd(peer), 'laptop');
    expect(r.accepted).toBe(true);
    if (r.accepted) {
      expect(r.stored).toBe(false);
      expect(r.storeReason).toMatch(/PR1/);
      expect(r.accountId).toBe('acct-1');
    }
  });

  it('persists via the injected writer when wired', () => {
    const { peer, privateKey } = makeX25519();
    const store = vi.fn();
    const h = new AccountCredentialShareHandler(makeDeps(privateKey, { storeCredential: store }));
    const r = h.handle(cmd(peer), 'laptop');
    expect(r.accepted).toBe(true);
    expect(store).toHaveBeenCalledWith('acct-1', SECRET);
  });

  it('RBAC gate runs BEFORE decrypt: a denied mandate never reaches decryption', () => {
    const { peer, privateKey } = makeX25519();
    const decryptSpyKey = vi.fn(() => privateKey);
    const h = new AccountCredentialShareHandler(
      makeDeps(privateKey, {
        ownEncryptionPrivateKey: decryptSpyKey,
        verifyMandate: () => ({ ok: false, reason: 'no-mandate' }),
      }),
    );
    const r = h.handle(cmd(peer), 'laptop');
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toMatch(/mandate-denied:no-mandate/);
    // decrypt never attempted → private key never requested
    expect(decryptSpyKey).not.toHaveBeenCalled();
  });

  it('a consumed/replayed single-use grant is rejected (R3)', () => {
    const { peer, privateKey } = makeX25519();
    let used = false;
    const h = new AccountCredentialShareHandler(
      makeDeps(privateKey, {
        consumeGrant: () => (used ? { ok: false, reason: 'already-consumed' } : ((used = true), { ok: true })),
      }),
    );
    const c = cmd(peer);
    expect(h.handle(c, 'laptop').accepted).toBe(true);
    const replay = h.handle(c, 'laptop');
    expect(replay.accepted).toBe(false);
    if (!replay.accepted) expect(replay.reason).toMatch(/grant-rejected:already-consumed/);
  });

  it('rejects a share addressed to a different machine (recipient binding)', () => {
    const { peer, privateKey } = makeX25519();
    const h = new AccountCredentialShareHandler(
      makeDeps(privateKey, { currentRecipientFingerprint: () => 'fp-some-other-machine' }),
    );
    const r = h.handle(cmd(peer), 'laptop');
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe('recipient-mismatch');
  });

  it('rejects an expired share before any crypto work', () => {
    const { peer, privateKey } = makeX25519();
    const consume = vi.fn(() => ({ ok: true }));
    const h = new AccountCredentialShareHandler(
      makeDeps(privateKey, { now: () => FUTURE + 1, consumeGrant: consume }),
    );
    const r = h.handle(cmd(peer), 'laptop');
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe('expired');
    expect(consume).not.toHaveBeenCalled();
  });

  it('fails closed when the recipient key has rotated (epoch advanced past the seal)', () => {
    const { peer, privateKey } = makeX25519();
    // Sealed at epoch 0; recipient is now at epoch 1 → AAD mismatch → decrypt fails.
    const h = new AccountCredentialShareHandler(makeDeps(privateKey, { currentPairingEpoch: () => 1 }));
    const r = h.handle(cmd(peer, { pairingEpoch: 0 }), 'laptop');
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toMatch(/decrypt-failed/);
  });

  it('refuses a non-credential verb', () => {
    const { privateKey } = makeX25519();
    const h = new AccountCredentialShareHandler(makeDeps(privateKey));
    const r = h.handle({ type: 'secret-share' } as never, 'laptop');
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe('wrong-verb');
  });
});

describe('legacy SecretShareHandler refuses credential-class data (§6.5)', () => {
  it('throws when handed an account-credential-share command', () => {
    const { peer, privateKey } = makeX25519();
    const legacy = new SecretShareHandler({
      ownEncryptionPrivateKey: () => privateKey,
      store: { set: () => undefined },
    });
    const credCmd = cmd(peer);
    expect(() => legacy.handle(credCmd as never, 'laptop')).toThrow(/refuses non-secret-share|account-credential-share/);
  });
});
