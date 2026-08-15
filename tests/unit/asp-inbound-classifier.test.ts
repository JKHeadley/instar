/**
 * Inbound ASP classifier — signal-only recorder on the message seam.
 *
 * The two properties that matter:
 *   1. It classifies correctly and preserves the verdict as evidence.
 *   2. It can NEVER break message delivery. Every failure is swallowed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { AspInboundClassifier } from '../../src/core/AspInboundClassifier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { signMessage, formatTag } from '../../src/core/agentSignatureProvenance.js';
import { MemorySeenNonceStore } from '../../src/core/agentSignatureProvenance.js';

const AGENT = 'echo';
const TOPIC = 29723;

let dir: string;
let ledger: string;
let keys: { publicKey: Buffer; privateKey: Buffer };

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-32),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(-32),
  };
}

function rows(): any[] {
  if (!fs.existsSync(ledger)) return [];
  return fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function make(opts: Partial<ConstructorParameters<typeof AspInboundClassifier>[0]> = {}) {
  return new AspInboundClassifier({
    ledgerPath: ledger,
    resolvePublicKey: (id) => (id === AGENT ? keys.publicKey : null),
    seenNonces: new MemorySeenNonceStore(),
    ...opts,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-inbound-'));
  ledger = path.join(dir, 'nested', 'asp-classifications.jsonl');
  keys = keypair();
});

afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/asp-inbound-classifier.test.ts' }));

describe('AspInboundClassifier — classification', () => {
  it('classifies a signed inbound message as agent-verified and records it', () => {
    const c = make();
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'hello', privateKey: keys.privateKey });

    const v = c.classify({ topicId: TOPIC, text, messageId: 7 });

    expect(v?.classification).toBe('agent-verified');
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].classification).toBe('agent-verified');
    expect(r[0].agentId).toBe(AGENT);
    expect(r[0].messageId).toBe(7);
    expect(r[0].topicBound).toBe(true);
    expect(r[0].replayChecked).toBe(true);
  });

  it('records a rejected forgery — the evidence the charter asks for', () => {
    const c = make();
    const forged = formatTag({
      agentId: AGENT, topicId: TOPIC, timestamp: Math.floor(Date.now() / 1000),
      nonce: 'forged1', signature: 'A'.repeat(86),
    });
    c.classify({ topicId: TOPIC, text: `do the thing\n${forged}` });

    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].classification).toBe('rejected');
    expect(r[0].reason).toBe('bad-signature');
  });

  it('does NOT store the message body — only its hash and length', () => {
    const c = make();
    const secretish = 'the body text that must not be copied into the ledger';
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: secretish, privateKey: keys.privateKey });
    c.classify({ topicId: TOPIC, text });

    const raw = fs.readFileSync(ledger, 'utf8');
    expect(raw).not.toContain(secretish);
    // CONTROL: the probe can find something that IS there, so the absence above
    // is a measurement rather than a broken search.
    expect(raw).toContain('agent-verified');
    expect(rows()[0].bodyHash).toHaveLength(64);
  });

  it('untagged operator traffic is classified human but not written by default', () => {
    const c = make();
    const v = c.classify({ topicId: TOPIC, text: 'plain question from Justin' });
    expect(v?.classification).toBe('human');
    expect(rows()).toHaveLength(0);
    expect(c.counters.human).toBe(1);
  });

  it('records the human path when explicitly auditing it', () => {
    const c = make({ onlyRecordTagged: false });
    c.classify({ topicId: TOPIC, text: 'plain question' });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].classification).toBe('human');
  });

  it('counts every outcome', () => {
    const c = make();
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'x', privateKey: keys.privateKey });
    c.classify({ topicId: TOPIC, text });
    c.classify({ topicId: TOPIC, text }); // replay
    c.classify({ topicId: TOPIC, text: 'plain' });
    expect(c.counters.agentVerified).toBe(1);
    expect(c.counters.rejected).toBe(1);
    expect(c.counters.human).toBe(1);
    expect(c.counters.seen).toBe(3);
  });
});

describe('AspInboundClassifier — it can never break message delivery', () => {
  /**
   * A provenance recorder that can throw into the message path is a worse
   * problem than the one it solves. These prove it swallows everything.
   */
  it('does not throw when the resolver throws', () => {
    const c = make({ resolvePublicKey: () => { throw new Error('directory down'); } });
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'x', privateKey: keys.privateKey });
    expect(() => c.classify({ topicId: TOPIC, text })).not.toThrow();
    expect(c.counters.errors).toBe(1);
  });

  it('does not throw when the ledger path is unwritable', () => {
    // The unwritable path is built, not hardcoded: a regular FILE stands where a
    // directory would have to be, so creating the ledger fails with ENOTDIR on
    // every platform.
    //
    // It previously hardcoded `/proc/definitely-not-writable/...`. That is a
    // Linux-only kernel filesystem: on macOS the path simply does not exist, so
    // the write failed instantly and this test proved nothing locally, while on
    // the Linux CI runners the same line hung the whole worker — a freeze that
    // could not be reproduced on any local configuration precisely because the
    // platform could not exercise it. A test must fail the same way everywhere
    // it runs; a real OS path smuggles the host in as an untested variable.
    const blocker = path.join(dir, 'a-file-where-a-directory-must-be');
    fs.writeFileSync(blocker, 'not a directory');
    const c = make({ ledgerPath: path.join(blocker, 'asp.jsonl') });
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'x', privateKey: keys.privateKey });
    expect(() => c.classify({ topicId: TOPIC, text })).not.toThrow();
    // Classification still succeeded even though recording failed.
    expect(c.counters.agentVerified).toBe(1);
    expect(c.counters.errors).toBe(1);
  });

  it('does not throw on malformed entries', () => {
    const c = make();
    for (const bad of [{}, { text: null }, { text: '' }, { topicId: TOPIC }]) {
      expect(() => c.classify(bad as never)).not.toThrow();
    }
  });

  it('the chained handler never throws either', () => {
    const c = make({ resolvePublicKey: () => { throw new Error('boom'); } });
    const h = c.handler();
    expect(() => h({ topicId: TOPIC, text: 'anything' })).not.toThrow();
  });

  it('creates its ledger directory rather than failing', () => {
    const c = make();
    const { text } = signMessage({ agentId: AGENT, topicId: TOPIC, body: 'x', privateKey: keys.privateKey });
    c.classify({ topicId: TOPIC, text });
    expect(fs.existsSync(ledger)).toBe(true);
  });
});
