/** Actual detached supervisor, inert nonce-tagged workers, disposable directory; no Mac calls. */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const SCRIPT = path.resolve(__dirname, '../../scripts/locked-proof/watch-end-supervisor.py');
const KEY = '12345678-1234-1234-1234-123456789abc.0';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(duration = 2_500, independentDriver = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-end-test-')));
  const nonce = crypto.randomBytes(16).toString('hex');
  const workers = Array.from({ length: independentDriver ? 3 : 2 }, () => spawn('python3', [SCRIPT, 'test-worker', `watch-end-test:${nonce}`], { stdio: ['ignore', 'pipe', 'ignore'] }));
  await Promise.all(workers.map(worker => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('inert worker readiness timeout')), 3_000);
    worker.stdout!.once('data', data => { clearTimeout(timer); data.toString().trim() === 'ready' ? resolve() : reject(new Error('unexpected worker readiness')); });
    worker.once('exit', () => { clearTimeout(timer); reject(new Error('worker exited before readiness')); });
  })));
  const uid = process.getuid!();
  const context = { boot: 'test-boot', login: 'test-login', uid, onConsole: true, locked: false };
  fs.writeFileSync(path.join(root, 'test-context.json'), JSON.stringify(context));
  fs.writeFileSync(path.join(root, 'test-state.lock'), '');
  const plan = { key: KEY, watchStart: Date.now(), testDurationMs: duration, testNonce: nonce,
    guardPid: workers[0].pid, serverPid: workers[1].pid, driverPid: independentDriver ? workers[2].pid : process.pid };
  const call = (action: string) => spawnSync('python3', [SCRIPT, '--driver-pid', String(plan.driverPid), action, root], {
    input: action === 'arm' ? JSON.stringify(plan) : undefined, encoding: 'utf8', timeout: 6_000,
    env: { ...process.env, LOCKED_PROOF_WATCH_TEST_ROOT: root },
  });
  const receipt = () => JSON.parse(fs.readFileSync(path.join(root, 'receipt.json'), 'utf8'));
  const wait = async () => { for (let i = 0; i < 80; i++) { const r = receipt(); if (['recovered', 'recovery-failed'].includes(r.state)) return r; await delay(100); } throw new Error('supervisor did not finish'); };
  const clean = async () => {
    if (fs.existsSync(path.join(root, 'receipt.json')) && fs.statSync(path.join(root, 'receipt.json')).isFile()) { call('finish'); await wait(); }
    for (const worker of workers) { worker.kill('SIGCONT'); worker.kill('SIGTERM'); }
    await delay(50);
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'test supervisor fixture cleanup' });
  };
  return { root, workers, call, receipt, wait, clean, context, plan };
}

describe.skipIf(process.platform === 'win32')('bounded independent watch-end recovery', () => {
  it('reads an owned inode atomically replaced between open and fstat, but rejects hard links', () => {
    const code = `import importlib.util,tempfile,os,json,sys
spec=importlib.util.spec_from_file_location("supervisor",sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
 p=os.path.join(root,"receipt.json"); replacement=os.path.join(root,"next.json")
 open(p,"w").write('{"before":true}'); open(replacement,"w").write('{"after":true}')
 original=os.open
 def race(file,flags,*args):
  fd=original(file,flags,*args)
  if file==p: os.replace(replacement,p)
  return fd
 os.open=race
 assert m.read(root,"receipt.json")=={"before":True}
 os.open=original
 os.link(p,os.path.join(root,"alias"))
 try: m.read(root,"receipt.json"); raise AssertionError("hardlink accepted")
 except ValueError as e: assert "unsafe receipt" in str(e)
print("atomic-read-safe")`;
    const result = spawnSync('python3', ['-c', code, SCRIPT], { encoding: 'utf8', timeout: 3_000 });
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe('atomic-read-safe');
  });
  it('ACKs durably before freeze, then resumes both workers and records a simulated lock at deadline', async () => {
    const f = await fixture();
    try {
      const arm = f.call('arm'); expect(arm.status, arm.stderr).toBe(0);
      expect(f.receipt()).toMatchObject({ state: 'armed', supervisorPid: expect.any(Number), readyAt: expect.any(Number) });
      const frozen = f.call('freeze'); expect(frozen.status, frozen.stderr).toBe(0);
      const ended = await f.wait();
      expect(ended.state).toBe('recovered'); expect(ended.recoveryReason).toBe('deadline');
      expect(ended.results.guard.continued).toBe(true); expect(ended.results.server.continued).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(f.root, 'test-lock.json'), 'utf8')).context).toEqual(f.context);
    } finally { await f.clean(); }
  });
  it('recovers after the independent driver dies, without waiting for the deadline', async () => {
    const f = await fixture(5_000, true);
    try {
      expect(f.call('arm')).toMatchObject({ status: 0, stderr: '' }); expect(f.call('freeze')).toMatchObject({ status: 0, stderr: '' });
      f.workers[2].kill('SIGTERM');
      const ended = await f.wait();
      expect(ended.recoveryReason).toBe('driver-ended'); expect(ended.state).toBe('recovered');
      expect(ended.recoveredAt).toBeLessThan(ended.deadlineAt);
    } finally { await f.clean(); }
  });
  it('finish is a recovery handshake, and terminal state refuses a later freeze', async () => {
    const f = await fixture(5_000);
    try {
      expect(f.call('arm')).toMatchObject({ status: 0, stderr: '' }); expect(f.call('freeze')).toMatchObject({ status: 0, stderr: '' });
      expect(f.call('finish').status).toBe(0);
      expect((await f.wait()).recoveryReason).toBe('finish-requested');
      expect(f.call('freeze').stderr).toContain('not armed');
      expect(f.call('arm').stderr).toContain('existing recovery receipt');
    } finally { await f.clean(); }
  });
  it.each(['login', 'boot', 'uid', 'onConsole'])('never simulates a lock for changed %s context', async field => {
    const f = await fixture();
    try {
      expect(f.call('arm')).toMatchObject({ status: 0, stderr: '' }); expect(f.call('freeze')).toMatchObject({ status: 0, stderr: '' });
      fs.writeFileSync(path.join(f.root, 'test-context.json'), JSON.stringify({ ...f.context, [field]: field === 'uid' ? -1 : field === 'onConsole' ? false : 'other' }));
      f.call('finish'); const ended = await f.wait();
      expect(ended.state).toBe('recovery-failed'); expect(ended.recoveryProblems.join(' ')).toContain('no lock attempted');
      expect(ended.results.guard.continued).toBe(true); expect(ended.results.server.continued).toBe(true);
      expect(fs.existsSync(path.join(f.root, 'test-lock.json'))).toBe(false);
    } finally { await f.clean(); }
  });
  it('the monitor deadline cannot be extended by rewriting the wall-clock receipt deadline', async () => {
    const f = await fixture();
    try {
      expect(f.call('arm')).toMatchObject({ status: 0, stderr: '' }); expect(f.call('freeze')).toMatchObject({ status: 0, stderr: '' });
      const r = f.receipt(); const original = r.deadlineAt; r.deadlineAt += 3_600_000;
      const tmp = path.join(f.root, 'replacement.json'); fs.writeFileSync(tmp, JSON.stringify(r)); fs.renameSync(tmp, path.join(f.root, 'receipt.json'));
      const ended = await f.wait();
      expect(ended.recoveryReason).toBe('deadline'); expect(ended.recoveredAt).toBeLessThan(original + 2_000);
    } finally { await f.clean(); }
  });
  it('changed persisted identities cannot replace the immutable recovery plan', async () => {
    const f = await fixture(5_000);
    try {
      expect(f.call('arm')).toMatchObject({ status: 0, stderr: '' }); expect(f.call('freeze')).toMatchObject({ status: 0, stderr: '' });
      const r = f.receipt(); r.guard.start = 'wrong-start';
      const tmp = path.join(f.root, 'replacement.json'); fs.writeFileSync(tmp, JSON.stringify(r)); fs.renameSync(tmp, path.join(f.root, 'receipt.json'));
      f.call('finish'); const ended = await f.wait();
      expect(ended.state).toBe('recovery-failed'); expect(ended.recoveryProblems.join(' ')).toContain('retained original plan');
      expect(ended.results.guard.continued).toBe(true); expect(ended.results.server.continued).toBe(true);
    } finally { await f.clean(); }
  });
  it('a corrupt receipt cannot suppress independent resume and same-context recovery', async () => {
    const f = await fixture(5_000);
    try {
      expect(f.call('arm')).toMatchObject({ status: 0, stderr: '' }); expect(f.call('freeze')).toMatchObject({ status: 0, stderr: '' });
      fs.writeFileSync(path.join(f.root, 'receipt.json'), '{broken');
      await delay(400);
      const ended = await f.wait();
      expect(ended.state, JSON.stringify(ended)).toBe('recovery-failed');
      expect(ended.results.guard.continued).toBe(true); expect(ended.results.server.continued).toBe(true);
      expect(ended.results.lock.locked).toBe(true);
      expect(ended.recoveryProblems.join(' ')).toContain('receipt unreadable');
    } finally { await f.clean(); }
  });
  it('failed recovery-start writes cannot suppress resume or same-context lock attempts', async () => {
    const f = await fixture(5_000);
    try {
      expect(f.call('arm')).toMatchObject({ status: 0, stderr: '' }); expect(f.call('freeze')).toMatchObject({ status: 0, stderr: '' });
      fs.renameSync(path.join(f.root, 'receipt.json'), path.join(f.root, 'original-receipt.json'));
      // A directory makes read and atomic replacement fail; other writes remain observable.
      fs.mkdirSync(path.join(f.root, 'receipt.json'));
      for (let i = 0; i < 50 && !fs.existsSync(path.join(f.root, 'test-lock.json')); i++) await delay(100);
      expect(fs.existsSync(path.join(f.root, 'test-lock.json'))).toBe(true);
      for (const worker of f.workers) {
        const observed = spawnSync('/bin/ps', ['-p', String(worker.pid), '-o', 'stat='], { encoding: 'utf8', timeout: 1_000 });
        expect(observed.status).toBe(0); expect(observed.stdout.trim().startsWith('T')).toBe(false);
      }
      expect(fs.statSync(path.join(f.root, 'receipt.json')).isDirectory()).toBe(true);
      await delay(200); // Supervisor exits after failed final persistence; no clean receipt exists.
    } finally { await f.clean(); }
  });
  it('a held store lock refuses promptly, and independent recovery still resumes the stopped workers', async () => {
    const f = await fixture(5_000);
    const locker = spawn('python3', ['-c', 'import fcntl,time,sys; f=open(sys.argv[1],"r+"); fcntl.flock(f,fcntl.LOCK_EX); open(sys.argv[2],"w").close(); time.sleep(15)',
      path.join(f.root, 'test-state.lock'), path.join(f.root, 'locker-ready')], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 30 && !fs.existsSync(path.join(f.root, 'locker-ready')); i++) await delay(50);
      expect(fs.existsSync(path.join(f.root, 'locker-ready'))).toBe(true);
      expect(f.call('arm')).toMatchObject({ status: 0, stderr: '' });
      const start = Date.now(); const blocked = f.call('freeze');
      expect(blocked.status).not.toBe(0); expect(Date.now() - start).toBeLessThan(2_000);
      f.call('finish'); expect((await f.wait()).state).toBe('recovered');
    } finally { locker.kill('SIGTERM'); await f.clean(); }
  });
  it('refuses a target that is not a nonce-tagged inert worker', async () => {
    const f = await fixture();
    try { f.plan.guardPid = process.pid; expect(f.call('arm').stderr).toContain('nonce-tagged'); }
    finally { await f.clean(); }
  });
  it('refuses a symlinked root and a nonproof nontemporary path before mutation', () => {
    const r = spawnSync('python3', [SCRIPT, 'arm', '/Users/Shared/not-a-proof-root'], { encoding: 'utf8', input: '{}', timeout: 3_000 });
    expect(r.stderr).toContain('not the dedicated proof');
  });
});

// @ts-expect-error standalone proof harness
import { CASES, runCase, judge } from '../../scripts/locked-proof/lib.mjs';
// @ts-expect-error standalone proof harness
import { RealTarget } from '../../scripts/locked-proof/driver.mjs';
const watchCase = CASES.find((row: { id: string }) => row.id === '12.8');
function proofTimeline() {
  let time = 1_000_000;
  let watchStart = time + 1_000;
  let stopped = false, cued = false, frozen = false, resumed = false;
  let fault: any;
  const events: string[] = [];
  const marker = () => ({ agentId: 'proof-A', guardPid: 1234, guardStart: '123.456', state: resumed ? 'relock-failed' : stopped && time >= watchStart ? 'watching' : 'owed',
    watchStart: stopped && time >= watchStart ? watchStart : undefined, enterPendingAt: 1_000_001,
    ...(resumed ? { guardAt: fault.failureAt } : {}) });
  const t: any = {
    events, now: () => time, sleep: async (ms: number) => { time += ms; }, prepare: async () => {},
    openGrant: async () => ({}), typePassword: async () => ({ sent: true }),
    snapshot: async () => { time += 10; return { now: time, dirty: false, lockState: cued ? 'unlocked' : 'locked', markers: { [KEY]: marker() }, processesGone: true }; },
    act: async (action: string) => {
      events.push(action);
      if (action === 'stop-viewer') stopped = true;
      if (action === 'freeze-watch-end') { frozen = true; fault = { key: KEY, agentId: 'proof-A', receipt: { nonce: 'fixture-nonce', key: KEY, guard: { pid: 1234, uid: 501, start: '123.456', command: 'helper relock-guard' }, server: { pid: 1235, uid: 501, start: '123.457', command: 'node proof-A' } }, resumedServer: { pid: 1235, uid: 501, start: '123.457', command: 'node proof-A' }, watchStart, readyAt: time - 1, frozenAt: time }; return { armed: true, frozen: true }; }
      if (action === 'resume-watch-end') {
        if (!frozen || !cued) throw new Error('not ready');
        time = watchStart + 124_000; resumed = true;
        Object.assign(fault, { guardResumedAt: watchStart + 121_000, failureAt: time, nodeResumedAt: time + 1,
          sameNode: true, attentionId: `agent:desktop-relock-failed:${KEY}`, attentionAt: time + 1_000 });
        return fault;
      }
      return {};
    },
    askPerson: async () => { events.push('cue'); cued = true; return { channel: 'console', outcome: 'console-only', sent: false }; },
    settled: () => resumed,
    extraEvidence: async () => ({ watchEnd: fault, securityItemMs: fault.attentionAt - fault.failureAt }),
    recover: async () => { events.push('recover'); return []; },
    watchEndRecoveryEvidence: () => ({ nonce: 'fixture-nonce', key: KEY, state: 'recovered', results: { lock: { locked: true } }, recoveryProblems: [] }),
  };
  return t;
}

describe('watch-end proof sequencing and independent verdict', () => {
  it('arms and freezes after a locked watch, cues one unlock, resumes at watch end and requires recovery', async () => {
    const t = proofTimeline();
    const ev = await runCase(watchCase, t, { pollMs: 100 });
    expect(t.events).toEqual(['serve-under-launchd', 'stop-viewer', 'freeze-watch-end', 'cue', 'resume-watch-end', 'recover']);
    expect(ev.verdict).toEqual({ pass: true, reasons: [] });
    expect(ev.person.unlockAt).toBeLessThan(ev.person.validUntil);
    expect(ev.extra.watchEnd.failureAt).toBeGreaterThanOrEqual(ev.extra.watchEnd.watchStart + 120_000);
  });
  it('rejects setup without a ready ACK before asking the person', async () => {
    const t = proofTimeline(), act = t.act;
    t.act = async (action: string) => action === 'freeze-watch-end' ? {} : act(action);
    const ev = await runCase(watchCase, t, { pollMs: 100 });
    expect(ev.error).toContain('not confirmed before cue'); expect(t.events).not.toContain('cue');
  });
  it('rejects early native failure, unrelated attention, a boot/replacement, missing timings or failed cleanup', async () => {
    const good = await runCase(watchCase, proofTimeline(), { pollMs: 100 });
    for (const change of [
      (e: any) => { e.extra.watchEnd.failureAt = e.extra.watchEnd.watchStart + 5_000; },
      (e: any) => { e.extra.watchEnd.attentionId = 'agent:desktop-relock-failed:other'; },
      (e: any) => { e.extra.watchEnd.attentionAt = e.extra.watchEnd.failureAt + 10_001; },
      (e: any) => { e.extra.watchEnd.sameNode = false; },
      (e: any) => { e.final.markers.other = e.final.markers[e.extra.watchEnd.key]; delete e.final.markers[e.extra.watchEnd.key]; },
      (e: any) => { delete e.extra.watchEnd.guardResumedAt; },
      (e: any) => { e.watchEndRecovery.state = 'recovery-failed'; },
      (e: any) => { e.extra.watchEnd.resumedServer.start = 'other-start'; },
      (e: any) => { e.extra.watchEnd.receipt.server = {}; e.extra.watchEnd.resumedServer = {}; },
      (e: any) => { delete e.extra.watchEnd.receipt.server.uid; delete e.extra.watchEnd.resumedServer.uid; },
      (e: any) => { e.extra.watchEnd.receipt.guard.command = ''; },
      (e: any) => { e.extra.watchEnd.receipt.guard.pid = 0; e.final.markers[KEY].guardPid = 0; },
      (e: any) => { e.extra.watchEnd.receipt.server.pid = Infinity; e.extra.watchEnd.resumedServer.pid = Infinity; },
      (e: any) => { delete e.extra.watchEnd.receipt.nonce; delete e.watchEndRecovery.nonce; },
      (e: any) => { e.watchEndRecovery.nonce = 'old-recovery'; },
      (e: any) => { e.watchEndRecovery.key = 'other-duty'; },
      (e: any) => { e.extra.watchEnd.receipt.key = 'other-duty'; },
      (e: any) => { e.extra.watchEnd.guardResumedAt = e.extra.watchEnd.failureAt + 1; },
      (e: any) => { e.final.markers[e.extra.watchEnd.key].agentId = 'other-owner'; },
    ]) {
      const ev = structuredClone(good); change(ev); expect(judge(watchCase, ev).pass).toBe(false);
    }
  });
  it('refuses unknown B owner or disagreement with the running owner before any freeze', async () => {
    const t = Object.assign(Object.create(RealTarget.prototype), {
      launchdJob: {}, a: { agentId: 'proof-A' }, b: {},
      api: async () => ({ project: 'wrong-running-owner' }),
      readWatchStore: () => { throw new Error('must not reach store'); },
    });
    await expect(t.freezeWatchEnd()).rejects.toThrow('distinct A/B');
    t.b.agentId = 'proof-B';
    await expect(t.freezeWatchEnd()).rejects.toThrow('running proof server owner');
  });
  it('waits for the exact delayed attention item using a consistent clock', async () => {
    let calls = 0, sleeps = 0;
    const item = { id: `agent:desktop-relock-failed:${KEY}`, createdAt: new Date(1_700_000_005_000).toISOString() };
    const t = Object.assign(Object.create(RealTarget.prototype), {
      watchEnd: { key: KEY }, now: () => 1_700_000_000_000,
      sleep: async () => { sleeps++; },
      api: async () => ({ items: ++calls < 3 ? [] : [item] }),
    });
    expect(await t.waitSecurityItem(watchCase, 1_700_000_000_000, 1_700_000_001_000)).toEqual(item);
    expect(sleeps).toBe(2);
  });
  it('a busy finish waits read-only for recovery before allowing topology restoration', async () => {
    let polls = 0;
    const t = Object.assign(Object.create(RealTarget.prototype), {
      watchEnd: {}, sleep: async () => {},
      watchSupervisor: (action: string) => {
        if (action === 'finish') throw new Error('recovery operation busy');
        return ++polls === 1 ? { state: 'recovering' } : { state: 'recovered', results: { lock: { locked: true } } };
      },
    });
    await t.finishWatchEnd();
    expect(polls).toBe(2); expect(t.watchEnd.recovery.state).toBe('recovered');
  });
  it('unconfirmed independent cleanup prevents launchd/server restoration', async () => {
    let topologyChanges = 0;
    const t = Object.assign(Object.create(RealTarget.prototype), {
      watchEnd: { recovery: { state: 'recovering' } }, launchdJob: {},
      finishWatchEnd: async () => { throw new Error('not confirmed'); },
      endLaunchdServe: () => { topologyChanges++; },
    });
    expect(await t.recover()).toEqual(['watch-end recovery: not confirmed']);
    expect(topologyChanges).toBe(0);
  });
  it('the real driver resumes the same Node only after native terminal failure is observed', async () => {
    let time = 1_000_000;
    const events: Array<{ action: string; t: number }> = [];
    const t = Object.assign(Object.create(RealTarget.prototype), {
      watchEnd: { key: KEY, watchStart: time, frozen: true }, now: () => time,
      sleep: async (ms: number) => { time += ms; }, localWatchLock: () => 'unlocked',
      assertWatchEndIdentity: () => ({ state: time >= 1_124_000 ? 'relock-failed' : 'watching', guardAt: 1_124_000 }),
      watchSupervisor: (action: string) => { events.push({ action, t: time }); return { continued: true, gone: false, at: time }; },
    });
    const result = await t.resumeWatchEnd();
    expect(events).toEqual([{ action: 'resume-guard', t: 1_121_000 }, { action: 'resume-server', t: 1_124_000 }]);
    expect(result.failureAt).toBe(1_124_000); expect(t.watchEnd.frozen).toBe(false);
  });
  it('an actually relocked Mac is a setup miss, not an invented watch-end failure', async () => {
    const t = Object.assign(Object.create(RealTarget.prototype), {
      watchEnd: { key: KEY, watchStart: 1_000_000, frozen: true }, now: () => 1_124_000,
      localWatchLock: () => 'locked-in-session', assertWatchEndIdentity: () => ({ state: 'relocked' }),
      watchSupervisor: () => ({ continued: true, gone: false, at: 1_124_000 }),
    });
    await expect(t.resumeWatchEnd()).rejects.toThrow('setup miss');
  });
});
