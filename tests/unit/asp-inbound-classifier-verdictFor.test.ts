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
import { AspInboundClassifier, aspTextHash } from '../../src/core/AspInboundClassifier.js';
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
    expect(c.verdictFor(TOPIC, 501, aspTextHash(text))).toEqual({ classification: 'agent-verified', agentId: AGENT, textHash: aspTextHash(text) });
  });

  it('remembers a human verdict as human (no agent id)', () => {
    const c = make();
    c.classify({ topicId: TOPIC, text: 'plain operator prose', messageId: 502, fromUser: true });
    expect(c.verdictFor(TOPIC, 502, aspTextHash('plain operator prose'))).toEqual({ classification: 'human', agentId: null, textHash: aspTextHash('plain operator prose') });
  });

  it('remembers a replay as rejected — the second copy of a signed message is not the agent', () => {
    const c = make();
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'once', privateKey: keys.privateKey });
    c.classify({ topicId: TOPIC, text, messageId: 503, fromUser: true });
    c.classify({ topicId: TOPIC, text, messageId: 504, fromUser: true });
    expect(c.verdictFor(TOPIC, 503, aspTextHash(text))?.classification).toBe('agent-verified');
    expect(c.verdictFor(TOPIC, 504, aspTextHash(text))?.classification).toBe('rejected');
  });

  it('returns null for an unknown, id-less, or outbound message', () => {
    const c = make();
    c.classify({ topicId: TOPIC, text: 'no id', fromUser: true });
    c.classify({ topicId: TOPIC, text: 'our own send', messageId: 505, fromUser: false });
    expect(c.verdictFor(TOPIC, 999, aspTextHash('x'))).toBeNull();
    expect(c.verdictFor(TOPIC, undefined, aspTextHash('no id'))).toBeNull();
    expect(c.verdictFor(TOPIC, 505, aspTextHash('our own send'))).toBeNull();
  });

  it('is keyed on topic too — the same message id in another topic is a different message', () => {
    const c = make();
    c.classify({ topicId: TOPIC, text: 'a', messageId: 506, fromUser: true });
    expect(c.verdictFor(TOPIC + 1, 506, aspTextHash('a'))).toBeNull();
  });

  it('is bounded: after 1000 entries the oldest is evicted', () => {
    const c = make();
    for (let i = 1; i <= 1001; i++) c.classify({ topicId: TOPIC, text: `m${i}`, messageId: i, fromUser: true });
    expect(c.verdictFor(TOPIC, 1, aspTextHash('m1'))).toBeNull();
    expect(c.verdictFor(TOPIC, 2, aspTextHash('m2'))).not.toBeNull();
    expect(c.verdictFor(TOPIC, 1001, aspTextHash('m1001'))).not.toBeNull();
  });
});

describe('SEC-106 decisions 5 and 5a — same-text no-downgrade, text-bound reads, app skip', () => {
  it('a resident agent-verified verdict survives a later classification of the SAME key and SAME text', () => {
    const c = make();
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'reforwarded', privateKey: keys.privateKey });
    c.classify({ topicId: TOPIC, text, messageId: 601, fromUser: true });
    // A lifeline re-forward reaching the log again: nonce already used → rejected, which must not overwrite.
    c.classify({ topicId: TOPIC, text, messageId: 601, fromUser: true });
    expect(c.verdictFor(TOPIC, 601, aspTextHash(text))).toMatchObject({ classification: 'agent-verified', agentId: AGENT });
    expect(c.counters.downgradeRefused).toBe(1);
  });

  it('different text under the same key replaces the entry, and the old text no longer reads it', () => {
    const c = make();
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'A', privateKey: keys.privateKey });
    c.classify({ topicId: TOPIC, text, messageId: 602, fromUser: true });
    c.classify({ topicId: TOPIC, text: 'edited human text', messageId: 602, fromUser: true });
    expect(c.verdictFor(TOPIC, 602, aspTextHash('edited human text'))?.classification).toBe('human');
    // The round-6 sequence: A's read after B replaced the key gets nothing, never B's verdict.
    expect(c.lookupVerdict(TOPIC, 602, aspTextHash(text))).toEqual({ kind: 'hash-mismatch' });
  });

  it('a replaced entry is never lent to the original message (replacement between classify and read)', () => {
    const c = make();
    c.classify({ topicId: TOPIC, text: 'human A', messageId: 603, fromUser: true });
    const { text: signedB } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'B', privateKey: keys.privateKey });
    c.classify({ topicId: TOPIC, text: signedB, messageId: 603, fromUser: true });
    expect(c.verdictFor(TOPIC, 603, aspTextHash('human A'))).toBeNull();
    expect(c.verdictFor(TOPIC, 603, aspTextHash(signedB))?.agentId).toBe(AGENT);
  });

  it('a later agent-verified replaces an earlier non-verified entry for the same key', () => {
    const c = make();
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'up', privateKey: keys.privateKey });
    c.classify({ topicId: TOPIC, text: 'first human', messageId: 604, fromUser: true });
    c.classify({ topicId: TOPIC, text, messageId: 604, fromUser: true });
    expect(c.verdictFor(TOPIC, 604, aspTextHash(text))?.classification).toBe('agent-verified');
  });

  it('an app (mobile-device) entry is neither classified nor remembered', () => {
    const c = make();
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'app', privateKey: keys.privateKey });
    expect(c.classify({ topicId: TOPIC, text, messageId: 605, fromUser: true, via: 'mobile-device' })).toBeNull();
    expect(c.verdictFor(TOPIC, 605, aspTextHash(text))).toBeNull();
    expect(c.counters.skippedApp).toBe(1);
    expect(c.counters.seen).toBe(0);
  });
});
