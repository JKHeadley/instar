/**
 * `instar install`: the one installer behind every way in (spec install-experience).
 *
 * Deterministic until an AI door is signed in, because no model is available before that. Package
 * output goes to a log. The ledger in ./install/progress.ts lets a harness poll it and `--resume`
 * continue it.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { detectGitPath, detectTmuxPath, standaloneAgentsDir } from '../core/Config.js';
import { validateAgentName } from '../core/AgentRegistry.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../core/SafeGitExecutor.js';
import { checkPrerequisites } from '../core/Prerequisites.js';
import {
  buildInstallFlow,
  INSTALL_DOOR_LABELS,
  INSTALL_EXPLANATION,
  INSTALL_INITIAL_STATE,
  type InstallDoor,
  type InstallFlowContext,
  type WizardAnswers,
} from './setup-wizard/state-machine.js';
import { runInstallFlow, type InstallIo, type StepHandler, type StepResult } from './install/engine.js';
import {
  DOOR_NPM_PACKAGE,
  detectDoorPath,
  detectInstallDoors,
  detectRunningDoor,
  doorSignInArgs,
  redetectDoorPath,
  hasBrowser,
  proveDoorSignedIn,
  type SignedInVerdict,
} from './install/doors.js';
import {
  installProgressPath,
  newInstallProgress,
  readInstallProgress,
  writeInstallProgress,
  type InstallProgress,
  type InstallStatus,
} from './install/progress.js';

/** Room for the AI tool, Instar's own state and a first week of logs. The browser is extra, and lazy. */
export const MIN_FREE_BYTES = 1.5 * 1024 ** 3;
const NODE_MINIMUM: [number, number] = [20, 12];
const SERVER_READY_TIMEOUT_MS = 60_000;
const PACKAGE_INSTALL_TIMEOUT_MS = 10 * 60_000;
/** Long enough for a sign-in that can't start, with no display or opener, to have already exited. */
const LOGIN_STARTUP_CHECK_MS = 2000;

export interface PreflightFacts {
  platform: NodeJS.Platform;
  nodeVersion: string;
  freeBytes: number | null;
}

/** A plain refusal when this computer can't take an install, or null. Unknown disk space doesn't refuse. */
export function preflightRefusal(facts: PreflightFacts): { message: string; nextStep: string } | null {
  if (facts.platform !== 'linux' && facts.platform !== 'darwin') {
    return {
      message: 'On Windows, Instar runs inside WSL.',
      nextStep: 'Run the Windows installer, install.ps1, which sets up WSL and then continues there.',
    };
  }
  const [major, minor] = facts.nodeVersion.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10));
  if (major < NODE_MINIMUM[0] || (major === NODE_MINIMUM[0] && minor < NODE_MINIMUM[1])) {
    return {
      message: `Instar needs Node ${NODE_MINIMUM.join('.')} or newer, and this computer has ${facts.nodeVersion}.`,
      nextStep: 'Install a newer Node, or use the one-line installer, then run instar install --resume.',
    };
  }
  if (facts.freeBytes !== null && facts.freeBytes < MIN_FREE_BYTES) {
    const need = (MIN_FREE_BYTES / 1024 ** 3).toFixed(1);
    const have = (facts.freeBytes / 1024 ** 3).toFixed(1);
    return {
      message: `Instar needs about ${need} GB of free disk space, and this computer has ${have} GB.`,
      nextStep: 'Free some space, then run instar install --resume.',
    };
  }
  return null;
}

export function agentDirFor(name: string): string {
  return path.join(standaloneAgentsDir(), name);
}

/** Refuses a bad or taken name, before anything is installed. */
export function validateNewAgentName(name: string): string | null {
  if (!validateAgentName(name)) {
    return 'That name won\'t work. Use letters, numbers, hyphens or underscores, starting with a letter or number.';
  }
  if (fs.existsSync(path.join(agentDirFor(name), '.instar', 'config.json'))) {
    return `You already have an agent called ${name}. Pick another name, or just talk to that one.`;
  }
  return null;
}

/** A git that really runs. On a clean Mac /usr/bin/git is only a stub until the developer tools install. */
export function gitWorks(): boolean {
  if (!detectGitPath()) return false;
  try {
    if (process.platform === 'darwin') execFileSync('xcode-select', ['-p'], { stdio: 'ignore', timeout: 5000 });
    SafeGitExecutor.readSync(['--version'], { stdio: 'pipe', timeout: 5000, operation: 'src/commands/install.ts:gitWorks' });
    return true;
  } catch {
    return false;
  }
}

function commandExists(command: string): boolean {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

/** How this computer can install tmux, or null when the person has to. Names any sudo it needs. */
export function tmuxInstallCommand(
  platform: NodeJS.Platform = process.platform,
  exists: (command: string) => boolean = commandExists,
): string[] | null {
  if (platform === 'darwin') return exists('brew') ? ['brew', 'install', 'tmux'] : null;
  if (platform !== 'linux' || !exists('sudo')) return null;
  if (exists('apt-get')) return ['sudo', 'apt-get', 'install', '-y', 'tmux'];
  if (exists('dnf')) return ['sudo', 'dnf', 'install', '-y', 'tmux'];
  if (exists('yum')) return ['sudo', 'yum', 'install', '-y', 'tmux'];
  return null;
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

/** What the single consent lists, including any sudo, so nothing is installed silently (spec 4.1). */
export function describeInstallPlan(answers: WizardAnswers): string[] {
  const lines: string[] = [];
  if (!detectTmuxPath()) {
    const command = tmuxInstallCommand();
    lines.push(command ? `Install tmux by running: ${command.join(' ')}` : 'Stop and ask you to install tmux');
  }
  if (!gitWorks()) lines.push('Stop and ask you to install git');
  if (answers.door && !detectDoorPath(answers.door)) {
    lines.push(`Install ${INSTALL_DOOR_LABELS[answers.door]} from npm (${DOOR_NPM_PACKAGE[answers.door]})`);
  } else if (answers.door) {
    lines.push(`Use the ${INSTALL_DOOR_LABELS[answers.door]} already on this computer`);
  }
  if (answers.agentName) lines.push(`Create your agent in ${agentDirFor(answers.agentName)}`);
  if (answers.autostartConsent !== false) lines.push('Start your agent automatically after a reboot');
  return lines;
}

export interface InstallEnv {
  logFile: string;
  /** The running CLI, so child commands are this same version. */
  cli: string[];
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
  initAgent: (answers: WizardAnswers) => Promise<void>;
  serverHealthy: (port: number) => Promise<boolean>;
  installAutostart: (agentDir: string) => { installed: boolean; detail?: string };
  print: (text: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

function agentConfigFile(answers: WizardAnswers): string {
  return path.join(agentDirFor(answers.agentName!), '.instar', 'config.json');
}

function readAgentConfig(answers: WizardAnswers): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(agentConfigFile(answers), 'utf-8')) as Record<string, unknown>;
}

/**
 * What the installer changes in a new agent's config. Addresses come when wanted (spec 4.1), and
 * `init` defaults to a public Cloudflare quick tunnel, which nobody here agreed to.
 */
export function finishAgentConfig(configFile: string): void {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
  config.tunnel = { ...(config.tunnel as Record<string, unknown> | undefined), enabled: false };
  const tmp = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, configFile);
  ensureViewingPin(configFile);
}

/** The PIN normally appears when Telegram is set up, and a messaging-free install needs one too. */
export function ensureViewingPin(configFile: string): string {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf-8')) as Record<string, unknown>;
  if (typeof config.dashboardPin === 'string' && config.dashboardPin) return config.dashboardPin;
  const pin = String(randomInt(100000, 1000000));
  config.dashboardPin = pin;
  const tmp = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, configFile);
  return pin;
}

export function buildInstallHandlers(env: InstallEnv): Partial<Record<import('./setup-wizard/state-machine.js').WizardActionKind, StepHandler>> {
  const resume = 'Then run instar install --resume.';
  return {
    'install-preflight': async () => {
      let freeBytes: number | null = null;
      try {
        const stat = fs.statfsSync(os.homedir());
        freeBytes = stat.bavail * stat.bsize;
      } catch {
        // @silent-fallback-ok: unknown disk space doesn't refuse an install
      }
      const refusal = preflightRefusal({ platform: process.platform, nodeVersion: process.version, freeBytes });
      if (refusal) return { kind: 'failed', ...refusal };
      env.print('');
      env.print(INSTALL_EXPLANATION.split('\n').map((line) => `  ${line}`).join('\n'));
      env.print('');
      return { kind: 'done' };
    },

    'install-tools': async () => {
      if (!gitWorks()) {
        const how = process.platform === 'darwin'
          ? 'Run xcode-select --install and finish its window.'
          : 'Install it from https://git-scm.com/downloads.';
        return { kind: 'failed', message: 'Your agent needs git, which isn\'t ready on this computer.', nextStep: `${how} ${resume}` };
      }
      if (detectTmuxPath()) return { kind: 'done' };
      const yourself = { kind: 'failed' as const, message: 'Your agent needs tmux, and I couldn\'t install it.' };
      const command = tmuxInstallCommand();
      if (!command) {
        const how = process.platform === 'darwin'
          ? 'Install Homebrew from https://brew.sh, then run brew install tmux.'
          : 'Install tmux with your package manager.';
        return { ...yourself, nextStep: `${how} ${resume}` };
      }
      if (!env.interactive && command[0] === 'sudo' && !env.sudoReady()) {
        return {
          kind: 'failed',
          message: 'Your agent needs tmux, and installing it needs your password.',
          nextStep: `Run ${command.join(' ')} in your own terminal. ${resume}`,
        };
      }
      env.runLogged(command[0], command.slice(1), PACKAGE_INSTALL_TIMEOUT_MS);
      if (detectTmuxPath()) return { kind: 'done' };
      return { ...yourself, nextStep: `Run ${command.join(' ')} yourself. Details are in ${env.logFile}. ${resume}` };
    },

    'door-install': async (answers) => {
      const door = answers.door!;
      if (detectDoorPath(door)) return { kind: 'done' };
      const pkg = DOOR_NPM_PACKAGE[door];
      const args = npmGlobalWritable()
        ? ['install', '-g', pkg]
        : ['install', '-g', '--prefix', userNpmPrefix(), pkg];
      const code = env.runLogged('npm', args, PACKAGE_INSTALL_TIMEOUT_MS);
      if (code === 0 && redetectDoorPath(door)) return { kind: 'done' };
      return {
        kind: 'failed',
        message: `I couldn't install ${INSTALL_DOOR_LABELS[door]}. Details are in ${env.logFile}.`,
        nextStep: `Install ${pkg} yourself. ${resume}`,
      };
    },

    'door-sign-in': async (answers, progress) => signInStep(env, answers.door!, progress),

    'agent-init': async (answers) => {
      const file = agentConfigFile(answers);
      // The name was free when asked, so a config here is this install's own, stopped partway. A
      // config appears midway through init, so it can't prove init finished: set it aside and redo it.
      if (fs.existsSync(file)) {
        const dir = agentDirFor(answers.agentName!);
        fs.renameSync(dir, `${dir}.partial-${env.now()}`);
      }
      await env.initAgent(answers);
      if (!fs.existsSync(file)) {
        return { kind: 'failed', message: `Your agent's files weren't created. Details are in ${env.logFile}.`, nextStep: resume };
      }
      finishAgentConfig(file);
      return { kind: 'done' };
    },

    'start-server': async (answers) => {
      const port = Number(readAgentConfig(answers).port);
      if (await env.serverHealthy(port)) return { kind: 'done' };
      env.runLogged(env.cli[0], [...env.cli.slice(1), 'server', 'start', '--dir', agentDirFor(answers.agentName!)]);
      const deadline = env.now() + SERVER_READY_TIMEOUT_MS;
      while (env.now() < deadline) {
        if (await env.serverHealthy(port)) return { kind: 'done' };
        await env.sleep(1000);
      }
      return { kind: 'failed', message: `Your agent didn't start. Details are in ${env.logFile}.`, nextStep: resume };
    },

    'install-autostart': async (answers) => {
      if (answers.autostartConsent === false) {
        return { kind: 'done', note: 'Your agent won\'t restart by itself after a reboot, as you chose.' };
      }
      const result = env.installAutostart(agentDirFor(answers.agentName!));
      if (result.installed) return { kind: 'done', ...(result.detail ? { note: result.detail } : {}) };
      return { kind: 'done', note: `Your agent is running, but it won't restart by itself after a reboot. ${result.detail ?? ''}`.trim() };
    },

    'owner-slot': async (answers) => {
      if (!env.interactive) {
        return {
          kind: 'awaiting-person',
          instruction: 'Your dashboard is ready. To see how to open it, run instar install --resume in your own terminal.',
        };
      }
      const config = readAgentConfig(answers);
      const pin = ensureViewingPin(agentConfigFile(answers));
      env.print('');
      env.print(`  Your dashboard: http://localhost:${Number(config.port)}/dashboard`);
      env.print(`  Your PIN: ${pin}`);
      env.print('  This is the only time the installer shows this PIN. Your agent can tell you again later.');
      env.print('');
      return { kind: 'done' };
    },
  };
}

async function signInStep(env: InstallEnv, door: InstallDoor, progress: InstallProgress): Promise<StepResult> {
  const label = INSTALL_DOOR_LABELS[door];
  const verdict = await env.proveSignedIn(door);
  if (verdict === 'signed-in') return { kind: 'done' };
  if (verdict === 'unknown') {
    return { kind: 'done', note: `I can't tell whether ${label} is signed in, so I'm leaving it as it is. If it asks you to sign in later, do that then.` };
  }
  const command = env.doorPath(door);
  if (!command) return { kind: 'failed', message: `${label} isn't installed.`, nextStep: 'Run instar install --resume.' };

  const previous = progress.awaiting?.loginPid;
  const previousStamp = progress.awaiting?.loginStamp;
  const stillRunning = previous !== undefined && previousStamp !== undefined && env.processStamp(previous) === previousStamp;

  if (env.interactive) {
    // A sign-in left waiting in the background would compete with this one.
    if (stillRunning) env.stopProcess(previous);
    env.print(`  Sign in to ${label} now. This uses your own account, and Instar never sees the password.`);
    env.runAttached(command, doorSignInArgs(door, env.browser));
    if ((await env.proveSignedIn(door)) === 'signed-out') {
      return { kind: 'failed', message: `${label} still isn't signed in.`, nextStep: 'Run instar install --resume to try again.' };
    }
    return { kind: 'done' };
  }

  const inYourTerminal = `run instar install --resume in your own terminal, for example over SSH`;
  if (!env.browser) {
    return { kind: 'awaiting-person', instruction: `There's no browser here to sign in to ${label} with, so ${inYourTerminal}.` };
  }
  if (stillRunning) {
    return {
      kind: 'awaiting-person',
      instruction: `Finish signing in to ${label} in the window that opened, then run instar install --resume.`,
      loginPid: previous,
      loginStamp: previousStamp,
    };
  }
  const pid = env.startDetached(command, doorSignInArgs(door, true));
  if (pid !== null) await env.sleep(LOGIN_STARTUP_CHECK_MS);
  const stamp = pid !== null ? env.processStamp(pid) : null;
  if (pid === null || stamp === null) {
    return { kind: 'awaiting-person', instruction: `I couldn't open a window to sign in to ${label}, so ${inYourTerminal}.` };
  }
  return {
    kind: 'awaiting-person',
    instruction: `Finish signing in to ${label} in the window that opened, then run instar install --resume. If no window opened, ${inYourTerminal}.`,
    loginPid: pid,
    loginStamp: stamp,
  };
}

/**
 * Never lets the agent install its own start-on-login job. The person's answer decides that, in
 * the autostart step, where the throwaway-agent guard still applies. On 2026-11-02 passing the
 * autostart flag here let a sandboxed test agent register itself as a real service.
 */
export function installInitOptions(answers: WizardAnswers) {
  return {
    standalone: true,
    name: answers.agentName!,
    framework: answers.door!,
    role: answers.agentRole,
    skipPrereqs: true,
    skipCloudBackup: true,
    interactive: false,
  };
}

function appendingLog(file: string): number {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return fs.openSync(file, 'a', 0o600);
}

function defaultEnv(interactive: boolean): InstallEnv {
  const logFile = path.join(os.homedir(), '.instar', 'logs', 'install.log');
  return {
    logFile,
    cli: [process.execPath, process.argv[1]],
    interactive,
    browser: hasBrowser(),
    proveSignedIn: proveDoorSignedIn,
    doorPath: detectDoorPath,
    runLogged: (command, args, timeoutMs) => {
      const log = appendingLog(logFile);
      try {
        // stdin stays attached so a sudo the consent named can still ask for its password.
        return spawnSync(command, args, {
          stdio: [interactive ? 'inherit' : 'ignore', log, log],
          ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
        }).status;
      } finally {
        fs.closeSync(log);
      }
    },
    sudoReady: () => spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 5000 }).status === 0,
    runAttached: (command, args) => spawnSync(command, args, { stdio: 'inherit' }).status,
    // Sign-in prints its link, and no link may reach output or logs (spec 4.3), so nothing is kept.
    startDetached: (command, args) => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      // A spawn that fails reports here, and would otherwise crash the installer.
      child.on('error', () => {});
      child.unref();
      return child.pid ?? null;
    },
    processStamp: (pid) => {
      const started = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8', timeout: 5000 });
      return started.status === 0 && started.stdout.trim() ? started.stdout.trim() : null;
    },
    stopProcess: (pid) => {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // @silent-fallback-ok: it already exited
      }
    },
    initAgent: (answers) => quietly(logFile, async () => {
      const { initProject } = await import('./init.js');
      await initProject(installInitOptions(answers));
    }),
    serverHealthy: async (port) => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        return res.ok;
      } catch {
        return false;
      }
    },
    installAutostart: (agentDir) => {
      const result = spawnSync(process.execPath, [process.argv[1], 'autostart', 'install', '--dir', agentDir], { encoding: 'utf-8' });
      fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(logFile, `${result.stdout ?? ''}${result.stderr ?? ''}`);
      if (result.status === 0 && /Auto-start installed/.test(result.stdout ?? '')) return { installed: true };
      const refused = /Auto-start not installed: (.*)/.exec(result.stdout ?? '')?.[1];
      return { installed: false, detail: refused };
    },
    print: (text) => console.log(text),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  };
}

/** `init` narrates for a developer audience. Here that goes to the log, per spec 4.1. */
async function quietly(logFile: string, run: () => Promise<void>): Promise<void> {
  const original = { log: console.log, warn: console.warn };
  fs.closeSync(appendingLog(logFile));
  const toLog = (...args: unknown[]): void => {
    const line = args.join(' ');
    // `init` prints part of the agent's token. No token goes to logs (spec 4.3).
    if (!/Auth token/.test(line)) fs.appendFileSync(logFile, `${line}\n`);
  };
  console.log = toLog;
  console.warn = toLog;
  try {
    await run();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
  }
}

export interface InstallAnswersFile {
  name?: string;
  purpose?: string;
  door?: string;
  autostart?: boolean;
}

/** Maps an answers file onto the flow's questions. `--yes` alone supplies consent (spec 4.1). */
export function presetFromAnswers(file: InstallAnswersFile, yes: boolean): Record<string, string> {
  return {
    ...(file.name !== undefined ? { 'agent-name': file.name } : {}),
    ...(file.purpose !== undefined ? { 'agent-purpose': file.purpose } : {}),
    ...(file.door !== undefined ? { 'door-choice': file.door } : {}),
    ...(yes ? { consent: 'yes' } : {}),
  };
}

export interface InstallCommandOptions {
  resume?: boolean;
  yes?: boolean;
  answers?: string;
  status?: boolean;
  restart?: boolean;
}

export const INSTALL_EXIT_CODES: Record<InstallStatus, number> = {
  complete: 0,
  declined: 0,
  // Waiting on a person isn't a failure, and a harness must not hang or retry on it (spec 4.3).
  'awaiting-person': 0,
  running: 0,
  'needs-answers': 2,
  failed: 1,
};

/** Refuses an answers file that would be misread, such as autostart spelled "no". */
export function answersFileProblem(file: InstallAnswersFile): string | null {
  for (const key of ['name', 'purpose', 'door'] as const) {
    if (file[key] !== undefined && typeof file[key] !== 'string') return `In the answers file, ${key} must be text.`;
  }
  if (file.autostart !== undefined && typeof file.autostart !== 'boolean') {
    return 'In the answers file, autostart must be true or false.';
  }
  return null;
}

function installLockPath(file: string): string {
  return `${file}.lock`;
}

/** The pid of a live install holding the lock, or null. A lock left by a dead process doesn't count. */
function liveLockHolder(lock: string): number | null {
  let pid: number;
  try {
    pid = Number.parseInt(fs.readFileSync(lock, 'utf-8'), 10);
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/** A ledger left on `running` by a process that died is shown as interrupted, so a poller stops waiting. */
export function reportedStatus(progress: InstallProgress, holder: number | null): string {
  return progress.status === 'running' && holder === null ? 'interrupted' : progress.status;
}

export async function runInstallCommand(options: InstallCommandOptions): Promise<InstallStatus> {
  const file = installProgressPath();
  const existing = readInstallProgress(file);
  const lock = installLockPath(file);

  if (options.status) {
    const holder = liveLockHolder(lock);
    console.log(JSON.stringify(existing ? {
      status: reportedStatus(existing, holder),
      cursor: existing.cursor,
      awaiting: existing.awaiting?.instruction,
      needs: existing.needs,
      failure: existing.failure,
    } : { status: 'none' }, null, 2));
    return 'complete';
  }

  const holder = liveLockHolder(lock);
  if (holder !== null) {
    console.log(`  Another install is running (process ${holder}). Wait for it, or stop it first.`);
    return 'failed';
  }

  const unfinished = existing && existing.status !== 'complete' && existing.status !== 'declined' && !options.restart;
  if (options.resume && !unfinished) {
    console.log('  There is no install to resume. Run instar install to start one.');
    return 'complete';
  }
  if (!options.resume && unfinished) {
    console.log('  An install is already in progress. Continuing it. To begin again, use --restart.');
  }
  const progress = unfinished ? existing : newInstallProgress(INSTALL_INITIAL_STATE);

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const answersFile: InstallAnswersFile = options.answers
    ? JSON.parse(fs.readFileSync(options.answers, 'utf-8')) as InstallAnswersFile
    : {};
  const problem = answersFileProblem(answersFile);
  if (problem) {
    console.log(`  ${problem}`);
    return 'needs-answers';
  }
  if (answersFile.autostart !== undefined) progress.answers.autostartConsent = answersFile.autostart;

  const context: InstallFlowContext = {
    detectedDoors: detectInstallDoors(),
    runningInDoor: detectRunningDoor(),
    validateName: validateNewAgentName,
    describePlan: describeInstallPlan,
  };

  const io: InstallIo = {
    interactive,
    print: (text) => console.log(text),
    ask: async (prompt) => {
      console.log();
      console.log(prompt.split('\n').map((line) => `  ${line}`).join('\n'));
      // Open only for the question. Left open, it keeps the terminal in raw mode and a step's
      // child process can't be stopped with Ctrl-C.
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(pc.dim('  > '));
      } finally {
        rl.close();
      }
    },
  };

  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  fs.writeFileSync(lock, String(process.pid), { mode: 0o600 });
  try {
    return await runInstallFlow({
      states: buildInstallFlow(context),
      progress,
      save: (p) => writeInstallProgress(file, p),
      handlers: buildInstallHandlers(defaultEnv(interactive)),
      io,
      preset: presetFromAnswers(answersFile, options.yes === true),
    });
  } finally {
    SafeFsExecutor.safeRmSync(lock, { force: true, operation: 'install lock release' });
  }
}
