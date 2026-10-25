/**
 * AspInboundClassifier.verdictFor — the routing path's read of the ONE
 * log-time verdict. The nonce is single-use, so verifying again downstream
 * would classify the genuine message as a replay; the classifier remembers
 * its verdict by (topic, message id) instead.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AspInboundClassifier } from '../../src/core/AspInboundClassifier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { signMessage, MemorySeenNonceStore } from '../../src/core/agentSignatureProvenance.js';

const AGENT = 'echo';
const TOPIC = 52075;
let dir: string;
let keys: { publicKey: Buffer; privateKey: Buffer };

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-32),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(-32),
  };
}
function make() {
  return new AspInboundClassifier({
    ledgerPath: path.join(dir, 'asp-classifications.jsonl'),
    resolvePublicKey: (id) => (id === AGENT ? keys.publicKey : null),
    seenNonces: new MemorySeenNonceStore(),
  });
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-verdictfor-')); keys = keypair(); });
afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/asp-inbound-classifier-verdictFor.test.ts' }));

describe('AspInboundClassifier.verdictFor', () => {
  it('remembers an agent-verified verdict by (topic, message id) with the agent id', () => {
    const c = make();
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'review round 1', privateKey: keys.privateKey });
    c.classify({ topicId: TOPIC, text, messageId: 501, fromUser: true });
    expect(c.verdictFor(TOPIC, 501)).toEqual({ classification: 'agent-verified', agentId: AGENT });
  });

  it('remembers a human verdict as human (no agent id)', () => {
    const c = make();
    c.classify({ topicId: TOPIC, text: 'plain operator prose', messageId: 502, fromUser: true });
    expect(c.verdictFor(TOPIC, 502)).toEqual({ classification: 'human', agentId: null });
  });

  it('remembers a replay as rejected — the second copy of a signed message is not the agent', () => {
    const c = make();
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'once', privateKey: keys.privateKey });
    c.classify({ topicId: TOPIC, text, messageId: 503, fromUser: true });
    c.classify({ topicId: TOPIC, text, messageId: 504, fromUser: true });
    expect(c.verdictFor(TOPIC, 503)?.classification).toBe('agent-verified');
    expect(c.verdictFor(TOPIC, 504)?.classification).toBe('rejected');
  });

  it('returns null for an unknown, id-less, or outbound message', () => {
    const c = make();
    c.classify({ topicId: TOPIC, text: 'no id', fromUser: true });
    c.classify({ topicId: TOPIC, text: 'our own send', messageId: 505, fromUser: false });
    expect(c.verdictFor(TOPIC, 999)).toBeNull();
    expect(c.verdictFor(TOPIC, undefined)).toBeNull();
    expect(c.verdictFor(TOPIC, 505)).toBeNull();
  });

  it('is keyed on topic too — the same message id in another topic is a different message', () => {
    const c = make();
    c.classify({ topicId: TOPIC, text: 'a', messageId: 506, fromUser: true });
    expect(c.verdictFor(TOPIC + 1, 506)).toBeNull();
  });

  it('is bounded: after 1000 entries the oldest is evicted', () => {
    const c = make();
    for (let i = 1; i <= 1001; i++) c.classify({ topicId: TOPIC, text: `m${i}`, messageId: i, fromUser: true });
    expect(c.verdictFor(TOPIC, 1)).toBeNull();
    expect(c.verdictFor(TOPIC, 2)).not.toBeNull();
    expect(c.verdictFor(TOPIC, 1001)).not.toBeNull();
  });
});
