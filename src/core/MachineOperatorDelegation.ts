/**
 * Receiver-verifiable operator grants for cross-machine identity actions.
 *
 * A grant is signed by the issuer's separately pinned recovery root only after
 * a local dashboard-PIN session authorizes the action. Ordinary machine-auth
 * signing keys cannot mint one. Peers that do not already hold the issuer's
 * recovery root fail closed; first root enrollment remains pairing-code-only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { base64ToSigningPem, verify } from './MachineIdentity.js';
import type { MachineIdentity } from './types.js';

export type MachineOperatorAction = 'rotate-recovery-root' | 'acknowledge-signing-rotation';

export interface MachineOperatorGrantUnsigned {
  version: 1;
  action: MachineOperatorAction;
  issuerMachineId: string;
  recipientMachineId: string;
  subjectMachineId: string;
  epoch: number;
  contentHash: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface MachineOperatorDelegation extends MachineOperatorGrantUnsigned {
  signature: string;
}

export function machineOperatorGrantMessage(grant: MachineOperatorGrantUnsigned): string {
  return [
    'instar-machine-operator-grant-v1', grant.action, grant.issuerMachineId,
    grant.recipientMachineId, grant.subjectMachineId, String(grant.epoch),
    grant.contentHash, grant.nonce, String(grant.issuedAt), String(grant.expiresAt),
  ].join('|');
}

export function recoveryRootDelegationHash(identity: MachineIdentity): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    machineId: identity.machineId,
    signingPublicKey: identity.signingPublicKey,
    encryptionPublicKey: identity.encryptionPublicKey,
    keyEpoch: identity.keyEpoch ?? 0,
    recoveryPublicKey: identity.recoveryPublicKey ?? null,
    recoveryEpoch: identity.recoveryEpoch ?? 0,
  })).digest('hex');
}

export function signingAckDelegationHash(machineId: string, keyEpoch: number): string {
  return crypto.createHash('sha256').update(`identity-ack-v1|${machineId}|${keyEpoch}`).digest('hex');
}

export function verifyMachineOperatorDelegation(
  grant: MachineOperatorDelegation,
  recoveryPublicKeyBase64: string,
): boolean {
  if (!grant || grant.version !== 1 || typeof grant.signature !== 'string') return false;
  try {
    const { signature, ...unsigned } = grant;
    return verify(machineOperatorGrantMessage(unsigned), signature, base64ToSigningPem(recoveryPublicKeyBase64));
  } catch { // @silent-fallback-ok: malformed operator proof is an expected fail-closed verification result
    return false;
  }
}

export function acceptMachineOperatorDelegation(input: {
  grant: unknown;
  expected: {
    action: MachineOperatorAction;
    issuerMachineId: string;
    recipientMachineId: string;
    subjectMachineId: string;
    epoch: number;
    contentHash: string;
  };
  issuerRecoveryPublicKey: string | undefined;
  replayStore?: MachineOperatorDelegationReplayStore;
  now?: number;
  maxTtlMs?: number;
}): { ok: true; replay: 'new' | 'repeat' | 'dry-run' } | { ok: false; reason: string } {
  const grant = input.grant as MachineOperatorDelegation;
  const now = input.now ?? Date.now();
  const maxTtlMs = input.maxTtlMs ?? 7 * 24 * 60 * 60_000;
  const e = input.expected;
  const exact = grant?.version === 1 && grant.action === e.action
    && grant.issuerMachineId === e.issuerMachineId
    && grant.recipientMachineId === e.recipientMachineId
    && grant.subjectMachineId === e.subjectMachineId
    && grant.epoch === e.epoch && grant.contentHash === e.contentHash
    && Number.isSafeInteger(grant.issuedAt) && Number.isSafeInteger(grant.expiresAt)
    && grant.issuedAt <= now + 30_000 && grant.expiresAt >= now
    && grant.expiresAt - grant.issuedAt <= maxTtlMs
    && /^[a-f0-9]{64}$/i.test(grant.nonce ?? '');
  if (!exact || !input.issuerRecoveryPublicKey
    || !verifyMachineOperatorDelegation(grant, input.issuerRecoveryPublicKey)) {
    return { ok: false, reason: 'operator-delegation-invalid' };
  }
  if (!input.replayStore) return { ok: true, replay: 'dry-run' };
  const digest = crypto.createHash('sha256').update(JSON.stringify(grant)).digest('hex');
  const replay = input.replayStore.authorize(grant.nonce, digest, grant.expiresAt);
  return replay ? { ok: true, replay } : { ok: false, reason: 'operator-delegation-replay' };
}

interface ReplayFile {
  version: 1;
  nonces: Record<string, { digest: string; expiresAt: number }>;
}

export class MachineOperatorDelegationReplayStore {
  private readonly file: string;
  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, 'state', 'machine-operator-delegation-nonces.json');
  }

  /** Identical retries are idempotent; a nonce rebound to any other grant is refused. */
  authorize(nonce: string, grantDigest: string, expiresAt: number): 'new' | 'repeat' | false {
    if (!/^[a-f0-9]{64}$/i.test(nonce) || !/^[a-f0-9]{64}$/i.test(grantDigest)
      || !Number.isFinite(expiresAt) || expiresAt < this.now()) return false;
    const data = this.load();
    const now = this.now();
    for (const [key, row] of Object.entries(data.nonces)) if (row.expiresAt < now) delete data.nonces[key];
    const prior = data.nonces[nonce];
    if (prior) return prior.digest === grantDigest ? 'repeat' : false;
    data.nonces[nonce] = { digest: grantDigest, expiresAt };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return 'new';
  }

  private load(): ReplayFile {
    if (!fs.existsSync(this.file)) return { version: 1, nonces: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ReplayFile;
      if (parsed?.version === 1 && parsed.nonces && typeof parsed.nonces === 'object') return parsed;
    } catch { /* fail closed below */ }
    throw new Error('operator delegation replay store corrupt');
  }
}
