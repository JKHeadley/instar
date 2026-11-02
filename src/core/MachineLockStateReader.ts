/**
 * Reads the inputs for the honest lock verdict (docs/specs/machine-self-maintenance.md,
 * Part A) and hands them to the pure table in machineMaintenance/lockState.ts.
 *
 * macOS: the packaged desktop helper's `probe`, run with the lock-input switch so it
 * also reports the shield window, screensaver and display sleep, plus
 * `sysadminctl -screenLock status`. Both are reads: the probe takes no permission,
 * captures nothing and sends no input. Linux has no such session here
 * (`not-applicable`); Windows is not covered yet (`unknown`).
 *
 * One read at a time and a short cache, so a busy dashboard cannot stack helper runs.
 */
// RULE 3: EXEMPT — reads the macOS console session from Instar's own desktop helper and sysadminctl; it parses no agent-framework or provider output.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { DEFAULT_MAC_DESKTOP_HELPER } from './MacDesktopHost.js';
import { isWslHost } from './wslPlatform.js';
import {
  EMPTY_LOCK_INPUTS, decideLockState, parsePasswordRequired,
  type LockReadingInputs, type LockVerdict, type PasswordRequired,
} from '../monitoring/machineMaintenance/lockState.js';

const CACHE_MS = 5_000;
const SAMPLE_MAX_AGE_MS = 5_000;

export interface LockStateReport extends LockVerdict {
  platform: NodeJS.Platform;
  readAt: string;
  /** Kept for readers of the old field: the raw flag, never the verdict. */
  screenLocked: boolean | null;
}

export interface MachineLockStateReaderDeps {
  platform?: NodeJS.Platform;
  now?: () => number;
  /** Raw helper probe output (one JSON line), or null when the helper cannot run. */
  runProbe?: () => Promise<string | null>;
  /** Raw `sysadminctl -screenLock status` output (stdout + stderr), or null. */
  runPolicy?: () => Promise<string | null>;
  /** True on Windows-with-WSL, where the session to read is Windows'. */
  wsl?: boolean;
}

const HELPER_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', INSTAR_DESKTOP_LOCKED: '1' };

function defaultProbe(): Promise<string | null> {
  return new Promise((resolve) => {
    if (!fs.existsSync(DEFAULT_MAC_DESKTOP_HELPER)) { resolve(null); return; }
    execFile(DEFAULT_MAC_DESKTOP_HELPER, ['probe'], { timeout: 3_000, maxBuffer: 16_384, env: HELPER_ENV },
      (err, stdout) => resolve(err ? null : stdout));
  });
}

function defaultPolicy(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/usr/sbin/sysadminctl', ['-screenLock', 'status'], { timeout: 3_000, maxBuffer: 16_384 },
      (err, stdout, stderr) => resolve(err ? null : `${stdout}${stderr}`));
  });
}

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** Builds the table inputs from the helper's probe line. A stale or partial sample reads as unreadable. */
export function inputsFromProbe(raw: string | null, policy: PasswordRequired, nowMs: number): LockReadingInputs {
  if (raw === null) return { ...EMPTY_LOCK_INPUTS, passwordRequired: policy };
  let probe: Record<string, unknown>;
  try { probe = JSON.parse(raw.trim()) as Record<string, unknown>; }
  catch { return { ...EMPTY_LOCK_INPUTS, passwordRequired: policy }; } // @silent-fallback-ok — an unparseable probe is every input unreadable, so the verdict is unknown.
  const lock = probe.lockInputs && typeof probe.lockInputs === 'object' ? probe.lockInputs as Record<string, unknown> : null;
  const fresh = lock !== null && typeof lock.sampledAtMs === 'number' && Math.abs(nowMs - lock.sampledAtMs) <= SAMPLE_MAX_AGE_MS;
  const console = bool(probe.consoleSessionPresent);
  const onConsole = bool(probe.onConsole);
  return {
    flagLocked: bool(probe.screenLocked),
    passwordRequired: policy,
    screensaverRunning: fresh ? bool(lock!.screensaver) : null,
    displayAsleep: fresh ? bool(lock!.displayAsleep) : null,
    lockShieldSeen: fresh ? bool(lock!.shieldWindow) : null,
    consoleSession: console === null || onConsole === null ? null : console && onConsole,
    loginDone: bool(probe.loginDone),
  };
}

export class MachineLockStateReader {
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly runProbe: () => Promise<string | null>;
  private readonly runPolicy: () => Promise<string | null>;
  private readonly wsl: boolean;
  private cached: { at: number; report: LockStateReport } | null = null;
  private inflight: Promise<LockStateReport> | null = null;

  constructor(deps: MachineLockStateReaderDeps = {}) {
    this.platform = deps.platform ?? process.platform;
    this.now = deps.now ?? Date.now;
    this.runProbe = deps.runProbe ?? defaultProbe;
    this.runPolicy = deps.runPolicy ?? defaultPolicy;
    this.wsl = deps.wsl ?? isWslHost(this.platform);
  }

  read(): Promise<LockStateReport> {
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return Promise.resolve(this.cached.report);
    if (this.inflight) return this.inflight;
    this.inflight = this.readNow().then((report) => {
      this.cached = { at: this.now(), report };
      return report;
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async readNow(): Promise<LockStateReport> {
    const readAt = new Date(this.now()).toISOString();
    if (this.platform !== 'darwin') {
      const notApplicable = this.platform === 'linux' && !this.wsl;
      return {
        lockState: notApplicable ? 'not-applicable' : 'unknown', row: 0,
        reason: notApplicable ? 'no console lock session is read on Linux' : 'this platform does not read its own lock state yet',
        inputs: { ...EMPTY_LOCK_INPUTS }, platform: this.platform, readAt, screenLocked: null,
      };
    }
    const [probe, policyRaw] = await Promise.all([
      this.runProbe().catch(() => null), // @silent-fallback-ok — an unreadable input makes the verdict unknown, with the reason
      this.runPolicy().catch(() => null), // @silent-fallback-ok — an unreadable input makes the verdict unknown, with the reason
    ]);
    const inputs = inputsFromProbe(probe, policyRaw === null ? null : parsePasswordRequired(policyRaw), this.now());
    const verdict = decideLockState(inputs);
    return {
      ...verdict,
      reason: probe === null ? `desktop helper unavailable; ${verdict.reason}` : verdict.reason,
      platform: this.platform, readAt, screenLocked: inputs.flagLocked,
    };
  }
}

let active: MachineLockStateReader | null = null;
export function setActiveMachineLockStateReader(reader: MachineLockStateReader | null): void { active = reader; }
export function getActiveMachineLockStateReader(): MachineLockStateReader | null { return active; }
