import { describe, expect, it } from 'vitest';
import { desktopSetupStep, parseDesktopSetupStatus, type DesktopSetupStatus } from '../../src/core/DesktopSetupGuide.js';

const FRONT = `m_${'a'.repeat(32)}`;
const OTHER = `m_${'b'.repeat(32)}`;
const ctx = { label: 'Mac Mini', frontMachineId: FRONT, frontLabel: 'Mac Studio' };
const unlocked: DesktopSetupStatus = {
  reachable: true, platform: 'darwin', configured: true, configuredAtBoot: true, frontMachineId: FRONT,
  targetConstructed: true, status: 'not-ready', sessionActive: true, displayCount: 1,
  consoleSessionPresent: true, onConsole: true, loginDone: true, screenLocked: false,
  screenPermission: true, inputPermission: true,
};
const ids = (step: ReturnType<typeof desktopSetupStep>) => step.actions.map(action => action.id);

describe('desktopSetupStep', () => {
  it('offers Set up on a machine that is off, and names the front when it becomes one', () => {
    const off = desktopSetupStep({ reachable: true, platform: 'darwin', configured: false, configuredAtBoot: false }, ctx);
    expect(off.state).toBe('off');
    expect(ids(off)).toEqual(['turn-on']);
    expect(off.detail).not.toContain('becomes the front');
    expect(desktopSetupStep({ reachable: true, platform: 'darwin', configured: false }, { ...ctx, becomesFront: true }).detail)
      .toContain('becomes the front');
  });

  it('asks for a restart only when the setting is on and this process started without it', () => {
    expect(desktopSetupStep({ ...unlocked, configuredAtBoot: false }, ctx).state).toBe('restart-needed');
    const dark = desktopSetupStep({ ...unlocked, targetConstructed: false, status: 'target-unavailable' }, ctx);
    expect(dark.state).toBe('target-unavailable');
    expect(ids(dark)).not.toContain('turn-on');
  });

  it('reads a waiting restart or a silent machine inside the window as restarting', () => {
    expect(desktopSetupStep({ ...unlocked, restartPending: true }, ctx).state).toBe('restarting');
    expect(desktopSetupStep({ reachable: false }, { ...ctx, restarting: true }).state).toBe('restarting');
    expect(desktopSetupStep({ reachable: false }, ctx).state).toBe('unreachable');
  });

  it('tells an old peer from an unreachable one', () => {
    expect(desktopSetupStep({ reachable: true, needsUpdate: true }, ctx).state).toBe('needs-update');
  });

  it('refuses to guide a machine tied to another front', () => {
    const step = desktopSetupStep({ ...unlocked, frontMachineId: OTHER }, ctx);
    expect(step.state).toBe('other-front');
    expect(ids(step)).toEqual(['check']);
  });

  it('says plainly when a peer does not take setup yet', () => {
    const step = desktopSetupStep({ reachable: true, platform: 'darwin', configured: false, peerClaim: false }, { ...ctx, isPeer: true });
    expect(step.state).toBe('setup-off');
    expect(ids(step)).toEqual(['check']);
    expect(desktopSetupStep({ reachable: true, platform: 'darwin', configured: false, peerClaim: false }, ctx).state).toBe('off');
  });

  it('holds a peer until the front is on', () => {
    expect(desktopSetupStep({ reachable: true, configured: false }, { ...ctx, frontNotReady: true }).state).toBe('front-first');
  });

  it('offers a pop-up only on positive evidence of an unlocked session', () => {
    const missing = { ...unlocked, screenPermission: false };
    expect(ids(desktopSetupStep(missing, ctx))).toContain('show-prompt');
    const locked = desktopSetupStep({ ...missing, sessionActive: false, screenLocked: true }, ctx);
    expect(locked.state).toBe('locked');
    expect(ids(locked)).toEqual(['check']);
    expect(locked.detail).toContain('Pop-ups do nothing');
    // Active but reporting locked still gets no prompt.
    expect(desktopSetupStep({ ...missing, screenLocked: true }, ctx).state).toBe('locked');
    const unknown = desktopSetupStep({ ...missing, sessionActive: undefined, screenLocked: undefined }, ctx);
    expect(unknown.state).toBe('session-unknown');
    expect(unknown.detail).not.toContain(' is locked');
    expect(ids(unknown)).toEqual(['check']);
  });

  it('offers no pop-up on a Mac that does not say whether it is locked', () => {
    const step = desktopSetupStep({ ...unlocked, screenPermission: false, screenLocked: undefined }, ctx);
    expect(step.state).toBe('session-unknown');
    expect(ids(step)).toEqual(['check']);
  });

  it.each([
    ['no-user', { consoleSessionPresent: false }],
    ['other-user', { onConsole: false }],
    ['sign-in-window', { loginDone: false }],
  ])('names %s', (state, extra) => {
    expect(desktopSetupStep({ ...unlocked, sessionActive: false, ...extra }, ctx).state).toBe(state);
  });

  it('wakes a machine with no display', () => {
    expect(desktopSetupStep({ ...unlocked, displayCount: 0 }, ctx).state).toBe('no-display');
  });

  it('walks Screen Recording then Accessibility, with the exact page and path', () => {
    const both = desktopSetupStep({ ...unlocked, screenPermission: false, inputPermission: false,
      helperPath: '/opt/instar/dist/native/instar-desktop-host' }, ctx);
    expect(both.state).toBe('needs-screen');
    expect(both.detail).toContain('Step 1 of 2');
    expect(both.actions.find(action => action.id === 'open-settings')?.pane).toBe('screen');
    expect(both.fallback).toContain('Screen & System Audio Recording');
    expect(both.fallback).toContain('/opt/instar/dist/native/instar-desktop-host');
    const input = desktopSetupStep({ ...unlocked, inputPermission: false }, ctx);
    expect(input.state).toBe('needs-input');
    expect(input.actions.find(action => action.id === 'open-settings')?.pane).toBe('input');
    expect(input.fallback).toContain('Accessibility');
  });

  it('says success is the live check, and to decline a pop-up naming another program', () => {
    const { detail } = desktopSetupStep({ ...unlocked, screenPermission: false }, ctx);
    expect(detail).toContain('not by that list');
    expect(detail).toContain('names tmux');
    expect(detail).toContain('Don’t Allow');
  });

  it('is ready only when the live check says ready, whatever the permission fields say', () => {
    expect(desktopSetupStep({ ...unlocked, status: 'not-ready' }, ctx).ready).toBe(false);
    expect(desktopSetupStep({ ...unlocked, status: 'ready', screenGrant: 'own', inputGrant: 'own' }, ctx).ready).toBe(true);
  });

  it('flags a grant another program holds as working but not permanent', () => {
    const step = desktopSetupStep({ ...unlocked, status: 'ready', screenGrant: 'inherited', inputGrant: 'own' }, ctx);
    expect(step.ready).toBe(true);
    expect(step.note).toContain('restart can change');
    expect(ids(step)).toContain('show-prompt');
  });

  it('explains Windows and refuses plain Linux', () => {
    expect(desktopSetupStep({ reachable: true, platform: 'linux', configured: false }, ctx).state).toBe('not-supported');
    expect(desktopSetupStep({ reachable: true, platform: 'linux', wsl: true, configured: false }, ctx).state).toBe('off');
    const failed = desktopSetupStep({ reachable: true, platform: 'linux', wsl: true, configured: false,
      bootstrapFailure: { phase: 'install' } }, ctx);
    expect(failed.state).toBe('windows-companion');
    expect(ids(failed)).not.toContain('turn-on');
    expect(desktopSetupStep({ ...unlocked, platform: 'linux', wsl: true, targetConstructed: false }, ctx).state).toBe('windows-companion');
  });
});

describe('parseDesktopSetupStatus', () => {
  it('drops unknown fields and wrong types from an untrusted peer', () => {
    const parsed = parseDesktopSetupStatus({ configured: 'yes', evil: 1, status: '<b>x</b>', frontMachineId: 'nope',
      helperPath: '/ok/path; touch x', displayCount: 99, screenGrant: 'root', platform: 'darwin', sessionActive: true });
    expect(parsed).toEqual({ reachable: true, platform: 'darwin', sessionActive: true });
  });

  it('keeps well-formed fields', () => {
    expect(parseDesktopSetupStatus({ configured: true, frontMachineId: FRONT, helperPath: '/a/b host', displayCount: 2, screenGrant: 'own' }))
      .toEqual({ reachable: true, configured: true, frontMachineId: FRONT, helperPath: '/a/b host', displayCount: 2, screenGrant: 'own' });
  });

  it('survives a reply that is not an object', () => {
    expect(parseDesktopSetupStatus('nope')).toEqual({ reachable: true });
    expect(parseDesktopSetupStatus(['x'])).toEqual({ reachable: true });
  });
});
