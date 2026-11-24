/**
 * takeover-ready-pool R1 (boot claim safety, fb-2bf6ccd0-705) — over real HTTP:
 *  - the AgentServer puts Instar's machine marker on every response, errors included;
 *  - a restarted non-preferred machine that cannot reach the preferred for 10 s does not claim;
 *  - a wedged preferred answering 503 (the real boot beacon, marker on) holds it back only for
 *    the unsigned-answer window;
 *  - a dead preferred behind a tunnel whose edge answers 530 counts as silent;
 *  - a restarted former holder on a git store with no remote and stale local state, while the
 *    current holder is briefly unreachable, defers and then adopts the holder's epoch.
 * Real LeaseCoordinator, LocalLeaseStore / GitLeaseStore, HttpLeaseTransport and Ed25519 keys;
 * the coordinator's clock is driven by the test so 45 s and 225 s windows run instantly.
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { FencedLease, type LeaseCrypto } from '../../src/core/FencedLease.js';
import { LeaseCoordinator } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { GitLeaseStore } from '../../src/core/GitLeaseStore.js';
import { HttpLeaseTransport, instarMachineMarker } from '../../src/core/HttpLeaseTransport.js';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';
import { BootHealthBeacon } from '../../src/server/BootHealthBeacon.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { resolveBootClaimSafety } from '../../src/core/BootClaimHold.js';
import type { InstarConfig, LeaseRecord, MachineRegistry, MeshEndpoint } from '../../src/core/types.js';

const IDS = ['laptop', 'studio'] as const;
const KEYS = Object.fromEntries(IDS.map((id) => [id, crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})])) as Record<string, { publicKey: string; privateKey: string }>;
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
const fl = (id: string) => new FencedLease(crypt(id), { leaseTtlMs: TTL, failoverThresholdMs: 15 * 60_000 });
// The live config that caused the outage: a named preferred machine.
const SAFETY = () => resolveBootClaimSafety({ developmentAgent: true, multiMachine: { leaseSelfHeal: { preferredAwakeMachineId: 'studio' } } });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

async function listen(handler: http.RequestListener): Promise<number> {
  const srv = http.createServer(handler);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }));
  return (srv.address() as AddressInfo).port;
}
async function closedPort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-claim-int-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'boot-claim-safety-test-cleanup' }));
  return d;
}

/** The restarted Laptop: own lease-local.json says it held epoch 41 last, now lapsed. */
/**
 * The resolver accepts only real-looking addresses (a Tailscale 100.64/10 address, an https
 * tunnel host), so the peer is advertised that way and the real fetch is pointed at loopback.
 */
function peerAt(kind: 'tailscale' | 'cloudflare', port: number): { endpoint: MeshEndpoint; fetchImpl: typeof fetch } {
  const endpoint: MeshEndpoint = kind === 'tailscale'
    ? { kind, url: `http://100.64.0.9:${port}` }
    : { kind, url: 'https://studio.example.dev' };
  const fetchImpl = ((url: string, init?: RequestInit) =>
    fetch(url.replace(/^https:\/\/studio\.example\.dev/, `http://127.0.0.1:${port}`).replace('100.64.0.9', '127.0.0.1'), init)) as typeof fetch;
  return { endpoint, fetchImpl };
}

function restartedLaptop({ endpoint, fetchImpl }: { endpoint: MeshEndpoint; fetchImpl: typeof fetch }, clock: { wall: number }) {
  const dir = tmpDir();
  const file = path.join(dir, 'lease-local.json');
  fs.writeFileSync(file, JSON.stringify({ lease: fl('laptop').signLease(41, new Date(clock.wall - 10 * TTL).toISOString(), new Date(clock.wall - TTL).toISOString(), 3) }));
  const transport = new HttpLeaseTransport({
    selfMachineId: 'laptop',
    signingKeyPem: KEYS.laptop.privateKey,
    peers: () => [{ machineId: 'studio', url: endpoint.url, endpoints: [endpoint], publicKeyPem: KEYS.studio.publicKey, meshAckCapable: true }],
    nextSequence: () => Date.now(),
    fetchImpl,
    resolver: new PeerEndpointResolver({ config: { enabled: true, hedgeDelayMs: 5, priorityTailscale: 10, priorityLan: 20, priorityCloudflare: 30, tailscaleEnabled: true, lanSubnetGate: false, unhealthyAfterFailures: 1000, endpointEvictionMs: 3_600_000, maxProbeBackoffMs: 1, requestTimeoutMs: 5_000 } }),
    meshTransportEnabled: () => true,
    hedgeDelayMs: 5,
    requestTimeoutMs: 5_000,
    now: () => clock.wall,
  });
  const logs: string[] = [];
  const lc = new LeaseCoordinator({
    lease: fl('laptop'), store: new LocalLeaseStore({ filePath: file }), tunnel: transport,
    presumedDeadHolders: () => new Set(), now: () => clock.wall, monotonicNow: () => clock.wall,
    soloCaptainHold: () => ({ enabled: true }),
    survivorMayHold: () => false, // server.ts: false whenever a preferred machine is named
    bootClaimSafety: SAFETY,
    logger: (m) => logs.push(m),
  });
  return { lc, transport, logs };
}

/** Probe every 5 s (the pull loop's cadence) until the coordinator claims or `maxMs` passes. */
async function runUntilClaim(lc: LeaseCoordinator, clock: { wall: number }, maxMs: number): Promise<number | null> {
  const start = clock.wall;
  while (clock.wall - start <= maxMs) {
    if (await lc.acquireIfEligible()) return clock.wall - start;
    clock.wall += 5_000;
  }
  return null;
}

describe('Instar response marker on the real AgentServer', () => {
  it('rides every response: health, a refused request, a missing route', async () => {
    const dir = tmpDir();
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}');
    const config = { projectName: 'bcs', projectDir: dir, stateDir, port: 0, authToken: 'tok', requestTimeoutMs: 10_000, version: '0', sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [], monitorIntervalMs: 5000 }, scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], updates: {}, monitoring: {} } as unknown as InstarConfig;
    const server = new AgentServer({ config, sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => [], getSession: () => null } as never, state: new StateManager(stateDir), meshSelfId: 'studio' });
    cleanups.push(() => server.stop());
    const app = server.getApp();
    const want = instarMachineMarker('studio');
    for (const [method, url] of [['get', '/health'], ['get', '/jobs'], ['get', '/no-such-route-here'], ['post', '/api/lease/pull']] as const) {
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[method](url);
      expect(res.headers['x-instar-machine'], `${method} ${url} → ${res.status}`).toBe(want);
    }
  });
});

describe('boot claim safety over real HTTP (preferred machine named)', () => {
  it('a restarted non-preferred machine that cannot reach the preferred for 10 s does not claim', async () => {
    const clock = { wall: 50_000_000 };
    const port = await closedPort();
    const { lc, logs } = restartedLaptop(peerAt('tailscale', port), clock);
    expect(await runUntilClaim(lc, clock, 10_000)).toBeNull();
    expect(lc.holdsLease()).toBe(false);
    expect(logs.some((l) => /boot-hold: rule-2 defer/.test(l))).toBe(true);
  });

  it('a dead preferred machine (connection refused) is taken over after 3 silent probes over ≥45 s', async () => {
    const clock = { wall: 50_000_000 };
    const port = await closedPort();
    const { lc } = restartedLaptop(peerAt('tailscale', port), clock);
    const at = await runUntilClaim(lc, clock, 120_000);
    expect(at).toBe(45_000);
    expect(lc.currentEpoch()).toBe(42);
  });

  it('a wedged preferred answering 503 with its marker blocks only for the window, then is silent', async () => {
    const clock = { wall: 50_000_000 };
    const port = await closedPort();
    const beacon = new BootHealthBeacon(port, '127.0.0.1', instarMachineMarker('studio'));
    await beacon.start();
    cleanups.push(() => beacon.stop());
    const { lc, transport, logs } = restartedLaptop(peerAt('tailscale', port), clock);
    const at = await runUntilClaim(lc, clock, 400_000);
    expect(transport.probeHistory().get('studio')!.probes.some((p) => p.answer === 'unsigned')).toBe(true);
    expect(logs.some((l) => /boot-hold: rule-3 defer/.test(l))).toBe(true);
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThan(225_000); // never inside the interim window
    expect(at!).toBeLessThanOrEqual(225_000 + 45_000 + 5_000); // and not for ever
  });

  it('a dead preferred behind a tunnel whose edge answers 530 counts as silent', async () => {
    const clock = { wall: 50_000_000 };
    const port = await listen((_req, res) => { res.writeHead(530, { 'content-type': 'text/html' }); res.end('<h1>Error 1033</h1>'); });
    const { lc, transport } = restartedLaptop(peerAt('cloudflare', port), clock);
    const at = await runUntilClaim(lc, clock, 120_000);
    expect(transport.probeHistory().get('studio')!.probes.every((p) => p.answer === 'silent')).toBe(true);
    expect(at).toBe(45_000);
  });

  it('control: the same tunnel carrying the peer\'s own 503 with its marker is an answer (rule 3)', async () => {
    const clock = { wall: 50_000_000 };
    const port = await listen((_req, res) => { res.writeHead(503, { 'x-instar-machine': instarMachineMarker('studio') }); res.end('{"error":"starting"}'); });
    const { lc, transport, logs } = restartedLaptop(peerAt('cloudflare', port), clock);
    expect(await runUntilClaim(lc, clock, 120_000)).toBeNull();
    expect(transport.probeHistory().get('studio')!.probes.every((p) => p.answer === 'unsigned')).toBe(true);
    expect(logs.some((l) => /boot-hold: rule-3 defer/.test(l))).toBe(true);
  });

  it('a tunnel error page carrying no marker (502 from the edge) is silent too', async () => {
    const clock = { wall: 50_000_000 };
    const port = await listen((_req, res) => { res.writeHead(502); res.end('bad gateway'); });
    const { lc } = restartedLaptop(peerAt('cloudflare', port), clock);
    expect(await runUntilClaim(lc, clock, 120_000)).toBe(45_000);
  });
});

describe('restarted former holder, git store with no remote, holder briefly unreachable', () => {
  it('defers while the holder is unreachable, then adopts its epoch without contesting', async () => {
    const clock = { wall: 70_000_000 };
    // B (laptop) held epoch 41 in its own git registry; A (studio) took over at 42 while it was down.
    const box = { reg: { machines: { laptop: {}, studio: {} }, lease: fl('laptop').signLease(41, new Date(clock.wall - 20 * TTL).toISOString(), new Date(clock.wall - 10 * TTL).toISOString(), 3) } as unknown as MachineRegistry };
    const store = new GitLeaseStore({
      machineId: 'laptop',
      loadRegistry: () => JSON.parse(JSON.stringify(box.reg)),
      saveRegistry: (r) => { box.reg = JSON.parse(JSON.stringify(r)); },
      registryAbsPath: '/tmp/registry.json',
      pullRebase: () => true, // a pull from nowhere "succeeds" and changes nothing
      commitAndPush: () => false,
      hasNoRemote: () => true,
      localCommitIsFinal: () => true,
    });
    let holderUp = false;
    const holderLease = (): LeaseRecord => fl('studio').signLease(42, new Date(clock.wall - 30_000).toISOString(), new Date(clock.wall + TTL).toISOString(), Math.floor(clock.wall / 1000));
    const port = await listen((req, res) => {
      if (!holderUp) { req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ lease: holderLease() }));
    });
    const transport = new HttpLeaseTransport({
      selfMachineId: 'laptop', signingKeyPem: KEYS.laptop.privateKey,
      peers: () => [{ machineId: 'studio', url: `http://127.0.0.1:${port}` }],
      nextSequence: () => Date.now(), requestTimeoutMs: 5_000, now: () => clock.wall,
    });
    const logs: string[] = [];
    const lc = new LeaseCoordinator({
      lease: fl('laptop'), store, tunnel: transport, presumedDeadHolders: () => new Set(),
      now: () => clock.wall, monotonicNow: () => clock.wall,
      soloCaptainHold: () => ({ enabled: true }), survivorMayHold: () => false,
      bootClaimSafety: SAFETY, logger: (m) => logs.push(m),
    });
    // Unreachable for 30 s: three probes, span too short — no claim from the stale git copy.
    for (let t = 0; t <= 30_000; t += 10_000) {
      expect(await lc.acquireIfEligible()).toBe(false);
      clock.wall += 10_000;
    }
    expect(box.reg.lease?.epoch).toBe(41);
    holderUp = true;
    expect(await lc.acquireIfEligible()).toBe(false);
    expect(lc.currentHolder()).toBe('studio');
    expect(lc.currentEpoch()).toBe(42);
    expect(lc.bootHoldActive()).toBe(false);
    expect(box.reg.lease?.epoch).toBe(41); // nothing written
    expect(logs.some((l) => /boot-hold: rule-4 end/.test(l))).toBe(true);
  });
});
