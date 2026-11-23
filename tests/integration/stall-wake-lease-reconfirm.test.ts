/**
 * stall-wake-lease-reconfirm (fb-fdb55c1c-a79) — over real HTTP. A real HttpLeaseTransport
 * dials a real HTTP server standing in for the Studio's lease route, and the real
 * LeaseCoordinator + LocalLeaseStore decide. The coordinator's clock is driven by the test, so
 * the 226 s stall and the 45 s / 60 s windows run instantly.
 *  - the Studio renewing while the Laptop stalls 226 s: switch off claims (the incident), switch
 *    on pulls over HTTP, folds the fresh signed renewal and does not claim;
 *  - the Studio dead after the stall (connection refused): taken over one TTL awake after the
 *    stall (on two machines no other peer proves this machine's network works), never at wake;
 *  - no stall: the lapse is claimed at the same moment with the switch on or off.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { HttpLeaseTransport } from '../../src/core/HttpLeaseTransport.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resolveStallReconfirm } from '../../src/core/StallReconfirm.js';
import { resolveBootClaimSafety } from '../../src/core/BootClaimHold.js';
import type { LeaseRecord } from '../../src/core/types.js';

const IDS = ['laptop', 'studio'] as const;
const KEYS = Object.fromEntries(IDS.map((id) => [id, crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})])) as Record<string, { publicKey: string; privateKey: string }>;
function crypt(self: string): LeaseCrypto {
  return {
    selfMachineId: self,
    sign: (c) => crypto.sign(null, Buffer.from(c), KEYS[self].privateKey).toString('base64'),
    verify: (c, sig, holder) => {
      const pub = KEYS[holder as 'laptop' | 'studio']?.publicKey;
      if (!pub) return false;
      try { return crypto.verify(null, Buffer.from(c), pub, Buffer.from(sig, 'base64')); } catch { return false; }
    },
  };
}
const TTL = 60_000;
const fl = (id: string) => new FencedLease(crypt(id), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });
// The live Echo posture: development agent, Studio named preferred.
const CONFIG = (stall: boolean) => ({
  developmentAgent: true,
  multiMachine: { leaseSelfHeal: { preferredAwakeMachineId: 'studio' }, takeoverReadyPool: { stallReconfirm: { enabled: stall } } },
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function studioServer(state: { up: boolean; lease: () => LeaseRecord | null }): Promise<number> {
  const srv = http.createServer((req, res) => {
    if (!state.up) { req.socket.destroy(); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ lease: state.lease() }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  return (srv.address() as AddressInfo).port;
}

function laptop(port: number, clock: { wall: number }, stall: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-reconfirm-int-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'stall-wake-lease-reconfirm-test-cleanup' }));
  const transport = new HttpLeaseTransport({
    selfMachineId: 'laptop', signingKeyPem: KEYS.laptop.privateKey,
    peers: () => [{ machineId: 'studio', url: `http://127.0.0.1:${port}` }],
    nextSequence: () => Date.now(), requestTimeoutMs: 5_000, now: () => clock.wall,
  });
  const logs: string[] = [];
  const config = CONFIG(stall);
  const lc = new LeaseCoordinator({
    lease: fl('laptop'), store: new LocalLeaseStore({ filePath: path.join(dir, 'lease-local.json') }), tunnel: transport,
    presumedDeadHolders: () => new Set(), now: () => clock.wall, monotonicNow: () => clock.wall,
    survivorMayHold: () => false,
    bootClaimSafety: () => resolveBootClaimSafety(config),
    stallReconfirm: () => resolveStallReconfirm(config), // the production resolution
    logger: (m) => logs.push(m),
  });
  return { lc, transport, logs };
}

/** The Studio, renewing: its lease as signed at the current clock. */
function renewing(clock: { wall: number }) {
  let nonce = 500;
  return () => fl('studio').signLease(23760, new Date(clock.wall - 3.5 * 3_600_000).toISOString(), new Date(clock.wall + TTL).toISOString(), ++nonce);
}

/** Boot, see the Studio holding, run the 5 s pull loop for a while: the boot hold ends. */
async function steady(lc: LeaseCoordinator, clock: { wall: number }) {
  expect(await lc.acquireIfEligible()).toBe(false);
  expect(lc.bootHoldActive()).toBe(false);
  for (let i = 0; i < 4; i++) { clock.wall += 5_000; await lc.pullFromPeers(); }
  expect(lc.currentHolder()).toBe('studio');
}

describe('stall reconfirm over real HTTP', () => {
  it('switch off: the 226 s stall ends in a claim on the aged copy (the incident)', async () => {
    const clock = { wall: 1_795_000_000_000 };
    const state = { up: true, lease: renewing(clock) as () => LeaseRecord | null };
    const { lc } = laptop(await studioServer(state), clock, false);
    await steady(lc, clock);
    clock.wall += 226_000;
    expect(await lc.acquireIfEligible()).toBe(true);
    expect(lc.currentEpoch()).toBe(23761);
  });

  it('switch on: the holder is re-asked over HTTP, its fresh renewal lands, no claim', async () => {
    const clock = { wall: 1_795_000_000_000 };
    const state = { up: true, lease: renewing(clock) as () => LeaseRecord | null };
    const { lc, logs, transport } = laptop(await studioServer(state), clock, true);
    await steady(lc, clock);
    clock.wall += 226_000;
    expect(await lc.acquireIfEligible()).toBe(false);
    expect(lc.currentHolder()).toBe('studio');
    expect(lc.currentEpoch()).toBe(23760);
    expect(transport.observedByPeer().get('studio')!.observedAtMs).toBe(clock.wall); // the fresh pull
    expect(logs.some((l) => /stall-reconfirm: opened/.test(l))).toBe(true);
    expect(logs.some((l) => /acquire skipped: held-by-live-peer/.test(l))).toBe(true);
  });

  it('switch on, the Studio dead after the stall: taken over one TTL awake later (two machines), not at wake', async () => {
    const clock = { wall: 1_795_000_000_000 };
    const state = { up: true, lease: renewing(clock) as () => LeaseRecord | null };
    const { lc, logs } = laptop(await studioServer(state), clock, true);
    await steady(lc, clock);
    state.up = false;
    clock.wall += 226_000;
    const woke = clock.wall;
    let at: number | null = null;
    for (let i = 0; i < 30 && at === null; i++) {
      if (await lc.acquireIfEligible()) at = clock.wall - woke;
      else { clock.wall += 5_000; await lc.pullFromPeers(); }
    }
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThanOrEqual(45_000);
    expect(at!).toBeLessThanOrEqual(60_000);
    expect(lc.currentEpoch()).toBe(23761);
    // A two-machine pool: no other peer can show this machine's network works, so C decides (one TTL awake).
    expect(at).toBe(60_000);
    expect(logs.some((l) => /stall-reconfirm: claim allowed \(awake-ttl\)/.test(l))).toBe(true);
  });

  for (const on of [false, true]) {
    it(`no stall, switch ${on ? 'on' : 'off'}: a holder that stops answering is taken over when its lease lapses`, async () => {
      const clock = { wall: 1_795_000_000_000 };
      const state = { up: true, lease: renewing(clock) as () => LeaseRecord | null };
      const { lc } = laptop(await studioServer(state), clock, on);
      await steady(lc, clock);
      state.up = false;
      const start = clock.wall;
      let at: number | null = null;
      for (let i = 0; i < 40 && at === null; i++) {
        clock.wall += 5_000;
        await lc.pullFromPeers();
        if (await lc.acquireIfEligible()) at = clock.wall - start;
      }
      expect(at).toBe(60_000);
      expect(lc.stallEpisodeOpen()).toBeNull();
    });
  }
});
