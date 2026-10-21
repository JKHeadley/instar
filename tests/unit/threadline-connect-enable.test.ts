/**
 * Connect-enable: an agent switches its agent network and pairing on at its person's
 * request and it takes effect with NO restart performed by the person
 * (upgrades/side-effects/threadline-enable-without-restart.md).
 *
 * Covers: the restart decision (when to restart, when not to, when to wait), the config
 * write, the supervised-restart request it writes, the deferred retry, the asking session's
 * exclusion from the restart gate, the supervisor no longer skipping every third
 * version-less restart, and the agent knowledge (new + existing agents) that no longer asks
 * the person for a restart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideConnectEnable, writeConnectConfig, writeConnectRestartRequest, restartRequestPending, lifelineRunning, CONNECT_ENABLE_DEFER_MAX_MS,
  readConnectEnableRecord, readConnectEnableStatus, isInstarLifelineCommand, ConnectEnableController, CONNECT_ENABLE_RESTART_COOLDOWN_MS,
  CONNECT_ENABLE_REQUESTED_BY, sayToPerson, type ConnectEnableInputs,
} from '../../src/threadline/connectEnable.js';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { StateManager } from '../../src/core/StateManager.js';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import {
  agentConnectSection, agentConnectStep1, generateClaudeMd, AGENT_CONNECT_HEADING,
  AGENT_CONNECT_STEP1_RESTART_ASK_MARKER,
} from '../../src/scaffold/templates.js';
import { TreeGenerator } from '../../src/knowledge/TreeGenerator.js';
import { TreeTraversal } from '../../src/knowledge/TreeTraversal.js';
import { ProbeRegistry } from '../../src/knowledge/ProbeRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { startFakeLifeline, startUnrelatedProcess, type FakeLifeline } from '../helpers/fakeLifeline.js';
import { processStartMs } from '../../src/core/processIdentity.js';

const NOW = Date.parse('2026-10-20T21:00:00Z');
const base: ConnectEnableInputs = {
  ready: false, bootRelayEnabled: false, bootPairingEnabled: false, ownsRelayAfterRestart: true,
  restartAlreadyPending: false, lastRequest: null, pid: 100, now: NOW, blockers: [], supervised: true,
};
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'connect-enable-')); });
afterEach(() => { vi.useRealTimers(); SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/threadline-connect-enable.test.ts' }); });

describe('decideConnectEnable — when the server restarts itself', () => {
  it('relay and pairing off, nothing in the way → write config and restart', () => {
    expect(decideConnectEnable(base)).toMatchObject({ state: 'restarting', writeConfig: true, requestRestart: true });
  });
  it('relay on but pairing off → restart (the pairing gate is read at boot)', () => {
    expect(decideConnectEnable({ ...base, bootRelayEnabled: true })).toMatchObject({ state: 'restarting', requestRestart: true });
  });
  it('already ready → nothing written, no restart', () => {
    expect(decideConnectEnable({ ...base, ready: true })).toMatchObject({ state: 'ready', writeConfig: false, requestRestart: false });
  });
  it('a quiet standby machine → no restart (it would not run the relay after one)', () => {
    expect(decideConnectEnable({ ...base, ownsRelayAfterRestart: false })).toMatchObject({ state: 'unavailable-here', writeConfig: false, requestRestart: false });
  });
  it('relay and pairing already on but no invite engine here → no restart (it changes nothing)', () => {
    expect(decideConnectEnable({ ...base, bootRelayEnabled: true, bootPairingEnabled: true })).toMatchObject({ state: 'unavailable-here', requestRestart: false });
  });
  it('a restart request already waiting → no second request', () => {
    expect(decideConnectEnable({ ...base, restartAlreadyPending: true })).toMatchObject({ state: 'restarting', writeConfig: true, requestRestart: false });
  });
  it('this same process asked a moment ago (flag consumed, restart under way) → no second request', () => {
    expect(decideConnectEnable({ ...base, lastRequest: { requestedAt: ago(5_000), pid: 100 } })).toMatchObject({ state: 'restarting', requestRestart: false });
  });
  it('a NEW process after a restart for this, still not ready → refuses to loop', () => {
    expect(decideConnectEnable({ ...base, lastRequest: { requestedAt: ago(60_000), pid: 99 } }))
      .toMatchObject({ state: 'not-ready-after-restart', writeConfig: false, requestRestart: false });
  });
  it('the cooldown ends → a later request may restart again', () => {
    expect(decideConnectEnable({ ...base, lastRequest: { requestedAt: ago(CONNECT_ENABLE_RESTART_COOLDOWN_MS + 1), pid: 99 } }))
      .toMatchObject({ state: 'restarting', requestRestart: true });
  });
  it('another session is actively working → defer, config written, no restart yet', () => {
    const d = decideConnectEnable({ ...base, blockers: ['job-digest'] });
    expect(d).toMatchObject({ state: 'deferred', writeConfig: true, requestRestart: false });
    expect(d.reason).toContain('job-digest');
  });
  it('no lifeline to bring the server back → no restart (it would stay down), config still written', () => {
    expect(decideConnectEnable({ ...base, supervised: false })).toMatchObject({ state: 'restart-unavailable', writeConfig: true, requestRestart: false });
    expect(decideConnectEnable({ ...base, supervised: false, ready: true }).state).toBe('ready');
  });
  it('every state the agent can be told has a plain sentence, and none asks the person to restart', () => {
    for (const st of ['restarting', 'deferred', 'unavailable-here', 'not-ready-after-restart', 'restart-unavailable'] as const) {
      expect(sayToPerson(st).length).toBeGreaterThan(10);
      expect(sayToPerson(st)).not.toMatch(/restart|lifeline|config|setting/i);
    }
  });
});

describe('writeConnectConfig', () => {
  it('sets both keys and leaves every other key alone; a re-run changes nothing', () => {
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 4042, threadline: { visibility: 'unlisted', verifiedPairing: { dryRun: false } } }));
    writeConnectConfig(tmp);
    const after = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf-8'));
    expect(after).toEqual({ port: 4042, threadline: { visibility: 'unlisted', relayEnabled: true, verifiedPairing: { dryRun: false, enabled: true } } });
    const mtime = fs.statSync(path.join(tmp, 'config.json')).mtimeMs;
    writeConnectConfig(tmp);
    expect(fs.statSync(path.join(tmp, 'config.json')).mtimeMs).toBe(mtime);
  });
});

describe('lifelineRunning — the lock\'s pid must really be an Instar lifeline', () => {
  const procs: FakeLifeline[] = [];
  afterEach(() => { for (const p of procs.splice(0)) p.stop(); });
  const lock = (pid: unknown) => fs.writeFileSync(path.join(tmp, 'lifeline.lock'), JSON.stringify({ pid }));

  it('true for a live process running `instar … lifeline start`', async () => {
    procs.push(await startFakeLifeline(tmp));
    expect(lifelineRunning(tmp)).toBe(true);
  });
  it('a REUSED pid running something else fails closed', () => {
    const other = startUnrelatedProcess();
    procs.push(other);
    fs.writeFileSync(path.join(tmp, 'lifeline.lock'), JSON.stringify({ pid: other.pid, procStart: processStartMs(other.pid) }));
    expect(lifelineRunning(tmp)).toBe(false);
  });
  it('a pid reused by ANOTHER agent\'s lifeline (command line matches, start time does not) fails closed', async () => {
    // A real lifeline-shaped process at the pid, but the lock records an earlier procStart:
    // the process that wrote this lock is gone and a different lifeline got its pid.
    const other = await startFakeLifeline(tmp);
    procs.push(other);
    const lockPath = path.join(tmp, 'lifeline.lock');
    const rec = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(lifelineRunning(tmp)).toBe(true); // control: the matching lock passes
    fs.writeFileSync(lockPath, JSON.stringify({ ...rec, procStart: rec.procStart - 60_000 }));
    expect(lifelineRunning(tmp)).toBe(false);
  });
  it('an unreadable start time, or a lock without procStart, fails closed', async () => {
    const lf = await startFakeLifeline(tmp);
    procs.push(lf);
    expect(lifelineRunning(tmp, undefined, () => null)).toBe(false);
    fs.writeFileSync(path.join(tmp, 'lifeline.lock'), JSON.stringify({ pid: lf.pid, startedAt: new Date().toISOString() }));
    expect(lifelineRunning(tmp)).toBe(false);
  });
  it('the test runner itself (alive, start time matches, not a lifeline) fails closed', () => {
    fs.writeFileSync(path.join(tmp, 'lifeline.lock'), JSON.stringify({ pid: process.pid, procStart: processStartMs(process.pid) }));
    expect(lifelineRunning(tmp)).toBe(false);
  });
  it('no lock, a dead pid, garbage, or an unreadable command line fail closed', () => {
    expect(lifelineRunning(tmp)).toBe(false);
    lock(2_147_483_000);
    expect(lifelineRunning(tmp)).toBe(false);
    lock('12');
    expect(lifelineRunning(tmp)).toBe(false);
    fs.writeFileSync(path.join(tmp, 'lifeline.lock'), 'not json');
    expect(lifelineRunning(tmp)).toBe(false);
    fs.writeFileSync(path.join(tmp, 'lifeline.lock'), JSON.stringify({ pid: 4242, procStart: 1 }));
    expect(lifelineRunning(tmp, () => null, () => 1)).toBe(false);
  });
  it('the command-line rule', () => {
    expect(isInstarLifelineCommand('/a/.instar/bin/node /a/.instar/instar-boot.cjs lifeline start --dir /a')).toBe(true);
    expect(isInstarLifelineCommand('node /usr/lib/node_modules/instar/dist/cli.js lifeline start')).toBe(true);
    expect(isInstarLifelineCommand('instar server start')).toBe(false);
    expect(isInstarLifelineCommand('sleep 600')).toBe(false);
    expect(isInstarLifelineCommand('node other-tool lifeline start')).toBe(false);
  });
});

describe('writeConnectConfig — never overwrites a concurrent edit', () => {
  it('a change made by another writer between read and commit is kept, and both keys still land', () => {
    const p = path.join(tmp, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ port: 1 }));
    let fired = 0;
    writeConnectConfig(tmp, { beforeCommit: () => {
      if (fired++ === 0) fs.writeFileSync(p, JSON.stringify({ port: 1, updates: { autoApply: false } }));
    } });
    expect(fired).toBe(2); // first attempt saw the change and started again
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ port: 1, updates: { autoApply: false }, threadline: { relayEnabled: true, verifiedPairing: { enabled: true } } });
    expect(fs.readdirSync(tmp).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
  it('a file that never stops changing is not written at all (no stale overwrite)', () => {
    const p = path.join(tmp, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ n: 0 }));
    let n = 0;
    expect(() => writeConnectConfig(tmp, { beforeCommit: () => fs.writeFileSync(p, JSON.stringify({ n: ++n })) })).toThrow(/kept changing/);
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ n: 5 });
  });
});

describe('writeConnectConfig — keeps the file private', () => {
  it('a 0600 config.json (it holds the auth token) stays 0600, and no temp file is left', () => {
    const p = path.join(tmp, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ authToken: 'secret' }), { mode: 0o600 });
    fs.chmodSync(p, 0o600);
    writeConnectConfig(tmp);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(tmp).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});

describe('writeConnectRestartRequest — the existing supervised-restart flag', () => {
  it('writes a planned restart with NO targetVersion (so the lifeline is not restarted too) and a record', () => {
    expect(writeConnectRestartRequest(tmp, NOW, 4242)).toBe(true);
    const flag = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'restart-requested.json'), 'utf-8'));
    expect(flag).toMatchObject({ requestedBy: CONNECT_ENABLE_REQUESTED_BY, plannedRestart: true, pid: 4242 });
    expect(flag.targetVersion).toBeUndefined();
    expect(restartRequestPending(tmp, NOW)).toBe(true);
    expect(restartRequestPending(tmp, NOW + 61 * 60_000)).toBe(false); // expired
    expect(readConnectEnableRecord(tmp)).toEqual({ requestedAt: new Date(NOW).toISOString(), pid: 4242 });
  });
  it('a cooldown record that cannot be written does not turn a queued restart into "unavailable"', () => {
    fs.mkdirSync(path.join(tmp, 'state', 'threadline-connect-enable.json'), { recursive: true }); // a directory: the write fails
    expect(writeConnectRestartRequest(tmp, NOW)).toBe(true);
    expect(restartRequestPending(tmp, NOW)).toBe(true);
  });
  it('clears a version-less restart count (an older supervisor would skip this restart) but keeps an update count', () => {
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    const countFile = path.join(tmp, 'state', 'restart-version-count.json');
    fs.writeFileSync(countFile, JSON.stringify({ count: 2 }));
    writeConnectRestartRequest(tmp, NOW);
    expect(fs.existsSync(countFile)).toBe(false);
    fs.writeFileSync(countFile, JSON.stringify({ targetVersion: '1.2.3', count: 2 }));
    writeConnectRestartRequest(tmp, NOW);
    expect(JSON.parse(fs.readFileSync(countFile, 'utf-8'))).toEqual({ targetVersion: '1.2.3', count: 2 });
  });
});

describe('ConnectEnableController', () => {
  const ctl = (over: Partial<ConstructorParameters<typeof ConnectEnableController>[0]> = {}) => new ConnectEnableController({
    stateDir: tmp, isReady: () => false, bootRelayEnabled: () => false, bootPairingEnabled: () => false,
    ownsRelayAfterRestart: () => true, blockers: () => [], supervised: () => true, pid: 100, now: () => NOW, retryMs: 60_000, ...over,
  });
  const flag = () => path.join(tmp, 'state', 'restart-requested.json');

  it('restarting: config on disk, flag written, a sentence and an ETA for the person', () => {
    const r = ctl().request(['me']);
    expect(r).toMatchObject({ state: 'restarting', backInSeconds: 60 });
    expect(r.sayToPerson).toContain('about a minute');
    expect(fs.existsSync(flag())).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf-8')).threadline).toMatchObject({ relayEnabled: true, verifiedPairing: { enabled: true } });
    // Asking again does not write a second request.
    SafeFsExecutor.safeUnlinkSync(flag(), { operation: 'tests/unit/threadline-connect-enable.test.ts' });
    expect(ctl().request(['me']).state).toBe('restarting');
    expect(fs.existsSync(flag())).toBe(false);
  });

  it('deferred: the asking session is excluded, the server retries by itself and restarts once the way is clear', () => {
    let blockers = ['other-session'];
    const seen: string[][] = [];
    const c = ctl({ blockers: (ex) => { seen.push(ex); return blockers.filter((b) => !ex.includes(b)); } });
    const r = c.request(['me']);
    expect(r).toMatchObject({ state: 'deferred', blockingSessions: ['other-session'] });
    expect(seen[0]).toEqual(['me']);
    expect(c.isDeferred()).toBe(true);
    expect(fs.existsSync(flag())).toBe(false);
    expect(c.retryTick()).toBe('deferred');
    blockers = [];
    expect(c.retryTick()).toBe('restarting');
    expect(c.isDeferred()).toBe(false);
    expect(fs.existsSync(flag())).toBe(true);
    expect(seen.every((ex) => ex.includes('me'))).toBe(true);
  });

  it('the retry runs on its own timer', () => {
    vi.useFakeTimers({ now: NOW });
    let blockers = ['other'];
    const c = ctl({ now: () => Date.now(), blockers: () => blockers });
    c.request([]);
    blockers = [];
    vi.advanceTimersByTime(60_000);
    expect(fs.existsSync(flag())).toBe(true);
    expect(c.isDeferred()).toBe(false);
  });

  it('a deferral that does not clear within the agent\'s wait is dropped: no restart after the person was told', () => {
    let now = NOW;
    let blockers = ['other'];
    const c = ctl({ now: () => now, blockers: () => blockers });
    expect(c.request([]).state).toBe('deferred');
    now = NOW + CONNECT_ENABLE_DEFER_MAX_MS + 1;
    blockers = [];
    blockers = ['still-busy'];
    expect(c.retryTick()).toBe('gave-up');
    expect(c.isDeferred()).toBe(false);
    expect(fs.existsSync(flag())).toBe(false);
    // Recorded explicitly, not left looking "deferred".
    expect(readConnectEnableStatus(tmp)).toMatchObject({ state: 'gave-up', configWritten: true, restartPending: true });
    expect(readConnectEnableStatus(tmp)!.reason).toContain('still-busy');
    expect(c.status()).toMatchObject({ deferred: false, last: { state: 'gave-up' } });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf-8')).threadline).toMatchObject({ relayEnabled: true, verifiedPairing: { enabled: true } });
    // A fresh request from the agent supersedes the give-up.
    blockers = [];
    expect(c.request([]).state).toBe('restarting');
    expect(readConnectEnableStatus(tmp)).toBeNull();
  });

  it('#2242 restart holds (a pairing invite awaiting approval): the enable restart waits on the hold, and the 5-minute give-up still ends the wait', () => {
    // A real AutoUpdater with a hold provider shaped like the pairing-invite one, wired the way the route wires it.
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    const u = new AutoUpdater(
      { getInstalledVersion: () => '1.0.0', getLastCheck: () => null } as unknown as UpdateChecker,
      { get: () => undefined, set: () => {} } as unknown as StateManager,
      tmp, { restartImmediately: true }, // even an always-latest agent honours holds
    );
    let now = NOW;
    u.setRestartHold('pairing-invite', () => [{ name: 'pairing-invite:abcd1234', until: Date.now() + 60 * 60_000, reason: 'a pairing invite from "echo" is waiting for the operator\'s approval' }]);
    const c = ctl({ now: () => now, blockers: (ex) => u.getRestartBlockers((n) => ex.includes(n)) });
    const r = c.request(['me']);
    expect(r).toMatchObject({ state: 'deferred', blockingSessions: ['hold:pairing-invite:abcd1234'] });
    // Its own config change creates no hold and does not block it: only the invite does.
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf-8')).threadline.relayEnabled).toBe(true);
    now = NOW + 60_000;
    expect(c.retryTick()).toBe('deferred');
    now = NOW + CONNECT_ENABLE_DEFER_MAX_MS + 1;
    expect(c.retryTick()).toBe('gave-up');
    expect(fs.existsSync(flag())).toBe(false);
    expect(readConnectEnableStatus(tmp)!.reason).toContain('hold:pairing-invite:abcd1234');
  });

  it('without a lifeline: config written, no flag, and the reason says why', () => {
    const r = ctl({ supervised: () => false }).request([]);
    expect(r).toMatchObject({ state: 'restart-unavailable', requestRestart: false });
    expect(r.reason).toContain('no lifeline');
    expect(fs.existsSync(flag())).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf-8')).threadline.relayEnabled).toBe(true);
  });

  it('a request that cannot be written says so (503 path), never "restarting"', () => {
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    fs.mkdirSync(flag()); // a directory where the flag must go: rename fails
    expect(ctl().request([]).state).toBe('restart-unavailable');
  });
});

describe('AutoUpdater.getRestartBlockers — the same gate an update restart uses', () => {
  const updater = (restartImmediately = false) => {
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    const u = new AutoUpdater(
      { getInstalledVersion: () => '1.0.0', getLastCheck: () => null } as unknown as UpdateChecker,
      { get: () => undefined, set: () => {} } as unknown as StateManager,
      tmp, { restartImmediately },
    );
    u.setSessionDeps(
      { listRunningSessions: () => [{ name: 'asker', tmuxSession: 'asker' }, { name: 'busy', tmuxSession: 'busy' }, { name: 'quiet', tmuxSession: 'quiet' }] },
      { getStatus: () => ({ sessionHealth: [
        { topicId: 1, sessionName: 'asker', status: 'healthy', idleMinutes: 0 },
        { topicId: 2, sessionName: 'busy', status: 'healthy', idleMinutes: 0 },
        { topicId: 3, sessionName: 'quiet', status: 'idle', idleMinutes: 90 },
      ] }) },
    );
    return u;
  };
  it('lists other healthy sessions and drops the asker', () => {
    expect(updater().getRestartBlockers((n) => n === 'asker')).toEqual(['busy']);
    expect(updater().getRestartBlockers()).toEqual(['asker', 'busy']);
  });
  it('none under updates.restartImmediately', () => {
    expect(updater(true).getRestartBlockers()).toEqual([]);
  });
  it('active restart holds are listed (even under restartImmediately); an ended hold is not', () => {
    for (const ri of [false, true]) {
      const u = updater(ri);
      u.setRestartHold('pairing-invite', () => [
        { name: 'pairing-invite:aaaa', until: Date.now() + 60_000, reason: 'pending' },
        { name: 'pairing-invite:old', until: Date.now() - 1, reason: 'expired' },
      ]);
      expect(u.getRestartBlockers((n) => n === 'asker')).toEqual(ri ? ['hold:pairing-invite:aaaa'] : ['busy', 'hold:pairing-invite:aaaa']);
    }
  });
  it('does not start the update deferral clock', () => {
    const u = updater();
    u.getRestartBlockers();
    expect(u.getStatus().deferralReason).toBeNull();
  });
});

describe('ServerSupervisor — a version-less restart is never skipped as a loop', () => {
  const sup = () => {
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    const s = new ServerSupervisor({ projectDir: tmp, projectName: 'connect-enable-test', port: 59996, stateDir: tmp } as never) as unknown as {
      checkRestartRequest(): void; performGracefulRestart(r: string): Promise<boolean>;
    };
    const spy = vi.spyOn(s, 'performGracefulRestart').mockResolvedValue(true);
    return { s, spy };
  };
  it('three config restarts in a row all happen', () => {
    const { s, spy } = sup();
    for (let i = 0; i < 3; i++) {
      writeConnectRestartRequest(tmp, Date.now(), 1);
      s.checkRestartRequest();
    }
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0][0]).toBe(`restart requested by ${CONNECT_ENABLE_REQUESTED_BY}`);
    expect(fs.existsSync(path.join(tmp, 'state', 'restart-version-count.json'))).toBe(false);
  });
  it('a version-less flag from a writer that does not clear the count is not skipped either', () => {
    const { s, spy } = sup();
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(tmp, 'state', 'restart-requested.json'), JSON.stringify({ requestedBy: 'money-layer-enable', plannedRestart: true, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      s.checkRestartRequest();
    }
    expect(spy).toHaveBeenCalledTimes(3);
  });
  it('an UPDATE restart loop is still detected (third restart for one version skipped)', () => {
    const { s, spy } = sup();
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(tmp, 'state', 'restart-requested.json'), JSON.stringify({ requestedBy: 'auto-updater', targetVersion: '9.9.9', expiresAt: new Date(Date.now() + 60_000).toISOString() }));
      s.checkRestartRequest();
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('agent knowledge — the agent never asks its person for a restart', () => {
  type R = { upgraded: string[]; skipped: string[]; errors: string[] };
  const project = () => {
    const dir = path.join(tmp, 'agent');
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    return dir;
  };
  const migrate = (dir: string): R => {
    const r: R = { upgraded: [], skipped: [], errors: [] };
    (new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test' }) as unknown as { migrateClaudeMd(r: R): void }).migrateClaudeMd(r);
    return r;
  };
  // Step 1 exactly as #2233 shipped it.
  const OLD_STEP1 = "1. **Make sure I can pair.** `curl -s -H \"Authorization: Bearer $AUTH\" http://localhost:4042/threadline/pairing`. A 200 means I'm ready. A 503 means my agent network or pairing is switched off on this agent, so I switch both on myself: `threadline.relayEnabled` and `threadline.verifiedPairing.enabled` set to `true` in `.instar/config.json`, leaving the other keys in those blocks alone (`threadline_relay` `action: \"enable\"` sets the first one). They take effect when my server restarts, and I can't restart my own server from inside a conversation, so I say one sentence: \"I've switched on my connection to other agents. Send /lifeline restart here and I'll be ready in about a minute.\" Nothing else is asked of my person.";

  it('a new agent: the section switches pairing on through the route and never mentions /lifeline restart', () => {
    const sec = agentConnectSection(4042);
    expect(sec).toContain('/threadline/pairing/enable');
    expect(sec).toContain('$INSTAR_SESSION_ID');
    expect(sec).not.toContain('/lifeline restart');
    expect(sec).toContain("I never ask my person to restart anything or change a setting.");
    const md = generateClaudeMd('test', 'agent', 4042, true);
    expect(md).not.toContain(AGENT_CONNECT_STEP1_RESTART_ASK_MARKER);
  });

  it('an agent that got the section from #2233: step 1 is replaced in place, once', () => {
    const dir = project();
    const oldSection = agentConnectSection(4042).replace(agentConnectStep1(4042), OLD_STEP1);
    expect(oldSection).toContain(AGENT_CONNECT_STEP1_RESTART_ASK_MARKER);
    const before = `# CLAUDE.md\n\n## Threadline\n\n${oldSection}\n### MCP Tools Available\n\n- \`threadline_send\` — x\n`;
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), before);
    const r1 = migrate(dir);
    expect(r1.upgraded).toContain('CLAUDE.md: "Connecting to another agent" step 1 no longer asks the person for a restart');
    const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    expect(after).not.toContain('/lifeline restart');
    // The section is now byte-identical to a new agent's.
    expect(after).toContain(agentConnectSection(4042));
    expect(after.split(AGENT_CONNECT_HEADING).length - 1).toBe(1);
    const r2 = migrate(dir);
    expect(r2.skipped).toContain('CLAUDE.md: "Connecting to another agent" step 1 already current');
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe(after);
  });

  it('a step 1 the agent rewrote itself is left alone', () => {
    const dir = project();
    const own = agentConnectSection(4042).replace(agentConnectStep1(4042), '1. **Make sure I can pair.** My own words.');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# CLAUDE.md\n\n${own}`);
    migrate(dir);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toContain('1. **Make sure I can pair.** My own words.');
  });

  it('the old restart ask OUTSIDE this section is not touched (before it or under a later heading)', () => {
    const dir = project();
    const text = `# CLAUDE.md\n\n### Something else\n\n${OLD_STEP1}\n\n${agentConnectSection(4042)}\n### A later section\n\n${OLD_STEP1}\n`;
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), text);
    const r = migrate(dir);
    const after = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    expect(r.skipped).toContain('CLAUDE.md: "Connecting to another agent" step 1 already current');
    expect(after).toContain(`### Something else\n\n${OLD_STEP1}`);
    expect(after).toContain(`### A later section\n\n${OLD_STEP1}`);
  });

  it('a section whose step 1 the agent removed never borrows a later section\'s line', () => {
    const dir = project();
    const noStep1 = agentConnectSection(4042).replace(agentConnectStep1(4042) + '\n', '');
    expect(noStep1).not.toContain('1. **Make sure I can pair.**');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# CLAUDE.md\n\n${noStep1}\n### A later section\n\n${OLD_STEP1}\n`);
    migrate(dir);
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toContain(`### A later section\n\n${OLD_STEP1}`);
  });

  it('the self-knowledge node serves the WHOLE section, to its last line', async () => {
    const dir = project();
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# CLAUDE.md\n\n${agentConnectSection(4042)}\n### Next\n\nnot this\n`);
    const tree = new TreeGenerator().generate({ projectDir: dir, stateDir: path.join(dir, '.instar'), agentName: 'test', hasMemory: true, hasJobs: true, hasDecisionJournal: true });
    const node = tree.layers.flatMap((l) => l.children).find((n) => n.id === 'capabilities.agent_connect')!;
    const traversal = new TreeTraversal({ projectDir: dir, stateDir: path.join(dir, '.instar'), probeRegistry: new ProbeRegistry() });
    const { fragments, errors } = await traversal.gather([node], { capabilities: 1 });
    expect(errors).toEqual([]);
    const content = fragments.map((f) => f.content).join('\n');
    expect(content).toContain('/threadline/pairing/enable');
    expect(content).toContain('**Finish pairing**');
    expect(content).toContain('Spec: `docs/specs/a2a-pairing-invite-link.md`.');
  });
});
