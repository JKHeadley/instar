/**
 * worktreeDirtyCheck — the ONE shared "does this worktree hold real uncommitted
 * work?" helper for Build-Session Yield Safety (ACT-839; spec
 * docs/specs/BUILD-SESSION-YIELD-SAFETY-SPEC.md).
 *
 * Called by BOTH paths so the "is this clean?" judgement can never diverge:
 *  - R1: the killer collects `uncommitted-worktree-work` evidence PRE-kill.
 *  - R2: the ResumeQueue drain tick checks delivery (clean + a real commit).
 *
 * Properties (all from the spec):
 *  - `git status --porcelain` (ignored files already excluded by porcelain).
 *  - Build-residue denylist: a worktree whose ONLY dirty entries are build
 *    artifacts (dist/, node_modules/, …) is NOT "real work" → not dirty.
 *  - realpath-normalized first (rejects a path that still starts with `-`).
 *  - Per-resolved-path cache (default 30s TTL) so N killers reaping overlapping
 *    sessions in one shed burst don't each spawn git on the same worktree.
 *  - FAIL-OPEN: any git error / a non-git path / a resolve failure → NOT dirty
 *    (signal absent). The bounded timeout lives in the injected `readGit`
 *    (SafeGitExecutor.readSync); a thrown timeout lands here as fail-open.
 *
 * Pure + injectable (readGit / now / realpath) so it unit-tests with fakes and
 * never reaches the real filesystem in tests.
 */
import { realpathSync } from 'node:fs';

/** Read-only git invocation — array args only (SafeGitExecutor.readSync shape). */
export type ReadGit = (args: string[], cwd: string) => string;

export interface WorktreeDirtyCheckConfig {
  /** Build-residue path prefixes/globs; a worktree dirty ONLY in these is not "work". */
  residueDenylist: readonly string[];
  /** Cache TTL per resolved path (ms). */
  cacheTtlMs: number;
}

export const DEFAULT_RESIDUE_DENYLIST: readonly string[] = [
  'dist/', 'build/', 'out/', '.next/', '.nuxt/', '.turbo/',
  'node_modules/', 'coverage/', '.cache/', '*.log', '*.tsbuildinfo',
];

export const DEFAULT_DIRTY_CHECK_CONFIG: WorktreeDirtyCheckConfig = {
  residueDenylist: DEFAULT_RESIDUE_DENYLIST,
  cacheTtlMs: 30_000,
};

export interface WorktreeDirtyCheckDeps {
  readGit: ReadGit;
  now?: () => number;
  /** Injectable for tests; defaults to fs.realpathSync. */
  realpath?: (p: string) => string;
  config?: Partial<WorktreeDirtyCheckConfig>;
}

interface CacheEntry { dirty: boolean; at: number; }

/**
 * One porcelain line → its path (strip the 2-char status + space; handle the
 * `R old -> new` rename arrow and quoted paths). Returns '' if unparseable.
 */
export function porcelainPath(line: string): string {
  if (line.length < 4) return '';
  let p = line.slice(3); // drop "XY "
  const arrow = p.indexOf(' -> ');
  if (arrow >= 0) p = p.slice(arrow + 4); // rename: take the destination
  // porcelain quotes paths with special chars; strip surrounding quotes.
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return p;
}

/** Does a porcelain path match a residue-denylist entry (prefix dir or *.ext glob)? */
export function isResiduePath(p: string, denylist: readonly string[]): boolean {
  for (const rule of denylist) {
    if (rule.startsWith('*.')) {
      if (p.endsWith(rule.slice(1))) return true; // '*.log' → endsWith('.log')
    } else if (rule.endsWith('/')) {
      if (p === rule.slice(0, -1) || p.startsWith(rule)) return true; // 'dist/' prefix
      // also match a nested segment: any path component equal to the dir
      if (p.includes('/' + rule)) return true;
    } else if (p === rule) {
      return true;
    }
  }
  return false;
}

/**
 * Decide dirtiness from porcelain output + denylist. Exported pure for tests:
 * non-empty AND at least one non-residue entry.
 */
export function classifyPorcelain(porcelain: string, denylist: readonly string[]): boolean {
  const lines = porcelain.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  for (const line of lines) {
    const p = porcelainPath(line);
    if (!p) continue;
    if (!isResiduePath(p, denylist)) return true; // a real (non-residue) change
  }
  return false; // everything dirty was build residue
}

export function makeWorktreeDirtyCheck(deps: WorktreeDirtyCheckDeps): (worktreePath: string) => boolean {
  const now = deps.now ?? (() => Date.now());
  const resolve = deps.realpath ?? realpathSync;
  const cfg: WorktreeDirtyCheckConfig = {
    residueDenylist: deps.config?.residueDenylist ?? DEFAULT_DIRTY_CHECK_CONFIG.residueDenylist,
    cacheTtlMs: deps.config?.cacheTtlMs ?? DEFAULT_DIRTY_CHECK_CONFIG.cacheTtlMs,
  };
  const cache = new Map<string, CacheEntry>();

  return function dirtyCheck(worktreePath: string): boolean {
    // Resolve first (defeats symlink escapes; rejects a leading-dash path that
    // could become a git option). Any resolve failure → fail-open absent.
    let resolved: string;
    try {
      resolved = resolve(worktreePath);
    } catch {
      // @silent-fallback-ok: SPEC-MANDATED fail-open — a realpath failure (ELOOP /
      // missing / not a dir) MUST yield "no dirty signal", never a wedge or a
      // spurious revive. The absence of the signal is the safe, intended outcome.
      return false;
    }
    if (!resolved || resolved.startsWith('-')) return false;

    const cached = cache.get(resolved);
    const t = now();
    if (cached && t - cached.at < cfg.cacheTtlMs) return cached.dirty;

    let dirty = false;
    try {
      const porcelain = deps.readGit(['-C', resolved, 'status', '--porcelain'], resolved);
      dirty = classifyPorcelain(porcelain, cfg.residueDenylist);
    } catch {
      // @silent-fallback-ok: SPEC-MANDATED fail-open — a git error / timeout /
      // non-git path MUST yield "no dirty signal" (never wedge the killer loop,
      // never spuriously revive). Cached briefly so a shed burst doesn't re-spawn;
      // self-heals on the next window. This is the safe direction by design.
      dirty = false;
    }
    cache.set(resolved, { dirty, at: t });
    return dirty;
  };
}
