import { describe, expect, it } from 'vitest';
import { desktopProbeUnavailableReason } from '../../src/core/DesktopProbeReadiness.js';

describe('desktop probe explanation', () => {
  const permitted = { screenPermission: true, inputPermission: true, displayCount: 1 };

  it('does not call an online machine locked when only the helper session is absent', () => {
    const reason = desktopProbeUnavailableReason({ ...permitted, sessionActive: false });
    expect(reason).toContain('helper has no active console session');
    expect(reason).toContain('agent is online');
    expect(reason).not.toContain('Unlock it');
  });

  it('distinguishes display and permission failures on a live session', () => {
    expect(desktopProbeUnavailableReason({ ...permitted, sessionActive: true, displayCount: 0 }))
      .toContain('No active display');
    expect(desktopProbeUnavailableReason({ ...permitted, sessionActive: true, screenPermission: false }))
      .toContain('Screen capture permission');
    expect(desktopProbeUnavailableReason({ ...permitted, sessionActive: true, inputPermission: false }))
      .toContain('Remote input permission');
  });

  it('names only the Mac session condition the helper actually observed', () => {
    expect(desktopProbeUnavailableReason({ ...permitted, sessionActive: false,
      consoleSessionPresent: false, onConsole: false, loginDone: false, screenLocked: false }))
      .toContain('cannot see a console session');
    expect(desktopProbeUnavailableReason({ ...permitted, sessionActive: false,
      consoleSessionPresent: true, onConsole: false, loginDone: true, screenLocked: false }))
      .toContain('does not report being in the console session');
    expect(desktopProbeUnavailableReason({ ...permitted, sessionActive: false,
      consoleSessionPresent: true, onConsole: true, loginDone: false, screenLocked: false }))
      .toContain('does not report a completed console login');
    expect(desktopProbeUnavailableReason({ ...permitted, sessionActive: false,
      consoleSessionPresent: true, onConsole: true, loginDone: true, screenLocked: true }))
      .toContain('reports a locked screen');
    const lockedAndUnpermitted = desktopProbeUnavailableReason({ ...permitted,
      sessionActive: false, consoleSessionPresent: true, onConsole: true,
      loginDone: true, screenLocked: true, screenPermission: false, inputPermission: false });
    expect(lockedAndUnpermitted).toContain('Screen Recording and Accessibility permission');
    expect(lockedAndUnpermitted).toContain('agent is online');
  });

  it('tells the operator the one step that fixes each condition', () => {
    const locked = desktopProbeUnavailableReason({ ...permitted, sessionActive: false,
      consoleSessionPresent: true, onConsole: true, loginDone: true, screenLocked: true,
      screenPermission: false });
    expect(locked).toContain('unlock it at the Mac, then tap Retry');
    expect(locked).toContain('Privacy & Security → Screen Recording → turn on instar-desktop-host');
    expect(desktopProbeUnavailableReason({ ...permitted, sessionActive: true, inputPermission: false }))
      .toContain('Accessibility → instar-desktop-host, then tap Retry');
  });

  it('asks the kept copy for every permission it lacks, not only the one missing overall', () => {
    const reason = desktopProbeUnavailableReason({ sessionActive: true, displayCount: 1,
      screenPermission: true, inputPermission: false,
      helperChange: { kind: 'source-changed', version: '1.3.1580', helperPath: '/k/instar-desktop-host',
        keptMissing: 'Screen Recording and Accessibility' } });
    expect(reason).toContain('Privacy & Security → Screen Recording and Accessibility');
    expect(reason).toContain('/k/instar-desktop-host');
  });

  it('says a locked Windows PC is locked and what to do, never the Mac wording', () => {
    const locked = desktopProbeUnavailableReason({ screenPermission: false, inputPermission: false,
      displayCount: 0, sessionActive: false, windows: { locked: true } });
    expect(locked).toContain('This Windows PC is locked');
    expect(locked).toContain('sign in at the PC, then tap Retry');
    expect(locked).not.toMatch(/Mac|System Settings/);
    const secure = desktopProbeUnavailableReason({ screenPermission: false, inputPermission: false,
      displayCount: 0, sessionActive: false, windows: { locked: false } });
    expect(secure).toContain('cannot reach');
    expect(secure).not.toMatch(/Mac|System Settings/);
    expect(desktopProbeUnavailableReason({ screenPermission: true, inputPermission: true,
      displayCount: 0, sessionActive: true, windows: { locked: false } })).toContain('No active display');
  });
});
