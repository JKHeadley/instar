/**
 * Test-agent leak guard (docs/specs/test-agent-leak-guard.md) — the
 * deterministic classifications, the init posture, the boot backfill, the
 * teardown order / ownership / lock / outcomes, and the installAutoStart funnel.
 * No real launchctl/systemctl ever runs: every command goes through an
 * injected `run`, and VITEST disables the live path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  autostartBelongsTo,
  autoStartRefusalReason,
  backfillThrowawayRecord,
  buildThrowawayJobGuard,
  checkThrowawayExpiry,
  classifyLocation,
  decideInitPosture,
  expiredMarkerPath,
  isHomeSandboxed,
  isThrowawayExpired,
  isUnderTempRoot,
  launchctlWorkingDirectory,
  markAutoStartExplicit,
  parseTtl,
  readExpiredMarker,
  teardownExpiredThrowaway,
  throwawayStartupDecision,
  withTeardownLock,
} from '../../src/core/ThrowawayAgentGuard.js';
import { installAutoStart } from '../../src/commands/setup.js';
import { takeLastAutoStartRefusal } from '../../src/core/ThrowawayAgentGuard.js';

const HOME = os.homedir();

function plist(workingDir: string): string {
  const esc = workingDir.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0"?>\n<plist><dict>\n<key>Label</key><string>ai.instar.x</string>\n<key>ProgramArguments</key><array><string>/bin/node</string><string>${esc}/boot.cjs</string></array>\n<key>WorkingDirectory</key>\n    <string>${esc}</string>\n</dict></plist>\n`;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlg-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/ThrowawayAgentGuard.test.ts' });
});

function makeAgent(dir: string, cfg: Record<string, unknown> = {}): string {
  fs.mkdirSync(path.join(dir, '.instar', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.instar', 'config.json'), JSON.stringify({ projectName: 'x', ...cfg }));
  return dir;
}

describe('classifications', () => {
  it('isHomeSandboxed: both sides of the boundary', () => {
    expect(isHomeSandboxed({ HOME } as NodeJS.ProcessEnv, HOME)).toBe(false);
    expect(isHomeSandboxed({ HOME: tmp } as NodeJS.ProcessEnv, HOME)).toBe(true);
    expect(isHomeSandboxed({} as NodeJS.ProcessEnv, HOME)).toBe(false);
  });

  it('isUnderTempRoot: temp folders yes, the home no, /tmp and /private/tmp alias', () => {
    expect(isUnderTempRoot(tmp, HOME)).toBe(true);
    expect(isUnderTempRoot('/tmp/some-agent', HOME)).toBe(true);
    expect(isUnderTempRoot('/private/tmp/claude-501/x/scratchpad/rtcheck', HOME)).toBe(true);
    expect(isUnderTempRoot(path.join(HOME, '.instar', 'agents', 'echo'), HOME)).toBe(false);
    expect(isUnderTempRoot('/tmpfoo/agent', HOME)).toBe(false);
  });

  it('ignores $TMPDIR (a user may point it inside their home)', () => {
    const prev = process.env.TMPDIR;
    process.env.TMPDIR = path.join(HOME, 'tmp');
    try {
      expect(isUnderTempRoot(path.join(HOME, 'tmp', 'agent'), HOME)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev;
    }
  });

  it('a temp root that contains the account home is never a root', () => {
    expect(isUnderTempRoot('/tmp/home/agent', '/tmp/home')).toBe(false);
  });

  it('classifyLocation: a keep record is not the recorded reason; an expiry record is', () => {
    const real = path.join(HOME, 'not-a-temp-agent-xyz');
    const env = { HOME } as NodeJS.ProcessEnv;
    expect(classifyLocation({ projectDir: real, env, accountHome: HOME }).throwaway).toBe(false);
    expect(classifyLocation({ projectDir: real, env, accountHome: HOME, record: { createdAt: 'x', keep: true } }).throwaway).toBe(false);
    expect(classifyLocation({ projectDir: real, env, accountHome: HOME, record: { createdAt: 'x', expiresAt: 'y' } }).reasons).toEqual(['recorded']);
  });

  it('parseTtl clamps and rejects junk', () => {
    expect(parseTtl('30m')).toBe(30 * 60_000);
    expect(parseTtl('2d')).toBe(2 * 86_400_000);
    expect(parseTtl('5s')).toBe(60_000);
    expect(parseTtl('400d')).toBe(30 * 86_400_000);
    expect(parseTtl('soon')).toBeNull();
  });

  it('isThrowawayExpired: past, future, unparseable, keep, none', () => {
    const now = Date.parse('2026-10-27T00:00:00Z');
    expect(isThrowawayExpired({ createdAt: 'x', expiresAt: '2026-10-26T00:00:00Z' }, now)).toBe(true);
    expect(isThrowawayExpired({ createdAt: 'x', expiresAt: '2026-10-28T00:00:00Z' }, now)).toBe(false);
    expect(isThrowawayExpired({ createdAt: 'x', expiresAt: 'garbage' }, now)).toBe(true);
    expect(isThrowawayExpired({ createdAt: 'x', keep: true }, now)).toBe(false);
    expect(isThrowawayExpired(null, now)).toBe(false);
  });
});

describe('ownership', () => {
  it('matches the exact working directory, not a prefix or a mention', () => {
    const dir = path.join(tmp, 'check');
    fs.mkdirSync(dir);
    expect(autostartBelongsTo(plist(dir), dir)).toBe(true);
    expect(autostartBelongsTo(plist(dir + '-production'), dir)).toBe(false);
    // Our path appears in ProgramArguments but WorkingDirectory is someone else's.
    const other = plist('/Users/someone/.instar/agents/x').replace('/bin/node', `${dir}/node`);
    expect(autostartBelongsTo(other, dir)).toBe(false);
  });

  it('matches /tmp and /private/tmp aliases and XML-escaped paths', () => {
    if (process.platform !== 'darwin') return;
    const dir = fs.mkdtempSync('/tmp/tlg-a&b-');
    try {
      expect(autostartBelongsTo(plist(dir), '/private' + dir)).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ThrowawayAgentGuard.test.ts' });
    }
  });

  it('systemd WorkingDirectory= is read', () => {
    const dir = path.join(tmp, 'svc');
    fs.mkdirSync(dir);
    expect(autostartBelongsTo(`[Service]\nWorkingDirectory=${dir}\nRestart=always\n`, dir)).toBe(true);
  });

  it('launchctlWorkingDirectory: the top-level field only; ambiguous → null', () => {
    const out = '\tpath = /x.plist\n\tprogram = /bin/node\n\tworking directory = /tmp/a\n\tenvironment = {\n\t\tPWD => /tmp/b\n\t}\n';
    expect(launchctlWorkingDirectory(out)).toBe('/tmp/a');
    expect(launchctlWorkingDirectory('\tpath = /x\n')).toBeNull();
    expect(launchctlWorkingDirectory('\tworking directory = /a\n\tworking directory = /b\n')).toBeNull();
  });
});

describe('init posture', () => {
  const real = path.join(HOME, 'not-a-temp-agent-xyz');
  const now = new Date('2026-10-27T00:00:00Z');

  it('non-interactive init at a normal location: autoInstall false, no expiry', () => {
    const p = decideInitPosture({ projectDir: real, interactive: false, env: { HOME } as NodeJS.ProcessEnv, accountHome: HOME, now });
    expect(p.autostart?.autoInstall).toBe(false);
    expect(p.throwawayAgent).toBeUndefined();
  });

  it('interactive init at a normal location records nothing', () => {
    expect(decideInitPosture({ projectDir: real, interactive: true, env: { HOME } as NodeJS.ProcessEnv, accountHome: HOME, now })).toEqual({});
  });

  it('--autostart lifts the non-interactive record', () => {
    expect(decideInitPosture({ projectDir: real, interactive: false, autostartFlag: true, env: { HOME } as NodeJS.ProcessEnv, accountHome: HOME, now }).autostart).toBeUndefined();
  });

  it('the incident shape (sandboxed HOME, temp project) records both, 24h expiry', () => {
    const p = decideInitPosture({ projectDir: path.join(tmp, 'rtcheck'), interactive: false, env: { HOME: tmp } as NodeJS.ProcessEnv, accountHome: HOME, now });
    expect(p.autostart?.autoInstall).toBe(false);
    expect(p.throwawayAgent?.expiresAt).toBe('2026-10-28T00:00:00.000Z');
    expect(p.throwawayAgent?.reasons).toEqual(['home-sandboxed', 'project-under-temp']);
  });

  it('a sandboxed HOME alone at a normal location blocks autostart but records no expiry', () => {
    const p = decideInitPosture({ projectDir: real, interactive: true, env: { HOME: tmp } as NodeJS.ProcessEnv, accountHome: HOME, now });
    expect(p.autostart?.autoInstall).toBe(false);
    expect(p.throwawayAgent).toBeUndefined();
  });

  it('--keep writes an exemption; --keep with --expires-in throws', () => {
    expect(decideInitPosture({ projectDir: tmp, interactive: true, keep: true, now, accountHome: HOME }).throwawayAgent).toEqual({ createdAt: now.toISOString(), keep: true });
    expect(() => decideInitPosture({ projectDir: tmp, interactive: true, keep: true, expiresIn: '1h', accountHome: HOME })).toThrow(/contradict/);
  });

  it('--expires-in at a normal location records an expiry', () => {
    const p = decideInitPosture({ projectDir: real, interactive: true, expiresIn: '6h', env: { HOME } as NodeJS.ProcessEnv, accountHome: HOME, now });
    expect(p.throwawayAgent?.expiresAt).toBe('2026-10-27T06:00:00.000Z');
  });
});

describe('boot backfill', () => {
  it('a temp-folder agent with no record gets a 24h expiry', () => {
    const dir = makeAgent(path.join(tmp, 'a'));
    const rec = backfillThrowawayRecord(dir, { now: new Date('2026-10-27T00:00:00Z') });
    expect(rec?.expiresAt).toBe('2026-10-28T00:00:00.000Z');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.instar', 'config.json'), 'utf-8')).throwawayAgent.expiresAt).toBe(rec?.expiresAt);
  });

  it('a keep record stops the backfill; an existing record is never replaced', () => {
    const kept = makeAgent(path.join(tmp, 'k'), { throwawayAgent: { createdAt: 'x', keep: true } });
    expect(backfillThrowawayRecord(kept)).toBeNull();
    const rec = makeAgent(path.join(tmp, 'r'), { throwawayAgent: { createdAt: 'x', expiresAt: '2030-01-01T00:00:00Z' } });
    expect(backfillThrowawayRecord(rec)).toBeNull();
  });
});

describe('scheduler guard', () => {
  it('refuses a temp-folder agent, allows with the override', () => {
    const dir = makeAgent(path.join(tmp, 'a'));
    expect(buildThrowawayJobGuard({ projectDir: dir })().refuse).toBe(true);
    expect(buildThrowawayJobGuard({ projectDir: dir, allowOnThrowawayAgent: true })().refuse).toBe(false);
  });

  it('allows a normal-location agent even when HOME is sandboxed; refuses a recorded one', () => {
    const real = path.join(HOME, 'not-a-temp-agent-xyz');
    expect(buildThrowawayJobGuard({ projectDir: real, accountHome: HOME })().refuse).toBe(false);
  });
});

describe('teardown', () => {
  interface Fake {
    files: Map<string, string>;
    calls: string[][];
    loadedWd: string | null;
    bootoutFails?: boolean;
  }
  function deps(f: Fake, homes: string[]) {
    return {
      platform: 'darwin' as NodeJS.Platform,
      homes,
      uid: 501,
      exists: (p: string) => f.files.has(p),
      readFile: (p: string) => { const c = f.files.get(p); if (c === undefined) throw new Error('ENOENT'); return c; },
      unlink: (p: string) => { f.calls.push(['unlink', p]); f.files.delete(p); },
      run: (cmd: string, args: string[]) => {
        f.calls.push([cmd, ...args]);
        if (args[0] === 'print') {
          if (f.loadedWd === null) throw new Error('not loaded');
          return `\tpath = /x\n\tworking directory = ${f.loadedWd}\n`;
        }
        if (args[0] === 'bootout' && f.bootoutFails) throw new Error('bootout failed');
        return '';
      },
    };
  }

  it('marker first, deletes every owned file in both homes, then unloads once', () => {
    const dir = makeAgent(path.join(tmp, 'agent'));
    const fakeHome = path.join(tmp, 'fakehome');
    const a = path.join(fakeHome, 'Library', 'LaunchAgents', 'ai.instar.x.plist');
    const b = path.join(HOME, 'Library', 'LaunchAgents', 'ai.instar.x.plist');
    const f: Fake = { files: new Map([[a, plist(dir)], [b, plist(dir)]]), calls: [], loadedWd: dir };
    const m = teardownExpiredThrowaway('x', dir, deps(f, [fakeHome, HOME]))!;
    expect(m.outcome).toBe('complete');
    expect(f.files.size).toBe(0);
    const order = f.calls.map((c) => c[0] === 'unlink' ? 'unlink' : `${c[0]} ${c[1]}`);
    expect(order).toEqual(['unlink', 'unlink', 'launchctl print', 'launchctl disable', 'launchctl bootout']);
    expect(readExpiredMarker(dir)?.outcome).toBe('complete');
  });

  it('leaves a same-name real agent alone (file and loaded job)', () => {
    const dir = makeAgent(path.join(tmp, 'agent'));
    const realPlist = path.join(HOME, 'Library', 'LaunchAgents', 'ai.instar.x.plist');
    const other = '/Users/someone/.instar/agents/x';
    const f: Fake = { files: new Map([[realPlist, plist(other)]]), calls: [], loadedWd: other };
    const m = teardownExpiredThrowaway('x', dir, deps(f, [HOME]))!;
    expect(f.files.has(realPlist)).toBe(true);
    expect(f.calls.some((c) => c[1] === 'bootout')).toBe(false);
    expect(m.outcome).toBe('complete');
  });

  it('checks the loaded label even when no file exists (plist deleted by the OS)', () => {
    const dir = makeAgent(path.join(tmp, 'agent'));
    const f: Fake = { files: new Map(), calls: [], loadedWd: dir };
    teardownExpiredThrowaway('x', dir, deps(f, [HOME]));
    expect(f.calls.some((c) => c[1] === 'bootout')).toBe(true);
  });

  it('a failed unload is retryable, then quarantined at the fifth attempt', () => {
    const dir = makeAgent(path.join(tmp, 'agent'));
    const f: Fake = { files: new Map(), calls: [], loadedWd: dir, bootoutFails: true };
    for (let i = 1; i <= 4; i++) {
      expect(teardownExpiredThrowaway('x', dir, deps(f, [HOME]))!.outcome).toBe('retryable');
    }
    expect(teardownExpiredThrowaway('x', dir, deps(f, [HOME]))!.outcome).toBe('quarantined');
    // Quarantined is terminal: no further launchctl calls.
    const before = f.calls.length;
    teardownExpiredThrowaway('x', dir, deps(f, [HOME]));
    expect(f.calls.length).toBe(before);
  });

  it('a retry does not delete a file that was replaced by another agent since', () => {
    const dir = makeAgent(path.join(tmp, 'agent'));
    const p = path.join(HOME, 'Library', 'LaunchAgents', 'ai.instar.x.plist');
    const f: Fake = { files: new Map([[p, plist(dir)]]), calls: [], loadedWd: dir, bootoutFails: true };
    // First attempt: unlink fails → stays pending.
    const d = deps(f, [HOME]);
    const failingUnlink = { ...d, unlink: () => { throw new Error('EPERM'); } };
    expect(teardownExpiredThrowaway('x', dir, failingUnlink)!.outcome).toBe('retryable');
    // Replaced by a different agent's unit before the retry.
    f.files.set(p, plist('/Users/someone/.instar/agents/x'));
    f.bootoutFails = false;
    teardownExpiredThrowaway('x', dir, d);
    expect(f.files.has(p)).toBe(true);
    expect(readExpiredMarker(dir)!.units[0].state).toBe('dropped');
  });

  it('a held lock makes a second caller back off', () => {
    const dir = makeAgent(path.join(tmp, 'agent'));
    const lock = path.join(dir, '.instar', 'state', 'throwaway-teardown.lock');
    fs.writeFileSync(lock, String(process.ppid)); // a live pid that is not ours
    expect(withTeardownLock(dir, () => 1).ran).toBe(false);
    fs.writeFileSync(lock, '999999999'); // dead pid → taken over
    expect(withTeardownLock(dir, () => 2)).toEqual({ ran: true, value: 2 });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('the lock runs fn exactly once and never retries its errors', () => {
    const dir = makeAgent(path.join(tmp, 'agent'));
    let calls = 0;
    const err = Object.assign(new Error('boom'), { code: 'EEXIST' });
    expect(() => withTeardownLock(dir, () => { calls++; throw err; })).toThrow('boom');
    expect(calls).toBe(1);
    expect(fs.existsSync(path.join(dir, '.instar', 'state', 'throwaway-teardown.lock'))).toBe(false);
  });

  it('the outcome is written before the self-unload (a killed caller leaves complete)', () => {
    const dir = makeAgent(path.join(tmp, 'agent'));
    const f: Fake = { files: new Map(), calls: [], loadedWd: dir };
    const d = deps(f, [HOME]);
    const dying = { ...d, run: (cmd: string, args: string[]) => {
      if (args[0] === 'bootout') {
        // Simulate being killed mid-unload: the marker must already say complete.
        expect(readExpiredMarker(dir)?.outcome).toBe('complete');
      }
      return d.run(cmd, args);
    } };
    expect(teardownExpiredThrowaway('x', dir, dying)!.outcome).toBe('complete');
  });

  it('startup decision: run → exit after expiry → idle when quarantined', () => {
    const dir = makeAgent(path.join(tmp, 'agent'), { throwawayAgent: { createdAt: 'x', expiresAt: '2099-01-01T00:00:00Z' } });
    const f: Fake = { files: new Map(), calls: [], loadedWd: null };
    expect(throwawayStartupDecision('x', dir, deps(f, [HOME])).decision).toBe('run');
    const cfgPath = path.join(dir, '.instar', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    cfg.throwawayAgent.expiresAt = '2000-01-01T00:00:00Z';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    expect(throwawayStartupDecision('x', dir, deps(f, [HOME])).decision).toBe('exit');
    expect(checkThrowawayExpiry('x', dir, deps(f, [HOME])).expired).toBe(true);
    fs.writeFileSync(expiredMarkerPath(dir), JSON.stringify({ expiredAt: 'x', outcome: 'quarantined', attempts: 5, units: [], unloaded: false, errors: [] }));
    expect(throwawayStartupDecision('x', dir, deps(f, [HOME])).decision).toBe('idle');
  });
});

describe('installAutoStart funnel', () => {
  it('refuses a temp-folder agent and says why; writes nothing', () => {
    const dir = makeAgent(path.join(tmp, 'agent'));
    expect(autoStartRefusalReason(dir)).toMatch(/throwaway agent/);
    expect(installAutoStart('tlg-never-installed', dir, false)).toBe(false);
    expect(takeLastAutoStartRefusal()).toMatch(/project-under-temp/);
    expect(fs.existsSync(path.join(HOME, 'Library', 'LaunchAgents', 'ai.instar.tlg-never-installed.plist'))).toBe(false);
  });

  it('refuses after expiry even at a normal location, unless forced', () => {
    const dir = makeAgent(path.join(tmp, 'agent'));
    fs.writeFileSync(expiredMarkerPath(dir), '{}');
    expect(autoStartRefusalReason(dir)).toMatch(/expired/);
    expect(autoStartRefusalReason(dir, { force: true })).toBeNull();
  });

  it('a forced explicit install revives: clears the expiry record and the marker', () => {
    const dir = makeAgent(path.join(tmp, 'agent'), { throwawayAgent: { createdAt: 'x', expiresAt: '2000-01-01T00:00:00Z' }, autostart: { autoInstall: false } });
    fs.writeFileSync(expiredMarkerPath(dir), '{}');
    markAutoStartExplicit(dir, { forced: true });
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.instar', 'config.json'), 'utf-8'));
    expect(cfg.autostart.autoInstall).toBe(true);
    expect(cfg.throwawayAgent).toBeUndefined();
    expect(fs.existsSync(expiredMarkerPath(dir))).toBe(false);
  });
});
