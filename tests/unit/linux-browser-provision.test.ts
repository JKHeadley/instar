/** Who gets the boot install, and what it does on each machine. Spec: docs/specs/normal-chrome-linux.md. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type MachineFacts, CHROME_UPGRADE_INTERVAL_MS, decideProvision, deriveBrowserState, machineBlocker, MAX_INSTALL_ATTEMPTS, markBrowserAutoInstall,
  provisionLinuxBrowser, retryDelayMs, wantsAutoInstall,
} from '../../src/core/linuxBrowserProvision.js';
import { markNewAgent } from '../../src/recommended/offerPrerequisites.js';

const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\n';
const good: MachineFacts = { platform: 'linux', wsl: false, arch: 'x64', osRelease: UBUNTU, hasApt: true, sudoWorks: true, freeBytes: 10 * 1024 ** 3 };
const NOW = 1_800_000_000_000;

let stateDir: string;
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lbp-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'test-cleanup' }); });

describe('who gets it', () => {
  it('a new agent does, through markNewAgent', () => {
    markNewAgent(stateDir);
    expect(wantsAutoInstall(stateDir, undefined, false)).toBe(true);
  });

  it('an agent that already has newAgentAt can never gain it, so an update installs nothing', () => {
    const folder = path.join(stateDir, 'state', 'offer-prerequisites');
    markNewAgent(stateDir);
    SafeFsExecutor.safeRmSync(path.join(stateDir, 'state', 'xdrive'), { recursive: true, operation: 'test-cleanup' });
    markNewAgent(stateDir);
    expect(fs.existsSync(path.join(stateDir, 'state', 'xdrive', 'auto-install.json'))).toBe(false);
    expect(wantsAutoInstall(stateDir, undefined, false)).toBe(false);
    expect(folder).toBeTruthy();
  });

  it('an explicit value wins both ways, and a throwaway agent never installs', () => {
    markBrowserAutoInstall(stateDir);
    expect(wantsAutoInstall(stateDir, false, false)).toBe(false);
    expect(wantsAutoInstall(stateDir, undefined, true)).toBe(false);
    expect(wantsAutoInstall(stateDir, true, true)).toBe(false);
    expect(wantsAutoInstall(fs.mkdtempSync(path.join(os.tmpdir(), 'lbp-')), true, false)).toBe(true);
  });
});

describe('which machines', () => {
  it('accepts the measured machine', () => expect(machineBlocker(good)).toBeNull());

  it.each([
    ['arm64', { arch: 'arm64' }, /^arch/],
    ['another version', { osRelease: 'ID=ubuntu\nVERSION_ID="22.04"\n' }, /^os/],
    ['another OS', { osRelease: 'ID=arch\n' }, /^os/],
    ['no apt', { hasApt: false }, /^os/],
    ['no sudo', { sudoWorks: false }, /^sudo/],
    ['low disk', { freeBytes: 1024 }, /^disk/],
  ])('names the reason on %s', (_name, change, reason) => {
    expect(machineBlocker({ ...good, ...change })).toMatch(reason);
  });
});

describe('deciding', () => {
  const base = { wanted: true, depsPresent: false, bindings: 0, facts: good, record: null, backoff: null, now: NOW };

  it('does nothing off Linux or when not wanted', () => {
    expect(decideProvision({ ...base, facts: { ...good, platform: 'darwin' } }).action).toBe('none');
    expect(decideProvision({ ...base, wanted: false }).action).toBe('none');
  });

  it('installs when wanted and missing, and skips with the reason on a machine it cannot serve', () => {
    expect(decideProvision(base).action).toBe('install');
    expect(decideProvision({ ...base, facts: { ...good, sudoWorks: false } })).toEqual({ action: 'skip', reason: expect.stringMatching(/^sudo/) });
  });

  it('waits 1 h, 6 h, then 24 h between attempts, and an operator yes bypasses that', () => {
    expect([1, 2, 3, 9].map(retryDelayMs)).toEqual([3_600_000, 21_600_000, 86_400_000, 86_400_000]);
    const waiting = { ...base, backoff: { attempts: 1, lastAt: NOW - 1000 } };
    expect(decideProvision(waiting)).toEqual({ action: 'none', reason: 'waiting to retry' });
    expect(decideProvision({ ...waiting, bypassBackoff: true }).action).toBe('install');
    expect(decideProvision({ ...base, backoff: { attempts: 1, lastAt: NOW - 3_600_001 } }).action).toBe('install');
  });

  it('stops for good after six attempts, until an operator says yes', () => {
    const spent = { ...base, backoff: { attempts: MAX_INSTALL_ATTEMPTS, lastAt: 0 } };
    expect(decideProvision(spent)).toEqual({ action: 'none', reason: 'stopped retrying' });
    expect(decideProvision({ ...spent, bypassBackoff: true }).action).toBe('install');
  });

  it('upgrades Chrome at most daily and never under a live binding', () => {
    const ready = { ...base, depsPresent: true };
    expect(decideProvision(ready).action).toBe('upgrade');
    expect(decideProvision({ ...ready, bindings: 1 })).toEqual({ action: 'none', reason: 'ready' });
    const recent = new Date(NOW - 1000).toISOString();
    expect(decideProvision({ ...ready, record: { upgradedAt: recent } })).toEqual({ action: 'none', reason: 'ready' });
    const old = new Date(NOW - CHROME_UPGRADE_INTERVAL_MS - 1).toISOString();
    expect(decideProvision({ ...ready, record: { upgradedAt: old } }).action).toBe('upgrade');
  });
});

describe('one boot', () => {
  const run = (overrides = {}) => {
    const started: string[] = [];
    const promise = provisionLinuxBrowser({
      stateDir, projectDir: stateDir, configured: true, throwaway: false, now: () => NOW,
      readFacts: async () => good, depsPresent: async () => false, startRunner: (mode) => started.push(mode), ...overrides,
    });
    return { started, promise };
  };
  const record = () => JSON.parse(fs.readFileSync(path.join(stateDir, 'state/xdrive/provision.json'), 'utf8'));

  it('starts the runner once and counts the attempt, so a restart does not start another', async () => {
    const first = run();
    await first.promise;
    expect(first.started).toEqual(['install']);
    const second = run();
    expect(await second.promise).toEqual({ action: 'none', reason: 'waiting to retry' });
    expect(second.started).toEqual([]);
  });

  it('records an upgrade before starting it, so a runner that cannot start still waits a day', async () => {
    const first = run({ depsPresent: async () => true });
    expect((await first.promise).action).toBe('upgrade');
    expect(first.started).toEqual(['upgrade']);
    const second = run({ depsPresent: async () => true });
    expect(await second.promise).toEqual({ action: 'none', reason: 'ready' });
    expect(second.started).toEqual([]);
  });

  it('records a skip with its reason and runs nothing', async () => {
    const { started, promise } = run({ readFacts: async () => ({ ...good, sudoWorks: false }) });
    await promise;
    expect(started).toEqual([]);
    expect(record().status).toMatch(/^skipped: sudo/);
  });

  it('records ready and clears the backoff once everything is present', async () => {
    fs.mkdirSync(path.join(stateDir, 'state/xdrive'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state/xdrive/provision.json'), JSON.stringify({ upgradedAt: new Date(NOW).toISOString() }));
    fs.writeFileSync(path.join(stateDir, 'state/xdrive/provision-backoff.json'), '{"attempts":2,"lastAt":1}');
    await run({ depsPresent: async () => true }).promise;
    expect(record().status).toBe('ready');
    expect(fs.existsSync(path.join(stateDir, 'state/xdrive/provision-backoff.json'))).toBe(false);
  });

  it('writes nothing off Linux', async () => {
    await run({ readFacts: async () => ({ ...good, platform: 'darwin' }) }).promise;
    expect(fs.existsSync(path.join(stateDir, 'state/xdrive'))).toBe(false);
  });

  it('runs no probe at all on an agent that has not asked for this', async () => {
    let probed = false;
    const { started, promise } = run({ configured: undefined, readFacts: async () => { probed = true; return good; } });
    expect(await promise).toEqual({ action: 'none', reason: 'not wanted on this agent' });
    expect(probed).toBe(false);
    expect(started).toEqual([]);
  });

  it('leaves a WSL host alone, so Chrome is not reinstalled every day', async () => {
    const { started, promise } = run({ readFacts: async () => ({ ...good, wsl: true }) });
    expect((await promise).action).toBe('none');
    expect(started).toEqual([]);
    expect(decideProvision({ wanted: true, depsPresent: false, bindings: 0, facts: { ...good, wsl: true }, record: null, backoff: null, now: NOW }).action).toBe('none');
  });

  it('never throws', async () => {
    const { promise } = run({ readFacts: async () => { throw new Error('boom'); } });
    await expect(promise).resolves.toEqual({ action: 'none', reason: 'check failed' });
  });
});

describe('the browser state an agent reads', () => {
  const derive = (over: object) => deriveBrowserState({ platform: 'linux', wsl: false, record: null, driverPresent: false, ...over });

  it('has a named state and a next step on every path, and never says there is no browser', () => {
    const cases = [
      derive({ platform: 'darwin' }), derive({ wsl: true }), derive({}), derive({ driverPresent: true }),
      derive({ record: { status: 'installing' } }), derive({ record: { status: 'failed: key' } }),
      derive({ record: { status: 'ready' } }), derive({ record: { status: 'skipped: sudo: this user has no passwordless sudo' } }),
    ];
    for (const answer of cases) {
      expect(['ready', 'installing', 'not-built', 'broken']).toContain(answer.state);
      expect(answer.nextStep.length).toBeGreaterThan(0);
      expect(JSON.stringify(answer).toLowerCase()).not.toMatch(/no browser|browserless/);
    }
  });

  it('tells not-built from broken', () => {
    expect(derive({}).state).toBe('not-built');
    expect(derive({ record: { status: 'skipped: arch: x' } })).toMatchObject({ state: 'not-built', reason: 'arch: x' });
    expect(derive({ record: { status: 'failed: install' } })).toMatchObject({ state: 'broken', reason: 'failed: install' });
    expect(derive({ record: { status: 'ready' } }).state).toBe('broken');
    expect(derive({ record: { status: 'ready' }, driverPresent: true }).state).toBe('ready');
  });

  it('gives the install route for both states the agent can act on', () => {
    expect(derive({}).nextStep).toContain('POST /browser/linux/install');
    expect(derive({ record: { status: 'failed: key' } }).nextStep).toContain('POST /browser/linux/install');
  });
});
