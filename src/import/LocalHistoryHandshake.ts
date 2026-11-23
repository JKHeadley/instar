/** Cryptographic handshake only. Call after real native-owner admission and
 * channel-capacity reservation. A public key supplied by discovery is not a pin.
 * The caller owns current machine/boot/owner lifecycle and disposal of keys.
 */
import crypto from 'node:crypto';

const PURPOSE = 'instar-local-history-channel-v1';
export const LOCAL_HISTORY_CHANNEL_TTL_MS = 60_000;
export interface LocalHistoryHandshakeRequest {
  machineId: string;
  clientPublicKey: string;
  clientNonce: string;
}
export interface LocalHistoryHandshakeContext {
  agentId: string;
  machineId: string;
  bootId: string;
  deviceId: string;
  deviceKeyHash: string;
}
export interface LocalHistoryHandshakeGrant extends LocalHistoryHandshakeContext, LocalHistoryHandshakeRequest {
  version: 1;
  purpose: typeof PURPOSE;
  channelId: string;
  serverPublicKey: string;
  salt: string;
  expiresAt: number;
  signature: string;
}
export interface LocalHistoryChannelKeys { request: Buffer; response: Buffer }

function invalid(): never { throw new Error('local-history-handshake-invalid'); }
function opaque(value: unknown): void {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(value)) invalid();
}
function bytes(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || value.length > 128) invalid();
  const result = Buffer.from(value, 'base64');
  if (result.length !== length || result.toString('base64') !== value) invalid();
  return result;
}
function point(value: unknown): Buffer {
  const result = bytes(value, 65);
  if (result[0] !== 4) invalid();
  return result;
}
function context(value: LocalHistoryHandshakeContext): void {
  for (const key of ['agentId', 'machineId', 'bootId', 'deviceId', 'deviceKeyHash'] as const) opaque(value[key]);
}
/** Fixed-position JSON array; both platforms serialize only these validated
 * ASCII strings and safe integer fields. Do not sign arbitrary object ordering. */
export function localHistoryHandshakeBytes(grant: Omit<LocalHistoryHandshakeGrant, 'signature'>): Buffer {
  return Buffer.from(JSON.stringify([PURPOSE, grant.version, grant.agentId, grant.machineId, grant.bootId,
    grant.deviceId, grant.deviceKeyHash, grant.clientNonce, grant.clientPublicKey,
    grant.serverPublicKey, grant.salt, grant.channelId, grant.expiresAt]));
}
function derive(shared: Buffer, grant: Omit<LocalHistoryHandshakeGrant, 'signature'>): LocalHistoryChannelKeys {
  const salt = bytes(grant.salt, 32);
  const transcript = localHistoryHandshakeBytes(grant);
  const key = (direction: string) => Buffer.from(crypto.hkdfSync('sha256', shared, salt,
    Buffer.concat([Buffer.from(PURPOSE + ':' + direction + ':'), transcript]), 32));
  try { return { request: key('request'), response: key('response') }; }
  finally { shared.fill(0); }
}

export function createLocalHistoryHandshake(request: LocalHistoryHandshakeRequest,
  scope: LocalHistoryHandshakeContext, sign: (bytes: Buffer) => string, now: number): {
    grant: LocalHistoryHandshakeGrant; keys: LocalHistoryChannelKeys;
  } {
  context(scope);
  if (request.machineId !== scope.machineId || !Number.isSafeInteger(now) || now < 0
    || !Number.isSafeInteger(now + LOCAL_HISTORY_CHANNEL_TTL_MS)) invalid();
  bytes(request.clientNonce, 32);
  const clientPublicKey = point(request.clientPublicKey);
  const server = crypto.createECDH('prime256v1');
  server.generateKeys();
  let shared: Buffer;
  try { shared = server.computeSecret(clientPublicKey); } catch { return invalid(); }
  const unsigned: Omit<LocalHistoryHandshakeGrant, 'signature'> = {
    agentId: scope.agentId, machineId: scope.machineId, bootId: scope.bootId,
    deviceId: scope.deviceId, deviceKeyHash: scope.deviceKeyHash, version: 1, purpose: PURPOSE,
    clientNonce: request.clientNonce, clientPublicKey: request.clientPublicKey,
    serverPublicKey: server.getPublicKey().toString('base64'), salt: crypto.randomBytes(32).toString('base64'),
    channelId: crypto.randomUUID(), expiresAt: now + LOCAL_HISTORY_CHANNEL_TTL_MS,
  };
  let signature: string;
  try { signature = sign(localHistoryHandshakeBytes(unsigned)); bytes(signature, 64); }
  catch { shared.fill(0); return invalid(); }
  return { grant: { ...unsigned, signature }, keys: derive(shared, unsigned) };
}

/** Reference/native-fixture verifier. pinnedKey MUST come from independent
 * trusted local enrollment or explicit out-of-band verification, never /targets.
 * Verification of all bindings precedes ECDH and any private channel bytes. */
export function finishLocalHistoryHandshake(grant: LocalHistoryHandshakeGrant,
  request: LocalHistoryHandshakeRequest, expected: LocalHistoryHandshakeContext,
  client: crypto.ECDH, pinnedKey: crypto.KeyObject, now: number): LocalHistoryChannelKeys {
  context(expected);
  if (pinnedKey.type !== 'public' || pinnedKey.asymmetricKeyType !== 'ed25519' || grant.version !== 1 || grant.purpose !== PURPOSE
    || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(grant.expiresAt)
    || grant.expiresAt <= now || grant.expiresAt - now > LOCAL_HISTORY_CHANNEL_TTL_MS) invalid();
  for (const field of ['agentId', 'machineId', 'bootId', 'deviceId', 'deviceKeyHash'] as const) {
    if (grant[field] !== expected[field]) invalid();
  }
  if (request.machineId !== expected.machineId || grant.clientNonce !== request.clientNonce
    || grant.clientPublicKey !== request.clientPublicKey) invalid();
  bytes(grant.clientNonce, 32);
  if (!point(grant.clientPublicKey).equals(client.getPublicKey())) invalid();
  const serverPublicKey = point(grant.serverPublicKey);
  bytes(grant.salt, 32); opaque(grant.channelId);
  const signature = bytes(grant.signature, 64);
  if (!crypto.verify(null, localHistoryHandshakeBytes(grant), pinnedKey, signature)) invalid();
  try { return derive(client.computeSecret(serverPublicKey), grant); }
  catch { return invalid(); }
}
