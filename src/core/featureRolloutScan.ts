/**
 * featureRolloutScan — the fs/git side of the FeatureRolloutReconciler: turn
 * docs/specs + instar-dev traces + live config into SpecArtifact[] and a flag
 * observer. Kept separate from the reconciler so the reconciliation LOGIC stays
 * pure/unit-tested; this module is the (lightly-tested) I/O adapter.
 *
 * Merged-detection note: the reconciler primarily runs on DEPLOYED agents (on
 * the released version), where a present + approved spec is by definition shipped.
 * So "merged" = approved frontmatter + a completed trace referencing it; recency
 * comes from the trace timestamp. Precise git-merge introspection is a refinement.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SafeGitExecutor } from './SafeGitExecutor.js';
import type { SpecArtifact } from './FeatureRolloutReconciler.js';
import type { RolloutFlagObservation } from './featureRollout.js';
import type { MaturationEvaluationContract, MaturationMetricSource } from './InitiativeTracker.js';

const RECENT_MERGE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14d ⇒ active vs terminal backfill

export function normalizeSpecId(specFileName: string): string {
  const base = specFileName.replace(/\.md$/i, '').replace(/\.eli16$/i, '');
  let id = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (id.length > 63) {
    // Truncate + short hash suffix to avoid prefix collisions (spec §4.1).
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    id = id.slice(0, 54) + '-' + h.toString(36).slice(0, 8);
  }
  return id || 'spec';
}

/** Minimal frontmatter reader (the specs use simple `key: value` lines). */
export function parseSpecFrontmatter(content: string): Record<string, string> {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export type MaturationContractError = 'invalid-json' | 'oversized' | 'invalid-shape' | 'unknown-source-ref';
export type MaturationContractParseResult =
  | { ok: true; contract: MaturationEvaluationContract }
  | { ok: false; error: MaturationContractError };

const MATURATION_SOURCE_REFS: Readonly<Record<MaturationMetricSource, ReadonlySet<string>>> = {
  'blocker-summary': new Set([
    'request-to-persist.coverage', 'request-to-persist.p95Ms',
    'clear-latency.coverage', 'clear-latency.p95Ms',
  ]),
  'blocker-trend': new Set(['request-to-persist.ratio', 'clear-latency.ratio']),
};

export function parseMaturationContract(raw: string | undefined): MaturationContractParseResult | undefined {
  if (!raw) return undefined;
  if (Buffer.byteLength(raw) > 16_384) return { ok: false, error: 'oversized' };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { ok: false, error: 'invalid-json' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'invalid-shape' };
  const v = value as Record<string, unknown>;
  if (!Number.isInteger(v.cadenceHours) || (v.cadenceHours as number) < 6 || (v.cadenceHours as number) > 168 || (v.cadenceHours as number) % 6 !== 0 ||
      !Number.isInteger(v.evidenceMaxAgeHours) || (v.evidenceMaxAgeHours as number) < (v.cadenceHours as number) ||
      (v.evidenceMaxAgeHours as number) > Math.min(168, (v.cadenceHours as number) * 2) ||
      !Array.isArray(v.metrics) || v.metrics.length < 1 || v.metrics.length > 16) {
    return { ok: false, error: 'invalid-shape' };
  }
  const ids = new Set<string>();
  const metrics = [] as MaturationEvaluationContract['metrics'];
  for (const rawMetric of v.metrics) {
    if (!rawMetric || typeof rawMetric !== 'object' || Array.isArray(rawMetric)) return { ok: false, error: 'invalid-shape' };
    const m = rawMetric as Record<string, unknown>;
    if (typeof m.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(m.id) || ids.has(m.id) ||
        !['blocker-summary', 'blocker-trend'].includes(String(m.source)) || typeof m.sourceRef !== 'string' ||
        !['at-least', 'at-most'].includes(String(m.direction)) || typeof m.threshold !== 'number' || !Number.isFinite(m.threshold) ||
        !Number.isInteger(m.minSamples) || (m.minSamples as number) < 1 || (m.minSamples as number) > 100_000) {
      return { ok: false, error: 'invalid-shape' };
    }
    const source = m.source as MaturationMetricSource;
    if (!MATURATION_SOURCE_REFS[source].has(m.sourceRef)) return { ok: false, error: 'unknown-source-ref' };
    ids.add(m.id);
    metrics.push({ id: m.id, source, sourceRef: m.sourceRef, direction: m.direction as 'at-least' | 'at-most', threshold: m.threshold, minSamples: m.minSamples as number });
  }
  return { ok: true, contract: { cadenceHours: v.cadenceHours as number, evidenceMaxAgeHours: v.evidenceMaxAgeHours as number, metrics } };
}

function maturationContractFrom(fm: Record<string, string>): MaturationEvaluationContract | undefined {
  const parsed = parseMaturationContract(fm['rollout-metrics-json']);
  return parsed?.ok ? parsed.contract : undefined;
}

interface TraceInfo { prNumber?: number; createdAtMs?: number; }

function indexTraces(tracesDir: string): Map<string, TraceInfo> {
  const byPath = new Map<string, TraceInfo>();
  let files: string[] = [];
  try { files = fs.readdirSync(tracesDir).filter(f => f.endsWith('.json')); } catch { return byPath; }
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(tracesDir, f), 'utf8'));
      if (typeof t.specPath === 'string') {
        // Traces carry the timestamp as `createdAt` (newer) or `timestamp` (older).
        const ts = t.createdAt ?? t.timestamp;
        byPath.set(t.specPath, { prNumber: typeof t.prNumber === 'number' ? t.prNumber : undefined, createdAtMs: ts ? Date.parse(ts) : undefined });
      }
    } catch { /* skip malformed trace */ }
  }
  return byPath;
}

/** Scan docs/specs + traces into SpecArtifact[]. */
export function scanSpecArtifacts(repoRoot: string, now: () => number = () => Date.now()): SpecArtifact[] {
  const specsDir = path.join(repoRoot, 'docs', 'specs');
  const traces = indexTraces(path.join(repoRoot, '.instar', 'instar-dev-traces'));
  const out: SpecArtifact[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(specsDir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.md') || f.endsWith('.eli16.md')) continue;
    const specPath = `docs/specs/${f}`;
    let content: string;
    try { content = fs.readFileSync(path.join(specsDir, f), 'utf8'); } catch { continue; }
    const fm = parseSpecFrontmatter(content);
    const approved = fm.approved === 'true';
    const reviewConverged = Boolean(fm['review-convergence']);
    const shipsStaged = fm['ships-staged'] === 'true';
    const trace = traces.get(specPath);
    const traceExists = trace != null;
    // Deployed-agent semantics: approved + a completed trace ⇒ shipped/merged.
    const merged = approved && traceExists;
    const mergedRecently = merged && trace?.createdAtMs != null && (now() - trace.createdAtMs) <= RECENT_MERGE_WINDOW_MS;
    out.push({
      id: normalizeSpecId(f),
      specPath,
      title: (content.match(/^#\s+(.+)$/m)?.[1] ?? fm.title ?? f).slice(0, 120),
      approved, reviewConverged, shipsStaged,
      flagPath: fm['rollout-flag-path'] || undefined,
      promotionCriteria: fm['rollout-criteria'] || undefined,
      evidenceSource: fm['rollout-evidence-ref']
        ? { type: (fm['rollout-evidence-type'] as 'log-filter' | 'endpoint') || 'log-filter', ref: fm['rollout-evidence-ref'], filter: fm['rollout-evidence-filter'] || undefined }
        : undefined,
      maturationEvaluation: maturationContractFrom(fm),
      traceExists,
      prNumber: trace?.prNumber,
      merged,
      mergedRecently,
    });
  }
  return out;
}

/** Read a dotted config path, e.g. 'monitoring.sessionReaper', from an object. */
function readPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
}

// ── Canonical-ref scan (Layer C of release-readiness-visibility) ────────
//
// The local-tree scan above infers `merged = approved && traceExists` from
// LOCAL files. As the maintainer's dev branch moves around, freshly-merged
// specs can be absent locally (different branch / cleaned worktree) → the
// reconciler silently skips them. The canonical scan reads `docs/specs/` and
// `.instar/instar-dev-traces/` from the canonical `main` ref directly, so a
// spec on main is detected as merged by construction. Repo-gated +
// feature-flagged + falls back to local on any failure (never throws into
// boot).

export interface CanonicalScanOpts {
  repoPath: string;
  /** A git remote name configured in repoPath; the canonical-remote allow-list
   *  on the caller's side already validated this. */
  canonicalRemote: string;
  fetchTimeoutMs?: number;
  now?: () => number;
}

export interface CanonicalScanResult {
  artifacts: SpecArtifact[];
  canonicalHeadSha: string;
}

export function scanSpecArtifactsCanonical(opts: CanonicalScanOpts): CanonicalScanResult {
  const now = opts.now ?? (() => Date.now());
  const timeout = opts.fetchTimeoutMs ?? 30_000;

  // 1) Bounded fetch (no --depth: matches the Layer-B fix that --depth=1
  //    shallows the local repo and breaks downstream git log).
  SafeGitExecutor.run(
    ['fetch', opts.canonicalRemote, 'main', '--no-tags', '--no-recurse-submodules'],
    {
      cwd: opts.repoPath,
      operation: 'featureRolloutScan:canonicalFetch',
      timeout,
      // LAYER C explicitly scans the instar source tree (a present-but-on-
      // wrong-branch spec is the bug being fixed). fetch is data-pull
      // (FETCH_HEAD + objects only). See SafeGitOptions.sourceTreeReadOk.
      sourceTreeReadOk: true,
    },
  );
  const canonicalHeadSha = SafeGitExecutor.run(['rev-parse', 'FETCH_HEAD'], {
    cwd: opts.repoPath,
    operation: 'featureRolloutScan:canonicalRevParse',
    sourceTreeReadOk: true,
  }).trim();

  // 2) Enumerate spec files on main.
  const lsSpecs = SafeGitExecutor.run(
    ['ls-tree', '-r', '--name-only', canonicalHeadSha, '--', 'docs/specs/'],
    { cwd: opts.repoPath, operation: 'featureRolloutScan:lsSpecs', sourceTreeReadOk: true },
  );
  const specPaths = lsSpecs.split('\n').map((s) => s.trim()).filter((p) => p.endsWith('.md') && !p.endsWith('.eli16.md'));

  // 3) Enumerate trace files on main and index by specPath.
  let lsTraces = '';
  try {
    lsTraces = SafeGitExecutor.run(
      ['ls-tree', '-r', '--name-only', canonicalHeadSha, '--', '.instar/instar-dev-traces/'],
      { cwd: opts.repoPath, operation: 'featureRolloutScan:lsTraces', sourceTreeReadOk: true },
    );
  } catch { /* traces dir may not exist on main yet */ }
  const tracesByPath = new Map<string, TraceInfo>();
  for (const tp of lsTraces.split('\n').map((s) => s.trim()).filter((p) => p.endsWith('.json'))) {
    try {
      const blob = SafeGitExecutor.run(['show', `${canonicalHeadSha}:${tp}`], {
        cwd: opts.repoPath, operation: 'featureRolloutScan:traceBlob', sourceTreeReadOk: true,
      });
      const t = JSON.parse(blob);
      if (typeof t.specPath === 'string') {
        const ts = t.createdAt ?? t.timestamp;
        tracesByPath.set(t.specPath, {
          prNumber: typeof t.prNumber === 'number' ? t.prNumber : undefined,
          createdAtMs: ts ? Date.parse(ts) : undefined,
        });
      }
    } catch { /* skip malformed trace */ }
  }

  // 4) Build SpecArtifact[] from canonical blobs.
  const out: SpecArtifact[] = [];
  for (const specPath of specPaths) {
    let content: string;
    try {
      content = SafeGitExecutor.run(['show', `${canonicalHeadSha}:${specPath}`], {
        cwd: opts.repoPath, operation: 'featureRolloutScan:specBlob', sourceTreeReadOk: true,
      });
    } catch { continue; }
    const fm = parseSpecFrontmatter(content);
    const approved = fm.approved === 'true';
    const reviewConverged = Boolean(fm['review-convergence']);
    const shipsStaged = fm['ships-staged'] === 'true';
    const trace = tracesByPath.get(specPath);
    const traceExists = trace != null;
    // Canonical semantics: a spec on main IS merged by construction (it's
    // reachable from FETCH_HEAD). The previous inferred rule
    // (approved && traceExists) misses approved-but-untraced or
    // untraced-but-merged cases.
    const merged = true;
    const mergedRecently = merged && trace?.createdAtMs != null && (now() - trace.createdAtMs) <= RECENT_MERGE_WINDOW_MS;
    out.push({
      id: normalizeSpecId(path.basename(specPath)),
      specPath,
      title: (content.match(/^#\s+(.+)$/m)?.[1] ?? fm.title ?? specPath).slice(0, 120),
      approved, reviewConverged, shipsStaged,
      flagPath: fm['rollout-flag-path'] || undefined,
      promotionCriteria: fm['rollout-criteria'] || undefined,
      evidenceSource: fm['rollout-evidence-ref']
        ? { type: (fm['rollout-evidence-type'] as 'log-filter' | 'endpoint') || 'log-filter', ref: fm['rollout-evidence-ref'], filter: fm['rollout-evidence-filter'] || undefined }
        : undefined,
      maturationEvaluation: maturationContractFrom(fm),
      traceExists,
      prNumber: trace?.prNumber,
      merged,
      mergedRecently,
    });
  }

  return { artifacts: out, canonicalHeadSha };
}

/**
 * Repo-gated, feature-flagged scanner with graceful fallback to the local
 * scan on any failure. Never throws into the caller (boot-safe).
 */
export function scanSpecArtifactsWithCanonical(
  repoRoot: string,
  opts: {
    canonicalRefScanEnabled: boolean;
    canonicalRemote?: string;
    fetchTimeoutMs?: number;
    onDegradation?: (reason: string) => void;
  },
  now: () => number = () => Date.now(),
): SpecArtifact[] {
  if (!opts.canonicalRefScanEnabled) return scanSpecArtifacts(repoRoot, now);
  const remote = opts.canonicalRemote;
  if (!remote) {
    opts.onDegradation?.('canonical-ref scan enabled but no canonicalRemote configured — falling back to local scan');
    return scanSpecArtifacts(repoRoot, now);
  }
  try {
    const result = scanSpecArtifactsCanonical({
      repoPath: repoRoot, canonicalRemote: remote, fetchTimeoutMs: opts.fetchTimeoutMs, now,
    });
    return result.artifacts;
  } catch (err) {
    opts.onDegradation?.(`canonical-ref scan failed (${String((err as Error)?.message ?? err)}) — falling back to local scan`);
    return scanSpecArtifacts(repoRoot, now);
  }
}

/**
 * Observe a feature's flag for stage derivation — READ-ONLY. Reads the agent's
 * live config and the shipped ConfigDefaults default. Never writes.
 */
export function makeFlagObserver(liveConfig: unknown, shippedDefaults: unknown): (flagPath: string) => RolloutFlagObservation {
  return (flagPath: string) => {
    const live = readPath(liveConfig, flagPath);
    const def = readPath(shippedDefaults, flagPath);
    // A flag may be an object ({enabled,dryRun}) or a bare boolean.
    const liveObj = typeof live === 'boolean' ? { enabled: live } : (live as { enabled?: boolean; dryRun?: boolean } | undefined);
    const defObj = typeof def === 'boolean' ? { enabled: def } : (def as { enabled?: boolean } | undefined);
    return {
      flagEnabled: liveObj?.enabled,
      flagDryRun: liveObj?.dryRun,
      defaultEnabled: defObj?.enabled === true,
    };
  };
}
