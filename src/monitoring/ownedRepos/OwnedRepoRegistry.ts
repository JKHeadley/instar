/**
 * OwnedRepoRegistry — every repository this agent creates or works in on this machine,
 * with its remote status, its single-copy work and its age (increment 1 of
 * docs/specs/no-data-loss-on-machine-death.md: §1.1–1.4 and §1.7, read-only).
 *
 * Why: on 2026-11-20 the Instar Apple app source and the Android app source were both
 * local-only repositories with no remote, and were lost with the Mac Studio. Nothing
 * listed them, so nothing said they existed only there.
 *
 * READ-ONLY. It never fetches, pushes, creates a remote or touches a working tree: every
 * git call is a read through `readGit` (no optional locks, no fsmonitor). Homing is
 * increment 2. This is a SIGNAL producer (docs/signal-vs-authority.md): it lists and it
 * reports defects to the Needs-you list; it blocks and changes nothing.
 *
 * Discovery, in order of reliability (§1.3): registration at birth (SafeGitExecutor's
 * `init` / `clone` observer), session evidence (hook-event working directories, queued
 * and drained at a bounded rate), and a budgeted scan of the agent home, the project-map
 * roots and declared roots, with a durable resume cursor.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GitReader } from './repoGit.js';
import { inspectRepo, repoIdFor, type RepoInspection, type RepoRemote } from './repoInspect.js';
import { enclosingRepoRoot, isAllowedRoot, isExcludedPath, runScan, type ScanItem } from './repoDiscovery.js';
import { bucket, type OwnedRepoReplica } from '../../core/OwnedRepoReplicatedStore.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Spec §Defaults. */
export const OWNED_REPO_DEFAULTS = {
  graceMs: DAY,
  atRiskGraceMs: HOUR,
  scanBudgetMs: 60_000,
  scanMaxEntries: 200_000,
  candidatesPerTick: 20,
  candidateQueueCap: 500,
  inspectEveryMs: 15 * 60_000,
  passEveryMs: 6 * HOUR,
  /** A completed pass at least this often, or the roots are `unknown` (and past it, a defect). */
  completedPassFloorMs: 7 * DAY,
  /** No first completed pass this long after enabling is a defect of its own ("could not check"). */
  firstPassDefectMs: DAY,
  maxRepos: 2000,
  maxBirths: 500,
  maxKnown: 20_000,
  maxQueue: 50_000,
  emitMinIntervalMs: 5 * 60_000,
  tombstoneMs: 90 * DAY,
} as const;

export type RepoClass = 'owned' | 'candidate';
export type DiscoveredVia = 'home' | 'birth' | 'session' | 'scan';

export interface StoredRepo {
  root: string;
  repoId: string;
  class: RepoClass;
  via: DiscoveredVia;
  firstSeenAt: number;
  inspectedAt: number | null;
  inspection: RepoInspection | null;
  goneAt: number | null;
  /** When the last reads started failing (cleared by a good read): `unknown` past a day is a defect. */
  unknownSince?: number | null;
}

interface StateFile {
  v: 1;
  enabledSince: number;
  minted: Record<string, string>;
  births: Array<{ path: string; at: number; via: string }>;
  candidates: Array<{ path: string; at: number }>;
  candidateOverflow: number;
  /** When the candidate queue last overflowed: places sessions worked that could not be checked (§1.3: reported as unknown). */
  candidateOverflowAt?: number | null;
  scan: { queue: ScanItem[]; known: string[]; passStartedAt: number | null; lastCompletedPassAt: number | null; entriesThisPass: number; unreadable: Array<{ dir: string; why: string }>; droppedThisPass?: number };
  repos: Record<string, StoredRepo>;
  emitted: Record<string, { sig: string; at: number }>;
}

export interface OwnedRepoRegistryDeps {
  machineId: string;
  machineName: () => string;
  agentHome: string;
  userHome: string;
  stateFile: string;
  git: GitReader;
  now?: () => number;
  /** Project-map roots and owner-declared roots (§1.3 path 3). */
  roots: () => string[];
  declaredRoots: () => string[];
  /** Other registered agents' homes: repositories inside them are skipped (their own registry covers them). */
  otherAgentHomes: () => string[];
  /** Disk below the warn line, a pending OS upgrade, or disk errors: the grace window shortens (§Defaults D2). */
  atRisk?: () => boolean;
  /** Replicate one record (the `owned-repo` WS2 kind). Optional: single machine / replication off. */
  emit?: (rec: OwnedRepoReplica) => void;
  log?: (e: Record<string, unknown>) => void;
}

export interface RepoView {
  repoId: string;
  machineId: string;
  path: string;
  displayPath: string;
  class: RepoClass;
  via: DiscoveredVia;
  worktrees: number;
  remotes: RepoRemote[];
  hasOffMachineRemote: boolean;
  singleCopy: { commits: number; branches: number; oldestAt: string | null; branchNames: string[] };
  uncommitted: { worktrees: number; files: number; bytes: number; oldestAt: string | null; complete: boolean };
  home: { mirror: null; remoteBackup: null };
  state: 'ok' | 'unknown';
  error?: string;
  inspectedAt: string | null;
  unknownSince: string | null;
  pastGrace: boolean;
}

export interface RepoDefect {
  key: string;
  kind: 'no-remote' | 'unpushed' | 'unknown';
  machineId: string;
  machineName: string;
  title: string;
  detail: string;
  count: number;
  repos: string[];
  oldestAt: string | null;
}

export interface OwnedRepoStatus {
  machineId: string;
  machineName: string;
  generatedAt: string;
  graceHours: number;
  scan: { state: 'complete' | 'in-progress' | 'never-completed'; lastCompletedPassAt: string | null; passStartedAt: string | null; queued: number; entriesThisPass: number; unreadable: number; roots: string[] };
  candidatesQueued: number;
  candidateOverflow: number;
  counts: { repos: number; owned: number; candidate: number; noRemote: number; withSingleCopy: number; unknown: number };
  repos: RepoView[];
  defects: RepoDefect[];
}

function emptyState(now: number): StateFile {
  return { v: 1, enabledSince: now, minted: {}, births: [], candidates: [], candidateOverflow: 0, scan: { queue: [], known: [], passStartedAt: null, lastCompletedPassAt: null, entriesThisPass: 0, unreadable: [] }, repos: {}, emitted: {} };
}

const iso = (t: number | null | undefined): string | null => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString() : null);

function age(ms: number): string {
  const h = Math.floor(ms / HOUR);
  if (h < 48) return `${Math.max(1, h)} hour${h === 1 ? '' : 's'}`;
  const d = Math.floor(ms / DAY);
  return `${d} days`;
}

export class OwnedRepoRegistry {
  private state: StateFile;
  private busy = false;
  private readonly seenDirs = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: OwnedRepoRegistryDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.state = this.load();
  }

  // ── discovery inputs ────────────────────────────────────────────────

  /** Registration at birth: an Instar funnel created or cloned a repository at `p` (§1.3 path 1). */
  noteBirth(p: string, via: string): void {
    const abs = path.resolve(p);
    if (isExcludedPath(abs, this.deps.userHome)) return;
    if (!this.state.births.some((b) => b.path === abs)) {
      this.state.births.push({ path: abs, at: this.now(), via: via.slice(0, 80) });
      if (this.state.births.length > OWNED_REPO_DEFAULTS.maxBirths) this.state.births.splice(0, this.state.births.length - OWNED_REPO_DEFAULTS.maxBirths);
      this.persist();
    }
  }

  /** Session evidence: a session worked at `p` (a working directory or a tool path) (§1.3 path 2). */
  noteSessionPath(p: unknown): void {
    if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return;
    const abs = path.resolve(p);
    // Deduplicate by enclosing directory: a session touches many files in one place.
    const dir = path.dirname(abs);
    if (this.seenDirs.has(dir)) return;
    this.seenDirs.add(dir);
    if (this.seenDirs.size > 5000) this.seenDirs.clear();
    if (!isAllowedRoot(abs, this.deps.userHome, this.deps.declaredRoots())) return;
    // A path inside a repository already known (or a worktree of one) adds nothing: only new roots are queued.
    const root = enclosingRepoRoot(abs, this.deps.userHome, this.deps.declaredRoots());
    if (!root) return;
    const main = mainWorktreeRoot(root);
    if (this.state.repos[main] && !this.state.repos[main].goneAt) return;
    if (this.state.candidates.some((c) => c.path === main)) return;
    if (this.state.candidates.length >= OWNED_REPO_DEFAULTS.candidateQueueCap) { this.state.candidateOverflow += 1; this.state.candidateOverflowAt = this.now(); return; }
    this.state.candidates.push({ path: main, at: this.now() });
  }

  // ── the tick ────────────────────────────────────────────────────────

  /** One bounded pass: drain candidates, continue the scan, re-inspect what is due. Never throws. */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const started = this.now();
    const deadline = Date.now() + OWNED_REPO_DEFAULTS.scanBudgetMs;
    // Each tick forgets the directories it has seen, so a folder that has become a repository since is noticed again.
    this.seenDirs.clear();
    try {
      this.drainCandidates();
      for (const b of this.state.births) this.addRepo(b.path, 'birth');
      await this.scanStep(deadline);
      await this.inspectDue(deadline);
      this.sweepGone();
      this.emitChanged();
      this.persist();
      const st = this.status();
      this.deps.log?.({ event: 'tick', ms: this.now() - started, repos: st.counts.repos, noRemote: st.counts.noRemote, withSingleCopy: st.counts.withSingleCopy, unknown: st.counts.unknown, defects: st.defects.map((d) => d.kind), scan: st.scan.state });
    } catch (e) {
      this.deps.log?.({ event: 'tick-failed', error: e instanceof Error ? e.message : String(e) });
    } finally {
      this.busy = false;
    }
  }

  private drainCandidates(): void {
    const take = this.state.candidates.splice(0, OWNED_REPO_DEFAULTS.candidatesPerTick);
    for (const c of take) {
      const root = enclosingRepoRoot(c.path, this.deps.userHome, this.deps.declaredRoots());
      if (root) this.addRepo(root, 'session');
    }
  }

  private scanRoots(): string[] {
    const declared = this.deps.declaredRoots();
    const out = new Set<string>([path.resolve(this.deps.agentHome)]);
    for (const r of [...this.deps.roots(), ...declared]) {
      const abs = path.resolve(r);
      if (isAllowedRoot(abs, this.deps.userHome, declared) && fs.existsSync(abs)) out.add(abs);
    }
    return [...out];
  }

  private async scanStep(deadline: number): Promise<void> {
    const s = this.state.scan;
    const now = this.now();
    if (!s.queue.length) {
      if (s.lastCompletedPassAt !== null && now - s.lastCompletedPassAt < OWNED_REPO_DEFAULTS.passEveryMs) return;
      s.queue = this.scanRoots().reverse().map((p) => ({ kind: 'root' as const, path: p }));
      s.known = [];
      s.passStartedAt = now;
      s.entriesThisPass = 0;
      s.unreadable = [];
      s.droppedThisPass = 0;
    }
    const known = new Set<string>(s.known);
    for (const r of Object.values(this.state.repos)) if (!r.goneAt) for (const w of r.inspection?.worktrees ?? []) if (path.resolve(w) !== path.resolve(r.root)) known.add(path.resolve(w));
    const budget = { deadline, maxEntries: OWNED_REPO_DEFAULTS.scanMaxEntries, entries: 0 };
    const done = await runScan(s.queue, budget, {
      git: this.deps.git,
      userHome: this.deps.userHome,
      known,
      onRepo: (root) => this.addRepo(root, 'scan'),
      onUnreadable: (dir, why) => { if (s.unreadable.length < 200) s.unreadable.push({ dir, why: why.slice(0, 160) }); },
    });
    s.entriesThisPass += budget.entries;
    s.known = [...known].slice(-OWNED_REPO_DEFAULTS.maxKnown);
    if (s.queue.length > OWNED_REPO_DEFAULTS.maxQueue) {
      // Drop the newest (deepest) folders, never the roots at the front, and remember the pass is not whole.
      const dropped = s.queue.length - OWNED_REPO_DEFAULTS.maxQueue;
      s.queue.splice(OWNED_REPO_DEFAULTS.maxQueue);
      s.droppedThisPass = (s.droppedThisPass ?? 0) + dropped;
    }
    // A pass that had to drop folders is not a completed pass: its roots stay unknown until a whole pass finishes.
    if (done) { if (!s.droppedThisPass) s.lastCompletedPassAt = this.now(); s.queue = []; }
  }

  /** The class of a repository at `root` (§1.1), or null when it belongs to another agent. */
  classify(root: string): RepoClass | null {
    const abs = path.resolve(root);
    const home = path.resolve(this.deps.agentHome);
    if (abs === home) return 'owned';
    for (const other of this.deps.otherAgentHomes()) {
      const o = path.resolve(other);
      if (o === home || home.startsWith(o + path.sep)) continue;
      if (abs === o || abs.startsWith(o + path.sep)) return null;
    }
    if (this.state.births.some((b) => b.path === abs)) return 'owned';
    return 'candidate';
  }

  private addRepo(root: string, via: DiscoveredVia): void {
    const abs = mainWorktreeRoot(path.resolve(root));
    if (isExcludedPath(abs, this.deps.userHome) || !fs.existsSync(abs)) return;
    const cls = this.classify(abs);
    if (!cls) return;
    const existing = this.state.repos[abs];
    if (existing) {
      existing.class = cls;
      if (existing.goneAt) existing.goneAt = null;
      if (via === 'birth' || abs === path.resolve(this.deps.agentHome)) existing.via = abs === path.resolve(this.deps.agentHome) ? 'home' : via;
      return;
    }
    if (Object.keys(this.state.repos).length >= OWNED_REPO_DEFAULTS.maxRepos) return;
    this.state.repos[abs] = { root: abs, repoId: this.mintedId(abs), class: cls, via: abs === path.resolve(this.deps.agentHome) ? 'home' : via, firstSeenAt: this.now(), inspectedAt: null, inspection: null, goneAt: null };
  }

  private displayPath(abs: string): string {
    const home = path.resolve(this.deps.userHome);
    return abs.startsWith(home + path.sep) ? `~/${path.relative(home, abs)}` : abs;
  }

  private mintedId(abs: string): string {
    if (!this.state.minted[abs]) this.state.minted[abs] = crypto.createHash('sha256').update(`minted\u0000${crypto.randomUUID()}`).digest('hex');
    return this.state.minted[abs];
  }

  private async inspectDue(deadline: number): Promise<void> {
    const due = Object.values(this.state.repos)
      .filter((r) => !r.goneAt && (r.inspectedAt === null || this.now() - r.inspectedAt >= OWNED_REPO_DEFAULTS.inspectEveryMs))
      .sort((a, b) => (a.inspectedAt ?? 0) - (b.inspectedAt ?? 0));
    const seenCommon = new Map<string, string>();
    for (const r of Object.values(this.state.repos)) if (!r.goneAt && r.inspection?.commonDir) seenCommon.set(r.inspection.commonDir, r.root);
    for (const r of due) {
      if (Date.now() > deadline) break;
      if (!fs.existsSync(r.root)) { r.goneAt = this.now(); continue; }
      const ins = await inspectRepo(r.root, this.deps.git, { deadline });
      // One record per object store: a second root on the same store (a worktree found by another path) folds into the first.
      const holder = ins.commonDir ? seenCommon.get(ins.commonDir) : undefined;
      if (holder && holder !== r.root && this.state.repos[holder] && !this.state.repos[holder].goneAt) { delete this.state.repos[r.root]; continue; }
      if (ins.commonDir) seenCommon.set(ins.commonDir, r.root);
      r.inspection = ins;
      r.inspectedAt = this.now();
      r.unknownSince = ins.state === 'unknown' ? (r.unknownSince ?? this.now()) : null;
      if (ins.rootCommit) {
        const id = repoIdFor(ins.rootCommit, this.displayPath(r.root));
        // An empty repository's minted id gives way to the real one: tell peers the old record is gone.
        if (id !== r.repoId && this.state.emitted[r.repoId] && this.deps.emit) {
          try { this.deps.emit({ ...this.replica(r), gone: true }); } catch { /* @silent-fallback-ok — the old record ages out by retention */ }
          delete this.state.emitted[r.repoId];
        }
        r.repoId = id;
      }
    }
  }

  private sweepGone(): void {
    for (const [k, r] of Object.entries(this.state.repos)) {
      if (!r.goneAt && !fs.existsSync(r.root)) r.goneAt = this.now();
      if (r.goneAt && this.now() - r.goneAt > OWNED_REPO_DEFAULTS.tombstoneMs) { delete this.state.repos[k]; delete this.state.emitted[r.repoId]; }
    }
  }

  // ── views ───────────────────────────────────────────────────────────

  graceMs(): number {
    let risky = false;
    try { risky = this.deps.atRisk?.() === true; } catch { risky = false; } // @silent-fallback-ok — no risk signal means the normal window
    return risky ? OWNED_REPO_DEFAULTS.atRiskGraceMs : OWNED_REPO_DEFAULTS.graceMs;
  }

  private pastGrace(r: StoredRepo): boolean {
    const ins = r.inspection;
    if (!ins || ins.state !== 'ok' || !ins.singleCopy.commits || ins.singleCopy.oldestAt === null) return false;
    return this.now() - ins.singleCopy.oldestAt >= this.graceMs();
  }

  view(r: StoredRepo): RepoView {
    const ins = r.inspection;
    return {
      repoId: r.repoId,
      machineId: this.deps.machineId,
      path: r.root,
      displayPath: this.displayPath(r.root),
      class: r.class,
      via: r.via,
      worktrees: ins?.worktrees.length ?? 0,
      remotes: ins?.remotes ?? [],
      hasOffMachineRemote: (ins?.remotes ?? []).some((x) => x.offMachine),
      singleCopy: { commits: ins?.singleCopy.commits ?? 0, branches: ins?.singleCopy.branches ?? 0, oldestAt: iso(ins?.singleCopy.oldestAt), branchNames: ins?.singleCopy.branchNames ?? [] },
      uncommitted: { worktrees: ins?.uncommitted.worktrees ?? 0, files: ins?.uncommitted.files ?? 0, bytes: ins?.uncommitted.bytes ?? 0, oldestAt: iso(ins?.uncommitted.oldestAt), complete: ins?.uncommitted.complete ?? false },
      home: { mirror: null, remoteBackup: null },
      state: ins ? ins.state : 'unknown',
      ...(ins?.error ? { error: ins.error } : {}),
      inspectedAt: iso(r.inspectedAt),
      unknownSince: iso(r.unknownSince ?? (ins ? null : r.firstSeenAt)),
      pastGrace: this.pastGrace(r),
    };
  }

  replica(r: StoredRepo): OwnedRepoReplica {
    const v = this.view(r);
    return {
      repoId: r.repoId, machineId: this.deps.machineId, displayPath: v.displayPath, class: r.class,
      remotes: v.remotes.slice(0, 20).map((x) => ({ name: x.name, host: x.host, ownerAccount: x.ownerAccount, offMachine: x.offMachine })),
      singleCopy: v.singleCopy.commits > 0,
      singleCopyCommitsBucket: bucket(v.singleCopy.commits),
      singleCopyBranchesBucket: bucket(v.singleCopy.branches),
      uncommitted: v.uncommitted.files > 0,
      pastGrace: v.pastGrace,
      state: v.state,
      gone: r.goneAt !== null,
    };
  }

  /** Emit records whose replicated fields changed: at once in the unsafe direction, else at most once per 5 min (§0). */
  private emitChanged(): void {
    if (!this.deps.emit) return;
    for (const r of Object.values(this.state.repos)) {
      if (!r.inspection && !r.goneAt) continue;
      const rep = this.replica(r);
      const sig = JSON.stringify(rep);
      const prev = this.state.emitted[r.repoId];
      if (prev && prev.sig === sig) continue;
      const prevRep = prev ? (JSON.parse(prev.sig) as OwnedRepoReplica) : null;
      const unsafe = !prevRep || (rep.singleCopy && !prevRep.singleCopy) || (rep.gone && !prevRep.gone) || (rep.pastGrace && !prevRep.pastGrace) || (rep.state === 'unknown' && prevRep.state !== 'unknown');
      if (!unsafe && prev && this.now() - prev.at < OWNED_REPO_DEFAULTS.emitMinIntervalMs) continue;
      try { this.deps.emit(rep); this.state.emitted[r.repoId] = { sig, at: this.now() }; }
      catch (e) { this.deps.log?.({ event: 'emit-failed', error: e instanceof Error ? e.message : String(e) }); }
    }
  }

  status(): OwnedRepoStatus {
    const now = this.now();
    const live = Object.values(this.state.repos).filter((r) => !r.goneAt);
    const repos = live.map((r) => this.view(r)).sort((a, b) => a.displayPath.localeCompare(b.displayPath));
    const s = this.state.scan;
    return {
      machineId: this.deps.machineId,
      machineName: this.deps.machineName(),
      generatedAt: new Date(now).toISOString(),
      graceHours: Math.round(this.graceMs() / HOUR),
      scan: {
        state: s.queue.length ? (s.lastCompletedPassAt === null ? 'never-completed' : 'in-progress') : s.lastCompletedPassAt === null ? 'never-completed' : 'complete',
        lastCompletedPassAt: iso(s.lastCompletedPassAt), passStartedAt: iso(s.passStartedAt), queued: s.queue.length,
        entriesThisPass: s.entriesThisPass, unreadable: s.unreadable.length, roots: this.scanRoots().map((p) => this.displayPath(p)),
      },
      candidatesQueued: this.state.candidates.length,
      candidateOverflow: this.state.candidateOverflow,
      counts: {
        repos: repos.length,
        owned: repos.filter((r) => r.class === 'owned').length,
        candidate: repos.filter((r) => r.class === 'candidate').length,
        noRemote: repos.filter((r) => r.state === 'ok' && !r.hasOffMachineRemote).length,
        withSingleCopy: repos.filter((r) => r.singleCopy.commits > 0).length,
        unknown: repos.filter((r) => r.state === 'unknown').length,
      },
      repos,
      defects: defectsFor(this.deps.machineId, this.deps.machineName(), repos, { now, enabledSince: this.state.enabledSince, lastCompletedPassAt: s.lastCompletedPassAt, candidateOverflowAt: this.state.candidateOverflowAt ?? null }),
    };
  }

  // ── persistence ─────────────────────────────────────────────────────

  private load(): StateFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.stateFile, 'utf8')) as StateFile;
      if (raw && raw.v === 1 && raw.repos && raw.scan) return { ...emptyState(this.now()), ...raw, scan: { ...emptyState(this.now()).scan, ...raw.scan } };
    } catch { /* @silent-fallback-ok — no state yet (first run) or unreadable: start a fresh registry; the scan rebuilds it */ }
    return emptyState(this.now());
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.stateFile), { recursive: true });
      const tmp = `${this.deps.stateFile}.next`;
      /* state-registry: owned-repo-registry */
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.deps.stateFile);
    } catch (e) {
      this.deps.log?.({ event: 'persist-failed', error: e instanceof Error ? e.message : String(e) });
    }
  }
}

/**
 * A linked worktree's `.git` is a file pointing into the main repository's `.git/worktrees/<name>`;
 * the registry keeps one record per object store, under the main working root. Pure file reads.
 */
export function mainWorktreeRoot(root: string): string {
  try {
    const dotGit = path.join(root, '.git');
    if (!fs.lstatSync(dotGit).isFile()) return root;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8').slice(0, 4096));
    if (!m) return root;
    const gitdir = path.resolve(root, m[1].trim());
    const common = fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim();
    const commonDir = path.resolve(gitdir, common);
    return path.basename(commonDir) === '.git' && fs.existsSync(path.dirname(commonDir)) ? path.dirname(commonDir) : root;
  } catch { return root; } // @silent-fallback-ok — not a linked worktree (or unreadable): keep the path as found
}

/**
 * The aggregated defects for one machine (§1.4): one row per kind of problem, never one per
 * repository or branch. Pure, so the pool read can apply it to a peer's repositories too.
 */
export function defectsFor(
  machineId: string,
  machineName: string,
  repos: Array<Pick<RepoView, 'displayPath' | 'class' | 'state' | 'hasOffMachineRemote' | 'pastGrace' | 'singleCopy'> & { unknownSince?: string | null }>,
  scan: { now: number; enabledSince: number; lastCompletedPassAt: number | null; candidateOverflowAt?: number | null },
): RepoDefect[] {
  const out: RepoDefect[] = [];
  const name = machineName || machineId.slice(0, 12);
  const shortList = (xs: string[]) => (xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more`);
  const oldest = (xs: typeof repos) => xs.map((r) => (r.singleCopy.oldestAt ? Date.parse(r.singleCopy.oldestAt) : NaN)).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;

  const noRemote = repos.filter((r) => r.state === 'ok' && !r.hasOffMachineRemote && r.pastGrace);
  if (noRemote.length) {
    const o = oldest(noRemote);
    out.push({
      key: `repos:no-remote:${machineId}`, kind: 'no-remote', machineId, machineName: name, count: noRemote.length,
      repos: noRemote.map((r) => r.displayPath), oldestAt: o ? new Date(o).toISOString() : null,
      title: `${noRemote.length === 1 ? 'A repository' : `${noRemote.length} repositories`} on ${name} exist${noRemote.length === 1 ? 's' : ''} only on that machine`,
      detail: `${shortList(noRemote.map((r) => r.displayPath))} ${noRemote.length === 1 ? 'has' : 'have'} no copy anywhere else (no remote)${o ? `, oldest work ${age(scan.now - o)} old` : ''}. If ${name} is lost, this work is lost with it.`,
    });
  }
  const unpushed = repos.filter((r) => r.state === 'ok' && r.hasOffMachineRemote && r.pastGrace && r.singleCopy.branches > 0);
  if (unpushed.length) {
    const branches = unpushed.reduce((n, r) => n + r.singleCopy.branches, 0);
    const o = oldest(unpushed);
    out.push({
      key: `repos:unpushed:${machineId}`, kind: 'unpushed', machineId, machineName: name, count: branches,
      repos: unpushed.map((r) => r.displayPath), oldestAt: o ? new Date(o).toISOString() : null,
      title: `${branches} branch${branches === 1 ? '' : 'es'} on ${name} ${branches === 1 ? 'has' : 'have'} no copy anywhere else${o ? `, oldest ${age(scan.now - o)}` : ''}`,
      detail: `Unpushed work in ${shortList(unpushed.map((r) => r.displayPath))}. It exists only on ${name}.`,
    });
  }
  // Unknown is never healthy, but only unknown PAST the check's window is a defect (§0).
  const unknown = repos.filter((r) => r.state === 'unknown' && (!r.unknownSince || scan.now - Date.parse(r.unknownSince) >= DAY));
  const neverChecked = scan.lastCompletedPassAt === null && scan.now - scan.enabledSince >= OWNED_REPO_DEFAULTS.firstPassDefectMs;
  const staleScan = scan.lastCompletedPassAt !== null && scan.now - scan.lastCompletedPassAt >= OWNED_REPO_DEFAULTS.completedPassFloorMs;
  // Session evidence that overflowed its queue in the last day: places sessions worked that were not checked.
  const overflowed = typeof scan.candidateOverflowAt === 'number' && scan.now - scan.candidateOverflowAt < DAY;
  if (overflowed && !neverChecked && !staleScan && !unknown.length) {
    out.push({
      key: `repos:unknown:${machineId}`, kind: 'unknown', machineId, machineName: name, count: 0, repos: [], oldestAt: null,
      title: `I could not check every place sessions worked on ${name}`,
      detail: 'More new folders came up than I can check at once, so a repository outside my usual folders may not be listed yet. I keep working through them.',
    });
  }
  if (neverChecked || staleScan || unknown.length) {
    const since = scan.lastCompletedPassAt ?? scan.enabledSince;
    out.push({
      key: `repos:unknown:${machineId}`, kind: 'unknown', machineId, machineName: name, count: unknown.length,
      repos: unknown.map((r) => r.displayPath), oldestAt: null,
      title: neverChecked || staleScan ? `I could not finish checking the repositories on ${name} for ${age(scan.now - since)}` : `I could not read ${unknown.length === 1 ? 'a repository' : `${unknown.length} repositories`} on ${name}`,
      detail: unknown.length ? `Not readable: ${shortList(unknown.map((r) => r.displayPath))}. Until I can read them I cannot say whether their work exists anywhere else.` : 'Until the check finishes I cannot say whether every repository there has a copy somewhere else.',
    });
  }
  return out;
}
