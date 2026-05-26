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
import type { SpecArtifact } from './FeatureRolloutReconciler.js';
import type { RolloutFlagObservation } from './featureRollout.js';

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

interface TraceInfo { prNumber?: number; createdAtMs?: number; }

function indexTraces(tracesDir: string): Map<string, TraceInfo> {
  const byPath = new Map<string, TraceInfo>();
  let files: string[] = [];
  try { files = fs.readdirSync(tracesDir).filter(f => f.endsWith('.json')); } catch { return byPath; }
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(tracesDir, f), 'utf8'));
      if (typeof t.specPath === 'string') {
        byPath.set(t.specPath, { prNumber: typeof t.prNumber === 'number' ? t.prNumber : undefined, createdAtMs: t.createdAt ? Date.parse(t.createdAt) : undefined });
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

/**
 * Observe a feature's flag for stage derivation — READ-ONLY. Reads the agent's
 * live config and the shipped ConfigDefaults default. Never writes.
 */
export function makeFlagObserver(liveConfig: unknown, shippedDefaults: unknown): (flagPath: string) => RolloutFlagObservation {
  return (flagPath: string) => {
    const live = readPath(liveConfig, flagPath) as { enabled?: boolean; dryRun?: boolean } | undefined;
    const def = readPath(shippedDefaults, flagPath) as { enabled?: boolean } | undefined;
    return {
      flagEnabled: live?.enabled,
      flagDryRun: live?.dryRun,
      defaultEnabled: def?.enabled === true,
    };
  };
}
