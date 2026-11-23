#!/usr/bin/env node
/**
 * secret-set.mjs — write ONE secret value into the agent's encrypted SecretStore
 * vault, reading the value from stdin. The write half of the no-echo transfer
 * (docs/specs/gemini-payg-metered-lane.md §4, "Console to drop, without echo"):
 *
 *   node .instar/scripts/secret-drop-retrieve.mjs <token> <field> --run -- \
 *     node .instar/scripts/secret-set.mjs gemini_api_key_payg
 *
 * The value travels drop → stdin → vault and is never printed to a session.
 *
 * Containment contract (sibling of secret-get.mjs and secret-drop-retrieve.mjs):
 *   - The value is read from stdin ONLY — never from argv (a command line is
 *     visible to every process on the machine) and never from an interactive
 *     prompt (a terminal on stdin is refused, so the value cannot be typed into
 *     a transcript and the command cannot hang waiting for input).
 *   - Nothing is written to stdout. Diagnostics go to stderr and name the key
 *     path and the value LENGTH only — never the value.
 *   - One trailing newline (\n or \r\n) is removed, so `printf` and `echo`
 *     producers store the same bytes. Nothing else is trimmed.
 *
 * Usage:
 *   <producer> | node .instar/scripts/secret-set.mjs <keyPath>
 *
 * Vault access:
 *   Loads the instar SecretStore implementation from the local install and writes
 *   the vault at `.instar/secrets/config.secrets.enc` relative to cwd (run from the
 *   agent home) — the same store, master key and write path the server reads.
 *
 * Exit codes:
 *   0 — stored
 *   1 — empty value, unreadable stdin, or the vault write failed
 *   2 — usage error (missing/invalid key path, stdin is a terminal, cannot
 *       resolve the instar dist)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const keyPath = args[0];

// A dot path of plain identifiers (the shape every vault key has), at most 64
// characters, and not shaped like a credential. A value pasted where the key name goes
// is refused WITHOUT being repeated (its argv exposure has already happened; it must not
// also land in a transcript through this script's own output).
const SECRET_SHAPES = /^(AIza|sk-|sk_|ghp_|gho_|github_pat_|xox[abpr]-|ya29\.|AKIA|glpat-|eyJ)/;
const looksLikeASecret = (k) => SECRET_SHAPES.test(k) || (/^[A-Za-z0-9_-]{32,}$/.test(k) && /[0-9]/.test(k) && /[A-Z]/.test(k) && /[a-z]/.test(k));
if (!keyPath || args.length !== 1 || keyPath.length > 64 || !/^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(keyPath) || looksLikeASecret(keyPath)) {
  process.stderr.write('usage: <producer> | secret-set.mjs <keyPath>   (the value is read from stdin, never argv; the key path is a short name such as gemini_api_key_payg)\n');
  process.exit(2);
}

if (process.stdin.isTTY) {
  process.stderr.write('secret-set: refusing to read a secret from a terminal — pipe the value in (e.g. secret-drop-retrieve.mjs <token> <field> --run -- node .instar/scripts/secret-set.mjs <keyPath>)\n');
  process.exit(2);
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
  process.stderr.write('secret-set: cannot resolve the instar SecretStore module (run from the agent home)\n');
  process.exit(2);
}

let raw;
try {
  raw = fs.readFileSync(0);
} catch (err) {
  process.stderr.write(`secret-set: could not read stdin (${err && err.code ? err.code : 'read-failed'})\n`);
  process.exit(1);
}
let value = raw.toString('utf8');
if (value.endsWith('\r\n')) value = value.slice(0, -2);
else if (value.endsWith('\n')) value = value.slice(0, -1);
raw.fill(0);

if (value.length === 0) {
  process.stderr.write(`secret-set: refusing to store an empty value for ${keyPath}\n`);
  process.exit(1);
}

try {
  new SecretStore({ stateDir: path.resolve('.instar') }).set(keyPath, value);
} catch (err) {
  // The error class only — a message could carry vault content.
  process.stderr.write(`secret-set: the vault write failed (${err && err.name ? err.name : 'error'})\n`);
  process.exit(1);
}
process.stderr.write(`secret-set: stored ${keyPath} (${value.length} chars)\n`);
value = '';
process.exit(0);
