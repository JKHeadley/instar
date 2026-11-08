/** Recovery-only signing domains. No shell commands or caller-selected paths. */
import crypto from 'node:crypto';

export const RECOVERY_VERBS = ['status', 'collect-diagnostics', 'stop-instar-server', 'hold-owned-instar-watchdog', 'start-instar-server', 'restore'] as const;
export type RecoveryVerb = typeof RECOVERY_VERBS[number];
export type RecoveryRoute = 'ssh' | 'relay';
export const OFFLINE_LEASE_MS = 24 * 60 * 60_000;
export const PROOF_TTL_MS = 5 * 60_000;
export const REQUEST_TTL_MS = 30_000;
export interface Signed<T> { payload: T; signature: string }
export interface RecoveryCertificate {
  domain: 'instar-recovery-certificate-v1'; agentId: string; publicKey: string;
  generation: number; issuedAt: number; expiresAt: number;
}
export interface RecoveryPrincipal {
  machineId: string; pairingEpoch: number; generation: number;
  sshPublicKey: string; relayPublicKey: string;
}
export interface RecoveryCheckpoint {
  domain: 'instar-recovery-checkpoint-v1'; agentId: string; targetMachineId: string;
  challenge: string; version: number; issuedAt: number; expiresAt: number;
  principals: RecoveryPrincipal[]; revoked: string[]; disabledRoutes?: RecoveryRoute[]; repairEpoch?:number;
}
export interface RecoveryControlRequest {
  domain:'instar-recovery-control-request-v1'; agentId:string; machineId:string;
  action:'checkpoint'|'checkpoint-ack'|'send'|'poll'|'ack'|'episode-claim'|'episode-notice'|'episode-notice-ack'|'episode-notice-pending'|'episode-resolve'; nonce:string; issuedAt:number; expiresAt:number;
  body:Record<string,unknown>;
}
export interface RecoveryEnvelope {
  domain: 'instar-recovery-operation-v1'; agentId: string;
  sourceMachineId: string; targetMachineId: string; targetBootId: string;
  pairingEpoch: number; generation: number; route: RecoveryRoute;
  operationId: string; nonce: string; issuedAt: number; expiresAt: number;
  fencingEpoch: number; verb: RecoveryVerb;
}
export interface RecoveryDiscovery {
  domain: 'instar-recovery-discovery-v1'; agentId:string; sourceMachineId:string; targetMachineId:string;
  pairingEpoch:number; generation:number; route:RecoveryRoute; nonce:string; issuedAt:number; expiresAt:number;
}
export interface RecoveryHello {
  domain:'instar-recovery-hello-v1'; agentId:string; machineId:string; bootId:string;
  nonce:string; route:RecoveryRoute; observedAt:number; fencingEpoch:number; repairEpoch?:number; checkpoint:{ready:boolean;version:number;expiresAt:number};
}
export interface RecoveryReceipt {
  domain: 'instar-recovery-receipt-v1'; agentId: string; sourceMachineId: string;
  targetMachineId: string; targetBootId: string; operationId: string;
  requestDigest: string; route: RecoveryRoute; observedAt: number;
  checkpointVersion: number; result: 'ok' | 'refused' | 'failed';
  detail: Record<string, string | number | boolean | null>;
}

/** Sorted JSON prevents alternate object-order encodings from rebinding a signature. */
export function recoveryCanonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(recoveryCanonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${recoveryCanonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  throw new Error('recovery-invalid-value');
}
export function recoveryDigest(value: unknown): string {
  return crypto.createHash('sha256').update(recoveryCanonical(value)).digest('hex');
}
export function signRecovery<T>(payload: T, privateKey: string): Signed<T> {
  return { payload, signature: crypto.sign(null, Buffer.from(recoveryCanonical(payload)), privateKey).toString('base64') };
}
export function verifyRecovery<T>(signed: Signed<T>, publicKey: string): boolean {
  try {
    if(typeof publicKey!=='string'||!publicKey.startsWith('-----BEGIN PUBLIC KEY-----'))return false;
    if (typeof signed?.signature !== 'string' || signed.signature.length > 128) return false;
    const key = crypto.createPublicKey(publicKey);
    return key.asymmetricKeyType === 'ed25519' && crypto.verify(null, Buffer.from(recoveryCanonical(signed.payload)), key, Buffer.from(signed.signature, 'base64'));
  } catch { // @silent-fallback-ok — untrusted signatures fail closed
    return false;
  }
}
export function recoveryKeyPair(): { publicKey: string; privateKey: string } {
  const k = crypto.generateKeyPairSync('ed25519');
  return { publicKey: k.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
export function validRecoveryId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
export function validRecoveryTime(issuedAt: number, expiresAt: number, now: number, ttl: number): boolean {
  return Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) && issuedAt <= now + 30_000 && expiresAt > now && expiresAt > issuedAt && expiresAt - issuedAt <= ttl;
}
export function validateRecoveryEnvelope(e: RecoveryEnvelope, now: number): boolean {
  return e?.domain === 'instar-recovery-operation-v1' && validRecoveryId(e.agentId) && validRecoveryId(e.sourceMachineId) && validRecoveryId(e.targetMachineId)
    && validRecoveryId(e.targetBootId) && validRecoveryId(e.operationId) && /^[a-f0-9]{64}$/.test(e.nonce)
    && Number.isSafeInteger(e.pairingEpoch) && e.pairingEpoch > 0 && Number.isSafeInteger(e.generation) && e.generation > 0
    && Number.isSafeInteger(e.fencingEpoch) && e.fencingEpoch > 0 && e.fencingEpoch <= now + REQUEST_TTL_MS && RECOVERY_VERBS.includes(e.verb)
    && (e.route === 'ssh' || e.route === 'relay') && validRecoveryTime(e.issuedAt, e.expiresAt, now, REQUEST_TTL_MS)
    && Object.keys(e).length === 14;
}

export function recoveryKeyFingerprint(pem: string): string {
  if(typeof pem!=='string'||!pem.startsWith('-----BEGIN PUBLIC KEY-----'))throw new Error('recovery-public-key-format-invalid');
  const key = crypto.createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('recovery-key-type-invalid');
  return crypto.createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
}
export function validateRecoveryPrincipals(principals: RecoveryPrincipal[], revoked: string[]): void {
  if (!Array.isArray(principals) || principals.length > 128 || !Array.isArray(revoked) || revoked.length > 1024 || revoked.some(id=>!validRecoveryId(id))) throw new Error('recovery-principal-invalid');
  const ids = new Set<string>(); const keys = new Set<string>();
  for (const p of principals) {
    if (!validRecoveryId(p.machineId) || ids.has(p.machineId) || revoked.includes(p.machineId) || !Number.isSafeInteger(p.pairingEpoch) || p.pairingEpoch < 1 || !Number.isSafeInteger(p.generation) || p.generation < 1) throw new Error('recovery-principal-invalid');
    for (const pem of [p.sshPublicKey,p.relayPublicKey]) {
      if (typeof pem !== 'string' || pem.length > 256) throw new Error('recovery-principal-invalid');
      const fingerprint = recoveryKeyFingerprint(pem);
      if (keys.has(fingerprint)) throw new Error('recovery-key-reused');
      keys.add(fingerprint);
    }
    ids.add(p.machineId);
  }
}
