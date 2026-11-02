/** Pinned pool writer's read surface. The caller still verifies the machine
 * signature and monotonic epoch; a successful HTTP response grants nothing. */
import type { Router } from 'express';
import type { JobFixedRegistryAuthorityStore } from '../scheduler/JobFixedRegistryAuthorityStore.js';
import type { FixedCertificateRegistrySnapshot } from '../scheduler/JobFixedCertificateRegistry.js';
import type { FixedResultCertificate } from '../scheduler/JobFixedResultCertificate.js';
import { verifyFixedRevocationProof, type FixedRevocationProof } from '../scheduler/JobFixedRegistryRevocation.js';
import type { MachineKeyLookup } from '../core/AppRecordSignatures.js';
import { isPeerUrlAllowedForCredentials, type PeerEndpointKind } from './peerUrlGuard.js';
import { poolPeerFetch, type PoolPeerTarget, type RopeResultRecorder } from './poolPeerFetch.js';

export function mountJobFixedRegistryRoutes(router: Router, deps: {
  authority: () => JobFixedRegistryAuthorityStore | null;
  keyLookup?: MachineKeyLookup;
  sourceAllowed?: (machineId: string) => boolean;
  now?: () => number;
}): void {
  router.get('/jobs/fixed-registry', (_req, res) => {
    try {
      const writer = deps.authority();
      if (!writer) return res.status(503).json({ error: 'fixed-registry-authority-unavailable' });
      res.setHeader('Cache-Control', 'no-store');
      return res.json(writer.snapshot((deps.now ?? Date.now)()));
    } catch {
      return res.status(503).json({ error: 'fixed-registry-authority-unavailable' });
    }
  });
  router.post('/jobs/fixed-registry/issue', (req, res) => {
    try {
      const writer = deps.authority();
      if (!writer) return res.status(503).json({ error: 'fixed-registry-authority-unavailable' });
      const epoch = writer.issue(req.body as FixedResultCertificate, (deps.now ?? Date.now)());
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ certificateId: (req.body as FixedResultCertificate).id, epoch });
    } catch {
      return res.status(403).json({ error: 'fixed-certificate-issuance-review-failed' });
    }
  });
  router.post('/jobs/fixed-registry/renew', (req, res) => {
    try {
      const writer = deps.authority();
      if (!writer) return res.status(503).json({ error: 'fixed-registry-authority-unavailable' });
      const priorId = req.body?.priorCertificateId;
      if (typeof priorId !== 'string' || !priorId) return res.status(400).json({ error: 'prior-certificate-required' });
      const cert = req.body?.certificate as FixedResultCertificate;
      const epoch = writer.renew(priorId, cert, (deps.now ?? Date.now)());
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ certificateId: cert.id, retiredCertificateId: priorId, epoch });
    } catch {
      return res.status(403).json({ error: 'fixed-certificate-renewal-review-failed' });
    }
  });
  router.post('/jobs/fixed-registry/revoke', (req, res) => {
    const proof = req.body as FixedRevocationProof;
    if (!deps.keyLookup || !verifyFixedRevocationProof(proof, deps.keyLookup, (deps.now ?? Date.now)())
      || (deps.sourceAllowed && !deps.sourceAllowed(proof.sourceMachineId))) {
      return res.status(403).json({ error: 'invalid-fixed-revocation-proof' });
    }
    try {
      const writer = deps.authority();
      if (!writer) return res.status(503).json({ error: 'fixed-registry-authority-unavailable' });
      const epoch = writer.acceptFalseRoutineProof(proof);
      return res.json({ certificateId: proof.certificateId, epoch });
    } catch {
      return res.status(503).json({ error: 'fixed-registry-revocation-unavailable' });
    }
  });
}

/** One bounded authenticated fetch to the pinned paired machine; no fan-out
 * can silently elect a different writer. The reader verifies its signature. */
export function createJobFixedRegistryFetcher(input: {
  authorityMachineId: string;
  resolvePeer: () => PoolPeerTarget | null;
  authToken: string;
  recordRopeResult?: RopeResultRecorder;
  fetchPeer?: (peer: PoolPeerTarget, route: string, init: Parameters<typeof fetch>[1]) => Promise<globalThis.Response>;
}): () => Promise<FixedCertificateRegistrySnapshot> {
  return async () => {
    const peer = input.resolvePeer();
    if (!peer || peer.machineId !== input.authorityMachineId
      || !isPeerUrlAllowedForCredentials({ url: peer.url,
        kind: (peer.kind ?? 'last-known-url') as PeerEndpointKind }).ok) {
      throw new Error('fixed registry pinned peer unavailable');
    }
    const dial = input.fetchPeer ?? ((p: PoolPeerTarget, route: string, init: Parameters<typeof fetch>[1]) =>
      poolPeerFetch(input.recordRopeResult, p, route, init));
    const response = await dial(peer, '/jobs/fixed-registry', {
      headers: { Authorization: `Bearer ${input.authToken}` },
      signal: AbortSignal.timeout(2_000), redirect: 'manual',
    });
    if (!response.ok) throw new Error('fixed registry writer refused read');
    const body = await response.text();
    if (Buffer.byteLength(body) > 512 * 1024) throw new Error('fixed registry response over cap');
    return JSON.parse(body) as FixedCertificateRegistrySnapshot;
  };
}

export function createJobFixedRevocationSubmitter(input: {
  authorityMachineId: string;
  resolvePeer: () => PoolPeerTarget | null;
  authToken: string;
  recordRopeResult?: RopeResultRecorder;
  fetchPeer?: (peer: PoolPeerTarget, route: string, init: Parameters<typeof fetch>[1]) => Promise<globalThis.Response>;
}): (proof: FixedRevocationProof) => Promise<void> {
  return async proof => {
    const peer = input.resolvePeer();
    if (!peer || peer.machineId !== input.authorityMachineId
      || !isPeerUrlAllowedForCredentials({ url: peer.url,
        kind: (peer.kind ?? 'last-known-url') as PeerEndpointKind }).ok) {
      throw new Error('fixed registry pinned peer unavailable');
    }
    const dial = input.fetchPeer ?? ((p: PoolPeerTarget, route: string, init: Parameters<typeof fetch>[1]) =>
      poolPeerFetch(input.recordRopeResult, p, route, init));
    const response = await dial(peer, '/jobs/fixed-registry/revoke', {
      method: 'POST', headers: { Authorization: `Bearer ${input.authToken}`,
        'Content-Type': 'application/json' }, body: JSON.stringify(proof),
      signal: AbortSignal.timeout(2_000), redirect: 'manual',
    });
    if (!response.ok) throw new Error('fixed registry writer refused revocation');
  };
}
