/** Custody of one gated launchd worker and its Darwin resource coalition. */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ScopeIdentity {
  attemptId: string;
  boot: string;
  coalition: string | null;
  closed: boolean;
}

export interface TrialScopeMember {
  pid: number;
  generation: number;
  rssBytes: number;
}

export interface TrialScopeSeams {
  boot(): string;
  job(label: string): { pid: number | null; coalition: string | null } | null;
  identify(pid: number): string;
  members(coalition: string): TrialScopeMember[];
  signal(coalition: string, signal: 'TERM' | 'KILL'): void;
  bootout(label: string): void;
  wait(ms: number): Promise<void>;
}

const helper = fileURLToPath(new URL('../../scripts/local-verify/trial-coalition.py', import.meta.url));
function native(op: string, arg: string): unknown {
  return JSON.parse(execFileSync('/usr/bin/python3', ['-I', helper, op, arg], {
    encoding: 'utf8', timeout: 1800, maxBuffer: 1024 * 1024,
  }));
}

function target(label: string): string {
  return `gui/${process.getuid!()}/${label}`;
}

export const darwinTrialScope: TrialScopeSeams = {
  boot: () => execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 1000 }).trim(),
  job(label) {
    let out: string;
    try {
      out = execFileSync('/bin/launchctl', ['print', target(label)], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      if (err.status === 113 && String(err.stderr).includes(`Could not find service "${label}"`)) return null;
      throw e;
    }
    const pid = /^\s*pid = (\d+)\s*$/m.exec(out);
    const resource = /resource coalition = \{([^}]*)\}/.exec(out)?.[1];
    const id = resource && /^\s*ID = (\d+)\s*$/m.exec(resource)?.[1];
    return { pid: pid ? Number(pid[1]) : null, coalition: id || null };
  },
  identify: (pid) => String(native('identify', String(pid))),
  members: (cid) => native('sample', cid) as TrialScopeMember[],
  signal: (cid, sig) => { native(sig, cid); },
  bootout: (label) => { execFileSync('/bin/launchctl', ['bootout', target(label)], { timeout: 3000 }); },
  wait: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
};

function folder(stateDir: string): string {
  return path.join(stateDir, 'trial-scopes');
}

function recordPath(stateDir: string, attemptId: string): string {
  if (!/^[a-f0-9]{32}$/.test(attemptId)) throw new Error('invalid trial attempt ID');
  return path.join(folder(stateDir), attemptId + '.json');
}

function readIdentity(file: string, attemptId: string): ScopeIdentity {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (record.attemptId !== attemptId || !record.boot || typeof record.boot !== 'string'
    || (record.coalition !== null && (typeof record.coalition !== 'string' || !/^[1-9]\d*$/.test(record.coalition)))
    || typeof record.closed !== 'boolean') throw new Error('invalid trial scope record');
  return record as ScopeIdentity;
}

function syncDir(dir: string): void {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeIdentity(file: string, id: ScopeIdentity, first = false): void {
  const tmp = first ? file : file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(id)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (!first) fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}

export class TrialExecutionScope {
  private constructor(private readonly stateDir: string, private readonly id: ScopeIdentity, private readonly seams: TrialScopeSeams) {}

  static label(stateDir: string, attemptId: string): string {
    recordPath(stateDir, attemptId);
    const prefix = createHash('sha256').update(path.resolve(stateDir)).digest('hex').slice(0, 20);
    return `ai.instar.lv-trial.${prefix}.${attemptId}`;
  }

  /** Before bootstrap: reserve the attempt label durably. An existence conflict refuses duplicate launch. */
  static prepare(stateDir: string, attemptId: string, seams = darwinTrialScope): string {
    const file = recordPath(stateDir, attemptId);
    fs.mkdirSync(folder(stateDir), { recursive: true, mode: 0o700 });
    const label = this.label(stateDir, attemptId);
    const boot = seams.boot();
    if (!boot || seams.job(label)) throw new Error('could not reserve a unique trial job');
    writeIdentity(file, { attemptId, boot, coalition: null, closed: false }, true);
    return label;
  }

  /** The job prelude waits before executing any PR code until capture returns. */
  static capture(args: {stateDir: string; attemptId: string; rootPid: number}, seams = darwinTrialScope): TrialExecutionScope {
    const { stateDir, attemptId, rootPid } = args;
    const file = recordPath(stateDir, attemptId);
    const id = readIdentity(file, attemptId);
    if (id.closed || id.coalition || id.boot !== seams.boot() || !Number.isSafeInteger(rootPid) || rootPid < 2) {
      throw new Error('trial scope is no longer available for capture');
    }
    const job = seams.job(this.label(stateDir, attemptId));
    const coalition = seams.identify(rootPid);
    if (!/^[1-9]\d*$/.test(coalition) || job?.pid !== rootPid || job.coalition !== coalition) {
      throw new Error('launchd and kernel disagree on trial job identity');
    }
    const members = seams.members(coalition);
    if (members.length !== 1 || members[0].pid !== rootPid) throw new Error('trial job is not exclusive');
    id.coalition = coalition;
    writeIdentity(file, id);
    return new TrialExecutionScope(stateDir, id, seams);
  }

  sample(): {rssBytes: number; members: TrialScopeMember[]} {
    if (this.id.closed || !this.id.coalition || this.seams.boot() !== this.id.boot) throw new Error('trial scope unavailable');
    const members = this.seams.members(this.id.coalition);
    return { rssBytes: members.reduce((sum, item) => sum + item.rssBytes, 0), members };
  }

  /** If any proof fails the record stays open, fencing subsequent admissions. */
  async stop(): Promise<void> {
    const { id, seams } = this;
    if (id.closed) return;
    const label = TrialExecutionScope.label(this.stateDir, id.attemptId);
    const job = seams.job(label);
    if (seams.boot() !== id.boot) {
      if (job) throw new Error('trial label unexpectedly present after host reboot');
    } else {
      if (job && id.coalition !== null && job.coalition !== id.coalition) throw new Error('trial coalition identity changed');
      // An uncaptured job can only be the waiting prelude; preserve its coalition before bootout.
      if (job && id.coalition === null) {
        if (!job.pid || !job.coalition || seams.identify(job.pid) !== job.coalition) throw new Error('cannot recover waiting trial job');
        id.coalition = job.coalition;
        writeIdentity(recordPath(this.stateDir, id.attemptId), id);
      }
      if (id.coalition) {
        seams.signal(id.coalition, 'TERM');
        await seams.wait(1000);
        // A root ignoring TERM would otherwise consume launchd's own exit timeout.
        seams.signal(id.coalition, 'KILL');
      }
      const beforeBootout = seams.job(label);
      if (beforeBootout) {
        if (!id.coalition || beforeBootout.coalition !== id.coalition) throw new Error('trial label changed before bootout');
        seams.bootout(label);
      }
      if (seams.job(label)) throw new Error('trial job still registered after bootout');
      if (id.coalition) {
        seams.signal(id.coalition, 'KILL');
        for (let poll = 0; poll < 20 && seams.members(id.coalition).length > 0; poll++) {
          await seams.wait(100);
          seams.signal(id.coalition, 'KILL');
        }
        if (seams.members(id.coalition).length > 0) throw new Error('trial scope still occupied after cancellation');
      }
    }
    id.closed = true;
    writeIdentity(recordPath(this.stateDir, id.attemptId), id);
  }

  static async reconcile(stateDir: string, seams = darwinTrialScope): Promise<void> {
    let names: string[];
    try { names = fs.readdirSync(folder(stateDir)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    for (const name of names.filter(n => n.endsWith('.json'))) {
      const attemptId = name.slice(0, -5);
      const id = readIdentity(recordPath(stateDir, attemptId), attemptId);
      if (!id.closed) await new TrialExecutionScope(stateDir, id, seams).stop();
    }
  }
}

export const reconcileTrialScopes = TrialExecutionScope.reconcile.bind(TrialExecutionScope);
