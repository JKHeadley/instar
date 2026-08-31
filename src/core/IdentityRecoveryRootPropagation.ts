/** Durable peer propagation for PIN-established/rotated recovery roots. */
import fs from 'node:fs';
import path from 'node:path';
import type { MachineIdentity } from './types.js';
import type { MachineOperatorDelegation } from './MachineOperatorDelegation.js';

export type RecoveryRootDelivery = 'rotated' | 'already-current' | 'not-required' | 'pending';

export interface RecoveryRootPropagationJob {
  id: string;
  machineIdentity: MachineIdentity;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  attempts: number;
  peers: Record<string, { status: RecoveryRootDelivery; attempts: number; lastAttemptAt?: string }>;
  operatorDelegations: Record<string, MachineOperatorDelegation>;
  phase: 'prepared' | 'committed';
  resurfaced24h?: boolean;
  escalated72h?: boolean;
  failedAt?: string;
  completedAt?: string;
}

interface QueueFile { version: 3; jobs: Record<string, RecoveryRootPropagationJob> }
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];

export class IdentityRecoveryRootPropagationQueue {
  private readonly file: string;
  private running = false;

  constructor(private readonly deps: {
    stateDir: string;
    sendPeer: (peerMachineId: string, identity: MachineIdentity, delegation: MachineOperatorDelegation) => Promise<RecoveryRootDelivery>;
    validateDelegation: (peerMachineId: string, identity: MachineIdentity, delegation: MachineOperatorDelegation) => boolean;
    notify: (event: { id: string; priority: 'high' | 'critical'; title: string; body: string }) => void | Promise<void>;
    now?: () => number;
  }) {
    this.file = path.join(deps.stateDir, 'state', 'identity-recovery-establishment.json');
  }

  /** Persist the old-root-signed outbox before the local trust root changes. */
  prepare(identity: MachineIdentity, delegations: Record<string, MachineOperatorDelegation>): RecoveryRootPropagationJob {
    if (!identity.recoveryPublicKey || !Number.isSafeInteger(identity.recoveryEpoch) || Number(identity.recoveryEpoch) < 1) {
      throw new Error('recovery root is not established');
    }
    const data = this.load();
    const id = `${identity.machineId}:${identity.recoveryEpoch}`;
    const now = this.now();
    const at = new Date(now).toISOString();
    let job = data.jobs[id];
    if (!job) {
      job = {
        id, machineIdentity: { ...identity }, createdAt: at, updatedAt: at,
        nextAttemptAt: at, attempts: 0, peers: {}, operatorDelegations: {}, phase: 'prepared',
      };
      data.jobs[id] = job;
    } else {
      if (JSON.stringify(job.machineIdentity) !== JSON.stringify(identity)) {
        throw new Error('recovery-root propagation transaction conflicts with durable journal');
      }
      // A committed transaction is immutable. Retrying the same operator action
      // may drive it again, but cannot add peers or replace signed grants through
      // a project-file journal.
      if (job.phase === 'committed') return job;
    }
    let added = false;
    for (const peer of Object.keys(delegations).sort()) {
      if (!job.peers[peer]) {
        job.peers[peer] = { status: 'pending', attempts: 0 };
        added = true;
      }
      job.operatorDelegations[peer] = delegations[peer];
    }
    if (added && job.completedAt) {
      delete job.completedAt;
      job.nextAttemptAt = at;
    }
    this.save(data);
    return job;
  }

  /** Mark the already-durable outbox sendable only after identity + escrow commit. */
  commit(id: string): RecoveryRootPropagationJob {
    const data = this.load();
    const job = data.jobs[id];
    if (!job) throw new Error('recovery-root propagation transaction missing');
    job.phase = 'committed';
    job.updatedAt = new Date(this.now()).toISOString();
    job.nextAttemptAt = job.updatedAt;
    this.save(data);
    return job;
  }

  reauthorize(id: string, delegations: Record<string, MachineOperatorDelegation>): RecoveryRootPropagationJob {
    const data = this.load();
    const job = data.jobs[id];
    if (!job || !job.failedAt) throw new Error('recovery-root propagation is not awaiting reauthorization');
    const at = new Date(this.now()).toISOString();
    for (const [peer, delegation] of Object.entries(delegations)) {
      if (job.peers[peer]?.status !== 'pending') continue;
      job.operatorDelegations[peer] = delegation;
      job.peers[peer].attempts = 0;
      delete job.peers[peer].lastAttemptAt;
    }
    job.createdAt = at;
    job.updatedAt = at;
    job.nextAttemptAt = at;
    job.attempts = 0;
    delete job.failedAt;
    delete job.resurfaced24h;
    delete job.escalated72h;
    this.save(data);
    return job;
  }

  /** Registry revocation is an authenticated authority transition: a peer that
   * is explicitly revoked no longer needs the new recovery root. Reconcile that
   * local fact into the immutable recipient journal without deleting history or
   * accepting mere absence/unreachability as revocation. */
  reconcileRevokedPeers(revokedPeerMachineIds: string[]): RecoveryRootPropagationJob[] {
    const revoked = new Set(revokedPeerMachineIds);
    if (revoked.size === 0) return this.status();
    const data = this.load();
    const at = new Date(this.now()).toISOString();
    let changed = false;
    for (const job of Object.values(data.jobs)) {
      if (job.phase !== 'committed' || job.completedAt) continue;
      let jobChanged = false;
      for (const [peer, row] of Object.entries(job.peers)) {
        if (row.status === 'pending' && revoked.has(peer)) {
          row.status = 'not-required';
          changed = true;
          jobChanged = true;
        }
      }
      if (jobChanged && Object.values(job.peers).every((row) => row.status !== 'pending')) {
        job.completedAt = at;
        job.updatedAt = at;
        delete job.failedAt;
      }
    }
    if (changed) this.save(data);
    return Object.values(data.jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Compatibility helper for callers that do not own a local authority commit. */
  enqueue(identity: MachineIdentity, delegations: Record<string, MachineOperatorDelegation>): RecoveryRootPropagationJob {
    const job = this.prepare(identity, delegations);
    return this.commit(job.id);
  }

  abort(id: string): void {
    const data = this.load();
    if (data.jobs[id]?.phase === 'prepared') {
      delete data.jobs[id];
      this.save(data);
    }
  }

  /** Rebuild the current transaction from the keychain-backed redundant intent
   * if the file outbox was interrupted or corrupt. The corrupt artifact is kept
   * for diagnosis; no unauthenticated data is ever made sendable here. */
  recoverPrepared(identity: MachineIdentity, delegations: Record<string, MachineOperatorDelegation>): RecoveryRootPropagationJob {
    try {
      return this.prepare(identity, delegations);
    } catch (err) {
      if (!(err instanceof Error) || err.message !== 'identity recovery-root propagation queue is corrupt') throw err;
      const corrupt = `${this.file}.corrupt.${this.now()}`;
      fs.renameSync(this.file, corrupt);
      return this.prepare(identity, delegations);
    }
  }

  /** A prepared transaction is committed iff the public identity and escrow
   * both reached the proposed generation; otherwise it is safe to roll back. */
  reconcile(localIdentity: MachineIdentity, recoveryPrivateKeyAvailable: boolean): RecoveryRootPropagationJob[] {
    const data = this.load();
    const at = new Date(this.now()).toISOString();
    for (const [id, job] of Object.entries(data.jobs)) {
      if (job.phase !== 'prepared') continue;
      const matches = job.machineIdentity.machineId === localIdentity.machineId
        && job.machineIdentity.recoveryPublicKey === localIdentity.recoveryPublicKey
        && job.machineIdentity.recoveryEpoch === localIdentity.recoveryEpoch;
      if (matches && recoveryPrivateKeyAvailable) {
        job.phase = 'committed';
        job.updatedAt = at;
        job.nextAttemptAt = at;
      } else {
        delete data.jobs[id];
      }
    }
    this.save(data);
    return Object.values(data.jobs);
  }

  async tick(): Promise<RecoveryRootPropagationJob[]> {
    if (this.running) return this.status();
    this.running = true;
    try {
      const data = this.load();
      const now = this.now();
      for (const job of Object.values(data.jobs)) {
        if (job.phase !== 'committed') continue;
        if (job.completedAt || job.failedAt) continue;
        const age = now - Date.parse(job.createdAt);
        if (age >= 24 * 60 * 60_000 && !job.resurfaced24h) {
          job.resurfaced24h = true;
          await this.deps.notify({
            id: `identity-recovery-root-pending:${job.id}:24h`, priority: 'high',
            title: 'Machine recovery root is not established everywhere',
            body: `${job.machineIdentity.machineId} recovery epoch ${job.machineIdentity.recoveryEpoch} has not reached every paired peer after 24 hours. Automatic retry continues.`,
          });
        }
        if (age >= 72 * 60 * 60_000 && !job.escalated72h) {
          job.escalated72h = true;
          await this.deps.notify({
            id: `identity-recovery-root-pending:${job.id}:72h`, priority: 'critical',
            title: 'Machine recovery root establishment is overdue',
            body: `${job.machineIdentity.machineId} recovery epoch ${job.machineIdentity.recoveryEpoch} remains unestablished at one or more paired peers after 72 hours. Those peers cannot perform zero-touch double-fault recovery.`,
          });
          job.failedAt = new Date(now).toISOString();
          job.updatedAt = job.failedAt;
          continue;
        }
        if (Date.parse(job.nextAttemptAt) > now) continue;
        job.attempts += 1;
        const at = new Date(now).toISOString();
        await Promise.all(Object.entries(job.peers).map(async ([peer, row]) => {
          if (row.status !== 'pending') return;
          row.attempts += 1;
          row.lastAttemptAt = at;
          const delegation = job.operatorDelegations[peer];
          if (!delegation) { row.status = 'pending'; return; }
          try { row.status = await this.deps.sendPeer(peer, job.machineIdentity, delegation); }
          catch { row.status = 'pending'; }
        }));
        job.updatedAt = at;
        if (Object.values(job.peers).every((row) => row.status !== 'pending')) job.completedAt = at;
        else job.nextAttemptAt = new Date(now + BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)]).toISOString();
      }
      const completed = Object.values(data.jobs).filter((job) => job.completedAt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      for (const stale of completed.slice(32)) delete data.jobs[stale.id];
      this.save(data);
      return Object.values(data.jobs);
    } finally {
      this.running = false;
    }
  }

  status(): RecoveryRootPropagationJob[] {
    return Object.values(this.load().jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Retire terminal file authority before the keychain drops the retained
   * prior root. A crash between this delete and key retirement is recoverable
   * from the redundant keychain intent and idempotent peer receipts. */
  retireCompleted(id: string): boolean {
    const data = this.load();
    const job = data.jobs[id];
    if (!job?.completedAt) return false;
    delete data.jobs[id];
    this.save(data);
    return true;
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private load(): QueueFile {
    if (!fs.existsSync(this.file)) return { version: 3, jobs: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as QueueFile | { version: 2; jobs: Record<string, RecoveryRootPropagationJob> };
      if ((parsed?.version === 2 || parsed?.version === 3) && parsed.jobs && typeof parsed.jobs === 'object') {
        for (const job of Object.values(parsed.jobs)) job.phase ??= 'committed';
        if (Object.entries(parsed.jobs).every(([id, job]) => this.validJob(id, job))) {
          return { version: 3, jobs: parsed.jobs };
        }
      }
    } catch { /* fail closed below */ }
    throw new Error('identity recovery-root propagation queue is corrupt');
  }
  private save(data: QueueFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private validJob(id: string, job: RecoveryRootPropagationJob): boolean {
    const identity = job?.machineIdentity;
    if (!job || !identity || job.id !== id
      || id !== `${identity.machineId}:${identity.recoveryEpoch}`
      || !/^[A-Za-z0-9_-]{1,64}$/.test(identity.machineId)
      || typeof identity.recoveryPublicKey !== 'string'
      || !Number.isSafeInteger(identity.recoveryEpoch) || Number(identity.recoveryEpoch) < 1
      || !['prepared', 'committed'].includes(job.phase)
      || !this.validDate(job.createdAt) || !this.validDate(job.updatedAt) || !this.validDate(job.nextAttemptAt)
      || !Number.isSafeInteger(job.attempts) || job.attempts < 0
      || !job.peers || typeof job.peers !== 'object'
      || !job.operatorDelegations || typeof job.operatorDelegations !== 'object') return false;
    if (job.completedAt && (!this.validDate(job.completedAt)
      || Object.values(job.peers).some((row) => row.status === 'pending'))) return false;
    if (job.failedAt && !this.validDate(job.failedAt)) return false;
    return Object.entries(job.peers).every(([peer, row]) => {
      const delegation = job.operatorDelegations[peer];
      return /^[A-Za-z0-9_-]{1,64}$/.test(peer)
        && !!row && ['rotated', 'already-current', 'not-required', 'pending'].includes(row.status)
        && Number.isSafeInteger(row.attempts) && row.attempts >= 0
        && (!row.lastAttemptAt || this.validDate(row.lastAttemptAt))
        && !!delegation && this.deps.validateDelegation(peer, identity, delegation);
    });
  }

  private validDate(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
  }
}
