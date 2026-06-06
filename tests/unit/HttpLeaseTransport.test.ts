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

  // ── Cross-Machine Coherence: active PULL (POST /api/lease/pull) ──────────

  it('pullPeer POSTs a signed empty body to /api/lease/pull and folds the returned lease', async () => {
    const peerLease = lease({ holder: 'm_b', epoch: 7, nonce: 9 });
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ lease: peerLease }) })) as any;
    const t = make([{ machineId: 'm_b', url: 'http://peer/' }], fetchImpl);
    const got = await t.pullPeer({ machineId: 'm_b', url: 'http://peer/' });
    expect(got?.epoch).toBe(7);
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://peer/api/lease/pull'); // trailing slash normalized
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{}'); // signed EMPTY body (machine-auth is body-hash based)
    expect(opts.headers['X-Machine-Id']).toBe('m_a');
    expect(opts.headers['X-Signature']).toBeTruthy();
    // Folded via recordObserved → visible in observed() and the watermark advanced.
    expect(t.observed().lease?.epoch).toBe(7);
    expect(t.observed().lastNonceByHolder['m_b']).toBe(9);
  });

  it('a successful pull proves reachability even when the peer returns no lease', async () => {
    let now = 2_000_000;
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ lease: null }) })) as any;
    const t = make([{ machineId: 'm_b', url: 'http://peer' }], fetchImpl, () => now);
    now += 60_001; // age out any prior broadcast window
    expect(t.isReachable()).toBe(false);
    const got = await t.pullPeer({ machineId: 'm_b', url: 'http://peer' });
    expect(got).toBeNull();
    expect(t.isReachable()).toBe(true); // pull alone made the medium live (one-way NAT case)
  });

  it('pullPeer returns null on a non-ok response and does not mark reachable', async () => {
    let now = 3_000_000;
    const fetchImpl = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as any;
    const t = make([{ machineId: 'm_b', url: 'http://peer' }], fetchImpl, () => now);
    now += 60_001;
    expect(await t.pullPeer({ machineId: 'm_b', url: 'http://peer' })).toBeNull();
    expect(t.isReachable()).toBe(false);
  });

  it('pullPeer returns null on a network error (advisory, not thrown)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const t = make([{ machineId: 'm_b', url: 'http://peer' }], fetchImpl);
    await expect(t.pullPeer({ machineId: 'm_b', url: 'http://peer' })).resolves.toBeNull();
  });

  it('pullAllPeers fans out to every peer and is a no-op with none', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ lease: null }) })) as any;
    const t = make([{ machineId: 'm_b', url: 'http://b' }, { machineId: 'm_c', url: 'http://c' }], fetchImpl);
    await t.pullAllPeers();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const empty = make([], fetchImpl);
    await empty.pullAllPeers();
    expect(fetchImpl).toHaveBeenCalledTimes(2); // unchanged — no peers, no calls
  });
});

describe('HttpLeaseTransport — P19 brakes (timeout + bounded failure logging)', () => {
  function makeWithLogger(fetchImpl: any, failureLogEveryN?: number) {
    let seq = 0;
    const lines: string[] = [];
    const t = new HttpLeaseTransport({
      selfMachineId: 'm_a',
      signingKeyPem: privateKey,
      peers: () => [{ machineId: 'm_b', url: 'http://peer' }],
      nextSequence: () => ++seq,
      fetchImpl,
      reachabilityWindowMs: 60_000,
      failureLogEveryN,
      logger: (m) => lines.push(m),
    });
    return { t, lines };
  }

  it('every outbound request carries an abort signal (hung-socket brake)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ lease: null }) })) as any;
    const { t } = makeWithLogger(fetchImpl);
    await t.broadcast({ holder: 'm_a', epoch: 1, nonce: 1, issuedAt: 1, ttlMs: 1000 } as any);
    await t.pullPeer({ machineId: 'm_b', url: 'http://peer' });
    for (const call of fetchImpl.mock.calls) {
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('SUSTAINED-FAILURE BOUND (P19): repeated pull failures log first + every Nth, never per-attempt', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any;
    const { t, lines } = makeWithLogger(fetchImpl, 10);
    for (let i = 0; i < 25; i++) {
      await t.pullPeer({ machineId: 'm_b', url: 'http://peer' });
    }
    // 25 failures with N=10 → first (#1) + reminders (#10, #20) = 3 lines, not 25.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('became unreachable');
    expect(lines[1]).toContain('10 consecutive failures');
    expect(lines[2]).toContain('20 consecutive failures');
  });

  it('recovery after a failure streak logs exactly once', async () => {
    let fail = true;
    const fetchImpl = vi.fn(async () => {
      if (fail) throw new Error('down');
      return { ok: true, json: async () => ({ lease: null }) };
    }) as any;
    const { t, lines } = makeWithLogger(fetchImpl, 100);
    await t.pullPeer({ machineId: 'm_b', url: 'http://peer' });
    await t.pullPeer({ machineId: 'm_b', url: 'http://peer' });
    fail = false;
    await t.pullPeer({ machineId: 'm_b', url: 'http://peer' });
    await t.pullPeer({ machineId: 'm_b', url: 'http://peer' });
    expect(lines.filter((l) => l.includes('recovered after 2 consecutive failures'))).toHaveLength(1);
    expect(lines).toHaveLength(2); // first-failure + recovery, nothing else
  });

  it('broadcast failure logging is gated the same way (rejecting peer, non-ok status)', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403 })) as any;
    const { t, lines } = makeWithLogger(fetchImpl, 10);
    const rec = { holder: 'm_a', epoch: 1, nonce: 1, issuedAt: 1, ttlMs: 1000 } as any;
    for (let i = 0; i < 12; i++) await t.broadcast(rec);
    expect(lines).toHaveLength(2); // first (status 403) + the 10th reminder
    expect(lines[0]).toContain('status 403');
  });
});

describe('server-boot wiring: lease transport timeout derivation (source-shape pin)', () => {
  it('server.ts derives requestTimeoutMs from leaseTtlMs (min(ttl/2, 30s))', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf-8');
    const idx = src.indexOf('new HttpLeaseTransport({');
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 1600);
    expect(block).toContain('requestTimeoutMs: Math.min(seamlessness.leaseTtlMs / 2, 30_000)');
  });
});
