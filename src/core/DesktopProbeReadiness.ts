/** A probe reports the helper's view of a desktop session, not whether the
 * machine or the Instar agent is online or whether a screen is actually locked. */
import type { DesktopHelperPermissionChange } from './DesktopHelperRetention.js';

const PERMISSION_STEP = 'System Settings → Privacy & Security';

/** macOS ties these permissions to the exact program, so a changed helper loses
 * them and nothing on the Mac can restore them without a person. Say that. */
function helperChangeReason(change: DesktopHelperPermissionChange, missing: string): string {
  const why = change.kind === 'source-changed'
    ? `Instar's Mac desktop helper changed in update ${change.version}, and macOS ties ${missing} to the exact program, so the old permission no longer applies.`
    : `Instar now keeps one permanent copy of its Mac desktop helper, so later updates that leave the helper unchanged cannot remove its permission. macOS needs to allow that copy once.`;
  return `${why} This will not fix itself. Someone at this Mac needs to allow it again: ${PERMISSION_STEP} → ${missing}. `
    + `Turn instar-desktop-host off and on. If it is not listed or that does not work, remove it with the minus button and add ${change.helperPath} with the plus button. Then tap Retry.`;
}

/** One sentence on what is wrong, then the one thing that fixes it. */
export function desktopProbeUnavailableReason(probe: {
  sessionActive: boolean;
  displayCount: number;
  screenPermission: boolean;
  inputPermission: boolean;
  consoleSessionPresent?: boolean;
  onConsole?: boolean;
  loginDone?: boolean;
  screenLocked?: boolean;
  helperChange?: DesktopHelperPermissionChange;
}): string {
  const missing = [!probe.screenPermission && 'Screen Recording',
    !probe.inputPermission && 'Accessibility'].filter(Boolean).join(' and ');
  const permissionStep = missing && probe.helperChange
    ? helperChangeReason(probe.helperChange, missing)
    : missing
    ? `It also needs a one-time ${missing} permission at the Mac: ${PERMISSION_STEP} → ${missing} → turn on instar-desktop-host.`
    : '';
  if (!probe.sessionActive) {
    if (probe.consoleSessionPresent === false) {
      return 'Nobody is signed in at this Mac’s screen, so the desktop helper cannot see a console session. Sign in at the Mac. The Instar agent is online.';
    }
    if (probe.onConsole === false) {
      return 'Another user is using this Mac’s screen, so the desktop helper does not report being in the console session. Switch back to the agent’s user at the Mac. The Instar agent is online.';
    }
    if (probe.loginDone === false) {
      return 'This Mac is still at its sign-in window; the desktop helper does not report a completed console login. Sign in at the Mac. The Instar agent is online.';
    }
    if (probe.screenLocked === true) {
      return ['This Mac reports a locked screen. Remote desktop cannot open a locked Mac yet: unlock it at the Mac, then tap Retry.',
        permissionStep, 'The Instar agent is online.'].filter(Boolean).join(' ');
    }
    return 'The desktop helper has no active console session. The agent is online; its screen may be locked or the helper may be outside the signed-in session.';
  }
  if (probe.displayCount === 0) return 'No active display is available to capture on this machine. Wake its screen or connect a display.';
  if (missing && probe.helperChange) return helperChangeReason(probe.helperChange, missing);
  if (!probe.screenPermission) {
    return `Screen capture permission is unavailable to the desktop helper. Turn it on once at the Mac: ${PERMISSION_STEP} → Screen Recording → instar-desktop-host, then tap Retry.`;
  }
  if (!probe.inputPermission) {
    return `Remote input permission is unavailable to the desktop helper. Turn it on once at the Mac: ${PERMISSION_STEP} → Accessibility → instar-desktop-host, then tap Retry.`;
  }
  return 'Remote desktop is not ready on this machine.';
}
