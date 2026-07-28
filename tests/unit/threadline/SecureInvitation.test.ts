import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SecureInvitationManager } from '../../../src/threadline/SecureInvitation.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

describe('SecureInvitation', () => {
  let tmpDir: string;
  let mgr: SecureInvitationManager;
  let issuer: { publicKey: Buffer; privateKey: Buffer; fingerprint: string };
  let redeemer: { publicKey: Buffer; privateKey: Buffer; fingerprint: string };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-test-'));
    mgr = new SecureInvitationManager(tmpDir);

    const issuerKp = generateIdentityKeyPair();
    issuer = { ...issuerKp, fingerprint: computeFingerprint(issuerKp.publicKey) };

    const redeemerKp = generateIdentityKeyPair();
    redeemer = { ...redeemerKp, fingerprint: computeFingerprint(redeemerKp.publicKey) };
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/threadline/SecureInvitation.test.ts:28' });
  });

  describe('create', () => {
    it('creates a valid signed token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      expect(token.version).toBe(1);
      expect(token.type).toBe('invitation');
      expect(token.issuer).toBe(issuer.fingerprint);
      expect(token.scope).toBe('verified');
      expect(token.maxUses).toBe(1);
      expect(token.signature).toBeDefined();
      expect(token.tokenId.length).toBeGreaterThan(0);
      expect(token.nonce.length).toBe(64); // 32 bytes hex
    });

    it('creates recipient-bound token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, {
        recipient: redeemer.fingerprint,
      });
      expect(token.recipient).toBe(redeemer.fingerprint);
    });
  });

  describe('validate', () => {
    it('validates a correct token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(true);
    });

    it('rejects token signed with wrong key', () => {
      const otherKp = generateIdentityKeyPair();
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      const result = mgr.validate(token, otherKp.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid signature');
    });

    it('rejects expired token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, { expiryMs: -1000 });
      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('expired');
    });

    it('rejects already-redeemed token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      mgr.validate(token, issuer.publicKey, redeemer.fingerprint, true); // redeem
      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('already redeemed');
    });

    it('rejects wrong recipient for bound token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, {
        recipient: 'specific-agent',
      });
      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('different recipient');
    });

    it('accepts correct recipient for bound token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, {
        recipient: redeemer.fingerprint,
      });
      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(true);
    });

    it('rejects tampered token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      const tampered = { ...token, nonce: 'tampered'.padEnd(64, '0') };
      const result = mgr.validate(tampered, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
    });
  });

  describe('revoke', () => {
    it('revokes an unredeemed token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      expect(mgr.revoke(token.tokenId)).toBe(true);

      const result = mgr.validate(token, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('revoked');
    });

    it('cannot revoke already-redeemed token', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      mgr.validate(token, issuer.publicKey, redeemer.fingerprint, true);
      expect(mgr.revoke(token.tokenId)).toBe(false);
    });
  });

  describe('persistence', () => {
    it('redemptions survive restart', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      mgr.validate(token, issuer.publicKey, redeemer.fingerprint, true);

      const mgr2 = new SecureInvitationManager(tmpDir);
      expect(mgr2.isRedeemed(token.tokenId)).toBe(true);
    });
  });

  describe('R1b — endpoint+cert pinning (sealed handoff)', () => {
    const HOST = 'echo.dawn-tunnel.dev/secrets/submit/abc';
    const CERTFP = 'aabbccddeeff'.padEnd(64, '0');

    it('carries submitHost + submitCertFingerprint and validates', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, {
        recipient: redeemer.fingerprint,
        submitHost: HOST,
        submitCertFingerprint: CERTFP,
      });
      expect(token.submitHost).toBe(HOST);
      expect(token.submitCertFingerprint).toBe(CERTFP);
      expect(mgr.validate(token, issuer.publicKey, redeemer.fingerprint).valid).toBe(true);
    });

    it('rejects a tampered submitHost (relay-swapped collector)', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, {
        submitHost: HOST, submitCertFingerprint: CERTFP,
      });
      const tampered = { ...token, submitHost: 'evil.attacker.example/collect' };
      const result = mgr.validate(tampered, issuer.publicKey, redeemer.fingerprint);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('Invalid signature');
    });

    it('rejects a tampered submitCertFingerprint', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, {
        submitHost: HOST, submitCertFingerprint: CERTFP,
      });
      const tampered = { ...token, submitCertFingerprint: 'ff'.padEnd(64, '0') };
      expect(mgr.validate(tampered, issuer.publicKey, redeemer.fingerprint).valid).toBe(false);
    });

    it('rejects stripping the pinned fields (downgrade to a plain invitation)', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey, {
        submitHost: HOST, submitCertFingerprint: CERTFP,
      });
      const stripped = { ...token };
      delete stripped.submitHost;
      delete stripped.submitCertFingerprint;
      expect(mgr.validate(stripped, issuer.publicKey, redeemer.fingerprint).valid).toBe(false);
    });

    it('rejects injecting a submit host into a plain invitation', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      const injected = { ...token, submitHost: 'evil.attacker.example/collect' };
      expect(mgr.validate(injected, issuer.publicKey, redeemer.fingerprint).valid).toBe(false);
    });

    it('backward-compat: a token without submit fields still validates', () => {
      const token = mgr.create(issuer.fingerprint, issuer.privateKey);
      expect(token.submitHost).toBeUndefined();
      expect(mgr.validate(token, issuer.publicKey, redeemer.fingerprint).valid).toBe(true);
    });
  });
});
