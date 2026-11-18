/**
 * Boot session census (docs/specs/restart-lock-continuity.md, part A).
 *
 * Before boot cleanup rewrites session records, record which sessions were alive
 * at the previous shutdown. Afterwards, classify each from its own record (by
 * session id) and mark the ones whose topic had open agent-driven work. Phase 1
 * lists and notifies; it never revives anything (revival is phase 2, CMT-1940).
 *
 * One file per OS boot under state/boot-session-census/<bootAt>.json. Files are
 * kept until the named reader marks them reviewed; a backlog is reported, never
 * dropped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Session } from './types.js';
import { parseBootTime } from '../monitoring/machineMaintenance/readings.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { commitmentQualifies } from './gapBCommitmentEvidence.js';
import { withSyncOp } from './InFlightSyncOpMarker.js';

/** Same-boot slack, matching the restart ledger's LEDGER_SAME_BOOT_MS. */
export const SAME_BOOT_SLACK_MS = 60_000;
export const REVIEWED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const UNREVIEWED_BACKLOG_LIMIT = 200;
export const OLD_ENTRY_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;

export interface CensusEntry {
  sessionId: string;
  tmuxSession: string;
  topicId: number | null;
  jobSlug: string | null;
  startedAt: string;
}

export interface CensusFile {
  v: 1;
  bootAt: number;
  writtenAt: string;
  entries: CensusEntry[];
  reviewedAt?: string;
  noticeSentAt?: string;
}

export type EndState = 'ended' | 'ended (unconfirmed)' | 'running';
export type WorkMark = 'open work' | 'autonomous (reconciler)' | 'autonomous (reconciler dark)' | 'none' | 'unknown';
export type AgeLabel = 'started before previous boot' | 'old (previous boot unknown)' | null;

export interface ClassifiedEntry extends CensusEntry {
  end: EndState;
  mark: WorkMark;
  markReason?: string;
  age: AgeLabel;
  topicCurrentlyActive: boolean;
}

export interface ClassifyDeps {
  /** The session's record now, by id; null when missing. */
  getSession: (sessionId: string) => Session | null;
  /** Is a live session serving this topic right now? */
  isTopicActive: (topicId: number) => boolean;
  /** Is a tmux session with this name alive now? */
  isTmuxAlive: (tmuxSession: string) => boolean;
  /** True when the topic has a qualifying open commitment; throws when unreadable. */
  hasOpenWork: (topicId: number) => boolean;
  /** True when the topic has an active autonomous state file. */
  autonomousActive: (topicId: number) => boolean;
  reconcilerEnabled: boolean;
  serverStartedAt: number;
  now: () => number;
}

/** Read this OS boot's time, per platform. null when none can be read. */
export function readBootAt(opts: { platform?: NodeJS.Platform; exec?: (cmd: string, args: string[]) => string; readFile?: (p: string) => string; uptimeSec?: () => number; now?: () => number } = {}): number | null {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? ((cmd, args) => withSyncOp(() => execFileSync(cmd, args, { encoding: 'utf-8', timeout: 2000 })));
  const readFile = opts.readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  try {
    if (platform === 'darwin') return parseBootTime(exec('sysctl', ['-n', 'kern.boottime']));
    if (platform === 'linux') {
      const m = /^btime\s+(\d+)/m.exec(readFile('/proc/stat'));
      if (m) return Number(m[1]) * 1000;
    }
  } catch { /* fall through to the uptime estimate */ }
  try {
    const up = (opts.uptimeSec ?? os.uptime)();
    if (!Number.isFinite(up) || up <= 0) return null;
    const raw = (opts.now ?? Date.now)() - up * 1000;
    return Math.round(raw / 60_000) * 60_000;
  } catch {
    return null;
  }
}

export class BootSessionCensus {
  readonly dir: string;

  readonly serverStartedAt: number;

  constructor(private readonly opts: { stateDir: string; bootAt: number | null; serverStartedAt?: number }) {
    this.serverStartedAt = opts.serverStartedAt ?? Date.now();
    this.dir = path.join(opts.stateDir, 'state', 'boot-session-census');
  }

  get bootAt(): number | null { return this.opts.bootAt; }

  private fileFor(bootAt: number): string { return path.join(this.dir, `${bootAt}.json`); }

  /** All census files, oldest first. Unreadable files are skipped and named. */
  listFiles(): { files: CensusFile[]; unreadable: string[] } {
    const files: CensusFile[] = [];
    const unreadable: string[] = [];
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter((n) => /^\d+\.json$/.test(n)); } catch { return { files, unreadable }; }
    for (const n of names) {
      try {
        const f = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf-8')) as CensusFile;
        if (f && f.v === 1 && Number.isFinite(f.bootAt) && Array.isArray(f.entries)) files.push(f);
        else unreadable.push(n);
      } catch { unreadable.push(n); }
    }
    files.sort((a, b) => a.bootAt - b.bootAt);
    return { files, unreadable };
  }

  /** The census for this boot, matched within the same-boot slack. */
  current(): CensusFile | null {
    if (this.opts.bootAt == null) return null;
    const b = this.opts.bootAt;
    return this.listFiles().files.find((f) => Math.abs(f.bootAt - b) <= SAME_BOOT_SLACK_MS) ?? null;
  }

  /** The newest census for a boot strictly before this one. */
  previous(): CensusFile | null {
    if (this.opts.bootAt == null) return null;
    const b = this.opts.bootAt;
    const older = this.listFiles().files.filter((f) => f.bootAt < b - SAME_BOOT_SLACK_MS);
    return older.length ? older[older.length - 1] : null;
  }

  /**
   * Write the census, once per boot, from the records as they are BEFORE cleanup.
   * A later server restart in the same boot finds the existing file and keeps it.
   */
  capture(records: Session[]): { written: boolean; reason: string } {
    if (this.opts.bootAt == null) return { written: false, reason: 'boot time unreadable' };
    if (this.current()) return { written: false, reason: 'census for this boot already exists' };
    const bootAt = this.opts.bootAt;
    const entries: CensusEntry[] = records
      .filter((s) => (s.status === 'running' || s.status === 'starting'))
      .filter((s) => { const t = Date.parse(s.startedAt); return Number.isFinite(t) && t < bootAt; })
      .map((s) => ({
        sessionId: s.id,
        tmuxSession: s.tmuxSession,
        topicId: typeof s.telegramTopicId === 'number' ? s.telegramTopicId : null,
        jobSlug: s.jobSlug ?? null,
        startedAt: s.startedAt,
      }));
    const file: CensusFile = { v: 1, bootAt, writtenAt: new Date().toISOString(), entries };
    this.writeFile(file);
    return { written: true, reason: `${entries.length} session(s) alive at the previous shutdown` };
  }

  private writeFile(file: CensusFile): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const target = this.fileFor(file.bootAt);
    const tmp = `${target}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
    fs.renameSync(tmp, target);
  }

  /** Classify one census file's entries from the records as they are now. */
  classify(file: CensusFile, deps: ClassifyDeps): ClassifiedEntry[] {
    const prevBoot = this.previousBootFor(file.bootAt);
    const unconfirmedAfterMs = 15 * 60 * 1000;
    return file.entries.map((e) => {
      const rec = deps.getSession(e.sessionId);
      let end: EndState;
      if (!rec || (rec.status !== 'running' && rec.status !== 'starting')) end = 'ended';
      else if (deps.now() - deps.serverStartedAt >= unconfirmedAfterMs && !deps.isTmuxAlive(e.tmuxSession)) end = 'ended (unconfirmed)';
      else end = 'running';
      const started = Date.parse(e.startedAt);
      let age: AgeLabel = null;
      if (prevBoot != null) { if (started < prevBoot) age = 'started before previous boot'; }
      else if (Number.isFinite(started) && file.bootAt - started > OLD_ENTRY_FALLBACK_MS) age = 'old (previous boot unknown)';
      let mark: WorkMark = 'none';
      let markReason: string | undefined;
      let topicCurrentlyActive = false;
      if (e.topicId != null) {
        try { topicCurrentlyActive = deps.isTopicActive(e.topicId); } catch { topicCurrentlyActive = false; }
        try {
          if (deps.autonomousActive(e.topicId)) mark = deps.reconcilerEnabled ? 'autonomous (reconciler)' : 'autonomous (reconciler dark)';
          else if (deps.hasOpenWork(e.topicId)) mark = 'open work';
        } catch (err) {
          mark = 'unknown';
          markReason = err instanceof Error ? err.message : String(err);
        }
      }
      return { ...e, end, mark, ...(markReason ? { markReason } : {}), age, topicCurrentlyActive };
    });
  }

  private previousBootFor(bootAt: number): number | null {
    const older = this.listFiles().files.filter((f) => f.bootAt < bootAt - SAME_BOOT_SLACK_MS);
    return older.length ? older[older.length - 1].bootAt : null;
  }

  /** Mark a boot's census reviewed by the named reader. */
  markReviewed(bootAt: number, at = new Date()): boolean {
    const f = this.listFiles().files.find((x) => Math.abs(x.bootAt - bootAt) <= SAME_BOOT_SLACK_MS);
    if (!f) return false;
    if (!f.reviewedAt) { f.reviewedAt = at.toISOString(); this.writeFile(f); }
    return true;
  }

  /** Record that this boot's open-work notice was sent (at most once per boot). */
  markNoticeSent(at = new Date()): boolean {
    const f = this.current();
    if (!f || f.noticeSentAt) return false;
    f.noticeSentAt = at.toISOString();
    this.writeFile(f);
    return true;
  }

  /**
   * Remove only reviewed files older than 30 days. Unreviewed files are never
   * removed; a backlog over the limit is returned so the caller reports it.
   */
  prune(now = Date.now()): { removed: number; unreviewed: number; backlog: boolean } {
    const { files } = this.listFiles();
    let removed = 0;
    for (const f of files) {
      if (f.reviewedAt && now - f.bootAt > REVIEWED_RETENTION_MS && f.bootAt !== this.opts.bootAt) {
        try { SafeFsExecutor.safeUnlinkSync(this.fileFor(f.bootAt), { operation: 'src/core/BootSessionCensus.ts:prune' }); removed++; } catch { /* keep it */ }
      }
    }
    const unreviewed = files.filter((f) => !f.reviewedAt).length;
    return { removed, unreviewed, backlog: unreviewed > UNREVIEWED_BACKLOG_LIMIT };
  }
}

let active: BootSessionCensus | null = null;
export function setActiveBootSessionCensus(c: BootSessionCensus | null): void { active = c; }
export function getActiveBootSessionCensus(): BootSessionCensus | null { return active; }

/** Production dependencies for classify(), from the server's own objects. */
export function bootCensusDeps(o: {
  state: { getSession(id: string): Session | null };
  sessionManager: { listRunningSessions(): Session[]; isSessionAlive(tmux: string): boolean };
  commitmentTracker: { getActiveByTopicId(topicId: number): import('../monitoring/CommitmentTracker.js').Commitment[] };
  ownMachineId: string | undefined;
  activeAutonomousTopics: () => Set<string>;
  reconcilerEnabled: boolean;
  serverStartedAt: number;
  now?: () => number;
}): ClassifyDeps {
  const now = o.now ?? Date.now;
  return {
    getSession: (id) => o.state.getSession(id),
    isTopicActive: (t) => o.sessionManager.listRunningSessions().some((s) => s.telegramTopicId === t),
    isTmuxAlive: (name) => o.sessionManager.isSessionAlive(name),
    hasOpenWork: (t) => o.commitmentTracker.getActiveByTopicId(t).some((c) =>
      commitmentQualifies(c, { ownMachineId: o.ownMachineId, freshCommitmentWindowMs: Number.POSITIVE_INFINITY, now })),
    autonomousActive: (t) => o.activeAutonomousTopics().has(String(t)),
    reconcilerEnabled: o.reconcilerEnabled,
    serverStartedAt: o.serverStartedAt,
    now,
  };
}

/**
 * The A.5 notice text, or null when nothing qualifies: ended sessions marked
 * `open work` or `autonomous (reconciler dark)` whose topic is not active again.
 */
export function buildOpenWorkNotice(entries: ClassifiedEntry[]): string | null {
  const waiting = entries.filter((e) =>
    e.end !== 'running' && e.topicId != null && !e.topicCurrentlyActive &&
    (e.mark === 'open work' || e.mark === 'autonomous (reconciler dark)'));
  if (waiting.length === 0) return null;
  const topics = [...new Set(waiting.map((e) => e.topicId))].join(', ');
  return `${waiting.length} session(s) with open work ended at the last restart and have not come back (topics ${topics}). ` +
    'They resume when their topic gets its next message. Automatic revival does not exist yet: it is phase 2, and once it exists it will be tried first and this notice will come only if it fails.';
}
