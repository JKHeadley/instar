/**
 * Read-only machine readings for the closed delay list and the safety holds
 * (docs/specs/machine-self-maintenance.md, Part D).
 *
 * Every OS command goes through `runReadOnly`, whose allowlist holds only commands
 * that observe. Each is bounded and takes no shell. An unreadable source returns
 * null, never a guess. Safety holds count only on positive evidence, so an
 * unreadable source is no hold; the owner-present delay reads unreadable as present,
 * which the spec bounds by its maximum.
 *
 * Holds S1 and S2 are unproven readings until live test L7 shows they tell a real
 * install from none, and the status says so beside each one.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SafetyHoldId } from './planner.js';

/** Every OS call this feature can make, by name, with its exact arguments. Nothing else can run. */
const READ_ONLY_CALLS = {
  bootTime: { command: 'sysctl', args: ['-n', 'kern.boottime'] },
  inputIdle: { command: 'ioreg', args: ['-c', 'IOHIDSystem', '-d', '4'] },
  ttyUsers: { command: 'who', args: ['-u'] },
  processes: { command: 'ps', args: ['-axo', 'args='] },
  battery: { command: 'pmset', args: ['-g', 'batt'] },
  tmuxSessions: { command: 'tmux', args: ['list-sessions', '-F', '#{session_name}'] },
} as const;

export type ReadingName = keyof typeof READ_ONLY_CALLS;
export type ReadOnlyRunner = (name: ReadingName) => Promise<string | null>;

/** `tmuxPath` replaces only the tmux executable, so a configured install is found. */
export function makeReadOnlyRunner(tmuxPath?: string): ReadOnlyRunner {
  return (name) => {
    const call = READ_ONLY_CALLS[name];
    if (!call) return Promise.reject(new Error(`not a read-only call: ${String(name)}`));
    const command = name === 'tmuxSessions' && tmuxPath ? tmuxPath : call.command;
    return new Promise((resolve) => {
      execFile(command, [...call.args], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
    });
  };
}

export interface MachineSignals {
  lastBootAt: number | null;
  /** Milliseconds since the last console input. Includes Instar's own driver input. */
  inputIdleMs: number | null;
  ttyUsers: Array<{ user: string; idleMs: number | null }>;
  processes: string[] | null;
  onBattery: boolean | null;
  batteryPercent: number | null;
  tmuxSessions: string[] | null;
}

export function parseBootTime(sysctlOutput: string): number | null {
  const match = /sec\s*=\s*(\d+)/.exec(sysctlOutput);
  return match ? Number(match[1]) * 1000 : null;
}

export function parseHidIdleMs(ioregOutput: string): number | null {
  const match = /"?HIDIdleTime"?\s*=\s*(\d+)/.exec(ioregOutput);
  return match ? Math.floor(Number(match[1]) / 1e6) : null;
}

/** `who -u` idle column: "." under a minute, "HH:MM", or "old". */
export function parseWhoIdle(whoOutput: string): MachineSignals['ttyUsers'] {
  const rows: MachineSignals['ttyUsers'] = [];
  for (const line of whoOutput.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    const clocks = fields.filter((f, i) => i >= 2 && (f === '.' || f === 'old' || /^\d{1,2}:\d{2}$/.test(f)));
    // The first clock-shaped field is the login time; the idle column follows it.
    const raw = clocks[1] ?? null;
    let idleMs: number | null = null;
    if (raw === '.') idleMs = 0;
    else if (raw === 'old') idleMs = 24 * 3_600_000;
    else if (raw) {
      const [h, m] = raw.split(':').map(Number);
      idleMs = (h * 60 + m) * 60_000;
    }
    rows.push({ user: fields[0], idleMs });
  }
  return rows;
}

export function parsePmsetBattery(pmsetOutput: string): { onBattery: boolean | null; percent: number | null } {
  const onBattery = /Battery Power/.test(pmsetOutput) ? true : /AC Power/.test(pmsetOutput) ? false : null;
  const percent = /(\d{1,3})%/.exec(pmsetOutput);
  return { onBattery, percent: percent ? Number(percent[1]) : null };
}

function readLinuxBattery(): { onBattery: boolean | null; percent: number | null } {
  try {
    const root = '/sys/class/power_supply';
    const bat = fs.readdirSync(root).find((n) => n.startsWith('BAT'));
    if (!bat) return { onBattery: false, percent: null };
    const status = fs.readFileSync(path.join(root, bat, 'status'), 'utf-8').trim();
    const capacity = Number(fs.readFileSync(path.join(root, bat, 'capacity'), 'utf-8').trim());
    return { onBattery: status === 'Discharging', percent: Number.isFinite(capacity) ? capacity : null };
  } catch {
    // @silent-fallback-ok — no readable battery is no S4 hold.
    return { onBattery: null, percent: null };
  }
}

export async function readMachineSignals(run: ReadOnlyRunner = makeReadOnlyRunner(), platform: NodeJS.Platform = process.platform): Promise<MachineSignals> {
  const mac = platform === 'darwin';
  const [boot, hid, who, ps, power, tmux] = await Promise.all([
    mac ? run('bootTime') : Promise.resolve(null),
    mac ? run('inputIdle') : Promise.resolve(null),
    run('ttyUsers'),
    run('processes'),
    mac ? run('battery') : Promise.resolve(null),
    run('tmuxSessions'),
  ]);
  const battery = power !== null ? parsePmsetBattery(power) : mac ? { onBattery: null, percent: null } : readLinuxBattery();
  return {
    lastBootAt: boot !== null ? parseBootTime(boot) : Math.round(Date.now() - os.uptime() * 1000),
    inputIdleMs: hid !== null ? parseHidIdleMs(hid) : null,
    ttyUsers: who !== null ? parseWhoIdle(who) : [],
    processes: ps !== null ? ps.split('\n').map((l) => l.trim()).filter(Boolean) : null,
    onBattery: battery.onBattery,
    batteryPercent: battery.percent,
    tmuxSessions: tmux !== null ? tmux.split('\n').map((l) => l.trim()).filter(Boolean) : null,
  };
}

const INSTALLING: RegExp[] = [
  /(^|\/)softwareupdate\s.*(--install|\s-i\b|-ia\b)/,
  /(^|\/)(osinstallersetupd|InstallAssistant)\b/,
  /(^|\/)(apt|apt-get|dpkg|dnf|yum|rpm|pacman|unattended-upgr\w*)\s/,
];
const DISK_OPERATION: RegExp[] = [
  /(^|\/)fsck(_\w+)?\s/,
  /(^|\/)diskutil\s+(repair\w*|verify\w*|apfs\s+(convert|encrypt|decrypt)|convert\w*|secureErase)\b/i,
  /(^|\/)asr\s/,
  /(^|\/)tmutil\s+restore\b/,
  /(^|\/)(fwupd|fwupdmgr|fwupdtool)\b/,
];

export interface HoldReading { id: SafetyHoldId; active: boolean; label: string; evidence: string | null; provenLive: boolean }

/** Safety holds. Only positive evidence counts. */
export function readSafetyHolds(s: MachineSignals, ownUser: string): HoldReading[] {
  const seen = (patterns: RegExp[]): string | null => (s.processes ?? []).find((p) => patterns.some((re) => re.test(p)))?.split(/\s+/)[0] ?? null;
  const installer = seen(INSTALLING);
  const disk = seen(DISK_OPERATION);
  const otherUser = s.ttyUsers.find((u) => u.user !== ownUser && u.idleMs !== null && u.idleMs < 15 * 60_000);
  const personNow = s.inputIdleMs !== null && s.inputIdleMs < 5 * 60_000;
  const lowBattery = s.onBattery === true && s.batteryPercent !== null && s.batteryPercent < 50;
  return [
    { id: 'S1', active: installer !== null, label: 'OS update installing', evidence: installer, provenLive: false },
    { id: 'S2', active: disk !== null, label: 'Disk or firmware operation', evidence: disk, provenLive: false },
    { id: 'S3', active: personNow || otherUser !== undefined, label: 'A person using the machine now', evidence: otherUser ? `user ${otherUser.user}` : personNow ? 'console input' : null, provenLive: false },
    { id: 'S4', active: lowBattery, label: 'On battery under 50%', evidence: lowBattery ? `${s.batteryPercent}%` : null, provenLive: false },
  ];
}

/** D1. Unreadable presence on a Mac reads as present; on Linux the ttys are the reading. */
export function readOwnerPresent(s: MachineSignals, ownUser: string, platform: NodeJS.Platform = process.platform): { active: boolean; evidence: string } {
  if (s.inputIdleMs !== null) return { active: s.inputIdleMs < 15 * 60_000, evidence: `console idle ${Math.round(s.inputIdleMs / 60_000)} min` };
  if (platform === 'darwin') return { active: true, evidence: 'presence unreadable' };
  const tty = s.ttyUsers.find((u) => u.user === ownUser && u.idleMs !== null && u.idleMs < 15 * 60_000);
  return { active: tty !== undefined, evidence: tty ? 'tty activity' : 'no tty activity' };
}

/** tmux sessions that belong to no agent in the census. `instar-codex-arm-` is Instar's own and self-closing. */
export function foreignTmuxSessions(all: string[] | null, ownSessions: string[], agentNames: string[]): string[] | null {
  if (all === null) return null;
  const own = new Set(ownSessions);
  return all.filter((name) => !own.has(name) && !name.startsWith('instar-codex-arm-') && !agentNames.some((a) => name === a || name.startsWith(`${a}-`)));
}
