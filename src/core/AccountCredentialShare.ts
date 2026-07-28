/**
 * WS5.2 Account Follow-Me — the `account-credential-share` mesh verb (Mechanism A).
 *
 * STRUCTURALLY SEPARATE from `secret-share` (SecretSync.ts) by design — spec R3a / §6.5.
 * The legacy `secret-share` verb/`SecretShareHandler`/`decryptFromSync` path is PERMISSIVE
 * (any registered peer; no AAD; no mandate). A credential MUST NOT ride it. This file is the
 * distinct, operator-mandate-gated path:
 *
 *   - the credential is sealed with the AAD-bound `encryptAccountCredential` (NOT
 *     `encryptForSync`), so the recipient/account/mandate/grant/epoch are cryptographically
 *     bound (SecretStore.ts);
 *   - the receiver runs an RBAC gate BEFORE decrypt — verify the authorizing mandate, match
 *     the addressed recipient, and CONSUME a single-use grant — and only then attempts the
 *     fail-closed decrypt against THIS machine's live fingerprint + key-rotation epoch.
 *
 * PR1 SCOPE (no live credential): the verb, the builder, and the RBAC-gated handler ship as
 * primitives with injected seams (mandate verifier, grant consumer, credential writer). The
 * real config-home credential write is a LATER PR — here `storeCredential` is optional and,
 * when absent, the handler authenticates+decrypts but reports the write as unwired rather than
 * touching any live credential store. Everything stays dark behind `multiMachine.accountFollowMe`.
 */

import crypto from 'node:crypto';
import {
  encryptAccountCredential,
  decryptAccountCredential,
  type Secrets,
  type AccountCredentialAAD,
  type EncryptedAccountCredentialPayload,
} from './SecretStore.js';

/** The DISTINCT credential-share mesh command (never `secret-share`). */
export interface AccountCredentialShareCommand {
  type: 'account-credential-share';
  /** JSON-serialized EncryptedAccountCredentialPayload (AAD-bound, sealed to the recipient). */
  encrypted: string;
  /** Authorizing coordination-mandate id (also bound in the AAD). */
  mandateId: string;
  /** Single-use grant id consumed at the gate (also bound in the AAD). */
  grantId: string;
  /** Routing fingerprint of the addressed recipient machine (also bound in the AAD). */
  targetFingerprint: string;
  /** SubscriptionAccount.id (also bound in the AAD). */
  accountId: string;
  /** Recipient key-rotation generation the seal targeted (also bound in the AAD). */
  pairingEpoch: number;
  /** Absolute expiry (ms since epoch) — rejected after this even before decrypt. */
  expiresAt: number;
}

export interface AccountCredentialSharePeer {
  machineId: string;
  /** Recipient's routing fingerprint (the AAD recipient binding). */
  fingerprint: string;
  /** Recipient's long-term X25519 public key (base64), from its MachineIdentity. */
  encryptionPublicKey: string;
}

export interface BuildCredentialShareArgs {
  secrets: Secrets;
  recipient: AccountCredentialSharePeer;
  accountId: string;
  mandateId: string;
  grantId: string;
  /** Recipient's CURRENT key-rotation epoch (R4b) — sealing to a stale epoch will fail at decrypt. */
  pairingEpoch: number;
  /** Absolute expiry (ms since epoch). */
  expiresAt: number;
}

/** Build an `account-credential-share` command sealed + AAD-bound to one recipient. */
export function buildAccountCredentialShareCommand(args: BuildCredentialShareArgs): AccountCredentialShareCommand {
  const aad: AccountCredentialAAD = {
    recipientFingerprint: args.recipient.fingerprint,
    accountId: args.accountId,
    mandateId: args.mandateId,
    grantId: args.grantId,
    pairingEpoch: args.pairingEpoch,
  };
  const payload = encryptAccountCredential(args.secrets, args.recipient.encryptionPublicKey, aad);
  return {
    type: 'account-credential-share',
    encrypted: JSON.stringify(payload),
    mandateId: args.mandateId,
    grantId: args.grantId,
    targetFingerprint: args.recipient.fingerprint,
    accountId: args.accountId,
    pairingEpoch: args.pairingEpoch,
    expiresAt: args.expiresAt,
  };
}

/** Result of the receive-side RBAC + decrypt pipeline. Never throws on a denied command. */
export type CredentialShareResult =
  | { accepted: true; stored: boolean; storeReason?: string; accountId: string }
  | { accepted: false; reason: string };

export interface AccountCredentialShareHandlerDeps {
  /** This machine's X25519 private key (KeyObject) for the fail-closed decrypt. */
  ownEncryptionPrivateKey: () => crypto.KeyObject;
  /** This machine's routing fingerprint — the AAD recipient binding is checked against it. */
  currentRecipientFingerprint: () => string;
  /** This machine's CURRENT X25519 key-rotation generation (R4b) — a stale-epoch seal fails. */
  currentPairingEpoch: () => number;
  /**
   * Verify the authorizing mandate authorizes (sender, account, target) — R1/R4a. This is the
   * operator-mandate gate; it returns `{ ok:false, reason }` for deny-by-default / expired /
   * revoked / wrong-bounds / unverified-issuer-signature. Wired to the real cross-machine
   * verifier (primitive #3) at integration; unit-tested with a real test double.
   */
  verifyMandate: (args: { mandateId: string; sender: string; accountId: string; targetFingerprint: string }) => {
    ok: boolean;
    reason?: string;
  };
  /** Consume a single-use grant; `{ ok:false }` if unknown / already-consumed / expired (R3). */
  consumeGrant: (grantId: string, mandateId: string) => { ok: boolean; reason?: string };
  /** Persist the decrypted credential (LATER PR wires the real config-home write). */
  storeCredential?: (accountId: string, secrets: Secrets) => void;
  now?: () => number;
  log?: (msg: string) => void;
}

/**
 * Receive-side handler. Runs the RBAC gate BEFORE decrypt (spec §5.4: "verifies ... AT THE
 * GATE (before decrypt)"), then a fail-closed AAD-bound decrypt against THIS machine's live
 * fingerprint + epoch. Order is load-bearing: a bad sender/recipient/grant is rejected without
 * ever doing the cryptographic work, and a stale/forged seal cannot decrypt regardless.
 */
export class AccountCredentialShareHandler {
  constructor(private readonly deps: AccountCredentialShareHandlerDeps) {}

  handle(command: AccountCredentialShareCommand, sender: string): CredentialShareResult {
    // 0. Type guard — this handler accepts ONLY the credential verb (never secret-share).
    if (!command || command.type !== 'account-credential-share') {
      return { accepted: false, reason: 'wrong-verb' };
    }
    const now = (this.deps.now ?? Date.now)();

    // 1. Expiry — reject before any work.
    if (typeof command.expiresAt !== 'number' || now > command.expiresAt) {
      return { accepted: false, reason: 'expired' };
    }

    // 2. Recipient binding — this share must be addressed to THIS machine.
    const myFp = this.deps.currentRecipientFingerprint();
    if (command.targetFingerprint !== myFp) {
      return { accepted: false, reason: 'recipient-mismatch' };
    }

    // 3. Mandate RBAC — deny-by-default; operator-mandate-gated (R1/R4a).
    const m = this.deps.verifyMandate({
      mandateId: command.mandateId,
      sender,
      accountId: command.accountId,
      targetFingerprint: command.targetFingerprint,
    });
    if (!m.ok) {
      return { accepted: false, reason: `mandate-denied:${m.reason ?? 'unknown'}` };
    }

    // 4. Single-use grant — consume it AT THE GATE (replay of a consumed grant is rejected, R3).
    const g = this.deps.consumeGrant(command.grantId, command.mandateId);
    if (!g.ok) {
      return { accepted: false, reason: `grant-rejected:${g.reason ?? 'unknown'}` };
    }

    // 5. Fail-closed decrypt — expectedAAD is built from THIS machine's LIVE state, so a seal to
    //    a stale fingerprint or pre-rotation epoch (R4b) cannot decrypt.
    const expectedAAD: AccountCredentialAAD = {
      recipientFingerprint: myFp,
      accountId: command.accountId,
      mandateId: command.mandateId,
      grantId: command.grantId,
      pairingEpoch: this.deps.currentPairingEpoch(),
    };
    let secrets: Secrets;
    try {
      const payload = JSON.parse(command.encrypted) as EncryptedAccountCredentialPayload;
      secrets = decryptAccountCredential(payload, this.deps.ownEncryptionPrivateKey(), expectedAAD);
    } catch (err) {
      return { accepted: false, reason: `decrypt-failed:${err instanceof Error ? err.message : String(err)}` };
    }

    // 6. Persist — the real config-home write is a LATER PR. PR1 ships the secure path proven
    //    end-to-end without touching a live credential store.
    if (!this.deps.storeCredential) {
      this.deps.log?.(`[account-cred] decrypted credential for ${command.accountId} from ${sender} (writer unwired — PR1)`);
      return { accepted: true, stored: false, storeReason: 'no-credential-writer-wired (PR1)', accountId: command.accountId };
    }
    this.deps.storeCredential(command.accountId, secrets);
    this.deps.log?.(`[account-cred] stored credential for ${command.accountId} from ${sender}`);
    return { accepted: true, stored: true, accountId: command.accountId };
  }
}
