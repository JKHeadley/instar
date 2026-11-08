/**
 * lease-restart-no-tie: both sides of the two decisions added for a store that holds only this
 * machine's own copy (fb-c51067c6-148): ask a peer before claiming, and do not claim over a
 * peer's live lease at our own lapsed epoch.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator, type LeaseStore, type LeaseTransport } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { LeaseRecord } from '../../src/core/types.js';

const KEYS: Record<string, { publicKey: string; privateKey: string }> = Object.fromEntries(['A', 'B'].map((id) => [id,
  crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } })]));
function crypt(self: string): LeaseCrypto {
  return {
    selfMachineId: self,
    sign: (c) => crypto.sign(null, Buffer.from(c), KEYS[self].privateKey).toString('base64'),
    verify: (c, sig, holder) => {
      const pub = KEYS[holder]?.publicKey;
      if (!pub) return false;
      try { return crypto.verify(null, Buffer.from(c), pub, Buffer.from(sig, 'base64')); } catch { return false; }
    },
  };
}
const TTL = 60_000;
const NOW = 1_000_000;
const fenced = (id: string) => new FencedLease(crypt(id), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });
const peerLease = (epoch: number, o: { expired?: boolean; released?: boolean; forged?: boolean } = {}): LeaseRecord => {
  const signed = fenced('A').signLease(epoch, new Date(NOW - 1_000).toISOString(),
    new Date(o.expired ? NOW - 1 : NOW + TTL).toISOString(), 50, o.released);
  return o.forged ? { ...signed, signature: 'AAAA' } : signed;
};

function rig(o: { ownEpoch?: number | null; answer?: LeaseRecord | null; shared?: boolean; survivor?: boolean; solo?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-no-tie-'));
  const file = path.join(dir, 'lease.json');
  const ownEpoch = o.ownEpoch === undefined ? 7 : o.ownEpoch;
  if (ownEpoch !== null) {
    const own = fenced('B').signLease(ownEpoch, new Date(1).toISOString(), new Date(2).toISOString(), 5);
    fs.writeFileSync(file, JSON.stringify({ lease: own }));
  }
  const local = new LocalLeaseStore({ filePath: file });
  const store: LeaseStore = o.shared
    ? { read: () => local.read(), casWrite: (c) => local.casWrite(c), refresh: (l) => local.refresh(l) }
    : local;
  let seen: LeaseRecord | null = null;
  let pulls = 0;
  const tunnel: LeaseTransport & { pullAllPeers: () => Promise<void> } = {
    broadcast: async () => false,
    observed: () => ({ lease: seen, lastNonceByHolder: seen ? { [seen.holder]: seen.nonce } : {} }),
    isReachable: () => false,
    pullAllPeers: async () => { pulls++; seen = o.answer ?? null; },
  };
  const lc = new LeaseCoordinator({
    lease: fenced('B'), store, tunnel,
    presumedDeadHolders: () => new Set(),
    now: () => NOW, monotonicNow: () => NOW,
    soloCaptainHold: () => (o.solo ? { enabled: true } : null),
    survivorMayHold: () => o.survivor ?? true,
  });
  return { lc, pulls: () => pulls, cleanup: () => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/lease-restart-no-tie.test.ts' }) };
}
async function run(o: Parameters<typeof rig>[0]) {
  const r = rig(o);
  try {
    return { acquired: await r.lc.acquireIfEligible(), pulls: r.pulls(), epoch: r.lc.currentEpoch(), holds: r.lc.holdsLease() };
  } finally { r.cleanup(); }
}

describe('asking before claiming', () => {
  it('own copy only, lapsed lease: asks, and a higher live lease stops the claim', async () => {
    expect(await run({ answer: peerLease(8) })).toMatchObject({ acquired: false, pulls: 1, epoch: 8, holds: false });
  });
  it('own copy only, no lease at all: asks, and a live lease stops the claim', async () => {
    expect(await run({ ownEpoch: null, answer: peerLease(8) })).toMatchObject({ acquired: false, pulls: 1, holds: false });
  });
  it('own copy only, nobody answers: claims, so a real takeover is not blocked', async () => {
    expect(await run({ answer: null })).toMatchObject({ acquired: true, pulls: 1, epoch: 8, holds: true });
  });
  it('a shared store with the switch off does not ask', async () => {
    expect(await run({ shared: true, answer: null })).toMatchObject({ pulls: 0, acquired: true });
  });
  it('a shared store with the switch on asks about its own lapsed lease, as before', async () => {
    expect((await run({ shared: true, solo: true, answer: null })).pulls).toBe(1);
  });
  it('a shared store with the switch on and no lease does not ask, as before', async () => {
    expect((await run({ shared: true, solo: true, ownEpoch: null, answer: null })).pulls).toBe(0);
  });
  it('a single machine or a named pool does not ask', async () => {
    expect(await run({ survivor: false })).toMatchObject({ pulls: 0, acquired: true });
  });
});

describe('a peer lease at our own lapsed epoch', () => {
  it('live: no claim, and our epoch stays where it was', async () => {
    expect(await run({ answer: peerLease(7) })).toMatchObject({ acquired: false, pulls: 1, epoch: 7, holds: false });
  });
  it('expired: claims', async () => {
    expect(await run({ answer: peerLease(7, { expired: true }) })).toMatchObject({ acquired: true, epoch: 8 });
  });
  it('released: claims', async () => {
    expect(await run({ answer: peerLease(7, { released: true }) })).toMatchObject({ acquired: true, epoch: 8 });
  });
  it('with a bad signature: claims, because it proves nothing', async () => {
    expect(await run({ answer: peerLease(7, { forged: true }) })).toMatchObject({ acquired: true, epoch: 8 });
  });
  it('at a lower epoch: claims', async () => {
    expect(await run({ answer: peerLease(6) })).toMatchObject({ acquired: true, epoch: 8 });
  });
});

describe('the store says what it is', () => {
  it('LocalLeaseStore holds only this machine\'s copy', () => {
    expect(new LocalLeaseStore({ filePath: path.join(os.tmpdir(), 'unused-lease.json') }).hasNoSharedMedium()).toBe(true);
  });
});
