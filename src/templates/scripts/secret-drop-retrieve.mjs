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
 *   XD_PROFILE=<id> node .instar/scripts/secret-drop-retrieve.mjs <token> <field> --browser
 *     → a password requested with `browserHost`. Runs `xdrive.sh typesecret <that host>` with the value
 *     on stdin and consumes the submission only on exit 0. The host comes from the request, which the
 *     person saw on the form; the caller cannot name another. This is the only exit for such a
 *     submission: stdout, --run and --consume are refused.
 *     Spec: docs/specs/normal-chrome-linux.md.
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
// Flags end at `--`: anything after it belongs to the --run command.
const sepIdx = args.indexOf('--');
const ownArgs = sepIdx === -1 ? args : args.slice(0, sepIdx);
const consume = ownArgs.includes('--consume');
const browserMode = ownArgs.includes('--browser');

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

if (!token || !mode || mode === '--consume' || mode === '--run' || mode === '--browser') {
  process.stderr.write('usage: secret-drop-retrieve.mjs <token> <field-name|--names> [--consume | --run -- <cmd...> | --browser]\n');
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
let agentId = process.env.INSTAR_AGENT_ID || '';
let port;
try {
  const config = JSON.parse(fs.readFileSync('.instar/config.json', 'utf-8'));
  if (!authToken && typeof config.authToken === 'string') authToken = config.authToken;
  if (!agentId && typeof config.projectName === 'string') agentId = config.projectName;
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

// Always peek first: the rules below need to see the submission before anything can consume it.
const url = `http://localhost:${resolvedPort}/secrets/retrieve/${token}`;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${authToken}`,
    ...(agentId ? { 'X-Instar-AgentId': agentId } : {}),
  },
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

const browserHost = typeof body?.browserHost === 'string' ? body.browserHost : '';

if (browserMode && !browserHost) {
  process.stderr.write('retrieve: --browser is only for a request made with browserHost; this one has none, so nothing was typed\n');
  process.exit(1);
}

if (mode === '--names') {
  // Field-name listing for debugging — names + lengths only, never values.
  // A browser password's length is not shown either.
  for (const k of Object.keys(values)) {
    const v = values[k];
    const len = typeof v === 'string' ? v.length : -1;
    process.stderr.write(browserHost ? `  ${k}\n` : `  ${k} (length ${len})\n`);
  }
  process.exit(0);
}

if (browserHost && !browserMode) {
  process.stderr.write(`retrieve: this password is for ${browserHost} and leaves only with --browser; nothing was printed or consumed\n`);
  process.exit(1);
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
      headers: {
        'Authorization': `Bearer ${authToken}`,
        ...(agentId ? { 'X-Instar-AgentId': agentId } : {}),
      },
    });
  } catch (e) {
    // Non-fatal — the sliding/absolute-cap cleanup will reclaim it regardless. Said out loud, because
    // --consume used to be one atomic call and a caller may rely on the value being gone.
    process.stderr.write(`consume failed (${e.message}); the submission stays until its cleanup\n`);
  }
}

if (browserMode) {
  const here = new URL('.', import.meta.url).pathname;
  const child = spawnSync(`${here}browser/xdrive.sh`, ['typesecret', browserHost], {
    input: v,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf-8',
    env: { ...process.env, XD_SECRET_BROWSER: '1' },
  });
  if (child.error) {
    process.stderr.write(`browser: failed to launch xdrive.sh: ${child.error.message} — secret NOT consumed (safe to retry)\n`);
    process.exit(1);
  }
  const code = child.status ?? 1;
  if (code === 0) {
    await consumeSubmission();
    process.stderr.write('browser: typed — secret consumed. If the sign-in fails, ask for a new Secret Drop.\n');
  } else {
    process.stderr.write(`browser: exited ${code} — secret NOT consumed (read the page before retrying).\n`);
  }
  process.exit(code);
}

if (runMode) {
  // Pipe the value into the command's stdin; never let it touch argv (process
  // listings / shell history) or stdout (transcript). Inherit stdout/stderr so
  // the operator sees the command's own (non-secret) output.
  // XD_SECRET_RUN: xdrive.sh refuses a value arriving this way (only --browser may reach typesecret).
  const child = spawnSync(runCmd[0], runCmd.slice(1), {
    input: v,
    stdio: ['pipe', 'inherit', 'inherit'],
    encoding: 'utf-8',
    env: { ...process.env, XD_SECRET_RUN: '1' },
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
if (consume) await consumeSubmission();
