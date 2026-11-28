/**
 * A sleeping display is not a lock (macOS).
 *
 * The desktop helper reads the session flag `CGSSessionScreenIsLocked`, which
 * display sleep sets on some Macs with no password in force: on 2026-11-27 the
 * Studio read the flag true while `IOConsoleLocked` was false, and three seconds
 * of declared user activity cleared the flag with no password. The helper's
 * flag is one input, never the answer (see machineMaintenance/lockState.ts).
 *
 * This reads macOS's own console lock and, only when it says "not locked",
 * declares user activity so the display wakes, as a person moving the mouse
 * would. A locked or unreadable console is never woken. The caller decides
 * when to call it: at admission only, at most once per attempt.
 */
import { execFile, spawn } from 'node:child_process';

export type DisplayWakeResult = 'woke' | 'console-locked' | 'unknown';

const IOREG = '/usr/sbin/ioreg';
const CAFFEINATE = '/usr/bin/caffeinate';
const IOREG_TIMEOUT_MS = 2_000;
/** The Root plist is about 185 KB on a Mac Studio; a larger registry must not read as unknown. */
const IOREG_MAX_BYTES = 4 * 1024 * 1024;

/**
 * `IOConsoleLocked` from `ioreg -n Root -d1 -a`. Only the Root entry's own key
 * counts (one tab of indent); a nested key of the same name never answers.
 * Null when absent or not a plain boolean.
 */
export function parseConsoleLocked(plist: string): boolean | null {
  const match = /^\t<key>IOConsoleLocked<\/key>\r?\n\t<(true|false)\/>$/m.exec(plist);
  return match ? match[1] === 'true' : null;
}

export interface DisplayWakePorts {
  /** The Root entry of the IORegistry as an XML plist. */
  readIoreg(): Promise<string>;
  /** Declare user activity for about 3 s. Resolves once it has started. */
  declareActivity(): Promise<void>;
}

/** A test run never reads or wakes the real display unless it opts in, like the real helper. */
export function realDisplayWakeBlockedUnderTest(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VITEST) && env.INSTAR_REAL_DESKTOP_HELPER_TESTS !== '1';
}

export const macDisplayWakePorts: DisplayWakePorts = {
  readIoreg: () => new Promise((resolve, reject) => {
    if (realDisplayWakeBlockedUnderTest()) { reject(new Error('mac-display-wake-blocked-under-test')); return; }
    execFile(IOREG, ['-n', 'Root', '-d1', '-a'], { timeout: IOREG_TIMEOUT_MS, maxBuffer: IOREG_MAX_BYTES, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)));
  }),
  declareActivity: () => new Promise((resolve, reject) => {
    if (realDisplayWakeBlockedUnderTest()) { reject(new Error('mac-display-wake-blocked-under-test')); return; }
    // caffeinate exits by itself after 3 s; nothing waits on it or kills it.
    const child = spawn(CAFFEINATE, ['-u', '-t', '3'], { stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => resolve());
    child.unref();
  }),
};

export class MacDisplayWake {
  constructor(private readonly ports: DisplayWakePorts = macDisplayWakePorts) {}

  /** `woke` means activity was declared; the caller probes again to see the result. */
  async wake(): Promise<DisplayWakeResult> {
    let plist: string;
    try { plist = await this.ports.readIoreg(); } catch { return 'unknown'; } // @silent-fallback-ok — unreadable is reported as `unknown`, which refuses as before and is audited by the caller.
    const locked = parseConsoleLocked(plist);
    if (locked !== false) return locked ? 'console-locked' : 'unknown';
    try { await this.ports.declareActivity(); } catch { return 'unknown'; } // @silent-fallback-ok — a wake that could not start is reported as `unknown` and audited by the caller.
    return 'woke';
  }
}
