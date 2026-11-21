/**
 * identity-security piece 3a §2: a lone agent (no mesh identity) still needs a machine key in the owner record, to
 * write the genesis and attest the first owner key. This key signs owner-record entries only; it is never a mesh
 * identity, never advertised, and never changes how a lone agent listens. It lives with the machine keys
 * (`.instar/machine/`, never served, synced or backed up) and is created once, on first need.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OWNER_RECORD_LOCAL_KEY_FILE = path.join('machine', 'owner-record-key.pem');

export interface LocalRecordKey { machineId: string; publicKeyPem: string; sign: (text: string) => string }

function idFor(publicKeyPem: string): string {
  return 'm_local_' + crypto.createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 24);
}

function fromPrivatePem(pem: string): LocalRecordKey {
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the record-only key is not Ed25519');
  const publicKeyPem = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }) as string;
  return { machineId: idFor(publicKeyPem), publicKeyPem, sign: (text) => crypto.sign(null, Buffer.from(text), key).toString('base64') };
}

/** The key if it exists; null if not. A damaged key file throws: nothing is signed with a key we can't read. */
export function readLocalRecordKey(stateDir: string): LocalRecordKey | null {
  const file = path.join(stateDir, OWNER_RECORD_LOCAL_KEY_FILE);
  let pem: string;
  try { pem = fs.readFileSync(file, 'utf8'); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return fromPrivatePem(pem);
}

/** Read the key, creating it (0600, exclusive) when absent. Two racing creators: the loser reads the winner's key. */
export function ensureLocalRecordKey(stateDir: string): LocalRecordKey {
  const existing = readLocalRecordKey(stateDir);
  if (existing) return existing;
  const file = path.join(stateDir, OWNER_RECORD_LOCAL_KEY_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  try { fs.writeFileSync(file, pem, { mode: 0o600, flag: 'wx' }); } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return readLocalRecordKey(stateDir)!;
}
