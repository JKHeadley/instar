import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface SshPeerAdmission {
  agentId: string;
  machineId: string;
  pairingEpoch: number;
  clientGeneration: number;
  observerBootId: string;
  publicKey: string;
  expiresAt: string;
  /** Machine-local only. Never replicated or reconstructed from receipt time. */
  monotonicDeadlineMs?: number;
}

export interface AdmissionClock {
  wallNow(): number;
  monotonicNow(): number;
}

function fingerprint(key: Buffer | string): string {
  const raw = Buffer.isBuffer(key) ? key : Buffer.from(key.trim().split(/\s+/)[1] ?? '', 'base64');
  return createHash('sha256').update(raw).digest('hex');
}

/** Atomic, symlink-refusing admission leases for the restricted SSH endpoint. */
export class SshPeerAdmissionStore {
  private readonly file: string;
  private admissions = new Map<string, SshPeerAdmission>();

  constructor(stateDir: string, private readonly clock: AdmissionClock = {
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now(),
  }) {
    this.file = path.join(stateDir, 'machine-ssh', 'peer-admissions.json');
    this.load();
  }

  reconcile(desired: SshPeerAdmission[], now = this.clock.wallNow()): void {
    const next = new Map<string, SshPeerAdmission>();
    for (const row of desired) {
      if (Date.parse(row.expiresAt) <= now || Date.parse(row.expiresAt) - now > 300_000) continue;
      const fp = fingerprint(row.publicKey);
      const collision = [...next.values()].some(x => fingerprint(x.publicKey) === fp && (x.agentId !== row.agentId || x.machineId !== row.machineId));
      if (collision) throw new Error('ssh-admission-key-identity-conflict');
      const previous = this.admissions.get(fp);
      if (previous && (row.pairingEpoch < previous.pairingEpoch || (row.pairingEpoch === previous.pairingEpoch && row.clientGeneration < previous.clientGeneration))) {
        next.set(fp, previous);
        continue;
      }
      const remaining = Math.min(300_000, Date.parse(row.expiresAt) - now);
      next.set(fp, {
        ...row,
        monotonicDeadlineMs: this.clock.monotonicNow() + remaining,
      });
    }
    this.admissions = next;
    this.persist();
  }

  authenticate(publicKey: Buffer, now = this.clock.wallNow()): SshPeerAdmission | null {
    const row = this.admissions.get(fingerprint(publicKey));
    if (!row || Date.parse(row.expiresAt) <= now) return null;
    return row.monotonicDeadlineMs !== undefined && row.monotonicDeadlineMs > this.clock.monotonicNow() ? row : null;
  }

  revoke(machineId: string): void {
    for (const [key, value] of this.admissions) if (value.machineId === machineId) this.admissions.delete(key);
    this.persist();
  }

  list(now = this.clock.wallNow()): SshPeerAdmission[] {
    return [...this.admissions.values()].filter(x => Date.parse(x.expiresAt) > now
      && x.monotonicDeadlineMs !== undefined
      && x.monotonicDeadlineMs > this.clock.monotonicNow());
  }

  private load(): void {
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink()) throw new Error('ssh-admission-store-symlink-refused');
      // A process restart intentionally invalidates persisted leases. A fresh signed
      // advert must be observed on this boot before authentication can succeed.
      for (const row of JSON.parse(fs.readFileSync(this.file, 'utf8')) as SshPeerAdmission[]) {
        this.admissions.set(fingerprint(row.publicKey), { ...row, monotonicDeadlineMs: undefined });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.file) && fs.lstatSync(this.file).isSymbolicLink()) throw new Error('ssh-admission-store-symlink-refused');
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify([...this.admissions.values()], null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
