import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import ssh2 from 'ssh2';
// `ssh2` is CommonJS: a NAMED esm import throws at load
// ("Named export 'utils' not found"). Default-import the namespace and destructure
// at runtime. See ssh2-cjs-named-imports side-effects artifact.
const { utils } = ssh2;
import { SafeFsExecutor } from './SafeFsExecutor.js';

export type PeerKeyNamespace = 'instar-peer-access' | 'instar-recovery-access';

export interface PeerAuthorizedKey {
  agentId: string;
  machineId: string;
  pairingEpoch: number;
  clientKeyGeneration: number;
  publicKey: string;
  /** Absolute path to an Instar-owned forced-command wrapper. Omitted for legacy callers. */
  forcedCommand?: string;
}

/**
 * Owns only the supplied agent account home's .ssh/authorized_keys and refuses
 * symlinked write targets.
 */
export class PeerAuthorizedKeys {
  readonly file: string;
  private activeLockToken: string | null = null;

  constructor(agentHome: string, private readonly dryRun: boolean, private readonly marker: PeerKeyNamespace = 'instar-peer-access') {
    const root = path.resolve(agentHome);
    this.file = path.join(root, '.ssh', 'authorized_keys');
    if (path.dirname(path.dirname(this.file)) !== root) throw new Error('peer-authorized-keys-scope-invalid');
  }

  reconcile(key: PeerAuthorizedKey): { changed: boolean; dryRun: boolean } {
    return this.withLock(() => {
      const parsed = parsePublicKey(key.publicKey);
      const comment = `${this.marker}:${encodeURIComponent(key.agentId)}:${encodeURIComponent(key.machineId)}:${key.pairingEpoch}:${key.clientKeyGeneration}`;
      const line = managedLine(parsed, comment, key.forcedCommand);
      const current = this.read();
      const retained = current
        .split(/\r?\n/)
        .filter(row => row.length > 0 && !isManagedForMachine(row, key.agentId, key.machineId, this.marker));
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
      const retained = current.split(/\r?\n/).filter(row => row.length > 0 && !isManagedForMachine(row, agentId, machineId, this.marker));
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
        const identity = managedIdentity(row, this.marker);
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
    const comment = `${this.marker}:${encodeURIComponent(key.agentId)}:${encodeURIComponent(key.machineId)}:${key.pairingEpoch}:${key.clientKeyGeneration}`;
    const expected = managedLine(parsed, comment, key.forcedCommand);
    return this.read().split(/\r?\n/).some(row => row === expected);
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

function isManagedForMachine(line: string, agentId: string, machineId: string, marker: PeerKeyNamespace): boolean {
  const identity = managedIdentity(line, marker);
  return identity?.agentId === agentId && identity.machineId === machineId;
}

function managedLine(parsed: { type: string; body: string }, comment: string, forcedCommand?: string): string {
  if (forcedCommand === undefined) return `${parsed.type} ${parsed.body} ${comment}`;
  if (!path.isAbsolute(forcedCommand) || /[\s"'\\,=\x00-\x1f\x7f]/.test(forcedCommand)) {
    throw new Error('peer-authorized-key-forced-command-invalid');
  }
  return `restrict,command="${forcedCommand}" ${parsed.type} ${parsed.body} ${comment}`;
}

function managedIdentity(line: string, marker: PeerKeyNamespace): { agentId: string; machineId: string } | null {
  // Match only the exact managed key position. This recognizes the legacy bare
  // line and the new restricted line, while preserving unrelated operator keys.
  const match = /^(?:restrict,command="[^"\s]+" )?ssh-ed25519 [A-Za-z0-9+/=]+ (instar-(?:peer|recovery)-access:[^\s]+)$/.exec(line.trim());
  if (!match) return null;
  const fields = match[1].split(':');
  if (fields[0] !== marker || fields.length !== 5 || !fields[1] || !fields[2]) return null;
  try { return { agentId: decodeURIComponent(fields[1]), machineId: decodeURIComponent(fields[2]) }; }
  catch {
    // @silent-fallback-ok — malformed managed comments are untrusted, unmanaged lines
    return null;
  }
}
