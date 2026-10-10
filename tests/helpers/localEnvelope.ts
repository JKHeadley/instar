/**
 * Shared helper for tests of the A2A local-route signed envelope
 * (docs/specs/a2a-local-route-signed-envelope.md).
 *
 * A test sender does what a real sender does: it owns an Ed25519 key pair and
 * signs. A receiver knows the key either from its registry
 * (`known-agents.json`, the way `threadline_discover` records it) or from a
 * first-contact probe.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
  const signature = signLocalEnvelope(envelope, sender.privateKey);
  if (!signature) throw new Error('test envelope exceeds a canonicalisation bound');
  return { ...envelope, signature };
}

/** A well-formed envelope from `from` to `to`, fresh nonce and timestamp. */
export function makeLocalEnvelope(from: string, to: string, overrides: { body?: unknown; threadId?: string; id?: string; at?: number; fingerprint?: string } = {}) {
  const now = new Date(overrides.at ?? Date.now()).toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: overrides.id ?? crypto.randomUUID(),
      from: { agent: from, session: 'threadline', machine: 'local', ...(overrides.fingerprint ? { fingerprint: overrides.fingerprint } : {}) },
      to: { agent: to, session: 'best', machine: 'local' },
      type: 'request',
      priority: 'medium',
      subject: 'signed envelope test',
      body: overrides.body ?? 'hello from a signed sender',
      threadId: overrides.threadId ?? crypto.randomUUID(),
      createdAt: now,
    },
    transport: {
      relayChain: [] as string[],
      originServer: 'http://localhost:1',
      nonce: `${crypto.randomUUID()}:${now}`,
      timestamp: now,
    },
    delivery: { phase: 'sent', transitions: [] as unknown[], attempts: 0 },
  };
}
