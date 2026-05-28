/**
 * Tier-1 tests for HttpLeaseTransport — the lease wire path (§6). Injected fetch,
 * real Ed25519 signing. Covers broadcast reachability, single-machine no-op,
 * observed-lease recording, nonce watermark + replay drop, reachability window.
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { HttpLeaseTransport, type LeasePeer } from '../../src/core/HttpLeaseTransport.js';
import type { LeaseRecord } from '../../src/core/types.js';

const { privateKey } = crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function lease(over?: Partial<LeaseRecord>): LeaseRecord {
  return { holder: 'm_a', epoch: 1, acquiredAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-01T00:01:00Z', signature: 'sig', nonce: 1, ...over };
}

function make(peers: LeasePeer[], fetchImpl?: any, now?: () => number) {
  let seq = 0;
  return new HttpLeaseTransport({
    selfMachineId: 'm_a',
    signingKeyPem: privateKey,
    peers: () => peers,
    nextSequence: () => ++seq,
    fetchImpl,
    now,
    reachabilityWindowMs: 60_000,
  });
}

describe('HttpLeaseTransport', () => {
  it('broadcast with no peers is a reachable no-op (single-machine mesh)', async () => {
    const t = make([]);
    expect(await t.broadcast(lease())).toBe(true);
    expect(t.isReachable()).toBe(true);
  });

  it('broadcast succeeds when a peer accepts', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true })) as any;
    const t = make([{ machineId: 'm_b', url: 'http://peer' }], fetchImpl);
    expect(await t.broadcast(lease())).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://peer/api/lease');
    expect(opts.headers['X-Machine-Id']).toBe('m_a');
    expect(opts.headers['X-Signature']).toBeTruthy();
    expect(t.isReachable()).toBe(true);
  });

  it('broadcast fails (unreachable) when all peers error', async () => {
    let now = 1_000_000;
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const t = make([{ machineId: 'm_b', url: 'http://peer' }], fetchImpl, () => now);
    expect(await t.broadcast(lease())).toBe(false);
    now += 60_001; // past the reachability window with no successful broadcast
    expect(t.isReachable()).toBe(false);
  });

  it('records an observed lease and exposes it', () => {
    const t = make([]);
    const l = lease({ holder: 'm_b', epoch: 3, nonce: 5 });
    t.recordObserved(l);
    const obs = t.observed();
    expect(obs.lease?.holder).toBe('m_b');
    expect(obs.lease?.epoch).toBe(3);
    expect(obs.lastNonceByHolder['m_b']).toBe(5);
  });

  it('advances the nonce watermark and ignores a replayed lower-nonce/same-epoch lease', () => {
    const t = make([]);
    t.recordObserved(lease({ holder: 'm_b', epoch: 3, nonce: 5 }));
    // Replay: same holder, lower nonce, not a higher epoch → ignored.
    t.recordObserved(lease({ holder: 'm_b', epoch: 3, nonce: 2 }));
    expect(t.observed().lastNonceByHolder['m_b']).toBe(5);
  });

  it('keeps the highest-epoch observed lease', () => {
    const t = make([]);
    t.recordObserved(lease({ holder: 'm_b', epoch: 2, nonce: 1 }));
    t.recordObserved(lease({ holder: 'm_c', epoch: 4, nonce: 1 }));
    expect(t.observed().lease?.epoch).toBe(4);
    expect(t.observed().lease?.holder).toBe('m_c');
  });
});
