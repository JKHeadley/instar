/**
 * Browser and window care, watch-only (docs/specs/machine-self-maintenance.md, Part B).
 *
 * The ledger of the normal-Chrome browsers this agent opened, and a 15-minute sweep
 * that decides, by the spec's rules, which of them it WOULD close. This build closes
 * nothing: it has no way to signal a process, and
 * `tests/unit/machine-maintenance-watch-only.test.ts` holds that. Every verdict is
 * written to `logs/browser-care.jsonl` so seven days of would-close rows can show the
 * rule never picks a browser that is still in use before any later build may act.
 *
 * Who may be closed: only a Chrome main process whose `--user-data-dir` is inside this
 * agent's own `.instar/state/playwright-profiles/`. The operator's own Chrome has no
 * such flag and can never match. An owned process with no ledger entry is adopted.
 *
 * A close needs one of: a completion signal (`completedAt`), an expired declared
 * lifetime (`ttlDeclared`), an adopted instance's expired lease, or a confirmed absent
 * owner (idle past `idleMinutes` and the owning tmux session gone on a fresh read).
 * Then it must pass the keep checks: no operator input in the last 5 minutes, no open
 * sign-in repair, no download growing, and every tab read as holding no unsaved input.
 * Any unreadable answer keeps the instance and says so.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../../core/hostSemaphoreCore.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';

const MIN = 60_000;
export const SWEEP_INTERVAL_MS = 15 * MIN;
export const OPERATOR_ACTIVE_MS = 5 * MIN;
export const DOWNLOAD_FRESH_MS = 5 * MIN;
/** At most this many instances get the per-tab check in one pass. */
export const MAX_CHECKS_PER_PASS = 5;
const BREAKER_FAILURES = 3;
const BREAKER_PAUSE_MS = 24 * 60 * MIN;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export interface BrowserCareSettings {
  enabled: boolean;
  /** Always true in this build: there is no close path. Reported so a reader sees it. */
  dryRun: boolean;
  maxPerAgent: number;
  maxPerHost: number;
  idleMinutes: number;
  ttlMinutes: number;
  /** Profile ids (folder names under playwright-profiles) the sweep never picks. */
  keepProfiles: string[];
}

export const DEFAULT_BROWSER_CARE: BrowserCareSettings = {
  enabled: true, dryRun: true, maxPerAgent: 4, maxPerHost: 8, idleMinutes: 30, ttlMinutes: 120, keepProfiles: [],
};

const posInt = (v: unknown, d: number, min = 1, max = 10_000): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.floor(v) : d;

export function normalizeBrowserCare(raw: unknown): BrowserCareSettings {
  const r = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    enabled: r.enabled !== false,
    dryRun: true,
    maxPerAgent: posInt(r.maxPerAgent, DEFAULT_BROWSER_CARE.maxPerAgent, 1, 100),
    maxPerHost: posInt(r.maxPerHost, DEFAULT_BROWSER_CARE.maxPerHost, 1, 200),
    idleMinutes: posInt(r.idleMinutes, DEFAULT_BROWSER_CARE.idleMinutes, 5, 7 * 24 * 60),
    ttlMinutes: posInt(r.ttlMinutes, DEFAULT_BROWSER_CARE.ttlMinutes, 5, 30 * 24 * 60),
    keepProfiles: Array.isArray(r.keepProfiles) ? r.keepProfiles.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, 100) : [],
  };
}

/** One file per instance, written by `chrome-launch.sh` and kept current by the other helpers. */
export interface BrowserInstanceEntry {
  userDataDir: string;
  pid: number | null;
  processStartTime: string | null;
  agent: string | null;
  sessionName: string | null;
  topicId: string | null;
  purpose: string | null;
  openedAt: string;
  lastUsedAt: string;
  ttlMinutes: number;
  ttlDeclared: boolean;
  leaseUntil: string;
  completedAt: string | null;
}

/** A Chrome browser main process: no `--type=`, with a `--user-data-dir=`. */
export interface ChromeProcess { pid: number; startTime: string; userDataDir: string }

/** The file name the helper scripts use too: the first 16 hex of SHA-256 of the directory. */
export function ledgerFileName(userDataDir: string): string {
  return `${crypto.createHash('sha256').update(userDataDir).digest('hex').slice(0, 16)}.json`;
}

/** The macOS Chrome app binary, exactly. `Google Chrome for Testing.app` does not match. */
const NORMAL_CHROME_MAIN = /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome( |$)/;
/** Flags an automation-driven browser carries; chrome-launch.sh adds no flags at all. */
const AUTOMATION_FLAGS = /--remote-debugging-(port|pipe)|--enable-automation|--test-type/;

/**
 * Parses `ps -axo pid=,lstart=,args=`. `lstart` is five fields ("Mon Nov  2 10:00:00 2026").
 * Only the real Chrome app's main process counts; helpers carry `--type=`, and an automation-driven
 * browser (Playwright, Chrome for Testing) is never counted.
 */
export function parseChromeProcesses(psOutput: string): ChromeProcess[] {
  const out: ChromeProcess[] = [];
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const args = m[3];
    // The real Chrome app only: not "Google Chrome for Testing" or a Chromium, and not a browser
    // started for automation (the Playwright MCP's), which the normal-Chrome launcher never is.
    if (!NORMAL_CHROME_MAIN.test(args) || /--type=/.test(args) || AUTOMATION_FLAGS.test(args)) continue;
    const dir = /--user-data-dir=(\S+)/.exec(args);
    if (!dir) continue;
    out.push({ pid: Number(m[1]), startTime: m[2].replace(/\s+/g, ' '), userDataDir: dir[1] });
  }
  return out;
}

function isInside(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export type BrowserCloseGround = 'completed' | 'declared-lifetime-expired' | 'adopted-lease-expired' | 'owner-absent';
export type BrowserKeepReason =
  | 'allowlisted' | 'in-use' | 'lease-expired-owner-alive' | 'owner-unreadable' | 'declared-lifetime-running'
  | 'operator-active' | 'operator-unreadable' | 'sign-in-repair-open' | 'sign-in-repair-unreadable'
  | 'download-active' | 'download-unreadable' | 'unsaved-input' | 'unreadable-tabs' | 'check-budget';

export interface BrowserVerdict {
  verdict: 'would-close' | 'keep';
  ground: BrowserCloseGround | null;
  reason: BrowserKeepReason | null;
}

/** Step one: does any close ground apply? Owner reads are fresh from the caller. */
export function closeGround(entry: BrowserInstanceEntry, nowMs: number, idleMinutes: number, ownerAlive: boolean | null): BrowserVerdict {
  const keep = (reason: BrowserKeepReason): BrowserVerdict => ({ verdict: 'keep', ground: null, reason });
  const ground = (g: BrowserCloseGround): BrowserVerdict => ({ verdict: 'would-close', ground: g, reason: null });
  if (entry.completedAt) return ground('completed');
  const leaseOver = Date.parse(entry.leaseUntil) < nowMs;
  const idle = nowMs - Date.parse(entry.lastUsedAt) > idleMinutes * MIN;
  if (entry.ttlDeclared) return leaseOver ? ground('declared-lifetime-expired') : keep('declared-lifetime-running');
  if (entry.purpose === 'adopted') return leaseOver ? ground('adopted-lease-expired') : keep('in-use');
  if (!idle && !leaseOver) return keep('in-use');
  if (!idle) return keep('lease-expired-owner-alive');
  if (!entry.sessionName || ownerAlive === null) return keep('owner-unreadable');
  if (ownerAlive) return keep(leaseOver ? 'lease-expired-owner-alive' : 'in-use');
  return ground('owner-absent');
}

export type TabCheck = 'no' | 'yes' | 'unreadable';

export interface BrowserCareDeps {
  agentName: string;
  /** The agent home; profiles live under `<home>/.instar/state/playwright-profiles/`. */
  agentHome: string;
  operatorChromeDir: string;
  ledgerDir: string;
  logPath: string;
  settings: () => BrowserCareSettings;
  /** Chrome main processes on this host, or null when the process table is unreadable. */
  listChrome: () => Promise<ChromeProcess[] | null>;
  /** Names of live tmux sessions, or null when unreadable. */
  tmuxSessions: () => Promise<string[] | null>;
  /** Milliseconds since the last console input, or null. */
  inputIdleMs: () => Promise<number | null>;
  /** True when a sign-in repair is open on this machine; null when unreadable. */
  signInRepairOpen: () => boolean | null;
  /** True when a download in this profile grew recently; null when unreadable. */
  downloadActive: (userDataDir: string) => Promise<boolean | null>;
  /** Read-only per-tab unsaved-input check for one instance. Every tab, or `unreadable`. */
  checkTabs: (userDataDir: string) => Promise<TabCheck[] | 'unreadable'>;
  now?: () => number;
  log?: (line: string) => void;
}

export interface InstanceReport {
  profile: string;
  pid: number | null;
  purpose: string | null;
  sessionName: string | null;
  openedAt: string;
  lastUsedAt: string;
  leaseUntil: string;
  ttlDeclared: boolean;
  verdict: BrowserVerdict['verdict'];
  ground: BrowserCloseGround | null;
  reason: BrowserKeepReason | null;
}

export interface BrowserCareStatus {
  enabled: boolean;
  dryRun: true;
  canClose: false;
  lastSweepAt: string | null;
  lastError: string | null;
  breakerUntil: string | null;
  owned: number;
  adopted: number;
  hostTotal: number | null;
  maxPerAgent: number;
  maxPerHost: number;
  overAgentCap: boolean;
  overHostCap: boolean;
  wouldClose: number;
  keptUnsaved: number;
  keptUnreadable: number;
  instances: InstanceReport[];
}

export class BrowserCareSweep {
  private readonly deps: BrowserCareDeps;
  private readonly now: () => number;
  private readonly profilesRoot: string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private failures = 0;
  private breakerUntil = 0;
  private lastSweepAt: number | null = null;
  private lastError: string | null = null;
  private hostTotal: number | null = null;
  private reports: InstanceReport[] = [];
  /** Last verdict per instance, so the audit records changes, not every pass. */
  private readonly lastKey = new Map<string, string>();

  constructor(deps: BrowserCareDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.profilesRoot = path.join(deps.agentHome, '.instar', 'state', 'playwright-profiles');
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.sweep(); }, SWEEP_INTERVAL_MS);
    this.timer.unref?.();
    setTimeout(() => { void this.sweep(); }, 60_000).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Owned: inside this agent's profiles folder and never the operator's own Chrome. */
  isOwned(dir: string): boolean {
    return isInside(dir, this.profilesRoot) && !isInside(dir, this.deps.operatorChromeDir) && dir !== this.deps.operatorChromeDir;
  }

  readLedger(): BrowserInstanceEntry[] {
    let names: string[];
    try { names = fs.readdirSync(this.deps.ledgerDir).filter((n) => n.endsWith('.json')); }
    catch { return []; } // @silent-fallback-ok — no ledger folder is an empty ledger; adoption fills it.
    const out: BrowserInstanceEntry[] = [];
    for (const name of names) {
      try {
        const e = JSON.parse(fs.readFileSync(path.join(this.deps.ledgerDir, name), 'utf-8')) as BrowserInstanceEntry;
        if (typeof e.userDataDir === 'string' && typeof e.openedAt === 'string' && typeof e.lastUsedAt === 'string' && typeof e.leaseUntil === 'string') out.push(e);
      } catch { /* @silent-fallback-ok — a half-written or foreign file is skipped; adoption rewrites it. */ }
    }
    return out;
  }

  private write(entry: BrowserInstanceEntry): void {
    fs.mkdirSync(this.deps.ledgerDir, { recursive: true });
    atomicWriteFileSync(path.join(this.deps.ledgerDir, ledgerFileName(entry.userDataDir)), JSON.stringify(entry, null, 2), { mode: 0o600, operation: 'BrowserCareSweep.writeLedger' });
  }

  private remove(entry: BrowserInstanceEntry): void {
    try { SafeFsExecutor.safeUnlinkSync(path.join(this.deps.ledgerDir, ledgerFileName(entry.userDataDir)), { operation: 'browser-care: ledger entry for an instance that has exited' }); }
    catch { /* @silent-fallback-ok — a stale entry is removed on the next pass. */ }
  }

  private audit(row: Record<string, unknown>): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.logPath), { recursive: true });
      try { if (fs.statSync(this.deps.logPath).size > MAX_LOG_BYTES) fs.renameSync(this.deps.logPath, `${this.deps.logPath}.1`); }
      catch { /* @silent-fallback-ok — no log yet. */ }
      fs.appendFileSync(this.deps.logPath, `${JSON.stringify({ ts: new Date(this.now()).toISOString(), agent: this.deps.agentName, dryRun: true, ...row })}\n`);
    } catch (err) {
      this.deps.log?.(`browser-care audit write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private profile(dir: string): string {
    return path.relative(this.deps.agentHome, dir);
  }

  async sweep(): Promise<void> {
    const settings = this.deps.settings();
    if (!settings.enabled || this.running || this.now() < this.breakerUntil) return;
    this.running = true;
    try {
      await this.pass(settings);
      this.failures = 0;
      this.lastError = null;
    } catch (err) {
      this.failures++;
      this.lastError = err instanceof Error ? err.message : String(err);
      if (this.failures >= BREAKER_FAILURES) {
        this.breakerUntil = this.now() + BREAKER_PAUSE_MS;
        this.audit({ event: 'breaker-open', failures: this.failures, error: this.lastError });
        this.failures = 0;
      }
    } finally {
      this.running = false;
    }
  }

  private async pass(settings: BrowserCareSettings): Promise<void> {
    const now = this.now();
    const procs = await this.deps.listChrome();
    if (procs === null) throw new Error('process table unreadable');
    // Every agent's normal-Chrome profiles on this host, read from the process table.
    this.hostTotal = procs.filter((p) => /\/\.instar\/state\/playwright-profiles\//.test(p.userDataDir)).length;
    const owned = new Map(procs.filter((p) => this.isOwned(p.userDataDir)).map((p) => [p.userDataDir, p]));

    // Reconcile the ledger with what is running. An entry whose process is gone is removed;
    // a process with no entry, or a different (pid, start time), is adopted afresh.
    const entries = new Map<string, BrowserInstanceEntry>();
    for (const e of this.readLedger()) {
      if (!this.isOwned(e.userDataDir)) continue;
      const p = owned.get(e.userDataDir);
      if (!p) { this.remove(e); this.lastKey.delete(e.userDataDir); continue; }
      if (e.pid === null) {
        const bound = { ...e, pid: p.pid, processStartTime: p.startTime };
        this.write(bound);
        entries.set(e.userDataDir, bound);
      } else if (e.pid === p.pid && e.processStartTime === p.startTime) {
        entries.set(e.userDataDir, e);
      }
    }
    for (const [dir, p] of owned) {
      if (entries.has(dir)) continue;
      const at = new Date(now).toISOString();
      const adopted: BrowserInstanceEntry = {
        userDataDir: dir, pid: p.pid, processStartTime: p.startTime, agent: this.deps.agentName,
        sessionName: null, topicId: null, purpose: 'adopted', openedAt: at, lastUsedAt: at,
        ttlMinutes: settings.ttlMinutes, ttlDeclared: false,
        leaseUntil: new Date(now + settings.ttlMinutes * MIN).toISOString(), completedAt: null,
      };
      this.write(adopted);
      entries.set(dir, adopted);
      this.audit({ event: 'adopted', profile: this.profile(dir) });
    }

    const tmux = await this.deps.tmuxSessions();
    const idleMs = await this.deps.inputIdleMs();
    const repair = this.deps.signInRepairOpen();
    let checks = 0;
    const reports: InstanceReport[] = [];
    for (const e of [...entries.values()].sort((a, b) => a.openedAt.localeCompare(b.openedAt))) {
      const ownerAlive = e.sessionName ? (tmux === null ? null : tmux.includes(e.sessionName)) : null;
      let v = settings.keepProfiles.includes(path.basename(e.userDataDir))
        ? { verdict: 'keep' as const, ground: null, reason: 'allowlisted' as const }
        : closeGround(e, now, settings.idleMinutes, ownerAlive);
      if (v.verdict === 'would-close') v = await this.keepChecks(e, v, idleMs, repair, checks++ < MAX_CHECKS_PER_PASS);
      reports.push({
        profile: this.profile(e.userDataDir), pid: e.pid, purpose: e.purpose, sessionName: e.sessionName,
        openedAt: e.openedAt, lastUsedAt: e.lastUsedAt, leaseUntil: e.leaseUntil, ttlDeclared: e.ttlDeclared,
        verdict: v.verdict, ground: v.ground, reason: v.reason,
      });
      const key = `${v.verdict}:${v.ground}:${v.reason}`;
      if (this.lastKey.get(e.userDataDir) !== key) {
        this.lastKey.set(e.userDataDir, key);
        this.audit({ event: v.verdict === 'would-close' ? 'would-close' : 'keep', profile: this.profile(e.userDataDir), purpose: e.purpose, ground: v.ground, reason: v.reason });
      }
    }
    this.reports = reports;
    this.lastSweepAt = now;
    if (reports.length > settings.maxPerAgent) this.audit({ event: 'over-agent-cap', owned: reports.length, cap: settings.maxPerAgent });
  }

  private async keepChecks(e: BrowserInstanceEntry, v: BrowserVerdict, idleMs: number | null, repair: boolean | null, budget: boolean): Promise<BrowserVerdict> {
    const keep = (reason: BrowserKeepReason): BrowserVerdict => ({ verdict: 'keep', ground: v.ground, reason });
    if (idleMs === null) return keep('operator-unreadable');
    if (idleMs < OPERATOR_ACTIVE_MS) return keep('operator-active');
    if (repair === null) return keep('sign-in-repair-unreadable');
    if (repair) return keep('sign-in-repair-open');
    if (!budget) return keep('check-budget');
    const download = await this.deps.downloadActive(e.userDataDir).catch(() => null);
    if (download === null) return keep('download-unreadable');
    if (download) return keep('download-active');
    const tabs = await this.deps.checkTabs(e.userDataDir).catch((): 'unreadable' => 'unreadable');
    if (tabs === 'unreadable' || tabs.includes('unreadable')) return keep('unreadable-tabs');
    if (tabs.includes('yes')) return keep('unsaved-input');
    return v;
  }

  status(): BrowserCareStatus {
    const s = this.deps.settings();
    return {
      enabled: s.enabled,
      dryRun: true,
      canClose: false,
      lastSweepAt: this.lastSweepAt === null ? null : new Date(this.lastSweepAt).toISOString(),
      lastError: this.lastError,
      breakerUntil: this.breakerUntil > this.now() ? new Date(this.breakerUntil).toISOString() : null,
      owned: this.reports.length,
      adopted: this.reports.filter((r) => r.purpose === 'adopted').length,
      hostTotal: this.hostTotal,
      maxPerAgent: s.maxPerAgent,
      maxPerHost: s.maxPerHost,
      overAgentCap: this.reports.length > s.maxPerAgent,
      overHostCap: this.hostTotal !== null && this.hostTotal > s.maxPerHost,
      wouldClose: this.reports.filter((r) => r.verdict === 'would-close').length,
      keptUnsaved: this.reports.filter((r) => r.reason === 'unsaved-input').length,
      keptUnreadable: this.reports.filter((r) => r.reason === 'unreadable-tabs').length,
      instances: this.reports,
    };
  }
}

let active: BrowserCareSweep | null = null;
export function setActiveBrowserCare(sweep: BrowserCareSweep | null): void { active = sweep; }
export function getActiveBrowserCare(): BrowserCareSweep | null { return active; }
