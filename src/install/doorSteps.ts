/**
 * The door and Tailscale setup steps, with no terminal or CLI behind them
 * (docs/specs/recommended-services.md, Rollout step 1). The installer runs them today. The
 * every-door-down confirm page runs them with no model session, which needs them callable from
 * the server.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTALL_DOOR_LABELS, type InstallDoor, type WizardAnswers } from '../commands/setup-wizard/state-machine.js';
import { DOOR_NPM_PACKAGE, doorSignInArgs, redetectDoorPath, type SignedInVerdict } from './doors.js';

export type StepResult =
  | { kind: 'done'; updates?: Partial<WizardAnswers>; note?: string }
  | { kind: 'awaiting-person'; instruction: string; loginPid?: number; loginStamp?: string }
  | { kind: 'failed'; message: string; nextStep: string };

const PACKAGE_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Long enough for a sign-in that can't start, with no display or opener, to have already exited. */
const LOGIN_STARTUP_CHECK_MS = 2000;

export function commandExists(command: string): boolean {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

/**
 * Whether this Linux user needs Tailscale operator rights, and the command that grants them.
 * Without them, setting up the agent's private Tailscale address for the phone app fails
 * (fresh server, 2026-11-02). Null when Tailscale is absent, the user is root, the rights are
 * already granted, or the answer can't be read.
 */
export function tailscaleOperatorCommand(
  user: string,
  readPrefs: () => string | null,
  platform: NodeJS.Platform = process.platform,
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null,
): string[] | null {
  if (platform !== 'linux' || uid === 0 || !user) return null;
  const raw = readPrefs();
  if (raw === null) return null;
  let prefs: unknown;
  try {
    prefs = JSON.parse(raw);
  } catch {
    // @silent-fallback-ok: unreadable prefs mean we can't tell, so we leave Tailscale alone
    return null;
  }
  if (!prefs || typeof prefs !== 'object') return null;
  if ((prefs as { OperatorUser?: unknown }).OperatorUser === user) return null;
  return ['sudo', 'tailscale', 'set', `--operator=${user}`];
}

export function readTailscalePrefs(): string | null {
  if (!commandExists('tailscale')) return null;
  try {
    return execFileSync('tailscale', ['debug', 'prefs'], { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // @silent-fallback-ok: Tailscale not running or not readable; nothing to set up
    return null;
  }
}

/** Where a door can install when the global npm folder isn't writable. Its bin folder is one detection checks. */
export function userNpmPrefix(home: string = os.homedir()): string {
  return path.join(home, '.local');
}

function npmGlobalWritable(): boolean {
  try {
    const prefix = execFileSync('npm', ['config', 'get', 'prefix'], { encoding: 'utf-8', timeout: 15_000 }).trim();
    fs.accessSync(path.join(prefix, 'lib'), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** What each step needs from whoever runs it. */
export interface DoorStepEnv {
  logFile: string;
  interactive: boolean;
  browser: boolean;
  proveSignedIn: (door: InstallDoor) => Promise<SignedInVerdict>;
  doorPath: (door: InstallDoor) => string | null;
  /** Runs a command with its output in the log. Returns its exit code. */
  runLogged: (command: string, args: string[], timeoutMs?: number) => number | null;
  /** True when sudo can run without asking for a password. */
  sudoReady: () => boolean;
  /** The door's sign-in in the person's own terminal. */
  runAttached: (command: string, args: string[]) => number | null;
  /** The door's sign-in in the background, so its browser window can finish after this exits. */
  startDetached: (command: string, args: string[]) => number | null;
  /** Identifies a process, so a reused pid isn't mistaken for the sign-in. Null when it's gone. */
  processStamp: (pid: number) => string | null;
  stopProcess: (pid: number) => void;
  print: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
}

/** How the person continues, in the words of whatever is running the step. */
export interface ResumeWords {
  /** A verb phrase, such as "open your setup page again". */
  resume: string;
  /** The same, for when no browser can be used here. */
  elsewhere: string;
}

function sentence(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** Optional: Tailscale operator rights on Linux. Never stops the setup. */
export function tailscaleOperatorStep(env: Pick<DoorStepEnv, 'interactive' | 'sudoReady' | 'runLogged'>): StepResult {
  const command = tailscaleOperatorCommand(os.userInfo().username, readTailscalePrefs);
  if (!command) return { kind: 'done' };
  if (env.interactive || env.sudoReady()) {
    env.runLogged(command[0], command.slice(1), 60_000);
    if (tailscaleOperatorCommand(os.userInfo().username, readTailscalePrefs) === null) return { kind: 'done' };
  }
  return {
    kind: 'done',
    note: `To let the phone app reach your agent over Tailscale, run ${command.join(' ')} once.`,
  };
}

export function doorInstallStep(
  env: Pick<DoorStepEnv, 'doorPath' | 'runLogged' | 'logFile'>,
  door: InstallDoor,
  words: Pick<ResumeWords, 'resume'>,
): StepResult {
  if (env.doorPath(door)) return { kind: 'done' };
  const pkg = DOOR_NPM_PACKAGE[door];
  const args = npmGlobalWritable()
    ? ['install', '-g', pkg]
    : ['install', '-g', '--prefix', userNpmPrefix(), pkg];
  const code = env.runLogged('npm', args, PACKAGE_INSTALL_TIMEOUT_MS);
  if (code === 0 && redetectDoorPath(door)) return { kind: 'done' };
  return {
    kind: 'failed',
    message: `I couldn't install ${INSTALL_DOOR_LABELS[door]}. Details are in ${env.logFile}.`,
    nextStep: `Install ${pkg} yourself. Then ${words.resume}.`,
  };
}

export interface SignInOptions {
  words: ResumeWords;
  /** The sign-in this setup left waiting, if any. */
  awaiting?: { loginPid?: number; loginStamp?: string };
  /** Claude already has a token to use, so nothing needs signing in. */
  claudeTokenHeld?: boolean;
  /** Gets a Claude token some other way. True when one was obtained. */
  obtainClaudeToken?: () => Promise<boolean>;
}

export async function doorSignInStep(env: DoorStepEnv, door: InstallDoor, options: SignInOptions): Promise<StepResult> {
  const { words, awaiting, claudeTokenHeld = false, obtainClaudeToken } = options;
  const label = INSTALL_DOOR_LABELS[door];
  if (door === 'claude-code' && claudeTokenHeld) return { kind: 'done' };
  const verdict = await env.proveSignedIn(door);
  if (verdict === 'signed-in') return { kind: 'done' };
  // A server has no browser, and Claude's sign-in page can show a puzzle to data-centre
  // addresses (Cirrus, 2026-11-02). A token made on any computer with a browser avoids both.
  if (door === 'claude-code' && verdict === 'signed-out' && obtainClaudeToken && (await obtainClaudeToken())) {
    return { kind: 'done', note: 'Claude will use the token you pasted.' };
  }
  if (verdict === 'unknown') {
    return { kind: 'done', note: `I can't tell whether ${label} is signed in, so I'm leaving it as it is. If it asks you to sign in later, do that then.` };
  }
  const command = env.doorPath(door);
  if (!command) return { kind: 'failed', message: `${label} isn't installed.`, nextStep: `${sentence(words.resume)}.` };

  const previous = awaiting?.loginPid;
  const previousStamp = awaiting?.loginStamp;
  const stillRunning = previous !== undefined && previousStamp !== undefined && env.processStamp(previous) === previousStamp;

  if (env.interactive) {
    // A sign-in left waiting in the background would compete with this one.
    if (stillRunning) env.stopProcess(previous);
    env.print(`  Sign in to ${label} now. This uses your own account, and Instar never sees the password.`);
    env.runAttached(command, doorSignInArgs(door, env.browser));
    if ((await env.proveSignedIn(door)) === 'signed-out') {
      return { kind: 'failed', message: `${label} still isn't signed in.`, nextStep: `${sentence(words.resume)} to try again.` };
    }
    return { kind: 'done' };
  }

  if (!env.browser) {
    return { kind: 'awaiting-person', instruction: `There's no browser here to sign in to ${label} with, so ${words.elsewhere}.` };
  }
  if (stillRunning) {
    return {
      kind: 'awaiting-person',
      instruction: `Finish signing in to ${label} in the window that opened, then ${words.resume}.`,
      loginPid: previous,
      loginStamp: previousStamp,
    };
  }
  const pid = env.startDetached(command, doorSignInArgs(door, true));
  if (pid !== null) await env.sleep(LOGIN_STARTUP_CHECK_MS);
  const stamp = pid !== null ? env.processStamp(pid) : null;
  if (pid === null || stamp === null) {
    return { kind: 'awaiting-person', instruction: `I couldn't open a window to sign in to ${label}, so ${words.elsewhere}.` };
  }
  return {
    kind: 'awaiting-person',
    instruction: `Finish signing in to ${label} in the window that opened, then ${words.resume}. If no window opened, ${words.elsewhere}.`,
    loginPid: pid,
    loginStamp: stamp,
  };
}
