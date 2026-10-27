/**
 * ThrowawayAgentGuard — keeps a throwaway (test / release-check) agent from
 * becoming a permanent job on the operator's real login.
 *
 * Incident 2026-10-21..26 (spec: docs/specs/test-agent-leak-guard.md). A
 * release-check script ran `instar init` with HOME sandboxed to a temp folder
 * and started a foreground server. The server's autostart self-heal wrote a
 * plist under the fake HOME and `launchctl bootstrap`ped it into the REAL user
 * launchd (the launchd domain belongs to the macOS user, not to $HOME). launchd
 * then ran the agent with the ACCOUNT's HOME, whose self-heal wrote a second
 * plist into the real ~/Library/LaunchAgents. The throwaway then ran scheduled
 * jobs on the operator's Claude subscription for five days.
 *
 * Every function here is deterministic and takes its inputs injectably so the
 * decision boundaries are unit-testable without touching the real machine.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { withSyncOp } from './InFlightSyncOpMarker.js';

export type ThrowawayReason = 'home-sandboxed' | 'project-under-temp' | 'recorded';

export interface ThrowawayRecord {
  createdAt: string;
  expiresAt?: string;
  reasons?: string[];
  /** --keep: explicit exemption from expiry and from the boot backfill. */
  keep?: boolean;
}

export interface LocationClassification {
  throwaway: boolean;
  reasons: ThrowawayReason[];
}

/** Default lifetime of a throwaway agent recorded at init. */
export const DEFAULT_THROWAWAY_TTL_MS = 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** realpath when possible; a missing/unreadable path compares by path.resolve. */
export function canonicalPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The account's home from the user database (what launchd and the macOS
 * Keychain use). Falls back to os.homedir() when userInfo() is unavailable.
 * Used ONLY for comparison and for locating this agent's own autostart files —
 * never as a place to write new ones.
 */
export function accountHomeDir(): string {
  try {
    const h = os.userInfo().homedir;
    if (h) return h;
  } catch { /* @silent-fallback-ok — userInfo unavailable (no passwd entry); os.homedir is the only other source */ }
  return os.homedir();
}

/** True when $HOME is not the account's real home. */
export function isHomeSandboxed(
  env: NodeJS.ProcessEnv = process.env,
  accountHome: string = accountHomeDir(),
): boolean {
  const home = env.HOME;
  if (!home) return false;
  return canonicalPath(home) !== canonicalPath(accountHome);
}

/**
 * The FIXED OS temp roots. $TMPDIR and os.tmpdir() are deliberately not roots:
 * a user may set TMPDIR inside their home, and a launchd/systemd-supervised
 * process may not inherit it, so the same agent would classify differently
 * from the CLI and from its supervisor. (On macOS os.tmpdir() is under
 * /var/folders anyway.) A Claude Code scratchpad lives under /private/tmp.
 */
export const FIXED_TEMP_ROOTS: readonly string[] = [
  '/tmp', '/private/tmp', '/var/folders', '/private/var/folders', '/var/tmp', '/private/var/tmp', '/dev/shm',
];

export function tempRoots(accountHome: string = accountHomeDir()): string[] {
  const home = canonicalPath(accountHome);
  const roots = new Set<string>();
  for (const p of FIXED_TEMP_ROOTS) {
    roots.add(p);
    roots.add(canonicalPath(p));
  }
  // A root that is, or contains, the account home would classify every agent.
  for (const r of [...roots]) {
    if (isWithin(home, r)) roots.delete(r);
  }
  return [...roots];
}

function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** True when the path resolves under an OS temp root. */
export function isUnderTempRoot(p: string, accountHome: string = accountHomeDir()): boolean {
  const candidates = [path.resolve(p), canonicalPath(p)];
  const roots = tempRoots(accountHome);
  return candidates.some((c) => roots.some((r) => isWithin(c, r)));
}

export function classifyLocation(opts: {
  projectDir: string;
  env?: NodeJS.ProcessEnv;
  accountHome?: string;
  record?: ThrowawayRecord | null;
}): LocationClassification {
  const env = opts.env ?? process.env;
  const accountHome = opts.accountHome ?? accountHomeDir();
  const reasons: ThrowawayReason[] = [];
  if (isHomeSandboxed(env, accountHome)) reasons.push('home-sandboxed');
  if (isUnderTempRoot(opts.projectDir, accountHome)) reasons.push('project-under-temp');
  // Only a record carrying an expiry is the `recorded` reason; a `keep`
  // record is an explicit exemption from expiry, not a throwaway marker.
  if (opts.record && opts.record.expiresAt !== undefined && !opts.record.keep) reasons.push('recorded');
  return { throwaway: reasons.length > 0, reasons };
}

/** Parse "30m" / "6h" / "2d" / "90s" into ms, clamped to [1 minute, 30 days]. */
export function parseTtl(input: string): number | null {
  const m = /^\s*(\d+)\s*([smhd])\s*$/i.exec(input);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, n * mult));
}

/**
 * True when the recorded expiry has passed. A record whose expiresAt is
 * missing or unparseable counts as expired: the record is only ever written
 * for a throwaway, and the least-harmful reading of a broken deadline is stop.
 */
export function isThrowawayExpired(record: ThrowawayRecord | null | undefined, now: number = Date.now()): boolean {
  if (!record || record.keep) return false;
  if (!record.expiresAt) return true;
  const t = Date.parse(record.expiresAt);
  if (!Number.isFinite(t)) return true;
  return t <= now;
}

// ── Autostart ownership ────────────────────────────────────────

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The WorkingDirectory a launchd plist or systemd unit declares, or null. */
export function autostartWorkingDirectory(content: string): string | null {
  const plist = /<key>\s*WorkingDirectory\s*<\/key>\s*<string>([^<]*)<\/string>/.exec(content);
  if (plist) return xmlUnescape(plist[1]);
  const unit = /^\s*WorkingDirectory\s*=\s*(.+?)\s*$/m.exec(content);
  if (unit) return unit[1];
  return null;
}

/** True only when the unit's WorkingDirectory IS this projectDir (canonical equality). */
export function autostartBelongsTo(content: string, projectDir: string): boolean {
  const wd = autostartWorkingDirectory(content);
  if (!wd) return false;
  return canonicalPath(wd) === canonicalPath(projectDir);
}

export interface AutostartFile {
  kind: 'launchd' | 'systemd';
  path: string;
  label: string;
}

/** Candidate autostart files for a project under both $HOME and the account home. */
export function ownAutostartCandidates(
  projectName: string,
  opts: { platform?: NodeJS.Platform; homes?: string[] } = {},
): AutostartFile[] {
  const platform = opts.platform ?? process.platform;
  const homes = [...new Set((opts.homes ?? [os.homedir(), accountHomeDir()]).map((h) => path.resolve(h)))];
  const out: AutostartFile[] = [];
  for (const home of homes) {
    if (platform === 'darwin') {
      const label = `ai.instar.${projectName}`;
      out.push({ kind: 'launchd', label, path: path.join(home, 'Library', 'LaunchAgents', `${label}.plist`) });
    } else if (platform === 'linux') {
      const label = `instar-${projectName}.service`;
      out.push({ kind: 'systemd', label, path: path.join(home, '.config', 'systemd', 'user', label) });
    }
  }
  return out;
}

// ── Autostart install refusal (read by the installAutoStart funnel) ──

let lastAutoStartRefusal: string | null = null;

export function setLastAutoStartRefusal(reason: string | null): void {
  lastAutoStartRefusal = reason;
}

/** The reason the most recent installAutoStart call refused, cleared on read. */
export function takeLastAutoStartRefusal(): string | null {
  const r = lastAutoStartRefusal;
  lastAutoStartRefusal = null;
  return r;
}

/**
 * The funnel's decision. Refuse when the location is a throwaway, unless the
 * caller explicitly forces it. Reading the agent's own config for a recorded
 * throwaway marker is best-effort: an unreadable config adds no reason.
 */
export function autoStartRefusalReason(
  projectDir: string,
  opts: { force?: boolean; env?: NodeJS.ProcessEnv; accountHome?: string } = {},
): string | null {
  if (opts.force) return null;
  if (fs.existsSync(expiredMarkerPath(projectDir))) {
    return 'this throwaway agent has expired and tore itself down: auto-start is not reinstalled. Pass --force to revive it.';
  }
  const record = readThrowawayRecord(projectDir);
  const c = classifyLocation({ projectDir, env: opts.env, accountHome: opts.accountHome, record });
  if (!c.throwaway) return null;
  return `throwaway agent (${c.reasons.join(', ')}): auto-start is not installed for an agent that lives in a temporary folder or runs with a sandboxed HOME. Pass --force to install it anyway.`;
}

export function readThrowawayRecord(projectDir: string): ThrowawayRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(projectDir, '.instar', 'config.json'), 'utf-8'));
    const rec = raw?.throwawayAgent;
    if (rec && typeof rec === 'object' && typeof rec.createdAt === 'string') return rec as ThrowawayRecord;
  } catch { /* @silent-fallback-ok — no config yet / unreadable: no recorded marker */ }
  return null;
}

// ── Scheduler guard ───────────────────────────────────────────

export interface ThrowawayJobGuardResult {
  refuse: boolean;
  reason?: string;
}

/**
 * Builds the guard server.ts hands to the JobScheduler. Jobs are refused for a
 * temp-folder project or a recorded throwaway — NOT for a sandboxed HOME alone
 * (a real agent can legitimately run with HOME set by a unit, sudo -E or a
 * container). Instar cannot prove a session would NOT reach the operator's real
 * login (the macOS Keychain credential is per user, not per HOME), so every
 * login is treated as real; `scheduler.allowOnThrowawayAgent: true` is the only
 * way through. The location is computed once (it cannot change while the
 * process runs); the record is re-read per call (one small file read).
 */
export function buildThrowawayJobGuard(opts: {
  projectDir: string;
  allowOnThrowawayAgent?: boolean;
  accountHome?: string;
}): () => ThrowawayJobGuardResult {
  const underTemp = isUnderTempRoot(opts.projectDir, opts.accountHome ?? accountHomeDir());
  return () => {
    if (opts.allowOnThrowawayAgent === true) return { refuse: false };
    const reasons: string[] = [];
    if (underTemp) reasons.push('project-under-temp');
    const record = readThrowawayRecord(opts.projectDir);
    if (record && record.expiresAt !== undefined && !record.keep) reasons.push('recorded');
    if (reasons.length === 0) return { refuse: false };
    return {
      refuse: true,
      reason: `throwaway agent (${reasons.join(', ')}) — scheduled jobs are refused so they cannot spend a real subscription login; set scheduler.allowOnThrowawayAgent: true to override`,
    };
  };
}

// ── Config records (init + boot) ──────────────────────────────

function configPath(projectDir: string): string {
  return path.join(projectDir, '.instar', 'config.json');
}

function patchConfig(projectDir: string, patch: (cfg: Record<string, unknown>) => boolean): boolean {
  const p = configPath(projectDir);
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { /* @silent-fallback-ok — missing or invalid config cannot boot an agent; the temp-location install and job guards still refuse it */
    return false;
  }
  if (!patch(cfg)) return false;
  SafeFsExecutor.atomicWriteJsonSync(p, cfg, { operation: 'src/core/ThrowawayAgentGuard.ts:patchConfig' });
  return true;
}

export interface InitPostureInput {
  projectDir: string;
  interactive: boolean;
  autostartFlag?: boolean;
  keep?: boolean;
  expiresIn?: string;
  env?: NodeJS.ProcessEnv;
  accountHome?: string;
  now?: Date;
}

export interface InitPosture {
  autostart?: { autoInstall: false; reason: string };
  throwawayAgent?: ThrowawayRecord;
}

/** Pure: what `instar init` records for a NEWLY created config. */
export function decideInitPosture(input: InitPostureInput): InitPosture {
  if (input.keep && input.expiresIn) {
    throw new Error('--keep and --expires-in contradict each other; pass one');
  }
  const now = input.now ?? new Date();
  const c = classifyLocation({ projectDir: input.projectDir, env: input.env, accountHome: input.accountHome });
  const out: InitPosture = {};
  if (!input.autostartFlag && (!input.interactive || c.throwaway)) {
    out.autostart = {
      autoInstall: false,
      reason: c.throwaway ? `throwaway location (${c.reasons.join(', ')})` : 'non-interactive init',
    };
  }
  if (input.keep) {
    out.throwawayAgent = { createdAt: now.toISOString(), keep: true };
  } else if (input.expiresIn || c.reasons.includes('project-under-temp')) {
    // A sandboxed HOME alone (e.g. `sudo -E`, a container, a provisioning
    // script) is not proof the agent is disposable: it only blocks autostart.
    // An expiry needs a temp-folder project or an explicit --expires-in.
    let ttl = DEFAULT_THROWAWAY_TTL_MS;
    if (input.expiresIn) {
      const parsed = parseTtl(input.expiresIn);
      if (parsed === null) throw new Error(`--expires-in must look like 30m, 6h or 2d (got "${input.expiresIn}")`);
      ttl = parsed;
    }
    out.throwawayAgent = {
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttl).toISOString(),
      reasons: c.reasons.includes('project-under-temp') ? c.reasons : ['expires-in'],
    };
  }
  return out;
}

export function applyInitPosture(projectDir: string, posture: InitPosture): boolean {
  if (!posture.autostart && !posture.throwawayAgent) return false;
  return patchConfig(projectDir, (cfg) => {
    if (posture.autostart) cfg.autostart = posture.autostart;
    if (posture.throwawayAgent) cfg.throwawayAgent = posture.throwawayAgent;
    return true;
  });
}

/**
 * Boot backfill: an agent whose project is under a temp root and that has no
 * record at all (neither an expiry nor a keep) gets a 24h expiry. This is what
 * stops agents that leaked before this release. Never for home-sandboxed alone.
 */
export function backfillThrowawayRecord(projectDir: string, opts: { accountHome?: string; now?: Date } = {}): ThrowawayRecord | null {
  if (!isUnderTempRoot(projectDir, opts.accountHome ?? accountHomeDir())) return null;
  if (readThrowawayRecord(projectDir)) return null;
  const now = opts.now ?? new Date();
  const record: ThrowawayRecord = {
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + DEFAULT_THROWAWAY_TTL_MS).toISOString(),
    reasons: ['project-under-temp', 'boot-backfill'],
  };
  const ok = patchConfig(projectDir, (cfg) => {
    if (cfg.throwawayAgent) return false;
    cfg.throwawayAgent = record;
    return true;
  });
  return ok ? record : null;
}

/** An explicit install (CLI / join) succeeded: record the operator's ask. */
export function markAutoStartExplicit(projectDir: string, opts: { forced?: boolean } = {}): void {
  patchConfig(projectDir, (cfg) => {
    const current = cfg.autostart as { autoInstall?: boolean } | undefined;
    let changed = false;
    if (!current || current.autoInstall !== true) {
      cfg.autostart = { autoInstall: true, reason: opts.forced ? 'explicit install (--force)' : 'explicit install' };
      changed = true;
    }
    // A forced install after expiry is the operator reviving the agent.
    if (opts.forced) {
      const rec = cfg.throwawayAgent as ThrowawayRecord | undefined;
      if (rec && rec.expiresAt !== undefined && !rec.keep) {
        delete cfg.throwawayAgent;
        changed = true;
      }
    }
    return changed;
  });
  if (opts.forced) {
    const marker = expiredMarkerPath(projectDir);
    try { if (fs.existsSync(marker)) SafeFsExecutor.safeUnlinkSync(marker, { operation: 'src/core/ThrowawayAgentGuard.ts:markAutoStartExplicit' }); } catch { /* @silent-fallback-ok — a stale marker only makes the next start re-check */ }
  }
}

// ── Teardown: lock ────────────────────────────────────────────

export function expiredMarkerPath(projectDir: string): string {
  return path.join(projectDir, '.instar', 'state', 'throwaway-expired.json');
}

function lockPath(projectDir: string): string {
  return path.join(projectDir, '.instar', 'state', 'throwaway-teardown.lock');
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Run fn under the per-agent teardown lock. Returns { ran: false } when another
 * LIVE process holds it. A lock whose pid is dead is taken over — never by age,
 * so a paused live owner keeps it.
 */
export function withTeardownLock<T>(
  projectDir: string,
  fn: () => T,
  deps: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): { ran: true; value: T } | { ran: false } {
  const acquired = acquireTeardownLock(projectDir, deps);
  if (acquired === 'busy') return { ran: false };
  // fn runs exactly once, outside any catch: its own errors propagate unchanged
  // and are never mistaken for lock contention.
  try {
    return { ran: true, value: fn() };
  } finally {
    if (acquired === 'held') {
      try { SafeFsExecutor.safeUnlinkSync(lockPath(projectDir), { operation: 'src/core/ThrowawayAgentGuard.ts:withTeardownLock' }); } catch { /* @silent-fallback-ok — a leftover lock is taken over once our pid is gone */ }
    }
  }
}

/** 'held' = we own the lock; 'unlocked' = no lock is possible here (run anyway); 'busy' = a live holder. */
function acquireTeardownLock(
  projectDir: string,
  deps: { pid?: number; isAlive?: (pid: number) => boolean },
): 'held' | 'unlocked' | 'busy' {
  const lp = lockPath(projectDir);
  const pid = deps.pid ?? process.pid;
  const isAlive = deps.isAlive ?? pidAlive;
  try {
    fs.mkdirSync(path.dirname(lp), { recursive: true });
  } catch {
    // @silent-fallback-ok — an unwritable state dir must not turn installAutoStart
    // into a throw; with nowhere to hold a lock there is nowhere a teardown runs from.
    return 'unlocked';
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lp, String(pid), { flag: 'wx' });
      return 'held';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return 'unlocked'; // @silent-fallback-ok — EACCES/EROFS: run unlocked, as before this guard
      let holder = NaN;
      try { holder = Number(fs.readFileSync(lp, 'utf-8').trim()); } catch { /* @silent-fallback-ok — unreadable holder treated as dead */ }
      if (holder !== pid && isAlive(holder)) return 'busy';
      try { SafeFsExecutor.safeUnlinkSync(lp, { operation: 'src/core/ThrowawayAgentGuard.ts:withTeardownLock:takeover' }); } catch { /* @silent-fallback-ok — raced with another taker; retry below */ }
    }
  }
  return 'busy';
}

// ── Teardown ──────────────────────────────────────────────────

export type TeardownOutcome = 'complete' | 'retryable' | 'quarantined';
export const MAX_TEARDOWN_ATTEMPTS = 5;

export interface PendingUnit {
  kind: 'launchd' | 'systemd';
  label: string;
  path: string;
  state: 'pending' | 'deleted' | 'dropped';
}

export interface ExpiredMarker {
  expiredAt: string;
  outcome: TeardownOutcome;
  attempts: number;
  units: PendingUnit[];
  unloaded: boolean;
  errors: string[];
}

export interface TeardownDeps {
  readFile?: (p: string) => string;
  exists?: (p: string) => boolean;
  unlink?: (p: string) => void;
  /** Runs launchctl/systemctl and returns stdout. Never runs under a test runner unless injected. */
  run?: (cmd: string, args: string[]) => string;
  platform?: NodeJS.Platform;
  homes?: string[];
  uid?: number;
  now?: () => Date;
  lock?: typeof withTeardownLock;
}

export function readExpiredMarker(projectDir: string): ExpiredMarker | null {
  try {
    const m = JSON.parse(fs.readFileSync(expiredMarkerPath(projectDir), 'utf-8'));
    if (m && typeof m === 'object' && typeof m.outcome === 'string') return m as ExpiredMarker;
    // A marker we cannot read still means "expired"; start a fresh teardown record.
    return { expiredAt: new Date().toISOString(), outcome: 'retryable', attempts: 0, units: [], unloaded: false, errors: ['marker unparseable'] };
  } catch (err) { /* @silent-fallback-ok — an unreadable marker is treated as expired and retried, never as permission to run */
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return { expiredAt: new Date().toISOString(), outcome: 'retryable', attempts: 0, units: [], unloaded: false, errors: ['marker unreadable'] };
  }
}

function writeMarker(projectDir: string, m: ExpiredMarker): void {
  const p = expiredMarkerPath(projectDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  SafeFsExecutor.atomicWriteJsonSync(p, m, { operation: 'src/core/ThrowawayAgentGuard.ts:writeMarker' });
}

/** The top-level `working directory = <path>` of `launchctl print` output. */
export function launchctlWorkingDirectory(printOutput: string): string | null {
  const matches = [...printOutput.matchAll(/^\t(?:working directory) = (.+)$/gm)];
  if (matches.length !== 1) return null; // missing or ambiguous → not provably ours
  return matches[0][1].trim();
}

/**
 * Tear down an expired throwaway's OWN autostart (spec section 3):
 * marker first (ownership decided once and persisted) → delete every owned
 * file → unload the label once, only when the LOADED job's working directory
 * is this projectDir → outcome. Serialized by the teardown lock; a caller that
 * cannot take it returns null (the holder is doing it).
 */
export function teardownExpiredThrowaway(
  projectName: string,
  projectDir: string,
  deps: TeardownDeps = {},
): ExpiredMarker | null {
  const lock = deps.lock ?? withTeardownLock;
  const r = lock(projectDir, () => teardownUnlocked(projectName, projectDir, deps));
  return r.ran ? r.value : null;
}

function teardownUnlocked(projectName: string, projectDir: string, deps: TeardownDeps): ExpiredMarker {
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf-8'));
  const exists = deps.exists ?? ((p: string) => fs.existsSync(p));
  const unlink = deps.unlink ?? ((p: string) => SafeFsExecutor.safeUnlinkSync(p, { operation: 'src/core/ThrowawayAgentGuard.ts:teardown' }));
  const liveAllowed = !process.env.VITEST && !process.env.INSTAR_SKIP_LAUNCHCTL_LOAD;
  const run = deps.run ?? (liveAllowed
    ? (cmd: string, args: string[]) => withSyncOp(() => execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }))
    : () => { throw new Error('test runner: launchctl/systemctl not run'); });
  const platform = deps.platform ?? process.platform;
  const uid = deps.uid ?? (process.getuid?.() ?? 501);
  const now = deps.now ?? (() => new Date());

  const existing = readExpiredMarker(projectDir);
  if (existing && existing.outcome !== 'retryable') return existing;

  const marker: ExpiredMarker = existing ?? {
    expiredAt: now().toISOString(), outcome: 'retryable', attempts: 0, units: [], unloaded: false, errors: [],
  };
  marker.errors = [];

  // Step 1–2: decide ownership of files found now, persist before acting.
  for (const unit of ownAutostartCandidates(projectName, { platform, homes: deps.homes })) {
    if (marker.units.some((u) => u.path === unit.path)) continue;
    if (!exists(unit.path)) continue;
    let content: string;
    try { content = readFile(unit.path); } catch { marker.errors.push(`${unit.path}: unreadable, left alone`); continue; }
    if (!autostartBelongsTo(content, projectDir)) continue;
    marker.units.push({ kind: unit.kind, label: unit.label, path: unit.path, state: 'pending' });
  }
  writeMarker(projectDir, marker);

  // Step 3: delete every owned file (re-checking ownership) before any unload.
  for (const u of marker.units) {
    if (u.state !== 'pending') continue;
    if (exists(u.path)) {
      let still = false;
      try { still = autostartBelongsTo(readFile(u.path), projectDir); } catch { still = false; }
      if (!still) { u.state = 'dropped'; continue; }
      try {
        if (u.kind === 'systemd') { try { run('systemctl', ['--user', 'disable', u.label]); } catch { /* @silent-fallback-ok — not enabled */ } }
        unlink(u.path);
        u.state = 'deleted';
      } catch (err) {
        marker.errors.push(`${u.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      u.state = 'deleted';
    }
  }
  writeMarker(projectDir, marker);

  // Step 4–5: unload once, outcome. The expected label is ALWAYS checked: a
  // job can stay loaded after its plist was deleted (a temp folder cleaned by
  // the OS). Unloading our OWN launchd job kills this process, so the outcome
  // the unload would produce is written FIRST and corrected on failure.
  const filesDone = marker.units.every((u) => u.state !== 'pending');
  marker.attempts += 1;
  const settle = (unloaded: boolean): void => {
    marker.unloaded = unloaded;
    if (filesDone && unloaded) marker.outcome = 'complete';
    else marker.outcome = marker.attempts >= MAX_TEARDOWN_ATTEMPTS ? 'quarantined' : 'retryable';
    writeMarker(projectDir, marker);
  };
  if (marker.unloaded) {
    settle(true);
    return marker;
  }
  settle(true); // optimistic: if the unload kills us, this is what it achieved
  const unloaded = unloadOwnJob(projectName, projectDir, { run, platform, uid }, marker.errors);
  if (!unloaded) settle(false);
  return marker;
}

/** true = nothing of ours is loaded any more (unloaded, or none was loaded / not ours). */
function unloadOwnJob(
  projectName: string,
  projectDir: string,
  ctx: { run: (cmd: string, args: string[]) => string; platform: NodeJS.Platform; uid: number },
  errors: string[],
): boolean {
  const want = canonicalPath(projectDir);
  if (ctx.platform === 'darwin') {
    const label = `ai.instar.${projectName}`;
    const target = `gui/${ctx.uid}/${label}`;
    let out: string;
    try {
      out = ctx.run('launchctl', ['print', target]);
    } catch {
      return true; // not loaded
    }
    const wd = launchctlWorkingDirectory(out);
    if (!wd || canonicalPath(wd) !== want) return true; // loaded, but not provably ours: leave it
    try { ctx.run('launchctl', ['disable', target]); } catch { /* @silent-fallback-ok — bootout below is what matters */ }
    try {
      /* @self-action-controller: throwaway-expiry-teardown */
      ctx.run('launchctl', ['bootout', target]);
      return true;
    } catch (err) {
      errors.push(`launchctl bootout ${label}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  if (ctx.platform === 'linux') {
    const unit = `instar-${projectName}.service`;
    let wd: string;
    try {
      wd = ctx.run('systemctl', ['--user', 'show', '-p', 'WorkingDirectory', '--value', unit]).trim();
    } catch { /* @silent-fallback-ok — no readable user unit; an expired server still exits before starting jobs */
      return true; // no user systemd / not loaded
    }
    if (!wd || canonicalPath(wd) !== want) return true;
    try { ctx.run('systemctl', ['--user', 'daemon-reload']); } catch { /* @silent-fallback-ok — stop below is what matters */ }
    try {
      ctx.run('systemctl', ['--user', 'stop', unit]);
      return true;
    } catch (err) { /* @silent-fallback-ok — recorded below and returned false for bounded retry, then quarantine */
      errors.push(`systemctl stop ${unit}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  return true;
}

// ── Expiry check shared by server + lifeline ──────────────────

export interface ExpiryCheck {
  expired: boolean;
  marker: ExpiredMarker | null;
}

/**
 * Should this process stop because the agent expired? True when a marker exists
 * or the record has expired. Runs the (idempotent, locked) teardown when needed.
 * Returns marker=null when another process holds the teardown lock.
 */
export function checkThrowawayExpiry(
  projectName: string,
  projectDir: string,
  deps: TeardownDeps & { now?: () => Date } = {},
): ExpiryCheck {
  const marker = readExpiredMarker(projectDir);
  const record = readThrowawayRecord(projectDir);
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  if (!marker && !isThrowawayExpired(record, nowMs)) return { expired: false, marker: null };
  if (marker && marker.outcome !== 'retryable') return { expired: true, marker };
  return { expired: true, marker: teardownExpiredThrowaway(projectName, projectDir, deps) };
}

/** One sentence for the log line printed on expiry. */
export function describeExpiry(c: ExpiryCheck): string {
  const o = c.marker?.outcome ?? 'in-progress-elsewhere';
  return `This throwaway agent expired (teardown: ${o}). It removed its own auto-start and will not run again. Delete .instar/state/throwaway-expired.json and the throwawayAgent config field to revive it.`;
}

export type StartupDecision = 'run' | 'exit' | 'idle';

/**
 * The single outcome handler's decision (spec section 3, "One outcome
 * handler"). Called first thing by the server and the lifeline:
 *   - not expired → backfill a record for a temp-folder agent, then 'run';
 *   - expired, teardown complete / retryable / held elsewhere → 'exit' (0);
 *   - quarantined (5 failed unloads) → 'idle': start nothing and stay up, so
 *     launchd KeepAlive cannot turn a stuck unload into a restart loop.
 */
export function throwawayStartupDecision(
  projectName: string,
  projectDir: string,
  deps: TeardownDeps = {},
): { decision: StartupDecision; check: ExpiryCheck; backfilled: ThrowawayRecord | null } {
  const check = checkThrowawayExpiry(projectName, projectDir, deps);
  if (!check.expired) {
    let backfilled: ThrowawayRecord | null = null;
    try { backfilled = backfillThrowawayRecord(projectDir, { now: deps.now?.() }); } catch { /* @silent-fallback-ok — the scheduler gate still refuses a temp-folder agent */ }
    return { decision: 'run', check, backfilled };
  }
  return { decision: check.marker?.outcome === 'quarantined' ? 'idle' : 'exit', check, backfilled: null };
}
