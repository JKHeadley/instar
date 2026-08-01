#!/usr/bin/env node
/**
 * standards-coverage.mjs — Tier-3 CI ratchet for the Standards Enforcement-Coverage
 * Audit (cartographer-conformance-audit spec #3, Part E). Parity with
 * scripts/docs-coverage.mjs + scripts/cartographer-freshness.mjs: a hardcoded
 * committed FLOOR on the enforced ratio + a hard ZERO ceiling on dangling refs,
 * a gitignored output file that is NEVER the read baseline, deterministic by
 * construction, fails OPEN on a transient (missing registry ⇒ vacuous pass).
 *
 * What it measures: for each constitutional standard in docs/STANDARDS-REGISTRY.md,
 * whether the structural guard its prose NAMES (a `*.test.ts`/`no-*` ratchet, a
 * `scripts/lint-*`, a gate marker/route, a `docs/specs/*`) actually resolves on
 * disk. It reports:
 *   - enforcedRatio = (ratchet + gate + lint) / total — fails the build if it drops
 *     below the committed floor (a new standard shipped with NO verifiable guard).
 *   - danglingCount = refs a standard names that are NOT on disk — fails the build if
 *     ABOVE ZERO (a guard file removed while a standard still cites it: a broken
 *     guarantee, the loudest signal).
 *   - falseClaimCount = standards that name NO guard while their own prose asserts
 *     running machinery ("a scheduled audit walks the list daily") — a false
 *     all-clear in the constitution, read by humans as protection that exists.
 *
 * Self-contained (no dist import) so it runs in CI without a build step — it
 * re-implements the same deterministic parse → extract → verify the auditor does.
 *
 * Usage:
 *   node scripts/standards-coverage.mjs           # report, exit 0
 *   node scripts/standards-coverage.mjs --check    # exit 1 on regression
 *   node scripts/standards-coverage.mjs --json     # JSON to stdout
 *
 * Floors (env override):
 *   STANDARDS_ENFORCED_RATIO_FLOOR  — min enforced ratio 0..1 (default 0.70,
 *                                     ratcheted up as gaps close)
 *   STANDARDS_DANGLING_CEILING      — max dangling refs (default 0 — zero tolerance)
 *   STANDARDS_FALSE_CLAIM_CEILING   — max standards asserting an unnamed guard
 *                                     (default 1 — the measured 2026-07-31 count;
 *                                     ratchet to 0 once Cross-Store Coherence is
 *                                     resolved)
 *   STANDARDS_UNRECOGNIZED_SECTION_CEILING — max unclassified article headings
 *                                     (default 0 — every heading declares a role)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { articleIds, parseRegistryStructure } from './standards-registry-article-core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const JSON_ONLY = args.has('--json');
const QUIET = args.has('--quiet');

function resolveRoot() {
  if (process.env.STANDARDS_COVERAGE_ROOT) return process.env.STANDARDS_COVERAGE_ROOT;
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'src'))) return cwd;
  return path.resolve(__dirname, '..');
}
const ROOT = resolveRoot();
const REGISTRY_PATH = path.join(ROOT, 'docs', 'STANDARDS-REGISTRY.md');
const OUT_PATH = path.join(ROOT, '.instar', 'standards-coverage.json');

// ── Hardcoded committed floors (the read baseline; output file is never it) ──
const numEnv = (env, def) => {
  const v = process.env[env];
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : def;
};
const FLOORS = {
  // Started at 0 ("starts loose", the docs-coverage rationale) while the gap closed.
  // Ratcheted to 0.70 on 2026-07-31 after the self-contained parser was brought
  // into parity with StandardsRegistryParser: 82 standards, 58 with a named
  // ratchet/gate/lint ref, ratio 0.7073. The old parser silently ignored alternate
  // enforcement headings and one whole structurally-detected family, reporting a
  // different denominator from the API. 0.70 keeps headroom for rounding while a
  // single new unguarded standard (58/83 = 0.6988) trips the ratchet.
  enforcedRatio: numEnv('STANDARDS_ENFORCED_RATIO_FLOOR', 0.70),
  // Zero tolerance: a standard must NEVER cite a guard that doesn't exist.
  danglingCeiling: numEnv('STANDARDS_DANGLING_CEILING', 0),
  // A gap that ASSERTS running machinery is a false all-clear, not an honest gap.
  // Set to the measured count on 2026-07-31 (1 — Cross-Store Coherence) rather than
  // 0, following the enforced-ratio precedent of "starts loose": a new check must
  // not fail a build for a pre-existing condition it just became able to see. It
  // already does the load-bearing job at 1 — a NEW standard that claims machinery
  // without naming it fails immediately. RATCHET TO 0 once Cross-Store Coherence
  // either gets its audit built or has the claim amended out of its prose.
  falseClaimCeiling: numEnv('STANDARDS_FALSE_CLAIM_CEILING', 1),
  // Zero tolerance: a new bold article section must be explicitly classified as
  // core, enforcement, provenance, or explanatory narrative.
  unrecognizedSectionCeiling: numEnv('STANDARDS_UNRECOGNIZED_SECTION_CEILING', 0),
};

// ── Deterministic parse → extract → verify (mirrors the auditor, self-contained) ──

const FIELD_HEADING_RE = /^\*\*(.+?)\.\*\*\s*(.*)$/;
const ENFORCEMENT_SECTION_HEADINGS = [
  'Applied through',
  'Enforced by (structure, not willpower)',
  'Enforcement',
  'Full spec',
  'Full specs',
];
const EXCLUDED_PROVENANCE_SECTION_HEADINGS = [
  'Derives from',
  'Earned from',
  'Ratified by',
  'Source documents',
  'Traces to the goal',
];
const EXCLUDED_NARRATIVE_SECTION_HEADINGS = [
  'Applied at the shipping layer',
  'Balanced by — Responsible Resource',
  'Benchmarks earn a real job',
  'Composition with No Silent Degradation',
  'Constrain the model\'s output with structure, never by matching its prose',
  'Distinct from Cross-Machine Coherence',
  'Distinct from Deferral = Deletion',
  'Distinct from the OnboardingGate',
  'Neither is whole alone',
  'Notice and fight the reflex (the load-bearing awareness)',
  'Per-feature posture (2026-06-12 widening)',
  'Restart-survival corollary',
  'The Eternal Sentinel exemption (ratified with the standard)',
  'The moving threshold (mastery)',
  'The near-total ban',
  'Three obligations, in increasing blast radius',
  'Three postures, in increasing order of ambition',
];
const CORE_SECTION_HEADINGS = ['Article ID', 'Rule', 'In practice'];
const ENFORCEMENT_SECTION_HEADING_SET = new Set(ENFORCEMENT_SECTION_HEADINGS);
const EXCLUDED_PROVENANCE_SECTION_HEADING_SET = new Set(EXCLUDED_PROVENANCE_SECTION_HEADINGS);
const EXCLUDED_NARRATIVE_SECTION_HEADING_SET = new Set(EXCLUDED_NARRATIVE_SECTION_HEADINGS);
const CORE_SECTION_HEADING_SET = new Set(CORE_SECTION_HEADINGS);
const familyName = (heading) => heading.split(/\s+[—–-]\s+/)[0].trim();

function parseRegistry(markdown) {
  const sections = parseRegistryStructure(markdown).map((rawSection) => ({
    heading: rawSection.heading,
    blocks: rawSection.blocks.map((block) => {
      const ids = articleIds(block);
      const article = {
        family: familyName(rawSection.heading), name: block.name,
        ...(ids.length === 1 ? { articleId: ids[0] } : {}),
        rule: '', inPractice: '', appliedThrough: '', enforcementSections: [],
      };
      const observedSections = [];
      let field = null;
      const flushField = () => {
        if (!field) return;
        const heading = field.heading;
        const text = field.lines.join('\n').trim();
        observedSections.push(heading);
        if (heading === 'Rule') article.rule = text;
        else if (heading === 'In practice') article.inPractice = text;
        else if (ENFORCEMENT_SECTION_HEADING_SET.has(heading)) {
          article.enforcementSections.push({ heading, text });
          if (heading === 'Applied through') article.appliedThrough = text;
        }
        field = null;
      };
      for (const line of block.visibleLines) {
        if (line === null) continue;
        const fieldMatch = line.match(FIELD_HEADING_RE);
        if (fieldMatch) {
          flushField();
          field = { heading: fieldMatch[1].trim(), lines: [fieldMatch[2]] };
        } else if (field) field.lines.push(line);
      }
      flushField();
      return { name: block.name, article, observedSections };
    }),
  }));

  const articles = [];
  const enforcementScope = {
    recognizedHeadings: [...ENFORCEMENT_SECTION_HEADINGS],
    excludedProvenanceHeadings: [...EXCLUDED_PROVENANCE_SECTION_HEADINGS],
    excludedNarrativeHeadings: [...EXCLUDED_NARRATIVE_SECTION_HEADINGS],
    capturedSections: 0,
    unrecognizedSections: [],
  };
  for (const candidate of sections) {
    if (!candidate.blocks.some((block) => block.article.rule)) continue;
    for (const block of candidate.blocks) {
      if (!block.article.rule) continue;
      articles.push(block.article);
      enforcementScope.capturedSections += block.article.enforcementSections.length;
      for (const heading of block.observedSections) {
        if (
          CORE_SECTION_HEADING_SET.has(heading) ||
          ENFORCEMENT_SECTION_HEADING_SET.has(heading) ||
          EXCLUDED_PROVENANCE_SECTION_HEADING_SET.has(heading) ||
          EXCLUDED_NARRATIVE_SECTION_HEADING_SET.has(heading)
        ) continue;
        enforcementScope.unrecognizedSections.push(
          `${familyName(candidate.heading)} › ${block.name} › ${heading}`,
        );
      }
    }
  }
  return { articles, enforcementScope };
}

const FILE_RE = /`([a-zA-Z0-9_./-]+\.(?:ts|js|mjs|cjs|md|json|sh))`/g;
const ROUTE_RE = /`(GET|POST|PUT|DELETE|PATCH)\s+(\/[a-zA-Z0-9/_:-]+)`/g;
const MARKER_RE = /\b([A-Z][A-Z0-9]{2,}_[A-Z0-9_]{2,})\b/g;
const SYMBOL_RE = /`([A-Z][a-zA-Z0-9]+(?:\.[a-zA-Z][a-zA-Z0-9]*)?)`/g;
const ENFORCEMENT_PATH_PREFIXES = ['tests/', 'scripts/', 'src/', 'docs/', '.github/', '.instar/', '.husky/'];
const isEnforcementPath = (p) => ENFORCEMENT_PATH_PREFIXES.some((pre) => p.startsWith(pre));
const dedupe = (xs) => [...new Set(xs)];

function extractRefs(a) {
  const text = [
    a.inPractice ?? '',
    a.appliedThrough ?? '',
    ...(a.enforcementSections ?? []).map((section) => section.text),
  ].join('\n');
  const files = [];
  for (const m of text.matchAll(FILE_RE)) { if (isEnforcementPath(m[1])) files.push(m[1]); }
  const routes = [];
  for (const m of text.matchAll(ROUTE_RE)) routes.push(`${m[1].toUpperCase()} ${m[2]}`);
  const markers = [];
  for (const m of text.matchAll(MARKER_RE)) markers.push(m[1]);
  for (const m of text.matchAll(SYMBOL_RE)) markers.push(m[1].split('.')[0]);
  return { files: dedupe(files).sort(), routes: dedupe(routes).sort(), markers: dedupe(markers).sort() };
}

/**
 * ── FALSE-CLAIM DETECTION ────────────────────────────────────────────────────
 * A standard that says "this is how we behave" and names no guard is an HONEST
 * gap. A standard that says "a scheduled audit walks the list daily" is making a
 * claim of FACT — and if it names no resolvable guard, that claim is a false
 * all-clear sitting in the constitution, read by humans as protection that exists.
 *
 * Earned 2026-07-31: of the 24 documented-only standards, exactly three asserted
 * running machinery. Two were true and merely unnamed (now cited). The third —
 * Cross-Store Coherence — claims "A scheduled coherence audit walks the list on
 * every machine daily". No such audit exists; of its three enumerated invariants
 * one has a per-message delivery-time fail-safe and two have no checker at all.
 * It is the standard earned from two identity stores contradicting each other for
 * 19 days with no tripwire — the reactive shield shipped, the tripwire did not.
 *
 * PRECISION OVER RECALL, deliberately, and it is structural rather than a matter
 * of tuning: this runs ONLY over standards already classified `documented-only`.
 * A standard that asserts machinery AND names a resolvable guard is never
 * examined, so the only way to be flagged is to claim a mechanism and cite
 * nothing. Patterns are assertions of a specific mechanism running, never
 * prescriptions ("must refuse", "should block"), which is what the negative
 * lookbehind excludes.
 */
const CLAIM_PATTERNS = [
  /\ba scheduled\s+[a-z-]*\s*(?:audit|job|check|sweep|pass)\b/i,
  /\bwalks the list\b/i,
  /\b(?:checked|runs|fires|re-?runs)\s+on a cadence\b/i,
  /\bfails the build\b/i,
  /\benforcement is\b/i,
  /\bis enforced by\b/i,
  /\bon every machine\s+daily\b/i,
  /\bdaily\b[^.]{0,40}\baudit\b/i,
];
// Prescriptive framing near a match means the standard is stating a requirement,
// not asserting an existing mechanism. "must be checked on a cadence" is a rule;
// "a scheduled audit walks the list" is a claim.
const PRESCRIPTIVE_NEAR = /\b(?:must|should|shall|needs? to|ought to|is required to)\b[^.]{0,60}$/i;

function detectEnforcementClaims(a) {
  const text = [
    a.rule ?? '',
    a.inPractice ?? '',
    a.appliedThrough ?? '',
    ...(a.enforcementSections ?? []).map((section) => section.text),
  ].join('\n');
  const hits = [];
  for (const re of CLAIM_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const before = text.slice(Math.max(0, m.index - 60), m.index);
    if (PRESCRIPTIVE_NEAR.test(before)) continue;
    hits.push(m[0].trim());
  }
  return dedupe(hits).sort();
}

const KIND_RANK = { ratchet: 4, gate: 3, lint: 2, 'spec-only': 1 };
function classifyFileGuard(ref) {
  const base = ref.split('/').pop() ?? ref;
  if (/\.test\.(ts|js|mjs)$/.test(base) || base.startsWith('no-') || /-coverage\.(mjs|js)$/.test(base)) return 'ratchet';
  if (ref.startsWith('scripts/') && base.startsWith('lint-')) return 'lint';
  if (ref.startsWith('.husky/') || /precommit/i.test(base)) return 'gate';
  if (ref.startsWith('scripts/')) return 'lint';
  if (ref.startsWith('docs/')) return 'spec-only';
  if (ref.startsWith('src/')) return 'gate';
  return 'spec-only';
}

function loadRouteTable() {
  const out = new Set();
  const serverDir = path.join(ROOT, 'src', 'server');
  let files;
  try { files = fs.readdirSync(serverDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')); } catch { return out; }
  const re = /router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(path.join(serverDir, f), 'utf-8'); } catch { continue; }
    for (const m of content.matchAll(re)) out.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return out;
}

function buildSymbolIndex(wanted) {
  const found = new Set();
  if (wanted.size === 0) return found;
  const srcDir = path.join(ROOT, 'src');
  try { if (!fs.statSync(srcDir).isDirectory()) return found; } catch { return found; }
  const escaped = [...wanted].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`\\b(${escaped.join('|')})\\b`, 'g');
  let readBytes = 0;
  const MAX = 64 * 1024 * 1024;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found.size === wanted.size) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        walk(full);
      } else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) {
        if (readBytes > MAX) return;
        let content;
        try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
        readBytes += content.length;
        for (const m of content.matchAll(re)) found.add(m[1]);
      }
    }
  };
  walk(srcDir);
  return found;
}

function compute() {
  let markdown = null;
  try { markdown = fs.readFileSync(REGISTRY_PATH, 'utf-8'); } catch { markdown = null; }
  if (markdown === null) {
    // Missing registry (a transient / a partial checkout) → vacuous pass (fail-open).
    return {
      generatedAt: new Date().toISOString(),
      registryFound: false,
      total: 0, byKind: { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 },
      enforcedRatio: 1, gaps: [], falseClaimCount: 0, falseClaims: [],
      danglingCount: 0, danglingByStandard: [],
      enforcementScope: {
        recognizedHeadings: [...ENFORCEMENT_SECTION_HEADINGS],
        excludedProvenanceHeadings: [...EXCLUDED_PROVENANCE_SECTION_HEADINGS],
        excludedNarrativeHeadings: [...EXCLUDED_NARRATIVE_SECTION_HEADINGS],
        capturedSections: 0,
        unrecognizedSections: [],
      },
    };
  }

  const { articles, enforcementScope } = parseRegistry(markdown);
  const routeTable = loadRouteTable();
  const extracted = articles.map((a) => ({ a, refs: extractRefs(a) }));
  const wanted = new Set();
  for (const { refs } of extracted) for (const m of refs.markers) wanted.add(m);
  const symbolIndex = buildSymbolIndex(wanted);

  const byKind = { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 };
  const gaps = [];
  const falseClaims = [];
  const danglingByStandard = [];
  let danglingCount = 0;

  for (const { a, refs } of extracted) {
    const guards = [];
    const dangling = [];
    for (const ref of refs.files) {
      const verified = fs.existsSync(path.join(ROOT, ref));
      if (verified) guards.push(classifyFileGuard(ref)); else dangling.push(ref);
    }
    for (const ref of refs.routes) {
      const verified = routeTable.has(ref);
      if (verified) guards.push('gate'); else dangling.push(ref);
    }
    for (const ref of refs.markers) {
      const verified = symbolIndex.has(ref);
      if (verified) guards.push('gate'); else dangling.push(ref);
    }
    let best = null;
    for (const g of guards) { if (best === null || KIND_RANK[g] > KIND_RANK[best]) best = g; }
    const kind = best ?? 'documented-only';
    byKind[kind] += 1;
    if (kind === 'documented-only') {
      gaps.push(a.name);
      // A gap that ASSERTS running machinery is a false claim, not an honest gap.
      const claims = detectEnforcementClaims(a);
      if (claims.length > 0) falseClaims.push({ standard: a.name, claims });
    }
    if (dangling.length > 0) { danglingByStandard.push({ standard: a.name, refs: dangling.sort() }); danglingCount += dangling.length; }
  }

  const total = articles.length;
  const enforced = byKind.ratchet + byKind.gate + byKind.lint;
  const enforcedRatio = total === 0 ? 1 : Number((enforced / total).toFixed(4));
  return {
    generatedAt: new Date().toISOString(),
    registryFound: true,
    total, byKind, enforcedRatio, gaps, enforcementScope,
    falseClaimCount: falseClaims.length, falseClaims,
    danglingCount, danglingByStandard,
  };
}

function main() {
  const report = compute();
  report.floors = FLOORS;
  report.inputHash = (() => {
    let reg = '';
    try { reg = fs.readFileSync(REGISTRY_PATH, 'utf-8'); } catch { reg = ''; }
    return crypto.createHash('sha256').update(reg).digest('hex').slice(0, 16);
  })();

  try {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n');
  } catch { /* output is advisory; never fail the build on a write error */ }

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (!QUIET) {
    console.error(`[standards-coverage] registry=${report.registryFound} total=${report.total} ` +
      `enforced-ratio=${report.enforcedRatio} (ratchet ${report.byKind.ratchet} / gate ${report.byKind.gate} / ` +
      `lint ${report.byKind.lint} / spec-only ${report.byKind['spec-only']} / gap ${report.byKind['documented-only']}) ` +
      `false-claims=${report.falseClaimCount} ` +
      `dangling=${report.danglingCount} ` +
      `unrecognized-sections=${report.enforcementScope.unrecognizedSections.length}`);
    console.error(`[standards-coverage] floors: enforced-ratio>=${FLOORS.enforcedRatio} dangling<=${FLOORS.danglingCeiling} false-claims<=${FLOORS.falseClaimCeiling} unrecognized-sections<=${FLOORS.unrecognizedSectionCeiling}`);
    for (const fc of report.falseClaims) {
      console.error(`[standards-coverage] FALSE CLAIM — "${fc.standard}" asserts running machinery (${fc.claims.map((c) => `"${c}"`).join(', ')}) but names no resolvable guard.`);
    }
  }

  if (CHECK) {
    const failures = [];
    if (report.enforcedRatio < FLOORS.enforcedRatio) {
      failures.push(`enforced ratio ${report.enforcedRatio} < floor ${FLOORS.enforcedRatio}`);
    }
    if (report.danglingCount > FLOORS.danglingCeiling) {
      failures.push(`dangling refs ${report.danglingCount} > ceiling ${FLOORS.danglingCeiling}` +
        (report.danglingByStandard.length
          ? ` — ${report.danglingByStandard.map((d) => `${d.standard}: [${d.refs.join(', ')}]`).join('; ')}`
          : ''));
    }
    if (report.falseClaimCount > FLOORS.falseClaimCeiling) {
      failures.push(`false claims ${report.falseClaimCount} > ceiling ${FLOORS.falseClaimCeiling}` +
        ` — ${report.falseClaims.map((f) => `${f.standard}: asserts [${f.claims.join(', ')}] but names no resolvable guard`).join('; ')}`);
    }
    if (report.enforcementScope.unrecognizedSections.length > FLOORS.unrecognizedSectionCeiling) {
      failures.push(
        `unrecognized article sections ${report.enforcementScope.unrecognizedSections.length} > ceiling ${FLOORS.unrecognizedSectionCeiling}` +
        ` — ${report.enforcementScope.unrecognizedSections.join('; ')}`,
      );
    }
    if (failures.length > 0) {
      process.stderr.write('\n❌ standards-coverage check failed:\n');
      for (const f of failures) process.stderr.write(`  - ${f}\n`);
      process.stderr.write('\nFix: build a guard for an unguarded standard (raise the ratio), repair a dangling reference, classify each unknown article heading, or resolve a false claim whose prose asserts unnamed machinery.\n');
      process.exit(1);
    }
    if (!QUIET) console.error('✅ standards-coverage check passed.');
  }
}

main();
