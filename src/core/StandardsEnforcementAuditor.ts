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
import { fileURLToPath } from 'node:url';
import {
  ENFORCEMENT_SECTION_HEADINGS,
  EXCLUDED_NARRATIVE_SECTION_HEADINGS,
  EXCLUDED_PROVENANCE_SECTION_HEADINGS,
  parseStandardsRegistryDetailed,
  runRegistryCanary,
  type RegistryEnforcementParseScope,
} from './StandardsRegistryParser.js';
import { extractEnforcementRefs, flattenRefs, type EnforcementRef } from './StandardEnforcementExtractor.js';
import { earnsVerified, readAuthoredConstitution, type RegistryIntegrity } from './standardsRegistryPath.js';

export type EnforcementKind = 'ratchet' | 'gate' | 'lint' | 'spec-only' | 'documented-only';

export interface VerifiedGuard {
  /** The reference token (path / `METHOD /route` / symbol). */
  ref: string;
  /** Recognizer kind from extraction. */
  kind: 'file' | 'route' | 'marker';
  /** Did the reference resolve on disk / in the route table / in src? */
  /**
   * The named ref RESOLVES — a file with that path exists, a route with that method
   * and path is declared in source, or that symbol appears in `src/`.
   *
   * DELIBERATELY NOT `verified`. That name asserted the guard works; this establishes
   * only that something with the right NAME is present. The constitution this auditor
   * grades says so itself, in as many words: *Verify the State, Not Its Symbol* —
   * "never accept a symbol … a string, label, marker, **filename** … as proof the
   * state holds". A `*.test.ts` that is `.skip`ped, assertion-free, or excluded from
   * the CI shards resolves exactly like one that runs. Measured in this tree:
   * **5 files carry an unconditional `.skip(`, 20 use `.skipIf(`, 29 carry either.** (An earlier
   * version of this comment said "40 test files", and before that "44" — neither figure was ever
   * measured. Using an invented number as evidence for a claim about honesty is the defect this
   * file exists to remove, so the measure and its command live here rather than a recollection:
   * `grep -rlE '\.(skip|skipIf)\(' tests/ | wc -l`.) See `enforcementBasis` on the summary, and §12 of the spec.
   */
  refResolves: boolean;
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
  /**
   * sha256 of the registry bytes this pass graded.
   *
   * The spec names this the FLEET KEY — "group by `registry.sha256` before comparing
   * totals", and the discriminator for monitoring the rollout and rollback of this very
   * change. Review found it existed in no response: not on this type, and
   * `unusableCoverageReport` even RECEIVED an observed sha and dropped it. The only sha
   * anywhere in the payload was a 12-char prefix inside a prose sentence. So the one
   * operational instruction the spec gave could not be followed.
   */
  sha256: string | null;
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
  /** What article sections the enforcement parser admitted, excluded, or could not classify. */
  enforcementScope: RegistryEnforcementParseScope;
}

export interface CoverageSummary {
  total: number;
  byKind: Record<EnforcementKind, number>;
  /** Per-family measurement parity with the source-checkout CI ratchet. */
  areas: Record<string, {
    total: number;
    enforced: number;
    byKind: Record<EnforcementKind, number>;
    refResolutionRatio: number;
    gaps: string[];
  }>;
  /**
   * (ratchet + gate + lint) / total — the fraction of standards that CITE a guard whose name resolves
   * (see `enforcementBasis` — resolution is not execution). **`null` when `total` is 0**: with nothing to divide by
   * there is no ratio, and reporting one (either the flattering 1 or the
   * damning 0) states a measurement that was never taken. Callers must render
   * null as "not assessed", never coerce it to a number.
   */
  enforcedRatio: number | null;
  /**
   * The SAME number under a name that states what it measures: the share of standards
   * whose named enforcement reference RESOLVES on disk.
   *
   * `enforcedRatio` is retained for existing readers and is DEPRECATED. Its name claims
   * more than the measurement supports — a `ratchet` classification means a
   * ratchet-shaped filename resolves, NOT that a ratchet ran — and the answer to that
   * was a caveat readers had to remember to go and read. A limitation that depends on
   * being remembered is not enforced (Structure beats Willpower; No Manual Work), so it
   * moves into the field name. New readers use this field.
   */
  refResolutionRatio: number | null;
  /** Names of `documented-only` standards (the gaps). */
  gaps: string[];
  /** Total dangling refs across all standards. */
  danglingCount: number;
  /**
   * How much this assessment has actually EARNED, in three states rather than a
   * boolean that overclaims.
   *
   *   'untrustworthy' — a check actively failed (nothing parsed, or the canary
   *                     objected). Every figure here describes a fragment or a
   *                     drifted parse.
   *   'unverified'    — the internal checks passed, but NOTHING established the
   *                     registry's provenance, so this pass cannot tell whether it
   *                     read the CURRENT constitution or a coherent old copy of it.
   *                     The figures are arithmetic over whatever was on disk.
   *   'verified'      — internal checks passed AND the bytes matched the integrity
   *                     meta generated beside them in the same build, so the data
   *                     shipped with the code reading it. This establishes CURRENCY,
   *                     not correctness-against-source and not tamper-resistance —
   *                     `confidenceReason` says so in as many words, because a
   *                     one-word verdict cannot carry its own limits.
   *
   * WHY THE TRI-STATE EXISTS (found 2026-07-25, two hours after shipping the
   * boolean): the live agent-home registry carries 22 articles where the source
   * carries 81 — and it passes every internal check, because it is a perfectly
   * self-consistent document that merely happens to be a quarter of the real one.
   * 22 headings, 22 parsed, nothing dropped, anchors present, above the floor. So
   * `assessmentTrustworthy: true` was asserting trust over exactly the defect the
   * field was added to expose.
   *
   * The lesson, which the spec review had already given me and I applied only to
   * the spec: nothing INSIDE a 22-rule document says it should have 81.
   * Trustworthiness is not obtainable by looking harder at the file; it requires
   * something from outside it. "My internal checks passed" and "this assessment is
   * trustworthy" are different claims, and conflating them is the failure this
   * whole instrument was fixed to stop.
   *
   * WHAT SUPPLIES THE OUTSIDE FACT (and what it is worth). The registry now ships
   * as a build artifact beside an integrity meta generated in the same pass, and
   * the resolver matches one against the other. The 22-article case is closed by
   * CONSTRUCTION rather than by detection: there is no longer an install-time
   * snapshot that can age, so the reader and its data are always the same version.
   * Note the shape of that — the defect was fixed by removing the drift, and the
   * verdict merely reports which basis held. Beware reading 'verified' as more than
   * that: it does NOT re-derive the constitution from source at runtime, and it is
   * not adversarial (whoever can edit the asset can edit the meta beside it).
   */
  assessmentConfidence: 'verified' | 'unverified' | 'untrustworthy';
  /** Plain-English reason for the confidence verdict — always populated. */
  confidenceReason: string;
  /**
   * @deprecated A bare boolean cannot carry what 'verified' does and does not
   * establish, which is the whole point of the tri-state. Retained for one release
   * so no consumer breaks; TRUE only when `assessmentConfidence === 'verified'`.
   * Prefer `assessmentConfidence` + `confidenceReason` — the reason states the
   * basis and its limits, and a consumer that reads only the boolean will overclaim.
   */
  assessmentTrustworthy: boolean;
  /**
   * WHAT `enforcedRatio` AND THE `byKind` COUNTS ARE ACTUALLY MEASURING.
   *
   * Always `'named-ref-existence'`. Every classification in this report is derived
   * from whether a NAME the registry's prose cites resolves to something on disk —
   * not from whether that thing runs, asserts, or is wired into CI. A standard citing
   * a `*.test.ts` that exists is graded `ratchet`, the top rank, whether or not the
   * test is skipped.
   *
   * The field exists because the alternative was to keep a number whose label
   * ("the fraction of standards that CITE a guard whose name resolves — see `enforcementBasis`; resolution is not execution") describes a
   * stronger measurement than the one performed. Naming the basis is the same repair
   * this change made one layer up, where the resolver stopped performing a check it
   * could not do and reported its basis instead.
   */
  enforcementBasis: 'named-ref-existence';
  /** One line a reader can quote — the meaning travels with the field. */
  enforcementBasisMeans: string;
  /** Provenance of the registry this pass read. */
  registry: RegistryProvenance;
  /**
   * Provenance of the GUARD side of the audit — the tree every enforcement ref is
   * resolved against.
   *
   * Split out because the registry and the guards now come from DIFFERENT places:
   * the registry from the packed asset, the guards from `projectDir`. Three
   * independent reviewers raised the same consequence: on an install whose
   * projectDir is not an instar checkout, `loadRouteTable` and `buildSymbolIndex`
   * return empty SILENTLY, every ref fails `existsSync`, every standard classifies
   * `documented-only` — and the registry still resolved fine, so the verdict read
   * `verified`. Absence of the repo was indistinguishable from absence of guards,
   * and this change made it MORE confident (the same reading was `unverified`
   * before). That is the honest-denominators defect this auditor exists to prevent,
   * moved one field over.
   */
  guards: GuardTreeProvenance;
}

export interface CoverageReport {
  generatedAt: string;
  /** Hash of the inputs (registry content + repo-structure signal) — drives the short-circuit. */
  inputHash: string;
  /**
   * Digest of the on-disk state (size + mtime, or `absent`) of every FILE ref THIS pass
   * resolved. Compared against a freshly-computed value on the next call, so a guard
   * that has since changed or vanished busts the cache even though `inputHash` cannot
   * see it.
   */
  guardSignal: string;
  standards: StandardCoverage[];
  summary: CoverageSummary;
}

/**
 * Where the guard half of the audit was resolved, and whether that tree can answer.
 *
 * `analyzable: false` means the enforcement refs were checked against a tree with no
 * instar source in it, so EVERY ref necessarily dangles for a reason that has nothing
 * to do with enforcement. Precedent for the shape is already in-tree: `/release-readiness`
 * returns null on any install with no analyzable instar git repo rather than reporting
 * a confident zero.
 */
export interface GuardTreeProvenance {
  /** The directory refs were resolved against, or the packed-index sentinel. */
  projectDir: string;
  /** The configured directory, retained when a packed index supersedes a stale local tree. */
  configuredProjectDir: string;
  /** Whether that directory actually contains an analyzable instar source tree. */
  analyzable: boolean;
  /** The markers probed, so a reader can see WHY it was judged (un)analyzable. */
  markersFound: string[];
  /** The independently checkable basis used to select this guard evidence. */
  basis:
    | 'executing-source-tree'
    | 'source-tree-index-match'
    | 'packed-source-index-match'
    | 'configured-tree-unverified'
    | 'not-probed';
  /** True only when the tree/index is tied to the code and constitution being read. */
  freshnessVerified: boolean;
  /** Plain-English explanation of what established (or failed to establish) freshness. */
  freshnessReason: string;
  /** sha256 of the packed source index, when that is the basis. */
  sourceIndexSha256: string | null;
  /** Registry sha the packed index was generated against. */
  registrySha256: string | null;
  /** Package version the packed index was generated for. */
  packageVersion: string | null;
}

export interface GuardTreeIndex {
  schemaVersion: 1;
  generatedFrom: 'source-tree';
  registrySha256: string;
  packageVersion: string;
  guards: VerifiedGuard[];
}

interface GuardTreeIndexMeta {
  sha256: string;
  registrySha256: string;
  packageVersion: string;
}

interface GuardEvidenceResolution {
  provenance: GuardTreeProvenance;
  indexedGuards: Map<string, VerifiedGuard> | null;
  packedIndex?: GuardTreeIndex;
}

export interface AuditorOptions {
  /** Path to docs/STANDARDS-REGISTRY.md. */
  registryPath: string;
  /** Repo root — all refs resolve relative to this. */
  projectDir: string;
  /**
   * The registry bytes the resolver ALREADY read, decoded. Supply them: the audit
   * otherwise re-opens `registryPath` twice more per call (once to hash for the
   * short-circuit, once to parse), and each re-read is a TOCTOU seam against the
   * integrity check that produced `integrity`. Omitted only by callers that have
   * no resolution in hand; then the file is read here.
   *
   * KNOWN SHAPE HAZARD, guarded by ratchet rather than by type. `registryPath`,
   * `registryMarkdown` and `integrity` are three loose fields, and the auditor is
   * deliberately ratcheted against cross-checking them — so a future edit pairing
   * `integrity` from one resolution with bytes from somewhere else would reach
   * `verified` over unchecked content, and nothing here would notice. Today the only
   * producer passes all three from ONE resolution; `assertResolutionCoherent` below
   * makes that a runtime precondition rather than a callsite convention, and the
   * route ratchet makes it a build-time one. (A single `resolution:` field would be
   * stronger still and is the right eventual shape; it is a wider refactor than this
   * change should carry, and is recorded rather than silently skipped.)
   */
  registryMarkdown?: string;
  /**
   * How the resolver established that these bytes are the ones this build ships.
   *
   * This REPLACES the former `expectation` field, which was a comparison that
   * could not fail (ACT-1426): the caller derived the expectation from the same
   * resolution whose sha the auditor then re-computed, so the two were the same
   * number by construction and `verified` was granted by ceremony. There is no
   * independent runtime expectation available to substitute — so the audit now
   * reports the basis the resolver ACTUALLY established, by name, instead of
   * performing a check it cannot really do.
   */
  integrity?: RegistryIntegrity;
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
/**
 * Blank out comments while preserving length and line structure.
 *
 * Block comments become equivalent-length whitespace (newlines kept) and line comments
 * are truncated, so offsets and line numbers stay usable for any caller that wants them.
 * Deliberately NOT a parser: a string literal containing `//` is over-stripped. That
 * direction is the safe one here — it can only make a guard fail to resolve (a visible
 * dangling ref), never manufacture one.
 */
export function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

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
        // Strip comments before matching. Without this, a symbol named ONLY in a
        // comment — `// TODO: build FooGate` — counts as a live gate-strength guard, so
        // a standard is graded `gate` on the strength of someone's note about work not
        // done. This change ships `scripts/lint-no-direct-standards-registry-path.mjs`
        // two hundred lines away and the spec praises it for exactly this: "strips
        // comments (preserving line numbers) so it fires on code, not prose." Applying
        // the technique in one place and not the other is how the same defect survives
        // in the file that introduced the fix for it.
        for (const m of stripComments(content).matchAll(re)) found.add(m[1]);
      }
    }
  };
  walk(srcDir);
  return found;
}

/** Verify each ref of an article against the prepared lookups. */
/**
 * Resolve a registry-supplied ref UNDER `projectDir`, or null if it escapes.
 *
 * The refs this auditor probes come from the CONSTITUTION DOCUMENT — each standard's
 * "Applied through" text. That text is authored, but it is DATA, and after this change the
 * document also ships as a packed asset and is mirrored into agent homes. A ref of
 * `../../../etc/passwd` would otherwise make `path.join(projectDir, ref)` probe outside the
 * project entirely.
 *
 * Two harms, and the second matters more:
 *   1. the probe touches a path outside the tree it is auditing;
 *   2. **an escaping ref that happens to EXIST grades the standard as ENFORCED** — the audit
 *      would report a guard resolving against a file unrelated to this repository. A
 *      containment failure becomes a correctness failure in the published numbers.
 *
 * Compared on the RESOLVED, normalized path with a trailing separator, so `/repo-evil` cannot
 * pass as a child of `/repo`. Null on any resolution error — callers treat that exactly like a
 * non-resolving ref, which is the conservative direction.
 */
export function containedRefPath(projectDir: string, ref: string): string | null {
  try {
    const root = path.resolve(projectDir);
    const full = path.resolve(root, ref);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (full !== root && !full.startsWith(rootWithSep)) return null;
    return full;
  } catch { return null; /* @silent-fallback-ok — unresolvable = not contained = treated as absent */ }
}

function verifyRefs(
  refs: EnforcementRef[],
  projectDir: string,
  routeTable: Set<string>,
  symbolIndex: Set<string>,
): VerifiedGuard[] {
  return refs.map((r): VerifiedGuard => {
    let refResolves = false;
    if (r.kind === 'file') {
      // An fs.existsSync that throws (a malformed path, an EACCES) means the referenced
      // guard is NOT resolvable on disk — which IS the correct, complete answer here
      // (verified=false → the standard reads as having a dangling ref, the loud signal
      // this auditor exists to surface). Not a degradation.
      // Containment FIRST: a ref escaping projectDir is not a resolvable guard for THIS
      // repo, however real the file it points at may be.
      const contained = containedRefPath(projectDir, r.ref);
      if (contained === null) { refResolves = false; }
      else {
        try { refResolves = fs.existsSync(contained); }
        catch { refResolves = false; /* @silent-fallback-ok — unresolvable path = a real dangling-ref finding, not a degraded result */ }
      }
    } else if (r.kind === 'route') {
      refResolves = routeTable.has(r.ref);
    } else {
      refResolves = symbolIndex.has(r.ref);
    }
    const g: VerifiedGuard = { ref: r.ref, kind: r.kind, refResolves };
    if (refResolves) {
      g.guardKind = r.kind === 'file' ? classifyFileGuard(r.ref) : 'gate'; // route/marker → gate-strength
    }
    return g;
  });
}

function guardKey(guard: Pick<VerifiedGuard, 'kind' | 'ref'>): string {
  return `${guard.kind}\u0000${guard.ref}`;
}

/**
 * Build the deterministic evidence index shipped beside the packed constitution.
 *
 * This runs in the real source checkout during `npm run build`, where the source tree
 * is unambiguous. Runtime installs need not guess which old checkout happens to sit in
 * `projectDir`; they verify and consume this same-build index instead.
 */
export function buildGuardTreeIndex(
  projectDir: string,
  registryMarkdown: string,
  packageVersion: string,
): GuardTreeIndex {
  const { articles } = parseStandardsRegistryDetailed(registryMarkdown);
  const extracted = articles.map((article) => extractEnforcementRefs(article));
  const refsByKey = new Map<string, EnforcementRef>();
  const wantedMarkers = new Set<string>();
  for (const refs of extracted) {
    for (const ref of flattenRefs(refs)) {
      refsByKey.set(`${ref.kind}\u0000${ref.ref}`, ref);
      if (ref.kind === 'marker') wantedMarkers.add(ref.ref);
    }
  }
  const routeTable = loadRouteTable(projectDir);
  const symbolIndex = buildSymbolIndex(projectDir, wantedMarkers);
  const guards = verifyRefs(
    [...refsByKey.values()].sort((a, b) => guardKey(a).localeCompare(guardKey(b))),
    projectDir,
    routeTable,
    symbolIndex,
  );
  return {
    schemaVersion: 1,
    generatedFrom: 'source-tree',
    registrySha256: crypto.createHash('sha256').update(registryMarkdown).digest('hex'),
    packageVersion,
    guards,
  };
}

function executingPackageRoot(): string | null {
  try {
    return fileURLToPath(new URL('../../', import.meta.url));
  } catch {
    // @silent-fallback-ok: this is one candidate identity only. The packed-index
    // resolver below remains authoritative for published installs and returns a
    // surfaced, untrustworthy provenance when it cannot verify its own artifacts.
    return null;
  }
}

function sameDirectory(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    // @silent-fallback-ok: inability to prove path identity is a negative result,
    // never permission to label a configured tree as current.
    return false;
  }
}

function sameGuardIndex(left: GuardTreeIndex, right: GuardTreeIndex): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Select a real checkout only when its audit-relevant evidence exactly matches the
 * same-build packed index. Landmark presence alone is deliberately insufficient.
 */
export function findMatchingGuardTree(
  candidates: string[],
  expected: GuardTreeIndex,
  registryMarkdown: string,
  packageVersion: string,
): string | null {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    let canonical: string;
    try {
      canonical = fs.realpathSync(candidate);
    } catch {
      // @silent-fallback-ok: a missing candidate is not a degraded audit result; it
      // simply cannot prove identity and the next bounded candidate is evaluated.
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    if (!probeGuardTree(canonical).analyzable) continue;
    let observed: GuardTreeIndex;
    try {
      observed = buildGuardTreeIndex(canonical, registryMarkdown, packageVersion);
    } catch {
      // @silent-fallback-ok: one optional candidate that cannot be fully indexed
      // has not established identity. Continue to the next bounded candidate; the
      // packed fallback retains analysis and exposes its own basis.
      continue;
    }
    if (sameGuardIndex(observed, expected)) return canonical;
  }
  return null;
}

function guardTreeCandidates(configuredProjectDir: string): string[] {
  const candidates = [
    configuredProjectDir,
    path.join(configuredProjectDir, 'repo'),
    process.cwd(),
  ];
  const packageRoot = executingPackageRoot();
  if (packageRoot) candidates.push(packageRoot);

  // Agent deployments keep a bounded fleet at `<agents>/<name>` and development
  // agents keep their checkout at `<agent>/repo`. Search only that one known level:
  // no home-directory crawl, no arbitrary project discovery.
  const agentsDir = path.dirname(configuredProjectDir);
  if (path.basename(agentsDir) === 'agents') {
    try {
      for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true }).slice(0, 100)) {
        if (entry.isDirectory()) candidates.push(path.join(agentsDir, entry.name, 'repo'));
      }
    } catch {
      // @silent-fallback-ok: fleet-layout discovery is an optional bounded candidate
      // source. Package-local evidence below retains the capability and reports its basis.
    }
  }
  return candidates;
}

function readPackedGuardIndex(
  registrySha256: string,
  runningPackageVersion: string | null,
  configuredProjectDir: string,
): GuardEvidenceResolution | null {
  let indexPath: string;
  let metaPath: string;
  try {
    indexPath = fileURLToPath(new URL('../data/standards-guard-index.json', import.meta.url));
    metaPath = fileURLToPath(new URL('../data/standards-guard-index.meta.json', import.meta.url));
  } catch {
    // @silent-fallback-ok: malformed module URL means this candidate is unavailable;
    // the caller returns configured-tree-unverified with the failed freshness claim
    // visible in the report.
    return null;
  }

  let bytes: Buffer;
  let parsed: unknown;
  let meta: unknown;
  try {
    bytes = fs.readFileSync(indexPath);
    parsed = JSON.parse(bytes.toString('utf-8'));
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch {
    // @silent-fallback-ok: a missing/unreadable index is not substituted or trusted.
    // The caller exposes the absence as an unverified guard-tree basis.
    return null;
  }
  const index = parsed as Partial<GuardTreeIndex>;
  const stamp = meta as Partial<GuardTreeIndexMeta>;
  const observedSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const structurallyValid =
    index.schemaVersion === 1
    && index.generatedFrom === 'source-tree'
    && typeof index.registrySha256 === 'string'
    && typeof index.packageVersion === 'string'
    && Array.isArray(index.guards)
    && index.guards.every((guard) =>
      guard !== null
      && typeof guard === 'object'
      && typeof (guard as VerifiedGuard).ref === 'string'
      && ['file', 'route', 'marker'].includes((guard as VerifiedGuard).kind)
      && typeof (guard as VerifiedGuard).refResolves === 'boolean');
  const stampMatches =
    stamp.sha256 === observedSha256
    && stamp.registrySha256 === registrySha256
    && stamp.packageVersion === runningPackageVersion
    && index.registrySha256 === registrySha256
    && index.packageVersion === runningPackageVersion;
  if (!structurallyValid || !stampMatches) return null;

  const indexedGuards = new Map<string, VerifiedGuard>();
  for (const guard of index.guards as VerifiedGuard[]) {
    indexedGuards.set(guardKey(guard), { ...guard });
  }
  return {
    provenance: {
      projectDir: '(packed same-build source index)',
      configuredProjectDir,
      analyzable: true,
      markersFound: ['packed guard evidence'],
      basis: 'packed-source-index-match',
      freshnessVerified: true,
      freshnessReason:
        `the source evidence index sha256 ${observedSha256} matches its build meta, registry ` +
        `sha256 ${registrySha256}, and running package version ${runningPackageVersion}`,
      sourceIndexSha256: observedSha256,
      registrySha256,
      packageVersion: runningPackageVersion,
    },
    indexedGuards,
    packedIndex: index as GuardTreeIndex,
  };
}

function resolveGuardEvidence(
  opts: AuditorOptions,
  registryMarkdown: string,
): GuardEvidenceResolution {
  const registrySha256 = crypto.createHash('sha256').update(registryMarkdown).digest('hex');
  const configuredProbe = probeGuardTree(opts.projectDir);

  if (opts.integrity?.basis === 'packed-meta-match') {
    const packed = readPackedGuardIndex(
      registrySha256,
      opts.integrity.runningPackageVersion,
      opts.projectDir,
    );
    if (packed && packed.packedIndex && opts.integrity.runningPackageVersion) {
      const matched = findMatchingGuardTree(
        guardTreeCandidates(opts.projectDir),
        packed.packedIndex,
        registryMarkdown,
        opts.integrity.runningPackageVersion,
      );
      if (matched) {
        const probe = probeGuardTree(matched);
        const packageRoot = executingPackageRoot();
        const executing = packageRoot !== null && sameDirectory(packageRoot, matched);
        return {
          provenance: {
            ...probe,
            configuredProjectDir: opts.projectDir,
            basis: executing ? 'executing-source-tree' : 'source-tree-index-match',
            freshnessVerified: true,
            freshnessReason:
              `the live tree's complete audit-evidence index exactly matches packed source index ` +
              `${packed.provenance.sourceIndexSha256}; landmark-only candidates were rejected`,
            sourceIndexSha256: packed.provenance.sourceIndexSha256,
            registrySha256,
            packageVersion: opts.integrity.runningPackageVersion,
          },
          indexedGuards: null,
        };
      }
    }
    if (packed) return packed;
  }

  return {
    provenance: {
      ...configuredProbe,
      configuredProjectDir: opts.projectDir,
      basis: 'configured-tree-unverified',
      freshnessVerified: false,
      freshnessReason:
        configuredProbe.analyzable
          ? 'the configured tree has the audit landmarks, but no same-build identity ties it to the packed constitution; a coherent stale tree passes landmark probes by construction'
          : 'the configured tree lacks the complete source landmarks and no valid same-build source index was available',
      sourceIndexSha256: null,
      registrySha256,
      packageVersion:
        opts.integrity?.basis === 'packed-meta-match'
          ? opts.integrity.runningPackageVersion
          : null,
    },
    indexedGuards: null,
  };
}

function verifyRefsFromResolution(
  refs: EnforcementRef[],
  resolution: GuardEvidenceResolution,
  projectDir: string,
  routeTable: Set<string>,
  symbolIndex: Set<string>,
): VerifiedGuard[] {
  if (resolution.indexedGuards === null) {
    return verifyRefs(refs, projectDir, routeTable, symbolIndex);
  }
  return refs.map((ref) => {
    const indexed = resolution.indexedGuards!.get(`${ref.kind}\u0000${ref.ref}`);
    return indexed ? { ...indexed } : { ref: ref.ref, kind: ref.kind, refResolves: false };
  });
}

/** Classify a standard by its strongest VERIFIED guard. */
function classifyStandard(guards: VerifiedGuard[]): EnforcementKind {
  let best: Exclude<EnforcementKind, 'documented-only'> | null = null;
  for (const g of guards) {
    if (!g.refResolves || !g.guardKind) continue;
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
/**
 * A digest over the on-disk state of every FILE ref the previous pass resolved.
 *
 * Size + mtime rather than content: the question is "did a guard I counted change or
 * vanish", and a stat answers it for a few dozen paths without re-reading them. A ref
 * that has disappeared contributes a distinct `absent` marker, so deletion moves the
 * key — which is the case that matters most and the one the directory-listing probe
 * could not see.
 */
function guardStateSignal(projectDir: string, prior?: CoverageReport | null): string {
  if (!prior) return 'no-prior';
  const refs = new Set<string>();
  for (const st of prior.standards) {
    for (const g of st.guards) if (g.kind === 'file') refs.add(g.ref);
  }
  if (refs.size === 0) return 'no-file-refs';
  const h = crypto.createHash('sha256');
  for (const ref of [...refs].sort()) {
    const containedRef = containedRefPath(projectDir, ref);
    if (containedRef === null) { h.update(`${ref}:absent\n`); continue; }
    try {
      const st = fs.statSync(containedRef);
      h.update(`${ref}:${st.size}:${st.mtimeMs}\n`);
    } catch {
      h.update(`${ref}:absent\n`);
    }
  }
  return h.digest('hex').slice(0, 16);
}

function computeInputHashForResolution(
  opts: AuditorOptions,
  guardResolution?: GuardEvidenceResolution,
): string {
  // An UNREADABLE registry must not hash identically to an empty-but-present one:
  // that conflation is the honest-denominators shape at the cache layer, where a
  // missing constitution would share a cache slot with a genuinely blank one.
  // `computeCoverage` throws on an unreadable registry (the correct loud failure);
  // this marker only keeps the short-circuit from confusing the two states.
  let registryDigestInput: string;
  try {
    // Prefer the bytes the resolver already read — same content, one fewer read,
    // and no window in which the file can change between the integrity check and
    // the hash that keys the short-circuit.
    registryDigestInput = opts.registryMarkdown ?? fs.readFileSync(opts.registryPath, 'utf-8');
  } catch (err) {
    registryDigestInput = `\u0000unreadable:${opts.registryPath}:${err instanceof Error ? err.message : String(err)}`;
  }
  const regHash = crypto.createHash('sha256').update(registryDigestInput).digest('hex').slice(0, 16);
  // The key MUST cover every input that decides the report, not just the bytes.
  //
  // `integrity` and `registryPath` both determine `assessmentConfidence`,
  // `confidenceReason` and `registry.path`, and neither was in the key. Review
  // DEMONSTRATED the consequence rather than arguing it: with identical bytes, a
  // caller-supplied fixture served after a production call returned
  // `assessmentConfidence: verified`, and a production call served after a fixture
  // returned `unverified` with the fixture's path. That falsified this spec's own
  // normative sentence — "a fixture still cannot reach verified, because its basis
  // says so" — which was true of the verdict and false of the cache in front of it.
  const basisSignal = opts.integrity
    ? opts.integrity.basis === 'packed-meta-match'
      ? [
          'packed',
          opts.integrity.metaSha256,
          String(opts.integrity.metaArticleCount),
          String(opts.integrity.observedArticleCount),
          String(opts.integrity.metaPackageVersion),
          String(opts.integrity.runningPackageVersion),
        ].join(':')
      : 'caller-supplied-path'
    : 'none';
  const auxHash = crypto
    .createHash('sha256')
    .update(`${opts.registryPath}\u0000${opts.projectDir}\u0000${basisSignal}`)
    .digest('hex')
    .slice(0, 16);
  //
  // `repoStructureSignal` probes only the IMMEDIATE listings of a fixed set of
  // directories, so deleting `src/core/MessagingToneGate.ts` — or any cited guard under
  // a second-level directory, which is most of them — leaves the key identical. The
  // cached report then keeps reporting that guard `refResolves: true` and
  // `danglingCount: 0` for the process lifetime: the loudest signal this auditor exists
  // to raise, suppressed by its own cache. Two reviewers raised it independently, and
  // the second noted the change had made it strictly worse — the stale report now
  // presents as `verified`.
  //
  // The refs are not known until a pass runs, so the previous pass supplies them. That
  // is sufficient for the failure that matters: a guard this audit ALREADY counted
  // disappearing underneath the cache. A guard that never existed still reads as
  // dangling, correctly, on the first pass.
  // The AUTHORED constitution, hashed explicitly.
  //
  // `compareAgainstAuthoredSource` is a report-determining input, and nothing in the key
  // covered it: `repoStructureSignal` probes directory LISTINGS, so editing the authored
  // document moves nothing. It was represented only by accident — `guardStateSignal`
  // stats `docs/STANDARDS-REGISTRY.md` because one article's prose happens to cite it as
  // a guard ref. Delete that sentence in a routine edit and the route would serve cached
  // `verified` over a stale asset indefinitely: the same cache-vs-verdict defect review
  // demonstrated for `integrity` a round earlier, resting on a coincidence.
  const authored = readAuthoredConstitution(opts.projectDir);
  const authoredSignal = authored === null
    ? 'no-authored-source'
    : crypto.createHash('sha256').update(authored).digest('hex').slice(0, 16);
  const guardBasisSignal = guardResolution
    ? `${guardResolution.provenance.basis}:${guardResolution.provenance.sourceIndexSha256 ?? 'live'}:` +
      `${guardResolution.provenance.projectDir}`
    : 'guard-basis-not-resolved';
  return `${regHash}.${auxHash}.${authoredSignal}.${repoStructureSignal(opts.projectDir)}.` +
    crypto.createHash('sha256').update(guardBasisSignal).digest('hex').slice(0, 16);
}

export function computeInputHash(opts: AuditorOptions): string {
  return computeInputHashForResolution(opts);
}

/**
 * Derive how much the assessment has EARNED. Extracted as a function on purpose:
 * inline, TypeScript's flow analysis used to prove `'verified'` unreachable and reject
 * the comparison deriving the deprecated boolean — back when no basis could ever be
 * supplied. It is reachable now (a packed asset resolves with a `packed-meta-match`
 * basis), and the extraction is kept because the verdict is worth reading in one
 * place, in the order a reader asks it.
 *
 * Order matters and mirrors how a reader asks it: did anything FAIL, and if not, did we
 * have anything to CHECK AGAINST?
 */
export function deriveAssessmentConfidence(
  total: number,
  registry: RegistryProvenance,
  /**
   * The basis the RESOLVER established, passed through verbatim. `'packed-meta-match'`
   * is the only basis that earns `'verified'`.
   *
   * Deliberately NOT a comparison performed here. The previous signature took an
   * expectation and an observed sha and compared them — but both were derived from
   * the same file moments apart, past a guard that had already equated them, so the
   * branch was unreachable in practice and `'verified'` came from ceremony rather
   * than evidence (ACT-1426). Reporting a basis by name is weaker-sounding and more
   * honest: it says exactly what was checked and by whom.
   */
  integrity?: RegistryIntegrity,
  /**
   * The guard tree the refs were resolved against. An unanalyzable tree makes the
   * enforcement figures meaningless regardless of how sound the registry is — the
   * two halves of this audit now come from different places and both must answer.
   */
  guards?: GuardTreeProvenance,
  /**
   * Whether the graded bytes match the AUTHORED constitution — answerable only in an
   * instar source tree, where `docs/STANDARDS-REGISTRY.md` is the original rather than a
   * mirror of the asset. `answerable: false` is not a failure; it is the normal state of
   * a published install, where the version stamp carries the claim instead.
   */
  authoredSource?: { answerable: boolean; matches: boolean },
): { confidence: CoverageSummary['assessmentConfidence']; reason: string } {
  if (total === 0) {
    return {
      confidence: 'untrustworthy',
      reason: 'no standards parsed from the registry — nothing was measured',
    };
  }
  if (!registry.canaryOk) {
    return {
      confidence: 'untrustworthy',
      reason: `the registry-parse canary objected: ${registry.canaryFailures.join('; ')}`,
    };
  }
  if (guards && !guards.analyzable) {
    return {
      confidence: 'untrustworthy',
      reason:
        `the enforcement refs were resolved against ${guards.projectDir}, which is not an analyzable ` +
        `instar source tree (found ${guards.markersFound.length ? guards.markersFound.join(', ') : 'none'} ` +
        `of src/server/routes.ts, src/core). Every ref necessarily dangles for a ` +
        `reason unrelated to enforcement, so the counts describe a missing repository rather than missing ` +
        `guards — the registry itself may be perfectly sound`,
    };
  }
  // The verdict delegates to ONE predicate that lives beside the integrity type
  // (`earnsVerified`). It is not re-derived here: the auditor is ratcheted against
  // performing comparisons of its own, and a rule with no named home drifts back
  // into consumers as ad-hoc conditionals. Every downgrade names its own operand.
  if (authoredSource?.answerable && !authoredSource.matches) {
    return {
      confidence: 'unverified',
      reason:
        `the packed constitution does NOT match the authored docs/STANDARDS-REGISTRY.md in this ` +
        `source tree — the asset is stale relative to what is written right now (edit the ` +
        `constitution, skip the generator, and every other operand still agrees: the sha pair, the ` +
        `version stamp and the article count are all internally consistent with the OLD bytes). ` +
        `Run \`npm run build\` to regenerate`,
    };
  }
  const verdict = earnsVerified(integrity);
  if (!verdict.verified) {
    return {
      confidence: 'unverified',
      reason:
        `internal checks passed over ${total} standards parsed from ${registry.path} ` +
        `(${registry.bytes} bytes), but ${verdict.reason} — so nothing establishes this is the CURRENT ` +
        `constitution rather than a coherent older copy; a stale registry passes every internal check ` +
        `by construction`,
    };
  }
  if (guards && !guards.freshnessVerified) {
    return {
      confidence: 'untrustworthy',
      reason:
        `the constitution is package-stamped, but guard-tree freshness was not established: ` +
        `${guards.freshnessReason}. The coverage counts remain observable for diagnosis, but a stale ` +
        `tree passes capability landmarks by construction and cannot support a trustworthy ratio`,
    };
  }
  return {
    confidence: 'verified',
    reason:
      `${total} standards parsed from ${registry.path}, and ${verdict.reason}. ` +
      `The guard evidence is also current: ${guards?.freshnessReason ?? 'the caller supplied no guard provenance'}. ` +
      `This is package/build currency, not a runtime execution check and not tamper-resistant`,
  };
}

/**
 * Compute the full enforcement-coverage report. Deterministic: the per-standard order
 * follows the registry parse order; refs within a standard are sorted; the only
 * non-deterministic field is `generatedAt`/`classifiedAt` (a timestamp, excluded from
 * `inputHash`). Pass `prior` to short-circuit when the input hash is unchanged.
 */
/**
 * Probe whether `projectDir` holds an analyzable instar source tree.
 *
 * Deliberately checks for the two files the audit itself reads (`src/server/routes.ts`
 * feeds the route table, `src/` feeds the symbol index) plus the package identity —
 * i.e. it verifies the STATE the audit depends on, not a symbol standing in for it.
 * A directory missing all three cannot produce a meaningful enforcement denominator.
 */
export function probeGuardTree(projectDir: string): GuardTreeProvenance {
  const markersFound: string[] = [];
  const check = (rel: string): void => {
    try { if (fs.existsSync(path.join(projectDir, rel))) markersFound.push(rel); } catch { /* unreadable = absent */ }
  };
  // Probe ONLY what this audit actually consumes: `src/server/routes.ts` feeds the route
  // table, `src/` feeds the symbol index. Both, not either — a partial tree yields a
  // partial denominator, which is the same lie in a smaller size.
  //
  // A `package.json#name === 'instar'` marker was required in the first version and it
  // was WRONG, in a way that only measurement caught: an agent home carries a full `src/`
  // copy and NO `package.json`, so the probe returned false there permanently — making
  // `untrustworthy` the eternal verdict on the one deployment where this surface is live,
  // and `verified` reachable only inside a unit-test run in the instar checkout. A guard
  // written to stop a false `verified` had instead made the honest one unreachable.
  //
  // The lesson is the probe's own subject: verify the STATE the audit depends on (can
  // these refs resolve here?), not an identity that merely correlates with it.
  check('src/server/routes.ts');
  check('src/core');
  // Membership by NAME, not a count. `markersFound.length === 2` silently turns
  // `analyzable` permanently false the moment anyone adds a third `check()` — which is
  // exactly the failure this probe was just repaired from, encoded so it can recur.
  const analyzable = markersFound.includes('src/server/routes.ts') && markersFound.includes('src/core');
  return {
    projectDir,
    configuredProjectDir: projectDir,
    analyzable,
    markersFound,
    basis: 'configured-tree-unverified',
    freshnessVerified: false,
    freshnessReason: 'landmark presence proves analyzability, not source-tree identity or freshness',
    sourceIndexSha256: null,
    registrySha256: null,
    packageVersion: null,
  };
}

/**
 * Refuse a basis that does not belong to these bytes.
 *
 * This is the INVERSE of the tautology ACT-1426 removed. That defect was a comparison
 * that could not fail; this guards the opposite failure — a basis paired with content
 * it never described. It is NOT the auditor deciding `verified` (the ratchet forbids
 * that, and rightly): it is a precondition on its inputs, refusing incoherent
 * arguments the way any function refuses a malformed one.
 *
 * It compares the sha the RESOLVER recorded in the basis against these bytes. If a
 * caller assembles a resolution from mismatched parts, the audit fails loudly here
 * rather than reporting `verified` over content nothing checked.
 */
function assertResolutionCoherent(opts: AuditorOptions, markdown: string): void {
  const integrity = opts.integrity;
  if (!integrity || integrity.basis !== 'packed-meta-match') return;
  // Hash the BYTES, not the decoded string. The resolver hashes a Buffer; re-hashing
  // `Buffer.toString('utf-8')` round-trips any non-UTF-8 byte through U+FFFD, so a
  // corrupt asset would produce a spurious mismatch here and — because this throws — a
  // 500 instead of the honest untrustworthy report this module's contract promises.
  const actual = crypto.createHash('sha256').update(Buffer.from(markdown, 'utf-8')).digest('hex');
  if (actual !== integrity.metaSha256) {
    throw new Error(
      'incoherent auditor options: the integrity basis records sha ' +
        `${integrity.metaSha256.slice(0, 12)} but the supplied registry bytes hash to ` +
        `${actual.slice(0, 12)}. A basis may only accompany the bytes it was established over — ` +
        'pass a single resolution through, never fields assembled from different sources.',
    );
  }
}

/**
 * Compare the graded bytes against the AUTHORED constitution, where that question is
 * answerable and non-circular.
 *
 * This is the operand review said the other three cannot supply. The version stamp
 * only disagrees when a version bump lands without a rebuild — but the scenario its own
 * comment names (`tsc` watch recompiles the reader without re-running the generator)
 * does not touch `package.json`, so the stamp is TRUE by construction exactly there.
 * And in a published tarball `prepublishOnly` regenerates from the same `package.json`
 * the resolver later reads, so it is true by construction there too. The stamp is real
 * but narrow, and claiming more of it was the third version of the same overclaim.
 *
 * The authored source is the one input the build that wrote the asset did not write.
 *
 * NON-CIRCULARITY, which is the whole reason this is gated: in an instar SOURCE tree
 * `docs/STANDARDS-REGISTRY.md` is the original. In an agent home it is a MIRROR of the
 * asset, so comparing them there would compare the asset to a copy of itself and always
 * agree — a fourth tautology. `holdsAuthoredConstitution` is the same probe the
 * mirror uses to decide where it must refuse, for the same reason.
 */
export function compareAgainstAuthoredSource(
  projectDir: string,
  gradedMarkdown: string,
): { answerable: boolean; matches: boolean } {
  const authored = readAuthoredConstitution(projectDir);
  if (authored === null) return { answerable: false, matches: false };
  return { answerable: true, matches: authored === gradedMarkdown };
}

export function computeCoverage(
  opts: AuditorOptions,
  prior?: CoverageReport | null,
): CoverageReport {
  // Read once before source resolution: the guard index is tied to these exact
  // registry bytes, and candidate checkouts are selected by reproducing that index.
  const registryMarkdown = opts.registryMarkdown ?? fs.readFileSync(opts.registryPath, 'utf-8');
  assertResolutionCoherent(opts, registryMarkdown);
  const guardResolution = resolveGuardEvidence(opts, registryMarkdown);
  const inputHash = computeInputHashForResolution(opts, guardResolution);
  const currentGuardSignal = guardResolution.provenance.sourceIndexSha256 !== null
    ? `source-index:${guardResolution.provenance.sourceIndexSha256}`
    : guardStateSignal(guardResolution.provenance.projectDir, prior);
  // TWO conditions, not one.
  //
  // `inputHash` covers the registry bytes, the basis, the paths and a coarse repo
  // signal — but `repoStructureSignal` probes only IMMEDIATE directory listings, so
  // deleting a cited guard under any second-level directory (most of them) left the key
  // identical. The cached report then kept reporting that guard `refResolves: true` and
  // `danglingCount: 0` for the process lifetime: the loudest signal this auditor exists
  // to raise, suppressed by its own cache. Two reviewers raised it independently, and
  // the second noted this change had made it worse — the stale report now reads
  // `verified`.
  //
  // It is a SEPARATE comparison rather than a term in the key on purpose. Folding a
  // prior-derived value into the key makes the first computation (no prior) and the
  // second (with prior) disagree by construction, so the short-circuit would never fire
  // — which is how the first attempt at this failed, caught by an existing test.
  if (prior && prior.inputHash === inputHash && prior.guardSignal === currentGuardSignal) {
    // Inputs unchanged → the deterministic report is byte-identical to the prior;
    // return it (only its timestamp would differ on recompute). The short-circuit.
    return prior;
  }

  // Read ONCE and keep what the parse saw: the audit must be able to state the
  // denominator it computed over (honest-denominators instance 4).
  const { articles, diagnostics } = parseStandardsRegistryDetailed(registryMarkdown);
  const canary = runRegistryCanary(articles, diagnostics);
  const registry: RegistryProvenance = {
    path: opts.registryPath,
    sha256: crypto.createHash('sha256').update(registryMarkdown).digest('hex'),
    bytes: Buffer.byteLength(registryMarkdown, 'utf-8'),
    articleHeadings: diagnostics.articleHeadings,
    parsed: diagnostics.parsed,
    droppedHeadings: diagnostics.droppedHeadings,
    families: diagnostics.families,
    canaryOk: canary.ok,
    canaryFailures: canary.failures,
    enforcementScope: diagnostics.enforcementScope,
  };
  const guards = guardResolution.provenance;
  const liveProjectDir = guards.projectDir;
  const routeTable = guardResolution.indexedGuards === null
    ? loadRouteTable(liveProjectDir)
    : new Set<string>();

  // Collect every wanted marker across all articles → ONE bounded src walk.
  const extracted = articles.map((a) => ({ a, refs: extractEnforcementRefs(a) }));
  const wantedMarkers = new Set<string>();
  for (const { refs } of extracted) for (const m of refs.markers) wantedMarkers.add(m);
  const symbolIndex = guardResolution.indexedGuards === null
    ? buildSymbolIndex(liveProjectDir, wantedMarkers)
    : new Set<string>();

  const classifiedAt = new Date().toISOString();
  const standards: StandardCoverage[] = extracted.map(({ a, refs }) => {
    const flat = flattenRefs(refs);
    const guards = verifyRefsFromResolution(
      flat,
      guardResolution,
      liveProjectDir,
      routeTable,
      symbolIndex,
    );
    const enforcementKind = classifyStandard(guards);
    const danglingRefs = guards.filter((g) => !g.refResolves).map((g) => g.ref).sort();
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
  const areaTallies = new Map<string, {
    total: number;
    enforced: number;
    byKind: Record<EnforcementKind, number>;
    refResolutionRatio: number;
    gaps: string[];
  }>();
  for (const standard of standards) {
    if (!areaTallies.has(standard.family)) {
      areaTallies.set(standard.family, {
        total: 0,
        enforced: 0,
        byKind: { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 },
        refResolutionRatio: 0,
        gaps: [],
      });
    }
    const area = areaTallies.get(standard.family)!;
    area.total += 1;
    area.byKind[standard.enforcementKind] += 1;
    if (standard.enforcementKind === 'ratchet' || standard.enforcementKind === 'gate' || standard.enforcementKind === 'lint') {
      area.enforced += 1;
    }
    if (standard.enforcementKind === 'documented-only') area.gaps.push(standard.standard);
  }
  for (const area of areaTallies.values()) {
    area.refResolutionRatio = Number((area.enforced / area.total).toFixed(4));
  }
  const areas = Object.fromEntries([...areaTallies.entries()].sort(([a], [b]) => a.localeCompare(b)));

  const { confidence: assessmentConfidence, reason: confidenceReason } =
    deriveAssessmentConfidence(
      total,
      registry,
      opts.integrity,
      guards,
      guards.basis === 'executing-source-tree' || guards.basis === 'source-tree-index-match'
        ? compareAgainstAuthoredSource(liveProjectDir, registryMarkdown)
        : { answerable: false, matches: false },
    );

  const report: CoverageReport = {
    generatedAt: classifiedAt,
    inputHash,
    guardSignal: '',
    standards,
    summary: {
      total,
      byKind,
      areas,
      enforcedRatio,
      refResolutionRatio: enforcedRatio,
      gaps,
      danglingCount,
      assessmentConfidence,
      confidenceReason,
      // Deprecated boolean: only a 'verified' verdict may present as trustworthy.
      assessmentTrustworthy: assessmentConfidence === 'verified',
      enforcementBasis: 'named-ref-existence' as const,
      enforcementBasisMeans:
        'a classification means a ref of that shape RESOLVES (file exists / route declared / symbol ' +
        'present in src), NOT that the guard runs, asserts, or is in CI',
      registry,
      guards,
    },
  };
  // Computed AFTER the standards exist, because it digests the refs this pass resolved.
  report.guardSignal = guardResolution.provenance.sourceIndexSha256 !== null
    ? `source-index:${guardResolution.provenance.sourceIndexSha256}`
    : guardStateSignal(liveProjectDir, report);
  return report;
}

/**
 * Build an HONEST report for an install where the packed registry could not be
 * used at all — absent, or not matching the integrity meta generated beside it.
 *
 * This exists so the readers never have to choose between crashing and guessing.
 * `total` is 0 and `enforcedRatio` is `null` (no denominator → no ratio, never a
 * flattering 1 or a damning 0), `assessmentConfidence` is `'untrustworthy'`, and
 * the resolver's own reason travels with it. No candidate is substituted, because
 * there is none: an install running this code with its data missing is broken,
 * not old.
 */
export function unusableCoverageReport(
  resolution: { reason: string; detail: string; observed?: { path?: string; sha256?: string; articleCount?: number } },
): CoverageReport {
  const registry: RegistryProvenance = {
    path: resolution.observed?.path ?? '(unresolved)',
    // Carry the observed sha through instead of dropping it — on an
    // integrity-mismatch this is the single most useful field for identifying WHICH
    // bad artifact an agent is holding, and it was being discarded.
    sha256: resolution.observed?.sha256 ?? null,
    bytes: 0,
    articleHeadings: resolution.observed?.articleCount ?? 0,
    parsed: 0,
    droppedHeadings: [],
    families: [],
    canaryOk: false,
    canaryFailures: [`${resolution.reason}: ${resolution.detail}`],
    enforcementScope: {
      recognizedHeadings: [...ENFORCEMENT_SECTION_HEADINGS],
      excludedProvenanceHeadings: [...EXCLUDED_PROVENANCE_SECTION_HEADINGS],
      excludedNarrativeHeadings: [...EXCLUDED_NARRATIVE_SECTION_HEADINGS],
      capturedSections: 0,
      unrecognizedSections: [],
    },
  };
  return {
    generatedAt: new Date().toISOString(),
    inputHash: `unusable:${resolution.reason}`,
    // No pass ran, so no refs were resolved and there is nothing to watch.
    guardSignal: 'unusable',
    standards: [],
    summary: {
      total: 0,
      byKind: { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 },
      areas: {},
      enforcedRatio: null,
      refResolutionRatio: null,
      gaps: [],
      danglingCount: 0,
      assessmentConfidence: 'untrustworthy',
      confidenceReason: `${resolution.reason}: ${resolution.detail}`,
      assessmentTrustworthy: false,
      enforcementBasis: 'named-ref-existence' as const,
      enforcementBasisMeans:
        'a classification means a ref of that shape RESOLVES (file exists / route declared / symbol ' +
        'present in src), NOT that the guard runs, asserts, or is in CI',
      registry,
      // No pass ran, so the guard tree was never probed. Reporting `analyzable:
      // false` here would assert a fact about the repo that this path never checked.
      guards: {
        projectDir: '(not probed — the registry was unusable)',
        configuredProjectDir: '(unknown)',
        analyzable: false,
        markersFound: [],
        basis: 'not-probed',
        freshnessVerified: false,
        freshnessReason: 'the registry was unusable, so no guard source was selected',
        sourceIndexSha256: null,
        registrySha256: registry.sha256,
        packageVersion: null,
      },
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
      guards: s.guards.map((g) => ({ ref: g.ref, kind: g.kind, refResolves: g.refResolves, guardKind: g.guardKind ?? null })),
      danglingRefs: s.danglingRefs,
    })),
    summary: report.summary,
  };
}
