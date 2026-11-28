/**
 * load-assess.sh — script behavior (CMT-1703, spec robust-load-assessment-fleet).
 *
 * Runs the REAL template script with the LOAD_ASSESS_FORCE_IDLE test seam to
 * exercise the verdict-threshold boundaries deterministically, plus the --json
 * contract and the fail-soft path (no server → ledger=unavailable, still a verdict).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(__dirname, '../../src/templates/scripts/load-assess.sh');

let fixture: string;
let script: string;

beforeAll(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'load-assess-test-'));
  const scripts = path.join(fixture, '.instar', 'scripts');
  const bin = path.join(fixture, 'bin');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(bin);
  script = path.join(scripts, 'load-assess.sh');
  fs.copyFileSync(SCRIPT, script);
  // The verdict tests force idle below. Skip only the real sampling wait on each platform.
  fs.writeFileSync(path.join(bin, 'top'), '#!/bin/sh\nprintf "%s\\n" "CPU usage: 0.0% user, 0.0% sys, 100.0% idle"\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
});

afterAll(() => {
  SafeFsExecutor.safeRmSync(fixture, { recursive: true, force: true, operation: 'load-assess-script.test:cleanup' });
});

function run(forceIdle: string, json = true): string {
  const env = { ...process.env, PATH: path.join(fixture, 'bin') + path.delimiter + process.env.PATH, LOAD_ASSESS_FORCE_IDLE: forceIdle };
  const args = json ? ['--json'] : [];
  return execFileSync('bash', [script, ...args], { env, encoding: 'utf-8', timeout: 20000 });
}

describe('load-assess.sh — verdict thresholds (both sides of each boundary)', () => {
  it('idle <12% → SATURATED', () => {
    expect(JSON.parse(run('5')).verdict).toBe('SATURATED');
    expect(JSON.parse(run('11.9')).verdict).toBe('SATURATED');
  });
  it('boundary 12: idle 12% → ELEVATED (not SATURATED)', () => {
    expect(JSON.parse(run('12')).verdict).toBe('ELEVATED');
  });
  it('12–30% → ELEVATED', () => {
    expect(JSON.parse(run('20')).verdict).toBe('ELEVATED');
    expect(JSON.parse(run('29.9')).verdict).toBe('ELEVATED');
  });
  it('boundary 30: idle 30% → OK (not ELEVATED)', () => {
    expect(JSON.parse(run('30')).verdict).toBe('OK');
  });
  it('>30% → OK', () => {
    expect(JSON.parse(run('62')).verdict).toBe('OK');
  });
});

describe('load-assess.sh — --json contract', () => {
  it('emits valid JSON with the documented fields', () => {
    const j = JSON.parse(run('45'));
    expect(['OK', 'ELEVATED', 'SATURATED', 'UNKNOWN']).toContain(j.verdict);
    expect(typeof j.cpuIdlePercent === 'number' || j.cpuIdlePercent === null).toBe(true);
    expect(j.scope).toBe('cpu-capacity-only'); // scope honesty — not a universal health oracle
    expect(typeof j.os).toBe('string');
    expect(j).toHaveProperty('loadAvg5'); // load average present but it is CONTEXT only
  });
});

describe('load-assess.sh — fail-soft', () => {
  it('still emits a verdict when the ResourceLedger is unreachable (no server in test env)', () => {
    const j = JSON.parse(run('40'));
    // The temporary agent has no auth or configured ledger.
    expect(j.ledger).toContain('unavailable');
    expect(j.verdict).toBe('OK'); // verdict still derived from CPU idle%, not the ledger
  });
  it('human-readable output names the verdict and demotes load average to context', () => {
    const out = run('40', false);
    expect(out).toContain('VERDICT:');
    expect(out).toContain('context only');
    expect(out).toContain('CPU capacity only');
  });
});
