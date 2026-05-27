#!/usr/bin/env node
// test-as-self / verify.mjs — Deterministic post-deploy verifier for the
// throwaway-agent harness (Task 4 Part 2 v1; spec: SELF-PROPAGATION-HARNESS-SPEC.md).
//
// Given a deployed test agent dir, this script:
//   1. Reads the Telegram poll-ownership lease (Part 1 artifact) and validates
//      it is present, fresh, well-formed, and contains ONLY the tokenHash
//      (security check: never the raw token).
//   2. Greps server.log for the Part 1 "send-only mode (lifeline owns polling)"
//      demote line — proves Part 1 actually fired in the live deploy, not just
//      that the module is shipped.
//   3. Tails server.log + lifeline.log for FATAL / OOM / V8-heap-exhaustion /
//      mark-compact signatures — surfaces the REAL crash signature deterministically,
//      replacing the post-hoc log forensics that left CMT-560's "libc++ mutex"
//      diagnosis wrong (it was actually a V8 heap OOM).
//
// Output: a single JSON report on stdout. Exit code 0 = all PASS; 1 = at least
// one FAIL or a crash was detected. Designed for both human reading + CI.
//
// USAGE:
//   node verify.mjs --dir <agent-home> [--stale-ms <ms>] [--tail-lines <N>] [--quiet]

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ── CLI parsing (tiny, no deps) ─────────────────────────────────────────
function parseArgs(argv) {
  const out = { dir: null, staleMs: 90_000, tailLines: 200, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--stale-ms') out.staleMs = Number(argv[++i]);
    else if (a === '--tail-lines') out.tailLines = Number(argv[++i]);
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--help' || a === '-h') {
      process.stdout.write('verify.mjs --dir <agent-home> [--stale-ms <ms>] [--tail-lines <N>] [--quiet]\n');
      process.exit(0);
    }
  }
  if (!out.dir) { process.stderr.write('error: --dir is required\n'); process.exit(2); }
  return out;
}

// ── Lease checks (Part 1 artifact) ──────────────────────────────────────
const LEASE_REL = 'state/telegram-poll-owner.json';

export function checkLease(dir, now = Date.now(), staleMs = 90_000) {
  const checks = {
    'lease.present': { pass: false, detail: '' },
    'lease.wellFormed': { pass: false, detail: '' },
    'lease.fresh': { pass: false, detail: '' },
    'lease.tokenHashOnly': { pass: false, detail: '' },
  };
  const p = join(dir, '.instar', LEASE_REL);
  if (!existsSync(p)) {
    checks['lease.present'].detail = `no file at .instar/${LEASE_REL} — lifeline never polled successfully`;
    return { checks, lease: null };
  }
  checks['lease.present'].pass = true;
  checks['lease.present'].detail = p;

  let raw, parsed;
  try {
    raw = readFileSync(p, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    checks['lease.wellFormed'].detail = `parse error: ${err.message}`;
    return { checks, lease: null };
  }
  if (typeof parsed?.pid !== 'number' || typeof parsed?.tokenHash !== 'string' ||
      typeof parsed?.heartbeatTs !== 'number' || parsed?.v !== 1) {
    checks['lease.wellFormed'].detail = `bad shape: ${JSON.stringify(parsed).slice(0, 120)}`;
    return { checks, lease: parsed };
  }
  checks['lease.wellFormed'].pass = true;
  checks['lease.wellFormed'].detail = `pid=${parsed.pid} v=${parsed.v}`;

  const ageMs = now - parsed.heartbeatTs;
  checks['lease.fresh'].pass = ageMs >= 0 && ageMs <= staleMs;
  checks['lease.fresh'].detail = `ageMs=${ageMs} (staleMs=${staleMs})`;

  // Security: tokenHash must be 64-hex AND the raw file must NEVER contain a
  // bot-token shape (digits:letters). This catches a regression where someone
  // accidentally stores the raw token in the lease.
  const tokenHashOk = /^[0-9a-f]{64}$/.test(parsed.tokenHash);
  const looksLikeRawToken = /\b\d{6,}:[A-Za-z0-9_-]{20,}\b/.test(raw);
  checks['lease.tokenHashOnly'].pass = tokenHashOk && !looksLikeRawToken;
  checks['lease.tokenHashOnly'].detail = looksLikeRawToken
    ? 'CRITICAL: file appears to contain a raw bot-token shape'
    : (tokenHashOk ? 'tokenHash is 64-hex; no raw-token shape in file' : 'tokenHash is not 64-hex');

  return { checks, lease: parsed };
}

// ── Demote-log check (Part 1 actually fired in the live deploy) ─────────
const DEMOTE_RE = /Telegram send-only mode \(lifeline owns polling/;

export function checkServerDemote(dir) {
  const out = { 'server.demoteLogged': { pass: false, detail: '' } };
  const p = join(dir, 'logs', 'server.log');
  if (!existsSync(p)) {
    out['server.demoteLogged'].detail = 'no logs/server.log (server never started?)';
    return out;
  }
  try {
    const text = readFileSync(p, 'utf8');
    if (DEMOTE_RE.test(text)) {
      out['server.demoteLogged'].pass = true;
      out['server.demoteLogged'].detail = 'send-only (lifeline owns polling) line found';
    } else {
      out['server.demoteLogged'].detail = 'server.log present but no demote line — Part 1 may not be wired';
    }
  } catch (err) {
    out['server.demoteLogged'].detail = `read error: ${err.message}`;
  }
  return out;
}

// ── Crash-tail (deterministic signature capture) ────────────────────────
const CRASH_PATTERNS = [
  /FATAL ERROR/i,
  /JavaScript heap out of memory/i,
  /CheckIneffectiveMarkCompact/i,
  /FatalProcessOutOfMemory/i,
  /Allocation failed/i,
  /Abort trap/i,
  /SIGABRT/i,
  /Segmentation fault/i,
  /libc\+\+abi/i,
  /pthread_kill/i,
];

export function tailCrashLines(dir, tailLines = 200) {
  const hits = [];
  for (const rel of [['logs', 'server.log'], ['logs', 'lifeline.log']]) {
    const p = join(dir, ...rel);
    if (!existsSync(p)) continue;
    let text;
    try { text = readFileSync(p, 'utf8'); }
    catch (err) { hits.push({ file: rel.join('/'), error: err.message }); continue; }
    const lines = text.split('\n');
    const tail = lines.slice(Math.max(0, lines.length - tailLines));
    for (const line of tail) {
      for (const re of CRASH_PATTERNS) {
        if (re.test(line)) { hits.push({ file: rel.join('/'), pattern: re.source, line: line.slice(0, 200) }); break; }
      }
    }
  }
  return hits;
}

// ── Report assembly ─────────────────────────────────────────────────────
export function runVerify(dir, opts = {}) {
  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? 90_000;
  const tailLines = opts.tailLines ?? 200;
  const leaseResult = checkLease(dir, now, staleMs);
  const demoteResult = checkServerDemote(dir);
  const crashes = tailCrashLines(dir, tailLines);

  const checks = { ...leaseResult.checks, ...demoteResult, 'crashes.found': {
    pass: crashes.length === 0,
    detail: crashes.length === 0 ? 'no crash signatures in tail' : `${crashes.length} crash signature(s)`,
  } };

  const allPass = Object.values(checks).every((c) => c.pass) && crashes.length === 0;
  return { dir, allPass, checks, crashes };
}

// ── Entry point (only when run as CLI) ──────────────────────────────────
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.dir)) {
    process.stderr.write(`error: dir does not exist: ${args.dir}\n`);
    process.exit(2);
  }
  if (!statSync(args.dir).isDirectory()) {
    process.stderr.write(`error: not a directory: ${args.dir}\n`);
    process.exit(2);
  }
  const report = runVerify(args.dir, { staleMs: args.staleMs, tailLines: args.tailLines });
  if (!args.quiet) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(report.allPass ? 0 : 1);
}
