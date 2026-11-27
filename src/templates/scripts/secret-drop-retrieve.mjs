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
 *     (unsafe or option-like names are selected as '#N'; keep the quotes in a shell)
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

// SEC-156: a browser-only password never comes back to this helper. The server refuses it (409) with the
// field names and the host; --names lists them, and --browser asks the server to type it, server-side.
if (res.status === 409) {
  let info = null;
  try { info = await res.json(); } catch { /* @silent-fallback-ok — handled as a plain error below */ }
  if (info?.error === 'browser-only') {
    const host = typeof info.browserHost === 'string' ? info.browserHost : 'the browser';
    const refs = Array.isArray(info.fieldRefs) ? info.fieldRefs.filter((r) => typeof r === 'string') : [];
    if (mode === '--names') {
      if (info.origin === 'unverified') process.stderr.write('retrieve: this request [unverified origin: made without the agent key]\n');
      refs.forEach((r) => process.stderr.write(`  ${r.startsWith('#') ? `'${r}'` : r}\n`));
      process.exit(0);
    }
    if (!browserMode) {
      process.stderr.write(`retrieve: this password is for ${host} and leaves only with --browser; nothing was printed or consumed\n`);
      process.exit(1);
    }
    let typed;
    try {
      const r = await fetch(`http://localhost:${resolvedPort}/secrets/type/${token}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json',
          ...(agentId ? { 'X-Instar-AgentId': agentId } : {}),
        },
        body: JSON.stringify({ field: mode, profile: process.env.XD_PROFILE || '' }),
      });
      typed = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
      if (!r.ok) {
        process.stderr.write(`browser: ${typeof typed?.error === 'string' ? typed.error : `HTTP ${r.status}`}${typeof typed?.detail === 'string' ? ` (${typed.detail})` : ''} — secret NOT consumed (safe to retry)\n`);
        process.exit(1);
      }
    } catch (e) {
      process.stderr.write(`browser: could not reach the agent server (${e.message}) — secret NOT consumed (safe to retry)\n`);
      process.exit(1);
    }
    // The server never returns the driver's output (it was just handed the secret); only a fixed category.
    if (typed.typed) {
      process.stderr.write(typed.consumed
        ? 'browser: typed — secret consumed. If the sign-in fails, ask for a new Secret Drop.\n'
        : 'browser: typed. If the sign-in fails, ask for a new Secret Drop.\n');
      process.exit(0);
    }
    const why = typed.category === 'timeout' ? 'the browser driver timed out' : 'the browser driver did not finish typing';
    process.stderr.write(`browser: ${why} (exit ${typed.exitCode ?? 1}) — secret NOT consumed (read the page before retrying; the driver's own messages are not kept, so run the driver yourself to see them).\n`);
    process.exit(typeof typed.exitCode === 'number' && typed.exitCode > 0 ? typed.exitCode : 1);
  }
  process.stderr.write(`HTTP 409: ${typeof info?.error === 'string' ? info.error : '(no error message)'}\n`);
  process.exit(1);
}

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

// A field is named by its name when that is safe to type in a command, else by its
// 1-based position `#N` (the server gives the same references as body.fieldRefs).
const fieldNames = Object.keys(values);
const SHELL_UNSAFE = /[\s`$'"\\;|&<>()*?!#~\[\]{}^\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const refOf = (name, i) => (name.length > 0 && !name.startsWith('-') && !SHELL_UNSAFE.test(name) ? name : `#${i + 1}`);
// A bare # starts a shell comment. Listings offer a pasteable, quoted selector.
const commandRefOf = (name, i) => {
  const ref = refOf(name, i);
  return ref.startsWith('#') ? `'${ref}'` : ref;
};
const origin = body?.origin === 'unverified' ? ' [unverified origin: made without the agent key]' : '';

if (mode === '--names') {
  // Field references for debugging — references + lengths only, never values.
  // A browser password's length is not shown either.
  if (origin) process.stderr.write(`retrieve: this request${origin}\n`);
  fieldNames.forEach((k, i) => {
    const v = values[k];
    const len = typeof v === 'string' ? v.length : -1;
    process.stderr.write(browserHost ? `  ${commandRefOf(k, i)}\n` : `  ${commandRefOf(k, i)} (length ${len})\n`);
  });
  process.exit(0);
}

if (browserHost && !browserMode) {
  process.stderr.write(`retrieve: this password is for ${browserHost} and leaves only with --browser; nothing was printed or consumed\n`);
  process.exit(1);
}

const posMatch = /^#(\d{1,3})$/.exec(mode);
const fieldName = posMatch ? fieldNames[Number(posMatch[1]) - 1] : mode;
const v = fieldName === undefined ? undefined : values[fieldName];
if (typeof v !== 'string') {
  process.stderr.write(`retrieve: field '${mode}' not found (available: `
    + fieldNames.map(commandRefOf).join(', ') + ')\n');
  process.exit(1);
}

// Helper: consume the submission. Returns true only when the server confirmed it. The server
// removes the stored copy first and answers 503 (nothing consumed) if it cannot, so a
// failure is retried once and then said out loud: the value stays until its cleanup.
async function consumeSubmission() {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`http://localhost:${resolvedPort}/secrets/retrieve/${token}?consume=true`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          ...(agentId ? { 'X-Instar-AgentId': agentId } : {}),
        },
      });
      if (res.ok) return true;
      if (attempt === 2) {
        process.stderr.write(`consume refused (HTTP ${res.status}); the secret was NOT marked consumed and stays until its cleanup\n`);
        return false;
      }
    } catch (e) {
      // @silent-fallback-ok — retried once, then reported on stderr and returned as not consumed
      if (attempt === 2) {
        process.stderr.write(`consume failed (${e.message}); the secret was NOT marked consumed and stays until its cleanup\n`);
        return false;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

if (browserMode) {
  // SEC-156: the server types a browser password itself (POST /secrets/type) and never returns it; the
  // 409 branch above handles that. A server that still returned one here is older than this helper:
  // refuse rather than handle the value.
  process.stderr.write('browser: this agent server returned a browser password instead of typing it; update the agent. Nothing was typed or consumed.\n');
  process.exit(1);
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
    const consumed = await consumeSubmission();
    process.stderr.write(consumed ? 'run: command succeeded — secret consumed.\n' : 'run: command succeeded.\n');
  } else {
    process.stderr.write(`run: command exited ${code} — secret NOT consumed (safe to retry).\n`);
  }
  process.exit(code);
}

// Stream the value to stdout, no trailing newline so it pipes cleanly into
// `gh secret set` or `bw unlock --raw`. process.stdout.write (not console.log)
// — no extra newline, no trailing whitespace to confuse downstream consumers.
process.stdout.write(v);
if (consume && !(await consumeSubmission())) process.exitCode = 1;
