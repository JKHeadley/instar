#!/usr/bin/env node
/**
 * credential-store.mjs — the ONLY sanctioned way to save a credential on this agent.
 * Operator rule (Justin, 2026-09-23): a credential stored only locally is a liability;
 * every credential must also be in Bitwarden.
 *
 * Order is Bitwarden FIRST, local vault second, so a failure can never leave a
 * local-only credential behind. The value is read from stdin only and never printed.
 *
 * Usage:
 *   <producer> | node .instar/scripts/credential-store.mjs <vaultKey> --bw-name "<item name>" \
 *        [--bw-user <username>] [--bw-uri <url>] [--bw-note "<what it is>"] [--force]
 *   --force replaces an existing local key AND updates the Bitwarden item's password
 *   (Bitwarden keeps the old one in password history).
 */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const { openBw } = require('./bw-session.cjs');
const guard = require('./browser/lockout-guard.cjs');

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const force = argv.includes('--force');
const key = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;
const name = opt('--bw-name');
if (!key || !name) { process.stderr.write('usage: <producer> | credential-store.mjs <vaultKey> --bw-name "<item>" [--bw-user u] [--bw-uri url] [--bw-note text] [--force]\n'); process.exit(2); }

const approval = opt('--operator-approval') || argv.find(a => a.startsWith('--operator-approval='))?.slice('--operator-approval='.length);
const field = opt('--bw-field');
try {
  // Names only: never inspect or print credential values to classify them.
  const names = JSON.stringify([key, name, field || '']);
  const operation = JSON.stringify({ force, user: opt('--bw-user') || '', uri: opt('--bw-uri') || '', note: opt('--bw-note') || '' });
  const prior = process.env.INSTAR_OPERATOR_APPROVAL;
  process.env.INSTAR_OPERATOR_APPROVAL = approval || '';
  await guard.main(['credential', process.cwd(), 'credential-store', names, operation]);
  if (prior === undefined) delete process.env.INSTAR_OPERATOR_APPROVAL; else process.env.INSTAR_OPERATOR_APPROVAL = prior;
} catch (e) { process.stderr.write(`ERR credential-store: break-glass access refused; ${e.message}\n`); process.exit(1); }

const chunks = []; for await (const c of process.stdin) chunks.push(c);
const value = Buffer.concat(chunks).toString();
if (!value) { process.stderr.write('credential-store: empty value on stdin — refusing\n'); process.exit(2); }

const { bw, close } = openBw();
try {
  const existing = JSON.parse(bw(['list', 'items', '--search', name])).filter((i) => i.name === name);
  if (existing.length > 1) throw new Error(`more than one Bitwarden item is named "${name}" — resolve that first`);
  let id;
  const stamp = `Stored via credential-store on ${new Date().toISOString().slice(0, 10)}. Local vault key: ${key}.`;
  if (existing.length === 1) {
    if (!force) throw new Error(`Bitwarden item "${name}" already exists — pass --force to update its password`);
    const full = JSON.parse(bw(['get', 'item', existing[0].id]));
    full.login = full.login || { uris: [] };
    if (field) {
      full.fields = (full.fields || []).filter(f => f.name !== field);
      full.fields.push({ name: field, value, type: 1 });
    } else full.login.password = value;
    if (opt('--bw-user')) full.login.username = opt('--bw-user');
    full.notes = [full.notes, stamp].filter(Boolean).join('\n');
    // The encoded item (it holds the password) goes on stdin, never argv: argv is visible in `ps`.
    bw(['edit', 'item', full.id], bw(['encode'], JSON.stringify(full)).trim());
    id = full.id;
  } else {
    const i = JSON.parse(bw(['get', 'template', 'item']));
    Object.assign(i, { type: 1, name, favorite: false, fields: [], notes: [opt('--bw-note'), stamp].filter(Boolean).join('\n') });
    i.login = { uris: opt('--bw-uri') ? [{ match: null, uri: opt('--bw-uri') }] : [], username: opt('--bw-user') || null, password: value, totp: null };
    if (field) { i.login.password = null; i.fields = [{ name: field, value, type: 1 }]; }
    id = JSON.parse(bw(['create', 'item'], bw(['encode'], JSON.stringify(i)).trim())).id;
  }
  const verified = JSON.parse(bw(['get', 'item', id]));
  if ((field ? verified.fields?.find(f => f.name === field)?.value : verified.login.password) !== value) throw new Error('Bitwarden read-back does not match — NOT writing locally');
  execFileSync('node', ['.instar/scripts/secret-set.mjs', key, ...(force ? ['--force'] : [])], { input: value, stdio: ['pipe', 'ignore', 'inherit'], env: { ...process.env, CREDENTIAL_STORE_SANCTIONED: '1' } });
  process.stderr.write(`credential-store: "${key}" saved to Bitwarden ("${name}", verified) and the local vault\n`);
} catch (e) {
  process.stderr.write(`credential-store: FAILED — ${e.message}\n`); process.exitCode = 1;
} finally { close(); }
