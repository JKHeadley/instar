/**
 * Shared helper for tests that POST to `/messages/relay-agent`
 * (docs/specs/a2a-local-route-signed-envelope.md).
 *
 * The route refuses an envelope whose Ed25519 signature does not verify
 * against the public key the RECEIVER's registry holds for the sender NAME,
 * so every test sender does what every real sender does: it owns a key pair,
 * its key is recorded in the receiver's `known-agents.json`, and it signs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { generateIdentityKeyPair } from '../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../src/threadline/client/MessageEncryptor.js';
import { signLocalEnvelope } from '../../src/threadline/localEnvelopeSignature.js';
import type { LocalEnvelopeLike } from '../../src/threadline/localEnvelopeSignature.js';

export interface LocalSender {
  name: string;
  publicKey: Buffer;
  privateKey: Buffer;
  /** 64-hex Ed25519 public key, as discovery records it. */
  publicKeyHex: string;
  /** 32-hex routing fingerprint (first 16 bytes of the key). */
  fingerprint: string;
}

/** Mint a sender identity for a test (a fresh Ed25519 key pair). */
export function createLocalSender(name: string): LocalSender {
  const kp = generateIdentityKeyPair();
  return {
    name,
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    publicKeyHex: kp.publicKey.toString('hex'),
    fingerprint: computeFingerprint(kp.publicKey),
  };
}

/** A sender built from an existing identity (e.g. `new IdentityManager(stateDir).getOrCreate()`). */
export function localSenderFromIdentity(name: string, id: { publicKey: Buffer; privateKey: Buffer; fingerprint: string }): LocalSender {
  return { name, publicKey: id.publicKey, privateKey: id.privateKey, publicKeyHex: id.publicKey.toString('hex'), fingerprint: id.fingerprint };
}

/**
 * Record a sender in a receiver's registry (`{stateDir}/threadline/known-agents.json`),
 * the way `threadline_discover` would — merged by name, other entries kept.
 */
export function registerKnownAgent(
  receiverStateDir: string,
  sender: Pick<LocalSender, 'name' | 'publicKeyHex' | 'fingerprint'>,
  extra: Record<string, unknown> = {},
): void {
  const dir = path.join(receiverStateDir, 'threadline');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'known-agents.json');
  let data: { agents?: Array<Record<string, unknown>> } = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { /* fresh */ }
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const kept = agents.filter(a => String(a?.name ?? '').toLowerCase() !== sender.name.toLowerCase());
  kept.push({ name: sender.name, port: 1, publicKey: sender.publicKeyHex, fingerprint: sender.fingerprint, ...extra });
  fs.writeFileSync(file, JSON.stringify({ ...data, agents: kept }, null, 2));
}

/** Return a copy of the envelope carrying the sender's signature. */
export function signEnvelope<T extends LocalEnvelopeLike>(envelope: T, sender: Pick<LocalSender, 'privateKey'>): T & { signature: string } {
  return { ...envelope, signature: signLocalEnvelope(envelope, sender.privateKey) };
}

/**
 * One-call setup: mint a sender, record it in the receiver's registry, and
 * hand back a `sign` that stamps envelopes for it.
 */
export function provisionLocalSender(name: string, receiverStateDir: string): LocalSender & { sign: <T extends LocalEnvelopeLike>(e: T) => T & { signature: string } } {
  const sender = createLocalSender(name);
  registerKnownAgent(receiverStateDir, sender);
  return { ...sender, sign: (e) => signEnvelope(e, sender) };
}
