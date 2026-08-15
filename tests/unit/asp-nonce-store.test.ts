/**
 * Durable replay defence — the property under test is SURVIVAL ACROSS RESTART.
 *
 * A store that only works within one process is not replay defence; a restart is
 * precisely when an attacker holding a captured message would retry. Every test
 * that matters here uses a SECOND store instance over the same file to stand in
 * for a restarted process.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { FileSeenNonceStore } from '../../src/core/aspNonceStore.js';
import { signMessage, verifyMessage } from '../../src/core/agentSignatureProvenance.js';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asp-nonce-'));
  file = path.join(dir, 'nested', 'asp-nonces.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: Buffer.from(publicKey.export({ type: 'spki', format: 'der' })).subarray(-32),
    privateKey: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'der' })).subarray(-32),
  };
}

describe('FileSeenNonceStore — durability', () => {
  it('a nonce recorded by one instance is seen by a NEW instance (restart survival)', () => {
    const a = new FileSeenNonceStore({ filePath: file });
    expect(a.has('echo:n1')).toBe(false);
    a.add('echo:n1', Date.now() + 60_000);

    // Stand-in for a process restart: fresh object, same file.
    const b = new FileSeenNonceStore({ filePath: file });
    expect(b.has('echo:n1')).toBe(true);
  });

  it('CONTROL: an unrelated nonce is NOT seen — so the check can say no', () => {
    const a = new FileSeenNonceStore({ filePath: file });
    a.add('echo:n1', Date.now() + 60_000);
    const b = new FileSeenNonceStore({ filePath: file });
    expect(b.has('echo:other')).toBe(false);
  });

  it('creates its parent directory rather than failing', () => {
    const s = new FileSeenNonceStore({ filePath: file });
    s.add('echo:n1', Date.now() + 60_000);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('expired entries stop matching, and do not survive a restart', () => {
    let now = 1_000_000;
    const a = new FileSeenNonceStore({ filePath: file, now: () => now });
    a.add('echo:old', now + 1_000);
    now += 5_000; // past expiry
    expect(a.has('echo:old')).toBe(false);

    const b = new FileSeenNonceStore({ filePath: file, now: () => now });
    expect(b.has('echo:old')).toBe(false);
  });
});

describe('FileSeenNonceStore — damage must not silently disarm the guard', () => {
  /**
   * The dangerous failure is not a crash — it is a corrupt store quietly
   * behaving like an empty one, because an empty store accepts every replay.
   */
  it('THROWS on a corrupt file rather than starting empty', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(() => new FileSeenNonceStore({ filePath: file })).toThrow(/corrupt/i);
  });

  it('THROWS on an unrecognised shape rather than starting empty', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 99, entries: {} }));
    expect(() => new FileSeenNonceStore({ filePath: file })).toThrow(/shape/i);
  });

  it('a MISSING file is a legitimate empty start, not damage', () => {
    // First run must work; only DAMAGE is fatal.
    expect(() => new FileSeenNonceStore({ filePath: file })).not.toThrow();
  });

  it('an empty file is treated as a fresh start', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    expect(() => new FileSeenNonceStore({ filePath: file })).not.toThrow();
  });
});

describe('ASP + durable store — replay is rejected ACROSS a restart', () => {
  it('end to end: the captured message is accepted once, then rejected by a new process', () => {
    const { publicKey, privateKey } = keypair();
    const resolvePublicKey = (id: string) => (id === 'echo' ? publicKey : null);
    const { text } = signMessage({ agentId: 'echo', topicId: 29723, body: 'approved', privateKey });

    // Process 1 accepts the genuine message.
    const store1 = new FileSeenNonceStore({ filePath: file });
    const first = verifyMessage({
      raw: text, expectedTopicId: 29723, resolvePublicKey, seenNonces: store1,
    });
    expect(first.classification).toBe('agent-verified');

    // Process restarts. Attacker replays the captured bytes.
    const store2 = new FileSeenNonceStore({ filePath: file });
    const replayed = verifyMessage({
      raw: text, expectedTopicId: 29723, resolvePublicKey, seenNonces: store2,
    });
    expect(replayed.classification).toBe('rejected');
    expect(replayed.classification === 'rejected' && replayed.reason).toBe('replay');
  });

  it('CONTROL: after the restart, a FRESH signed message still verifies', () => {
    // Without this, a store that reported every key as seen would pass the test above.
    const { publicKey, privateKey } = keypair();
    const resolvePublicKey = (id: string) => (id === 'echo' ? publicKey : null);

    const first = signMessage({ agentId: 'echo', topicId: 29723, body: 'one', privateKey });
    const store1 = new FileSeenNonceStore({ filePath: file });
    verifyMessage({ raw: first.text, expectedTopicId: 29723, resolvePublicKey, seenNonces: store1 });

    const store2 = new FileSeenNonceStore({ filePath: file });
    const fresh = signMessage({ agentId: 'echo', topicId: 29723, body: 'two', privateKey });
    expect(
      verifyMessage({ raw: fresh.text, expectedTopicId: 29723, resolvePublicKey, seenNonces: store2 })
        .classification
    ).toBe('agent-verified');
  });
});
