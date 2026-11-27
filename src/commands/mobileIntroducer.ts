/**
 * `instar mobile introducer show|add|list|remove` (docs/specs/mobile-pairing-introducer.md §3.1).
 *
 * `show` prints THIS agent's introducer entry (derived from its own identity, read from disk).
 * `add` / `remove` / `list` edit the `mobilePairing.ownerIntroducers` list in an agent's own
 * `.instar/config.json`. This is the creator's step when one agent sets up another for its owner:
 * whoever can run this already controls that agent's files, so it grants nothing new. The running
 * server reads the list at boot: restart the agent after a change.
 */
import fs from 'node:fs';
import path from 'node:path';
import { detectProjectDir } from '../core/Config.js';
import { IdentityManager } from '../threadline/client/IdentityManager.js';
import { deriveIntroducerKey, introducerKeyId, MAX_INTRODUCERS } from '../server/mobilePairingIntroducer.js';

interface DirOpt { dir?: string }

function configPathOf(opts: DirOpt): string {
  const dir = opts.dir ? path.resolve(opts.dir) : detectProjectDir();
  return path.join(dir, '.instar', 'config.json');
}

function readConfig(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) throw new Error(`No agent config at ${file}.`);
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

/** Atomic write, keeping the file's mode. */
function writeConfig(file: string, cfg: Record<string, unknown>): void {
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = `${file}.introducer-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
}

function keyOf(raw: string): Buffer {
  const k = raw.trim().replace(/=+$/, '');
  if (!/^[A-Za-z0-9_-]{40,48}$/.test(k)) throw new Error('The key must be a base64url Ed25519 public key (43 characters).');
  const b = Buffer.from(k, 'base64url');
  if (b.length !== 32) throw new Error('The key must decode to 32 bytes.');
  return b;
}

function list(cfg: Record<string, unknown>): Array<{ name: string; publicKey: string }> {
  const mp = (cfg.mobilePairing ?? {}) as Record<string, unknown>;
  return Array.isArray(mp.ownerIntroducers) ? (mp.ownerIntroducers as Array<{ name: string; publicKey: string }>) : [];
}

export function showIntroducer(opts: DirOpt & { json?: boolean }): void {
  const file = configPathOf(opts);
  const cfg = readConfig(file);
  const id = new IdentityManager(path.dirname(file)).get();
  if (!id) { console.error('This agent has no identity key yet, so it cannot vouch for phones.'); process.exitCode = 1; return; }
  const k = deriveIntroducerKey({ publicKey: id.publicKey, privateKey: id.privateKey });
  const entry = { name: String(cfg.projectName ?? 'agent'), publicKey: k.publicKey.toString('base64url') };
  if (opts.json) { console.log(JSON.stringify(entry)); return; }
  console.log(`Introducer: ${entry.name}  key ${introducerKeyId(k.publicKey)}`);
  console.log(`On the new agent's machine: instar mobile introducer add --name ${JSON.stringify(entry.name)} --key ${entry.publicKey}`);
}

export function addIntroducer(opts: DirOpt & { name: string; key: string }): void {
  const file = configPathOf(opts);
  const cfg = readConfig(file);
  const key = keyOf(opts.key);
  const name = opts.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 40);
  if (!name) throw new Error('A name is required.');
  const cur = list(cfg).filter((e) => { try { return !Buffer.from(String(e.publicKey).replace(/=+$/, ''), 'base64url').equals(key); } catch { return true; } });
  if (cur.length >= MAX_INTRODUCERS) throw new Error(`At most ${MAX_INTRODUCERS} introducers.`);
  cur.push({ name, publicKey: key.toString('base64url') });
  cfg.mobilePairing = { ...((cfg.mobilePairing ?? {}) as Record<string, unknown>), ownerIntroducers: cur };
  writeConfig(file, cfg);
  console.log(`Added ${name} (key ${introducerKeyId(key)}). Restart the agent so it reads the change.`);
}

export function removeIntroducer(opts: DirOpt & { key: string }): void {
  const file = configPathOf(opts);
  const cfg = readConfig(file);
  const key = keyOf(opts.key);
  const before = list(cfg);
  const after = before.filter((e) => { try { return !Buffer.from(String(e.publicKey).replace(/=+$/, ''), 'base64url').equals(key); } catch { return true; } });
  if (after.length === before.length) { console.log('No introducer with that key.'); return; }
  cfg.mobilePairing = { ...((cfg.mobilePairing ?? {}) as Record<string, unknown>), ownerIntroducers: after };
  writeConfig(file, cfg);
  console.log(`Removed key ${introducerKeyId(key)}. Restart the agent so it reads the change.`);
}

export function listIntroducers(opts: DirOpt): void {
  const rows = list(readConfig(configPathOf(opts)));
  if (rows.length === 0) { console.log('No introducers: phones pair with Telegram, the pairing page or the code.'); return; }
  for (const e of rows) {
    let id = 'invalid key';
    try { id = introducerKeyId(keyOf(String(e.publicKey))); } catch { /* @silent-fallback-ok — shown as invalid; the server skips it too */ }
    console.log(`${e.name}  key ${id}`);
  }
}
