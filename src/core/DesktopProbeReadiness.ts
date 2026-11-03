/** A probe reports the helper's view of a desktop session, not whether the
 * machine or the Instar agent is online or whether a screen is actually locked. */
import type { DesktopHelperPermissionChange } from './DesktopHelperRetention.js';

const PERMISSION_STEP = 'System Settings → Privacy & Security';

/** macOS ties these permissions to the exact program, so a changed helper loses
 * them and nothing on the Mac can restore them without a person. Say that. */
function helperChangeReason(change: DesktopHelperPermissionChange, servingMissing: string): string {
  // A tie keeps the kept copy serving, so granting it only what is missing
  // overall would leave it short and need a second trip. Ask for all of it.
  const missing = change.keptMissing || servingMissing;
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
  linux?: { display: string | null; capturer: boolean; wayland?: boolean };
}): string {
  if (probe.linux) return linuxUnavailableReason(probe, probe.linux);
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

/** Native Linux reads its own X11 session; there are no per-app permissions to grant. */
function linuxUnavailableReason(probe: { sessionActive: boolean; displayCount: number; screenLocked?: boolean },
  linux: { display: string | null; capturer: boolean; wayland?: boolean }): string {
  if (linux.wayland) {
    return 'This Linux desktop runs Wayland, which does not let other programs see or control the screen. Choose an X11 (Xorg) session at the sign-in screen, then tap Retry. The Instar agent is online.';
  }
  if (!linux.display) {
    return 'This Linux machine has no desktop session for remote desktop to show: no X display is running as the agent’s user. A server needs a virtual desktop (for example TigerVNC or Xvfb) started as that user. The Instar agent is online.';
  }
  if (probe.screenLocked === true) {
    return 'This Linux desktop reports a locked screen. Unlock it at the machine, then tap Retry. The Instar agent is online.';
  }
  if (!probe.sessionActive) {
    return `The X display ${linux.display} did not answer, so its desktop may have stopped. Start the desktop session again, then tap Retry. The Instar agent is online.`;
  }
  if (!linux.capturer) {
    return 'The screen-capture tool is missing on this Linux machine. Install ImageMagick and xdotool (on Ubuntu: sudo apt install imagemagick xdotool), then tap Retry.';
  }
  return 'Remote desktop is not ready on this machine.';
}
