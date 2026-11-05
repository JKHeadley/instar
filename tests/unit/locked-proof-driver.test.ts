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
import { CASES, RESUME_WINDOW_MS, TERMINAL, assertProofTarget, generateProofPassword, judge, renderExpected, resetAttempts, runCase, selectCases } from '../../scripts/locked-proof/lib.mjs';
// @ts-expect-error — plain .mjs script, no type declarations
import { RealTarget, VIEWER_READY, ownerOf, recordPersonStep, refusalFromStatus, setupGaps } from '../../scripts/locked-proof/driver.mjs';
// @ts-expect-error — plain .mjs script, no type declarations
import { isInsideProofHome, proofConfig, validPin } from '../../scripts/locked-proof/configure-proof-agent.mjs';

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
  recovered = 0;
  failAt: string | null = null;
  asked: string[] = [];
  constructor(private c: { final: string; markerEnd?: string[] }, private broken = false, readonly password = 'abcdefghjkmnpqrstuvw') {}
  now() { return this.t; }
  async sleep(ms: number) { this.t += ms; }
  async prepare() { this.markers = {}; this.lockState = 'locked-in-session'; }
  async openGrant() { this.markers.k = { state: 'owed', requestId: 'r1', deadlineMs: this.t + 600_000 }; this.guard = 41; return { id: 'r1' }; }
  calibration() { return { reserveMs: 300, perCharMs: 40, length: this.password.length }; }
  async typePassword() { this.typist = true; this.markers.k = { ...this.markers.k, enterPendingAt: this.t }; return { sent: true }; }
  async snapshot() {
    return { now: this.t, dirty: false, markers: JSON.parse(JSON.stringify(this.markers)), lockState: this.lockState, typistRunning: this.typist, guardPid: this.guard ?? undefined, events: ['lease-written', 'guard-spawned', 'guard-acked', 'deadline-passed', 'other-grant-tried', 'takeover', 'next-grant-open', 'proof-user-console'] };
  }
  async act(action: string) {
    this.acts.push(action);
    if (this.failAt === action) throw new Error(`boom at ${action}`);
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
  async recover() { this.recovered++; return []; }
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

  it('sets the dashboard PIN only when given one, and only a digits PIN', () => {
    expect(proofConfig({}, { port: 4098, tunnel: false, pin: '123456' }).dashboardPin).toBe('123456');
    expect(proofConfig({ dashboardPin: '999999' }, { port: 4098, tunnel: false }).dashboardPin).toBe('999999');
    expect(() => proofConfig({}, { port: 4098, tunnel: false, pin: '12 34' })).toThrow(/4 to 12 digits/);
    expect(validPin('')).toBe(false);
    expect(validPin('0123')).toBe(true);
  });

  it('names what setup still owes before a run, pointing at --finalize', () => {
    const ready = { dashboardPin: '123456', remoteDesktop: { frontMachineId: 'm1' } };
    expect(setupGaps([['/a', ready]])).toEqual([]);
    const gaps = setupGaps([['/a', { remoteDesktop: {} }], ['/b', { dashboardPin: '123456' }]]);
    expect(gaps).toHaveLength(3);
    expect(gaps[0]).toMatch(/^\/a: no dashboard PIN/);
    for (const gap of gaps) expect(gap).toContain('--finalize --agent-home DIR --execute');
    expect(gaps.join('\n')).not.toContain('123456');
  });

  it('stage-proof-agents needs --agent-home before it touches anything, and names the steps in order', () => {
    const script = path.join(DIR, 'stage-proof-agents.sh');
    const finalize = spawnSync('bash', [script, '--finalize', '--execute'], { encoding: 'utf8' });
    expect(finalize.status).toBe(2);
    expect(finalize.stderr).toContain('--agent-home is required');
    const home = tmp('proof-agent-home-');
    try {
      fs.mkdirSync(path.join(home, '.instar', 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(home, '.instar', 'scripts', 'secret-get.mjs'), 'process.exit(0);');
      const empty = spawnSync('bash', [script, '--finalize', '--agent-home', home, '--execute'], { encoding: 'utf8' });
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain('vault key locked_proof_dashboard_pin is empty');
    } finally { rm(home); }
    const text = fs.readFileSync(script, 'utf8');
    expect(text).toContain('REQUIRED before any driver run');
    expect(text).toContain("printf '%s' \"$PIN\" | as_user node");
    expect(text).not.toMatch(/echo[^\n]*\$PIN(?![_A-Za-z])/);
  });

  it('configure-proof-agent refuses any directory outside the proof home, and needs --execute', () => {
    expect(isInsideProofHome('/Users/instarproof/.instar/agents/locked-proof')).toBe(true);
    expect(isInsideProofHome('/Users/instarproofX/a')).toBe(false);
    expect(isInsideProofHome('/Users/dabombstudio/.instar/agents/echo')).toBe(false);
    const d = tmp('proof-config-');
    try {
      fs.mkdirSync(path.join(d, '.instar'));
      fs.writeFileSync(path.join(d, '.instar', 'config.json'), '{"port":1}');
      const r = spawnSync(process.execPath, [path.join(DIR, 'configure-proof-agent.mjs'), d, '--port', '4098', '--execute'], { encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/is not inside \/Users\/instarproof/);
      expect(fs.readFileSync(path.join(d, '.instar', 'config.json'), 'utf8')).toBe('{"port":1}');
    } finally { rm(d); }
  });
});

describe('locked-proof viewer driving', () => {
  /** A page stand-in: records clicks and answers isVisible('#control'). */
  const page = (open: boolean) => {
    const clicks: string[] = [];
    return { clicks, isVisible: async (sel: string) => sel === '#control' && open, click: async (sel: string) => { clicks.push(sel); } };
  };

  it('treats an auto-opened stream as ready, as well as an enabled request button', () => {
    expect(VIEWER_READY).toContain('#requestButton:not([disabled])');
    expect(VIEWER_READY).toContain('#control:not([hidden])');
  });

  it('requests a grant only when the page has not already opened one', async () => {
    const target = Object.create(RealTarget.prototype) as { requestGrant(v: unknown): Promise<{ clicked: boolean }> };
    const opened = page(true);
    expect(await target.requestGrant({ page: opened })).toEqual({ clicked: false });
    expect(opened.clicks).toEqual([]);
    const closed = page(false);
    expect(await target.requestGrant({ page: closed })).toEqual({ clicked: true });
    expect(closed.clicks).toEqual(['#requestButton']);
  });

  it('opens every grant through requestGrant, never a bare click', () => {
    const source = fs.readFileSync(path.join(DIR, 'driver.mjs'), 'utf8');
    expect(source.match(/page\.click\('#requestButton'\)/g)).toHaveLength(1);
    expect(source.match(/await this\.requestGrant\(v\)/g)).toHaveLength(3);
  });

  it('maps the new viewer reasons back to their words', () => {
    expect(refusalFromStatus("Password entry from a browser is off until this Mac's secure tunnel is up. This page updates when it is.")).toBe('tunnel-not-active');
    expect(refusalFromStatus("Password entry needs Instar's kept desktop helper on this Mac, and this install does not have one.")).toBe('retained-helper-required');
    expect(refusalFromStatus('Password entry from a browser is off for this Mac.')).toBe('browser-box-off');
  });
});

describe('locked-proof person steps', () => {
  const rows = (out: string) => fs.readFileSync(path.join(out, 'person-steps.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

  it('records a refused send, so a person step cannot vanish', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-person-'));
    const row = recordPersonStep({ out, notifyTopic: 138345 }, 'Unlock the test account', () => ({ status: 1 }));
    expect(row.sent).toBe(false);
    expect(rows(out)).toEqual([expect.objectContaining({ text: 'Unlock the test account', topic: 138345, sent: false })]);
    rm(out);
  });

  it('records a delivered send, and a run with no topic never calls the sender', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-person-'));
    expect(recordPersonStep({ out, notifyTopic: 138345 }, 'one', () => ({ status: 0 })).sent).toBe(true);
    expect(recordPersonStep({ out }, 'two', () => { throw new Error('must not send'); }).sent).toBe(false);
    expect(rows(out).map(row => row.topic)).toEqual([138345, null]);
    rm(out);
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

  it('a case that throws still resumes and relocks, and fails with the error', async () => {
    const c = CASES.find((x: { id: string }) => x.id === '12.1');
    const target = new FakeTarget(c);
    target.failAt = 'stop-server';
    const ev = await runCase(c, target, { pollMs: 50 });
    expect(target.recovered).toBe(1);
    expect(ev.verdict.pass).toBe(false);
    expect(ev.verdict.reasons[0]).toBe('case stopped with an error: boom at stop-server');
  });

  it('a target without recover() fails the case', async () => {
    const c = CASES.find((x: { id: string }) => x.id === '15.1');
    const target = new FakeTarget(c) as unknown as Record<string, unknown>;
    target.recover = undefined;
    const ev = await runCase(c, target, { pollMs: 50 });
    expect(ev.verdict.reasons).toContain('recovery problems: target has no recover()');
  });

  it('an expectation with no measurement fails loudly, and a measured one is judged', () => {
    const base = { unfired: [], fired: [], final: { lockState: 'locked-in-session', markers: { k: { state: 'relocked' } }, processesGone: true } };
    const c155 = CASES.find((x: { id: string }) => x.id === '15.5');
    expect(judge(c155, { ...base, extra: {} }).reasons).toContain('not measured: relock time after the transport drop');
    expect(judge(c155, { ...base, extra: { relockAfterDropMs: 2_000 } }).reasons.join(' ')).toMatch(/inside the 30000 ms resume window/);
    expect(judge(c155, { ...base, extra: { relockAfterDropMs: RESUME_WINDOW_MS + 500 } }).pass).toBe(true);
    const c159 = CASES.find((x: { id: string }) => x.id === '15.9');
    expect(judge(c159, { ...base, extra: { typistGone: true } }).reasons).toContain('not measured: password field state at the end');
    expect(judge(c159, { ...base, extra: { typistGone: true, fieldDirtyAtEnd: true } }).reasons).toContain('password field left dirty at the end');
    expect(judge(c159, { ...base, extra: { typistGone: true, fieldDirtyAtEnd: false } }).pass).toBe(true);
    const c1212 = CASES.find((x: { id: string }) => x.id === '12.12');
    const closed = { ...base, final: { ...base.final, markers: { k: { state: 'closed-not-applicable' } } } };
    expect(judge(c1212, { ...closed, extra: {} }).reasons).toContain('not measured: lock calls against another session (no observable source yet)');
  });

  it('the runner measures the relock time after a transport drop from its own samples', async () => {
    const c = CASES.find((x: { id: string }) => x.id === '15.6');
    const ev = await runCase(c, new FakeTarget(c), { pollMs: 50 });
    expect(ev.extra.relockAfterDropMs).toBeLessThan(1_000);
    expect(ev.extra.fieldDirtyAtEnd).toBe(false);
    expect(ev.verdict.reasons.join(' ')).toMatch(/inside the 30000 ms resume window/);
  });

  it('never signals a process the proof user does not own', () => {
    expect(ownerOf(process.pid)).toBe(os.userInfo().username);
    const target = Object.create(RealTarget.prototype) as { stopped: Set<number>; kill(pid: number, sig: string): unknown };
    target.stopped = new Set();
    expect(() => target.kill(process.pid, 'STOP')).toThrow(/not instarproof/);
    expect(target.stopped.size).toBe(0);
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

describe('create-proof-user.sh refuses a Bitwarden helper that leaks to argv', () => {
  it('stops before storing or creating anything', () => {
    const d = tmp('proof-user-helper-');
    try {
      const bin = path.join(d, 'bin');
      fs.mkdirSync(bin);
      fs.mkdirSync(path.join(d, '.instar', 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(d, '.instar', 'scripts', 'credential-store.mjs'), "id = JSON.parse(bw(['create', 'item', bw(['encode'], JSON.stringify(i)).trim()])).id;\n");
      const log = path.join(d, 'calls.log');
      for (const name of ['sysadminctl', 'credential-store', 'pwpolicy']) fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(bin, 'dscl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const r = spawnSync('bash', [path.join(DIR, 'create-proof-user.sh'), '--agent-home', d, '--execute'], { encoding: 'utf8', env: { ...process.env, LOCKED_PROOF_FAKE_BIN: bin } });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/command line; update it to pass it on stdin/);
      expect(fs.existsSync(log)).toBe(false);
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
      const env = { ...process.env, LOCKED_PROOF_TEST_ROOT: root };
      const noExecute = spawnSync('python3', [path.join(DIR, 'reset-attempts.py'), root], { env, encoding: 'utf8' });
      expect(noExecute.status).not.toBe(0);
      expect(noExecute.stderr).toMatch(/no --execute/);
      expect(spawnSync('python3', [path.join(DIR, 'reset-attempts.py'), root], { encoding: 'utf8' }).status).not.toBe(0);
      expect(spawnSync('python3', [path.join(DIR, 'reset-attempts.py'), '--execute', root], { encoding: 'utf8' }).stderr).toMatch(/not the proof user/);
      expect(spawnSync('python3', [path.join(DIR, 'reset-attempts.py'), '--execute', root], { env }).status).toBe(0);
      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(after.attempts).toMatchObject({ count: 0, perRequest: {} });
      expect(after.markers.k.state).toBe('relocked');
      fs.writeFileSync(file, JSON.stringify({ markers: { k: { state: 'owed' } } }));
      const refused = spawnSync('python3', [path.join(DIR, 'reset-attempts.py'), '--execute', root], { env, encoding: 'utf8' });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toMatch(/duty k is owed/);
      expect(spawnSync('python3', [path.join(DIR, 'reset-attempts.py'), '--execute', d], { env }).status).not.toBe(0);
    } finally { rm(d); }
  });
});
