/** A probe reports the helper's view of a desktop session, not whether the
 * machine or the Instar agent is online or whether a screen is actually locked. */
export function desktopProbeUnavailableReason(probe: {
  sessionActive: boolean;
  displayCount: number;
  screenPermission: boolean;
  inputPermission: boolean;
  consoleSessionPresent?: boolean;
  onConsole?: boolean;
  loginDone?: boolean;
  screenLocked?: boolean;
}): string {
  if (!probe.sessionActive) {
    if (probe.consoleSessionPresent === false) {
      return 'The Mac desktop helper cannot see a console session. The Instar agent is online.';
    }
    if (probe.onConsole === false) {
      return 'The Mac desktop helper does not report being in the console session. The Instar agent is online.';
    }
    if (probe.loginDone === false) {
      return 'The Mac desktop helper does not report a completed console login. The Instar agent is online.';
    }
    if (probe.screenLocked === true) {
      return 'The Mac console session reports a locked screen. The Instar agent is online.';
    }
    return 'The desktop helper has no active console session. The agent is online; its screen may be locked or the helper may be outside the GUI session.';
  }
  if (probe.displayCount === 0) return 'No active display is available to capture on this machine.';
  if (!probe.screenPermission) return 'Screen capture permission is unavailable to the desktop helper.';
  if (!probe.inputPermission) return 'Remote input permission is unavailable to the desktop helper.';
  return 'Remote desktop is not ready on this machine.';
}
