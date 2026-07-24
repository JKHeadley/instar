import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { MachineSshIdentity, type MachineSshIdentityRecord } from './MachineSshIdentity.js';
import { MachineSshEndpoint } from './MachineSshEndpoint.js';
import { MutualSshVerifier, canonicalDirectionalSshProof, type DirectionalSshProof, type SshProbeTarget } from './MutualSshVerifier.js';
import { MutualSshHealthController, classifyMutualSshFailure, type MutualSshPairHealth } from './MutualSshHealthController.js';
import { MutualSshProbeScheduler } from './MutualSshProbeScheduler.js';
import { SshPeerAdmissionStore } from './SshPeerAdmissionStore.js';
import { SshHostKeyLifecycle, canonicalHostKeyProposal } from './SshHostKeyLifecycle.js';
import { canonicalSshBootstrapAdvert, validateSshBootstrapAdvert, type SshBootstrapAdvert } from './SshBootstrapAdvert.js';
import { PeerAuthorizedKeys, type PeerAuthorizedKey } from './PeerAuthorizedKeys.js';
import { StandingSshVerifier } from './StandingSshVerifier.js';

export interface MutualSshPeer {
  machineId: string;
  pairingEpoch: number;
  machineFingerprint: string;
  endpoints: string[];
}

export interface MutualSshRuntimeDeps {
  stateDir: string;
  agentId: string;
  selfMachineId: string;
  selfMachineFingerprint: string;
  observerBootId: string;
  bindHost: string;
  bindPort: number;
  dryRun: boolean;
  peerExecution?: { agentHome: string; dryRun: boolean; requiredForReadiness: boolean };
  localStandingSsh?: SshBootstrapAdvert['standingSsh'];
  requiredForReadiness?: boolean;
  freshnessMs?: number;
  cadenceMs?: number;
  concurrency?: number;
  listPeers(): MutualSshPeer[];
  send(machineId: string, command: MutualSshWireCommand): Promise<unknown>;
  sign(payload: string): string;
  verify(machineId: string, payload: string, signature: string): boolean;
  emitJournalProof?(proof: DirectionalSshProof): void;
  audit?(event: Record<string, unknown>): void;
  notifySecurity?(event: Record<string, unknown>): void;
}

export type MutualSshWireCommand =
  | { type: 'ssh-bootstrap-advert'; advert: SshBootstrapAdvert }
  | { type: 'ssh-proof-publish'; proof: DirectionalSshProof };

interface StoredProofs { version: 1; proofs: DirectionalSshProof[] }

/** Production coordinator for endpoint lifecycle, signed adverts, directional probes and rollback. */
export class MutualSshRuntime {
  private readonly identityManager: MachineSshIdentity;
  private readonly admissionStore: SshPeerAdmissionStore;
  private readonly verifier = new MutualSshVerifier();
  private readonly controller: MutualSshHealthController;
  private readonly scheduler: MutualSshProbeScheduler;
  private identity!: MachineSshIdentityRecord;
  private endpoint: MachineSshEndpoint | null = null;
  private listen: { host: string; port: number } | null = null;
  private readonly adverts = new Map<string, SshBootstrapAdvert>();
  private readonly candidateAdverts = new Map<string, SshBootstrapAdvert>();
  private readonly hostKeys = new Map<string, SshHostKeyLifecycle>();
  private readonly proofs = new Map<string, DirectionalSshProof>();
  private readonly bootstrapFailures = new Map<string, string>();
  private readonly knownPeers = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private hostOverlapTimer: NodeJS.Timeout | null = null;
  private servePreviousHost = true;
  private running = false;
  private stopped = false;
  private readonly startedAtWall = Date.now();
  private readonly proofFile: string;
  private readonly peerAuthorizedKeys: PeerAuthorizedKeys | null;
  private readonly standingVerifier = new StandingSshVerifier();
  private readonly standingEvidence = new Map<string, { deadline: number; targetDigest: string }>();

  constructor(private readonly d: MutualSshRuntimeDeps) {
    const freshness = d.freshnessMs ?? 300_000;
    const concurrency = d.concurrency ?? 4;
    MutualSshHealthController.validateCapacity(d.listPeers().length + 1, concurrency, 8_000, freshness);
    this.identityManager = new MachineSshIdentity(d.stateDir, d.agentId, d.selfMachineId);
    this.admissionStore = new SshPeerAdmissionStore(d.stateDir);
    this.scheduler = new MutualSshProbeScheduler(concurrency, freshness, 8_000);
    this.controller = new MutualSshHealthController(this.verifier, {
      refreshAdvert: async target => { await this.exchangeAdvert(target.targetMachineId); },
      reconcileAdmission: async target => { const advert = this.adverts.get(target.targetMachineId); if (advert) this.installAdvert(advert); },
      rotateSourceKey: async target => {
        this.identity = this.identityManager.ensure({ forceClientRotation: true });
        target.sourceClientKeyGeneration = this.identity.clientGeneration;
        target.clientPrivateKeyPath = this.identity.clientPrivateKeyPath;
        target.expectedSourceClientKeyFingerprint = MachineSshIdentity.fingerprint(this.identity.clientPublicKey);
        await this.exchangeAdvert(target.targetMachineId);
      },
      notifySecurity: async target => this.d.notifySecurity?.({ type: 'host-key-change', target: target.targetMachineId }),
      notifyExhausted: async (target, failure) => this.audit({ type: 'repair-exhausted', target: target.targetMachineId, failure }),
    }, concurrency);
    this.proofFile = path.join(d.stateDir, 'machine-ssh', 'directional-proofs.json');
    this.peerAuthorizedKeys = d.peerExecution ? new PeerAuthorizedKeys(d.peerExecution.agentHome, d.peerExecution.dryRun) : null;
    this.invalidatePersistedProofs();
  }

  async start(): Promise<void> {
    this.identity = this.identityManager.ensure();
    if (this.peerAuthorizedKeys) {
      // A process restart invalidates proof authority. Remove all grants first;
      // current-boot mutual proof may reinstall them.
      const result = new PeerAuthorizedKeys(this.d.peerExecution!.agentHome, false).revokeUnknown(this.d.agentId, new Set());
      if (result.changed) this.audit({ type: 'peer-authorized-key-stale-reconciled', dryRun: result.dryRun });
    }
    if (!this.d.dryRun) await this.ensureEndpoint();
    await this.tick();
    this.timer = setInterval(() => { void this.tick(); }, this.d.cadenceMs ?? 60_000);
    this.timer.unref?.();
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      if (!this.d.dryRun && !this.endpoint) await this.ensureEndpoint();
      const checkedIdentity = this.identityManager.ensure();
      if (checkedIdentity.clientGeneration !== this.identity.clientGeneration || checkedIdentity.hostGeneration !== this.identity.hostGeneration) {
        const hostChanged = checkedIdentity.hostGeneration !== this.identity.hostGeneration;
        this.audit({ type: 'local-key-rotation', clientGeneration: checkedIdentity.clientGeneration, hostGeneration: checkedIdentity.hostGeneration });
        this.identity = checkedIdentity;
        if (hostChanged && !this.d.dryRun) {
          this.servePreviousHost = true;
          await this.endpoint?.close();
          this.endpoint = null;
          this.listen = null;
          await this.ensureEndpoint();
        }
      }
      const peers = this.d.listPeers().filter(peer => peer.machineId !== this.d.selfMachineId);
      const livePeerIds = new Set(peers.map(peer => peer.machineId));
      for (const machineId of this.knownPeers) if (!livePeerIds.has(machineId)) this.revoke(machineId);
      for (const machineId of livePeerIds) this.knownPeers.add(machineId);
      this.scheduler.validate(peers.length + 1);
      for (const peer of peers) {
        try { await this.exchangeAdvert(peer.machineId); this.bootstrapFailures.delete(peer.machineId); }
        catch (error) {
          // @silent-fallback-ok — an advert exchange failure is retained as a
          // named readiness blocker and retried on the next bounded sweep.
          this.bootstrapFailures.set(peer.machineId, classifyMutualSshFailure(error));
        }
      }
      if (this.d.dryRun) { this.audit({ type: 'dry-run', wouldProbe: peers.length }); return; }
      const targets = peers.flatMap(peer => { const target = this.targetFor(peer); return target ? [target] : []; });
      await this.scheduler.sweep(targets.map(target => ({ sourceMachineId: target.sourceMachineId, targetMachineId: target.targetMachineId, healthy: this.proofFresh(this.proofs.get(this.key(target.sourceMachineId, target.targetMachineId))) })), async direction => {
        const target = targets.find(row => row.sourceMachineId === direction.sourceMachineId && row.targetMachineId === direction.targetMachineId);
        if (!target) return;
        const proof = await this.controller.check(target);
        if (!proof) return;
        this.promoteProvenHostKey(target.targetMachineId, proof.targetHostKeyGeneration);
        this.acceptProof(proof, this.d.selfMachineId);
        this.d.emitJournalProof?.(proof);
        await this.d.send(target.targetMachineId, { type: 'ssh-proof-publish', proof });
      });
      await Promise.all(peers.map(peer => this.probeStandingAccess(peer.machineId)));
    } finally { this.running = false; }
  }

  handleAdvert(raw: unknown, authenticatedSender: string): { advert: SshBootstrapAdvert } {
    const advert = validateSshBootstrapAdvert(raw, authenticatedSender, this.d.agentId);
    const { machineSignature, ...unsigned } = advert;
    if (!this.d.verify(authenticatedSender, canonicalSshBootstrapAdvert(unsigned), machineSignature)) throw new Error('ssh-advert-machine-signature-invalid');
    const peer = this.d.listPeers().find(row => row.machineId === authenticatedSender);
    if (!peer || peer.pairingEpoch !== advert.pairingEpoch) throw new Error('ssh-advert-epoch-mismatch');
    this.installAdvert(advert);
    return { advert: this.localAdvert(peer.pairingEpoch) };
  }

  handleProof(raw: unknown, authenticatedSender: string): { accepted: true } {
    if (!raw || typeof raw !== 'object') throw new Error('ssh-proof-invalid');
    const proof = raw as DirectionalSshProof;
    if (proof.sourceMachineId !== authenticatedSender || proof.targetMachineId !== this.d.selfMachineId || typeof proof.machineSignature !== 'string') throw new Error('ssh-proof-principal-mismatch');
    for (const value of [proof.observerBootId, proof.endpointId, proof.targetHostKeyFingerprint, proof.challengeDigest, proof.machineSignature]) if (typeof value !== 'string' || value.length < 1 || value.length > 512) throw new Error('ssh-proof-invalid');
    if (!Number.isSafeInteger(proof.pairingEpoch) || !Number.isSafeInteger(proof.sourceClientKeyGeneration) || !Number.isSafeInteger(proof.targetHostKeyGeneration)) throw new Error('ssh-proof-invalid');
    if (!Number.isFinite(Date.parse(proof.verifiedAt)) || !Number.isFinite(Date.parse(proof.expiresAt))) throw new Error('ssh-proof-invalid');
    const peer = this.d.listPeers().find(row => row.machineId === authenticatedSender);
    if (!peer || peer.pairingEpoch !== proof.pairingEpoch) throw new Error('ssh-proof-epoch-mismatch');
    const advert = this.adverts.get(authenticatedSender);
    if (!advert || advert.observerBootId !== proof.observerBootId || advert.clientKeyGeneration !== proof.sourceClientKeyGeneration) throw new Error('ssh-proof-source-generation-mismatch');
    if (proof.targetHostKeyGeneration !== this.identity.hostGeneration) throw new Error('ssh-proof-target-generation-mismatch');
    if (Date.parse(proof.verifiedAt) < this.startedAtWall) throw new Error('ssh-proof-precedes-runtime-boot');
    if (!this.d.verify(authenticatedSender, canonicalDirectionalSshProof(proof), proof.machineSignature)) throw new Error('ssh-proof-signature-invalid');
    if (!this.proofFresh(proof)) throw new Error('ssh-proof-expired');
    const wallRemaining = Date.parse(proof.expiresAt) - Date.now();
    this.acceptProof({ ...proof, monotonicDeadlineMs: performance.now() + Math.max(0, Math.min(wallRemaining, this.d.freshnessMs ?? 300_000)) }, authenticatedSender);
    this.maybeRetirePreviousHost();
    return { accepted: true };
  }

  /** Delayed journal delivery is observational only and fails closed when stale. */
  handleJournalProof(raw: unknown, authenticatedSender: string): boolean {
    try { this.handleProof(raw, authenticatedSender); return true; }
    catch (error) {
      // @silent-fallback-ok — journal replication is an observational backup;
      // invalid/stale evidence is audited and must never enter readiness state.
      this.audit({ type: 'journal-proof-rejected', sourceMachineId: authenticatedSender, reason: error instanceof Error ? error.message : 'invalid' });
      return false;
    }
  }

  status(): { enabled: true; dryRun: boolean; listener: boolean; readinessRequired: boolean; ready: boolean; enrollmentState: 'paired' | 'ssh-bootstrap' | 'ssh-bootstrap-blocked' | 'ssh-proving' | 'ready'; blockedReasons: string[]; directions: MutualSshPairHealth[]; pairs: Array<{ machines: string[]; mutual: boolean; standingKeyInstalled: boolean; standingReachable: boolean }> } {
    const targets = this.d.listPeers().flatMap(peer => { const target = this.targetFor(peer); return target ? [target] : []; });
    const directions = this.controller.health(targets).map(row => ({ ...row, proof: this.proofs.get(this.key(row.sourceMachineId, row.targetMachineId)) ?? row.proof }));
    const pairs = this.d.listPeers().map(peer => {
      const local = this.proofs.get(this.key(this.d.selfMachineId, peer.machineId));
      const remote = this.proofs.get(this.key(peer.machineId, this.d.selfMachineId));
      const advert = this.adverts.get(peer.machineId);
      const mutual = Boolean(advert && MutualSshVerifier.mutual(local, remote, Date.now(), {
        monotonicNow: performance.now(),
        liveBootIds: new Set([this.d.observerBootId, advert.observerBootId]),
        sourceClientGenerations: new Map([[this.d.selfMachineId, this.identity.clientGeneration], [peer.machineId, advert.clientKeyGeneration]]),
        targetHostGenerations: new Map([[this.d.selfMachineId, this.identity.hostGeneration], [peer.machineId, advert.hostKeyGeneration]]),
      }));
      let standingKeyInstalled = false;
      try { standingKeyInstalled = Boolean(advert && this.peerAuthorizedKeys?.has(this.authorizedKey(advert))); }
      catch (error) { this.bootstrapFailures.set(peer.machineId, `standing-key-store:${classifyMutualSshFailure(error)}`); }
      return {
        machines: [this.d.selfMachineId, peer.machineId],
        mutual,
        standingKeyInstalled,
        standingReachable: Boolean(advert && this.standingEvidence.get(peer.machineId)?.deadline! > performance.now()
          && this.standingEvidence.get(peer.machineId)?.targetDigest === this.standingTargetDigest(advert)),
      };
    });
    const peerCount = this.d.listPeers().filter(peer => peer.machineId !== this.d.selfMachineId).length;
    const proofReady = peerCount === 0 || (pairs.length === peerCount && pairs.every(pair => pair.mutual));
    const readinessRequired = this.d.requiredForReadiness === true && !this.stopped;
    const standingRequired = this.d.peerExecution?.requiredForReadiness === true && !this.d.peerExecution.dryRun;
    const standingReady = !standingRequired || pairs.every(pair => pair.mutual && pair.standingKeyInstalled && pair.standingReachable);
    const combinedReadinessRequired = readinessRequired || standingRequired;
    const ready = !combinedReadinessRequired || (proofReady && standingReady);
    const blockedReasons = [...this.bootstrapFailures.values()];
    if (standingRequired) for (const pair of pairs) if (!pair.mutual || !pair.standingKeyInstalled || !pair.standingReachable) blockedReasons.push(`standing-key-unreachable:${pair.machines[1]}`);
    const enrollmentState = this.stopped || peerCount === 0 ? 'ready' : this.bootstrapFailures.size > 0 || (combinedReadinessRequired && !standingReady) ? 'ssh-bootstrap-blocked' : this.d.dryRun || this.adverts.size < peerCount || !this.endpoint ? 'ssh-bootstrap' : proofReady ? 'ready' : 'ssh-proving';
    return { enabled: true, dryRun: this.d.dryRun, listener: this.endpoint !== null, readinessRequired: combinedReadinessRequired, ready, enrollmentState, blockedReasons: [...new Set(blockedReasons)].sort(), directions, pairs };
  }

  revoke(machineId: string): void {
    this.clearPeerEvidence(machineId);
    this.knownPeers.delete(machineId);
  }

  async rollback(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.hostOverlapTimer) clearTimeout(this.hostOverlapTimer);
    this.timer = null;
    this.hostOverlapTimer = null;
    await Promise.race([this.endpoint?.close() ?? Promise.resolve(), new Promise<void>(resolve => setTimeout(resolve, 10_000))]);
    this.endpoint = null;
    this.listen = null;
    for (const peer of this.d.listPeers()) {
      this.admissionStore.revoke(peer.machineId);
      this.peerAuthorizedKeys?.revoke(this.d.agentId, peer.machineId);
    }
  }

  private async startEndpoint(): Promise<void> {
    this.endpoint = new MachineSshEndpoint({
      hostPrivateKeyPath: this.identity.hostPrivateKeyPath, admissionStore: this.admissionStore,
      hostPrivateKeyPaths: [this.identity.hostPrivateKeyPath, ...(this.servePreviousHost && this.identity.previousHostPrivateKeyPath ? [this.identity.previousHostPrivateKeyPath] : [])],
      machineId: this.d.selfMachineId, machineFingerprint: this.d.selfMachineFingerprint,
      hostGeneration: this.identity.hostGeneration,
      respond: (challenge, admission) => {
        const unsigned = { ...challenge, machineId: this.d.selfMachineId, machineFingerprint: this.d.selfMachineFingerprint, sourceClientKeyFingerprint: MachineSshIdentity.fingerprint(admission.publicKey) };
        return { ...unsigned, signature: this.d.sign(JSON.stringify({ nonce: unsigned.nonce, pairingEpoch: unsigned.pairingEpoch, observerBootId: unsigned.observerBootId, clientGeneration: unsigned.clientGeneration, hostGeneration: unsigned.hostGeneration, machineId: unsigned.machineId, sourceClientKeyFingerprint: unsigned.sourceClientKeyFingerprint, machineFingerprint: unsigned.machineFingerprint })) };
      },
    });
    this.listen = await this.endpoint.listen(this.d.bindHost, this.d.bindPort);
    if (this.servePreviousHost && this.identity.previousHostPrivateKeyPath && !this.hostOverlapTimer) {
      this.hostOverlapTimer = setTimeout(() => { void this.retirePreviousHost(); }, 600_000);
      this.hostOverlapTimer.unref?.();
    }
  }

  private async ensureEndpoint(): Promise<void> {
    try {
      await this.startEndpoint();
      this.bootstrapFailures.delete(this.d.selfMachineId);
    } catch (error) {
      // @silent-fallback-ok — endpoint bootstrap failure is retained as a
      // stable blocked reason and retried by the bounded repair controller.
      await this.endpoint?.close().catch(() => {
        // @silent-fallback-ok — best-effort cleanup of an endpoint that already
        // failed to bind; the original bootstrap failure remains authoritative.
      });
      this.endpoint = null;
      this.listen = null;
      this.bootstrapFailures.set(this.d.selfMachineId, classifyMutualSshFailure(error));
    }
  }

  private localAdvert(pairingEpoch: number): SshBootstrapAdvert {
    const now = Date.now();
    const issuedAt = new Date(now).toISOString();
    const transition = this.identity.hostGeneration > 1 ? {
      agentId: this.d.agentId, machineId: this.d.selfMachineId, pairingEpoch,
      generation: this.identity.hostGeneration, previousGeneration: this.identity.hostGeneration - 1,
      publicKey: this.identity.hostPublicKey, issuedAt,
    } : null;
    const unsigned: Omit<SshBootstrapAdvert, 'machineSignature'> = {
      machineId: this.d.selfMachineId, agentId: this.d.agentId, pairingEpoch,
      observerBootId: this.d.observerBootId, clientKeyGeneration: this.identity.clientGeneration,
      hostKeyGeneration: this.identity.hostGeneration, clientPublicKey: this.identity.clientPublicKey,
      sshHostPublicKeys: [this.identity.hostPublicKey], endpoints: this.listen && !isLoopback(this.listen.host) ? [{ ...this.listen, source: 'configured' }] : [],
      issuedAt, expiresAt: new Date(now + Math.min(300_000, this.d.freshnessMs ?? 300_000)).toISOString(),
      ...(transition ? { hostKeyTransitionSignature: this.d.sign(canonicalHostKeyProposal(transition)) } : {}),
      ...(this.d.localStandingSsh ? { standingSsh: this.d.localStandingSsh } : {}),
    };
    return { ...unsigned, machineSignature: this.d.sign(canonicalSshBootstrapAdvert(unsigned)) };
  }

  private async exchangeAdvert(machineId: string): Promise<void> {
    const peer = this.d.listPeers().find(row => row.machineId === machineId);
    if (!peer) return;
    const response = await this.d.send(machineId, { type: 'ssh-bootstrap-advert', advert: this.localAdvert(peer.pairingEpoch) }) as { advert?: unknown };
    if (response?.advert) this.handleAdvert(response.advert, machineId);
  }

  private installAdvert(advert: SshBootstrapAdvert): void {
    let prior = this.adverts.get(advert.machineId);
    if (prior && (advert.pairingEpoch < prior.pairingEpoch || (advert.pairingEpoch === prior.pairingEpoch && (advert.clientKeyGeneration < prior.clientKeyGeneration || advert.hostKeyGeneration < prior.hostKeyGeneration)))) throw new Error('ssh-advert-rollback-rejected');
    if (prior && advert.pairingEpoch > prior.pairingEpoch) {
      this.clearPeerEvidence(advert.machineId);
      prior = undefined;
    }
    if (prior && (advert.clientKeyGeneration !== prior.clientKeyGeneration || advert.clientPublicKey !== prior.clientPublicKey)) {
      const revoked = this.peerAuthorizedKeys?.revoke(this.d.agentId, advert.machineId);
      this.standingEvidence.delete(advert.machineId);
      if (revoked?.changed) this.audit({ type: 'peer-authorized-key-rotation-revoked', machineId: advert.machineId, dryRun: revoked.dryRun });
    }
    if (prior && advert.hostKeyGeneration === prior.hostKeyGeneration && advert.sshHostPublicKeys[0] !== prior.sshHostPublicKeys[0]) { this.d.notifySecurity?.({ type: 'host-key-substitution', machineId: advert.machineId }); throw new Error('ssh-host-key-substitution'); }
    if (prior && advert.hostKeyGeneration > prior.hostKeyGeneration) {
      if (!advert.hostKeyTransitionSignature) throw new Error('ssh-host-key-transition-signature-missing');
      const lifecycle = this.hostKeys.get(advert.machineId) ?? new SshHostKeyLifecycle({ generation: prior.hostKeyGeneration, publicKey: prior.sshHostPublicKeys[0] });
      this.hostKeys.set(advert.machineId, lifecycle);
      const proposal = {
        agentId: advert.agentId, machineId: advert.machineId, pairingEpoch: advert.pairingEpoch,
        generation: advert.hostKeyGeneration, previousGeneration: prior.hostKeyGeneration,
        publicKey: advert.sshHostPublicKeys[0], issuedAt: advert.issuedAt, machineSignature: advert.hostKeyTransitionSignature,
      };
      lifecycle.propose(proposal, {
        verifyMachine: row => this.d.verify(advert.machineId, canonicalHostKeyProposal(row), row.machineSignature),
        verifyPreviousHost: () => false,
      });
      this.candidateAdverts.set(advert.machineId, advert);
      this.d.notifySecurity?.({ type: 'host-key-quarantined', machineId: advert.machineId, generation: advert.hostKeyGeneration });
      return;
    }
    this.adverts.set(advert.machineId, advert);
    if (!this.hostKeys.has(advert.machineId)) this.hostKeys.set(advert.machineId, new SshHostKeyLifecycle({ generation: advert.hostKeyGeneration, publicKey: advert.sshHostPublicKeys[0] }));
    if (!this.d.dryRun) this.admissionStore.reconcile([...this.adverts.values()].map(row => ({ agentId: row.agentId, machineId: row.machineId, pairingEpoch: row.pairingEpoch, clientGeneration: row.clientKeyGeneration, observerBootId: row.observerBootId, publicKey: row.clientPublicKey, expiresAt: row.expiresAt })));
  }

  private targetFor(peer: MutualSshPeer): SshProbeTarget | null {
    const advert = this.candidateAdverts.get(peer.machineId) ?? this.adverts.get(peer.machineId);
    const endpoint = advert?.endpoints[0];
    if (!advert || !endpoint) return null;
    return {
      sourceMachineId: this.d.selfMachineId, targetMachineId: peer.machineId,
      host: endpoint.host, port: endpoint.port, endpointId: `${endpoint.source}:${createHash('sha256').update(`${endpoint.host}:${endpoint.port}`).digest('hex').slice(0, 12)}`,
      pairingEpoch: peer.pairingEpoch, observerBootId: this.d.observerBootId,
      sourceClientKeyGeneration: this.identity.clientGeneration, targetHostKeyGeneration: advert.hostKeyGeneration,
      targetHostPublicKey: advert.sshHostPublicKeys[0], clientPrivateKeyPath: this.identity.clientPrivateKeyPath,
      expectedMachineFingerprint: peer.machineFingerprint,
      expectedSourceClientKeyFingerprint: MachineSshIdentity.fingerprint(this.identity.clientPublicKey),
      verifyMachineResponse: (payload, signature) => this.d.verify(peer.machineId, payload, signature),
      signProof: payload => this.d.sign(payload),
    };
  }

  private acceptProof(proof: DirectionalSshProof, origin: string): void {
    if (proof.sourceMachineId !== origin) throw new Error('ssh-proof-origin-mismatch');
    this.proofs.set(this.key(proof.sourceMachineId, proof.targetMachineId), proof);
    this.persistProofs();
    this.reconcilePeerExecution(proof.sourceMachineId === this.d.selfMachineId ? proof.targetMachineId : proof.sourceMachineId);
  }

  private promoteProvenHostKey(machineId: string, generation: number): void {
    const candidate = this.candidateAdverts.get(machineId);
    const lifecycle = this.hostKeys.get(machineId);
    if (!candidate || !lifecycle || candidate.hostKeyGeneration !== generation) return;
    lifecycle.proveCandidate(generation);
    lifecycle.promote(generation, true);
    this.candidateAdverts.delete(machineId);
    this.adverts.set(machineId, candidate);
    this.admissionStore.reconcile([...this.adverts.values()].map(row => ({ agentId: row.agentId, machineId: row.machineId, pairingEpoch: row.pairingEpoch, clientGeneration: row.clientKeyGeneration, observerBootId: row.observerBootId, publicKey: row.clientPublicKey, expiresAt: row.expiresAt })));
    this.audit({ type: 'host-key-promoted', machineId, generation });
  }

  private clearPeerEvidence(machineId: string): void {
    const revoked = this.peerAuthorizedKeys?.revoke(this.d.agentId, machineId);
    this.standingEvidence.delete(machineId);
    if (revoked?.changed) this.audit({ type: 'peer-authorized-key-revoked', machineId, dryRun: revoked.dryRun });
    this.admissionStore.revoke(machineId);
    this.endpoint?.revoke(machineId);
    this.adverts.delete(machineId);
    this.candidateAdverts.delete(machineId);
    this.hostKeys.delete(machineId);
    for (const key of [...this.proofs.keys()]) if (key.startsWith(`${machineId}->`) || key.endsWith(`->${machineId}`)) this.proofs.delete(key);
    this.persistProofs();
  }

  private reconcilePeerExecution(machineId: string): void {
    if (!this.peerAuthorizedKeys) return;
    const peer = this.d.listPeers().find(row => row.machineId === machineId);
    const advert = this.adverts.get(machineId);
    if (!peer || !advert || peer.pairingEpoch !== advert.pairingEpoch) return;
    const local = this.proofs.get(this.key(this.d.selfMachineId, machineId));
    const remote = this.proofs.get(this.key(machineId, this.d.selfMachineId));
    if (!MutualSshVerifier.mutual(local, remote, Date.now(), {
      monotonicNow: performance.now(),
      liveBootIds: new Set([this.d.observerBootId, advert.observerBootId]),
      sourceClientGenerations: new Map([[this.d.selfMachineId, this.identity.clientGeneration], [machineId, advert.clientKeyGeneration]]),
      targetHostGenerations: new Map([[this.d.selfMachineId, this.identity.hostGeneration], [machineId, advert.hostKeyGeneration]]),
    })) return;
    try {
      const result = this.peerAuthorizedKeys.reconcile(this.authorizedKey(advert));
      if (result.changed) this.audit({ type: 'peer-authorized-key-reconciled', machineId, pairingEpoch: advert.pairingEpoch, clientKeyGeneration: advert.clientKeyGeneration, dryRun: result.dryRun });
      this.bootstrapFailures.delete(machineId);
    } catch (error) {
      this.bootstrapFailures.set(machineId, `standing-key-store:${classifyMutualSshFailure(error)}`);
    }
  }

  private async probeStandingAccess(machineId: string): Promise<void> {
    if (!this.peerAuthorizedKeys || this.d.peerExecution?.dryRun) return;
    const advert = this.adverts.get(machineId);
    if (!advert?.standingSsh) {
      this.standingEvidence.delete(machineId);
      this.bootstrapFailures.set(machineId, 'standing-ssh-endpoint-missing');
      return;
    }
    try {
      await this.standingVerifier.probe({ ...advert.standingSsh, clientPrivateKeyPath: this.identity.clientPrivateKeyPath });
      this.standingEvidence.set(machineId, {
        deadline: performance.now() + (this.d.freshnessMs ?? 300_000),
        targetDigest: this.standingTargetDigest(advert),
      });
      this.bootstrapFailures.delete(machineId);
    } catch (error) {
      this.standingEvidence.delete(machineId);
      this.bootstrapFailures.set(machineId, `standing-ssh:${classifyMutualSshFailure(error)}`);
    }
  }

  private authorizedKey(advert: SshBootstrapAdvert): PeerAuthorizedKey {
    return {
      agentId: advert.agentId,
      machineId: advert.machineId,
      pairingEpoch: advert.pairingEpoch,
      clientKeyGeneration: advert.clientKeyGeneration,
      publicKey: advert.clientPublicKey,
    };
  }

  private standingTargetDigest(advert: SshBootstrapAdvert): string {
    return createHash('sha256').update(JSON.stringify({
      machineId: advert.machineId,
      pairingEpoch: advert.pairingEpoch,
      observerBootId: advert.observerBootId,
      clientKeyGeneration: advert.clientKeyGeneration,
      standingSsh: advert.standingSsh ?? null,
    })).digest('hex');
  }

  private maybeRetirePreviousHost(): void {
    if (!this.servePreviousHost || !this.identity.previousHostPrivateKeyPath) return;
    const peers = this.d.listPeers().filter(peer => peer.machineId !== this.d.selfMachineId);
    const allProven = peers.length > 0 && peers.every(peer => {
      const proof = this.proofs.get(this.key(peer.machineId, this.d.selfMachineId));
      return this.proofFresh(proof) && proof?.targetHostKeyGeneration === this.identity.hostGeneration && proof.pairingEpoch === peer.pairingEpoch;
    });
    if (allProven) void this.retirePreviousHost();
  }

  private async retirePreviousHost(): Promise<void> {
    if (!this.servePreviousHost || this.stopped) return;
    this.servePreviousHost = false;
    if (this.hostOverlapTimer) clearTimeout(this.hostOverlapTimer);
    this.hostOverlapTimer = null;
    await this.endpoint?.close();
    this.endpoint = null;
    this.listen = null;
    await this.ensureEndpoint();
    this.audit({ type: 'local-host-key-overlap-retired', generation: this.identity.hostGeneration });
  }

  private proofFresh(proof: DirectionalSshProof | undefined): boolean {
    return Boolean(proof && Date.parse(proof.expiresAt) > Date.now() && (proof.monotonicDeadlineMs === undefined || proof.monotonicDeadlineMs > performance.now()));
  }
  private key(source: string, target: string): string { return `${source}->${target}`; }
  private audit(event: Record<string, unknown>): void { this.d.audit?.({ ...event, at: new Date().toISOString() }); }

  private invalidatePersistedProofs(): void {
    try {
      if (fs.lstatSync(this.proofFile).isSymbolicLink()) throw new Error('ssh-proof-store-symlink-refused');
      JSON.parse(fs.readFileSync(this.proofFile, 'utf8')) as StoredProofs;
      // Proof authority is process-local. A restart gets a new observer boot id and
      // must actively re-observe both directions instead of reviving wall-clock data.
      this.persistProofs();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  private persistProofs(): void {
    fs.mkdirSync(path.dirname(this.proofFile), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.proofFile) && fs.lstatSync(this.proofFile).isSymbolicLink()) throw new Error('ssh-proof-store-symlink-refused');
    const tmp = `${this.proofFile}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, proofs: [...this.proofs.values()].map(({ monotonicDeadlineMs: _, ...proof }) => proof) }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.proofFile);
  }
}

function isLoopback(host: string): boolean { return host === 'localhost' || host === '::1' || host.startsWith('127.'); }
