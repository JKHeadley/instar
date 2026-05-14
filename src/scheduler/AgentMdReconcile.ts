/**
 * AgentMdReconcile — boot-time consistency check for the agentmd job tree.
 *
 * Per INSTAR-JOBS-AS-AGENTMD spec §Runtime "Load lifecycle (boot)":
 *
 *   reconcile() runs at boot, surfaces orphan/shadow/missing on boot.
 *   Output goes to Dashboard Issues card.
 *
 * Categories surfaced:
 *
 *   - ORPHAN-MANIFEST: A `<slug>.json` per-slug manifest exists but the
 *     `.md` it references does NOT. Scheduler cannot resolve the body;
 *     entry is excluded from jobs[] and surfaced as Issues-card row.
 *
 *   - SHADOW-MD: A `<slug>.md` exists in either `instar/` or `user/` but
 *     has no per-slug manifest. The body is on disk but the scheduler
 *     has no schedule for it — Issues-card "Add to schedule (disabled)"
 *     or "Delete file" actions apply.
 *
 *   - MISSING-FROM-JOBS-JSON: A legacy `jobs.json` entry has no
 *     corresponding per-slug manifest AND no `.md` under user/ or
 *     instar/. Mid-migration state; not yet copied over.
 *
 *   - STAGED-NEW: A `.md.new` or `.json.new` left over from a crashed
 *     atomic save (see AgentMdAtomicSave). Issues-card "Apply" /
 *     "Discard" actions apply.
 *
 *   - CASE-COLLISION: Two slug files differ only by case (NFC normalized)
 *     in the same directory. Both are excluded from jobs[] by the
 *     loader; this row surfaces them together.
 *
 * Pure function — reads the file system, returns a structured report.
 * The caller (boot lifecycle in JobLoader; Phase 4 Dashboard read
 * endpoint) decides how to present the rows.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Local scanner for `.new` staged files. Will be replaced with the
 *  shared `listStagedNewFiles()` export from `AgentMdAtomicSave.ts`
 *  once that PR merges (echo/two-rename-atomicity). */
function scanStagedFiles(jobsRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && (p.endsWith('.md.new') || p.endsWith('.json.new'))) {
        found.push(p);
      }
    }
  };
  walk(jobsRoot);
  return found;
}

export type ReconcileFindingKind =
  | 'orphan-manifest'
  | 'shadow-md'
  | 'missing-from-jobs-json'
  | 'staged-new'
  | 'case-collision';

export interface ReconcileFinding {
  kind: ReconcileFindingKind;
  /** Affected slug (when computable). */
  slug?: string;
  /** Affected file path (absolute). */
  filePath?: string;
  /** Two-pane comparison: for case-collision, both paths. */
  conflictingPaths?: string[];
  /** One-line operator-facing summary. */
  summary: string;
  /** Stable severity ordering for the Issues card. */
  severity: 'info' | 'warning' | 'error';
}

export interface ReconcileReport {
  findings: ReconcileFinding[];
  summary: {
    total: number;
    byKind: Record<ReconcileFindingKind, number>;
  };
}

export interface ReconcileOptions {
  /** State directory root (e.g., `<projectDir>/.instar/`). */
  stateDir: string;
}

const EMPTY_BY_KIND: Record<ReconcileFindingKind, number> = {
  'orphan-manifest': 0,
  'shadow-md': 0,
  'missing-from-jobs-json': 0,
  'staged-new': 0,
  'case-collision': 0,
};

export function reconcileAgentMdTree(opts: ReconcileOptions): ReconcileReport {
  const { stateDir } = opts;
  const jobsRoot = path.join(stateDir, 'jobs');
  const scheduleDir = path.join(jobsRoot, 'schedule');
  const instarDir = path.join(jobsRoot, 'instar');
  const userDir = path.join(jobsRoot, 'user');
  const jobsJsonPath = path.join(stateDir, 'jobs.json');

  const findings: ReconcileFinding[] = [];
  const byKind: Record<ReconcileFindingKind, number> = { ...EMPTY_BY_KIND };

  // ── Index the per-slug manifests ─────────────────────────────────
  const manifestSlugs = new Map<string, { path: string; origin?: string }>();
  if (fs.existsSync(scheduleDir)) {
    for (const f of fs.readdirSync(scheduleDir)) {
      if (!f.endsWith('.json')) continue;
      const slug = path.basename(f, '.json');
      const p = path.join(scheduleDir, f);
      let origin: string | undefined;
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        origin = typeof parsed?.origin === 'string' ? parsed.origin : undefined;
      } catch {
        // Surface as orphan + add to find later.
      }
      manifestSlugs.set(slug, { path: p, origin });
    }
  }

  // ── Index the .md files under instar/ and user/ ──────────────────
  const mdSlugs = new Map<string, { path: string; namespace: 'instar' | 'user' }>();
  for (const [dir, ns] of [
    [instarDir, 'instar'],
    [userDir, 'user'],
  ] as const) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md') || f.startsWith('.')) continue;
      const slug = path.basename(f, '.md');
      const p = path.join(dir, f);
      mdSlugs.set(slug, { path: p, namespace: ns });
    }
  }

  // ── Orphan manifests: manifest exists, no .md ────────────────────
  for (const [slug, info] of manifestSlugs.entries()) {
    if (!mdSlugs.has(slug)) {
      findings.push({
        kind: 'orphan-manifest',
        slug,
        filePath: info.path,
        summary: `Manifest "${slug}.json" exists but no matching .md under ${info.origin === 'instar' ? 'instar/' : info.origin === 'user' ? 'user/' : 'instar/ or user/'}.`,
        severity: 'error',
      });
      byKind['orphan-manifest']++;
    }
  }

  // ── Shadow .md: .md exists, no manifest ───────────────────────────
  for (const [slug, info] of mdSlugs.entries()) {
    if (!manifestSlugs.has(slug)) {
      findings.push({
        kind: 'shadow-md',
        slug,
        filePath: info.path,
        summary: `Body file "${slug}.md" exists under ${info.namespace}/ but no per-slug manifest at schedule/${slug}.json.`,
        severity: 'warning',
      });
      byKind['shadow-md']++;
    }
  }

  // ── Missing from jobs.json: legacy entry not yet copied ──────────
  if (fs.existsSync(jobsJsonPath)) {
    try {
      const entries = JSON.parse(fs.readFileSync(jobsJsonPath, 'utf-8'));
      if (Array.isArray(entries)) {
        for (const e of entries) {
          if (!e || typeof e !== 'object' || typeof e.slug !== 'string') continue;
          if (e.execute?.type !== 'prompt') continue;
          if (!manifestSlugs.has(e.slug) && !mdSlugs.has(e.slug)) {
            findings.push({
              kind: 'missing-from-jobs-json',
              slug: e.slug,
              summary: `Legacy jobs.json entry "${e.slug}" has no per-slug manifest and no body file. Migration may have partially run.`,
              severity: 'warning',
            });
            byKind['missing-from-jobs-json']++;
          }
        }
      }
    } catch {
      // jobs.json malformed — separate concern, not surfaced here.
    }
  }

  // ── Staged .new files from interrupted atomic save ───────────────
  for (const staged of scanStagedFiles(jobsRoot)) {
    findings.push({
      kind: 'staged-new',
      filePath: staged,
      summary: `Staged file from interrupted save: ${path.relative(stateDir, staged)}. Operator can apply or discard via Dashboard.`,
      severity: 'info',
    });
    byKind['staged-new']++;
  }

  // ── Case collisions: two .md or .json files differ only by case ──
  detectCaseCollisions(instarDir, '.md', findings, byKind);
  detectCaseCollisions(userDir, '.md', findings, byKind);
  detectCaseCollisions(scheduleDir, '.json', findings, byKind);

  return {
    findings,
    summary: { total: findings.length, byKind },
  };
}

function detectCaseCollisions(
  dir: string,
  ext: string,
  findings: ReconcileFinding[],
  byKind: Record<ReconcileFindingKind, number>,
): void {
  if (!fs.existsSync(dir)) return;
  const seen = new Map<string, string[]>();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(ext) || f.startsWith('.')) continue;
    const slug = path.basename(f, ext);
    const normalized = slug.normalize('NFC').toLowerCase();
    if (!seen.has(normalized)) seen.set(normalized, []);
    seen.get(normalized)!.push(path.join(dir, f));
  }
  for (const [, paths] of seen) {
    if (paths.length > 1) {
      findings.push({
        kind: 'case-collision',
        conflictingPaths: paths,
        summary: `Case-only filename collision in ${path.basename(dir)}/: ${paths.map((p) => path.basename(p)).join(' vs ')}. Both excluded from jobs[]; manual resolution required.`,
        severity: 'error',
      });
      byKind['case-collision']++;
    }
  }
}
