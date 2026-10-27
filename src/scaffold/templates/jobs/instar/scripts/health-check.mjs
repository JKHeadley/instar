#!/usr/bin/env node
/**
 * health-check.mjs — script port of the `health-check` built-in job.
 *
 * Reads the authenticated /health and the free space on the volume that holds
 * the agent's state directory, and reports each observed condition as one
 * JOB_ANOMALY line with a stable reason id (spec §5.3):
 *   disk-low (2)            free space < 10%
 *   disk-critical (3)       free space < 5%
 *   sessions-exhausted (2)  the session limit is reached
 *   llm-unreliable (2)      llmReliability.status !== 'ok'
 *   degradation:<feature>   one per entry of the authed `degradationFeatures`,
 *                           with the matching degradationSummary string as evidence
 * Deliberately NOT a reason: consecutiveJobFailures (each failing job alerts on
 * its own), and /health unreachable or non-200 (that is a failed run).
 * Canary flag: --disk-free-override <percent>.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Canary-only flags this script accepts beyond --server-url. */
const ACCEPTS = { prober: false, diskFreeOverride: true };

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

const MAX_DEGRADATIONS = 20;

function diskFreePercent() {
  if (CANARY && ARGS.diskFreeOverride !== null) {
    const v = Number(ARGS.diskFreeOverride);
    if (!Number.isFinite(v) || v < 0 || v > 100) finish('failed', 'disk-free-override-invalid');
    return v;
  }
  const stateDir = fs.existsSync('.instar') ? path.resolve('.instar') : process.cwd();
  try {
    const s = fs.statfsSync(stateDir);
    if (!(s.blocks > 0)) return null;
    return (Number(s.bavail) / Number(s.blocks)) * 100;
  } catch {
    // @silent-fallback-ok: reported below as a failed run (disk-unreadable)
    return null;
  }
}

async function main() {
  const r = await call('GET', '/health', { timeoutMs: 30_000 });
  if (r.status !== 200 || r.malformed || !isObject(r.json)) failNoAnswer('health', r);
  const h = r.json;
  // The session counts ride the authenticated branch only; without them the
  // token was refused and this check would silently miss half its signals.
  if (!isObject(h.sessions)) finish('failed', 'health-unauthenticated: /health answered without its authenticated fields');

  const freePct = diskFreePercent();
  if (freePct === null) finish('failed', 'disk-unreadable: could not read free space on the state volume');

  const kinds = [];
  const freeText = `${freePct.toFixed(1)}% free on the agent volume`;
  if (freePct < 5) { anomaly('disk-critical', 3, freeText); kinds.push('disk-critical'); }
  else if (freePct < 10) { anomaly('disk-low', 2, freeText); kinds.push('disk-low'); }

  const cur = h.sessions.current;
  const max = h.sessions.max;
  if (isCount(cur) && isCount(max) && max > 0 && cur >= max) {
    anomaly('sessions-exhausted', 2, `${cur} of ${max} sessions in use`);
    kinds.push('sessions-exhausted');
  }

  if (isObject(h.llmReliability) && h.llmReliability.status !== 'ok') {
    const why = h.llmReliability.reason ? ` (${clean(h.llmReliability.reason, 200)})` : '';
    anomaly('llm-unreliable', 2, `LLM reliability is ${clean(h.llmReliability.status, 40)}${why}`);
    kinds.push('llm-unreliable');
  }

  const features = Array.isArray(h.degradationFeatures) ? h.degradationFeatures : [];
  const summaries = Array.isArray(h.degradationSummary) ? h.degradationSummary : [];
  const seen = new Set();
  features.forEach((f, i) => {
    if (typeof f !== 'string' || seen.size >= MAX_DEGRADATIONS) return;
    const id = f.replace(/[^A-Za-z0-9_.:-]+/g, '_').slice(0, 60);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const evidence = typeof summaries[i] === 'string' ? summaries[i] : `${id} reported degraded`;
    anomaly(`degradation:${id}`, 2, evidence);
    kinds.push(`degradation:${id}`);
  });

  field('disk_free_pct', freePct.toFixed(1));
  field('sessions_current', cur);
  field('sessions_max', max);
  field('degradations', h.degradations);
  if (isObject(h.llmReliability)) field('llm_status', h.llmReliability.status);

  if (kinds.length === 0) finish('ok', 'healthy');
  finish('ok', `observed ${kinds.length} condition(s): ${kinds.join(' ')}`);
}

main();
