/** Bounded diagnostic history. Never grants, denies, delays or cancels a spawn. */
import { randomUUID, createHash } from 'node:crypto';

export interface GuardSpawnObservation {
  sequence: number;
  attemptId: string;
  key: string;
  storeId: string;
  pid: number | null;
  spawn: 'intent' | 'spawned' | 'error';
  exit: 'pending' | 'exited';
  exitCode: number | null;
  signal: string | null;
}
export interface GuardObservationSnapshot {
  schema: 1;
  available: boolean;
  instanceId: string | null;
  nodePid: number;
  sequence: number;
  complete: boolean;
  reason: string | null;
  entries: GuardSpawnObservation[];
}

export class DesktopGuardObservation {
  static readonly CAPACITY = 128;
  private instanceId: string | null = null;
  private sequence = 0;
  private reason: string | null = null;
  private entries: GuardSpawnObservation[] = [];

  constructor() {
    try { this.instanceId = randomUUID(); }
    catch { // @silent-fallback-ok — own status publishes sticky initialization failure; observation cannot block dispatch.
      this.fail('initialization-failed');
    }
  }
  fail(reason = 'observation-failed'): void { this.reason ??= reason; }
  /** Must execute synchronously before spawn; no history eviction or reuse. */
  intent(key: string, root = ''): string | null {
    try {
      if (this.reason || !this.instanceId) return null;
      if (this.entries.length >= DesktopGuardObservation.CAPACITY || !Number.isSafeInteger(this.sequence + 1)) {
        this.fail('capacity-exceeded'); return null;
      }
      const sequence = ++this.sequence;
      const attemptId = `${this.instanceId}:${sequence}`;
      this.entries.push({ sequence, attemptId, key, storeId: createHash('sha256').update(root).digest('hex'), pid: null, spawn: 'intent', exit: 'pending', exitCode: null, signal: null });
      return attemptId;
    } catch { // @silent-fallback-ok — own status publishes sticky incomplete history; no I/O may gate a safety spawn.
      this.fail(); return null;
    }
  }
  update(attemptId: string | null, patch: Partial<Pick<GuardSpawnObservation, 'pid' | 'spawn' | 'exit' | 'exitCode' | 'signal'>>): void {
    try {
      if (!attemptId) { this.fail(); return; }
      const entry = this.entries.find(item => item.attemptId === attemptId);
      if (!entry) { this.fail(); return; }
      Object.assign(entry, patch);
    } catch { this.fail(); }
  }
  snapshot(): GuardObservationSnapshot {
    return { schema: 1, available: !!this.instanceId, instanceId: this.instanceId, nodePid: process.pid,
      sequence: this.sequence, complete: !this.reason, reason: this.reason, entries: this.entries.map(entry => ({ ...entry })) };
  }
}
