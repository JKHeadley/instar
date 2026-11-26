/**
 * Enrolment readiness and refusals (docs/specs/machine-self-maintenance.md, Part C).
 * CMT-1200, first slice: read-only. Nothing here enrols a machine, installs a rule or
 * restarts anything. It answers two questions the Machine care card needs before it may
 * offer the owner's tap:
 *
 *  1. May this machine be offered at all? (`enrolmentRefusal`): never for a throwaway or a
 *     test process, never with the host do-not-maintain marker, never for a machine this
 *     agent's config names `shared`, never while another person is using it, never in a
 *     container. An unknown machine is never assumed owned: the tap is the owner's word.
 *  2. Could it come back by itself after a restart? (`readReadiness`): macOS needs
 *     FileVault off, auto-login as this user, and each agent's LaunchAgent set to run at
 *     load; Linux needs root off an encrypted volume, lingering on, and the user unit
 *     enabled; Windows + WSL is attended only in v1. Anything unread is attended: unknown
 *     never reads as ready. The card names only the one setting that is missing.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export type ReadinessPlatform = 'darwin' | 'linux' | 'wsl' | 'other';
export type ReadinessMode = 'unattended' | 'attended';

export interface ReadinessCheck {
  id: 'filevault-off' | 'auto-login' | 'launch-agents' | 'root-not-encrypted' | 'linger' | 'user-unit' | 'platform';
  ok: boolean | null;
  detail?: string;
}

export interface Readiness {
  platform: ReadinessPlatform;
  /** What the machine can do, as read now. `unattended` only when every check passed. */
  mode: ReadinessMode;
  checks: ReadinessCheck[];
  /** The one plain step for the card, or null when nothing is missing. Never a command. */
  ownerStep: string | null;
  readAt: number;
}

/** One bounded read. Null when it failed or timed out. */
export type ReadCommand = (command: string, args: string[]) => Promise<string | null>;

export function makeReadCommand(timeoutMs = 3_000): ReadCommand {
  return (command, args) => new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: timeoutMs, killSignal: 'SIGKILL', env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
        // fdesetup and defaults print to stdout; a nonzero exit is still a reading for `defaults` (key absent).
        if (err && (err as { killed?: boolean }).killed) { resolve(null); return; }
        resolve(err ? (String(stderr || '') + String(stdout || '')) || '' : String(stdout));
      });
    } catch { resolve(null); } // @silent-fallback-ok — an unstartable read is unread
  });
}

export function parseFileVault(out: string | null): boolean | null {
  if (out === null) return null;
  if (/FileVault is Off/i.test(out)) return true;
  if (/FileVault is On/i.test(out)) return false;
  return null;
}

/** `defaults read ... autoLoginUser`: the user name, or "does not exist" when unset. */
export function parseAutoLogin(out: string | null, user: string): boolean | null {
  if (out === null) return null;
  if (/does not exist/i.test(out)) return false;
  const name = out.trim().split('\n')[0]?.trim();
  return name ? name === user : null;
}

export function parseLsblkCrypt(out: string | null): boolean | null {
  if (out === null) return null;
  const types = out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (types.length === 0) return null;
  return !types.includes('crypt');
}

export async function readReadiness(input: {
  platform: ReadinessPlatform;
  user: string;
  /** Agents whose autostart must hold on this login (this one and its co-residents). */
  agents: string[];
  read: ReadCommand;
  /** macOS: the LaunchAgents folder. Default ~/Library/LaunchAgents. */
  launchAgentsDir?: string;
  now?: () => number;
}): Promise<Readiness> {
  const now = (input.now ?? Date.now)();
  const checks: ReadinessCheck[] = [];
  if (input.platform === 'darwin') {
    const fv = parseFileVault(await input.read('/usr/bin/fdesetup', ['status']));
    const al = parseAutoLogin(await input.read('/usr/bin/defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser']), input.user);
    const dir = input.launchAgentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents');
    const missing: string[] = [];
    let unread = false;
    for (const agent of input.agents) {
      const plist = path.join(dir, `ai.instar.${agent}.plist`);
      if (!fs.existsSync(plist)) { missing.push(agent); continue; }
      const runAtLoad = await input.read('/usr/bin/plutil', ['-extract', 'RunAtLoad', 'raw', '-o', '-', plist]);
      if (runAtLoad === null) unread = true;
      else if (runAtLoad.trim() !== 'true') missing.push(agent);
    }
    checks.push({ id: 'filevault-off', ok: fv });
    checks.push({ id: 'auto-login', ok: al });
    checks.push({ id: 'launch-agents', ok: missing.length ? false : unread ? null : true, ...(missing.length ? { detail: missing.join(', ') } : {}) });
  } else if (input.platform === 'linux') {
    const src = (await input.read('/usr/bin/findmnt', ['-no', 'SOURCE', '/']))?.trim() || null;
    const crypt = src ? parseLsblkCrypt(await input.read('/usr/bin/lsblk', ['-s', '-no', 'TYPE', src])) : null;
    const linger = await input.read('/usr/bin/loginctl', ['show-user', input.user, '-p', 'Linger']);
    const units: string[] = [];
    let unread = false;
    for (const agent of input.agents) {
      const out = await input.read('/usr/bin/systemctl', ['--user', 'is-enabled', `instar-${agent}.service`]);
      if (out === null) unread = true;
      else if (out.trim() !== 'enabled') units.push(agent);
    }
    checks.push({ id: 'root-not-encrypted', ok: crypt });
    checks.push({ id: 'linger', ok: linger === null ? null : /Linger=yes/.test(linger) });
    checks.push({ id: 'user-unit', ok: units.length ? false : unread ? null : true, ...(units.length ? { detail: units.join(', ') } : {}) });
  } else {
    // Windows + WSL: nothing starts the agent after a Windows boot in v1. Other: not covered.
    checks.push({ id: 'platform', ok: false, detail: input.platform === 'wsl' ? 'wsl-attended-only' : 'not-covered' });
  }
  const ready = checks.length > 0 && checks.every((c) => c.ok === true);
  return { platform: input.platform, mode: ready ? 'unattended' : 'attended', checks, ownerStep: ownerStep(input.platform, checks), readAt: now };
}

/** The one plain step the card shows, for the first missing setting. Never a command. */
export function ownerStep(platform: ReadinessPlatform, checks: ReadinessCheck[]): string | null {
  const bad = (id: ReadinessCheck['id']) => checks.find((c) => c.id === id && c.ok === false);
  if (platform === 'darwin') {
    if (bad('filevault-off')) return 'This Mac asks for your password before it starts, so it can\'t come back by itself. That is a good setting for a laptop and I recommend keeping it. I\'ll remind you to restart it instead.';
    if (bad('auto-login')) return 'On this Mac: System Settings, Users & Groups, Automatically log in as, choose your name.';
    if (bad('launch-agents')) return 'I\'ll set this Mac to start me when it starts.';
  }
  if (platform === 'linux') {
    if (bad('root-not-encrypted')) return 'This machine asks for a disk password before it starts, so it can\'t come back by itself. I\'ll remind you to restart it instead.';
    if (bad('linger') || bad('user-unit')) return 'I\'ll set this machine to start me when it starts.';
  }
  if (platform === 'wsl') return 'This Windows machine can\'t start me by itself after a restart yet, so I\'ll remind you to restart it instead.';
  if (checks.some((c) => c.ok === null)) return 'I couldn\'t read this machine\'s start-up settings, so I\'ll treat it as needing you nearby for restarts.';
  return null;
}

export type EnrolmentRefusal = 'throwaway' | 'not-owned' | 'other-user-active' | null;

/**
 * Part C's refusal table. Checked before the tap is offered and again before any restart.
 * Positive evidence of another person blocks; an unread `who` does not invent one, but the
 * actuation-time safety hold S3 re-reads it.
 */
export function enrolmentRefusal(input: {
  throwaway: boolean;
  testProcess: boolean;
  doNotMaintainMarker: boolean;
  ownership: 'owned' | 'shared' | undefined;
  inContainer: boolean;
  /** Other human users seen on console, tty or SSH, or with tty processes. Null: unread. */
  otherUsers: string[] | null;
}): EnrolmentRefusal {
  if (input.throwaway || input.testProcess) return 'throwaway';
  if (input.doNotMaintainMarker || input.ownership === 'shared' || input.inContainer) return 'not-owned';
  if (input.otherUsers && input.otherUsers.length > 0) return 'other-user-active';
  return null;
}

/** Other human users from `who` output: any login name that is not this user. */
export function otherUsersFromWho(whoOutput: string | null, user: string): string[] | null {
  if (whoOutput === null) return null;
  const names = new Set<string>();
  for (const line of whoOutput.split('\n')) {
    const name = line.trim().split(/\s+/)[0];
    if (name && name !== user) names.add(name);
  }
  return [...names];
}

export function defaultDoNotMaintainPath(): string {
  return path.join(os.homedir(), '.instar', 'host-maintenance', 'do-not-maintain.json');
}

/** The enrolment record (Part C). Written only by the owner's tap, which a later slice adds. */
export interface EnrolmentRecord {
  machineId: string;
  maintainerAgent: string;
  mode: 'proving' | 'unattended' | 'attended';
  enrolledAt: number;
  principal: string;
  ruleInstalled: boolean;
}

export function readEnrolment(file = path.join(os.homedir(), '.instar', 'host-maintenance', 'enrolment.json')): EnrolmentRecord | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf-8')) as EnrolmentRecord;
    return r && typeof r.machineId === 'string' && typeof r.principal === 'string' ? r : null;
  } catch { return null; } // @silent-fallback-ok — absent or unreadable: not enrolled, so nothing restarts
}

export interface EnrolmentStatus {
  enrolled: boolean;
  record: EnrolmentRecord | null;
  refusal: EnrolmentRefusal;
  readiness: Readiness;
  /** What the card can offer now. The tap itself is a later slice: `offerable` is a reading. */
  offerable: boolean;
}

// RULE 3: EXEMPT — reads fixed OS settings (FileVault, auto-login, launchd/systemd units, `who`)
// through exact command lines, not a provider or session output stream; unread is attended.
/** Reads enrolment status on demand, cached, so a status route never blocks on probes. */
export class EnrolmentStatusReader {
  private cached: { at: number; value: EnrolmentStatus } | null = null;
  private inflight: Promise<EnrolmentStatus> | null = null;
  constructor(private readonly deps: {
    platform: ReadinessPlatform;
    user: string;
    agents: () => string[];
    read: ReadCommand;
    refusalInputs: () => Promise<Parameters<typeof enrolmentRefusal>[0]>;
    readRecord?: () => EnrolmentRecord | null;
    cacheMs?: number;
    now?: () => number;
  }) {}

  async read(): Promise<EnrolmentStatus> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached && now - this.cached.at < (this.deps.cacheMs ?? 10 * 60_000)) return this.cached.value;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const [readiness, refusalIn] = await Promise.all([
        readReadiness({ platform: this.deps.platform, user: this.deps.user, agents: this.deps.agents(), read: this.deps.read }),
        this.deps.refusalInputs(),
      ]);
      const record = (this.deps.readRecord ?? readEnrolment)();
      const refusal = enrolmentRefusal(refusalIn);
      const value: EnrolmentStatus = { enrolled: record !== null, record, refusal, readiness, offerable: record === null && refusal === null };
      this.cached = { at: now, value };
      return value;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }
}

let activeEnrolment: EnrolmentStatusReader | null = null;
export function setActiveEnrolmentStatusReader(r: EnrolmentStatusReader | null): void { activeEnrolment = r; }
export function getActiveEnrolmentStatusReader(): EnrolmentStatusReader | null { return activeEnrolment; }
