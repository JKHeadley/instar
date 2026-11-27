/**
 * Honest lock reading (docs/specs/machine-self-maintenance.md, Part A).
 *
 * The session flag `CGSSessionScreenIsLocked` is one input and never the answer:
 * on 2026-11-01 it read true on a Mac whose screensaver a keypress dismissed with
 * no password. This is the spec's decision table, first matching row wins, with
 * every input reported beside the verdict. Conflicting or unreadable evidence is
 * `unknown`, never `locked`. Pure: the readings come from the caller.
 */

export type MachineLockState = 'unlocked' | 'locked' | 'screensaver-or-display-sleep' | 'unknown' | 'not-applicable';

/** `sysadminctl -screenLock status`: `immediate`, `off`, a delay, or unreadable. */
export type PasswordRequired = 'immediate' | 'off' | 'delayed' | null;

export interface LockReadingInputs {
  /** The session flag. Null when the helper gave no reading. */
  flagLocked: boolean | null;
  passwordRequired: PasswordRequired;
  screensaverRunning: boolean | null;
  displayAsleep: boolean | null;
  lockShieldSeen: boolean | null;
  consoleSession: boolean | null;
  loginDone: boolean | null;
}

export interface LockVerdict {
  lockState: MachineLockState;
  /** The table row that decided, 1 to 5; 0 when the platform has no such reading. */
  row: number;
  reason: string;
  inputs: LockReadingInputs;
}

export const EMPTY_LOCK_INPUTS: LockReadingInputs = {
  flagLocked: null, passwordRequired: null, screensaverRunning: null, displayAsleep: null,
  lockShieldSeen: null, consoleSession: null, loginDone: null,
};

export function decideLockState(inputs: LockReadingInputs): LockVerdict {
  const v = (lockState: MachineLockState, row: number, reason: string): LockVerdict => ({ lockState, row, reason, inputs });
  const { flagLocked: flag, passwordRequired: pw, lockShieldSeen: shield } = inputs;
  const quiet = inputs.screensaverRunning === true || inputs.displayAsleep === true;
  // Row 1: no console session, login not done, or an input every later row needs is unreadable.
  if (inputs.consoleSession !== true) return v('unknown', 1, inputs.consoleSession === null ? 'console session unreadable' : 'no console session');
  if (inputs.loginDone !== true) return v('unknown', 1, inputs.loginDone === null ? 'login state unreadable' : 'login not done');
  if (flag === null) return v('unknown', 1, 'session flag unreadable');
  if (shield === null) return v('unknown', 1, 'lock shield unreadable');
  // Row 2: all three agree a password is needed now.
  if (shield && flag && pw === 'immediate') return v('locked', 2, 'flag set, lock shield on screen, password required immediately');
  // Row 3: the flag is set but no password is in force and the screen is only resting.
  // A lock shield on screen while no password is required is conflicting evidence, so it falls to row 5.
  if (flag && pw === 'off' && quiet && !shield) return v('screensaver-or-display-sleep', 3, 'flag set but no password is required and no lock shield is drawn; input dismisses it');
  // Row 4: nothing says locked.
  if (!flag && !shield) return v('unlocked', 4, 'flag clear, no lock shield, console session present');
  // Row 5: everything else, including a set flag under a delayed or unreadable password policy.
  if (flag && pw === 'delayed') return v('unknown', 5, 'flag set under a delayed password policy; no input reads how much of the delay has passed');
  if (pw === null) return v('unknown', 5, 'password policy unreadable');
  return v('unknown', 5, 'evidence conflicts');
}

/** Parses `sysadminctl -screenLock status`, which prints on stderr. */
export function parsePasswordRequired(output: string): PasswordRequired {
  if (/screenLock is off/i.test(output)) return 'off';
  const delay = /screenLock delay is (-?\d+)/i.exec(output);
  if (delay) return Number(delay[1]) === 0 ? 'immediate' : 'delayed';
  return /immediate/i.test(output) ? 'immediate' : null;
}
