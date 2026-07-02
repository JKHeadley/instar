/**
 * ScopeAccretionSweep — the git-truth accretion sweep (Layer 0, LOAD-BEARING).
 *
 * Spec: docs/specs/autonomous-scope-accretion-completion.md §2.2 (R15/R31/R41/
 * R42/R48) + §2.4 (R20). Computes, from GIT STATE over a live-derived root set,
 * the artifacts an autonomous run created — catching Write/Edit, Bash heredocs,
 * `tee`, `cp`, python scripts, and subagent sessions identically (P20: the file
 * in the tree is the state; the tool event was only a symbol).
 *
 * Read-only by construction: every git invocation goes through the injected
 * `readGit` (SafeGitExecutor.readSync shape), bounded (per-root timeout, total
 * budget, 200-path clamp), and runs in-process on the server at judge-fire only.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AutonomousRunRecord, SweepBaseRoot } from './AutonomousRunStore.js';

export type ArtifactClass = 'deliverable' | 'companion' | 'scratch' | 'out-of-allowlist-doc';

export interface AccretedArtifact {
  /** Repo-relative path within its root. */
  path: string;
  root: string;
  cls: ArtifactClass;
  /** R17: a deliverable that disappeared from the tree stays flagged, never reclassified. */
  deleted: boolean;
  committed: boolean;
}

export interface SweepResult {
  artifacts: AccretedArtifact[];
  /** Out-of-allowlist doc / orphan companion seen — advisory flag (§2.4). */
  suspected: boolean;
  truncated: boolean;
  /** A git invocation failed or the budget expired mid-sweep — named in judge context. */
  degraded: boolean;
  latencyMs: number;
  rootsSwept: number;
  /** Worktrees first seen this sweep → their first-sight anchor SHA (for persistence, R31). */
  newWorktrees: Record<string, string>;
}

export interface SweepDeps {
  /** SafeGitExecutor.readSync shape: throws on failure. */
  readGit: (args: string[], cwd: string, timeoutMs?: number) => string;
  now?: () => number;
  /** Per-root git budget in ms (default 4000). */
  perRootTimeoutMs?: number;
  /** Total sweep budget in ms (default 10000). */
  totalBudgetMs?: number;
  /** Path-count clamp (default 200, spec §2.2). */
  maxPaths?: number;
  /** Agent-home worktree convention dir (`<agentHome>/.worktrees`); optional. */
  worktreesDir?: string;
}

const MAX_PATHS_DEFAULT = 200;

// ── Artifact classes (R20 — glob-only, fully deterministic) ───────────────

const ELI16_RE = /\.eli16\.md$/;

export function classifyArtifactPath(relPath: string): ArtifactClass | null {
  const p = relPath.replace(/\\/g, '/');
  // scratch — scratchpad/tmp conventions are ledgered, never block.
  if (/^tmp\//.test(p) || /\/tmp\//.test(p) || /^\.scratchpad\//.test(p) || /^scratch\//.test(p)) {
    return 'scratch';
  }
  // docs/specs/reports/** is ceremony EVIDENCE (the convergence report that
  // CLEARS a spec via R32 arm (a)) — treating it as a fresh deliverable would
  // make clearing a spec accrete a new hold (a self-feeding loop). Evidence,
  // not a deliverable; out of the blocking taxonomy.
  if (/^docs\/specs\/reports\//.test(p)) return null;
  if (/^docs\/specs\/.+\.md$/.test(p)) {
    return ELI16_RE.test(p) ? 'companion' : 'deliverable';
  }
  if (/^docs\/audits\/.+\.md$/.test(p)) return 'deliverable';
  if (/^docs\/incidents\/.+\.md$/.test(p)) return 'deliverable';
  if (/(^|\/)[^/]*runbook[^/]*\.md$/i.test(p)) return 'deliverable';
  if (/^scripts\//.test(p)) return 'deliverable';
  // out-of-allowlist doc (advisory): any other docs/**/*.md or *.md at repo root.
  if (/^docs\/.+\.md$/.test(p)) return 'out-of-allowlist-doc';
  if (/^[^/]+\.md$/.test(p)) return 'out-of-allowlist-doc';
  return null;
}

/** The companion's parent spec path (`foo.eli16.md` → `foo.md`). */
export function companionParentPath(relPath: string): string {
  return relPath.replace(/\.eli16\.md$/, '.md');
}

// ── Declared-deliverable grammar (R20, frontloaded) ───────────────────────

const PATH_TOKEN_RE = /[A-Za-z0-9_./-]+\.(?:md|sh|mjs|js|cjs|ts|py)\b/g;

/**
 * Extract the declared-deliverable set from a registered condition text:
 * repo-relative path tokens matching the frontloaded grammar that ALSO match a
 * deliverable glob, UNION the explicit registration list. A pathless condition
 * ("draft five specs…") declares NOTHING — the honest reading of the motivating
 * incident (spec §2.4).
 *
 * Registered parser (Scrape/Parser Fixture Realness): fed byte-for-byte
 * captured completion-condition texts in tests/fixtures/captured/.
 */
export function parseDeclaredDeliverables(conditionText: string, explicit: string[] = []): string[] {
  const out = new Set<string>();
  const matches = (conditionText || '').match(PATH_TOKEN_RE) ?? [];
  for (const raw of matches) {
    const tok = raw.replace(/^\.\//, '').replace(/^\/+/, '');
    const cls = classifyArtifactPath(tok);
    if (cls === 'deliverable' || cls === 'companion') out.add(tok);
  }
  for (const p of explicit) {
    if (typeof p === 'string' && p.trim()) out.add(p.trim().replace(/^\.\//, ''));
  }
  return [...out];
}

// ── Porcelain mapping (R42, fixed) ────────────────────────────────────────

export interface PorcelainEntry {
  path: string;
  present: boolean;
  deleted: boolean;
}

/**
 * Map `git status --porcelain` output to present/deleted path entries per R42:
 * `??` untracked and `A`/`M` states = present; `R`/`C` = the NEW path is present
 * (old path treated as deleted); `D` = deleted (feeds the R17 deleted-flag).
 * Ignored files (`!!`) and submodule pointers are NOT swept.
 */
export function parsePorcelainStatus(porcelain: string): PorcelainEntry[] {
  const out: PorcelainEntry[] = [];
  for (const line of (porcelain || '').split('\n')) {
    if (!line || line.length < 4) continue;
    const xy = line.slice(0, 2);
    const rest = line.slice(3);
    if (xy === '!!') continue; // ignored — out of taxonomy
    const unquote = (s: string): string => {
      const t = s.trim();
      return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
    };
    if (/[RC]/.test(xy)) {
      // rename/copy: `R  old -> new` — new present, old deleted (rename only).
      const arrow = rest.indexOf(' -> ');
      if (arrow >= 0) {
        const oldPath = unquote(rest.slice(0, arrow));
        const newPath = unquote(rest.slice(arrow + 4));
        out.push({ path: newPath, present: true, deleted: false });
        if (xy.includes('R')) out.push({ path: oldPath, present: false, deleted: true });
      } else {
        out.push({ path: unquote(rest), present: true, deleted: false });
      }
      continue;
    }
    if (xy.includes('D')) {
      out.push({ path: unquote(rest), present: false, deleted: true });
      continue;
    }
    if (xy === '??' || /[AM]/.test(xy)) {
      out.push({ path: unquote(rest), present: true, deleted: false });
    }
  }
  return out;
}

// ── The sweep ─────────────────────────────────────────────────────────────

interface SweepRoot {
  root: string;
  startSha: string | null;
  /** R48: shared roots get HEAD-only committed attribution. */
  shared: boolean;
}

export function runAccretionSweep(record: AutonomousRunRecord, deps: SweepDeps): SweepResult {
  const now = deps.now ?? (() => Date.now());
  const t0 = now();
  const perRoot = deps.perRootTimeoutMs ?? 4000;
  const budget = deps.totalBudgetMs ?? 10_000;
  const maxPaths = deps.maxPaths ?? MAX_PATHS_DEFAULT;

  let degraded = false;
  let truncated = false;
  let suspected = false;
  const newWorktrees: Record<string, string> = {};
  const seen = new Map<string, AccretedArtifact>();

  const budgetLeft = (): number => budget - (now() - t0);

  // ── Root set, RE-DERIVED LIVE (R31): base roots + their worktrees + the
  // agent-home worktree convention dirs created after started_at. ──
  const roots: SweepRoot[] = [];
  // Dedupe on the REALPATH (macOS: /var → /private/var — `git worktree list`
  // reports the realpath while the registered root may be the symlinked form).
  const canon = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const addRoot = (root: string, startSha: string | null, shared: boolean): void => {
    const norm = canon(root);
    if (roots.some((r) => canon(r.root) === norm)) return;
    roots.push({ root, startSha, shared });
  };

  for (const base of record.baseRoots as SweepBaseRoot[]) {
    addRoot(base.root, base.startSha, base.shared);
    if (budgetLeft() <= 0) break;
    // Every checkout in `git worktree list` for this base root.
    try {
      const out = deps.readGit(['worktree', 'list', '--porcelain'], base.root, Math.min(perRoot, Math.max(budgetLeft(), 1)));
      for (const line of out.split('\n')) {
        if (!line.startsWith('worktree ')) continue;
        const wt = line.slice('worktree '.length).trim();
        if (!wt || path.resolve(wt) === path.resolve(base.root)) continue;
        addRoot(wt, resolveWorktreeAnchor(record, wt, base, deps, newWorktrees), false);
      }
    } catch {
      degraded = true;
    }
  }

  // Agent-home worktree convention: dirs under `.worktrees/` created after started_at.
  if (deps.worktreesDir) {
    try {
      const startedMs = Date.parse(record.startedAt);
      for (const name of fs.readdirSync(deps.worktreesDir)) {
        const p = path.join(deps.worktreesDir, name);
        let st: fs.Stats;
        try {
          st = fs.statSync(p);
        } catch {
          continue;
        }
        if (!st.isDirectory()) continue;
        const created = Math.min(st.birthtimeMs || Infinity, st.mtimeMs || Infinity);
        if (Number.isFinite(startedMs) && created < startedMs) continue;
        const base = (record.baseRoots as SweepBaseRoot[]).find((b) => !b.shared) ?? record.baseRoots[0];
        if (base) addRoot(p, resolveWorktreeAnchor(record, p, base, deps, newWorktrees), false);
      }
    } catch {
      /* @silent-fallback-ok — a missing .worktrees dir is the normal single-checkout
         case; the base-root `git worktree list` arm above still covers linked trees. */
    }
  }

  const record1 = (relPath: string, root: string, committed: boolean, deletedHint: boolean): void => {
    const cls = classifyArtifactPath(relPath);
    if (cls === null) return;
    if (cls === 'out-of-allowlist-doc') {
      suspected = true;
      return; // advisory only — never enters the artifact set (§2.4)
    }
    if (seen.size >= maxPaths) {
      truncated = true;
      return;
    }
    const key = `${path.resolve(root)} ${relPath}`;
    const existing = seen.get(key);
    const abs = path.join(root, relPath);
    const onDisk = fs.existsSync(abs);
    // R17: deletion never silently reclassifies — committed-then-missing or a
    // porcelain D keeps the entry with deleted:true.
    const deleted = deletedHint || (committed && !onDisk);
    if (existing) {
      existing.committed = existing.committed || committed;
      existing.deleted = existing.deleted || deleted;
      return;
    }
    seen.set(key, { path: relPath, root, cls, deleted, committed });
  };

  // ── Per-root arms ──
  let rootsSwept = 0;
  for (const r of roots) {
    if (budgetLeft() <= 0) {
      degraded = true;
      break;
    }
    if (!r.startSha) {
      // Not a git repo at registration — porcelain-only best effort.
      try {
        // --untracked-files=all: a freshly-created directory must list its
        // FILES (`?? docs/specs/foo.md`), not collapse to `?? docs/` (which no
        // class glob matches — the exact heredoc-evasion blind spot).
        const st = deps.readGit(['status', '--porcelain', '--untracked-files=all'], r.root, Math.min(perRoot, Math.max(budgetLeft(), 1)));
        for (const e of parsePorcelainStatus(st)) record1(e.path, r.root, false, e.deleted);
        rootsSwept++;
      } catch {
        degraded = true;
      }
      continue;
    }
    // Committed arm — SHA-anchored, never --since (backdated commit dates are
    // author-settable; a SHA anchor sees the commit regardless, R31).
    try {
      const logArgs = r.shared
        ? // R48: shared agent-home root — HEAD-only attribution (concurrent
          // sessions in the shared clone must not hold this run).
          ['log', `${r.startSha}..HEAD`, '--diff-filter=ACR', '--name-only', '--pretty=format:']
        : // Run-owned roots: ALL local branches (R41 — commit-on-branch-then-
          // switch-back is a normal-workflow escape; local branches only, so
          // fetched peer work is never attributed).
          ['log', '--branches', '--not', r.startSha, '--diff-filter=ACR', '--name-only', '--pretty=format:'];
      const out = deps.readGit(logArgs, r.root, Math.min(perRoot, Math.max(budgetLeft(), 1)));
      for (const line of out.split('\n')) {
        const p = line.trim();
        if (p) record1(p, r.root, true, false);
      }
    } catch {
      degraded = true;
    }
    if (budgetLeft() <= 0) {
      degraded = true;
      break;
    }
    // Uncommitted arm — porcelain mapping FIXED per R42 (-uall so untracked
    // dirs list their files; see the note above).
    try {
      const st = deps.readGit(['status', '--porcelain', '--untracked-files=all'], r.root, Math.min(perRoot, Math.max(budgetLeft(), 1)));
      for (const e of parsePorcelainStatus(st)) record1(e.path, r.root, false, e.deleted);
    } catch {
      degraded = true;
    }
    rootsSwept++;
  }

  // Orphan companion (an .eli16.md with no swept parent) → advisory flag; a
  // companion never blocks on its own (§2.4).
  const artifacts = [...seen.values()];
  const deliverablePaths = new Set(artifacts.filter((a) => a.cls === 'deliverable').map((a) => a.path));
  for (const a of artifacts) {
    if (a.cls === 'companion' && !deliverablePaths.has(companionParentPath(a.path))) {
      suspected = true;
    }
  }

  return {
    artifacts,
    suspected,
    truncated,
    degraded,
    latencyMs: now() - t0,
    rootsSwept,
    newWorktrees,
  };
}

/**
 * Anchor SHA for a worktree first seen at sweep time (R31): the recorded
 * first-sight SHA if we have one, else merge-base with the base root's start
 * SHA, falling back to the registration-time base-root SHA.
 */
function resolveWorktreeAnchor(
  record: AutonomousRunRecord,
  wtPath: string,
  base: SweepBaseRoot,
  deps: SweepDeps,
  newWorktrees: Record<string, string>,
): string | null {
  const known = record.worktreeFirstSeen?.[wtPath];
  if (known) return known;
  let anchor: string | null = base.startSha;
  if (base.startSha) {
    try {
      const mb = deps.readGit(['merge-base', 'HEAD', base.startSha], wtPath, deps.perRootTimeoutMs ?? 4000).trim();
      if (/^[0-9a-f]{7,40}$/.test(mb)) anchor = mb;
    } catch {
      /* @silent-fallback-ok — merge-base can fail on an unrelated-history worktree;
         the registration-time base-root SHA is the documented fallback (R31). */
    }
  }
  if (anchor) newWorktrees[wtPath] = anchor;
  return anchor;
}

/**
 * Compute the BLOCKING unbuilt set from a sweep (spec §2.8 step 1-2):
 * deliverable-class artifacts (deleted ones stay, R17) minus declared, minus
 * ratified, minus corroborated. Companions never block (cleared iff parent).
 */
export function computeUnbuiltSet(
  sweep: SweepResult,
  declared: string[],
  ratified: string[],
  corroborated: Record<string, unknown>,
): AccretedArtifact[] {
  const declaredSet = new Set(declared);
  const ratifiedSet = new Set(ratified);
  return sweep.artifacts.filter((a) => {
    if (a.cls !== 'deliverable') return false;
    if (declaredSet.has(a.path)) return false;
    if (ratifiedSet.has(a.path)) return false;
    if (corroborated[a.path]) return false;
    return true;
  });
}
