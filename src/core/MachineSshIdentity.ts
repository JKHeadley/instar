import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { withSyncOp } from './InFlightSyncOpMarker.js';

export interface MachineSshIdentityRecord {
  agentId: string;
  machineId: string;
  clientGeneration: number;
  hostGeneration: number;
  clientPrivateKeyPath: string;
  clientPublicKey: string;
  hostPrivateKeyPath: string;
  hostPublicKey: string;
  previousHostPrivateKeyPath?: string;
  previousHostPublicKey?: string;
}

const PRIVATE_MODE = 0o600;

function readPublic(file: string): string {
  return fs.readFileSync(file, 'utf8').trim();
}

function matchingPair(privatePath: string, publicPath: string): boolean {
  try {
    const derived = withSyncOp(() => execFileSync('ssh-keygen', ['-y', '-f', privatePath], { encoding: 'utf8' })).trim().split(/\s+/).slice(0, 2).join(' ');
    const installed = readPublic(publicPath).split(/\s+/).slice(0, 2).join(' ');
    return installed.startsWith(`${derived} `) || installed === derived;
  } catch {
    return false;
  }
}

/** Owns only Instar's dedicated keys. It never reads or writes ~/.ssh. */
export class MachineSshIdentity {
  private readonly root: string;

  constructor(stateDir: string, private readonly agentId: string, private readonly machineId: string) {
    this.root = path.join(stateDir, 'machine-ssh');
  }

  ensure(options: { forceClientRotation?: boolean; forceHostRotation?: boolean } = {}): MachineSshIdentityRecord {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(this.root).isSymbolicLink()) throw new Error('ssh-identity-root-symlink-refused');
    fs.chmodSync(this.root, 0o700);
    const metadataPath = path.join(this.root, 'identity.json');
    let metadata = { clientGeneration: 1, hostGeneration: 1 };
    const established = fs.existsSync(metadataPath);
    if (established) {
      try { metadata = { ...metadata, ...JSON.parse(fs.readFileSync(metadataPath, 'utf8')) }; }
      catch { throw new Error('ssh-identity-metadata-invalid'); }
      if (!Number.isSafeInteger(metadata.clientGeneration) || metadata.clientGeneration < 1 || !Number.isSafeInteger(metadata.hostGeneration) || metadata.hostGeneration < 1) throw new Error('ssh-identity-metadata-invalid');
    }

    const client = this.ensurePair('client', metadata.clientGeneration, () => { metadata.clientGeneration += 1; }, options.forceClientRotation === true, established);
    const host = this.ensurePair('host', metadata.hostGeneration, () => { metadata.hostGeneration += 1; }, options.forceHostRotation === true, established);
    const metadataTmp = `${metadataPath}.${process.pid}.tmp`;
    fs.writeFileSync(metadataTmp, `${JSON.stringify(metadata, null, 2)}\n`, { mode: PRIVATE_MODE });
    fs.renameSync(metadataTmp, metadataPath);
    fs.chmodSync(metadataPath, PRIVATE_MODE);
    const previousHostPrivateKeyPath = metadata.hostGeneration > 1 ? path.join(this.root, `host-ed25519-g${metadata.hostGeneration - 1}`) : undefined;
    const previousHostPublicPath = previousHostPrivateKeyPath ? `${previousHostPrivateKeyPath}.pub` : undefined;
    return {
      agentId: this.agentId,
      machineId: this.machineId,
      clientGeneration: metadata.clientGeneration,
      hostGeneration: metadata.hostGeneration,
      clientPrivateKeyPath: client.privatePath,
      clientPublicKey: readPublic(client.publicPath),
      hostPrivateKeyPath: host.privatePath,
      hostPublicKey: readPublic(host.publicPath),
      ...(previousHostPrivateKeyPath && previousHostPublicPath && fs.existsSync(previousHostPrivateKeyPath) && fs.existsSync(previousHostPublicPath)
        && !fs.lstatSync(previousHostPrivateKeyPath).isSymbolicLink() && !fs.lstatSync(previousHostPublicPath).isSymbolicLink()
        && (fs.statSync(previousHostPrivateKeyPath).mode & 0o777) === PRIVATE_MODE && matchingPair(previousHostPrivateKeyPath, previousHostPublicPath)
        ? { previousHostPrivateKeyPath, previousHostPublicKey: readPublic(previousHostPublicPath) }
        : {}),
    };
  }

  private ensurePair(kind: 'client' | 'host', generation: number, rotate: () => void, force = false, established = false) {
    let current = generation;
    let privatePath = path.join(this.root, `${kind}-ed25519-g${current}`);
    let publicPath = `${privatePath}.pub`;
    const valid = !force && fs.existsSync(privatePath) && fs.existsSync(publicPath)
      && !fs.lstatSync(privatePath).isSymbolicLink() && !fs.lstatSync(publicPath).isSymbolicLink()
      && (fs.statSync(privatePath).mode & 0o777) === PRIVATE_MODE
      && matchingPair(privatePath, publicPath);
    if (!valid) {
      if (established || fs.existsSync(privatePath) || fs.existsSync(publicPath)) { rotate(); current += 1; }
      privatePath = path.join(this.root, `${kind}-ed25519-g${current}`);
      publicPath = `${privatePath}.pub`;
      withSyncOp(() => execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `instar:${this.agentId}:${this.machineId}:${current}`, '-f', privatePath], { stdio: 'ignore' }));
      fs.chmodSync(privatePath, PRIVATE_MODE);
    }
    return { privatePath, publicPath };
  }

  static fingerprint(publicKey: string): string {
    const body = publicKey.trim().split(/\s+/)[1] ?? '';
    return `SHA256:${createHash('sha256').update(Buffer.from(body, 'base64')).digest('base64').replace(/=+$/, '')}`;
  }
}
