/** Authenticated response envelope for recovery-channel bearer convergence. */
import crypto, { type KeyObject } from 'node:crypto';
import { verify } from './MachineIdentity.js';
import { decryptFromSync } from './SecretStore.js';

export interface IdentityRecoveryBearerWire {
  encrypted?: string;
  responderMachineId?: string;
  recipientMachineId?: string;
  requestNonce?: string;
  tokenHash?: string;
  signature?: string;
}

/** Mutable authority state used by the boot attempt and retry timer. A root
 * or config change cannot replace the last authenticated token implicitly. */
export class IdentityRecoveryBearerAuthority {
  private rootMachineId?: string;
  private token?: string;
  private confirmed = false;

  selectRoot(rootMachineId: string): void {
    if (this.rootMachineId === rootMachineId) return;
    this.rootMachineId = rootMachineId;
    this.token = undefined;
    this.confirmed = false;
  }

  confirm(rootMachineId: string, token: string): boolean {
    if (rootMachineId !== this.rootMachineId || !/^[a-f0-9]{64}$/i.test(token)) return false;
    this.token = token;
    this.confirmed = true;
    return true;
  }

  snapshot(): { rootMachineId?: string; token?: string; confirmed: boolean } {
    return { rootMachineId: this.rootMachineId, token: this.token, confirmed: this.confirmed };
  }
}

/** 30s ticks: unconfirmed peers retry every tick; confirmed peers recheck at 15m. */
export function shouldAttemptIdentityRecoveryBearer(confirmedByRoot: boolean, tick: number): boolean {
  return !confirmedByRoot || tick % 30 === 0;
}

/** Shared cadence for every enabled machine, including the machine that was
 * root at boot. Re-election is therefore revisited after registry changes. */
export class IdentityRecoveryBearerCadence {
  private ticks = 0;
  constructor(private readonly deps: {
    confirmed: () => boolean;
    reconcile: () => Promise<boolean>;
  }) {}

  async tick(): Promise<boolean> {
    this.ticks += 1;
    if (!shouldAttemptIdentityRecoveryBearer(this.deps.confirmed(), this.ticks)) return false;
    return this.deps.reconcile();
  }
}

export function identityRecoveryBearerResponseMessage(input: {
  responderMachineId: string;
  recipientMachineId: string;
  requestNonce: string;
  tokenHash: string;
  encrypted: string;
}): string {
  const ciphertextHash = crypto.createHash('sha256').update(input.encrypted).digest('hex');
  return [
    'instar-identity-recovery-bearer-v1', input.responderMachineId,
    input.recipientMachineId, input.requestNonce, input.tokenHash, ciphertextHash,
  ].join('|');
}

/** Returns the authenticated token or null. Callers must not mutate config/runtime on null. */
export function acceptIdentityRecoveryBearerResponse(input: {
  wire: IdentityRecoveryBearerWire;
  expectedResponderMachineId: string;
  expectedRecipientMachineId: string;
  expectedRequestNonce: string;
  responderSigningPublicKeyPem: string;
  recipientEncryptionPrivateKey: KeyObject;
}): string | null {
  const { wire } = input;
  if (typeof wire.encrypted !== 'string' || typeof wire.tokenHash !== 'string'
    || typeof wire.signature !== 'string'
    || wire.responderMachineId !== input.expectedResponderMachineId
    || wire.recipientMachineId !== input.expectedRecipientMachineId
    || wire.requestNonce !== input.expectedRequestNonce) return null;
  const message = identityRecoveryBearerResponseMessage({
    responderMachineId: input.expectedResponderMachineId,
    recipientMachineId: input.expectedRecipientMachineId,
    requestNonce: input.expectedRequestNonce,
    tokenHash: wire.tokenHash,
    encrypted: wire.encrypted,
  });
  if (!verify(message, wire.signature, input.responderSigningPublicKeyPem)) return null;
  try {
    const decrypted = decryptFromSync(JSON.parse(wire.encrypted), input.recipientEncryptionPrivateKey) as {
      identityRecoveryBearerToken?: unknown;
    };
    const token = String(decrypted.identityRecoveryBearerToken ?? '');
    if (!/^[a-f0-9]{64}$/i.test(token)) return null;
    return crypto.createHash('sha256').update(token).digest('hex') === wire.tokenHash ? token : null;
  } catch { // @silent-fallback-ok: invalid authenticated ciphertext is rejected as null; callers keep activation held
    return null;
  }
}
