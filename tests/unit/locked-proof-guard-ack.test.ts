/** Proof harness tests: disposable filesystem only, never a real desktop account. */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
// @ts-expect-error plain proof script
import { CASES, runCase, judge } from '../../scripts/locked-proof/lib.mjs';
// @ts-expect-error plain proof script
import { RealTarget, refusalFromStatus, matchesGuardProcess } from '../../scripts/locked-proof/driver.mjs';

const REQUEST = '12345678-1234-1234-1234-123456789abc';
const KEY = `${REQUEST}.0`;
const c = CASES.find((x: { id: string }) => x.id === '12.18');
const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'scripts/locked-proof/guard-ack-fixture.py');
const armed = () => ({ armed: true, frozen: true, key: KEY, mtimeNs: '1000000000', ageMs: 10_000, marker: null });
const secretResult = () => ({ refused: 'guard-not-alive', guardAckFault: {
  observed: { ...armed(), guardAlive: true, dirty: false,
    marker: { requestId: REQUEST, guardPid: 42, guardStart: 'guard-start', state: 'owed' } },
  restored: { key: KEY, released: true, boundary: 'revoked' }, grantEnded: true,
} });

function target() {
  const events: string[] = [];
  return {
    events, now: () => 100_000, sleep: async () => {}, prepare: async () => {},
    openGrant: async () => { events.push('grant'); return {}; },
    act: async () => { events.push('armed'); return armed(); },
    typePassword: async () => { events.push('secret'); return secretResult(); },
    snapshot: async () => {
      events.push('snapshot');
      return { now: 100_000, lockState: 'locked', dirty: false,
        markers: { [KEY]: { state: 'relocked', requestId: REQUEST } } };
    },
    settled: () => true,
    extraEvidence: async () => ({ submissions: 0, submissionsAfterClose: 0 }),
    recover: async () => { events.push('recover'); return []; },
  };
}

describe('guard acknowledgement proof lifecycle', () => {
  it('awaits setup before password and the complete secret lifecycle before sampling/recovery', async () => {
    const t = target();
    let finishSetup!: () => void, finishSecret!: () => void;
    const setup = new Promise<void>(resolve => { finishSetup = resolve; });
    const secret = new Promise<void>(resolve => { finishSecret = resolve; });
    t.act = async () => { t.events.push('arming'); await setup; t.events.push('armed'); return armed(); };
    t.typePassword = async () => { t.events.push('secret'); await secret; t.events.push('restored'); return secretResult(); };
    const run = runCase(c, t);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(t.events).toEqual(['grant', 'arming']);
    finishSetup();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(t.events).toEqual(['grant', 'arming', 'armed', 'secret']);
    finishSecret();
    const ev = await run;
    expect(ev.verdict).toEqual({ pass: true, reasons: [] });
    expect(t.events.indexOf('restored')).toBeLessThan(t.events.indexOf('snapshot'));
    expect(t.events.at(-1)).toBe('recover');
  });

  it('never attempts the password after a setup failure and always invokes recovery', async () => {
    const t = target();
    t.act = async () => { throw new Error('unsafe heartbeat path'); };
    const ev = await runCase(c, t);
    expect(ev.verdict.pass).toBe(false);
    expect(ev.error).toContain('unsafe heartbeat path');
    expect(t.events).not.toContain('secret');
    expect(t.events.at(-1)).toBe('recover');
  });

  it('a secret error or failed recovery cannot pass', async () => {
    const t = target();
    t.typePassword = async () => { throw new Error('viewer disconnected'); };
    t.recover = async () => ['fixture release failed'];
    const ev = await runCase(c, t);
    expect(ev.verdict.pass).toBe(false);
    expect(ev.secretResult.error).toBe('viewer disconnected');
    expect(ev.verdict.reasons.join(' ')).toContain('fixture release failed');
  });

  it('recognizes the actual dashboard guard-not-alive message', () => {
    const source = fs.readFileSync(path.join(root, 'dashboard/desktop.js'), 'utf8');
    const message = source.match(/'guard-not-alive': '((?:\\'|[^'])*)'/)?.[1].replace(/\\'/g, "'");
    expect(message).toBeTruthy();
    expect(refusalFromStatus(message)).toBe('guard-not-alive');
  });

  it('requires the real proof guard owner, command, request key and process start', () => {
    const start = 'Tue Nov 17 16:00:00 2026';
    const marker = { guardPid: 42, guardStart: `${Date.parse(start) / 1000}.1234` };
    const row = { pid: 42, start, command: `/proof/instar-desktop-host relock-guard /proof/store ${KEY}` };
    expect(matchesGuardProcess(marker, row, KEY, 'instarproof')).toBe(true);
    expect(matchesGuardProcess(marker, row, KEY, 'operator')).toBe(false);
    expect(matchesGuardProcess(marker, { ...row, pid: 43 }, KEY, 'instarproof')).toBe(false);
    expect(matchesGuardProcess(marker, { ...row, start: 'Tue Nov 17 15:00:00 2026' }, KEY, 'instarproof')).toBe(false);
    expect(matchesGuardProcess(marker, { ...row, command: row.command + '-other' }, KEY, 'instarproof')).toBe(false);
  });

  it('rejects missing, false or unmeasured fixture evidence', async () => {
    const good = await runCase(c, target());
    const changes = [
      (ev: any) => { ev.fired = []; },
      (ev: any) => { delete ev.fired[0].result.mtimeNs; delete ev.secretResult.guardAckFault.observed.mtimeNs; },
      (ev: any) => { ev.fired[0].result.marker = { state: 'owed' }; },
      (ev: any) => { ev.secretStartedAt = 0; },
      (ev: any) => { ev.secretResult.guardAckFault.observed.frozen = false; },
      (ev: any) => { ev.secretResult.guardAckFault.observed.mtimeNs = '2000000000'; },
      (ev: any) => { ev.secretResult.guardAckFault.observed.ageMs = 100; },
      (ev: any) => { ev.secretResult.guardAckFault.observed.ageMs = '10000'; },
      (ev: any) => { ev.secretResult.guardAckFault.observed.guardAlive = false; },
      (ev: any) => { ev.secretResult.guardAckFault.observed.marker = null; },
      (ev: any) => { ev.secretResult.guardAckFault.observed.dirty = true; },
      (ev: any) => { ev.secretResult.guardAckFault.observed.marker.enterPendingAt = 1; },
      (ev: any) => { delete ev.extra.submissions; },
      (ev: any) => { ev.secretResult.guardAckFault.restored.released = false; },
      (ev: any) => { ev.secretResult.guardAckFault.grantEnded = false; },
    ];
    for (const change of changes) {
      const ev = structuredClone(good);
      change(ev);
      expect(judge(c, ev).pass).toBe(false);
    }
  });

  const viewerTarget = (fail: 'secret' | 'revoke' | 'observe' | 'close' | 'both' | null) => {
    const events: string[] = [];
    const receipt = { present: true, key: KEY, expiresAt: Date.now() + 60_000,
      secretState: 'not-submitted', grantRevoked: false };
    const t = Object.assign(Object.create(RealTarget.prototype), {
      a: {}, guardAckArmed: armed(), failRevoke: fail === 'revoke' || fail === 'both',
      main: { requestId: REQUEST, session: 'test-session', context: { close: async () => {
        events.push('close'); if (fail === 'close' || fail === 'both') throw new Error('close failed');
      } } },
      typePasswordInViewer: async () => { events.push('secret'); if (fail === 'secret' || fail === 'both') throw new Error('sent then viewer failed'); return { refused: 'guard-not-alive' }; },
      api: async () => { events.push('revoke'); return { httpStatus: t.failRevoke ? 403 : 200, revoked: !t.failRevoke }; },
      guardAckCommand: (action: string) => {
        events.push(action);
        if (action === 'observe' && fail === 'observe') throw new Error('observe failed');
        if (action === 'begin-secret') { receipt.secretState = 'may-be-in-flight'; return { key: KEY, submitting: true }; }
        if (action === 'confirm-revoked') { receipt.grantRevoked = true; return { key: KEY, grantRevoked: true }; }
        if (action === 'receipt') return { ...receipt };
        if (action === 'observe') return { key: KEY, marker: null };
        if (receipt.secretState === 'may-be-in-flight' && !receipt.grantRevoked && t.now() < receipt.expiresAt) {
          throw new Error('retaining frozen heartbeat');
        }
        receipt.present = false;
        return { key: KEY, released: true, boundary: receipt.grantRevoked ? 'revoked' : 'expired' };
      },
    });
    return { t, events, receipt };
  };

  it('the real driver revokes and closes the viewer before releasing the fixture', async () => {
    const { t, events } = viewerTarget(null);
    const result = await t.typePassword(c);
    expect(events).toEqual(['begin-secret', 'secret', 'observe', 'revoke', 'confirm-revoked', 'close', 'receipt', 'release']);
    expect(result.guardAckFault.restored.released).toBe(true);
  });

  it.each(['secret', 'observe', 'close'] as const)('the real driver releases after %s fails only because revocation succeeded', async fail => {
    const { t, events } = viewerTarget(fail);
    await expect(t.typePassword(c)).rejects.toThrow();
    expect(events.at(-1)).toBe('release');
    expect(t.guardAckArmed).toBeNull();
  });

  it.each(['revoke', 'both'] as const)('retains the fault after %s failure, then retries the exact grant boundary', async fail => {
    const { t, events, receipt } = viewerTarget(fail);
    await expect(t.typePassword(c)).rejects.toThrow('retaining frozen heartbeat');
    expect(receipt).toMatchObject({ present: true, secretState: 'may-be-in-flight', grantRevoked: false });
    expect(t.guardAckArmed).not.toBeNull();
    expect(events).not.toContain('confirm-revoked');
    t.failRevoke = false;
    expect(await t.restoreGuardAck()).toMatchObject({ released: true, boundary: 'revoked' });
    expect(receipt.present).toBe(false);
  });

  it('startup without the original viewer cannot release a live request, but recorded expiry permits recovery', async () => {
    const { t, events, receipt } = viewerTarget('both');
    await expect(t.typePassword(c)).rejects.toThrow();
    t.main = null;
    events.length = 0;
    await expect(t.restoreGuardAck()).rejects.toThrow('retaining frozen heartbeat');
    expect(events).toEqual(['receipt', 'release']);
    expect(receipt.present).toBe(true);
    t.now = () => receipt.expiresAt + 1;
    expect(await t.restoreGuardAck()).toMatchObject({ released: true, boundary: 'expired' });
  });

  it('runCase cannot pass or thaw an in-flight request when both revoke and viewer close fail', async () => {
    const { t, receipt } = viewerTarget('both');
    const harness = target();
    harness.typePassword = () => t.typePassword(c);
    harness.recover = async () => {
      try { await t.restoreGuardAck(); return []; }
      catch (error) { return [String(error)]; }
    };
    const ev = await runCase(c, harness);
    expect(ev.verdict.pass).toBe(false);
    expect(ev.secretResult.error).toContain('retaining frozen heartbeat');
    expect(receipt).toMatchObject({ present: true, secretState: 'may-be-in-flight', grantRevoked: false });
  });

  it('requires an exact approved server expiry before arming', async () => {
    const t = Object.assign(Object.create(RealTarget.prototype), {
      main: { requestId: REQUEST, session: 'original-viewer' }, a: {}, now: () => 100_000,
      api: async (_a: unknown, method: string, route: string, _body: unknown, headers: Record<string, string>) => {
        expect(method).toBe('GET'); expect(route).toBe(`/desktop/requests/${REQUEST}`);
        expect(headers['X-Instar-Operator-Session']).toBe('original-viewer');
        return { httpStatus: 200, status: 'approved' };
      },
      guardAckCommand: () => { throw new Error('must not arm'); },
    });
    await expect(t.act('block-guard-heartbeat')).rejects.toThrow('server expiry');
    t.api = async () => ({ httpStatus: 200, status: 'approved', expiresAt: 200_000 });
    t.guardAckCommand = (action: string, request: string, expiresAt: number) => {
      expect([action, request, expiresAt]).toEqual(['arm', REQUEST, 200_000]); return armed();
    };
    expect(await t.act('block-guard-heartbeat')).toMatchObject({ armed: true });
  });
});

function sandbox() {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-ack-proof-')));
  const store = path.join(tmp, '.instar/desktop-helper/locked');
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  const rawCall = (action: string, ...args: string[]) => spawnSync('python3', [script, '--execute', action, store, ...args], {
    encoding: 'utf8', env: { ...process.env, LOCKED_PROOF_TEST_ROOT: store }, timeout: 10_000,
  });
  const call = (action: string, ...args: string[]) => rawCall(action, ...args,
    ...(action === 'arm' && args.length === 1 ? [String(Date.now() + 60_000)] : []));
  const clean = () => {
    let result = call('release');
    if (result.status !== 0 && result.stderr.includes('recorded server expiry')) {
      // This directory contains synthetic grants only, never a real desktop request.
      call('confirm-revoked', REQUEST);
      result = call('release');
    }
    if (result.status !== 0) throw new Error(`fixture test cleanup: ${result.stderr}`);
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'test fixture cleanup' });
  };
  return { tmp, store, call, rawCall, clean };
}

function driverIdentity(pid = process.pid) {
  return { driverPid: pid, driverStart: spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim() };
}

function reservedReceipt() {
  return { schema: 2, phase: 'reserved', key: KEY, uid: process.getuid!(), token: 'a'.repeat(32),
    ...driverIdentity(), expiresAt: Date.now() + 60_000, secretState: 'not-submitted', grantRevoked: false };
}

describe.skipIf(process.platform !== 'darwin')('real immutable heartbeat fixture in a disposable directory', () => {
  it('refuses missing expiry and preserves the frozen fault until exact revocation', () => {
    const s = sandbox();
    try {
      expect(s.rawCall('arm', REQUEST).status).not.toBe(0);
      expect(fs.existsSync(path.join(s.store, '.proof-guard-ack.json'))).toBe(false);
      expect(s.call('arm', REQUEST).status).toBe(0);
      expect(s.call('begin-secret', REQUEST).status).toBe(0);
      expect(s.call('release').stderr).toContain('recorded server expiry');
      expect(JSON.parse(s.call('observe').stdout).frozen).toBe(true);
      expect(s.call('confirm-revoked', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa').status).not.toBe(0);
      expect(s.call('release').status).not.toBe(0);
      expect(s.call('confirm-revoked', REQUEST).status).toBe(0);
      expect(JSON.parse(s.call('release').stdout).boundary).toBe('revoked');
    } finally { s.clean(); }
  });

  it('recovers a possibly submitted request only after its durable deadline, without sleeps', () => {
    const s = sandbox();
    try {
      expect(s.call('arm', REQUEST).status).toBe(0);
      expect(s.call('begin-secret', REQUEST).status).toBe(0);
      const receiptPath = path.join(s.store, '.proof-guard-ack.json');
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      // Synthetic server clock boundary in a disposable fixture; no real request.
      receipt.expiresAt = Date.now() - 1;
      fs.writeFileSync(receiptPath, JSON.stringify(receipt));
      expect(s.call('begin-secret', REQUEST).status).not.toBe(0);
      expect(JSON.parse(s.call('release').stdout).boundary).toBe('expired');
      fs.utimesSync(path.join(s.store, `hb-${KEY}`), new Date(), new Date());
    } finally { s.clean(); }
  });

  it('blocks native-style rewrite and timestamp refresh, then releases idempotently', () => {
    const s = sandbox();
    try {
      const result = s.call('arm', REQUEST);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ key: KEY, armed: true, frozen: true });
      const hb = path.join(s.store, `hb-${KEY}`);
      expect(() => fs.writeFileSync(hb, '')).toThrow(/EPERM/);
      expect(() => fs.utimesSync(hb, new Date(), new Date())).toThrow(/EPERM/);
      expect(JSON.parse(s.call('observe').stdout).mtimeNs).toBe('1000000000');
      expect(JSON.parse(s.call('release').stdout)).toMatchObject({ released: true, key: KEY });
      fs.writeFileSync(hb, '');
      fs.utimesSync(hb, new Date(), new Date());
      expect(JSON.parse(s.call('release').stdout)).toMatchObject({ released: true, present: false });
    } finally { s.clean(); }
  });

  it('refuses old markers, existing heartbeats, symlinks and a second arm', () => {
    const s = sandbox();
    try {
      const state = path.join(s.store, 'locked-state.json');
      fs.writeFileSync(state, JSON.stringify({ markers: { [KEY]: { state: 'relocked' } } }));
      expect(s.call('arm', REQUEST).stderr).toContain('already has a relock marker');
      fs.writeFileSync(state, '{}');
      const hb = path.join(s.store, `hb-${KEY}`);
      fs.symlinkSync(state, hb);
      expect(s.call('arm', REQUEST).stderr).toContain('existing heartbeat');
      SafeFsExecutor.safeUnlinkSync(hb, { operation: 'test symlink cleanup' });
      expect(s.call('arm', REQUEST).status).toBe(0);
      expect(s.call('arm', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa').stderr).toContain('previous fixture');
    } finally { s.clean(); }
  });

  it('recovers a durable reserved receipt before file creation and before inode recording', () => {
    const s = sandbox();
    const receipt = path.join(s.store, '.proof-guard-ack.json');
    const token = 'a'.repeat(32);
    const reserved = reservedReceipt();
    try {
      fs.writeFileSync(receipt, JSON.stringify(reserved));
      expect(s.call('release').status).toBe(0);
      fs.writeFileSync(receipt, JSON.stringify(reserved));
      fs.writeFileSync(path.join(s.store, `hb-${KEY}`), token);
      expect(s.call('release').status).toBe(0);
      expect(fs.readFileSync(path.join(s.store, `hb-${KEY}`), 'utf8')).toBe(token);
      fs.writeFileSync(receipt, JSON.stringify(reserved));
      fs.writeFileSync(path.join(s.store, `hb-${KEY}`), '');
      expect(s.call('release').status).toBe(0);
    } finally { s.clean(); }
  });

  it('retires a reserved receipt without changing a partial or unknown nonimmutable file', () => {
    const s = sandbox();
    const receipt = path.join(s.store, '.proof-guard-ack.json');
    try {
      fs.writeFileSync(receipt, JSON.stringify(reservedReceipt()));
      const hb = path.join(s.store, `hb-${KEY}`);
      fs.writeFileSync(hb, 'not-this-fixture');
      expect(s.call('release').status).toBe(0);
      expect(fs.readFileSync(hb, 'utf8')).toBe('not-this-fixture');
      expect(fs.existsSync(receipt)).toBe(false);
    } finally { s.clean(); }
  });

  it('will not unfreeze a different inode substituted under a valid receipt', () => {
    const s = sandbox();
    let saved: string | undefined;
    const receipt = path.join(s.store, '.proof-guard-ack.json');
    try {
      expect(s.call('arm', REQUEST).status).toBe(0);
      saved = fs.readFileSync(receipt, 'utf8');
      const invalid = JSON.parse(saved); invalid.ino += 1;
      fs.writeFileSync(receipt, JSON.stringify(invalid));
      expect(s.call('release').stderr).toContain('unknown immutable replacement');
      expect(() => fs.writeFileSync(path.join(s.store, `hb-${KEY}`), '')).toThrow(/EPERM/);
    } finally { if (saved) fs.writeFileSync(receipt, saved); s.clean(); }
  });

  it('refuses recovery of another live driver but recovers after that identity is gone', () => {
    const s = sandbox();
    let saved: string | undefined;
    const receipt = path.join(s.store, '.proof-guard-ack.json');
    try {
      expect(s.call('arm', REQUEST).status).toBe(0);
      saved = fs.readFileSync(receipt, 'utf8');
      const r = JSON.parse(saved);
      Object.assign(r, driverIdentity(process.ppid));
      fs.writeFileSync(receipt, JSON.stringify(r));
      expect(s.call('release').stderr).toContain('another live proof driver');
      expect(() => fs.writeFileSync(path.join(s.store, `hb-${KEY}`), '')).toThrow(/EPERM/);
      r.driverStart = 'different process start';
      fs.writeFileSync(receipt, JSON.stringify(r));
      expect(s.call('release').status).toBe(0);
      fs.writeFileSync(path.join(s.store, `hb-${KEY}`), '');
    } finally { if (saved) fs.writeFileSync(receipt, saved); s.clean(); }
  });

  it('rejects paths outside the proof/temp store and refuses symlinked store roots', () => {
    const s = sandbox();
    try {
      const outside = spawnSync('python3', [script, '--execute', 'release', s.tmp], { encoding: 'utf8', timeout: 10_000 });
      expect(outside.stderr).toContain('not the proof store');
      const alias = path.join(s.tmp, 'alias'); fs.symlinkSync(s.store, alias);
      const symlink = spawnSync('python3', [script, '--execute', 'release', alias], {
        encoding: 'utf8', env: { ...process.env, LOCKED_PROOF_TEST_ROOT: alias }, timeout: 10_000,
      });
      expect(symlink.stderr).toContain('symlinked store');
    } finally { s.clean(); }
  });
});
