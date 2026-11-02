import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopSetupRefused, DesktopSetupTarget, type DesktopSetupTargetDeps } from '../../src/core/DesktopSetupTarget.js';
import { parsePeerDesktopSetup } from '../../src/server/desktopSetupRoutes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const FRONT = `m_${'a'.repeat(32)}`;
const OTHER = `m_${'b'.repeat(32)}`;

describe('DesktopSetupTarget', () => {
  let dir: string;
  let clock = 1_000_000;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-setup-target-'));
    fs.mkdirSync(path.join(dir, 'state'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ authToken: 'keep', remoteDesktop: { extra: 1 } }));
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop-setup-target test cleanup' }));

  function make(over: Partial<DesktopSetupTargetDeps> = {}) {
    const openUrl = vi.fn(async () => {});
    const requestRestart = vi.fn(() => true);
    const requestPermission = vi.fn(async () => ({}));
    const onPeerEnable = vi.fn(async () => {});
    const deps: DesktopSetupTargetDeps = { stateDir: dir, platform: 'darwin', config: {}, configuredAtBoot: false,
      diagnostics: async () => ({ sessionActive: true, screenLocked: false, status: 'not-ready' }),
      requestPermission, requestRestart, helperPath: () => '/x/instar-desktop-host', onPeerEnable, endLiveAccess: vi.fn(), peerClaimAllowed: true, openUrl, now: () => clock, ...over };
    return { target: new DesktopSetupTarget(deps), openUrl, requestRestart, requestPermission, onPeerEnable, deps };
  }
  const file = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  const audit = () => fs.readFileSync(path.join(dir, 'logs', 'desktop-setup.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

  it('turns on, keeps every sibling, updates the live config, restarts, and audits', async () => {
    const { target, requestRestart, deps } = make();
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, null)).resolves.toEqual({ restartRequested: true });
    expect(file()).toMatchObject({ authToken: 'keep', remoteDesktop: { extra: 1, enabled: true, frontMachineId: FRONT } });
    expect(deps.config.remoteDesktop).toMatchObject({ enabled: true, frontMachineId: FRONT });
    expect(requestRestart).toHaveBeenCalledOnce();
    expect(audit().map(row => row.action)).toEqual(['turn-on', 'restart']);
  });

  it('is a no-op when already running that config', async () => {
    const { target, requestRestart } = make({ config: { remoteDesktop: { enabled: true, frontMachineId: FRONT } }, configuredAtBoot: true });
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, null)).resolves.toMatchObject({ alreadyOn: true });
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('restarts without rewriting when the config is on but this process started without it', async () => {
    const { target, requestRestart, onPeerEnable } = make({ config: { remoteDesktop: { enabled: true, frontMachineId: FRONT } } });
    await target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT);
    expect(requestRestart).toHaveBeenCalledOnce();
    expect(onPeerEnable).not.toHaveBeenCalled();
  });

  it('notifies once when a peer claims it', async () => {
    const { target, onPeerEnable } = make();
    await target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT);
    expect(onPeerEnable).toHaveBeenCalledWith(FRONT);
    expect(audit()[0]).toMatchObject({ action: 'claim', sender: FRONT });
  });

  it('makes no change when a peer claim cannot be recorded', async () => {
    fs.mkdirSync(path.join(dir, 'logs'));
    fs.chmodSync(path.join(dir, 'logs'), 0o500);
    const { target, requestRestart } = make();
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT)).rejects.toMatchObject({ code: 'audit-failed' });
    fs.chmodSync(path.join(dir, 'logs'), 0o700);
    expect(file().remoteDesktop.enabled).toBeUndefined();
    expect(requestRestart).not.toHaveBeenCalled();
  });

  it('still restarts, and says so, when the notice fails', async () => {
    const { target } = make({ onPeerEnable: async () => { throw new Error('telegram down'); } });
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT)).resolves.toEqual({ restartRequested: true, noticeFailed: true });
    expect(audit().some(row => row.action === 'notice' && row.outcome === 'failed')).toBe(true);
  });

  it('does not let a slow notice hold up the restart', async () => {
    const never = () => new Promise<void>(() => {});
    vi.useFakeTimers();
    try {
      const { target } = make({ onPeerEnable: never });
      const run = target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(run).resolves.toMatchObject({ restartRequested: true, noticeFailed: true });
    } finally { vi.useRealTimers(); }
  });

  it('turning off on the machine itself ends live access and sticks against peers', async () => {
    const endLiveAccess = vi.fn();
    const { target } = make({ endLiveAccess, config: { remoteDesktop: { enabled: true, frontMachineId: FRONT } } });
    await target.run({ action: 'turn-off' }, null);
    expect(endLiveAccess).toHaveBeenCalledOnce();
    clock += 60_001;
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT)).rejects.toMatchObject({ code: 'turned-off-here' });
    expect(file().remoteDesktop.enabled).toBe(false);
    await target.run({ action: 'turn-on', frontMachineId: FRONT }, null);
    expect(file().remoteDesktop).toMatchObject({ enabled: true, frontMachineId: FRONT });
    expect(file().remoteDesktop.peerClaimRefused).toBeUndefined();
  });

  it('a turn-off from the front leaves the front able to turn it on again', async () => {
    const { target } = make({ config: { remoteDesktop: { enabled: true, frontMachineId: FRONT } } });
    await target.run({ action: 'turn-off' }, FRONT);
    clock += 60_001;
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT)).resolves.toMatchObject({ restartRequested: true });
  });

  it('reserves the change before any wait, so a peer cannot overlap it', async () => {
    let release = () => {};
    const { target } = make({ onPeerEnable: () => new Promise<void>(resolve => { release = resolve; }) });
    const claim = target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT);
    await expect(target.run({ action: 'turn-off' }, FRONT)).rejects.toMatchObject({ code: 'wait' });
    release();
    await expect(claim).resolves.toMatchObject({ restartRequested: true });
    expect(file().remoteDesktop.enabled).toBe(true);
  });

  it('lets a local Turn off revoke a claim at once, inside the limit', async () => {
    const endLiveAccess = vi.fn();
    const { target } = make({ endLiveAccess });
    await target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT);
    await target.run({ action: 'turn-off' }, null);
    expect(endLiveAccess).toHaveBeenCalledOnce();
    expect(file().remoteDesktop).toMatchObject({ enabled: false, peerClaimRefused: true });
  });

  it('counts a missing notice channel as a failed notice', async () => {
    const { target } = make({ onPeerEnable: undefined });
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT)).resolves.toMatchObject({ noticeFailed: true });
  });

  it('a dark machine refuses a peer claim but keeps its own page', async () => {
    const { target } = make({ peerClaimAllowed: false });
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT)).rejects.toMatchObject({ code: 'setup-off' });
    expect(file().remoteDesktop.enabled).toBeUndefined();
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, null)).resolves.toMatchObject({ restartRequested: true });
  });

  it('ends live access even when the config cannot be written', async () => {
    const endLiveAccess = vi.fn();
    const { target } = make({ endLiveAccess, config: { remoteDesktop: { enabled: true, frontMachineId: FRONT } } });
    fs.writeFileSync(path.join(dir, 'config.json'), 'not json');
    await expect(target.run({ action: 'turn-off' }, null)).rejects.toThrow();
    expect(endLiveAccess).toHaveBeenCalledOnce();
  });

  it('refuses a sender claiming to act for a different front', async () => {
    const { target } = make();
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, OTHER)).rejects.toMatchObject({ code: 'front-mismatch' });
    expect(file().remoteDesktop.enabled).toBeUndefined();
  });

  it('refuses to move an existing front, reading the file not the memory', async () => {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ remoteDesktop: { frontMachineId: OTHER } }));
    const { target } = make();
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT)).rejects.toMatchObject({ code: 'other-front' });
    expect(file().remoteDesktop.frontMachineId).toBe(OTHER);
  });

  it('lets exactly one of two competing fronts win', async () => {
    const { target } = make();
    const [first, second] = await Promise.allSettled([
      target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT),
      target.run({ action: 'turn-on', frontMachineId: OTHER }, OTHER),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect(file().remoteDesktop.frontMachineId).toBe(FRONT);
  });

  it('refuses plain Linux but allows WSL', async () => {
    await expect(make({ platform: 'linux' }).target.run({ action: 'turn-on', frontMachineId: FRONT }, null))
      .rejects.toMatchObject({ code: 'not-supported' });
    await expect(make({ platform: 'linux', wsl: true }).target.run({ action: 'turn-on', frontMachineId: FRONT }, null))
      .resolves.toEqual({ restartRequested: true });
  });

  it('holds repeat restarts to one a minute', async () => {
    const { target } = make();
    await target.run({ action: 'turn-on', frontMachineId: FRONT }, FRONT);
    await expect(target.run({ action: 'turn-off' }, FRONT)).rejects.toMatchObject({ code: 'wait' });
    clock += 60_001;
    await expect(target.run({ action: 'turn-off' }, FRONT)).resolves.toBeTruthy();
  });

  it('reuses a restart already waiting on the supervisor', async () => {
    fs.writeFileSync(path.join(dir, 'state', 'restart-requested.json'), JSON.stringify({ expiresAt: new Date(clock + 60_000).toISOString() }));
    const { target, requestRestart } = make();
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, null)).resolves.toEqual({ restartRequested: true });
    expect(requestRestart).not.toHaveBeenCalled();
    await expect(target.status()).resolves.toMatchObject({ restartPending: true });
  });

  it('reports honestly when it cannot restart', async () => {
    const { target } = make({ requestRestart: () => false });
    await expect(target.run({ action: 'turn-on', frontMachineId: FRONT }, null)).rejects.toMatchObject({ code: 'restart-unavailable', httpStatus: 503 });
  });

  it('lets only the current front turn it off', async () => {
    const { target } = make({ config: { remoteDesktop: { enabled: true, frontMachineId: FRONT } } });
    await expect(target.run({ action: 'turn-off' }, OTHER)).rejects.toMatchObject({ code: 'front-mismatch' });
    await target.run({ action: 'turn-off' }, FRONT);
    expect(file().remoteDesktop.enabled).toBe(false);
  });

  it('refuses a prompt or the settings page on a locked Mac', async () => {
    const { target, requestPermission, openUrl } = make({ diagnostics: async () => ({ sessionActive: false, screenLocked: true }) });
    await expect(target.run({ action: 'show-prompt' }, null)).rejects.toMatchObject({ code: 'locked' });
    await expect(target.run({ action: 'open-settings', pane: 'screen' }, null)).rejects.toMatchObject({ code: 'locked' });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('refuses a prompt without positive evidence of a session', async () => {
    const { target } = make({ diagnostics: async () => ({ status: 'probe-error' }) });
    await expect(target.run({ action: 'show-prompt' }, null)).rejects.toMatchObject({ code: 'locked' });
  });

  it('refuses a prompt when the Mac does not say whether it is locked', async () => {
    const { target } = make({ diagnostics: async () => ({ sessionActive: true }) });
    await expect(target.run({ action: 'show-prompt' }, null)).rejects.toMatchObject({ code: 'locked' });
  });

  it('shows the prompt without waiting for an answer, once a minute', async () => {
    let answer = (_: unknown) => {};
    const { target } = make({ requestPermission: () => new Promise(resolve => { answer = resolve; }) });
    await expect(target.run({ action: 'show-prompt' }, null)).resolves.toEqual({ accepted: true });
    await expect(target.run({ action: 'show-prompt' }, null)).rejects.toBeInstanceOf(DesktopSetupRefused);
    answer({});
  });

  it('needs desktop to be running for either macOS surface', async () => {
    const { target, openUrl } = make({ requestPermission: null });
    await expect(target.run({ action: 'open-settings', pane: 'screen' }, null)).rejects.toMatchObject({ code: 'target-off' });
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('opens only the fixed Privacy pages', async () => {
    const { target, openUrl } = make();
    await target.run({ action: 'open-settings', pane: 'screen' }, null);
    await target.run({ action: 'open-settings', pane: 'input' }, null);
    expect(openUrl.mock.calls.map(call => call[0])).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    ]);
  });

  it('refuses a peer that is not this machine’s front, and non-Mac prompts', async () => {
    await expect(make({ config: { remoteDesktop: { frontMachineId: FRONT } } }).target.run({ action: 'show-prompt' }, OTHER))
      .rejects.toMatchObject({ code: 'front-mismatch' });
    await expect(make({ config: {} }).target.run({ action: 'open-settings', pane: 'input' }, FRONT))
      .rejects.toMatchObject({ code: 'front-mismatch' });
    await expect(make({ platform: 'linux' }).target.run({ action: 'show-prompt' }, null)).rejects.toMatchObject({ code: 'not-macos' });
  });

  it('reports its status with no secret and survives a helper with no path', async () => {
    const { target } = make({ helperPath: () => { throw new Error('no helper'); } });
    const status = await target.status();
    expect(status).toMatchObject({ platform: 'darwin', configured: false, configuredAtBoot: false, restartPending: false });
    expect(status.helperPath).toBeUndefined();
    expect(JSON.stringify(status)).not.toContain('keep');
  });
});

describe('parsePeerDesktopSetup', () => {
  it('takes the front from the authenticated sender, never from a claim', () => {
    expect(parsePeerDesktopSetup({ action: 'turn-on', frontMachineId: FRONT }, FRONT)).toEqual({ action: 'turn-on', frontMachineId: FRONT });
    expect(parsePeerDesktopSetup({ action: 'turn-on', frontMachineId: OTHER }, FRONT)).toBeNull();
  });
  it('accepts only known actions and panes', () => {
    expect(parsePeerDesktopSetup({ action: 'open-settings', pane: 'screen' }, FRONT)).toEqual({ action: 'open-settings', pane: 'screen' });
    expect(parsePeerDesktopSetup({ action: 'open-settings', pane: 'neither' }, FRONT)).toBeNull();
    expect(parsePeerDesktopSetup({ action: 'exec' }, FRONT)).toBeNull();
    expect(parsePeerDesktopSetup(null, FRONT)).toBeNull();
  });
});
