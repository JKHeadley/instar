/** Durable retry/resurface queue for the operator's one machine-identity ack. */
import fs from 'node:fs';
import path from 'node:path';
import type { MachineOperatorDelegation } from './MachineOperatorDelegation.js';

export type AckDeliveryResult = 'acknowledged' | 'already-acknowledged' | 'pending';

export interface IdentityAckPropagationJob {
  id: string;
  machineId: string;
  keyEpoch: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  attempts: number;
  local: AckDeliveryResult;
  peers: Record<string, { status: AckDeliveryResult; attempts: number; lastAttemptAt?: string }>;
  operatorDelegations: Record<string, MachineOperatorDelegation>;
  resurfaced24h?: boolean;
  escalated72h?: boolean;
  failedAt?: string;
  completedAt?: string;
}

interface QueueFile { version: 1; jobs: Record<string, IdentityAckPropagationJob> }

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000];

export class IdentityAckPropagationQueue {
  private readonly file: string;
  private running = false;

  constructor(private readonly deps: {
    stateDir: string;
    sendPeer: (peerMachineId: string, machineId: string, keyEpoch: number, delegation: MachineOperatorDelegation) => Promise<AckDeliveryResult>;
    validateDelegation: (peerMachineId: string, machineId: string, keyEpoch: number, delegation: MachineOperatorDelegation) => boolean;
    notify: (event: { id: string; priority: 'high' | 'critical'; title: string; body: string }) => void | Promise<void>;
    now?: () => number;
  }) {
    this.file = path.join(deps.stateDir, 'state', 'identity-rotation-ack-propagation.json');
  }

  enqueue(machineId: string, keyEpoch: number, delegations: Record<string, MachineOperatorDelegation>): IdentityAckPropagationJob {
    const data = this.load();
    const id = `${machineId}:${keyEpoch}`;
    const now = this.now();
    const at = new Date(now).toISOString();
    const existing = data.jobs[id];
    if (existing && !existing.completedAt && !existing.failedAt) return existing;
    const job: IdentityAckPropagationJob = {
      id, machineId, keyEpoch, createdAt: at, updatedAt: at, nextAttemptAt: at,
      attempts: 0, local: 'acknowledged',
      peers: Object.fromEntries(Object.keys(delegations).sort().map((peer) => [peer, { status: 'pending', attempts: 0 }])),
      operatorDelegations: { ...delegations },
    };
    data.jobs[id] = job;
    this.save(data);
    return job;
  }

  async tick(): Promise<IdentityAckPropagationJob[]> {
    if (this.running) return this.status();
    this.running = true;
    try {
      const data = this.load();
      const now = this.now();
      for (const job of Object.values(data.jobs)) {
        if (job.completedAt || job.failedAt) continue;
        const age = now - Date.parse(job.createdAt);
        if (age >= 24 * 60 * 60_000 && !job.resurfaced24h) {
          job.resurfaced24h = true;
          await this.deps.notify({
            id: `identity-ack-pending:${job.id}:24h`, priority: 'high',
            title: 'Machine identity acknowledgement is still propagating',
            body: `The acknowledgement for ${job.machineId} signing epoch ${job.keyEpoch} has not reached every peer after 24 hours. Automatic retry continues.`,
          });
        }
        if (age >= 72 * 60 * 60_000 && !job.escalated72h) {
          job.escalated72h = true;
          await this.deps.notify({
            id: `identity-ack-pending:${job.id}:72h`, priority: 'critical',
            title: 'Machine identity acknowledgement is overdue',
            body: `The acknowledgement for ${job.machineId} signing epoch ${job.keyEpoch} remains incomplete after 72 hours. Automatic recovery can stay suspended on lagging peers.`,
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
          try { row.status = await this.deps.sendPeer(peer, job.machineId, job.keyEpoch, delegation); }
          catch { row.status = 'pending'; }
        }));
        job.updatedAt = at;
        const localDone = job.local !== 'pending';
        const peersDone = Object.values(job.peers).every((row) => row.status !== 'pending');
        if (localDone && peersDone) job.completedAt = at;
        else job.nextAttemptAt = new Date(now + BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)]).toISOString();
      }
      // Return the terminal snapshot to the caller, then retire it before a
      // later recovery-root rotation makes the old-root grant unverifiable.
      const result = structuredClone(Object.values(data.jobs));
      for (const completed of Object.values(data.jobs).filter((job) => job.completedAt)) delete data.jobs[completed.id];
      this.save(data);
      return result;
    } finally {
      this.running = false;
    }
  }

  status(): IdentityAckPropagationJob[] {
    return Object.values(this.load().jobs).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  private load(): QueueFile {
    if (!fs.existsSync(this.file)) return { version: 1, jobs: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as QueueFile;
      if (parsed?.version === 1 && parsed.jobs && typeof parsed.jobs === 'object'
        && Object.entries(parsed.jobs).every(([id, job]) => this.validJob(id, job))) return parsed;
    } catch { /* fail closed below */ }
    throw new Error('identity acknowledgement propagation queue is corrupt');
  }

  private save(data: QueueFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  private validJob(id: string, job: IdentityAckPropagationJob): boolean {
    if (!job || job.id !== id || id !== `${job.machineId}:${job.keyEpoch}`
      || !/^[A-Za-z0-9_-]{1,64}$/.test(job.machineId)
      || !Number.isSafeInteger(job.keyEpoch) || job.keyEpoch < 1
      || !this.validDate(job.createdAt) || !this.validDate(job.updatedAt) || !this.validDate(job.nextAttemptAt)
      || !Number.isSafeInteger(job.attempts) || job.attempts < 0
      || !['acknowledged', 'already-acknowledged'].includes(job.local)
      || !job.peers || typeof job.peers !== 'object'
      || !job.operatorDelegations || typeof job.operatorDelegations !== 'object') return false;
    if (job.completedAt && !this.validDate(job.completedAt)) return false;
    if (job.failedAt && !this.validDate(job.failedAt)) return false;
    return Object.entries(job.peers).every(([peer, row]) => {
      const delegation = job.operatorDelegations[peer];
      return /^[A-Za-z0-9_-]{1,64}$/.test(peer)
        && !!row && ['acknowledged', 'already-acknowledged', 'pending'].includes(row.status)
        && Number.isSafeInteger(row.attempts) && row.attempts >= 0
        && (!row.lastAttemptAt || this.validDate(row.lastAttemptAt))
        && !!delegation && this.deps.validateDelegation(peer, job.machineId, job.keyEpoch, delegation);
    });
  }

  private validDate(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
  }
}

export function assertIdentityAckPropagationSettled(queue: IdentityAckPropagationQueue | null | undefined): void {
  if (queue?.status().some((job) => !job.completedAt)) {
    throw new Error('Signing-rotation acknowledgement propagation must converge before recovery-root rotation');
  }
}
