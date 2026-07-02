/**
 * ScopeAccretionCorroboration — per-class deterministic "built/delivered"
 * evidence, computed server-side at judge-fire time.
 *
 * Spec: docs/specs/autonomous-scope-accretion-completion.md §2.5
 * (R21/R22/R32/R33/R34). An accreted deliverable clears ONLY by:
 *   - spec class: the convergence REPORT artifact + a server-recorded
 *     conformance-check invocation inside the run window (R32), OR a merged PR
 *     passing the exact predicate (R33);
 *   - audit/runbook/incident doc: a merged PR containing the file (own-file
 *     rule relaxed for a doc whose deliverable IS the doc);
 *   - script: a merged PR touching the script path;
 *   - the local-git POSITIVE-ONLY shortcut (R34): the path verifiably landed on
 *     `origin/main` after the start SHA — may CLEAR, never used to refuse.
 *
 * Cost discipline (R22): ONE batched `gh` query per evaluation, 10s total
 * budget; positives are persisted by the caller (monotone); negatives carry a
 * 5-minute TTL. A network failure leaves artifacts uncorroborated (fail toward
 * keep-working) with `degraded: true` named in the judge context.
 */

import * as path from 'path';
import type { AccretedArtifact } from './ScopeAccretionSweep.js';

export interface MergedPrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface MergedPr {
  number: number;
  files: MergedPrFile[];
}

export interface CorroborationDeps {
  /** Bounded `gh` runner — throws on failure/timeout. */
  runGh: (args: string[], timeoutMs: number) => string;
  /** SafeGitExecutor.readSync shape. */
  readGit: (args: string[], cwd: string, timeoutMs?: number) => string;
  fsExists: (p: string) => boolean;
  /** Server-recorded ceremony evidence lookup (R32). */
  conformanceInvocationsInWindow: (slug: string, startIso: string, endIso: string) => number;
  now?: () => number;
  /** Total gh budget in ms (default 10000, R22). */
  ghBudgetMs?: number;
}

export interface CorroborationInput {
  artifacts: AccretedArtifact[];
  /** Paths already persisted as corroborated (monotone — skipped here). */
  alreadyCorroborated: Record<string, unknown>;
  /** Paths under a fresh negative-TTL — external queries skipped for these. */
  negativeCached: Set<string>;
  startedAt: string;
  workDir: string;
}

export interface CorroborationResult {
  /** Newly-cleared paths → evidence (the caller persists these, monotone). */
  cleared: Record<string, { by: string; detail?: string }>;
  /** Paths that were queried and NOT cleared (the caller stamps the 5-min TTL). */
  newNegatives: string[];
  /** gh/network failure — artifacts stay uncorroborated, named in judge context. */
  degraded: boolean;
}

/** Spec slug from an artifact path (`docs/specs/foo-bar.md` → `foo-bar`). */
export function specSlugFromPath(relPath: string): string {
  return path.basename(relPath).replace(/\.md$/, '');
}

/**
 * The merged-PR predicate, defined exactly (R33): the PR's merged diff includes
 * the artifact's path AND ≥1 non-`docs/**` path with a combined non-docs diff
 * of ≥10 changed lines. An artifact's own file NEVER corroborates itself; a
 * docs-only PR NEVER corroborates a spec. `relaxOwnFile` covers the doc-whose-
 * deliverable-IS-the-doc classes (audit/runbook/incident/script): the merged PR
 * containing the file suffices.
 */
export function mergedPrSatisfiesPredicate(pr: MergedPr, artifactPath: string, relaxOwnFile: boolean): boolean {
  const containsArtifact = pr.files.some((f) => f.path === artifactPath);
  if (!containsArtifact) return false;
  if (relaxOwnFile) return true;
  const nonDocs = pr.files.filter((f) => !f.path.startsWith('docs/') && f.path !== artifactPath);
  if (nonDocs.length < 1) return false;
  const changedLines = nonDocs.reduce((sum, f) => sum + (f.additions || 0) + (f.deletions || 0), 0);
  return changedLines >= 10;
}

function isSpecClass(relPath: string): boolean {
  return /^docs\/specs\/.+\.md$/.test(relPath) && !/\.eli16\.md$/.test(relPath);
}

function isRelaxedDocClass(relPath: string): boolean {
  return (
    /^docs\/audits\/.+\.md$/.test(relPath) ||
    /^docs\/incidents\/.+\.md$/.test(relPath) ||
    /(^|\/)[^/]*runbook[^/]*\.md$/i.test(relPath) ||
    /^scripts\//.test(relPath)
  );
}

/**
 * Fetch merged PRs since the run start with ONE batched query (R22).
 * `gh pr list --state merged --search "merged:><date>" --json number,files`.
 */
function fetchMergedPrs(deps: CorroborationDeps, startedAt: string, budgetMs: number): MergedPr[] | null {
  try {
    const day = (startedAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const raw = deps.runGh(
      ['pr', 'list', '--state', 'merged', '--search', `merged:>=${day}`, '--json', 'number,files', '--limit', '50'],
      budgetMs,
    );
    const parsed = JSON.parse(raw) as Array<{ number: number; files?: Array<{ path: string; additions?: number; deletions?: number }> }>;
    if (!Array.isArray(parsed)) return null;
    return parsed.map((p) => ({
      number: p.number,
      files: (p.files ?? []).map((f) => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
    }));
  } catch {
    /* @silent-fallback-ok — a gh/network failure leaves artifacts uncorroborated
       with `degraded: true` NAMED in the judge context (R22): fail toward
       keep-working, never a wedge and never a false done. */
    return null;
  }
}

export function resolveCorroboration(input: CorroborationInput, deps: CorroborationDeps): CorroborationResult {
  const now = deps.now ?? (() => Date.now());
  const t0 = now();
  const ghBudget = deps.ghBudgetMs ?? 10_000;
  const cleared: Record<string, { by: string; detail?: string }> = {};
  const newNegatives: string[] = [];
  let degraded = false;

  const pending = input.artifacts.filter(
    (a) => a.cls === 'deliverable' && !input.alreadyCorroborated[a.path],
  );
  if (pending.length === 0) return { cleared, newNegatives, degraded };

  // Evidence-source separation (R34): gh is the merged-PR authority; local git
  // is a POSITIVE-ONLY shortcut. Compute the cheap local arms first.
  let mergedPrs: MergedPr[] | null = null;
  let ghAttempted = false;
  const nowIso = new Date(now()).toISOString();

  for (const a of pending) {
    // Arm (a) for the spec class: report + server-recorded ceremony evidence (R32).
    if (isSpecClass(a.path)) {
      const slug = specSlugFromPath(a.path);
      const reportRel = `docs/specs/reports/${slug}-convergence.md`;
      const reportExists = deps.fsExists(path.join(a.root, reportRel)) || deps.fsExists(path.join(input.workDir, reportRel));
      if (reportExists && deps.conformanceInvocationsInWindow(slug, input.startedAt, nowIso) >= 1) {
        cleared[a.path] = { by: 'ceremony-report', detail: reportRel };
        continue;
      }
    }

    // Local-git positive-only shortcut (R34): commits reachable from origin/main
    // as last fetched — fetch staleness only DELAYS clearing (safe direction).
    const base = findStartSha(input, a);
    if (base) {
      try {
        const out = deps.readGit(['log', `${base}..origin/main`, '--oneline', '--', a.path], a.root, 4000);
        if (out.trim().length > 0) {
          cleared[a.path] = { by: 'local-git-origin-main' };
          continue;
        }
      } catch {
        /* @silent-fallback-ok — R34: the local shortcut is positive-only; absence or
           error falls through to the gh authority, never refuses. */
      }
    }

    // Negative-TTL cache: skip the external query for fresh negatives (R22).
    if (input.negativeCached.has(a.path)) continue;

    // Merged-PR authority (gh) — ONE batched fetch per evaluation.
    if (!ghAttempted) {
      ghAttempted = true;
      const left = ghBudget - (now() - t0);
      if (left > 500) {
        mergedPrs = fetchMergedPrs(deps, input.startedAt, Math.min(left, ghBudget));
        if (mergedPrs === null) degraded = true;
      } else {
        degraded = true;
      }
    }
    if (mergedPrs) {
      const relax = isRelaxedDocClass(a.path);
      const hit = mergedPrs.find((pr) => mergedPrSatisfiesPredicate(pr, a.path, relax));
      if (hit) {
        cleared[a.path] = { by: 'merged-pr', detail: `#${hit.number}` };
        continue;
      }
      newNegatives.push(a.path);
    }
    // gh degraded → leave uncorroborated with NO negative stamp (a network
    // failure must not suppress the retry once gh recovers).
  }

  return { cleared, newNegatives, degraded };
}

function findStartSha(input: CorroborationInput, a: AccretedArtifact): string | null {
  // The caller's record carries per-root SHAs; the sweep artifact only carries
  // its root. We accept an injected resolution via input — for simplicity the
  // route passes base-root SHAs through `artifactStartShas`.
  const shas = (input as unknown as { artifactStartShas?: Record<string, string | null> }).artifactStartShas;
  if (!shas) return null;
  return shas[path.resolve(a.root)] ?? null;
}

export interface CorroborationInputWithShas extends CorroborationInput {
  /** path.resolve(root) → start SHA, for the local-git shortcut. */
  artifactStartShas: Record<string, string | null>;
}
