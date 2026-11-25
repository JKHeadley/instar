// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * planned-restart-keeps-lead (fb-135e3043-add) over real HTTP: the Studio's real HttpLeaseTransport
 * talks to a Laptop that answers the real `/api/lease` and `/api/lease/pull` shapes (signed acks over
 * the request nonce). The pending renewal reaches the peer with the window as its expiry; the boot
 * after the restart confirms the same epoch from the peer's identity-verified answer — on the mesh
 * dial and on the legacy single-url dial (which today read every answer as silence).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { featureEvidence } from '../../src/monitoring/FeatureEvidenceLog.js';
import { LeaseCoordinator } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { LeaseContinuityStore } from '../../src/core/LeaseContinuity.js';
import { HttpLeaseTransport } from '../../src/core/HttpLeaseTransport.js';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';
import { signLeaseAck } from '../../src/server/machineAuth.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { UNSIGNED_WINDOW_CEILING_MS } from '../../src/core/BootClaimHold.js';
import type { LeaseRecord, MeshEndpoint } from '../../src/core/types.js';

const IDS = ['studio', 'laptop'] as const;
const KEYS = Object.fromEntries(IDS.map((id) => [id, crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})])) as Record<string, { publicKey: string; privateKey: string }>;
function crypt(self: string): LeaseCrypto {
  return {
    selfMachineId: self,
    sign: (c) => crypto.sign(null, Buffer.from(c), KEYS[self].privateKey).toString('base64'),
    verify: (c, sig, holder) => { const pub = KEYS[holder]?.publicKey; if (!pub) return false; try { return crypto.verify(null, Buffer.from(c), pub, Buffer.from(sig, 'base64')); } catch { return false; } },
  };
}
const TTL = 60_000;
const WINDOW = 3 * TTL + 53_000;
const fl = (id: string) => new FencedLease(crypt(id), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prkl-int-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'planned-restart-lease-continuity-test-cleanup' }));
  return d;
}

/** The Laptop: folds broadcasts, answers pulls with its view, signs every ack over the request nonce. */
async function laptop(): Promise<{ port: number; received: LeaseRecord[]; view: { lease: LeaseRecord | null } }> {
  const received: LeaseRecord[] = [];
  const view: { lease: LeaseRecord | null } = { lease: null };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}') as { lease?: LeaseRecord; reqNonce?: string };
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/lease') {
        if (parsed.lease) { received.push(parsed.lease); if (!view.lease || parsed.lease.epoch >= view.lease.epoch) view.lease = parsed.lease; }
        const ack = { machineId: 'laptop', reqNonce: parsed.reqNonce ?? '', observedEpoch: parsed.lease?.epoch ?? 0 };
        res.end(JSON.stringify(parsed.reqNonce ? { ok: true, ack, sig: signLeaseAck(ack, KEYS.laptop.privateKey) } : { ok: true }));
        return;
      }
      if (req.url === '/api/lease/pull') {
        const ack = { machineId: 'laptop', reqNonce: parsed.reqNonce ?? '', observedEpoch: view.lease?.epoch ?? -1 };
        res.end(JSON.stringify(parsed.reqNonce ? { lease: view.lease, ack, sig: signLeaseAck(ack, KEYS.laptop.privateKey) } : { lease: view.lease }));
        return;
      }
      res.end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  return { port: (srv.address() as AddressInfo).port, received, view };
}

function studio(dir: string, port: number, clock: { wall: number; mono: number }, mode: 'mesh' | 'legacy') {
  const f = fl('studio');
  const endpoint: MeshEndpoint = { kind: 'tailscale', url: `http://100.64.0.9:${port}` };
  const fetchImpl = ((url: string, init?: RequestInit) => fetch(url.replace('100.64.0.9', '127.0.0.1'), init)) as typeof fetch;
  const transport = new HttpLeaseTransport({
    selfMachineId: 'studio',
    signingKeyPem: KEYS.studio.privateKey,
    peers: () => [mode === 'mesh'
      ? { machineId: 'laptop', url: endpoint.url, endpoints: [endpoint], publicKeyPem: KEYS.laptop.publicKey, meshAckCapable: true }
      : { machineId: 'laptop', url: `http://127.0.0.1:${port}`, publicKeyPem: KEYS.laptop.publicKey }],
    nextSequence: () => Date.now(),
    fetchImpl,
    resolver: new PeerEndpointResolver({ config: { enabled: true, hedgeDelayMs: 5, priorityTailscale: 10, priorityLan: 20, priorityCloudflare: 30, tailscaleEnabled: true, lanSubnetGate: false, unhealthyAfterFailures: 1000, endpointEvictionMs: 3_600_000, maxProbeBackoffMs: 1, requestTimeoutMs: 5_000 } }),
    meshTransportEnabled: () => mode === 'mesh',
    hedgeDelayMs: 5,
    requestTimeoutMs: 5_000,
    now: () => clock.wall,
  });
  const store = new LocalLeaseStore({ filePath: path.join(dir, 'state', 'lease-local.json') });
  const continuity = new LeaseContinuityStore({
    stateDir: dir, selfMachineId: 'studio',
    sign: (c) => f.signContinuityMeta(c), verify: (c, s, h) => f.verifyContinuityMeta(c, s, h), verifyLease: (l) => f.verifyLease(l),
    unsignedCeilingMs: UNSIGNED_WINDOW_CEILING_MS, now: () => clock.wall,
  });
  const logs: string[] = [];
  const lc = new LeaseCoordinator({
    lease: f, store, tunnel: transport, continuity,
    presumedDeadHolders: () => new Set(),
    now: () => clock.wall, monotonicNow: () => clock.mono,
    soloCaptainHold: () => ({ enabled: false }), survivorMayHold: () => true,
    bootClaimSafety: () => ({ enabled: true, preferredMachineId: 'studio' }),
    plannedRestartContinuity: () => ({ enabled: true, windowMs: null }),
    renewIntervalMs: () => 30_000, broadcastDeadlineMs: () => 8_000,
    readRequestFile: () => ({ present: false }),
    findConsumption: () => ({ record: null, coverage: 'full' }),
    logger: (m) => logs.push(m),
  });
  return { lc, transport, store, continuity, logs };
}

for (const mode of ['mesh', 'legacy'] as const) {
  describe(`planned restart keeps the lead over real HTTP (${mode} dial)`, () => {
    it('the pending renewal reaches the peer with the window; the boot after the restart confirms the same epoch', async () => {
      const dir = tmpDir();
      const clock = { wall: 1_700_000_000_000, mono: 1_000 };
      const peer = await laptop();
      const a = studio(dir, peer.port, clock, mode);
      await a.lc.pullFromPeers();
      expect(await a.lc.acquireIfEligible()).toBe(true);
      const epoch = a.lc.currentEpoch();
      expect(peer.received.at(-1)?.epoch).toBe(epoch);
      // The role-change announce: the window renewal goes to the peer before the request is visible.
      const outcome = await a.lc.beginPendingRestart({ requestedBy: 'role-change', reason: 'this machine took the lease', requestedAt: new Date(clock.wall).toISOString() });
      expect(outcome).toBe('confirmed');
      const extended = peer.received.at(-1)!;
      expect(extended.epoch).toBe(epoch);
      expect(Date.parse(extended.expiresAt)).toBe(clock.wall + WINDOW);
      expect(a.continuity.read().verdict).toBe('ok');
      expect(a.lc.stampContinuityExit()).toBe(true);
      // The restart: 2 minutes of boot, past the TTL. The peer's view still names the Studio.
      clock.wall += 120_000; clock.mono += 120_000;
      const b = studio(dir, peer.port, clock, mode);
      expect(b.lc.bootReclaimPending()).toBe(true);
      expect(b.lc.holdsLease()).toBe(false);
      await b.lc.pullFromPeers();
      expect(b.transport.probeHistory().get('laptop')!.probes.at(-1)!.answer).toBe('signed'); // identity-verified on BOTH dials
      expect(b.transport.verifiedAnswers().get('laptop')?.lease?.epoch).toBe(epoch);
      expect(await b.lc.acquireIfEligible()).toBe(true);
      expect(b.lc.holdsLease()).toBe(true);
      expect(b.lc.currentEpoch()).toBe(epoch);
      expect(b.lc.currentHolder()).toBe('studio');
      expect(peer.received.at(-1)!.epoch).toBe(epoch);
      expect(Date.parse(peer.received.at(-1)!.expiresAt)).toBe(clock.wall + TTL); // back to the TTL
      expect(fs.existsSync(b.continuity.filePath)).toBe(false);
      expect(b.store.readPendingEpisodeId()).toBeNull();
      expect(b.continuity.bootSamplesMs()).toEqual([120_000]);
      expect(b.logs.some((l) => l.includes('keeps the lead'))).toBe(true);
      const record = vi.spyOn(featureEvidence, 'record').mockReturnValue(null);
      try {
        for (let renewal = 1; renewal <= 4; renewal++) {
          clock.wall += 1_000; clock.mono += 1_000;
          expect(await b.lc.renew()).toBe(true);
        }
        const observations = record.mock.calls.filter(([id]) => id === 'multiMachine.postRestartRenewal');
        expect(observations.map(([, row]) => row.context?.attempt)).toEqual([1, 1, 2, 2, 3, 3]);
        expect(observations[0][1]).toMatchObject({
          reason: 'ordinary renewal started',
          context: { epoch, sinceReclaimMs: 1_000 },
        });
        expect(observations[1][1]).toMatchObject({
          reason: 'ordinary renewal confirmed',
          context: { epoch, nonce: observations[0][1].context?.nonce },
        });
      } finally {
        record.mockRestore();
      }
    });

    it('a peer that took a newer epoch meanwhile supersedes the window lease', async () => {
      const dir = tmpDir();
      const clock = { wall: 1_700_000_000_000, mono: 1_000 };
      const peer = await laptop();
      const a = studio(dir, peer.port, clock, mode);
      await a.lc.pullFromPeers();
      expect(await a.lc.acquireIfEligible()).toBe(true);
      const epoch = a.lc.currentEpoch();
      expect(await a.lc.beginPendingRestart({ requestedBy: 'auto-updater', reason: 'update', requestedAt: new Date(clock.wall).toISOString() })).toBe('confirmed');
      clock.wall += 120_000; clock.mono += 120_000;
      peer.view.lease = fl('laptop').signLease(epoch + 1, new Date(clock.wall - 5_000).toISOString(), new Date(clock.wall + TTL).toISOString(), 77);
      const b = studio(dir, peer.port, clock, mode);
      await b.lc.pullFromPeers();
      expect(await b.lc.acquireIfEligible()).toBe(false);
      expect(b.lc.holdsLease()).toBe(false);
      expect(b.lc.currentHolder()).toBe('laptop');
      expect(b.lc.currentEpoch()).toBe(epoch + 1);
      expect(b.lc.bootReclaimPending()).toBe(false);
      expect(fs.existsSync(b.continuity.filePath)).toBe(false);
    });
  });
}
