/**
 * Integration — multi-transport-mesh-comms 2-server hedged failover.
 * Stands up TWO real express servers (peer B has a working /api/lease + accept-ack
 * receiver). Peer A's HttpLeaseTransport advertises B over two ropes: a DEAD rope
 * (an unused port that connection-refuses) and B's REAL rope. Asserts the broadcast
 * confirms over the working rope (the dead one is failed, not fatal), and that a
 * STRANGER server returning 200 with no/forged ack is rejected.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineIdentityManager, generateSigningKeyPair, generateMachineId, pemToBase64, type MachineIdentity } from '../../src/core/MachineIdentity.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { HeartbeatManager } from '../../src/core/HeartbeatManager.js';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import { HttpLeaseTransport, type LeasePeer } from '../../src/core/HttpLeaseTransport.js';
import { PeerEndpointResolver, type PeerEndpointResolverConfig } from '../../src/core/PeerEndpointResolver.js';
import type { MachineAuthDeps } from '../../src/server/machineAuth.js';
import type { LeaseRecord, MeshEndpoint } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const servers: Server[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of tmpDirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mesh-failover-2server.test.ts:afterEach' });
});

function listen(app: express.Express, host = '127.0.0.1'): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, host, () => {
      servers.push(server);
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

/**
 * The resolver (correctly) rejects loopback as a forbidden mesh host, so a LAN-rope
 * integration test needs a REAL private IPv4 + a CIDR for the subnet gate. Returns
 * null when the box has no private IPv4 (e.g. a minimal CI runner) → the test skips
 * honestly (the real LAN/Tailscale ropes are exercised in live-verify regardless).
 */
function ownPrivateIpv4(): { ip: string; cidr: string } | null {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      const isV4 = a.family === 'IPv4' || (a.family as unknown as number) === 4;
      if (isV4 && !a.internal && typeof a.cidr === 'string' && /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(a.address)) {
        return { ip: a.address, cidr: a.cidr };
      }
    }
  }
  return null;
}

/** A real receiver server for machine B (folds the lease, signs the accept-ack). */
async function startReceiver(opts: { selfId: string; selfKeys: { publicKey: string; privateKey: string }; callerId: string; callerPub: string; foldEpoch: number; host?: string }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-recv-'));
  tmpDirs.push(tmpDir);
  const idMgr = new MachineIdentityManager(tmpDir);
  const selfIdentity: MachineIdentity = {
    machineId: opts.selfId, signingPublicKey: pemToBase64(opts.selfKeys.publicKey),
    encryptionPublicKey: 'unused', name: 'B', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
  };
  const callerIdentity: MachineIdentity = {
    machineId: opts.callerId, signingPublicKey: pemToBase64(opts.callerPub),
    encryptionPublicKey: 'unused', name: 'A', platform: 'test', createdAt: new Date().toISOString(), capabilities: ['sessions'],
  };
  fs.mkdirSync(path.join(tmpDir, 'machine'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'machine', 'identity.json'), JSON.stringify(selfIdentity));
  idMgr.registerMachine(selfIdentity, 'awake');
  idMgr.registerMachine(callerIdentity, 'standby');
  idMgr.storeRemoteIdentity(callerIdentity);

  const nonceStore = new NonceStore(path.join(tmpDir, 'nonces'));
  const securityLog = new SecurityLog(tmpDir);
  securityLog.initialize();
  const authDeps: MachineAuthDeps = { identityManager: idMgr, nonceStore, securityLog, localMachineId: opts.selfId };
  const routes = createMachineRoutes({
    identityManager: idMgr,
    heartbeatManager: new HeartbeatManager(tmpDir, opts.selfId),
    securityLog,
    authDeps,
    localMachineId: opts.selfId,
    localSigningKeyPem: opts.selfKeys.privateKey,
    onLeaseReceived: () => opts.foldEpoch,
    onLeasePullRequest: () => null,
  });
  const app = express();
  app.use(express.json());
  app.use(routes);
  return listen(app, opts.host);
}

function mkTransport(peerFactory: () => LeasePeer[], callerId: string, callerKey: string, ownCidr?: string) {
  const cfg: PeerEndpointResolverConfig = {
    enabled: true, hedgeDelayMs: 30, priorityTailscale: 10, priorityLan: 20, priorityCloudflare: 30,
    tailscaleEnabled: true, lanSubnetGate: !!ownCidr, unhealthyAfterFailures: 3,
    endpointEvictionMs: 3_600_000, maxProbeBackoffMs: 300_000, requestTimeoutMs: 5_000,
  };
  const resolver = new PeerEndpointResolver({ config: cfg, ownCidrs: () => (ownCidr ? [ownCidr] : []) });
  let seq = 1;
  return new HttpLeaseTransport({
    selfMachineId: callerId,
    signingKeyPem: callerKey,
    peers: peerFactory,
    nextSequence: () => ++seq,
    resolver,
    meshTransportEnabled: () => true,
    hedgeDelayMs: 30,
    requestTimeoutMs: 5_000,
  });
}

function mkLease(holder: string, epoch: number): LeaseRecord {
  return { holder, epoch, acquiredAt: '2026-06-20T00:00:00Z', expiresAt: '2026-06-20T00:01:00Z', nonce: epoch } as LeaseRecord;
}

describe('mesh 2-server hedged failover (integration)', () => {
  it('confirms over the working LAN rope when a higher-priority rope is dead', async () => {
    const lan = ownPrivateIpv4();
    if (!lan) {
      console.log('[mesh-failover] SKIP: no private IPv4 on this host (real LAN/Tailscale ropes are exercised in live-verify)');
      return;
    }
    const aKeys = generateSigningKeyPair();
    const bKeys = generateSigningKeyPair();
    const aId = generateMachineId();
    const bId = generateMachineId();

    // The receiver listens on 0.0.0.0 so it answers on the LAN IP.
    const recv = await startReceiver({ selfId: bId, selfKeys: bKeys, callerId: aId, callerPub: aKeys.publicKey, foldEpoch: 7, host: '0.0.0.0' });

    // B advertises a DEAD tailscale rope (CGNAT addr nothing listens on) + a REAL
    // lan rope (the live receiver on the box's private IP). The dead rope must not
    // stop the confirm — the transport hedges to the working lan rope.
    const peerEndpoints: MeshEndpoint[] = [
      { kind: 'tailscale', url: `http://100.64.0.254:${recv.port}` }, // CGNAT, unreachable
      { kind: 'lan', url: `http://${lan.ip}:${recv.port}` },
    ];
    const transport = mkTransport(
      () => [{ machineId: bId, url: `http://${lan.ip}:${recv.port}`, endpoints: peerEndpoints, publicKeyPem: bKeys.publicKey, meshAckCapable: true }],
      aId, aKeys.privateKey, lan.cidr,
    );

    const ok = await transport.broadcast(mkLease(aId, 7));
    expect(ok).toBe(true); // confirmed over the live lan rope despite the dead tailscale one
    expect(transport.isReachable()).toBe(true);
  });

  it('a stranger server (200 but no valid ack) is NOT counted as confirmed', async () => {
    const aKeys = generateSigningKeyPair();
    const bKeys = generateSigningKeyPair();
    const aId = generateMachineId();
    const bId = generateMachineId();

    // A "stranger" server that 200s every /api/lease with a bare ok (no ack).
    const strangerApp = express();
    strangerApp.use(express.json());
    strangerApp.post('/api/lease', (_req, res) => res.json({ ok: true }));
    const stranger = await listen(strangerApp);

    const peerEndpoints: MeshEndpoint[] = [{ kind: 'lan', url: `http://127.0.0.1:${stranger.port}` }];
    const transport = mkTransport(
      () => [{ machineId: bId, url: `http://127.0.0.1:${stranger.port}`, endpoints: peerEndpoints, publicKeyPem: bKeys.publicKey, meshAckCapable: true }],
      aId, aKeys.privateKey,
    );

    const ok = await transport.broadcast(mkLease(aId, 7));
    expect(ok).toBe(false); // ack-capable peer + no valid ack ⇒ FAILED rope
  });
});
