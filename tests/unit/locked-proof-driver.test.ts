/**
 * Locked-Mac proof driver and setup scripts (scripts/locked-proof/). Nothing here
 * touches a real Mac user, lock screen or desktop helper: the runner is driven by a
 * fake target, and the setup script by stand-in commands.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// @ts-expect-error — plain .mjs script, no type declarations
import { CASES, TERMINAL, assertProofTarget, generateProofPassword, judge, renderExpected, resetAttempts, runCase, selectCases } from '../../scripts/locked-proof/lib.mjs';
// @ts-expect-error — plain .mjs script, no type declarations
import { refusalFromStatus } from '../../scripts/locked-proof/driver.mjs';
// @ts-expect-error — plain .mjs script, no type declarations
import { proofConfig } from '../../scripts/locked-proof/configure-proof-agent.mjs';

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = path.join(ROOT, 'scripts/locked-proof');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rm = (d: string) => SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'test cleanup' });

type Marker = Record<string, unknown> & { state: string };

/** A fake proof Mac: a marker store, a lock flag, a typist and a guard. */
class FakeTarget {
  t = 1_000_000;
  markers: Record<string, Marker> = {};
  lockState = 'locked-in-session';
  typist = false;
  guard: number | null = null;
  acts: string[] = [];
  asked: string[] = [];
  constructor(private c: { final: string; markerEnd?: string[] }, private broken = false, readonly password = 'abcdefghjkmnpqrstuvw') {}
  now() { return this.t; }
  async sleep(ms: number) { this.t += ms; }
  async prepare() { this.markers = {}; this.lockState = 'locked-in-session'; }
  async openGrant() { this.markers.k = { state: 'owed', requestId: 'r1', deadlineMs: this.t + 600_000 }; this.guard = 41; return { id: 'r1' }; }
  calibration() { return { reserveMs: 300, perCharMs: 40, length: this.password.length }; }
  async typePassword() { this.typist = true; this.markers.k = { ...this.markers.k, enterPendingAt: this.t }; return { sent: true }; }
  async snapshot() {
    return { now: this.t, markers: JSON.parse(JSON.stringify(this.markers)), lockState: this.lockState, typistRunning: this.typist, guardPid: this.guard ?? undefined, events: ['lease-written', 'guard-spawned', 'guard-acked', 'deadline-passed', 'other-grant-tried', 'takeover', 'next-grant-open', 'proof-user-console'] };
  }
  async act(action: string) {
    this.acts.push(action);
    if (['start-server', 'cont-server', 'lock-now', 'cont-guards'].includes(action)) return {};
    if (action === 'grant-other-agent') return { opened: false, refused: 'relock-pending' };
    // Any disruption: the guard does its duty (unless this fake is broken).
    const end = this.c.markerEnd?.[0] ?? 'relocked';
    this.markers.k = { ...this.markers.k, state: end, guardReplacements: 1, producerGone: true };
    this.typist = false; this.guard = null;
    this.lockState = this.broken ? 'unlocked' : (this.c.final === 'unlocked-accepted-risk' ? 'unlocked' : 'locked-in-session');
    return { done: true };
  }
  async askPerson(text: string) { this.asked.push(text); }
  settled(snap: { markers: Record<string, Marker> }) { return Object.values(snap.markers).every(m => TERMINAL.includes(m.state)) && !this.typist; }
  async extraEvidence() { return { submissions: 0, submissionsAfterClose: 0, guardReplaced: true, producerGone: true, oldGuardGone: true, typistGone: true, grantAlive: true, securityItemMs: 2_000, securityItemRaised: true }; }
}

describe('locked-proof case table', () => {
  it('covers every P12 and P15 case with a unique id and an expected end', () => {
    const ids = CASES.map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CASES.filter((c: { gate: string }) => c.gate === 'P12').length).toBeGreaterThanOrEqual(25);
    expect(CASES.filter((c: { gate: string }) => c.gate === 'P15').length).toBe(11);
    for (const c of CASES) expect(['locked', 'left-unlocked', 'unlocked-accepted-risk', 'either', 'not-judged']).toContain(c.final);
    const table = renderExpected();
    for (const id of ids) expect(table).toContain(`| ${id} |`);
  });

  it('selects by id or by gate and names unknown cases', () => {
    expect(selectCases(['15.1', '12.17']).map((c: { id: string }) => c.id)).toEqual(['12.17', '15.1']);
    expect(selectCases(['P15'])).toHaveLength(11);
    expect(() => selectCases(['99.9'])).toThrow(/unknown case/);
  });
});

describe('locked-proof safety helpers', () => {
  it('generates a 20-character layout-safe password and uses the random source', () => {
    const pw = generateProofPassword();
    expect(pw).toMatch(/^[a-hjkmnp-z2-9]{20}$/);
    expect(generateProofPassword()).not.toBe(pw);
    expect(generateProofPassword(() => Buffer.alloc(40, 0))).toBe('a'.repeat(20));
    expect(() => generateProofPassword(() => Buffer.alloc(40, 255))).toThrow(/random/);
  });

  it('resets attempts only while no duty is open', () => {
    expect(resetAttempts({ markers: { k: { state: 'relocked' } }, attempts: { count: 6 } }, '2026-11-03').attempts)
      .toEqual({ day: '2026-11-03', count: 0, perRequest: {} });
    expect(() => resetAttempts({ markers: { k: { state: 'watching' } } }, '2026-11-03')).toThrow(/watching/);
  });

  it('acts only on the proof user running a -lockedproof build', () => {
    expect(() => assertProofTarget({ user: 'instarproof', version: '1.3.1607-lockedproof.2' })).not.toThrow();
    expect(() => assertProofTarget({ user: 'dabombstudio', version: '1.3.1607-lockedproof.2' })).toThrow(/instarproof/);
    expect(() => assertProofTarget({ user: 'instarproof', version: '1.3.1607' })).toThrow(/lockedproof/);
  });

  it('maps the viewer status text back to the refusal reason', () => {
    expect(refusalFromStatus('This Mac is finishing a relock. Try again in a couple of minutes.')).toBe('relock-pending');
    expect(refusalFromStatus('Too many tries today.')).toBe('attempts-per-day');
    expect(refusalFromStatus('Remote desktop connected.')).toBeNull();
  });

  it('configures a proof agent: desktop on, locked access absent, no updates, tunnel only when asked', () => {
    const next = proofConfig({ projectName: 'x', remoteDesktop: { lockedScreen: { enabled: true } }, updates: { autoApply: true } }, { port: 4098, tunnel: true, frontMachineId: 'm1' });
    expect(next).toMatchObject({ port: 4098, remoteDesktop: { enabled: true, retainedHelper: true, frontMachineId: 'm1' }, updates: { autoApply: false }, autostart: { autoInstall: false }, messaging: [], tunnel: { enabled: true, type: 'quick' } });
    expect(next.remoteDesktop.lockedScreen).toBeUndefined();
    expect(proofConfig({ tunnel: { enabled: true } }, { port: 4097, tunnel: false }).tunnel.enabled).toBe(false);
  });
});

describe('locked-proof runner and verdict', () => {
  it('passes a case when the Mac ends locked with the duty closed', async () => {
    const c = CASES.find((x: { id: string }) => x.id === '15.2');
    const ev = await runCase(c, new FakeTarget(c), { pollMs: 50 });
    expect(ev.verdict).toEqual({ pass: true, reasons: [] });
    expect(ev.fired.map((f: { action: string }) => f.action)).toEqual(['revoke']);
  });

  it('fails the same case when the Mac is left unlocked', async () => {
    const c = CASES.find((x: { id: string }) => x.id === '15.2');
    const ev = await runCase(c, new FakeTarget(c, true), { pollMs: 50 });
    expect(ev.verdict.pass).toBe(false);
    expect(ev.verdict.reasons.join(' ')).toMatch(/ended unlocked, expected locked/);
  });

  it('cues the person, records the security item, and never puts the password in evidence', async () => {
    const c = CASES.find((x: { id: string }) => x.id === '12.8');
    const target = new FakeTarget(c);
    const ev = await runCase(c, target, { pollMs: 50 });
    expect(target.asked).toHaveLength(1);
    expect(ev.verdict.pass).toBe(true);
    expect(JSON.stringify(ev)).not.toContain(target.password);
  });

  it('judge names every unmet expectation', () => {
    const c = { id: 'x', gate: 'P15', inject: [{ action: 'revoke', at: 'now' }], final: 'locked', markerEnd: ['relocked'], noSubmissionAfterClose: true, guardReplaced: true };
    const bad = judge(c, { unfired: ['revoke at now'], final: { lockState: 'unlocked', markers: { k: { state: 'watching' } }, processesGone: false }, extra: { submissionsAfterClose: 1, guardReplaced: false }, fired: [] });
    expect(bad.pass).toBe(false);
    expect(bad.reasons).toEqual(expect.arrayContaining([
      'injection never fired: revoke at now', 'a duty is still open at the end', 'Mac ended unlocked, expected locked',
      'guard or typist still running after the duty closed', '1 submission(s) after the duty closed', 'the killed guard was not replaced',
    ]));
    const good = judge(c, { unfired: [], final: { lockState: 'locked-in-session', markers: { k: { state: 'relocked' } }, processesGone: true }, extra: { submissionsAfterClose: 0, guardReplaced: true }, fired: [] });
    expect(good).toEqual({ pass: true, reasons: [] });
  });

  it('a refusal the case expects must actually happen', () => {
    const c = CASES.find((x: { id: string }) => x.id === '12.16');
    const base = { unfired: [], final: { lockState: 'locked-in-session', markers: { k: { state: 'relocked' } }, processesGone: true }, extra: {} };
    expect(judge(c, { ...base, fired: [{ action: 'grant-other-agent', result: { refused: 'relock-pending' } }] }).pass).toBe(true);
    expect(judge(c, { ...base, fired: [{ action: 'grant-other-agent', result: { opened: true } }] }).reasons.join(' ')).toMatch(/expected refusal relock-pending/);
  });

  it('the CLI without --execute only prints the plan', () => {
    const out = execFileSync(process.execPath, [path.join(DIR, 'driver.mjs'), 'run', '--cases', 'P12'], { encoding: 'utf8' });
    expect(out).toMatch(/^dry run \(no --execute\)/);
    expect(execFileSync(process.execPath, [path.join(DIR, 'driver.mjs'), 'expected'], { encoding: 'utf8' })).toContain('| 15.11 | P15 |');
  });
});

/** Stand-in for a command that asks for a password on its terminal, as sysadminctl does. */
function writePrompter(file: string, record: string) {
  fs.writeFileSync(file, `#!/usr/bin/env python3
import getpass, json, sys
pw = getpass.getpass('Password:')
with open(${JSON.stringify(record)}, 'a') as f:
    f.write(json.dumps({'argv': sys.argv[1:], 'pw': pw}) + '\\n')
`, { mode: 0o755 });
}

describe('pty-feed answers a password prompt without a command line', () => {
  it('feeds stdin to the prompt; the secret is in no argument', () => {
    const d = tmp('pty-feed-');
    try {
      const record = path.join(d, 'record.jsonl');
      writePrompter(path.join(d, 'prompter'), record);
      const r = spawnSync('python3', [path.join(DIR, 'pty-feed.py'), '--', path.join(d, 'prompter'), '-addUser', 'x'], { input: 's3cretvalue', encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).not.toContain('s3cretvalue');
      const row = JSON.parse(fs.readFileSync(record, 'utf8').trim());
      expect(row).toEqual({ argv: ['-addUser', 'x'], pw: 's3cretvalue' });
    } finally { rm(d); }
  });

  it('fails when the command never asks', () => {
    const r = spawnSync('python3', [path.join(DIR, 'pty-feed.py'), '--', '/bin/echo', 'hi'], { input: 'x', encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/never asked/);
  });
});

describe('create-proof-user.sh with stand-in commands', () => {
  it('dry run does nothing', () => {
    const out = execFileSync('bash', [path.join(DIR, 'create-proof-user.sh'), '--agent-home', '/nonexistent'], { encoding: 'utf8', env: { ...process.env, LOCKED_PROOF_FAKE_BIN: '/nonexistent' } });
    expect(out).toMatch(/Dry run: nothing done/);
  });

  it('stores the password in the vault first, creates the user by prompt, clears policies, verifies; never prints it', () => {
    const d = tmp('proof-user-');
    try {
      const bin = path.join(d, 'bin');
      fs.mkdirSync(bin);
      const order = path.join(d, 'order.log');
      const vault = path.join(d, 'vault.txt');
      const created = path.join(d, 'created.jsonl');
      writePrompter(path.join(bin, 'sysadminctl'), created);
      fs.appendFileSync(path.join(bin, 'sysadminctl'), `open(${JSON.stringify(order)}, 'a').write('sysadminctl\\n')\n`);
      fs.writeFileSync(path.join(bin, 'credential-store'), `#!/bin/sh\necho "store $*" >> ${JSON.stringify(order)}\ncat > ${JSON.stringify(vault)}\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'pwpolicy'), `#!/bin/sh\necho "pwpolicy $*" >> ${JSON.stringify(order)}\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'dscl'), `#!/usr/bin/env python3
import getpass, sys
if '-read' in sys.argv: sys.exit(1)
pw = getpass.getpass('Password:')
open(${JSON.stringify(order)}, 'a').write('authonly ' + ('ok' if pw == open(${JSON.stringify(vault)}).read() else 'bad') + '\\n')
`, { mode: 0o755 });
      const r = spawnSync('bash', [path.join(DIR, 'create-proof-user.sh'), '--agent-home', d, '--execute'], { encoding: 'utf8', env: { ...process.env, LOCKED_PROOF_FAKE_BIN: bin } });
      expect(r.status, r.stderr).toBe(0);
      const pw = fs.readFileSync(vault, 'utf8');
      expect(pw).toMatch(/^[a-z2-9]{20}$/);
      const steps = fs.readFileSync(order, 'utf8').trim().split('\n');
      expect(steps[0]).toMatch(/^store locked_proof_user_password --bw-name Instar locked-proof test user/);
      expect(steps.slice(1)).toEqual(['sysadminctl', 'pwpolicy -u instarproof -clearaccountpolicies', 'authonly ok']);
      const row = JSON.parse(fs.readFileSync(created, 'utf8').trim());
      expect(row.pw).toBe(pw);
      expect(row.argv).toEqual(['-addUser', 'instarproof', '-fullName', 'Instar proof', '-password', '-']);
      expect(r.stdout + r.stderr).not.toContain(pw);
      expect(fs.readFileSync(order, 'utf8')).not.toContain(pw);
    } finally { rm(d); }
  });
});

describe('reset-attempts.py', () => {
  it('resets the counter under the lock and refuses while a duty is open', () => {
    const d = tmp('proof-attempts-');
    try {
      const root = path.join(d, '.instar', 'desktop-helper', 'locked');
      fs.mkdirSync(root, { recursive: true });
      const file = path.join(root, 'locked-state.json');
      fs.writeFileSync(file, JSON.stringify({ markers: { k: { state: 'relocked' } }, attempts: { day: 'x', count: 6, perRequest: { r: 3 } } }));
      expect(spawnSync('python3', [path.join(DIR, 'reset-attempts.py'), root]).status).toBe(0);
      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(after.attempts).toMatchObject({ count: 0, perRequest: {} });
      expect(after.markers.k.state).toBe('relocked');
      fs.writeFileSync(file, JSON.stringify({ markers: { k: { state: 'owed' } } }));
      const refused = spawnSync('python3', [path.join(DIR, 'reset-attempts.py'), root], { encoding: 'utf8' });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/duty k is owed/);
      expect(spawnSync('python3', [path.join(DIR, 'reset-attempts.py'), d]).status).not.toBe(0);
    } finally { rm(d); }
  });
});
