/**
 * Tier-1 + security-negative tests for HttpLiveTailTransport — the encrypted
 * holder→standby live-tail wire (spec §8 G3b/c). Injected fetch + injected
 * encryptor, real Ed25519 signing. Covers: single-machine no-op, signed POST to
 * /api/live-tail, REDACTION-BEFORE-ENCRYPTION (the security guarantee that no
 * secret ever leaves the machine in the clear), per-peer encryption, reachability.
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { HttpLiveTailTransport, type LiveTailPeer } from '../../src/core/HttpLiveTailTransport.js';
import { REDACTION_CATEGORY_VERSION } from '../../src/core/liveTailRedaction.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const peer = (id: string): LiveTailPeer => ({ machineId: id, url: `http://${id}`, encryptionPublicKey: `enc_${id}` });

/**
 * A stand-in encryptor that records the plaintext it was asked to encrypt (so a
 * test can prove the secret was already redacted) and returns a payload-shaped
 * object whose ciphertext is just base64 of the (redacted) content for assertion.
 */
function spyEncryptor() {
  const seen: { content: string; recipient: string }[] = [];
  const fn = vi.fn((content: string, recipient: string) => {
    seen.push({ content, recipient });
    return {
      ephemeralPublicKey: 'eph',
      iv: 'iv',
      ciphertext: Buffer.from(content, 'utf-8').toString('base64'),
      tag: 'tag',
    };
  });
  return { fn, seen };
}

function make(peers: LiveTailPeer[], encryptFor: any, fetchImpl?: any, now?: () => number) {
  let seq = 0;
  return new HttpLiveTailTransport({
    selfMachineId: 'm_a',
    signingKeyPem: privateKey,
    peers: () => peers,
    nextSequence: () => ++seq,
    encryptFor,
    fetchImpl,
    now,
    reachabilityWindowMs: 60_000,
  });
}

describe('HttpLiveTailTransport', () => {
  it('broadcast with no peers is a reachable no-op (single-machine mesh)', async () => {
    const enc = spyEncryptor();
    const t = make([], enc.fn);
    expect(await t.broadcast({ topic: '13481', seq: 1, content: 'hi' })).toBe(true);
    expect(t.isReachable()).toBe(true);
    expect(enc.fn).not.toHaveBeenCalled(); // nothing to encrypt with no peers
  });

  it('posts the encrypted flush to /api/live-tail with signed machine-auth headers', async () => {
    const enc = spyEncryptor();
    const fetchImpl = vi.fn(async () => ({ ok: true })) as any;
    const t = make([peer('m_b')], enc.fn, fetchImpl);
    expect(await t.broadcast({ topic: '13481', seq: 7, content: 'hello there' })).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://m_b/api/live-tail');
    expect(opts.headers['X-Machine-Id']).toBe('m_a');
    expect(opts.headers['X-Signature']).toBeTruthy();
    const body = JSON.parse(opts.body);
    expect(body.flush.topic).toBe('13481');
    expect(body.flush.seq).toBe(7);
    expect(body.flush.redactionVersion).toBe(REDACTION_CATEGORY_VERSION);
    expect(body.flush.enc.ciphertext).toBeTruthy();
    expect(t.isReachable()).toBe(true);
  });

  it('SECURITY: redacts secrets BEFORE encryption — no credential ever leaves in the clear', async () => {
    const enc = spyEncryptor();
    const fetchImpl = vi.fn(async () => ({ ok: true })) as any;
    const t = make([peer('m_b')], enc.fn, fetchImpl);
    const secret = 'Authorization: Bearer sk-ABC123DEFsupersecrettoken987654321';
    await t.broadcast({ topic: 'x', seq: 1, content: `here is the token ${secret} ok` });
    // The encryptor must have been handed REDACTED text, not the raw secret.
    expect(enc.seen).toHaveLength(1);
    expect(enc.seen[0].content).not.toContain('sk-ABC123DEFsupersecrettoken987654321');
    // And the on-the-wire ciphertext (base64 of what was encrypted) must not decode to the secret.
    const [, opts] = fetchImpl.mock.calls[0];
    const wire = JSON.parse(opts.body);
    const decoded = Buffer.from(wire.flush.enc.ciphertext, 'base64').toString('utf-8');
    expect(decoded).not.toContain('sk-ABC123DEFsupersecrettoken987654321');
  });

  it('encrypts per-peer (each standby gets its own ciphertext for its own key)', async () => {
    const enc = spyEncryptor();
    const fetchImpl = vi.fn(async () => ({ ok: true })) as any;
    const t = make([peer('m_b'), peer('m_c')], enc.fn, fetchImpl);
    await t.broadcast({ topic: 'x', seq: 1, content: 'shared content' });
    expect(enc.fn).toHaveBeenCalledTimes(2);
    expect(enc.seen.map((s) => s.recipient).sort()).toEqual(['enc_m_b', 'enc_m_c']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('broadcast is unreachable when every peer errors, and the window expires', async () => {
    let now = 1_000_000;
    const enc = spyEncryptor();
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const t = make([peer('m_b')], enc.fn, fetchImpl, () => now);
    expect(await t.broadcast({ topic: 'x', seq: 1, content: 'c' })).toBe(false);
    now += 60_001;
    expect(t.isReachable()).toBe(false);
  });

  it('a peer returning non-ok does not count as reachable', async () => {
    const enc = spyEncryptor();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 })) as any;
    const t = make([peer('m_b')], enc.fn, fetchImpl);
    expect(await t.broadcast({ topic: 'x', seq: 1, content: 'c' })).toBe(false);
  });
});
