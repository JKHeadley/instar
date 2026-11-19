/**
 * Settings for borrowed machines (docs/specs/local-verify-borrowed-unit-slices.md, B and F).
 *
 * Both blocks ship DARK and are never written by config defaults or migration:
 *  - `monitoring.localVerify.helper` (on the helper machine): an absent or malformed block means
 *    the helper role is disabled and its routes answer 404. Only the helper machine's own agent
 *    turns it on, after its owner's yes.
 *  - `monitoring.localVerify.borrowed` (on a run machine): anything but `mode: 'shadow'` is off.
 *
 * Pure.
 */

export interface SandboxSize { cpus: number; memoryGb: number; diskGb: number }

export interface HelperConfig {
  enabled: true;
  reserveCores: number;
  pinnedRepoUrl: string;
  /** owner/repo parsed from pinnedRepoUrl. */
  repo: string;
  pinnedRequesters: string[];
  stopOnBattery: boolean;
  sandbox: SandboxSize;
}

const MACHINE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const REPO_URL_RE = /^https:\/\/github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/;

/**
 * Starting sandbox size (spec B2.2): half the cores, min(8 GB, RAM / 4) of memory, 30 GB of disk.
 * The operator revises them from the recorded ownerCoresMax, the sandbox's peak memory and the
 * owner's word.
 */
export function defaultSandboxSize(hw: { ncpu: number; totalMemGb: number }): SandboxSize {
  return {
    cpus: Math.max(1, Math.floor(hw.ncpu / 2)),
    memoryGb: Math.max(1, Math.min(8, Math.floor(hw.totalMemGb / 4))),
    diskGb: 30,
  };
}

/** A quarter of the cores (4 of 16 on the laptop, the trial value). */
export function defaultReserveCores(ncpu: number): number {
  return Math.max(1, Math.round(ncpu / 4));
}

const posInt = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= max;

/** The helper block, or null (disabled) when absent, not enabled, or malformed in any field. */
export function parseHelperConfig(raw: unknown, hw: { ncpu: number; totalMemGb: number }): HelperConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return null;
  if (typeof r.pinnedRepoUrl !== 'string') return null;
  const m = REPO_URL_RE.exec(r.pinnedRepoUrl.trim());
  if (!m) return null;
  if (!Array.isArray(r.pinnedRequesters) || r.pinnedRequesters.length === 0 || r.pinnedRequesters.length > 8
    || !r.pinnedRequesters.every((x) => typeof x === 'string' && MACHINE_ID_RE.test(x))) return null;
  if (r.stopOnBattery !== undefined && typeof r.stopOnBattery !== 'boolean') return null;
  let reserveCores = defaultReserveCores(hw.ncpu);
  if (r.reserveCores !== undefined) {
    if (typeof r.reserveCores !== 'number' || !Number.isSafeInteger(r.reserveCores) || r.reserveCores < 0 || r.reserveCores >= hw.ncpu) return null;
    reserveCores = r.reserveCores;
  }
  const size = defaultSandboxSize(hw);
  if (r.sandbox !== undefined) {
    // Only a resource object. A string (e.g. the e2e suite's `'test-bypass'` seam name) is
    // malformed here, so production config can never select a non-sandbox runner.
    if (!r.sandbox || typeof r.sandbox !== 'object' || Array.isArray(r.sandbox)) return null;
    const s = r.sandbox as Record<string, unknown>;
    if (Object.keys(s).some((k) => !['cpus', 'memoryGb', 'diskGb'].includes(k))) return null;
    if (s.cpus !== undefined) { if (!posInt(s.cpus, hw.ncpu)) return null; size.cpus = s.cpus; }
    if (s.memoryGb !== undefined) { if (!posInt(s.memoryGb, Math.max(1, Math.floor(hw.totalMemGb)))) return null; size.memoryGb = s.memoryGb; }
    if (s.diskGb !== undefined) { if (!posInt(s.diskGb, 2048)) return null; size.diskGb = s.diskGb; }
  }
  return {
    enabled: true,
    reserveCores,
    pinnedRepoUrl: r.pinnedRepoUrl.trim(),
    repo: `${m[1]}/${m[2]}`,
    pinnedRequesters: [...new Set(r.pinnedRequesters as string[])],
    stopOnBattery: r.stopOnBattery !== false,
    sandbox: size,
  };
}

export interface HelperTarget { machineId: string; url: string }

export interface BorrowedConfig {
  mode: 'off' | 'shadow';
  helpers: HelperTarget[];
  /**
   * The full dry run (spec E): send every eligible file, spread over as many runs as it takes, on
   * trees this machine verified green; its learned entries are tagged `dry-run` and count from one
   * paired failure. Set by the operator at a helper's first enable; off otherwise.
   */
  dryRun?: boolean;
}

/** At most two helpers: the laptop and the Windows PC. */
export const MAX_BORROWED_HELPERS = 2;

/** The run-machine block. Anything but `mode: 'shadow'` with at least one valid helper is off. */
export function parseBorrowedConfig(raw: unknown, selfMachineId: string): BorrowedConfig {
  const off: BorrowedConfig = { mode: 'off', helpers: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return off;
  const r = raw as Record<string, unknown>;
  if (r.mode !== 'shadow') return off;
  const helpers: HelperTarget[] = [];
  for (const h of Array.isArray(r.helpers) ? r.helpers : []) {
    if (!h || typeof h !== 'object') continue;
    const { machineId, url } = h as { machineId?: unknown; url?: unknown };
    if (typeof machineId !== 'string' || !MACHINE_ID_RE.test(machineId) || machineId === selfMachineId) continue;
    if (typeof url !== 'string' || !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(url)) continue;
    if (helpers.some((x) => x.machineId === machineId)) continue;
    helpers.push({ machineId, url: url.replace(/\/$/, '') });
    if (helpers.length >= MAX_BORROWED_HELPERS) break;
  }
  return helpers.length === 0 ? off : { mode: 'shadow', helpers, ...(r.dryRun === true ? { dryRun: true } : {}) };
}

/**
 * Workers allowed by the sandbox's memory: at most 1 per GB (PRACTICE-PHASE DEFAULT, see
 * HELPER_LIMITS.workersPerGb) and never more than its CPUs.
 */
export function sandboxWorkerCeiling(size: SandboxSize, workersPerGb: number): number {
  return Math.max(0, Math.min(size.cpus, Math.floor(size.memoryGb * workersPerGb)));
}
