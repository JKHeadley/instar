/**
 * Persisting the agent's own Witness key.
 *
 * The key file is written once with mode 0600 and never overwritten: replacing
 * a Witness key silently would orphan every record it signed. Rotation, when
 * it exists, will be an explicit operation that publishes a new binding.
 */

import fs from 'node:fs';
import path from 'node:path';
import { generateWitnessKey, keyIdFor, publicKeyFromPrivate, type WitnessKeyPair } from './keys.js';

export const KEY_FILE_NAME = 'witness-key.json';

/** Load the key in `dir`, creating it on first use. Throws if an existing file is inconsistent. */
export function loadOrCreateWitnessKey(dir: string): { key: WitnessKeyPair; created: boolean } {
  const file = path.join(dir, KEY_FILE_NAME);
  if (fs.existsSync(file)) return { key: readKeyFile(file), created: false };
  fs.mkdirSync(dir, { recursive: true });
  const key = generateWitnessKey();
  try {
    fs.writeFileSync(file, JSON.stringify(key, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (err) {
    // Another process created it first; use theirs rather than fork the identity.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { key: readKeyFile(file), created: false };
    throw err;
  }
  return { key, created: true };
}

function readKeyFile(file: string): WitnessKeyPair {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WitnessKeyPair>;
  if (typeof raw.privateKey !== 'string' || typeof raw.publicKey !== 'string') {
    throw new Error(`${file}: missing publicKey or privateKey`);
  }
  if (publicKeyFromPrivate(raw.privateKey) !== raw.publicKey) {
    throw new Error(`${file}: publicKey does not match privateKey`);
  }
  return { publicKey: raw.publicKey, privateKey: raw.privateKey, keyId: keyIdFor(raw.publicKey) };
}
