#!/usr/bin/env node
/**
 * secret-drop-retrieve.mjs — fetch a Secret Drop submission and stream the
 * requested field value to stdout WITHOUT ever printing the response body.
 * All informational output goes to stderr and is limited to field NAMES,
 * lengths, and HTTP status — never values.
 *
 * Hardened replacement for the ad-hoc `curl + jq` / `curl + python` pattern
 * that historically leaked credentials in plaintext into the Bash tool
 * transcript. The lesson: when probing an unknown JSON shape, NEVER fall
 * back to `console.log(JSON.stringify(body))` — that's how plaintext
 * credentials end up in shell history, session transcripts, and downstream
 * LLM context.
 *
 * Usage:
 *   node .instar/scripts/secret-drop-retrieve.mjs <token> <field-name>
 *     → prints the field value to stdout (single line, no trailing newline)
 *     → suitable for piping: `... password | gh secret set X`
 *
 *   node .instar/scripts/secret-drop-retrieve.mjs <token> --names
 *     → prints field names + lengths to stderr; nothing to stdout
 *     → use to discover what fields the submission contains
 *
 *   node .instar/scripts/secret-drop-retrieve.mjs <token> <field> --consume
 *     → opt into one-shot semantics (the submission is removed after read).
 *     Default is peek (non-destructive) per the 2026-05-20 hardening.
 *
 *   node .instar/scripts/secret-drop-retrieve.mjs <token> <field> --run -- <cmd...>
 *     → ATOMIC use-and-consume. Retrieves the field value, runs <cmd> with the
 *     value piped to its stdin, and consumes the submission ONLY if <cmd> exits
 *     0. On any non-zero exit the secret is left intact for retry. This makes it
 *     structurally impossible to drop a secret on a failed handoff — the
 *     2026-06-02 failure mode where a standalone `--consume` was fired after a
 *     step that had not actually succeeded. Prefer this over a separate
 *     retrieve-then-consume whenever the value feeds a single command.
 *     Example: `... <token> github_token --run -- gh auth login --with-token`
 *
 * Config:
 *   Reads `authToken` and `port` from `.instar/config.json` relative to cwd.
 *   `INSTAR_PORT` env var overrides the config port.
 *
 * Exit codes:
 *   0 — value or names printed successfully
 *   1 — HTTP error, missing field, or unexpected response shape
 *   2 — usage error (missing args, cannot read config)
 */

import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const token = args[0];
const mode = args[1];
const consume = args.includes('--consume');

// Atomic use-and-consume: `<token> <field> --run -- <cmd...>`. Everything after
// the first `--` (which must follow `--run`) is the command to run with the
// field value piped to its stdin. The submission is consumed only if the
// command exits 0, so a failed handoff never destroys the secret.
const runIdx = args.indexOf('--run');
const runMode = runIdx !== -1;
let runCmd = [];
if (runMode) {
  const sep = args.indexOf('--', runIdx + 1);
  runCmd = sep !== -1 ? args.slice(sep + 1) : [];
}

if (!token || !mode || mode === '--consume' || mode === '--run') {
  process.stderr.write('usage: secret-drop-retrieve.mjs <token> <field-name|--names> [--consume | --run -- <cmd...>]\n');
  process.exit(2);
}
if (runMode && runCmd.length === 0) {
  process.stderr.write('usage: --run requires a command after `--`, e.g. --run -- gh auth login --with-token\n');
  process.exit(2);
}

// Auth-token resolution: INSTAR_AUTH_TOKEN env first (SessionManager and
// JobScheduler inject it for every spawned context; survives the
// secret-externalization refactor that moved authToken out of config.json into
// the encrypted store), legacy plaintext-config fallback with a string-type
// guard so the { "secret": true } placeholder produced by SecretMigrator
// cannot leak through as a bogus Bearer.
let authToken = process.env.INSTAR_AUTH_TOKEN || '';
let port;
try {
  const config = JSON.parse(fs.readFileSync('.instar/config.json', 'utf-8'));
  if (!authToken && typeof config.authToken === 'string') authToken = config.authToken;
  port = config.port;
} catch (e) {
  if (!authToken) {
    process.stderr.write('cannot read .instar/config.json: ' + e.message + '\n');
    process.exit(2);
  }
}

// Port resolution: env > config. Mirrors the telegram-reply.sh precedence
// so a single explicit INSTAR_PORT override flows through every agent script.
const resolvedPort = process.env.INSTAR_PORT || port;
if (!resolvedPort) {
  process.stderr.write('cannot resolve port: no INSTAR_PORT env and no port in .instar/config.json\n');
  process.exit(2);
}

const url = `http://localhost:${resolvedPort}/secrets/retrieve/${token}${consume ? '?consume=true' : ''}`;
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${authToken}` },
});

if (!res.ok) {
  // Surface ONLY status + the structured error message field, never the body.
  let errMsg = '(no error message)';
  try {
    const body = await res.json();
    if (typeof body?.error === 'string') errMsg = body.error;
  } catch {
    // Don't fall back to printing raw response body — that's the leak we're
    // explicitly hardening against. Just report the HTTP status.
  }
  process.stderr.write(`HTTP ${res.status}: ${errMsg}\n`);
  process.exit(1);
}

const body = await res.json();

// Locate the values bag. The server's known shape is body.values; defend
// against future shape changes by checking the two most-likely nestings,
// but NEVER print the body itself.
const values = body?.values
  ?? body?.submission?.values
  ?? body?.fields
  ?? null;

if (!values || typeof values !== 'object') {
  process.stderr.write('retrieve: response did not contain a values bag (keys at top: '
    + Object.keys(body || {}).join(', ') + ')\n');
  process.exit(1);
}

if (mode === '--names') {
  // Field-name listing for debugging — names + lengths only, never values.
  for (const k of Object.keys(values)) {
    const v = values[k];
    const len = typeof v === 'string' ? v.length : -1;
    process.stderr.write(`  ${k} (length ${len})\n`);
  }
  process.exit(0);
}

const v = values[mode];
if (typeof v !== 'string') {
  process.stderr.write(`retrieve: field '${mode}' not found (available: `
    + Object.keys(values).join(', ') + ')\n');
  process.exit(1);
}

// Helper: consume the submission (idempotent best-effort). Used only after a
// verified-successful handoff in --run mode.
async function consumeSubmission() {
  try {
    await fetch(`http://localhost:${resolvedPort}/secrets/retrieve/${token}?consume=true`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}` },
    });
  } catch {
    // Non-fatal — the sliding/absolute-cap cleanup will reclaim it regardless.
  }
}

if (runMode) {
  // Pipe the value into the command's stdin; never let it touch argv (process
  // listings / shell history) or stdout (transcript). Inherit stdout/stderr so
  // the operator sees the command's own (non-secret) output.
  const child = spawnSync(runCmd[0], runCmd.slice(1), {
    input: v,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf-8',
  });
  if (child.error) {
    process.stderr.write(`run: failed to launch '${runCmd[0]}': ${child.error.message} — secret NOT consumed (safe to retry)\n`);
    process.exit(1);
  }
  const code = child.status ?? 1;
  if (code === 0) {
    await consumeSubmission();
    process.stderr.write('run: command succeeded — secret consumed.\n');
  } else {
    process.stderr.write(`run: command exited ${code} — secret NOT consumed (safe to retry).\n`);
  }
  process.exit(code);
}

// Stream the value to stdout, no trailing newline so it pipes cleanly into
// `gh secret set` or `bw unlock --raw`. process.stdout.write (not console.log)
// — no extra newline, no trailing whitespace to confuse downstream consumers.
process.stdout.write(v);
