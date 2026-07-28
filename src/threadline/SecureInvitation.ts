/**
 * SecureInvitation — Ed25519-bound invitation tokens.
 *
 * Spec Section 3.11: Challenge-bound invitation tokens that are:
 * - Cryptographically signed by the issuer's Ed25519 key
 * - Single-use (invalidated after redemption)
 * - Optionally bound to a specific recipient fingerprint
 * - Nonce-protected against replay
 * - Short-lived (default 1h, max 24h)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sign, verify } from './ThreadlineCrypto.js';

// ── Types ────────────────────────────────────────────────────────────

export interface InvitationToken {
  version: 1;
  type: 'invitation';
  issuer: string;             // issuer fingerprint
  tokenId: string;            // 32-byte CSPRNG, base64url
  nonce: string;              // 32-byte random, hex
  scope: 'verified';          // accepted agents start at verified
  expiry: string;             // ISO-8601, max 24h from creation
  maxUses: number;            // 1 = single-use (default)
  recipient?: string;         // optional: intended recipient fingerprint
  // Sealed-handoff endpoint pinning (R1b): when present, the sender validates the
  // secret-submit destination against these signed values before POSTing — so a
  // relay-swapped collector URL fails the check. Both are covered by the signature.
  submitHost?: string;             // host (+optional path) the secret is POSTed to
  submitCertFingerprint?: string;  // TLS cert fingerprint of submitHost, hex
  signature: string;          // Ed25519 signature over all fields above, base64
}

export interface Redemption {
  tokenId: string;
  redeemedBy: string;         // fingerprint of the agent that redeemed
  redeemedAt: string;         // ISO-8601
}

// ── Constants ────────────────────────────────────────────────────────

const MAX_EXPIRY_MS = 24 * 60 * 60 * 1000;  // 24 hours
const DEFAULT_EXPIRY_MS = 60 * 60 * 1000;    // 1 hour

// ── Manager ──────────────────────────────────────────────────────────

export class SecureInvitationManager {
  private redemptions: Map<string, Redemption> = new Map();
  private revoked: Set<string> = new Set();
  private readonly stateFile: string;

  constructor(stateDir: string) {
    this.stateFile = path.join(stateDir, 'threadline', 'secure-invitations.json');
    this.loadState();
  }

  /**
   * Create an Ed25519-signed invitation token.
   *
   * @param issuerFingerprint Fingerprint of the issuing agent
   * @param issuerPrivateKey Ed25519 private key (32 bytes)
   * @param options Optional: recipient binding, custom expiry, max uses
   */
  create(
    issuerFingerprint: string,
    issuerPrivateKey: Buffer,
    options?: {
      recipient?: string;
      expiryMs?: number;
      maxUses?: number;
      submitHost?: string;
      submitCertFingerprint?: string;
    },
  ): InvitationToken {
    const expiryMs = Math.min(options?.expiryMs ?? DEFAULT_EXPIRY_MS, MAX_EXPIRY_MS);

    const token: InvitationToken = {
      version: 1,
      type: 'invitation',
      issuer: issuerFingerprint,
      tokenId: crypto.randomBytes(32).toString('base64url'),
      nonce: crypto.randomBytes(32).toString('hex'),
      scope: 'verified',
      expiry: new Date(Date.now() + expiryMs).toISOString(),
      maxUses: options?.maxUses ?? 1,
      ...(options?.recipient && { recipient: options.recipient }),
      ...(options?.submitHost && { submitHost: options.submitHost }),
      ...(options?.submitCertFingerprint && { submitCertFingerprint: options.submitCertFingerprint }),
      signature: '', // placeholder, computed below
    };

    token.signature = this.signToken(token, issuerPrivateKey);
    return token;
  }

  /**
   * Validate and optionally redeem an invitation token.
   *
   * Checks:
   * 1. Signature is valid (issuer's public key)
   * 2. Token is not expired
   * 3. Token is not revoked
   * 4. Token is not already redeemed (single-use)
   * 5. If recipient-bound: redeemer fingerprint matches
   * 6. Redeemer proves Ed25519 key possession (separate step)
   *
   * @param token The invitation token to validate
   * @param issuerPublicKey Ed25519 public key of the issuer (32 bytes)
   * @param redeemerFingerprint Fingerprint of the agent trying to redeem
   * @param redeem If true, mark as redeemed on successful validation
   */
  validate(
    token: InvitationToken,
    issuerPublicKey: Buffer,
    redeemerFingerprint: string,
    redeem = false,
  ): { valid: boolean; reason: string } {
    // 1. Verify signature
    if (!this.verifyTokenSignature(token, issuerPublicKey)) {
      return { valid: false, reason: 'Invalid signature' };
    }

    // 2. Check expiry
    if (new Date(token.expiry) <= new Date()) {
      return { valid: false, reason: 'Token expired' };
    }

    // 3. Check revocation
    if (this.revoked.has(token.tokenId)) {
      return { valid: false, reason: 'Token revoked' };
    }

    // 4. Check redemption
    if (this.redemptions.has(token.tokenId)) {
      return { valid: false, reason: 'Token already redeemed' };
    }

    // 5. Check recipient binding
    if (token.recipient && token.recipient !== redeemerFingerprint) {
      return { valid: false, reason: 'Token bound to different recipient' };
    }

    // Redeem if requested
    if (redeem) {
      this.redemptions.set(token.tokenId, {
        tokenId: token.tokenId,
        redeemedBy: redeemerFingerprint,
        redeemedAt: new Date().toISOString(),
      });
      this.saveState();
    }

    return { valid: true, reason: 'Token valid' };
  }

  /**
   * Revoke an unredeemed invitation token.
   */
  revoke(tokenId: string): boolean {
    if (this.redemptions.has(tokenId)) return false; // already redeemed
    this.revoked.add(tokenId);
    this.saveState();
    return true;
  }

  /**
   * Check if a token has been redeemed.
   */
  isRedeemed(tokenId: string): boolean {
    return this.redemptions.has(tokenId);
  }

  // ── Signing ─────────────────────────────────────────────────────

  private signToken(token: InvitationToken, privateKey: Buffer): string {
    const message = this.buildSignatureMessage(token);
    return sign(privateKey, message).toString('base64');
  }

  private verifyTokenSignature(token: InvitationToken, publicKey: Buffer): boolean {
    const message = this.buildSignatureMessage(token);
    try {
      return verify(publicKey, message, Buffer.from(token.signature, 'base64'));
    } catch {
      return false;
    }
  }

  private buildSignatureMessage(token: InvitationToken): Buffer {
    // Sign over all fields except signature itself.
    let payload = `${token.version}|${token.type}|${token.issuer}|${token.tokenId}|${token.nonce}|${token.scope}|${token.expiry}|${token.maxUses}|${token.recipient ?? ''}`;
    // R1b — sealed-handoff endpoint pinning. Appended ONLY when present, so existing
    // invitations (no submit fields) produce a byte-identical payload and stay valid.
    // Because the signature binds whichever form was signed, stripping or injecting a
    // submit field changes the verifier's payload and fails verification.
    if (token.submitHost !== undefined || token.submitCertFingerprint !== undefined) {
      payload += `|${token.submitHost ?? ''}|${token.submitCertFingerprint ?? ''}`;
    }
    return crypto.createHash('sha256').update(payload).digest();
  }

  // ── Persistence ─────────────────────────────────────────────────

  private saveState(): void {
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    const data = JSON.stringify({
      redemptions: Object.fromEntries(this.redemptions),
      revoked: [...this.revoked],
    }, null, 2);
    const tmpPath = `${this.stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, data, { mode: 0o600 });
    fs.renameSync(tmpPath, this.stateFile);
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      if (raw.redemptions) {
        for (const [k, v] of Object.entries(raw.redemptions)) {
          this.redemptions.set(k, v as Redemption);
        }
      }
      if (Array.isArray(raw.revoked)) {
        for (const id of raw.revoked) this.revoked.add(id);
      }
    } catch { /* start fresh */ }
  }
}
