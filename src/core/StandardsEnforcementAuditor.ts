/**
 * StandardsEnforcementAuditor — the registry-wide enforcement-coverage audit
 * (cartographer-conformance-audit spec #3, Parts B + C).
 *
 * For each constitutional standard in `docs/STANDARDS-REGISTRY.md`, it:
 *   1. parses the article (StandardsRegistryParser),
 *   2. extracts the enforcement references its prose NAMES (StandardEnforcementExtractor),
 *   3. VERIFIES each reference resolves against the live repo — a file via
 *      `fs.existsSync`, a route via a regex scan of `src/server/routes.ts`, a
 *      symbol/marker via a bounded grep of `src/**`,
 *   4. classifies the standard by its STRONGEST verified guard
 *      (`ratchet` > `gate` > `lint` > `spec-only` > `documented-only` gap),
 *   5. records DANGLING refs — a guard a standard names that no longer exists on
 *      disk (a broken guarantee, the loudest signal).
 *
 * Deterministic + idempotent: two runs over an unchanged registry+repo produce a
 * byte-identical report (refs are sorted; classifiedAt is omitted from the hashable
 * core). A content-hash short-circuit (registry hash + a cheap repo-structure signal)
 * skips recompute when nothing changed — the `docs-coverage.mjs` pattern.
 *
 * Observe-only, non-gating: it NEVER blocks anything. It produces a read-only
 * coverage report. "Signal vs. Authority" — a gap is a signal to build a guard.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseStandardsRegistryDetailed, runRegistryCanary } from './StandardsRegistryParser.js';
import { extractEnforcementRefs, flattenRefs, type EnforcementRef } from './StandardEnforcementExtractor.js';

export type EnforcementKind = 'ratchet' | 'gate' | 'lint' | 'spec-only' | 'documented-only';

export interface VerifiedGuard {
  /** The reference token (path / `METHOD /route` / symbol). */
  ref: string;
  /** Recognizer kind from extraction. */
  kind: 'file' | 'route' | 'marker';
  /** Did the reference resolve on disk / in the route table / in src? */
  verified: boolean;
  /** The classification weight this guard contributes (only when verified). */
  guardKind?: Exclude<EnforcementKind, 'documented-only'>;
}

export interface StandardCoverage {
  standard: string;
  family: string;
  enforcementKind: EnforcementKind;
  guards: VerifiedGuard[];
  /** Refs named in prose but NOT found on disk — broken guarantees (loud signal). */
  danglingRefs: string[];
  classifiedAt: string;
}

/**
 * What the audit's own inputs looked like, so a reader can tell an assessment
 * over the WHOLE constitution apart from one over a fragment of it.
 *
 * Born from honest-denominators instance 4 (2026-07-25): this auditor reported
 * `enforcedRatio: 0.0455` over 22 standards while the registry on disk carried
 * 81. Reading the same registry in full gives 0.5375. The ratio was not wrong
 * arithmetic — it was arithmetic over a denominator nobody could see, and the
 * result was a figure 12× more alarming than reality, quoted onward as fact.
 */
export interface RegistryProvenance {
  /** Absolute path of the registry file this pass actually read. */
  path: string;
  /** Bytes read — a 46KB copy where the source carries 248KB is a staleness tell. */
  bytes: number;
  /** Article headings found inside detected standards families — the parse denominator. */
  articleHeadings: number;
  /** Headings that parsed into an article. */
  parsed: number;
  /** Headings inside a family that carried no `**Rule.**` and were dropped. */
  droppedHeadings: string[];
  /** Families detected structurally. */
  families: string[];
  /** Registry-parse canary verdict — false means the numbers below are NOT trustworthy. */
  canaryOk: boolean;
  canaryFailures: string[];
}

export interface CoverageSummary {
  total: number;
  byKind: Record<EnforcementKind, number>;
  /**
   * (ratchet + gate + lint) / total — the fraction of standards with a verified
   * structural guard. **`null` when `total` is 0**: with nothing to divide by
   * there is no ratio, and reporting one (either the flattering 1 or the
   * damning 0) states a measurement that was never taken. Callers must render
   * null as "not assessed", never coerce it to a number.
   */
  enforcedRatio: number | null;
  /** Names of `documented-only` standards (the gaps). */
  gaps: string[];
  /** Total dangling refs across all standards. */
  danglingCount: number;
  /**
   * True only when the pass read a registry its own canary vouches for. False
   * means every figure in this summary describes a fragment or a drifted parse
   * — surface it beside the numbers rather than presenting them bare.
   */
  assessmentTrustworthy: boolean;
  /** Provenance of the registry this pass read. */
  registry: RegistryProvenance;
}

export interface CoverageReport {
  generatedAt: string;
  /** Hash of the inputs (registry content + repo-structure signal) — drives the short-circuit. */
  inputHash: string;
  standards: StandardCoverage[];
  summary: CoverageSummary;
}

export interface AuditorOptions {
  /** Path to docs/STANDARDS-REGISTRY.md. */
  registryPath: string;
  /** Repo root — all refs resolve relative to this. */
  projectDir: string;
}

const KIND_RANK: Record<Exclude<EnforcementKind, 'documented-only'>, number> = {
  ratchet: 4, gate: 3, lint: 2, 'spec-only': 1,
};

/** Classify a VERIFIED file ref into its guard weight. */
export function classifyFileGuard(ref: string): Exclude<EnforcementKind, 'documented-only'> {
  const base = ref.split('/').pop() ?? ref;
  // Ratchet: a CI test that fails on regression — `*.test.ts`, a `no-*` guard, a
  // `*-coverage` script.
  if (/\.test\.(ts|js|mjs)$/.test(base) || base.startsWith('no-') || /-coverage\.(mjs|js)$/.test(base)) {
    return 'ratchet';
  }
  // Lint: a `scripts/lint-*` static check.
  if (ref.startsWith('scripts/') && base.startsWith('lint-')) return 'lint';
  // Gate: a precommit/husky hook, or a server/source guard file (a hook script, a
  // gate module under src/). `.husky/*` and `scripts/*-precommit*` count as gates.
  if (ref.startsWith('.husky/') || /precommit/i.test(base)) return 'gate';
  if (ref.startsWith('scripts/')) return 'lint'; // a generic script guard → lint-strength
  // A docs/specs/* reference designed-but-maybe-unenforced → spec-only.
  if (ref.startsWith('docs/specs/')) return 'spec-only';
  if (ref.startsWith('docs/')) return 'spec-only';
  // A src/** guard file (a gate/marker module) → gate-strength.
  if (ref.startsWith('src/')) return 'gate';
  return 'spec-only';
}

/**
 * Grade a SINGLE guard citation (a path, a `METHOD /route`, or a symbol/marker)
 * against a repo checkout — the library form the class-closure gate's lint invokes
 * (docs/specs/class-closure-gate.md → Piece 1 `guardEvidence`). Returns the
 * enforcement strength AS GRADED by the same deterministic rules the standards
 * coverage audit uses (`classifyFileGuard`), plus whether the citation actually
 * RESOLVES on disk / in the route table / in src.
 *
 * The caller's rule (stated normatively in the spec): a citation that does not
 * resolve to a live enforcing guard — `resolved: false`, or a resolved kind of
 * `spec-only` (a dark/spec-only artifact guards nothing, G3) — downgrades the
 * closure declaration to `gap`. Only `ratchet` / `gate` / `lint` count as a live
 * enforcing guard.
 *
 * Pure over the repo checkout (fs reads only) — NEVER the agent-runtime
 * conformance route (which ships dark and 503s).
 */
export function gradeGuardCitation(
  projectDir: string,
  citation: string,
): { resolved: boolean; kind: EnforcementKind | null; citation: string } {
  const raw = (citation ?? '').trim();
  if (!raw) return { resolved: false, kind: null, citation: raw };

  // Route citation, e.g. "GET /class-closure".
  const routeMatch = /^(GET|POST|PUT|DELETE|PATCH)\s+(\/\S+)$/i.exec(raw);
  if (routeMatch) {
    const token = `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`;
    const resolved = loadRouteTable(projectDir).has(token);
    return { resolved, kind: resolved ? 'gate' : null, citation: raw };
  }

  // File-path citation (contains a slash). Strip a `#symbol` or `:line` suffix
  // before existence-checking the path.
  if (raw.includes('/')) {
    const filePart = raw.split('#')[0].split(':')[0];
    let resolved = false;
    try {
      resolved = fs.existsSync(path.join(projectDir, filePart));
    } catch {
      // @silent-fallback-ok: an unresolvable path is a real dangling-ref finding, not a
      // degraded result — fail-closed to `resolved:false` so the closure declaration
      // downgrades guard->gap (the intended, surfaced outcome). Mirrors line 236 above.
      resolved = false;
    }
    return { resolved, kind: resolved ? classifyFileGuard(filePart) : null, citation: raw };
  }

  // Bare symbol / marker citation.
  const found = buildSymbolIndex(projectDir, new Set([raw]));
  const resolved = found.has(raw);
  return { resolved, kind: resolved ? 'gate' : null, citation: raw };
}

/**
 * Build a regex-scannable route token set from the server route files. Routes are
 * registered across `routes.ts` AND several sibling `*Routes.ts` modules
 * (specReviewRoutes, machineRoutes, usherRoutes, …); scanning only routes.ts would
 * report a route registered elsewhere as a (false) dangling ref. We scan every
 * `*.ts` under `src/server/` for the `router.<verb>('…')` pattern.
 */
function loadRouteTable(projectDir: string): Set<string> {
  const serverDir = path.join(projectDir, 'src', 'server');
  const out = new Set<string>();
  let files: string[];
  try {
    files = fs.readdirSync(serverDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  } catch { return out; }
  const re = /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const f of files) {
    let content: string;
    try { content = fs.readFileSync(path.join(serverDir, f), 'utf-8'); } catch { continue; }
    for (const m of content.matchAll(re)) out.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return out;
}

/**
 * Bounded grep for a symbol across src/** — returns the set of all symbols found so a
 * batch of marker refs is resolved in ONE walk (not one walk per ref). Skips test
 * files and node_modules; caps total bytes read for safety.
 */
function buildSymbolIndex(projectDir: string, wanted: Set<string>): Set<string> {
  const found = new Set<string>();
  if (wanted.size === 0) return found;
  const srcDir = path.join(projectDir, 'src');
  let exists = false;
  try { exists = fs.statSync(srcDir).isDirectory(); } catch { exists = false; }
  if (!exists) return found;

  const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
  let readBytes = 0;
  // Pre-compile a single alternation regex over the wanted symbols (word-bounded).
  const escaped = [...wanted].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`\\b(${escaped.join('|')})\\b`, 'g');

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.size === wanted.size) return; // all resolved — stop early
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) {
        if (readBytes > MAX_TOTAL_BYTES) return;
        let content: string;
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        readBytes += content.length;
        for (const m of content.matchAll(re)) found.add(m[1]);
      }
    }
  };
  walk(srcDir);
  return found;
}

/** Verify each ref of an article against the prepared lookups. */
function verifyRefs(
  refs: EnforcementRef[],
  projectDir: string,
  routeTable: Set<string>,
  symbolIndex: Set<string>,
): VerifiedGuard[] {
  return refs.map((r): VerifiedGuard => {
    let verified = false;
    if (r.kind === 'file') {
      // An fs.existsSync that throws (a malformed path, an EACCES) means the referenced
      // guard is NOT resolvable on disk — which IS the correct, complete answer here
      // (verified=false → the standard reads as having a dangling ref, the loud signal
      // this auditor exists to surface). Not a degradation.
      try { verified = fs.existsSync(path.join(projectDir, r.ref)); }
      catch { verified = false; /* @silent-fallback-ok — unresolvable path = a real dangling-ref finding, not a degraded result */ }
    } else if (r.kind === 'route') {
      verified = routeTable.has(r.ref);
    } else {
      verified = symbolIndex.has(r.ref);
    }
    const g: VerifiedGuard = { ref: r.ref, kind: r.kind, verified };
    if (verified) {
      g.guardKind = r.kind === 'file' ? classifyFileGuard(r.ref) : 'gate'; // route/marker → gate-strength
    }
    return g;
  });
}

/** Classify a standard by its strongest VERIFIED guard. */
function classifyStandard(guards: VerifiedGuard[]): EnforcementKind {
  let best: Exclude<EnforcementKind, 'documented-only'> | null = null;
  for (const g of guards) {
    if (!g.verified || !g.guardKind) continue;
    if (best === null || KIND_RANK[g.guardKind] > KIND_RANK[best]) best = g.guardKind;
  }
  return best ?? 'documented-only';
}

/**
 * A cheap repo-structure signal for the short-circuit: a hash over the sorted mtimes
 * + sizes of the directories whose contents the audit reads (the route table source
 * and the top-level src/scripts/tests/docs/.husky trees' immediate listings). Cheap,
 * deterministic on an unchanged tree, and changes when a referenced guard file is
 * added/removed.
 */
function repoStructureSignal(projectDir: string): string {
  const hash = crypto.createHash('sha256');
  const probe = (rel: string): void => {
    const full = path.join(projectDir, rel);
    try {
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        const names = fs.readdirSync(full).sort();
        hash.update(`${rel}:${names.join(',')}\n`);
      } else {
        hash.update(`${rel}:${st.size}:${Math.floor(st.mtimeMs)}\n`);
      }
    } catch {
      hash.update(`${rel}:absent\n`);
    }
  };
  for (const p of [
    'src', 'src/server', 'scripts', 'tests', 'tests/unit', 'docs', 'docs/specs', '.husky',
    'src/server/routes.ts',
  ]) probe(p);
  return hash.digest('hex').slice(0, 16);
}

/** Compute the input hash that drives the recompute short-circuit. */
export function computeInputHash(opts: AuditorOptions): string {
  // An UNREADABLE registry must not hash identically to an empty-but-present one:
  // that conflation is the honest-denominators shape at the cache layer, where a
  // missing constitution would share a cache slot with a genuinely blank one.
  // `computeCoverage` throws on an unreadable registry (the correct loud failure);
  // this marker only keeps the short-circuit from confusing the two states.
  let registryDigestInput: string;
  try {
    registryDigestInput = fs.readFileSync(opts.registryPath, 'utf-8');
  } catch (err) {
    registryDigestInput = ` unreadable:${opts.registryPath}:${err instanceof Error ? err.message : String(err)}`;
  }
  const regHash = crypto.createHash('sha256').update(registryDigestInput).digest('hex').slice(0, 16);
  return `${regHash}.${repoStructureSignal(opts.projectDir)}`;
}

/**
 * Compute the full enforcement-coverage report. Deterministic: the per-standard order
 * follows the registry parse order; refs within a standard are sorted; the only
 * non-deterministic field is `generatedAt`/`classifiedAt` (a timestamp, excluded from
 * `inputHash`). Pass `prior` to short-circuit when the input hash is unchanged.
 */
export function computeCoverage(
  opts: AuditorOptions,
  prior?: CoverageReport | null,
): CoverageReport {
  const inputHash = computeInputHash(opts);
  if (prior && prior.inputHash === inputHash) {
    // Inputs unchanged → the deterministic report is byte-identical to the prior;
    // return it (only its timestamp would differ on recompute). The short-circuit.
    return prior;
  }

  // Read ONCE and keep what the parse saw: the audit must be able to state the
  // denominator it computed over (honest-denominators instance 4).
  const registryMarkdown = fs.readFileSync(opts.registryPath, 'utf-8');
  const { articles, diagnostics } = parseStandardsRegistryDetailed(registryMarkdown);
  const canary = runRegistryCanary(articles, diagnostics);
  const registry: RegistryProvenance = {
    path: opts.registryPath,
    bytes: Buffer.byteLength(registryMarkdown, 'utf-8'),
    articleHeadings: diagnostics.articleHeadings,
    parsed: diagnostics.parsed,
    droppedHeadings: diagnostics.droppedHeadings,
    families: diagnostics.families,
    canaryOk: canary.ok,
    canaryFailures: canary.failures,
  };
  const routeTable = loadRouteTable(opts.projectDir);

  // Collect every wanted marker across all articles → ONE bounded src walk.
  const extracted = articles.map((a) => ({ a, refs: extractEnforcementRefs(a) }));
  const wantedMarkers = new Set<string>();
  for (const { refs } of extracted) for (const m of refs.markers) wantedMarkers.add(m);
  const symbolIndex = buildSymbolIndex(opts.projectDir, wantedMarkers);

  const classifiedAt = new Date().toISOString();
  const standards: StandardCoverage[] = extracted.map(({ a, refs }) => {
    const flat = flattenRefs(refs);
    const guards = verifyRefs(flat, opts.projectDir, routeTable, symbolIndex);
    const enforcementKind = classifyStandard(guards);
    const danglingRefs = guards.filter((g) => !g.verified).map((g) => g.ref).sort();
    return { standard: a.name, family: a.family, enforcementKind, guards, danglingRefs, classifiedAt };
  });

  const byKind: Record<EnforcementKind, number> = {
    ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0,
  };
  for (const s of standards) byKind[s.enforcementKind] += 1;
  const total = standards.length;
  const enforced = byKind.ratchet + byKind.gate + byKind.lint;
  // No denominator → no ratio. Returning 0 here (the previous behaviour) reads on
  // a dashboard as "0% of our standards are enforced" — a measurement, and an
  // alarming one — when the truth is that nothing was measured at all.
  const enforcedRatio = total === 0 ? null : Number((enforced / total).toFixed(4));
  const gaps = standards.filter((s) => s.enforcementKind === 'documented-only').map((s) => s.standard);
  const danglingCount = standards.reduce((n, s) => n + s.danglingRefs.length, 0);

  return {
    generatedAt: classifiedAt,
    inputHash,
    standards,
    summary: {
      total,
      byKind,
      enforcedRatio,
      gaps,
      danglingCount,
      assessmentTrustworthy: total > 0 && registry.canaryOk,
      registry,
    },
  };
}

/** A stable, timestamp-free view used to assert determinism (two runs → identical). */
export function stableView(report: CoverageReport): unknown {
  return {
    inputHash: report.inputHash,
    standards: report.standards.map((s) => ({
      standard: s.standard,
      family: s.family,
      enforcementKind: s.enforcementKind,
      guards: s.guards.map((g) => ({ ref: g.ref, kind: g.kind, verified: g.verified, guardKind: g.guardKind ?? null })),
      danglingRefs: s.danglingRefs,
    })),
    summary: report.summary,
  };
}
