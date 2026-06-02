/**
 * Spec-review HTTP routes — the standards-conformance gate surface.
 *
 *   POST /spec/conformance-check   — check a spec against the constitution → report
 *   GET  /spec/conformance-metrics — observability funnel (runs, per-standard flags)
 *
 * Signal-only (spec §4): returns a report; never blocks. Operator/skill-callable;
 * classified INTERNAL (build-time tool, not an agent-discoverable runtime capability).
 *
 * Spec: docs/specs/standards-conformance-gate.md §3, §5.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { IntelligenceProvider } from '../core/types.js';
import { loadStandardsRegistry, parseStandardsRegistry, runRegistryCanary } from '../core/StandardsRegistryParser.js';
import { StandardsConformanceReviewer } from '../core/reviewers/standards-conformance.js';

// ── File-backed metrics (Observability: reloads on restart) ────────────────

interface ConformanceMetrics {
  runs: number;
  degraded: number;
  findings_total: number;
  by_standard: Record<string, number>;
  last_run_at: string | null;
}

function emptyMetrics(): ConformanceMetrics {
  return { runs: 0, degraded: 0, findings_total: 0, by_standard: {}, last_run_at: null };
}

function loadMetrics(file: string): ConformanceMetrics {
  try {
    if (fs.existsSync(file)) {
      const m = JSON.parse(fs.readFileSync(file, 'utf-8')) as ConformanceMetrics;
      return { ...emptyMetrics(), ...m, by_standard: m.by_standard ?? {} };
    }
  } catch { /* corrupt → fresh */ }
  return emptyMetrics();
}

function saveMetrics(file: string, m: ConformanceMetrics): void {
  try {
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`[specReviewRoutes] metrics save failed: ${err}`);
  }
}

/**
 * Extract the `parent-principle` value from a spec's YAML frontmatter
 * (Constitutional Traceability). Returns '' when absent — the caller then knows
 * the spec named no parent (a block-worthy condition: name a real parent).
 */
export function extractParentPrinciple(md: string): string {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return '';
  const m = fm[1].match(/^parent-principle:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

export function createSpecReviewRoutes(deps: {
  intelligence: IntelligenceProvider | null;
  /** Path to docs/STANDARDS-REGISTRY.md (the constitution). */
  registryPath: string;
  /** Directory specs are read from; specPath inputs are resolved within it (no traversal). */
  specsDir: string;
  /** Where to persist conformance metrics. */
  stateDir: string;
  /** Master switch; default true. When false, routes 503-stub. */
  enabled?: boolean;
  /** Model tier override (default 'capable'). */
  model?: 'fast' | 'balanced' | 'capable';
}): Router {
  const router = Router();
  const enabled = deps.enabled !== false;
  const metricsFile = path.join(deps.stateDir, 'spec-conformance-metrics.json');
  const reviewer = new StandardsConformanceReviewer(deps.intelligence, { model: deps.model });

  if (!enabled) {
    router.use('/spec', (_req, res) => res.status(503).json({ error: 'spec conformance gate disabled' }));
    return router;
  }

  /** Resolve a caller-supplied specPath safely within specsDir (block traversal). */
  function resolveSpecPath(specPath: string): string | null {
    const resolved = path.resolve(deps.specsDir, specPath);
    const base = path.resolve(deps.specsDir);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    return resolved;
  }

  router.post('/spec/conformance-check', async (req: Request, res: Response) => {
    let markdown: string | undefined;
    if (typeof req.body?.markdown === 'string' && req.body.markdown.trim()) {
      markdown = req.body.markdown;
    } else if (typeof req.body?.specPath === 'string' && req.body.specPath.trim()) {
      const p = resolveSpecPath(req.body.specPath);
      if (!p) return res.status(400).json({ error: 'specPath escapes specsDir' });
      if (!fs.existsSync(p)) return res.status(404).json({ error: 'spec not found' });
      try { markdown = fs.readFileSync(p, 'utf-8'); }
      catch (err) { return res.status(500).json({ error: `read failed: ${(err as Error).message}` }); }
    } else {
      return res.status(400).json({ error: 'provide markdown or specPath' });
    }

    if (typeof markdown !== 'string' || !markdown.trim()) {
      return res.status(400).json({ error: 'empty spec content' });
    }

    // Load + canary the constitution; a drifted/partial registry must not silently
    // produce a misleadingly-clean report.
    let articles;
    try { articles = loadStandardsRegistry(deps.registryPath); }
    catch (err) { return res.status(503).json({ error: `constitution unreadable: ${(err as Error).message}` }); }
    const canary = runRegistryCanary(articles);

    const report = await reviewer.review(markdown, articles);

    // Constitutional Traceability (Part C): attach the fit verdict for the spec's
    // named parent constitutional standard. parentPrinciple comes from the request
    // body or the spec's frontmatter; when present, judgeFit returns fit/weak/none
    // (and fails open to 'fit' when the reviewer is degraded). Absent → no fit field
    // (the caller — e.g. the pre-commit gate — treats a missing parent as block).
    const parentPrinciple = (typeof req.body?.parentPrinciple === 'string' && req.body.parentPrinciple.trim())
      ? req.body.parentPrinciple.trim()
      : extractParentPrinciple(markdown);
    if (parentPrinciple) {
      report.fit = await reviewer.judgeFit(markdown, parentPrinciple, articles);
    }

    // Record metrics (best-effort).
    try {
      const m = loadMetrics(metricsFile);
      m.runs += 1;
      if (report.degraded) m.degraded += 1;
      m.findings_total += report.findings.length;
      for (const f of report.findings) m.by_standard[f.standard] = (m.by_standard[f.standard] ?? 0) + 1;
      m.last_run_at = report.checkedAt;
      saveMetrics(metricsFile, m);
    } catch { /* metering best-effort */ }

    res.json({ report, registryCanary: canary });
  });

  router.get('/spec/conformance-metrics', (_req: Request, res: Response) => {
    res.json({ metrics: loadMetrics(metricsFile) });
  });

  return router;
}

/** Exposed for the CLI (no HTTP): run a conformance check on raw markdown. */
export async function runConformanceCheck(
  markdown: string,
  registryMarkdown: string,
  intelligence: IntelligenceProvider | null,
  model?: 'fast' | 'balanced' | 'capable',
) {
  const articles = parseStandardsRegistry(registryMarkdown);
  const canary = runRegistryCanary(articles);
  const reviewer = new StandardsConformanceReviewer(intelligence, { model });
  const report = await reviewer.review(markdown, articles);
  const parentPrinciple = extractParentPrinciple(markdown);
  if (parentPrinciple) {
    report.fit = await reviewer.judgeFit(markdown, parentPrinciple, articles);
  }
  return { report, registryCanary: canary };
}
