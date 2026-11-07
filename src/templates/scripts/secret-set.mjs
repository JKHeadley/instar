#!/usr/bin/env node
/**
 * secret-set.mjs — write ONE secret into the agent's encrypted SecretStore vault,
 * reading the VALUE FROM STDIN so it never appears in argv, a shell variable, a
 * process listing, or an agent transcript. The write-side sibling of secret-get.mjs.
 *
 * Containment contract:
 *   - The value is read from stdin only. Never an argument.
 *   - stdout stays EMPTY. All diagnostics go to stderr and carry key NAMES and
 *     lengths only — never values.
 *   - Refuses to overwrite an existing key unless --force is passed, so a typo
 *     in a key path cannot silently clobber a credential.
 *
 * Usage:
 *   <producer> | node .instar/scripts/secret-set.mjs <keyPath>
 *   <producer> | node .instar/scripts/secret-set.mjs <keyPath> --force
 *
 * Exit codes:
 *   0 — written
 *   1 — vault absent/undecryptable, or key exists without --force
 *   2 — usage error, or cannot resolve the instar dist
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const force = args.includes('--force');
const keyPath = args.filter((a) => !a.startsWith('--'))[0];

if (!keyPath) {
  process.stderr.write('usage: <producer> | secret-set.mjs <keyPath> [--force]\n');
  process.exit(2);
}

const require = createRequire(import.meta.url);
const candidates = [
  path.resolve('.instar/shadow-install/node_modules/instar/dist/core/SecretStore.js'),
  path.resolve('dist/core/SecretStore.js'),
];
let SecretStore = null;
for (const c of candidates) {
  if (fs.existsSync(c)) {
    try { ({ SecretStore } = require(c)); break; } catch { /* next candidate */ }
  }
}
if (!SecretStore) {
  process.stderr.write('secret-set: cannot resolve the instar SecretStore module (run from the agent home)\n');
  process.exit(2);
}

const stateDir = path.resolve('.instar');
if (!fs.existsSync(path.join(stateDir, 'secrets', 'config.secrets.enc'))) {
  process.stderr.write('secret-set: no vault on this machine (.instar/secrets/config.secrets.enc absent)\n');
  process.exit(1);
}

let value = '';
for await (const chunk of process.stdin) value += chunk;
value = value.replace(/\n+$/, '');
if (!value) {
  process.stderr.write('secret-set: stdin was empty — nothing written\n');
  process.exit(2);
}

const store = new SecretStore({ stateDir });
try {
  store.read();
} catch {
  process.stderr.write(
    'secret-set: vault exists but could not be decrypted (master-key mismatch?). ' +
      'Do NOT repair/rotate/delete — surface to the operator.\n',
  );
  process.exit(1);
}

const existing = store.get(keyPath);
if (existing !== undefined && existing !== null && !force) {
  process.stderr.write(
    `secret-set: "${keyPath}" already exists (${String(existing).length} chars). ` +
      'Pass --force to overwrite.\n',
  );
  process.exit(1);
}

store.set(keyPath, value);
process.stderr.write(`secret-set: wrote "${keyPath}" (${value.length} chars)${existing ? ' [overwrote]' : ''}\n`);
process.exit(0);
