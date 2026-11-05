/**
 * Installs what the Linux Chrome driver needs, at the agent's own boot (ACT-138).
 *
 * xdrive.sh never installs anything. This module decides, from stored values and measured machine
 * facts, whether to start the detached runner (xdrive-provision.sh), which does the work and records
 * the result. It adds packages and gates nothing: on any false fact or failure the agent still boots
 * and reports what is missing. Spec: docs/specs/normal-chrome-linux.md, "Installing on a fresh agent".
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { isWslHost } from './wslPlatform.js';

export const PROVISION_RETRY_MS = [60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
export const CHROME_UPGRADE_INTERVAL_MS = 24 * 60 * 60_000;
export const MIN_FREE_BYTES = 3 * 1024 ** 3;
/** After this many automatic attempts it stops; only an operator's yes (POST /browser/linux/install) tries again. */
export const MAX_INSTALL_ATTEMPTS = 6;

export interface MachineFacts {
  platform: NodeJS.Platform;
  /** Windows underneath: ndrive.sh is the driver there, so nothing is installed. */
  wsl: boolean;
  arch: string;
  osRelease: string;
  hasApt: boolean;
  sudoWorks: boolean;
  freeBytes: number;
}

export interface ProvisionRecord {
  status?: string;
  at?: string;
  boot?: string;
  upgradedAt?: string;
  upgradeFailed?: boolean;
}

export interface BackoffRecord {
  attempts: number;
  lastAt: number;
}

export type ProvisionDecision =
  | { action: 'none'; reason: string }
  | { action: 'skip'; reason: string }
  | { action: 'install' }
  | { action: 'upgrade' };

function stateFolder(stateDir: string): string {
  return path.join(stateDir, 'state', 'xdrive');
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    // @silent-fallback-ok: a missing or partial state file means "nothing recorded".
    return null;
  }
}

/** Written once, by markNewAgent, for an agent born on this release or later. */
export function markBrowserAutoInstall(stateDir: string): void {
  const folder = stateFolder(stateDir);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(folder, 'auto-install.json'), JSON.stringify({ browserAutoInstall: true }), { mode: 0o600 });
}

/** The who-gets-it rule. An explicit config value always wins; a throwaway agent never installs. */
export function wantsAutoInstall(stateDir: string, configured: boolean | undefined, throwaway: boolean): boolean {
  if (throwaway) return false;
  if (configured !== undefined) return configured;
  return readJson<{ browserAutoInstall?: boolean }>(path.join(stateFolder(stateDir), 'auto-install.json'))?.browserAutoInstall === true;
}

/** Why this machine cannot be installed automatically, or null when it can. */
export function machineBlocker(facts: MachineFacts): string | null {
  if (facts.arch !== 'x64') return 'arch: Google publishes no Chrome for Linux on this processor';
  if (!/^ID=ubuntu$/m.test(facts.osRelease) || !/^VERSION_ID="?24\.04"?$/m.test(facts.osRelease)) return 'os: automatic install is measured on Ubuntu 24.04 only';
  if (!facts.hasApt) return 'os: no apt-get';
  if (!facts.sudoWorks) return 'sudo: this user has no passwordless sudo';
  if (facts.freeBytes < MIN_FREE_BYTES) return 'disk: less than 3 GB free';
  return null;
}

export function retryDelayMs(attempts: number): number {
  return PROVISION_RETRY_MS[Math.min(Math.max(attempts, 1), PROVISION_RETRY_MS.length) - 1];
}

/** Everything the boot call decides, as a pure function of what it read. */
export function decideProvision(input: {
  wanted: boolean;
  bypassBackoff?: boolean;
  depsPresent: boolean;
  bindings: number;
  facts: MachineFacts;
  record: ProvisionRecord | null;
  backoff: BackoffRecord | null;
  now: number;
}): ProvisionDecision {
  const { wanted, depsPresent, bindings, facts, record, backoff, now } = input;
  if (facts.platform !== 'linux' || facts.wsl) return { action: 'none', reason: 'not Linux' };
  if (!wanted) return { action: 'none', reason: 'not wanted on this agent' };
  if (depsPresent) {
    const last = record?.upgradedAt ? Date.parse(record.upgradedAt) : 0;
    const due = now - (Number.isFinite(last) ? last : 0) >= CHROME_UPGRADE_INTERVAL_MS;
    if (due && bindings === 0 && facts.sudoWorks && facts.hasApt) return { action: 'upgrade' };
    return { action: 'none', reason: 'ready' };
  }
  const blocker = machineBlocker(facts);
  if (blocker) return { action: 'skip', reason: blocker };
  if (!input.bypassBackoff && backoff && backoff.attempts >= MAX_INSTALL_ATTEMPTS) {
    return { action: 'none', reason: 'stopped retrying' };
  }
  if (!input.bypassBackoff && backoff && backoff.attempts > 0 && now - backoff.lastAt < retryDelayMs(backoff.attempts)) {
    return { action: 'none', reason: 'waiting to retry' };
  }
  return { action: 'install' };
}

function run(command: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) }));
  });
}

async function readMachineFacts(stateDir: string): Promise<MachineFacts> {
  let osRelease = '';
  try {
    osRelease = fs.readFileSync('/etc/os-release', 'utf8');
  } catch {
    // @silent-fallback-ok: an unreadable os-release reads as "not the measured OS".
  }
  let freeBytes = 0;
  try {
    const info = fs.statfsSync(stateDir);
    freeBytes = Number(info.bavail) * Number(info.bsize);
  } catch {
    // @silent-fallback-ok: unknown free space reads as too little, so nothing installs.
  }
  return {
    platform: process.platform,
    wsl: isWslHost(),
    arch: os.arch(),
    osRelease,
    hasApt: (await run('which', ['apt-get'])).ok,
    sudoWorks: (await run('sudo', ['-n', 'true'])).ok,
    freeBytes,
  };
}

export interface ProvisionDeps {
  stateDir: string;
  projectDir: string;
  configured: boolean | undefined;
  throwaway: boolean;
  bypassBackoff?: boolean;
  readFacts?: (stateDir: string) => Promise<MachineFacts>;
  depsPresent?: () => Promise<boolean>;
  startRunner?: (mode: 'install' | 'upgrade') => void;
  now?: () => number;
}

function writeRecord(stateDir: string, status: string, extra: Partial<ProvisionRecord> = {}): void {
  const folder = stateFolder(stateDir);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = path.join(folder, 'provision.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ status, at: new Date().toISOString(), ...extra }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function startDetachedRunner(projectDir: string, mode: 'install' | 'upgrade'): void {
  /* @self-action-controller: linux-browser-install-retry */
  const script = path.join(projectDir, '.instar', 'scripts', 'browser', 'xdrive-provision.sh');
  const args = ['-n', '19', 'setsid', script, projectDir, ...(mode === 'upgrade' ? ['--upgrade'] : [])];
  const child = spawn('nice', args, {
    detached: true,
    stdio: 'ignore',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '', LANG: process.env.LANG ?? 'C.UTF-8' },
  });
  child.on('error', () => { /* @silent-fallback-ok: the unchanged record shows the runner never wrote */ });
  child.unref();
}

/** Live bindings only: a leftover file for a dead Chrome must not hold back upgrades forever. */
function countBindings(stateDir: string): number {
  const folder = path.join(stateFolder(stateDir), 'targets');
  let live = 0;
  try {
    for (const name of fs.readdirSync(folder)) {
      const target = readJson<{ pid?: number }>(path.join(folder, name));
      if (target?.pid && fs.existsSync(`/proc/${target.pid}`)) live++;
    }
  } catch {
    // @silent-fallback-ok: no targets folder means no binding.
  }
  return live;
}

/** One boot's work. Never throws and never blocks the caller for longer than a few short reads. */
export async function provisionLinuxBrowser(deps: ProvisionDeps): Promise<ProvisionDecision> {
  const now = deps.now ?? Date.now;
  const folder = stateFolder(deps.stateDir);
  try {
    // First, and before any probe: an agent that has not asked for this runs nothing at all, no sudo included.
    const wanted = wantsAutoInstall(deps.stateDir, deps.configured, deps.throwaway);
    if (!wanted) return { action: 'none', reason: 'not wanted on this agent' };
    const facts = await (deps.readFacts ?? readMachineFacts)(deps.stateDir);
    if (facts.platform !== 'linux' || facts.wsl) return { action: 'none', reason: 'not Linux' };
    const present = deps.depsPresent
      ? await deps.depsPresent()
      : (await run(path.join(deps.projectDir, '.instar', 'scripts', 'browser', 'xdrive.sh'), ['deps'])).stdout.trim() === 'OK';
    const backoffFile = path.join(folder, 'provision-backoff.json');
    const decision = decideProvision({
      wanted,
      bypassBackoff: deps.bypassBackoff,
      depsPresent: present,
      bindings: countBindings(deps.stateDir),
      facts,
      record: readJson<ProvisionRecord>(path.join(folder, 'provision.json')),
      backoff: readJson<BackoffRecord>(backoffFile),
      now: now(),
    });
    const start = deps.startRunner ?? ((mode) => startDetachedRunner(deps.projectDir, mode));
    if (decision.action === 'skip') {
      writeRecord(deps.stateDir, `skipped: ${decision.reason}`);
    } else if (decision.action === 'install') {
      const backoff = readJson<BackoffRecord>(backoffFile);
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      fs.writeFileSync(backoffFile, JSON.stringify({ attempts: (backoff?.attempts ?? 0) + 1, lastAt: now() }), { mode: 0o600 });
      start('install');
    } else if (decision.action === 'upgrade') {
      // Written first: a runner that cannot start must still wait the full interval.
      writeRecord(deps.stateDir, 'ready', { upgradedAt: new Date(now()).toISOString() });
      start('upgrade');
    } else if (decision.reason === 'ready' && wanted) {
      const record = readJson<ProvisionRecord>(path.join(folder, 'provision.json'));
      if (record?.status !== 'ready') writeRecord(deps.stateDir, 'ready');
      if (fs.existsSync(backoffFile)) SafeFsExecutor.safeUnlinkSync(backoffFile, { operation: 'src/core/linuxBrowserProvision.ts:clear-backoff' });
    }
    return decision;
  } catch (err) {
    console.error('[linux-browser] provisioning check failed:', err instanceof Error ? err.message : String(err));
    return { action: 'none', reason: 'check failed' };
  }
}

/** Hourly re-check, so a machine that stays up still retries after a failure and takes Chrome updates. */
export function startProvisionTimer(deps: () => ProvisionDeps): NodeJS.Timeout {
  const timer = setInterval(() => { void provisionLinuxBrowser(deps()); }, 60 * 60_000);
  timer.unref();
  return timer;
}

/**
 * Every answer is one of these. An agent always has a browser: `not-built` and `broken` are states with
 * a next step, and nothing here ever reads as "no browser" (operator rule, 2026-11-04).
 */
export type BrowserState = 'ready' | 'installing' | 'not-built' | 'broken';

export interface BrowserCapability {
  state: BrowserState;
  driver: string;
  reason: string | null;
  nextStep: string;
  asOf: string | null;
  machineLocal: true;
}

const INSTALL_STEP = 'Ask the operator one plain yes/no naming what gets installed (Google Chrome and five system packages); on a yes, POST /browser/linux/install.';

/** Pure, so every state is tested on any OS. */
export function deriveBrowserState(input: {
  platform: NodeJS.Platform;
  wsl: boolean;
  record: ProvisionRecord | null;
  driverPresent: boolean;
}): BrowserCapability {
  const { platform, wsl, record, driverPresent } = input;
  const base = { reason: null, asOf: record?.at ?? null, machineLocal: true as const };
  if (platform === 'darwin') return { ...base, state: 'ready', driver: 'chrome-js.sh (Apple Events)', nextStep: 'Use /normal-chrome-browser.' };
  if (wsl || platform === 'win32') return { ...base, state: 'ready', driver: 'ndrive.sh (Windows, from WSL)', nextStep: 'Use /normal-chrome-browser.' };
  const driver = 'xdrive.sh (private display)';
  const status = record?.status ?? '';
  if (status === 'installing') return { ...base, state: 'installing', driver, nextStep: 'It is installing now; check again in a few minutes.' };
  if (status.startsWith('failed')) {
    return { ...base, state: 'broken', driver, reason: status, nextStep: `The install stopped at this step. Tell the operator, or retry: ${INSTALL_STEP}` };
  }
  if (driverPresent) return { ...base, state: 'ready', driver, nextStep: 'Use /normal-chrome-browser: xdrive.sh launch <profile> <url>.' };
  if (status === 'ready') {
    return { ...base, state: 'broken', driver, reason: 'a package it needs has been removed', nextStep: `Retry the install: ${INSTALL_STEP}` };
  }
  return { ...base, state: 'not-built', driver, reason: status.startsWith('skipped: ') ? status.slice('skipped: '.length) : 'not installed on this machine yet', nextStep: INSTALL_STEP };
}

function driverOnDisk(): boolean {
  const any = (paths: string[]) => paths.some((p) => fs.existsSync(p));
  return fs.existsSync('/opt/google/chrome/chrome')
    && any(['/usr/bin/Xvnc', '/usr/bin/Xtigervnc'])
    && any(['/usr/libexec/at-spi-bus-launcher', '/usr/lib/at-spi2-core/at-spi-bus-launcher']);
}

/** For GET /browser/state and GET /capabilities: this machine's state, labelled with its time. */
export function browserCapability(stateDir: string): BrowserCapability {
  return deriveBrowserState({
    platform: process.platform,
    wsl: isWslHost(),
    record: readJson<ProvisionRecord>(path.join(stateFolder(stateDir), 'provision.json')),
    driverPresent: process.platform === 'linux' && driverOnDisk(),
  });
}
