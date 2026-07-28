import readline from 'node:readline';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { MachineSshIdentity } from '../../src/core/MachineSshIdentity.js';
import { SshPeerAdmissionStore } from '../../src/core/SshPeerAdmissionStore.js';
import { canonicalSshResponse, MachineSshEndpoint } from '../../src/core/MachineSshEndpoint.js';
import { MutualSshVerifier } from '../../src/core/MutualSshVerifier.js';

const [stateDir, machineId] = process.argv.slice(2);
const identity = new MachineSshIdentity(stateDir, 'agent', machineId).ensure();
const machineKeys = generateKeyPairSync('ed25519');
const machinePublicPem = machineKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
let endpoint: MachineSshEndpoint | null = null;

function send(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
send({ type: 'ready', machineId, clientPublicKey: identity.clientPublicKey, hostPublicKey: identity.hostPublicKey, machinePublicPem });

readline.createInterface({ input: process.stdin }).on('line', async line => {
  try {
    const message = JSON.parse(line) as Record<string, any>;
    if (message.type === 'start') {
      const admissions = new SshPeerAdmissionStore(stateDir);
      admissions.reconcile([{ agentId: 'agent', machineId: message.peerMachineId, pairingEpoch: 1, clientGeneration: 1, observerBootId: message.peerBootId, publicKey: message.peerClientPublicKey, expiresAt: new Date(Date.now() + 120_000).toISOString() }]);
      endpoint = new MachineSshEndpoint({
        hostPrivateKeyPath: identity.hostPrivateKeyPath, admissionStore: admissions,
        machineId, machineFingerprint: `fp-${machineId}`, hostGeneration: 1,
        respond: (challenge, admission) => {
          const unsigned = { ...challenge, machineId, machineFingerprint: `fp-${machineId}`, sourceClientKeyFingerprint: MachineSshIdentity.fingerprint(admission.publicKey) };
          return { ...unsigned, signature: sign(null, Buffer.from(canonicalSshResponse(unsigned)), machineKeys.privateKey).toString('base64') };
        },
      });
      send({ type: 'started', ...(await endpoint.listen('127.0.0.1', 0)) });
    } else if (message.type === 'probe') {
      const proof = await new MutualSshVerifier().probe({
        sourceMachineId: machineId, targetMachineId: message.targetMachineId,
        host: message.host, port: message.port, endpointId: 'child-loopback', pairingEpoch: 1,
        observerBootId: `boot-${machineId}`, sourceClientKeyGeneration: 1, targetHostKeyGeneration: 1,
        targetHostPublicKey: message.targetHostPublicKey, clientPrivateKeyPath: identity.clientPrivateKeyPath,
        expectedMachineFingerprint: `fp-${message.targetMachineId}`,
        expectedSourceClientKeyFingerprint: MachineSshIdentity.fingerprint(identity.clientPublicKey),
        verifyMachineResponse: (payload, signature) => verify(null, Buffer.from(payload), message.targetMachinePublicPem, Buffer.from(signature, 'base64')),
      });
      send({ type: 'proof', proof });
    } else if (message.type === 'close') {
      await endpoint?.close();
      process.exit(0);
    }
  } catch (error) { send({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
});
