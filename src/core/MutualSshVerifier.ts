import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { Client, utils } from 'ssh2';
import { canonicalSshResponse, type SshRpcChallenge, type SshRpcResponse } from './MachineSshEndpoint.js';

export interface DirectionalSshProof {
  sourceMachineId: string;
  targetMachineId: string;
  pairingEpoch: number;
  observerBootId: string;
  endpointId: string;
  sourceClientKeyGeneration: number;
  targetHostKeyGeneration: number;
  targetHostKeyFingerprint: string;
  verifiedAt: string;
  expiresAt: string;
  challengeDigest: string;
  machineSignature?: string;
  /** Origin-process local authority. Omitted from replicated proof payloads. */
  monotonicDeadlineMs?: number;
}

export interface SshProbeTarget {
  sourceMachineId: string;
  targetMachineId: string;
  host: string;
  port: number;
  endpointId: string;
  pairingEpoch: number;
  observerBootId: string;
  sourceClientKeyGeneration: number;
  targetHostKeyGeneration: number;
  targetHostPublicKey: string;
  clientPrivateKeyPath: string;
  expectedMachineFingerprint: string;
  expectedSourceClientKeyFingerprint: string;
  verifyMachineResponse: (canonicalPayload: string, signature: string) => boolean;
  signProof?: (canonicalPayload: string) => string;
}

export function canonicalDirectionalSshProof(proof: Omit<DirectionalSshProof, 'machineSignature' | 'monotonicDeadlineMs'>): string {
  return JSON.stringify({
    sourceMachineId: proof.sourceMachineId, targetMachineId: proof.targetMachineId,
    pairingEpoch: proof.pairingEpoch, observerBootId: proof.observerBootId,
    endpointId: proof.endpointId, sourceClientKeyGeneration: proof.sourceClientKeyGeneration,
    targetHostKeyGeneration: proof.targetHostKeyGeneration,
    targetHostKeyFingerprint: proof.targetHostKeyFingerprint, verifiedAt: proof.verifiedAt,
    expiresAt: proof.expiresAt, challengeDigest: proof.challengeDigest,
  });
}

export class MutualSshVerifier {
  async probe(target: SshProbeTarget, now = Date.now()): Promise<DirectionalSshProof> {
    const nonce = randomBytes(24).toString('base64url');
    const challenge: SshRpcChallenge = {
      nonce, pairingEpoch: target.pairingEpoch, observerBootId: target.observerBootId,
      clientGeneration: target.sourceClientKeyGeneration, hostGeneration: target.targetHostKeyGeneration,
    };
    const expectedHost = utils.parseKey(target.targetHostPublicKey);
    if (expectedHost instanceof Error) throw new Error('invalid-pinned-host-key');
    const expectedHostFingerprint = createHash('sha256').update(expectedHost.getPublicSSH()).digest('hex');
    const response = await withDeadline<SshRpcResponse>(8_000, (resolve, reject) => {
      const client = new Client();
      client.once('ready', () => client.subsys('instar-rpc', (error, stream) => {
        if (error) return reject(error);
        let data = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => { data += chunk; if (data.length > 256 * 1024) client.end(); });
        stream.on('close', () => {
          client.end();
          try { resolve(JSON.parse(data.trim())); } catch { reject(new Error('invalid-ssh-rpc-response')); }
        });
        stream.end(`${JSON.stringify(challenge)}\n`);
      }));
      client.once('error', reject);
      client.connect({
        host: target.host, port: target.port, username: 'instar', privateKey: fs.readFileSync(target.clientPrivateKeyPath),
        readyTimeout: 7_500, hostVerifier: (key: Buffer) => key.equals(expectedHost.getPublicSSH()),
        algorithms: { serverHostKey: ['ssh-ed25519'], kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org'] },
      });
      return () => client.end();
    });
    const { signature, ...unsigned } = response;
    if (typeof signature !== 'string' || !target.verifyMachineResponse(canonicalSshResponse(unsigned), signature)) throw new Error('ssh-proof-machine-signature-invalid');
    if (response.nonce !== nonce || response.machineId !== target.targetMachineId || response.machineFingerprint !== target.expectedMachineFingerprint
      || response.sourceClientKeyFingerprint !== target.expectedSourceClientKeyFingerprint
      || response.pairingEpoch !== target.pairingEpoch || response.observerBootId !== target.observerBootId
      || response.clientGeneration !== target.sourceClientKeyGeneration || response.hostGeneration !== target.targetHostKeyGeneration) throw new Error('ssh-proof-identity-mismatch');
    const proof: DirectionalSshProof = {
      sourceMachineId: target.sourceMachineId, targetMachineId: target.targetMachineId,
      pairingEpoch: target.pairingEpoch, observerBootId: target.observerBootId, endpointId: target.endpointId,
      sourceClientKeyGeneration: target.sourceClientKeyGeneration, targetHostKeyGeneration: target.targetHostKeyGeneration,
      targetHostKeyFingerprint: expectedHostFingerprint, verifiedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 300_000).toISOString(), challengeDigest: createHash('sha256').update(nonce).digest('hex'),
      monotonicDeadlineMs: performance.now() + 300_000,
    };
    if (target.signProof) proof.machineSignature = target.signProof(canonicalDirectionalSshProof(proof));
    return proof;
  }

  static mutual(
    aToB: DirectionalSshProof | undefined,
    bToA: DirectionalSshProof | undefined,
    now = Date.now(),
    context?: {
      monotonicNow?: number;
      liveBootIds?: ReadonlySet<string>;
      sourceClientGenerations?: ReadonlyMap<string, number>;
      targetHostGenerations?: ReadonlyMap<string, number>;
    },
  ): boolean {
    if (!aToB || !bToA) return false;
    const proofs = [aToB, bToA];
    if (context?.liveBootIds && proofs.some(proof => !context.liveBootIds!.has(proof.observerBootId))) return false;
    if (context?.sourceClientGenerations && proofs.some(proof => context.sourceClientGenerations!.get(proof.sourceMachineId) !== proof.sourceClientKeyGeneration)) return false;
    if (context?.targetHostGenerations && proofs.some(proof => context.targetHostGenerations!.get(proof.targetMachineId) !== proof.targetHostKeyGeneration)) return false;
    if (context?.monotonicNow !== undefined && proofs.some(proof => proof.monotonicDeadlineMs === undefined || proof.monotonicDeadlineMs <= context.monotonicNow!)) return false;
    return aToB.sourceMachineId === bToA.targetMachineId && aToB.targetMachineId === bToA.sourceMachineId
      && aToB.pairingEpoch === bToA.pairingEpoch && Date.parse(aToB.expiresAt) > now && Date.parse(bToA.expiresAt) > now;
  }
}

function withDeadline<T>(ms: number, run: (resolve: (value: T) => void, reject: (error: Error) => void) => () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let cleanup = () => {};
    const timer = setTimeout(() => { cleanup(); reject(new Error('ssh-probe-timeout')); }, ms);
    cleanup = run(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
