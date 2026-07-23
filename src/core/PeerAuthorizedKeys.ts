import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { utils } from 'ssh2';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const MARKER = 'instar-peer-access';

export interface PeerAuthorizedKey {
  agentId: string;
  machineId: string;
  pairingEpoch: number;
  clientKeyGeneration: number;
  publicKey: string;
}

/**
 * Owns only the supplied agent account home's .ssh/authorized_keys and refuses
 * symlinked write targets.
 */
export class PeerAuthorizedKeys {
  readonly file: string;
  private activeLockToken: string | null = null;

  constructor(agentHome: string, private readonly dryRun: boolean) {
    const root = path.resolve(agentHome);
    this.file = path.join(root, '.ssh', 'authorized_keys');
    if (path.dirname(path.dirname(this.file)) !== root) throw new Error('peer-authorized-keys-scope-invalid');
  }

  reconcile(key: PeerAuthorizedKey): { changed: boolean; dryRun: boolean } {
    return this.withLock(() => {
      const parsed = parsePublicKey(key.publicKey);
      const comment = `${MARKER}:${encodeURIComponent(key.agentId)}:${encodeURIComponent(key.machineId)}:${key.pairingEpoch}:${key.clientKeyGeneration}`;
      const line = `${parsed.type} ${parsed.body} ${comment}`;
      const current = this.read();
      const retained = current
        .split(/\r?\n/)
        .filter(row => row.length > 0 && !isManagedForMachine(row, key.agentId, key.machineId));
      retained.push(line);
      const next = `${retained.join('\n')}\n`;
      if (next === current) return { changed: false, dryRun: this.dryRun };
      if (!this.dryRun) this.write(next);
      return { changed: true, dryRun: this.dryRun };
    });
  }

  revoke(agentId: string, machineId: string): { changed: boolean; dryRun: boolean } {
    return this.withLock(() => {
      const current = this.read();
      const retained = current.split(/\r?\n/).filter(row => row.length > 0 && !isManagedForMachine(row, agentId, machineId));
      const next = retained.length > 0 ? `${retained.join('\n')}\n` : '';
      if (next === current) return { changed: false, dryRun: this.dryRun };
      if (!this.dryRun) this.write(next);
      return { changed: true, dryRun: this.dryRun };
    });
  }

  revokeUnknown(agentId: string, activeMachineIds: ReadonlySet<string>): { changed: boolean; dryRun: boolean } {
    return this.withLock(() => {
      const current = this.read();
      const retained = current.split(/\r?\n/).filter(row => {
        if (row.length === 0) return false;
        const identity = managedIdentity(row);
        return !identity || identity.agentId !== agentId || activeMachineIds.has(identity.machineId);
      });
      const next = retained.length > 0 ? `${retained.join('\n')}\n` : '';
      if (next === current) return { changed: false, dryRun: this.dryRun };
      if (!this.dryRun) this.write(next);
      return { changed: true, dryRun: this.dryRun };
    });
  }

  has(key: PeerAuthorizedKey): boolean {
    const parsed = parsePublicKey(key.publicKey);
    return this.read().split(/\r?\n/).some(row =>
      row === `${parsed.type} ${parsed.body} ${MARKER}:${encodeURIComponent(key.agentId)}:${encodeURIComponent(key.machineId)}:${key.pairingEpoch}:${key.clientKeyGeneration}`,
    );
  }

  private read(): string {
    this.refuseSymlinks();
    try { return fs.readFileSync(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  private write(content: string): void {
    this.assertLockOwner();
    const dir = path.dirname(this.file);
    this.refuseSymlinks();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    this.refuseSymlinks();
    const tmp = path.join(dir, `.authorized_keys.${process.pid}.${randomUUID()}.tmp`);
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    this.assertLockOwner();
    fs.renameSync(tmp, this.file);
    fs.chmodSync(this.file, 0o600);
  }

  private refuseSymlinks(): void {
    for (const target of [path.dirname(this.file), this.file]) {
      try {
        if (fs.lstatSync(target).isSymbolicLink()) throw new Error('peer-authorized-keys-symlink-refused');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private withLock<T>(run: () => T): T {
    if (this.dryRun) return run();
    const lock = path.join(path.dirname(this.file), '.instar-authorized-keys.lock');
    const ownerFile = path.join(lock, 'owner.json');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    let acquired = false;
    const token = randomUUID();
    try {
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
        fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
        acquired = true;
        this.activeLockToken = token;
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let owner: { pid?: unknown; token?: unknown };
        try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { pid?: unknown; token?: unknown }; }
        catch { throw new Error('peer-authorized-keys-lock-busy'); }
        if (typeof owner.pid !== 'number' || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string') throw new Error('peer-authorized-keys-lock-busy');
        try {
          process.kill(owner.pid, 0);
          throw new Error('peer-authorized-keys-lock-busy');
        } catch (probeError) {
          if ((probeError as NodeJS.ErrnoException).code !== 'ESRCH') throw probeError;
        }
        SafeFsExecutor.safeRmSync(lock, { recursive: true, force: true, operation: 'PeerAuthorizedKeys:remove-stale-lock' });
        fs.mkdirSync(lock, { mode: 0o700 });
        fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
        acquired = true;
        this.activeLockToken = token;
      }
      return run();
    } finally {
      if (acquired) {
        try {
          const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { token?: unknown };
          if (owner.token === token) SafeFsExecutor.safeRmSync(lock, { recursive: true, force: true, operation: 'PeerAuthorizedKeys:release-lock' });
        } catch {
          // @silent-fallback-ok — ownership ambiguity fails closed: leave the
          // lock for liveness-checked recovery rather than delete another owner.
        }
      }
      if (this.activeLockToken === token) this.activeLockToken = null;
    }
  }

  private assertLockOwner(): void {
    if (!this.activeLockToken) throw new Error('peer-authorized-keys-lock-ownership-lost');
    const ownerFile = path.join(path.dirname(this.file), '.instar-authorized-keys.lock', 'owner.json');
    try {
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { pid?: unknown; token?: unknown };
      if (owner.pid !== process.pid || owner.token !== this.activeLockToken) throw new Error('peer-authorized-keys-lock-ownership-lost');
    } catch (error) {
      if (error instanceof Error && error.message === 'peer-authorized-keys-lock-ownership-lost') throw error;
      throw new Error('peer-authorized-keys-lock-ownership-lost');
    }
  }
}

function parsePublicKey(value: string): { type: string; body: string } {
  const [type, body] = value.trim().split(/\s+/, 3);
  const parsed = utils.parseKey(value);
  if (type !== 'ssh-ed25519' || !body || parsed instanceof Error || parsed.type !== 'ssh-ed25519') throw new Error('peer-authorized-key-invalid');
  return { type, body };
}

function isManagedForMachine(line: string, agentId: string, machineId: string): boolean {
  const identity = managedIdentity(line);
  return identity?.agentId === agentId && identity.machineId === machineId;
}

function managedIdentity(line: string): { agentId: string; machineId: string } | null {
  const comment = line.trim().split(/\s+/, 3)[2] ?? '';
  const fields = comment.split(':');
  if (fields[0] !== MARKER || !fields[1] || !fields[2]) return null;
  try { return { agentId: decodeURIComponent(fields[1]), machineId: decodeURIComponent(fields[2]) }; }
  catch {
    // @silent-fallback-ok — malformed managed comments are untrusted, unmanaged lines
    return null;
  }
}
