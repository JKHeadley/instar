/**
 * Unit tests for the /test-as-self verify.mjs deterministic post-deploy verifier
 * (Task 4 Part 2 v1; spec: SELF-PROPAGATION-HARNESS-SPEC.md).
 *
 * Covers both sides of every check boundary (Testing Integrity Standard):
 *   - lease present / missing / unparseable / wrong-shape
 *   - lease fresh / stale
 *   - tokenHash-only security check (rejects raw-token in the file; rejects non-64-hex)
 *   - server demote line present / missing / no server.log
 *   - crash signatures detected per pattern, not detected on clean logs
 *   - aggregate report: all-pass exits 0; any fail exits 1
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  checkLease,
  checkServerDemote,
  tailCrashLines,
  runVerify,
} from '../../.claude/skills/test-as-self/scripts/verify.mjs';

const TOKEN = '1234567890:VerifyTestBotTokenZZZZAAAABBBBCCCC';
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest('hex');

let dir: string;

function leasePath() { return path.join(dir, '.instar', 'state', 'telegram-poll-owner.json'); }
function serverLogPath() { return path.join(dir, 'logs', 'server.log'); }
function lifelineLogPath() { return path.join(dir, 'logs', 'lifeline.log'); }

function writeLease(obj: unknown): void {
  fs.mkdirSync(path.dirname(leasePath()), { recursive: true });
  fs.writeFileSync(leasePath(), typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function writeServerLog(text: string): void {
  fs.mkdirSync(path.dirname(serverLogPath()), { recursive: true });
  fs.writeFileSync(serverLogPath(), text);
}
function writeLifelineLog(text: string): void {
  fs.mkdirSync(path.dirname(lifelineLogPath()), { recursive: true });
  fs.writeFileSync(lifelineLogPath(), text);
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-as-self-verify-')); });
afterEach(() => {
  try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/test-as-self-verify.test.ts' }); } catch { /* ignore */ }
});

describe('checkLease', () => {
  it('FAIL all four when the lease file is missing', () => {
    const r = checkLease(dir, 1_000);
    expect(r.checks['lease.present'].pass).toBe(false);
    expect(r.checks['lease.wellFormed'].pass).toBe(false);
    expect(r.checks['lease.fresh'].pass).toBe(false);
    expect(r.checks['lease.tokenHashOnly'].pass).toBe(false);
  });

  it('PASS present + FAIL well-formed when file is unparseable', () => {
    writeLease('{not valid');
    const r = checkLease(dir, 1_000);
    expect(r.checks['lease.present'].pass).toBe(true);
    expect(r.checks['lease.wellFormed'].pass).toBe(false);
  });

  it('FAIL well-formed when the JSON has the wrong shape', () => {
    writeLease({ pid: 1 }); // missing tokenHash/heartbeatTs/v
    const r = checkLease(dir, 1_000);
    expect(r.checks['lease.wellFormed'].pass).toBe(false);
  });

  it('PASS all four for a fresh, well-formed lease with tokenHash only', () => {
    writeLease({ pid: 42, tokenHash: TOKEN_HASH, heartbeatTs: 1_000, v: 1 });
    const r = checkLease(dir, 1_500, 5_000);
    expect(r.checks['lease.present'].pass).toBe(true);
    expect(r.checks['lease.wellFormed'].pass).toBe(true);
    expect(r.checks['lease.fresh'].pass).toBe(true);
    expect(r.checks['lease.tokenHashOnly'].pass).toBe(true);
  });

  it('FAIL fresh when the lease is older than staleMs', () => {
    writeLease({ pid: 1, tokenHash: TOKEN_HASH, heartbeatTs: 1_000, v: 1 });
    const r = checkLease(dir, 1_000 + 100_000, 90_000);
    expect(r.checks['lease.fresh'].pass).toBe(false);
  });

  it('FAIL tokenHashOnly (CRITICAL) if the on-disk file contains a raw-token shape', () => {
    // Pathological: someone wrote the raw token into the file by mistake.
    const bad = JSON.stringify({ pid: 1, tokenHash: TOKEN_HASH, heartbeatTs: 1_000, v: 1, oops: TOKEN });
    writeLease(bad);
    const r = checkLease(dir, 1_000);
    expect(r.checks['lease.tokenHashOnly'].pass).toBe(false);
    expect(r.checks['lease.tokenHashOnly'].detail).toContain('CRITICAL');
  });

  it('FAIL tokenHashOnly if tokenHash is not 64-hex', () => {
    writeLease({ pid: 1, tokenHash: 'short', heartbeatTs: 1_000, v: 1 });
    const r = checkLease(dir, 1_000);
    expect(r.checks['lease.tokenHashOnly'].pass).toBe(false);
  });
});

describe('checkServerDemote (proves Part 1 actually fired)', () => {
  it('FAIL when there is no server.log', () => {
    const r = checkServerDemote(dir);
    expect(r['server.demoteLogged'].pass).toBe(false);
    expect(r['server.demoteLogged'].detail).toContain('no logs/server.log');
  });

  it('FAIL when the log is present but the demote line is missing', () => {
    writeServerLog('startup\n  Telegram connected (full poll mode)\nmore logs\n');
    expect(checkServerDemote(dir)['server.demoteLogged'].pass).toBe(false);
  });

  it('PASS when the demote line is logged', () => {
    writeServerLog('startup\n  Telegram send-only mode (lifeline owns polling (lease detected))\n');
    expect(checkServerDemote(dir)['server.demoteLogged'].pass).toBe(true);
  });

  it('PASS even with the older send-only descriptor (still detects the family)', () => {
    writeServerLog('  Telegram send-only mode (lifeline owns polling)\n');
    expect(checkServerDemote(dir)['server.demoteLogged'].pass).toBe(true);
  });
});

describe('tailCrashLines — deterministic crash-signature capture', () => {
  it('returns [] when both logs are clean', () => {
    writeServerLog('all good\nstartup complete\n');
    writeLifelineLog('polling tick\n');
    expect(tailCrashLines(dir)).toEqual([]);
  });

  it('returns [] when logs are missing entirely', () => {
    expect(tailCrashLines(dir)).toEqual([]);
  });

  it('catches a V8 heap OOM (the actual CMT-560 signature, NOT a libc++ mutex bug)', () => {
    writeServerLog('normal line\nFATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory\nmore\n');
    const hits = tailCrashLines(dir);
    expect(hits.length).toBeGreaterThan(0);
    // The hit captures the offending LINE; some pattern in our list matched it.
    // First-match-wins on the regex array, so pattern may be FATAL ERROR / Allocation
    // failed / heap out of memory depending on order — but the line itself preserves
    // the full OOM signature for forensic use.
    expect(hits.some((h: { line: string }) => /heap out of memory/i.test(h.line))).toBe(true);
  });

  it('catches CheckIneffectiveMarkCompact (the GC-gave-up signature)', () => {
    writeServerLog('CheckIneffectiveMarkCompact triggered\n');
    expect(tailCrashLines(dir).length).toBeGreaterThan(0);
  });

  it('catches an Abort trap / SIGABRT in the lifeline log', () => {
    writeLifelineLog('Abort trap: 6\n');
    expect(tailCrashLines(dir).length).toBeGreaterThan(0);
  });

  it('records the offending line (capped to 200 chars) + source file', () => {
    writeServerLog('Allocation failed - JavaScript heap out of memory\n');
    const hits = tailCrashLines(dir);
    expect(hits[0].file).toBe('logs/server.log');
    expect(hits[0].line).toContain('Allocation failed');
  });
});

describe('runVerify — aggregate report', () => {
  it('allPass=true when lease is fresh + demote logged + no crashes', () => {
    writeLease({ pid: 1, tokenHash: TOKEN_HASH, heartbeatTs: 1_000, v: 1 });
    writeServerLog('  Telegram send-only mode (lifeline owns polling (lease detected))\n');
    writeLifelineLog('poll tick\n');
    const r = runVerify(dir, { now: 1_500, staleMs: 5_000 });
    expect(r.allPass).toBe(true);
    expect(r.crashes).toEqual([]);
  });

  it('allPass=false when ANY check fails (missing lease)', () => {
    writeServerLog('  Telegram send-only mode (lifeline owns polling (lease detected))\n');
    const r = runVerify(dir, { now: 1_500 });
    expect(r.allPass).toBe(false);
  });

  it('allPass=false when a crash signature is in the tail (even if other checks pass)', () => {
    writeLease({ pid: 1, tokenHash: TOKEN_HASH, heartbeatTs: 1_000, v: 1 });
    writeServerLog('  Telegram send-only mode (lifeline owns polling (lease detected))\nFATAL ERROR\n');
    const r = runVerify(dir, { now: 1_500, staleMs: 5_000 });
    expect(r.allPass).toBe(false);
    expect(r.crashes.length).toBeGreaterThan(0);
  });
});
