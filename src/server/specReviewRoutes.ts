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
import { FULL_BODY_LIMIT_BYTES } from './bodyBudget.js';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { IntelligenceProvider } from '../core/types.js';
import { loadStandardsRegistry, parseStandardsRegistry, runRegistryCanary, parseStandardsRegistryDetailed } from '../core/StandardsRegistryParser.js';
import type { RegistryResolution } from '../core/standardsRegistryPath.js';
import { StandardsConformanceReviewer } from '../core/reviewers/standards-conformance.js';
import { recordConformanceInvocationAt } from '../core/AutonomousRunStore.js';
import { recordSpecConstitutionCheck, readSpecConstitutionChecks } from '../core/specConstitutionCheckLedger.js';

/**
 * Derive the spec SLUG a conformance-check invocation is recorded under
 * (scope-accretion R32): frontmatter `slug:` when present, else the specPath
 * basename minus `.md`. Empty when neither resolves (nothing recorded).
 */
/**
 * The route's outer request budget (middleware SPEC_REVIEW_TIMEOUT_MS; a test pins the
 * two equal). Kept as a local constant so this module does not import the middleware.
 */
export const CONFORMANCE_ROUTE_BUDGET_MS = 180_000;

/** Time kept back from the route budget for recording and replying after the fit call. */
export const REPLY_MARGIN_MS = 10_000;

/** What the fit call may use: the route budget left since the request arrived, less the reply margin. */
export function fitTimeLeft(startedAt: number, now: number): number {
  return CONFORMANCE_ROUTE_BUDGET_MS - (now - startedAt) - REPLY_MARGIN_MS;
}

export function conformanceSlugFor(markdown: string, specPath?: string): string {
  const fm = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fm) {
    const m = fm[1].match(/^slug:\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  if (specPath) return path.basename(specPath).replace(/\.md$/, '');
  return '';
}

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
  /**
   * The constitution AS RESOLVED by `src/core/standardsRegistryPath.ts` — never a
   * path this module builds. Taking the resolution (not a string) is the API
   * boundary that keeps a reader from silently reacquiring the agent-home-snapshot
   * bug: there is no raw path exported to shortcut.
   */
  registryResolution: RegistryResolution;
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
    // The budget clock starts when the request arrives, as the middleware's does.
    const startedAt = Date.now();
    let markdown: string | undefined;
    if (typeof req.body?.markdown === 'string' && req.body.markdown.trim()) {
      markdown = req.body.markdown;
    } else if (typeof req.body?.specPath === 'string' && req.body.specPath.trim()) {
      const p = resolveSpecPath(req.body.specPath);
      if (!p) return res.status(400).json({ error: 'specPath escapes specsDir' });
      if (!fs.existsSync(p)) return res.status(404).json({ error: 'spec not found' });
      // A spec file is held to the same ceiling as an inline spec (the general JSON parser's
      // FULL_BODY_LIMIT_BYTES), so the route never builds a prompt from an unbounded read.
      // Refused plainly, never cut: nothing is judged from part of the file.
      try {
        const size = fs.statSync(p).size;
        if (size > FULL_BODY_LIMIT_BYTES) {
          return res.status(413).json({ error: `spec too large to judge: ${size} bytes, over ${FULL_BODY_LIMIT_BYTES}`, checked: false, notChecked: `not checked: the spec file (${size} bytes) is over the ${FULL_BODY_LIMIT_BYTES}-byte input ceiling; nothing was read or judged` });
        }
      } catch (err) { return res.status(500).json({ error: `read failed: ${(err as Error).message}` }); }
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
    if (!deps.registryResolution.usable) {
      return res.status(503).json({
        error: `constitution unusable: ${deps.registryResolution.reason}`,
        detail: deps.registryResolution.detail,
      });
    }
    // Parse the bytes the RESOLUTION carries — never re-open `path`.
    //
    // This callsite was the widest seam in the change and four reviewers named it
    // independently: the resolution is built ONCE at server construction
    // (`AgentServer`), while this handler re-read the file per request. So the
    // integrity check was a boot-time snapshot and the graded bytes were read hours
    // later — on the HIGHER-stakes endpoint, the one that grades specs and feeds the
    // pre-commit gate. The coverage route closed its seam and the spec generalized
    // the claim to "consumers"; this consumer had a wider seam than the original.
    //
    // There is nothing left to throw here (the bytes are in hand), so the former
    // `catch → 503` is gone rather than kept as decoration.
    const detailed = parseStandardsRegistryDetailed(deps.registryResolution.markdown);
    articles = detailed.articles;
    // Diagnostics are passed so the COMPLETENESS half of the canary actually runs.
    // Without them `completenessAssessed` is false and the dropped-heading check —
    // the one that catches a truncated constitution — silently does not happen.
    const canary = runRegistryCanary(articles, detailed.diagnostics);

    // The review also stays inside what is left of the budget (setup time counts).
    const report = await reviewer.review(markdown, articles, { timeoutMs: fitTimeLeft(startedAt, Date.now()) });

    // Constitutional Traceability (Part C): attach the fit verdict for the spec's
    // named parent constitutional standard. parentPrinciple comes from the request
    // body or the spec's frontmatter; when present, judgeFit returns fit/weak/none
    // (and 'not-checked' when the reviewer is degraded: never a pass, never a block). Absent → no fit field
    // (the caller — e.g. the pre-commit gate — treats a missing parent as block).
    const parentPrinciple = (typeof req.body?.parentPrinciple === 'string' && req.body.parentPrinciple.trim())
      ? req.body.parentPrinciple.trim()
      : extractParentPrinciple(markdown);
    if (parentPrinciple) {
      // The review and the fit judgment share the route's request budget: the fit call
      // gets only what is left (less a reply margin), so a slow whole-spec review ends
      // as a stated 'not checked' fit, never a 408 that hides both results.
      const left = fitTimeLeft(startedAt, Date.now());
      // Made even after a too-long review: the fit prompt carries the spec with one
      // standard, not the whole constitution, so it can fit where the review did not.
      report.fit = await reviewer.judgeFit(markdown, parentPrinciple, articles, { timeoutMs: left });
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

    // Scope-accretion ceremony evidence (R32): the spec-converge ceremony calls
    // THIS route on every round, so the invocation is persisted server-side
    // keyed by spec slug — a forged convergence report without a real ceremony
    // run has no server record, and the report arm of corroboration can never
    // clear on it. Best-effort: a miss only DELAYS clearing (keep-working).
    // Only a run that actually CHECKED the spec counts: a degraded run (too long,
    // no provider, error, unreadable reply) judged nothing, so it is not evidence
    // that the ceremony checked this spec.
    try {
      const slug = conformanceSlugFor(markdown, typeof req.body?.specPath === 'string' ? req.body.specPath : undefined);
      if (slug && !report.degraded) recordConformanceInvocationAt(deps.stateDir, slug);
    } catch { /* @silent-fallback-ok — ceremony-record persistence is corroboration
                 evidence only; a miss fails toward keep-working (R21/R22) */ }

    // B24 evidence (Echo Bugs topic 10000002750): the latest result per spec, read by
    // the outbound tone gate and the Work Board judge when an approval of a spec or
    // design is asked of the operator. Best-effort: a miss only means that ask is
    // held until the check is re-run (the agent's own step, never the operator's).
    try {
      recordSpecConstitutionCheck(deps.stateDir, {
        slug: conformanceSlugFor(markdown, typeof req.body?.specPath === 'string' ? req.body.specPath : undefined),
        markdown,
        report,
      });
    } catch { /* @silent-fallback-ok — record is evidence only; a miss fails toward re-running the check */ }

    // A degraded report is NOT a result. Say so at the top level too, so a caller
    // that only looks at findings cannot read an unchecked spec as a clean one.
    res.json({
      report,
      registryCanary: canary,
      checked: !report.degraded,
      ...(report.degraded ? { notChecked: report.notCheckedReason ?? `not checked: ${report.degradeReason ?? 'unknown'}` } : {}),
      // The fit judgment is a second model call and can fail on its own.
      ...(report.fit ? { fitChecked: !report.fit.degraded } : {}),
    });
  });

  // This machine's recorded constitution checks (B24 proxied-on-read source). Local only:
  // a peer asks each machine for its own records and merges them; this never fans out.
  router.get('/spec/constitution-checks', (_req: Request, res: Response) => {
    res.json({ records: readSpecConstitutionChecks(deps.stateDir) });
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
  const startedAt = Date.now();
  const report = await reviewer.review(markdown, articles);
  const parentPrinciple = extractParentPrinciple(markdown);
  if (parentPrinciple) {
    report.fit = await reviewer.judgeFit(markdown, parentPrinciple, articles, { timeoutMs: fitTimeLeft(startedAt, Date.now()) });
  }
  return { report, registryCanary: canary };
}
