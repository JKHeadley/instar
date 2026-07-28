#!/usr/bin/env node
/**
 * secret-get.mjs — read ONE secret value from the agent's encrypted SecretStore
 * vault and stream it to stdout for piping. The retrieval affordance promised by
 * the Session Boot Self-Knowledge block (docs/specs/session-boot-self-knowledge.md):
 * a session that boots knowing `github_token` is in the vault uses THIS script to
 * fetch it — never `node -e` ad-hoc reads, never asking the user to re-send it.
 *
 * Containment contract (sibling of secret-drop-retrieve.mjs, same rules):
 *   - The VALUE goes to stdout ONLY — single write, no trailing newline — so it
 *     can pipe straight into the consuming command without ever being echoed
 *     into a terminal, chat, or transcript.
 *   - ALL diagnostics go to stderr and are limited to key NAMES, lengths, and
 *     error categories — never values.
 *   - On ANY error, stdout receives ZERO value bytes (stderr-only, non-zero exit).
 *
 * Usage:
 *   node .instar/scripts/secret-get.mjs <keyPath>
 *     → prints the value to stdout. Pipe it: `... github_token | gh auth login --with-token`
 *
 *   node .instar/scripts/secret-get.mjs --names
 *     → prints vault key paths + value lengths to stderr; nothing to stdout.
 *
 *   node .instar/scripts/secret-get.mjs <keyPath> --run -- <cmd...>
 *     → runs <cmd> with the value piped to its stdin (atomic handoff — the value
 *     never touches a shell variable or the transcript). Exits with <cmd>'s code.
 *
 * Vault access:
 *   Loads the instar SecretStore implementation from the local install and reads
 *   the vault at `.instar/secrets/config.secrets.enc` relative to cwd (run from
 *   the agent home). Keychain-backed master key by default — the same read path
 *   the server uses.
 *
 * Exit codes:
 *   0 — value printed (or --run command succeeded, or --names listed)
 *   1 — key not found, vault absent/undecryptable, or --run command failed
 *   2 — usage error (missing args, cannot resolve the instar dist)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);

// `<keyPath> --run -- <cmd...>`: everything after the first `--` (which must
// follow `--run`) is the command to receive the value on stdin.
const runIdx = args.indexOf('--run');
const dashIdx = args.indexOf('--');
let runCmd = null;
if (runIdx !== -1) {
  if (dashIdx === -1 || dashIdx < runIdx || dashIdx === args.length - 1) {
    process.stderr.write('usage: secret-get.mjs <keyPath> --run -- <cmd...>\n');
    process.exit(2);
  }
  runCmd = args.slice(dashIdx + 1);
}
const positional = (dashIdx === -1 ? args : args.slice(0, dashIdx)).filter((a) => !a.startsWith('--'));
const namesOnly = args.includes('--names');
const keyPath = positional[0];

if (!namesOnly && !keyPath) {
  process.stderr.write('usage: secret-get.mjs <keyPath> | secret-get.mjs --names\n');
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
  process.stderr.write('secret-get: cannot resolve the instar SecretStore module (run from the agent home)\n');
  process.exit(2);
}

const stateDir = path.resolve('.instar');
if (!fs.existsSync(path.join(stateDir, 'secrets', 'config.secrets.enc'))) {
  process.stderr.write('secret-get: no vault on this machine (.instar/secrets/config.secrets.enc absent)\n');
  process.exit(1);
}

let secrets;
try {
  secrets = new SecretStore({ stateDir }).read();
} catch {
  process.stderr.write(
    'secret-get: vault exists but could not be decrypted (master-key mismatch?). ' +
      'Do NOT repair/rotate/delete — surface to the operator.\n',
  );
  process.exit(1);
}

// Flatten to dot-notation leaves — names + lengths only, mirroring the vault's
// own get/set addressing. Values never leave this function except via stdout.
function leaves(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...leaves(v, p));
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

const hit = entries.find(([name]) => name === keyPath);
if (!hit) {
  process.stderr.write(`secret-get: no key "${keyPath}" in the vault. Known keys:\n`);
  for (const [name] of entries) process.stderr.write(`  ${name}\n`);
  process.exit(1);
}
const value = typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]);

if (runCmd) {
  const r = spawnSync(runCmd[0], runCmd.slice(1), { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
  process.exit(r.status ?? 1);
}

process.stdout.write(value);
process.exit(0);
