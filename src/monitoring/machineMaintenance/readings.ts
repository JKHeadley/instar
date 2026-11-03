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
import { fileURLToPath } from 'node:url';
import type { SafetyHoldId } from './planner.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The shipped wedge canary (Part E, F1 on macOS): a no-UI app that quits at once,
 * built by scripts/build-native-desktop-host.mjs into dist/native. From a source
 * checkout this resolves to that checkout's dist; from the package, beside dist.
 */
export const WEDGE_CANARY_APP = path.basename(path.resolve(MODULE_DIR, '..', '..')) === 'src'
  ? path.resolve(MODULE_DIR, '..', '..', '..', 'dist', 'native', 'InstarWedgeCanary.app')
  : path.resolve(MODULE_DIR, '..', '..', 'native', 'InstarWedgeCanary.app');

/**
 * Whether the canary can be run here: macOS, the bundle's executable present, and not
 * a test run that did not opt in (a test must not launch the real app by accident).
 */
export function wedgeCanaryAvailable(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, app: string = WEDGE_CANARY_APP): boolean {
  if (platform !== 'darwin') return false;
  if (env.VITEST && env.INSTAR_REAL_WEDGE_CANARY_TESTS !== '1') return false;
  try {
    return fs.statSync(path.join(app, 'Contents', 'MacOS', 'InstarWedgeCanary')).isFile();
  } catch {
    // @silent-fallback-ok — no canary installed: F1 on macOS reads unknown, with that reason.
    return false;
  }
}

/** Every OS call this feature can make, by name, with its exact arguments. Nothing else can run. */
const READ_ONLY_CALLS = {
  bootTime: { command: 'sysctl', args: ['-n', 'kern.boottime'] },
  inputIdle: { command: 'ioreg', args: ['-c', 'IOHIDSystem', '-d', '4'] },
  ttyUsers: { command: 'who', args: ['-u'] },
  processes: { command: 'ps', args: ['-axo', 'args='] },
  chromeProcesses: { command: 'ps', args: ['-axo', 'pid=,lstart=,args='] },
  battery: { command: 'pmset', args: ['-g', 'batt'] },
  tmuxSessions: { command: 'tmux', args: ['list-sessions', '-F', '#{session_name}'] },
  // Wedge evidence (Part E). The process table's state column, timed: a hung or
  // refused `ps` is itself the F2 evidence.
  processStates: { command: 'ps', args: ['-axo', 'stat='] },
  // F1 on Linux: a no-op run through the user service manager. It starts one transient
  // unit that runs `/bin/true` and is collected; it observes whether that path works.
  userUnitProbe: { command: 'systemd-run', args: ['--user', '--quiet', '--wait', '--collect', '/bin/true'] },
  // F1 on WSL: one no-op Windows command through interop.
  interopProbe: { command: 'cmd.exe', args: ['/c', 'exit', '0'] },
  // F2 on WSL: the Windows process table, timed.
  windowsTasks: { command: 'tasklist.exe', args: ['/NH', '/FO', 'CSV'] },
  // F1 on macOS: LaunchServices starts the shipped no-UI canary, which quits at once.
  // `-g` keeps it in the background and `-j` hidden; nothing is drawn or focused.
  guiCanary: { command: '/usr/bin/open', args: ['-g', '-j', WEDGE_CANARY_APP] },
  // F1 eligibility on macOS: who owns the console. `root` is the login window (no one
  // logged in); another name is someone else's session. A file stat, no GUI involved.
  consoleOwner: { command: '/usr/bin/stat', args: ['-f', '%Su', '/dev/console'] },
  // F2 on macOS: the data.kalloc.1024 kernel zone. Unprivileged, zprint reports the
  // zone's in-use element count and element size (its byte columns read 0 without root).
  kernelZone: { command: '/usr/bin/zprint', args: ['-L', 'data.kalloc.1024'] },
} as const;

export type ReadingName = keyof typeof READ_ONLY_CALLS;
export type ReadOnlyRunner = (name: ReadingName) => Promise<string | null>;

/** One bounded run of a table entry: the output, how long it took, and how it ended. */
export interface ProbeResult {
  ok: boolean;
  stdout: string | null;
  ms: number;
  /** The hard timeout ended it. A completed result for the family that ran it, never "missing". */
  timedOut: boolean;
  /** The error code when it did not succeed: `ENOENT`, `EAGAIN`, an exit code, or null. */
  code: string | number | null;
  /** What the child wrote to stderr, when it ended with an error. Parsed for codes only, never shown. */
  stderr?: string | null;
}

export type ProbeRunner = (name: ReadingName, timeoutMs: number) => Promise<ProbeResult>;

/** The process-spawning seam: execFile in production, a fake in tests. */
export type ExecLike = (
  command: string,
  args: string[],
  options: { timeout: number; killSignal: NodeJS.Signals; maxBuffer: number; env: NodeJS.ProcessEnv },
  callback: (err: Error | null, stdout: string, stderr?: string) => void,
) => unknown;

const defaultExec: ExecLike = (command, args, options, callback) => execFile(command, args, options, (err, stdout, stderr) => callback(err, String(stdout), String(stderr ?? '')));

/**
 * A child stuck in the kernel (uninterruptible sleep) ignores every signal, so
 * execFile's own timeout never fires its callback. This guard settles the call
 * anyway, a short grace after the timeout, as `timedOut` with code `no-exit`.
 */
export const PROBE_EXIT_GRACE_MS = 500;

function runCall(name: ReadingName, timeoutMs: number, tmuxPath?: string, runChild: ExecLike = defaultExec, outstanding?: Set<ReadingName>): Promise<ProbeResult> {
  const call = READ_ONLY_CALLS[name];
  if (!call) return Promise.reject(new Error(`not a read-only call: ${String(name)}`));
  // A child of this probe that never exited is still out there. Starting another
  // would pile up stuck children on a wedged machine, so the stuck one IS the answer.
  if (outstanding?.has(name)) return Promise.resolve({ ok: false, stdout: null, ms: 0, timedOut: true, code: 'previous-still-running' });
  const command = name === 'tmuxSessions' && tmuxPath ? tmuxPath : call.command;
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(r);
    };
    const guard = setTimeout(() => {
      outstanding?.add(name);
      finish({ ok: false, stdout: null, ms: Date.now() - started, timedOut: true, code: 'no-exit' });
    }, timeoutMs + PROBE_EXIT_GRACE_MS);
    guard.unref?.();
    try {
      runChild(command, [...call.args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
        outstanding?.delete(name);
        const ms = Date.now() - started;
        if (!err) { finish({ ok: true, stdout, ms, timedOut: false, code: null }); return; }
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        finish({ ok: false, stdout: null, ms, timedOut: e.killed === true, code: e.code ?? null, stderr: stderr ? stderr.slice(0, 2048) : null });
      });
    } catch (err) {
      // A spawn that throws synchronously (EAGAIN on some platforms) is a completed failure, not a hang.
      finish({ ok: false, stdout: null, ms: Date.now() - started, timedOut: false, code: (err as NodeJS.ErrnoException)?.code ?? 'spawn-error' });
    }
  });
}

/** `tmuxPath` replaces only the tmux executable, so a configured install is found. */
export function makeReadOnlyRunner(tmuxPath?: string): ReadOnlyRunner {
  return async (name) => {
    const r = await runCall(name, 3000, tmuxPath);
    return r.ok ? r.stdout : null;
  };
}

/**
 * The wedge sampler's runner: same table, its own timeout, the outcome kept, and a
 * result guaranteed within the timeout plus a short grace even if the child never exits.
 * At most one stuck child per probe name.
 */
export function makeProbeRunner(runChild: ExecLike = defaultExec): ProbeRunner {
  const outstanding = new Set<ReadingName>();
  return (name, timeoutMs) => runCall(name, timeoutMs, undefined, runChild, outstanding);
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

/** An operator-declared entry: an exact tmux session name, or a prefix ending in `*`. */
export function isDeclaredNonAgent(name: string, declared: string[]): boolean {
  return declared.some((d) => (d.endsWith('*') ? name.startsWith(d.slice(0, -1)) : name === d));
}

/**
 * tmux sessions that belong to no agent in the census. `instar-codex-arm-` is Instar's own and
 * self-closing. Sessions the operator declared as not agent work are left out.
 */
export function foreignTmuxSessions(all: string[] | null, ownSessions: string[], agentNames: string[], nonAgent: string[] = []): string[] | null {
  if (all === null) return null;
  const own = new Set(ownSessions);
  return all.filter((name) => !own.has(name) && !name.startsWith('instar-codex-arm-') && !agentNames.some((a) => name === a || name.startsWith(`${a}-`)) && !isDeclaredNonAgent(name, nonAgent));
}
