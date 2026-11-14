/**
 * Reads whether a Mac is really locked. The flag is one input, never the
 * answer: the session-only inputs name whose session is on the console and stay
 * true at the shield, so only the flag and the shield window can tell locked
 * from unlocked. Fixed predicates, no model; a real frame settles capture.
 * Spec: docs/specs/desktop-locked-screen.md, "Lock reading".
 */
export type DesktopLockState =
  | 'unlocked' | 'screensaver-or-sleep' | 'locked-in-session' | 'locked-by-policy'
  | 'login-window-switched' | 'other-user-on-console' | 'unknown';

/** `pending` is a refresh after a state change. It falls on the locked side. */
export type DesktopLockPolicy = 'off' | 'on' | 'delayed' | 'unreadable' | 'pending';

export interface DesktopLockInputs {
  shieldWindow: boolean;
  secureInputOwner: 'loginwindow' | 'other' | 'none' | 'unreadable';
  displayAsleep: boolean;
  screensaver: boolean;
  onlineDisplays: number;
  thisUser: string;
  consoleUser?: string;
  osMajor: number;
  sampledAtMs: number;
  bootSession?: string;
  loginSession?: string;
}

export const LOCK_SAMPLE_MAX_AGE_MS = 2_000;

export interface DesktopLockSample {
  screenLocked?: boolean;
  onConsole?: boolean;
  loginDone?: boolean;
  osMajor?: number;
  lockInputs?: DesktopLockInputs;
}

/** `unknown` comes first: a stale, partial or self-contradicting sample never
 * reaches the table. */
export function classifyDesktopLock(sample: DesktopLockSample, policy: DesktopLockPolicy, nowMs: number): DesktopLockState {
  const inputs = sample.lockInputs;
  const flag = sample.screenLocked;
  if (!inputs || typeof flag !== 'boolean' || typeof sample.onConsole !== 'boolean'
    || typeof sample.loginDone !== 'boolean' || !inputs.thisUser
    || Math.abs(nowMs - inputs.sampledAtMs) > LOCK_SAMPLE_MAX_AGE_MS) return 'unknown';
  const console = inputs.consoleUser;
  const quiet = inputs.screensaver || inputs.displayAsleep;
  if (!flag && inputs.shieldWindow) return 'unknown';
  if (flag && !inputs.shieldWindow && !quiet) return 'unknown';
  if (console && console !== 'loginwindow' && console !== 'root' && console !== inputs.thisUser) return 'other-user-on-console';
  if (!console || console === 'loginwindow' || console === 'root' || !sample.onConsole) return 'login-window-switched';
  if (flag && inputs.shieldWindow) return 'locked-in-session';
  if (quiet && (flag || policy !== 'off')) return 'locked-by-policy';
  if (quiet) return 'screensaver-or-sleep';
  if (!flag && !inputs.shieldWindow) return 'unlocked';
  return 'unknown';
}

export function isLockedClass(state: DesktopLockState): boolean {
  return state === 'locked-in-session' || state === 'locked-by-policy' || state === 'unknown';
}

/** Parses `sysadminctl -screenLock status`, which reports on stderr. */
export function parseScreenLockPolicy(output: string): DesktopLockPolicy {
  if (/screenLock is off/i.test(output)) return 'off';
  const delay = /screenLock delay is (-?\d+)/i.exec(output);
  if (!delay) return /immediate/i.test(output) ? 'on' : 'unreadable';
  return Number(delay[1]) === 0 ? 'on' : 'delayed';
}
