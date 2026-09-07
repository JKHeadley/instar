import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { StateManager } from '../../src/core/StateManager.js';
import { FencedLease } from '../../src/core/FencedLease.js';
import { LeaseCoordinator } from '../../src/core/LeaseCoordinator.js';
import { LocalLeaseStore } from '../../src/core/LocalLeaseStore.js';
import { HttpLeaseTransport } from '../../src/core/HttpLeaseTransport.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

export async function originLeaseDependencyFixture(options: { enroll?: boolean; enabled?: boolean; developmentAgent?: boolean;
  clock?: { value: number }; observeOnly?: boolean } = {}) {
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
    peers: () => [], nextSequence: () => ++sequence, now });
  const store = new LocalLeaseStore({ filePath: path.join(stateDir, 'state/fenced-lease.json') });
  const lc = new LeaseCoordinator({ lease, store, tunnel: transport, presumedDeadHolders: () => new Set(), now,
    ...(options.clock ? { monotonicNow: now } : {}) });
  const config = { stateDir, developmentAgent: options.developmentAgent,
    multiMachine: { leaseSelfHeal: { resilientRenew: { enabled: options.enabled },
      ...(options.observeOnly ? { leaseRole: 'observe-only' as const } : {}) } } };
  const coordinator = new MultiMachineCoordinator(new StateManager(stateDir), config);
  coordinator.start();
  const release = options.enroll === false ? () => undefined : coordinator.enrollOriginWriterLeaseRenewal();
  coordinator.attachLeaseCoordinator(lc);
  await coordinator.initializeLease();
  return { root, stateDir, identity, config, coordinator, lc, store, transport, peerLease, release,
    close: async () => { release(); coordinator.stop(); await SafeFsExecutor.safeRm(root, { recursive: true, force: true, operation: 'test:origin-lease-dependency:cleanup' }); } };
}
