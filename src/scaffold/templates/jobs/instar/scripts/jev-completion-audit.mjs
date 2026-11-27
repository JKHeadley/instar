#!/usr/bin/env node
/**
 * jev-completion-audit.mjs — script port of `jev-completion-audit`.
 *
 * One POST /jev-audit/batch. 503 = the audit is not constructed here. A
 * `skipped.disabled` / `skipped.soak-expired` count with nothing audited is
 * the shipped dark state, so the run is skipped, not failed.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Canary-only flags this script accepts beyond --server-url. */
const ACCEPTS = { prober: false, diskFreeOverride: false };

// ── Shared script-job prelude ────────────────────────────────────────────────
// Identical in every built-in job script (each script must stay self-contained:
// node ESM, built-in modules only). Protocol: docs/specs/job-cost-reduction.md
// §5.2; CLI contract and canary flags: §5.6.4.
//
// - Exactly one `JOB_RESULT ok|skipped|failed <text>` line. Exit 0 for ok and
//   skipped, 1 for failed, 2 for a refused flag.
// - Optional `JOB_ANOMALY <kind> <1-3> <evidence>` and `JOB_FIELD <key> <value>`.
// - Canary mode needs BOTH `--canary` in argv AND INSTAR_SCRIPT_CANARY=1. Only
//   then are `--server-url` (loopback only) and the script's own test flags
//   accepted. Outside canary mode they are refused.
// - These scripts never write a file and never message anyone.

const ARGV = process.argv.slice(2);

function emit(line) {
  // writeSync: a pipe write on macOS is asynchronous, and process.exit() would
  // drop a pending one.
  fs.writeSync(1, line + '\n');
}

function clean(text, max = 300) {
  return String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** A JOB_FIELD / reason-code value: ^[A-Za-z0-9_.:/-]{1,64}$. */
function code(value) {
  const v = String(value ?? '').replace(/[^A-Za-z0-9_.:/-]+/g, '_').slice(0, 64);
  return v.length > 0 ? v : 'none';
}

let finished = false;
function finish(result, text, exitCode) {
  if (finished) return;
  finished = true;
  emit(`JOB_RESULT ${result} ${clean(text, 1000)}`.trimEnd());
  process.exit(exitCode ?? (result === 'failed' ? 1 : 0));
}

function field(key, value) {
  if (value === undefined || value === null) return;
  emit(`JOB_FIELD ${key} ${code(value)}`);
}

function anomaly(kind, severity, evidence) {
  emit(`JOB_ANOMALY ${kind} ${severity} ${clean(evidence, 300)}`.trimEnd());
}

function parseArgs(argv) {
  const out = { canary: false, serverUrl: null, prober: null, diskFreeOverride: null, refused: null };
  const canaryRequested = argv.includes('--canary');
  out.canary = canaryRequested && process.env.INSTAR_SCRIPT_CANARY === '1';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--canary') continue;
    const takesValue = { '--server-url': 'serverUrl', '--prober': 'prober', '--disk-free-override': 'diskFreeOverride' }[a];
    const allowed = a === '--server-url'
      || (a === '--prober' && ACCEPTS.prober)
      || (a === '--disk-free-override' && ACCEPTS.diskFreeOverride);
    if (!takesValue || !allowed) { out.refused = a; return out; }
    if (!out.canary) { out.refused = a; return out; }
    const value = argv[i + 1];
    if (value === undefined) { out.refused = a; return out; }
    out[takesValue] = value;
    i++;
  }
  if (canaryRequested && !out.canary) out.refused = '--canary';
  return out;
}

/** Loopback only: the parsed hostname must be 127.0.0.1 or ::1, with no userinfo. */
function loopbackUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (u.hostname !== '127.0.0.1' && u.hostname !== '[::1]' && u.hostname !== '::1') return null;
  return u.origin;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join('.instar', 'config.json'), 'utf8')) ?? {};
  } catch {
    // @silent-fallback-ok: an absent or unreadable config falls back to env + defaults
    return {};
  }
}

const ARGS = parseArgs(ARGV);
if (ARGS.refused) finish('failed', `flag-refused ${clean(ARGS.refused, 40)}`, 2);
const CANARY = ARGS.canary;
const CONFIG = readConfig();
const TOKEN = process.env.INSTAR_AUTH_TOKEN || (typeof CONFIG.authToken === 'string' ? CONFIG.authToken : '');
const AGENT_ID = process.env.INSTAR_AGENT_ID || String(CONFIG.projectName ?? '');
let BASE = `http://127.0.0.1:${process.env.INSTAR_PORT || CONFIG.port || 4042}`;
if (CANARY && ARGS.serverUrl !== null) {
  const origin = loopbackUrl(ARGS.serverUrl);
  if (!origin) finish('failed', 'canary-url-refused');
  BASE = origin;
}

/** Bounded wait; a canary may shorten it so a must-fail fixture finishes quickly. */
function bound(ms, envKey = 'INSTAR_SCRIPT_HTTP_TIMEOUT_MS') {
  const override = Number(process.env[envKey]);
  return CANARY && Number.isFinite(override) && override > 0 ? override : ms;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One authenticated server call. status 0 = no answer (unreachable or timed out). */
async function call(method, route, { body, headers, timeoutMs = 60_000 } = {}) {
  const h = { Authorization: `Bearer ${TOKEN}`, ...(AGENT_ID ? { 'X-Instar-AgentId': AGENT_ID } : {}), ...(headers ?? {}) };
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(BASE + route, { method, headers: h, body: payload, signal: AbortSignal.timeout(bound(timeoutMs)) });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { status: 0, json: undefined, malformed: false, error: timedOut ? 'timeout' : 'unreachable' };
  }
  let text = '';
  try { text = await res.text(); } catch {
    // @silent-fallback-ok: a body that cannot be read is reported as malformed below
    return { status: res.status, json: undefined, malformed: true, error: null };
  }
  try {
    return { status: res.status, json: text.length > 0 ? JSON.parse(text) : null, malformed: false, error: null };
  } catch {
    // @silent-fallback-ok: reported to the caller as malformed
    return { status: res.status, json: undefined, malformed: true, error: null };
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The common failure for a call that got no usable answer. */
function failNoAnswer(what, r) {
  if (r.status === 0) finish('failed', r.error === 'timeout' ? `${what}-timeout` : 'server-unreachable');
  if (r.malformed) finish('failed', `${what}-malformed-response HTTP ${r.status}`);
  const detail = isObject(r.json) ? clean(r.json.error ?? r.json.reason ?? '', 200) : '';
  finish('failed', `${what}-http-${r.status}${detail ? ' ' + detail : ''}`);
}

process.on('uncaughtException', (err) => finish('failed', `script-error ${clean(err && err.message, 200)}`));
process.on('unhandledRejection', (err) => finish('failed', `script-error ${clean(err && err.message, 200)}`));
// ── end of shared prelude ────────────────────────────────────────────────────

async function main() {
  const r = await call('POST', '/jev-audit/batch', { body: {}, timeoutMs: 150_000 });
  if (r.status === 503) finish('skipped', 'feature-dark');
  if (r.status !== 200 || r.malformed || !isObject(r.json)) failNoAnswer('batch', r);
  const b = r.json;
  if (!isCount(b.audited) || !isObject(b.skipped)) finish('failed', 'batch-malformed-response: expected audited, skipped');
  if (b.audited === 0 && (b.skipped.disabled ?? 0) > 0) finish('skipped', 'feature-dark');
  if (b.audited === 0 && (b.skipped['soak-expired'] ?? 0) > 0) finish('skipped', 'soak-expired');
  finish('ok', `audited=${b.audited}`);
}

main();
