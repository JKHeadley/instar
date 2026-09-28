import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { StateManager } from '../../src/core/StateManager.js';
import { FencedLease } from '../../src/core/FencedLease.js';
import { LeaseCoordinator } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { HttpLeaseTransport, type LeasePeer } from '../../src/core/HttpLeaseTransport.js';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

export async function originLeaseDependencyFixture(options: { enroll?: boolean; enabled?: boolean; developmentAgent?: boolean;
  clock?: { value: number }; observeOnly?: boolean;
  /** lease-renew-unreachable-peers: peers the renewal broadcast dials, over this fetch. */
  peers?: LeasePeer[]; fetchImpl?: typeof fetch; broadcastDeadlineMs?: number;
  /** Wire the production mesh resolver so signed accept-acks are verified (the ack-capable path). */
  mesh?: boolean;
  /** Solo-captain hold inputs (preferred captain + whether every peer is presumed gone). */
  soloCaptain?: { allPeersPresumedGone: boolean } } = {}) {
  const root = await mkdtemp('/tmp/origin-lease-dependency-'), stateDir = path.join(root, '.instar');
  await mkdir(stateDir);
  const identities = new MachineIdentityManager(stateDir);
  await identities.generateIdentity({ name: 'Origin fixture', role: 'awake' });
  const identity = identities.loadIdentity(), privateKey = identities.loadSigningKey();
  const peerKeys = generateKeyPairSync('ed25519');
  const peerPublic = peerKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const selfPublic = identities.getSigningPublicKeyPem(identity.machineId)!;
  const verifyLease = (bytes: string, signature: string, holder: string) => {
    const key = holder === identity.machineId ? selfPublic : holder === 'fixture-peer' ? peerPublic : null;
    return !!key && verify(null, Buffer.from(bytes), key, Buffer.from(signature, 'base64'));
  };
  const now = options.clock ? () => options.clock!.value : Date.now;
  const lease = new FencedLease({ selfMachineId: identity.machineId,
    sign: bytes => sign(null, Buffer.from(bytes), privateKey).toString('base64'), verify: verifyLease },
  { leaseTtlMs: 60_000, failoverThresholdMs: 15 * 60_000 });
  const peerLease = new FencedLease({ selfMachineId: 'fixture-peer',
    sign: bytes => sign(null, Buffer.from(bytes), peerKeys.privateKey).toString('base64'), verify: verifyLease },
  { leaseTtlMs: 60_000, failoverThresholdMs: 15 * 60_000 });
  let sequence = 0;
  const transport = new HttpLeaseTransport({ selfMachineId: identity.machineId, signingKeyPem: privateKey,
    peers: () => options.peers ?? [], nextSequence: () => ++sequence, now,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.broadcastDeadlineMs !== undefined ? { broadcastDeadlineMs: options.broadcastDeadlineMs } : {}),
    ...(options.mesh ? { resolver: new PeerEndpointResolver({ config: { enabled: true, hedgeDelayMs: 1500, priorityTailscale: 10,
      priorityLan: 20, priorityCloudflare: 30, tailscaleEnabled: true, lanSubnetGate: false, unhealthyAfterFailures: 3,
      endpointEvictionMs: 3_600_000, maxProbeBackoffMs: 300_000, requestTimeoutMs: 30_000 } }) } : {}) });
  const store = new LocalLeaseStore({ filePath: path.join(stateDir, 'state/fenced-lease.json') });
  const lc = new LeaseCoordinator({ lease, store, tunnel: transport, presumedDeadHolders: () => new Set(), now,
    ...(options.clock ? { monotonicNow: now } : {}),
    ...(options.soloCaptain ? { soloCaptainHold: () => ({ enabled: true }), isPreferredAwakeAgreed: () => true,
      allPeersPresumedGone: () => options.soloCaptain!.allPeersPresumedGone } : {}) });
  const config = { stateDir, developmentAgent: options.developmentAgent,
    multiMachine: { leaseSelfHeal: { resilientRenew: { enabled: options.enabled },
      ...(options.observeOnly ? { leaseRole: 'observe-only' as const } : {}) } } };
  const coordinator = new MultiMachineCoordinator(new StateManager(stateDir), config);
  coordinator.start();
  const release = options.enroll === false ? () => undefined : coordinator.enrollOriginWriterLeaseRenewal();
  coordinator.attachLeaseCoordinator(lc);
  await coordinator.initializeLease();
  const peerPrivateKeyPem = peerKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { root, stateDir, identity, config, coordinator, lc, store, transport, peerLease, peerPublicKeyPem: peerPublic, peerPrivateKeyPem, release,
    close: async () => { release(); coordinator.stop(); await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-lease-dependency:cleanup' }); } };
}
