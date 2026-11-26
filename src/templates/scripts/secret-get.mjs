#!/usr/bin/env node
/**
 * Read one vault leaf and pass it to a designated consumer on stdin.
 * A bare lookup refuses before opening the vault. Child output is discarded.
 * The internal --pipe-fd3 mode uses a dedicated inherited private pipe.
 * Diagnostics contain key paths, lengths and fixed error text only.
 *
 * Usage:
 *   node .instar/scripts/secret-get.mjs --names
 *   node .instar/scripts/secret-get.mjs <keyPath> --run -- <cmd...>
 *
 * Plain-config fallback:
 *   A key the vault lacks (or a machine with no vault) is read from a PLAIN
 *   string at the same dot path in `.instar/config.json`, with a one-line
 *   stderr note naming the source. A `{ "secret": true }` placeholder there is
 *   a vault reference and is never returned.
 *
 * Vault access:
 *   Loads the instar SecretStore implementation from the local install and reads
 *   the vault at `.instar/secrets/config.secrets.enc` relative to cwd (run from
 *   the agent home). Keychain-backed master key by default — the same read path
 *   the server uses.
 *
 * Exit codes:
 *   0 — transfer succeeded, the consumer exited successfully, or names listed
 *   1 — key not found, vault absent/undecryptable, or --run command failed
 *   2 — usage error (missing args, cannot resolve the instar dist)
 *   3 — refused: a metered (pay-per-use) key, readable only by its door
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const boundary = args.indexOf('--');
const own = boundary < 0 ? args : args.slice(0, boundary);
const keyPath = own[0];
const namesOnly = boundary < 0 && own.length === 1 && keyPath === '--names';
const runCmd = boundary === 2 && own[1] === '--run' && args.length > 3 ? args.slice(3) : null;
const privatePipe = boundary < 0 && own.length === 2 && own[1] === '--pipe-fd3';
const matchesPath = typeof keyPath === 'string' && /^[A-Za-z0-9_-]+(?:\[[0-9]+\])*(?:\.[A-Za-z0-9_-]+(?:\[[0-9]+\])*)*$/.test(keyPath);

// METERED keys bill real money per token (gemini-payg-metered-lane §4.2). They are
// readable only by their door inside the agent server, never by a session. Refused
// HERE, before vault resolution and before the plain-config fallback, in every branch
// (stdout and --run alike). This literal list is pinned to METERED_SECRET_NAMES in
// src/core/meteredSecrets.ts by a template-drift test; the `metered_` prefix covers
// any future bench key.
const METERED_SECRET_NAMES = ['gemini_api_key_payg', 'metered_gemini_bench', 'metered_openrouter_bench', 'metered_groq_bench'];
const METERED_SECRET_PREFIX = 'metered_';
if (keyPath) {
  const first = keyPath.split(/[.\[]/, 1)[0];
  if (METERED_SECRET_NAMES.includes(first) || first.startsWith(METERED_SECRET_PREFIX)) {
    process.stderr.write('refused: metered key — readable only by its door\n');
    process.exit(3);
  }
}

if (!namesOnly && (!matchesPath || (!runCmd && !privatePipe))) {
  process.stderr.write('usage: secret-get.mjs --names | secret-get.mjs <keyPath> --run -- <cmd...>\n');
  process.exit(2);
}
if (privatePipe) {
  try {
    const stat = fs.fstatSync(3, { bigint: true });
    if (!stat.isFIFO() && !stat.isSocket()) throw new Error('not a pipe');
    for (const fd of [1, 2]) {
      const output = fs.fstatSync(fd, { bigint: true });
      if (output.dev === stat.dev && output.ino === stat.ino) throw new Error('standard output alias');
    }
  } catch {
    process.stderr.write('secret-get: a private pipe on descriptor 3 is required\n');
    process.exit(2);
  }
}

// Resolve the instar dist: deployed agents run from the shadow-install; the dev
// checkout falls back to its own dist. Never print resolution paths on success.
const require = createRequire(import.meta.url);
const candidates = [
  path.resolve('.instar/shadow-install/node_modules/instar/dist/core/SecretStore.js'),
  path.resolve('dist/core/SecretStore.js'),
];
let SecretStore = null;
for (const c of candidates) {
  if (fs.existsSync(c)) {
    try {
      ({ SecretStore } = require(c));
      break;
    } catch {
      // try the next candidate; details are not value-bearing but stay off stdout
    }
  }
}
if (!SecretStore) {
  process.stderr.write('secret-get: cannot resolve the instar SecretStore module (run from the agent home)\n');
  process.exit(2);
}

const stateDir = path.resolve('.instar');

// A machine whose secrets were never moved into the vault (no `instar pair` /
// migration yet) still holds them as plain strings in `.instar/config.json`.
// The server reads them there, so this script does too: a key the vault lacks
// (or a machine with no vault) falls back to a PLAIN string at the same dot
// path in config.json. A `{ "secret": true }` placeholder is a vault
// reference, never a value, and is not returned. Same containment contract:
// the value goes to the selected consumer, and the note names the source only.
function plainConfigValue(key) {
  try {
    let node = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
    for (const part of key.match(/[^.\[\]]+/g) ?? []) {
      if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) return null;
      node = node[part];
    }
    return typeof node === 'string' && node.length > 0 ? node : null;
  } catch {
    return null;
  }
}

let configFallback = null;
if (!fs.existsSync(path.join(stateDir, 'secrets', 'config.secrets.enc'))) {
  configFallback = namesOnly ? null : plainConfigValue(keyPath);
  if (configFallback === null) {
    process.stderr.write('secret-get: no vault on this machine (.instar/secrets/config.secrets.enc absent)\n');
    process.exit(1);
  }
  process.stderr.write(`secret-get: no vault on this machine; read "${keyPath}" from .instar/config.json\n`);
}

let secrets = {};
if (configFallback === null) try {
  secrets = new SecretStore({ stateDir }).read();
} catch {
  process.stderr.write(
    'secret-get: vault exists but could not be decrypted (master-key mismatch?). ' +
      'Do NOT repair/rotate/delete — surface to the operator.\n',
  );
  process.exit(1);
}

// Flatten to dot-notation leaves — names + lengths only, mirroring the vault's
// own get/set addressing. Only leaf addresses are eligible for transfer.
function leaves(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = Array.isArray(obj) ? `${prefix}[${k}]` : prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') out.push(...leaves(v, p));
    else out.push([p, v]);
  }
  return out;
}
const entries = leaves(secrets);

if (namesOnly) {
  for (const [name, value] of entries) {
    process.stderr.write(`${name} (${String(value ?? '').length} chars)\n`);
  }
  if (entries.length === 0) process.stderr.write('(vault is empty)\n');
  process.exit(0);
}

let hit = configFallback === null ? entries.find(([name]) => name === keyPath) : [keyPath, configFallback];
if (!hit) {
  const plain = plainConfigValue(keyPath);
  if (plain !== null) {
    process.stderr.write(`secret-get: "${keyPath}" is not in the vault; read it from .instar/config.json\n`);
    hit = [keyPath, plain];
  }
}
if (!hit) {
  process.stderr.write(`secret-get: no key "${keyPath}" in the vault or as plain text in .instar/config.json. Known vault keys:\n`);
  for (const [name] of entries) process.stderr.write(`  ${name}\n`);
  process.exit(1);
}
const value = typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]);

// Prototype agent-held Google passkeys (spec agent-held-google-passkey §6,
// Increment 1): reads stay allowed so the operator-run prototype scripts keep
// working, but every read is recorded — key name and time only, never the value
// — until the operator adopts or deletes that key.
if (keyPath.split('.')[0].startsWith('google_passkey_')) {
  try {
    const logDir = path.join(stateDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, 'passkey-legacy-reads.jsonl'),
      JSON.stringify({ ts: new Date().toISOString(), key: keyPath, pid: process.pid, mode: runCmd ? 'run' : 'private-pipe' }) + '\n',
    );
  } catch {
    // Audit is best-effort: a logging failure must never block or leak the read.
  }
}

if (runCmd) {
  const r = spawnSync(runCmd[0], runCmd.slice(1), { input: value, stdio: ['pipe', 'ignore', 'ignore'] });
  process.exit(r.status ?? 1);
}

try {
  fs.writeFileSync(3, value);
} catch {
  process.stderr.write('secret-get: private pipe transfer failed\n');
  process.exitCode = 1;
}
