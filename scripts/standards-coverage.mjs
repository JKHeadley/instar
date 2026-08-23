#!/usr/bin/env node
/**
 * standards-coverage.mjs — Tier-3 CI ratchet for the Standards Enforcement-Coverage
 * Audit (cartographer-conformance-audit spec #3, Part E). Parity with
 * scripts/docs-coverage.mjs + scripts/cartographer-freshness.mjs: a hardcoded
 * committed FLOOR on the enforced ratio + a hard ZERO ceiling on dangling refs,
 * a gitignored output file that is NEVER the read baseline, deterministic by
 * construction, and fails closed on a missing/empty/rootless full-checkout registry.
 * Deliberately partial consumers must opt out with `--allow-partial-registry`.
 *
 * What it measures: for each constitutional standard in docs/STANDARDS-REGISTRY.md,
 * whether the structural guard its prose NAMES (a `*.test.ts`/`no-*` ratchet, a
 * `scripts/lint-*`, a gate marker/route, a `docs/specs/*`) actually resolves on
 * disk. It reports:
 *   - enforcedRatio = (ratchet + gate + lint) / total — fails the build if it drops
 *     below the committed floor (a new standard shipped with NO verifiable guard).
 *   - areas = the same measurement grouped by the registry's first-class `family`
 *     field — each family has an independent committed floor and a content-bound
 *     last-audited fact, so a large family cannot hide another family regressing.
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
 *   node scripts/standards-coverage.mjs --record-area-audit=all --audit-ref=docs/audits/review.json
 *   node scripts/standards-coverage.mjs --record-area-audit="The Root" --audit-ref=docs/audits/review.json
 *   node scripts/standards-coverage.mjs --record-area-audit=all --admit-new-areas --audit-ref=docs/audits/review.json
 *   node scripts/standards-coverage.mjs --record-area-model-audit --audit-ref=docs/audits/model-review.json
 *   node scripts/standards-coverage.mjs --allow-partial-registry # explicit non-CI partial checkout
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
import yaml from 'js-yaml';
import { articleIds, parseRegistryStructure } from './standards-registry-article-core.mjs';
import {
  evaluateStandardsDirection,
  evaluateOperatorReviewApproval,
  inventoryStandardsArticles,
  readCandidateApproverKey,
  readDirectionApprovalLedger,
  resolveProtectedApproverKey,
  resolveProtectedBaseRegistry,
} from './standards-direction-guard.mjs';
import {
  measureAnchoredEnforcement,
  resolveProtectedMeasurementSnapshot,
  routeTableFromSnapshot,
} from './lib/standards-enforcement-measurement.mjs';
import { parseFrontmatter, validateAuditReport } from './write-audit-convergence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const JSON_ONLY = args.has('--json');
const QUIET = args.has('--quiet');
/**
 * `--rebaseline-floor="<reason>"` — the ONLY way a family's enforcement floor may go
 * DOWN, and it exists because of a specific operator ruling (Justin, 2026-08-08).
 *
 * The floor normally ratchets: `recordAreaAudit` keeps the OLD floor whenever the
 * measured ratio is below it, so a family can never quietly lower its own bar. That is
 * right for the case it was built for — enforcement genuinely regressing.
 *
 * It is WRONG for one case. When articles are re-filed between families to correct a
 * MISFILING, the losing family's density changes for a reason that has nothing to do
 * with whether anything is better guarded. The ruling: *a floor satisfied by misfiled
 * articles was passing on false composition, and fixing a filing mistake must not be
 * punishable by the meter the mistake was inflating.*
 *
 * So this flag is deliberately awkward: it must be typed, it must carry a reason, and
 * the reason belongs in the commit and the audit report where a reviewer will see it.
 * It does NOT verify enforcement-neutrality itself — the author must establish that
 * separately (registry-wide enforced ratio identical before and after) and say so. What
 * it certifies is only that the lowering was DELIBERATE and attributed, never that it
 * was justified. A floor that can never move is a floor that eventually protects a lie;
 * a floor that moves silently is not a floor.
 */
const REBASELINE_ARG = [...args].find((arg) => arg.startsWith('--rebaseline-floor='));
const REBASELINE_REASON = REBASELINE_ARG?.slice('--rebaseline-floor='.length) ?? null;
const RECORD_AREA_ARG = [...args].find((arg) => arg.startsWith('--record-area-audit='));
const RECORD_AREA = RECORD_AREA_ARG?.slice('--record-area-audit='.length) ?? null;
const AUDIT_REF_ARG = [...args].find((arg) => arg.startsWith('--audit-ref='));
const AUDIT_REF = AUDIT_REF_ARG?.slice('--audit-ref='.length) ?? null;
const RECORD_AREA_MODEL = args.has('--record-area-model-audit');
const ALLOW_PARTIAL_REGISTRY = args.has('--allow-partial-registry');
const REQUIRE_ROOT = !ALLOW_PARTIAL_REGISTRY || args.has('--require-root');
const ADMIT_NEW_AREAS = args.has('--admit-new-areas');

function resolveRoot() {
  if (process.env.STANDARDS_COVERAGE_ROOT) return process.env.STANDARDS_COVERAGE_ROOT;
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'src'))) return cwd;
  return path.resolve(__dirname, '..');
}
const ROOT = resolveRoot();
const REGISTRY_PATH = path.join(ROOT, 'docs', 'STANDARDS-REGISTRY.md');
const AREA_AUDITS_PATH = path.join(ROOT, 'docs', 'standards-registry-area-audits.json');
const AREA_MODEL_AUDIT_PATH = path.join(ROOT, 'docs', 'standards-registry-area-model-audit.json');
const CI_WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const OUT_PATH = path.join(ROOT, '.instar', 'standards-coverage.json');
const DIRECTION_APPROVALS_PATH = path.join(ROOT, 'docs', 'standards-direction-approvals.json');
const DIRECTION_APPROVER_KEY_PATH = path.join(ROOT, '.github', 'keyrings', 'telegram-principal-pub.pem');

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
  // Added 2026-08-13 with operator rulings 4b/4c. An article whose provenance claimed
  // an incident it never had was borrowing that incident's authority; the rulings split
  // the honest cases out of `Earned from`. All are PROVENANCE, never ENFORCEMENT — they
  // say where an article came FROM, and scanning them for guards would let an origin
  // story read as a live check.
  //
  // NOTE — this list is a hand-kept MIRROR of the same three lists in
  // `src/core/StandardsRegistryParser.ts`. Adding a heading there and not here is
  // silent: the parser classifies it while this ratchet counts it unrecognized. That
  // is exactly how this edit was caught, and the duplication is worth removing.
  'Articulated during',
  'Derives from',
  'Earned from',
  'Grounded in',
  'Provenance status',
  'Ratified by',
  'Ratified from operator policy',
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
  // Added 2026-08-07 by operator ruling on external-review finding 4: an article
  // honestly labelled `documented-only` must carry a COUNTDOWN — a deadline and a
  // tracked item — because "documented-only MUST force a change in the near
  // future. It can't remain documented only."
  //
  // Deliberately classified NARRATIVE and never ENFORCEMENT: a countdown says a
  // guard is OWED, not that one exists. Placing it in the enforcement set would
  // let a promise-to-build flip an article to `enforced`, which is precisely the
  // over-claim finding 4 was raised about. Its refs must not be scanned.
  'Documented-only until',
  // Added 2026-08-13 by operator ruling on decision-package item 2 — the seven grouped
  // failure-direction defaults. NARRATIVE, never ENFORCEMENT, for the same reason as
  // the countdown above: a failure direction describes what should happen when a guard
  // is MISSING, which is the opposite of evidence that one exists.
  // Added 2026-08-13 by operator ruling on decision-package item 3. Ten articles were
  // accepted as genuinely NOT mechanisable; each says so in place and names the judgment it
  // turns on, plus the obligation that replaces the check (context sufficiency + rating).
  //
  // NARRATIVE, never ENFORCEMENT — and this one most of all: the field's entire content is
  // 'no mechanical check exists here'. Filing it as enforcement would let an article's own
  // admission that it is unguarded read as evidence of a guard.
  // Added 2026-08-13 by operator ruling 4a. An ARCHIVALLY RETIRED article keeps its text and
  // gains a retirement record naming what superseded it and which live article absorbed its
  // obligations. Stripping the body instead would drop the article from this parser entirely —
  // the count falls, every area ratio moves, and the 27 surviving citations measured during the
  // escalation start dangling, which is the breakage the ruling refused.
  //
  // NARRATIVE, never ENFORCEMENT: 'this no longer governs' is a status, not a guard. And
  // 'Retirement held' records WHY an article that was proposed for retirement stays live, with
  // the dated owner whose job is to build the absorption target it lacks.
  // Added 2026-08-13 by the operator's RE-RULING of 4a: MERGE, not archive. A superseded standard
  // becomes a named SUBSECTION of its parent and stays LIVE — 'Merged into' on the child, 'Merged
  // subsections' on the parent, which names each child AND the specific tripwire it carries.
  //
  // The operator's reason, and the bar the fields exist to hold: 'if the lower level standards are
  // retired, the higher level standards may not have the level of specificity needed for the
  // development process to avoid the pitfalls that the retired standards represent.'
  //
  // NARRATIVE, never ENFORCEMENT: these state where a standard sits in the tree, not that a guard
  // exists for it. The child keeps its own enforcement citations.
  // Justin's structural addition, 2026-08-13, binding: 'The tree structure itself should by default
  // remove the possibility of duplicates since any new standard introduced has to find a proper place
  // in the tree, whether that's updating a current standard becoming a child of a current standard or
  // becoming a new route or foundational standard.' The 25 duplicates existed because that was never
  // structurally enforced. 'Tree placement' is where a standard states which of the three it took.
  //
  // NARRATIVE, never ENFORCEMENT: a placement is where a standard SITS, not a guard that it works.
  'Tree placement',
  'Merged into',
  'Merged subsections',
  'Judgment-bound',
  'Fails',
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
    raw: rawSection.raw,
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
      return { name: block.name, article, observedSections, raw: block.raw };
    }),
  }));

  const articles = [];
  const areaSections = new Map();
  const enforcementScope = {
    recognizedHeadings: [...ENFORCEMENT_SECTION_HEADINGS],
    excludedProvenanceHeadings: [...EXCLUDED_PROVENANCE_SECTION_HEADINGS],
    excludedNarrativeHeadings: [...EXCLUDED_NARRATIVE_SECTION_HEADINGS],
    capturedSections: 0,
    unrecognizedSections: [],
  };
  for (const candidate of sections) {
    if (!candidate.blocks.some((block) => block.article.rule)) continue;
    const area = familyName(candidate.heading);
    if (!areaSections.has(area)) areaSections.set(area, []);
    areaSections.get(area).push(candidate.raw);
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
          `${area} › ${block.name} › ${heading}`,
        );
      }
    }
  }
  const areaSha256 = Object.fromEntries(
    [...areaSections.entries()].map(([area, sections]) => [
      area,
      crypto.createHash('sha256')
        // Git's object is LF-normalized while a checkout may be CRLF. Hash the
        // same logical registry bytes on every machine, not checkout policy.
        .update(`standards-area-audit-v1\0${JSON.stringify(sections.map((section) => section.replace(/\r\n?/g, '\n')))}`)
        .digest('hex'),
    ]),
  );
  return {
    articles,
    enforcementScope,
    areaSha256,
    areaSectionCounts: Object.fromEntries(
      [...areaSections.entries()].map(([area, areaSectionsForName]) => [area, areaSectionsForName.length]),
    ),
  };
}

function measuredArticles(markdown, parsedArticles) {
  const inventory = inventoryStandardsArticles(markdown);
  return {
    articles: parsedArticles.map((article, index) => {
      const identity = inventory.articles[index];
      return {
        ...article,
        id: identity?.id ?? null,
        ruleSha256: identity?.ruleSha256 ?? null,
        articleSha256: identity?.articleSha256 ?? null,
        refs: extractRefs(article),
      };
    }),
    errors: inventory.errors,
  };
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

// ── Per-area audit facts + floors ────────────────────────────────────────────

const AREA_AUDIT_SCHEMA_VERSION = 2;
const AUDIT_EVIDENCE_SCHEMA_VERSION = 1;
const AREA_MODEL_AUDIT_SCHEMA_VERSION = 1;
const AREA_MODEL_EVIDENCE_SCHEMA_VERSION = 1;
const AREA_MODEL_SCOPE = 'area-model-adequacy';
const AREA_MODEL_ACTIONS = ['keep', 'add', 'split', 'merge', 'retire'];
const CURRENT_AREA_DISPOSITIONS = new Set(['keep', 'split', 'merge', 'retire']);
const AREA_AUDIT_KEYS = [
  'lastAuditedAt', 'auditRef', 'auditSha256', 'areaSha256', 'refResolutionFloor',
];
const SHA256_RE = /^[a-f0-9]{64}$/;
const RFC3339_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullObject = () => Object.create(null);

function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !RFC3339_UTC_RE.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

/**
 * A permit authorises exactly ONE floor decrease, for one area, from one specific
 * floor to one specific floor. Anything less exact is ignored, so a stale permit
 * cannot silently authorise a LATER, different decrease.
 *
 * It also requires the entry to assert enforcement-neutrality by stating the
 * registry-wide enforced ratio before and after, and those must be EQUAL. That is the
 * whole justification for the exception: a re-filing moves articles between families
 * without changing how much of the constitution is guarded. A permit whose own numbers
 * show enforcement dropping is refused — the mechanism cannot be used to launder a real
 * regression as a filing correction.
 *
 * What it does NOT verify: that the stated ratios are true. They are an author's
 * assertion, reviewed in the PR alongside the diff that produced them. This certifies
 * that the decrease was named, bounded, attributed and claimed-neutral — never that the
 * claim was audited.
 */
function findRebaselinePermit(area, priorFloor, nextFloor) {
  const abs = path.join(ROOT, 'docs/standards-floor-rebaselines.json');
  if (!fs.existsSync(abs)) return null;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(abs, 'utf-8')); } catch { return null; }
  if (!Array.isArray(doc?.rebaselines)) return null;
  return doc.rebaselines.find((entry) => entry?.area === area
    && validFloor(entry?.from) && validFloor(entry?.to)
    && entry.from.enforced === priorFloor.enforced && entry.from.total === priorFloor.total
    && entry.to.enforced === nextFloor.enforced && entry.to.total === nextFloor.total
    && typeof entry.authority === 'string' && entry.authority.trim().length > 0
    && Number.isFinite(entry.registryEnforcedRatioBefore) && Number.isFinite(entry.registryEnforcedRatioAfter)
    && entry.registryEnforcedRatioBefore === entry.registryEnforcedRatioAfter) ?? null;
}

function validFloor(value) {
  return isPlainObject(value) && Number.isSafeInteger(value.enforced) && Number.isSafeInteger(value.total) &&
    value.enforced >= 0 && value.total > 0 && value.enforced <= value.total &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['enforced', 'total']);
}

function floorRatio(value) {
  return validFloor(value) ? Number((value.enforced / value.total).toFixed(4)) : null;
}

function ratioBelowFloor(enforced, total, floor) {
  return validFloor(floor) && BigInt(enforced) * BigInt(floor.total) < BigInt(floor.enforced) * BigInt(total);
}

function numericFloorFraction(value) {
  const [coefficient, exponentText = '0'] = String(value).toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const exponent = Number(exponentText);
  const digits = BigInt(`${whole}${fraction}`);
  const scale = fraction.length - exponent;
  return scale >= 0
    ? { numerator: digits, denominator: 10n ** BigInt(scale) }
    : { numerator: digits * 10n ** BigInt(-scale), denominator: 1n };
}

function ratioBelowNumericFloor(enforced, total, floor) {
  const threshold = numericFloorFraction(floor);
  return BigInt(enforced) * threshold.denominator < threshold.numerator * BigInt(total);
}

function canonicalAreaAuditLedger(value) {
  const areas = nullObject();
  const sourceAreas = isPlainObject(value?.areas) ? value.areas : nullObject();
  for (const area of Object.keys(sourceAreas).sort()) {
    const entry = isPlainObject(sourceAreas[area]) ? sourceAreas[area] : {};
    areas[area] = {
      lastAuditedAt: entry.lastAuditedAt,
      auditRef: entry.auditRef,
      auditSha256: entry.auditSha256,
      areaSha256: entry.areaSha256,
      refResolutionFloor: entry.refResolutionFloor,
    };
  }
  return { schemaVersion: value?.schemaVersion, areas };
}

function serializeAreaAuditLedger(value) {
  return JSON.stringify(canonicalAreaAuditLedger(value), null, 2) + '\n';
}

function canonicalText(value) {
  return value.replace(/\r\n?/g, '\n');
}

function textSha256(value) {
  return crypto.createHash('sha256').update(canonicalText(value)).digest('hex');
}

function areaSetSha256(areaNames) {
  return textSha256(`standards-area-model-v1\n${[...areaNames].sort().join('\n')}\n`);
}

function validateRootSelfWiring() {
  const errors = [];
  let stat;
  try { stat = fs.lstatSync(CI_WORKFLOW_PATH); } catch { stat = null; }
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    errors.push('The Root self-wiring requires .github/workflows/ci.yml to be a regular non-symlink file');
    return { status: 'invalid', errors };
  }
  let workflow;
  try { workflow = yaml.load(canonicalText(fs.readFileSync(CI_WORKFLOW_PATH, 'utf-8'))); } catch { workflow = null; }
  if (!isPlainObject(workflow)) {
    errors.push('The Root self-wiring requires .github/workflows/ci.yml to be valid mapping YAML');
    return { status: 'invalid', errors };
  }
  const exactKeys = (value, keys) => isPlainObject(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  const eventTargetsMain = (event) => {
    const config = workflow.on?.[event];
    return exactKeys(config, ['branches']) &&
      Array.isArray(config.branches) && config.branches.length === 1 && config.branches[0] === 'main';
  };
  if (!exactKeys(workflow.on, ['push', 'pull_request', 'workflow_dispatch']) ||
    !(workflow.on.workflow_dispatch === null || exactKeys(workflow.on.workflow_dispatch, [])) ||
    !eventTargetsMain('push') || !eventTargetsMain('pull_request')) {
    errors.push('The Root self-wiring requires top-level push and pull_request CI triggers targeting main');
  }
  const job = workflow.jobs?.['standards-coverage'];
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const checkStep = steps.find((step) => step?.run === 'node scripts/standards-coverage.mjs --check');
  const checkEnv = {
    STANDARDS_AREA_AUDIT_BASE_FILE: '${{ runner.temp }}/standards-area-audits-base.json',
    STANDARDS_AREA_AUDIT_BASE_REQUIRED: '${{ steps.area-audit-base.outputs.required }}',
    STANDARDS_DIRECTION_BASE_FILE: '${{ runner.temp }}/standards-registry-base.md',
    STANDARDS_DIRECTION_BASE_APPROVER_KEY_FILE: '${{ runner.temp }}/standards-direction-approver-base.pem',
    STANDARDS_DIRECTION_BASE_REVISION: "${{ github.event.pull_request.base.sha || github.event.before || format('{0}^', github.sha) }}",
    // Path B (2026-08-22): the operator-review context the guard reads. Pinned
    // here for the same reason as the others — this contract is deliberately
    // EXACT so the CI wiring cannot be quietly rearranged, and adding an input
    // to the check must therefore be a visible, declared edit rather than a
    // silent one. The guard caught exactly that when this key was introduced.
    STANDARDS_DIRECTION_REVIEW_FILE: '${{ runner.temp }}/standards-direction-review.json',
  };
  if (!exactKeys(job, ['name', 'runs-on', 'steps']) ||
    job.name !== 'Standards Enforcement Coverage' || job['runs-on'] !== 'ubuntu-latest' ||
    !exactKeys(checkStep, ['run', 'env']) || !exactKeys(checkStep?.env, Object.keys(checkEnv)) ||
    Object.entries(checkEnv).some(([key, value]) => checkStep.env[key] !== value) ||
    Object.hasOwn(workflow, 'defaults') || Object.hasOwn(workflow, 'env')) {
    errors.push('The Root self-wiring requires the standards-coverage CI job to invoke node scripts/standards-coverage.mjs --check');
  }
  const checkoutStep = steps.find((step) => step?.uses === 'actions/checkout@v4');
  const setupStep = steps.find((step) => step?.uses === 'actions/setup-node@v4');
  const installStep = steps.find((step) => step?.run === 'npm ci --ignore-scripts');
  const baseStep = steps.find((step) => step?.id === 'area-audit-base');
  // Path B's evidence-gathering step. Pinned into the ordered prefix so it
  // cannot be dropped without this check failing — an absent step would make
  // every operator approval read as UNAVAILABLE, which fails safe but would
  // silently return the operator to needing a key.
  const reviewStep = steps.find((step) => step?.name === 'Fetch operator review context (direction guard path B)');
  const expectedBaseRun = [
    'git cat-file -e "$BASE_SHA^{commit}"',
    'if git cat-file -e "$BASE_SHA:docs/standards-registry-area-audits.json"; then',
    '  git show "$BASE_SHA:docs/standards-registry-area-audits.json" > "$RUNNER_TEMP/standards-area-audits-base.json"',
    '  echo "required=1" >> "$GITHUB_OUTPUT"',
    'else',
    '  echo "required=0" >> "$GITHUB_OUTPUT"',
    'fi',
    'git show "$BASE_SHA:docs/STANDARDS-REGISTRY.md" > "$RUNNER_TEMP/standards-registry-base.md"',
    'git show "$BASE_SHA:.github/keyrings/telegram-principal-pub.pem" > "$RUNNER_TEMP/standards-direction-approver-base.pem"',
    '',
  ].join('\n');
  const expectedBaseSha = "${{ github.event.pull_request.base.sha || github.event.before || format('{0}^', github.sha) }}";
  const exactPrefix = [checkoutStep, setupStep, installStep, baseStep, reviewStep, checkStep];
  const ordered = exactPrefix.every((step, index) => step && steps[index] === step);
  const protectedBaseWired = ordered &&
    exactKeys(checkoutStep, ['uses', 'with']) && exactKeys(checkoutStep.with, ['fetch-depth']) && checkoutStep.with['fetch-depth'] === 0 &&
    exactKeys(setupStep, ['uses', 'with']) && exactKeys(setupStep.with, ['node-version']) && setupStep.with['node-version'] === 20 &&
    exactKeys(installStep, ['run']) &&
    exactKeys(baseStep, ['name', 'id', 'env', 'run']) &&
    baseStep.name === 'Resolve protected-base area ledger' &&
    exactKeys(baseStep.env, ['BASE_SHA']) && baseStep.env.BASE_SHA === expectedBaseSha &&
    baseStep.run === expectedBaseRun &&
    exactKeys(reviewStep, ['name', 'if', 'env', 'run']) &&
    reviewStep.if === "github.event_name == 'pull_request'" &&
    exactKeys(reviewStep.env, ['GH_TOKEN', 'PR', 'HEAD_SHA', 'OWNER_LOGIN', 'OWNER_TYPE', 'PR_AUTHOR', 'OUT']) &&
    reviewStep.env.OUT === '${{ runner.temp }}/standards-direction-review.json';
  if (!protectedBaseWired) {
    errors.push('The Root self-wiring requires dependency install plus full-history protected-base extraction and required base env on the standards check');
  }
  return { status: errors.length === 0 ? 'wired' : 'invalid', errors };
}

function resolveJailedRegularFile(ref, jail, extension) {
  if (typeof ref !== 'string' || ref.length < 5 || ref.length > 240) return 'must be a 5-240 character path';
  if (ref.includes('\\') || path.posix.normalize(ref) !== ref || path.posix.isAbsolute(ref) || ref.startsWith('../')) {
    return 'must be a normalized repository-relative path';
  }
  if (!ref.startsWith(`${jail}/`) || !ref.endsWith(extension)) {
    return `must be a ${extension} artifact under ${jail}/`;
  }
  const full = path.resolve(ROOT, ref);
  if (!full.startsWith(`${path.resolve(ROOT)}${path.sep}`)) return 'must stay inside the repository';
  let jailCursor = path.resolve(ROOT);
  for (const component of jail.split('/')) {
    jailCursor = path.join(jailCursor, component);
    let componentStat;
    try { componentStat = fs.lstatSync(jailCursor); } catch { return 'must resolve through an existing evidence jail'; }
    if (!componentStat.isDirectory() || componentStat.isSymbolicLink()) {
      return `must use a real non-symlink ${jail}/ directory`;
    }
  }
  const lexicalParent = path.dirname(full);
  const descendant = path.relative(path.resolve(ROOT, jail), lexicalParent);
  for (const component of descendant.split(path.sep).filter(Boolean)) {
    jailCursor = path.join(jailCursor, component);
    let componentStat;
    try { componentStat = fs.lstatSync(jailCursor); } catch { return 'must resolve through an existing evidence jail'; }
    if (!componentStat.isDirectory() || componentStat.isSymbolicLink()) {
      return `must not traverse a symlinked ancestor under ${jail}/`;
    }
  }
  let stat;
  try { stat = fs.lstatSync(full); } catch { return 'must resolve to an existing review artifact'; }
  if (!stat.isFile() || stat.isSymbolicLink()) return 'must resolve to a regular file (symlinks are not accepted)';
  let jailReal;
  let fullReal;
  try {
    jailReal = fs.realpathSync(path.resolve(ROOT, jail));
    fullReal = fs.realpathSync(full);
  } catch {
    return 'must resolve through an existing evidence jail';
  }
  const relativeToJail = path.relative(jailReal, fullReal);
  if (relativeToJail.startsWith(`..${path.sep}`) || relativeToJail === '..' || path.isAbsolute(relativeToJail)) {
    return `must stay inside the real ${jail}/ directory (symlinked ancestors are not accepted)`;
  }
  return { fullPath: fullReal };
}

function auditRefError(ref) {
  const resolved = resolveJailedRegularFile(ref, 'docs/audits', '.json');
  if (typeof resolved !== 'string') return null;
  if (resolved === 'must be a .json artifact under docs/audits/') {
    return 'must be a JSON evidence artifact under docs/audits/';
  }
  return resolved;
}

function serializeAuditEvidence(value) {
  const areas = nullObject();
  const sourceAreas = isPlainObject(value?.areas) ? value.areas : nullObject();
  for (const area of Object.keys(sourceAreas).sort()) {
    areas[area] = {
      areaSha256: sourceAreas[area]?.areaSha256,
      verdict: sourceAreas[area]?.verdict,
    };
  }
  return JSON.stringify({
    schemaVersion: value?.schemaVersion,
    reviewedAt: value?.reviewedAt,
    reviewers: value?.reviewers,
    findingDisposition: value?.findingDisposition,
    convergenceReport: value?.convergenceReport,
    convergenceSha256: value?.convergenceSha256,
    areas,
  }, null, 2) + '\n';
}

function readAuditEvidence(ref) {
  const resolvedAudit = resolveJailedRegularFile(ref, 'docs/audits', '.json');
  const refError = typeof resolvedAudit === 'string' ? auditRefError(ref) : null;
  if (refError) return { bytes: null, sha256: null, evidence: null, errors: [refError] };
  let bytes;
  try { bytes = fs.readFileSync(resolvedAudit.fullPath, 'utf-8'); } catch { return { bytes: null, sha256: null, evidence: null, errors: ['cannot be read'] }; }
  let evidence;
  try { evidence = JSON.parse(bytes); } catch { return { bytes, sha256: null, evidence: null, errors: ['is not valid JSON'] }; }
  const errors = [];
  if (canonicalText(bytes) !== serializeAuditEvidence(evidence)) errors.push('is not in canonical form');
  if (!isPlainObject(evidence) || evidence.schemaVersion !== AUDIT_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`must use schemaVersion ${AUDIT_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (!canonicalTimestamp(evidence?.reviewedAt)) errors.push('has invalid reviewedAt');
  if (!isPlainObject(evidence?.areas)) errors.push('must contain an areas object');
  if (isPlainObject(evidence?.areas)) {
    for (const area of Object.keys(evidence.areas)) {
      const entry = evidence.areas[area];
      if (!isPlainObject(entry) ||
        JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['areaSha256', 'verdict']) ||
        typeof entry.areaSha256 !== 'string' || !SHA256_RE.test(entry.areaSha256) ||
        entry.verdict !== 'accepted') {
        errors.push(`has invalid evidence entry for ${area}`);
      }
    }
  }
  const reportRef = evidence?.convergenceReport;
  const resolvedReport = resolveJailedRegularFile(reportRef, 'docs/specs/reports', '.md');
  const reportPath = typeof resolvedReport === 'string' ? '' : resolvedReport.fullPath;
  if (typeof resolvedReport === 'string') errors.push('must name an existing regular convergenceReport under docs/specs/reports/');
  if (typeof evidence?.convergenceSha256 !== 'string' || !SHA256_RE.test(evidence.convergenceSha256)) {
    errors.push('has invalid convergenceSha256');
  } else if (reportPath) {
    const reportSha256 = textSha256(fs.readFileSync(reportPath, 'utf-8'));
    if (reportSha256 !== evidence.convergenceSha256) errors.push('convergenceReport bytes changed');
  }
  if (isPlainObject(evidence)) {
    const keys = Object.keys(evidence).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['areas', 'convergenceReport', 'convergenceSha256', 'findingDisposition', 'reviewedAt', 'reviewers', 'schemaVersion'])) {
      errors.push('must contain exactly schemaVersion, reviewedAt, reviewers, findingDisposition, convergenceReport, convergenceSha256, areas');
    }
  }
  if (!Array.isArray(evidence?.reviewers) || evidence.reviewers.length === 0 ||
    evidence.reviewers.some((reviewer) => typeof reviewer !== 'string' ||
      !/^[a-z0-9][a-z0-9:._/-]{1,119}$/i.test(reviewer)) ||
    new Set(evidence.reviewers).size !== evidence.reviewers.length) {
    errors.push('must name one or more unique reviewers');
  }
  const disposition = evidence?.findingDisposition;
  if (!isPlainObject(disposition) ||
    JSON.stringify(Object.keys(disposition).sort()) !== JSON.stringify(['noUnresolvedDesign', 'resolvedFindings']) ||
    disposition.noUnresolvedDesign !== true ||
    !Number.isSafeInteger(disposition.resolvedFindings) || disposition.resolvedFindings < 0) {
    errors.push('must declare findingDisposition { noUnresolvedDesign: true, resolvedFindings: nonnegative integer }');
  }
  return {
    bytes,
    sha256: textSha256(bytes),
    evidence,
    errors,
  };
}

function canonicalAreaModelEvidence(value) {
  const currentAreas = nullObject();
  const sourceAreas = isPlainObject(value?.currentAreas) ? value.currentAreas : nullObject();
  for (const area of Object.keys(sourceAreas).sort()) {
    currentAreas[area] = {
      disposition: sourceAreas[area]?.disposition,
      rationale: sourceAreas[area]?.rationale,
    };
  }
  const additions = Array.isArray(value?.additions)
    ? [...value.additions]
      .map((entry) => ({ name: entry?.name, rationale: entry?.rationale }))
      .sort((left, right) => String(left.name).localeCompare(String(right.name)))
    : value?.additions;
  return {
    schemaVersion: value?.schemaVersion,
    scope: value?.scope,
    reviewedAt: value?.reviewedAt,
    reviewers: value?.reviewers,
    findingDisposition: value?.findingDisposition,
    reviewedActions: value?.reviewedActions,
    convergenceReport: value?.convergenceReport,
    convergenceSha256: value?.convergenceSha256,
    currentAreas,
    additions,
  };
}

function serializeAreaModelEvidence(value) {
  return JSON.stringify(canonicalAreaModelEvidence(value), null, 2) + '\n';
}

function readAreaModelEvidence(ref, expectedAreas) {
  const resolved = resolveJailedRegularFile(ref, 'docs/audits', '.json');
  const refError = typeof resolved === 'string' ? auditRefError(ref) : null;
  if (refError) return { bytes: null, sha256: null, evidence: null, errors: [refError] };
  let bytes;
  try { bytes = fs.readFileSync(resolved.fullPath, 'utf-8'); } catch {
    return { bytes: null, sha256: null, evidence: null, errors: ['cannot be read'] };
  }
  let evidence;
  try { evidence = JSON.parse(bytes); } catch {
    return { bytes, sha256: null, evidence: null, errors: ['is not valid JSON'] };
  }
  const errors = [];
  if (canonicalText(bytes) !== serializeAreaModelEvidence(evidence)) errors.push('is not in canonical form');
  const topKeys = isPlainObject(evidence) ? Object.keys(evidence).sort() : [];
  const expectedTopKeys = [
    'additions', 'convergenceReport', 'convergenceSha256', 'currentAreas',
    'findingDisposition', 'reviewedActions', 'reviewedAt', 'reviewers',
    'schemaVersion', 'scope',
  ];
  if (!isPlainObject(evidence) || evidence.schemaVersion !== AREA_MODEL_EVIDENCE_SCHEMA_VERSION) {
    errors.push(`must use schemaVersion ${AREA_MODEL_EVIDENCE_SCHEMA_VERSION}`);
  }
  if (JSON.stringify(topKeys) !== JSON.stringify(expectedTopKeys)) {
    errors.push(`must contain exactly ${expectedTopKeys.join(', ')}`);
  }
  if (evidence?.scope !== AREA_MODEL_SCOPE) errors.push(`scope must be ${AREA_MODEL_SCOPE}`);
  if (!canonicalTimestamp(evidence?.reviewedAt)) errors.push('has invalid reviewedAt');
  if (!Array.isArray(evidence?.reviewers) || evidence.reviewers.length === 0 ||
    evidence.reviewers.some((reviewer) => typeof reviewer !== 'string' ||
      !/^[a-z0-9][a-z0-9:._/-]{1,119}$/i.test(reviewer)) ||
    new Set(evidence.reviewers).size !== evidence.reviewers.length) {
    errors.push('must name one or more unique reviewers');
  }
  const findingDisposition = evidence?.findingDisposition;
  if (!isPlainObject(findingDisposition) ||
    JSON.stringify(Object.keys(findingDisposition).sort()) !== JSON.stringify(['noUnresolvedDesign', 'resolvedFindings']) ||
    findingDisposition.noUnresolvedDesign !== true ||
    !Number.isSafeInteger(findingDisposition.resolvedFindings) || findingDisposition.resolvedFindings < 0) {
    errors.push('must declare findingDisposition { noUnresolvedDesign: true, resolvedFindings: nonnegative integer }');
  }
  if (!Array.isArray(evidence?.reviewedActions) ||
    JSON.stringify(evidence.reviewedActions) !== JSON.stringify(AREA_MODEL_ACTIONS)) {
    errors.push(`reviewedActions must be exactly ${AREA_MODEL_ACTIONS.join(', ')}`);
  }

  const expected = [...expectedAreas].sort();
  const actual = isPlainObject(evidence?.currentAreas) ? Object.keys(evidence.currentAreas).sort() : [];
  if (!isPlainObject(evidence?.currentAreas)) errors.push('must contain a currentAreas object');
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(`currentAreas must exactly cover the parsed family set (expected: ${expected.join(', ') || 'none'})`);
  }
  for (const area of actual) {
    const entry = evidence.currentAreas[area];
    if (!isPlainObject(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['disposition', 'rationale']) ||
      !CURRENT_AREA_DISPOSITIONS.has(entry.disposition) ||
      typeof entry.rationale !== 'string' || entry.rationale.trim().length < 24 || entry.rationale.length > 1000) {
      errors.push(`currentAreas entry for ${area} must carry a keep/split/merge/retire disposition and a 24-1000 character rationale`);
    }
  }
  if (!Array.isArray(evidence?.additions)) {
    errors.push('additions must be an array (empty is the explicit no-add disposition)');
  } else {
    const seen = new Set();
    for (const addition of evidence.additions) {
      if (!isPlainObject(addition) ||
        JSON.stringify(Object.keys(addition).sort()) !== JSON.stringify(['name', 'rationale']) ||
        typeof addition.name !== 'string' || addition.name.trim() !== addition.name ||
        addition.name.length < 2 || addition.name.length > 120 || seen.has(addition.name) ||
        expected.includes(addition.name) ||
        typeof addition.rationale !== 'string' || addition.rationale.trim().length < 24 || addition.rationale.length > 1000) {
        errors.push('each additions entry must name one unique non-current area with a 24-1000 character rationale');
        break;
      }
      seen.add(addition.name);
    }
  }

  const reportRef = evidence?.convergenceReport;
  const resolvedReport = resolveJailedRegularFile(reportRef, 'docs/audits', '.md');
  let reportBytes = null;
  if (typeof resolvedReport === 'string') {
    errors.push('must name an existing regular convergenceReport under docs/audits/');
  } else {
    try { reportBytes = fs.readFileSync(resolvedReport.fullPath, 'utf-8'); } catch {
      errors.push('convergenceReport cannot be read');
    }
  }
  if (typeof evidence?.convergenceSha256 !== 'string' || !SHA256_RE.test(evidence.convergenceSha256)) {
    errors.push('has invalid convergenceSha256');
  } else if (reportBytes !== null && textSha256(reportBytes) !== evidence.convergenceSha256) {
    errors.push('convergenceReport bytes changed');
  }
  if (reportBytes !== null) {
    const reportText = canonicalText(reportBytes);
    let convergence;
    try {
      convergence = validateAuditReport(reportText, {
        root: ROOT,
        basenameSlug: path.basename(reportRef, '.md'),
        requiredStandardsRef: 'docs/STANDARDS-REGISTRY.md',
        standardEvidence: { responseChanged: false },
      });
    } catch (error) {
      convergence = { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
    if (!convergence.ok) {
      errors.push(`convergenceReport has not earned convergence: ${convergence.reason}`);
    } else {
      const resolvedFindings = convergence.rounds.reduce((sum, round) => sum + round.rows.length, 0);
      if (findingDisposition?.resolvedFindings !== resolvedFindings) {
        errors.push(`findingDisposition resolvedFindings must equal the convergenceReport ledger count (${resolvedFindings})`);
      }
      try {
        const convergedAt = parseFrontmatter(reportText).fields.converged;
        if (convergedAt !== evidence.reviewedAt) {
          errors.push('reviewedAt must equal the convergenceReport earned timestamp');
        }
      } catch {
        errors.push('convergenceReport frontmatter cannot be read');
      }
    }
  }
  return { bytes, sha256: textSha256(bytes), evidence, errors };
}

function canonicalAreaModelAuditRecord(value) {
  return {
    schemaVersion: value?.schemaVersion,
    lastAuditedAt: value?.lastAuditedAt,
    auditRef: value?.auditRef,
    auditSha256: value?.auditSha256,
    areaSetSha256: value?.areaSetSha256,
  };
}

function serializeAreaModelAuditRecord(value) {
  return JSON.stringify(canonicalAreaModelAuditRecord(value), null, 2) + '\n';
}

function loadAreaModelAudit(expectedAreas) {
  let raw;
  try { raw = fs.readFileSync(AREA_MODEL_AUDIT_PATH, 'utf-8'); } catch {
    return { record: null, errors: ['area model adequacy audit record is missing'] };
  }
  let record;
  try { record = JSON.parse(raw); } catch {
    return { record: null, errors: ['area model adequacy audit record is not valid JSON'] };
  }
  const errors = [];
  const keys = isPlainObject(record) ? Object.keys(record).sort() : [];
  const expectedKeys = ['areaSetSha256', 'auditRef', 'auditSha256', 'lastAuditedAt', 'schemaVersion'];
  if (!isPlainObject(record) || record.schemaVersion !== AREA_MODEL_AUDIT_SCHEMA_VERSION ||
    JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    errors.push(`area model adequacy audit record must use schemaVersion ${AREA_MODEL_AUDIT_SCHEMA_VERSION} and exact keys`);
  }
  if (!canonicalTimestamp(record?.lastAuditedAt)) {
    errors.push('area model adequacy audit record has invalid lastAuditedAt');
  } else if (Date.parse(record.lastAuditedAt) > Date.now() + 5 * 60_000) {
    errors.push('area model adequacy audit record has a future lastAuditedAt');
  }
  const evidence = readAreaModelEvidence(record?.auditRef, expectedAreas);
  for (const error of evidence.errors) errors.push(`area model adequacy auditRef ${error}`);
  if (typeof record?.auditSha256 !== 'string' || !SHA256_RE.test(record.auditSha256)) {
    errors.push('area model adequacy audit record has invalid auditSha256');
  } else if (evidence.sha256 && record.auditSha256 !== evidence.sha256) {
    errors.push('area model adequacy audit artifact changed');
  }
  const currentAreaSetSha256 = areaSetSha256(expectedAreas);
  if (typeof record?.areaSetSha256 !== 'string' || !SHA256_RE.test(record.areaSetSha256)) {
    errors.push('area model adequacy audit record has invalid areaSetSha256');
  } else if (record.areaSetSha256 !== currentAreaSetSha256) {
    errors.push('area model adequacy audit is stale for the current family set');
  }
  if (evidence.evidence?.reviewedAt !== record?.lastAuditedAt) {
    errors.push('area model adequacy audit reviewedAt does not match lastAuditedAt');
  }
  if (isPlainObject(record) && canonicalText(raw) !== serializeAreaModelAuditRecord(record)) {
    errors.push('area model adequacy audit record is not in canonical form');
  }
  return { record, evidence, currentAreaSetSha256, errors };
}

function loadAreaAuditLedger(expectedAreas) {
  let raw;
  try {
    raw = fs.readFileSync(AREA_AUDITS_PATH, 'utf-8');
  } catch {
    return {
      ledger: null,
      errors: [`area audit ledger missing: ${path.relative(ROOT, AREA_AUDITS_PATH)}`],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ledger: null,
      errors: [`area audit ledger is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  const errors = [];
  if (!isPlainObject(parsed)) errors.push('area audit ledger root must be an object');
  if (parsed?.schemaVersion !== AREA_AUDIT_SCHEMA_VERSION) {
    errors.push(`area audit ledger schemaVersion ${String(parsed?.schemaVersion)} != ${AREA_AUDIT_SCHEMA_VERSION}`);
  }
  if (!isPlainObject(parsed?.areas)) errors.push('area audit ledger areas must be an object');

  const topKeys = isPlainObject(parsed) ? Object.keys(parsed).sort() : [];
  if (JSON.stringify(topKeys) !== JSON.stringify(['areas', 'schemaVersion'])) {
    errors.push(`area audit ledger top-level keys must be exactly schemaVersion, areas (found: ${topKeys.join(', ') || 'none'})`);
  }

  const ledgerAreas = isPlainObject(parsed?.areas) ? Object.keys(parsed.areas).sort() : [];
  const expected = [...expectedAreas].sort();
  const missing = expected.filter((area) => !ledgerAreas.includes(area));
  const extra = ledgerAreas.filter((area) => !expected.includes(area));
  if (missing.length > 0) errors.push(`area audit ledger missing families: ${missing.join(', ')}`);
  if (extra.length > 0) errors.push(`area audit ledger has unknown families: ${extra.join(', ')}`);

  const unknownEvidenceClaims = new Set();
  for (const area of ledgerAreas) {
    const entry = parsed.areas[area];
    if (!isPlainObject(entry)) {
      errors.push(`area audit record for ${area} must be an object`);
      continue;
    }
    const keys = Object.keys(entry).sort();
    const expectedKeys = [...AREA_AUDIT_KEYS].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
      errors.push(`area audit record for ${area} must contain exactly ${AREA_AUDIT_KEYS.join(', ')}`);
    }
    if (!canonicalTimestamp(entry.lastAuditedAt)) {
      errors.push(`area audit record for ${area} has invalid lastAuditedAt`);
    } else if (Date.parse(entry.lastAuditedAt) > Date.now() + 5 * 60_000) {
      errors.push(`area audit record for ${area} has a future lastAuditedAt`);
    }
    const evidence = readAuditEvidence(entry.auditRef);
    for (const error of evidence.errors) errors.push(`area audit record for ${area} auditRef ${error}`);
    if (isPlainObject(evidence.evidence?.areas)) {
      for (const attestedArea of Object.keys(evidence.evidence.areas)) {
        if (!ledgerAreas.includes(attestedArea)) {
          unknownEvidenceClaims.add(`area audit artifact ${String(entry.auditRef)} attests unknown family ${attestedArea}`);
        }
      }
    }
    if (typeof entry.auditSha256 !== 'string' || !SHA256_RE.test(entry.auditSha256)) {
      errors.push(`area audit record for ${area} has invalid auditSha256`);
    } else if (evidence.sha256 && entry.auditSha256 !== evidence.sha256) {
      errors.push(`area audit record for ${area} audit artifact changed: expected ${entry.auditSha256.slice(0, 12)}, current ${evidence.sha256.slice(0, 12)}`);
    }
    if (typeof entry.areaSha256 !== 'string' || !SHA256_RE.test(entry.areaSha256)) {
      errors.push(`area audit record for ${area} has invalid areaSha256`);
    }
    if (!validFloor(entry.refResolutionFloor)) errors.push(`area audit record for ${area} has invalid refResolutionFloor`);
    const evidenceArea = isPlainObject(evidence.evidence?.areas?.[area]) ? evidence.evidence.areas[area] : null;
    if (!evidenceArea) errors.push(`area audit artifact ${String(entry.auditRef)} does not attest family ${area}`);
    else {
      if (evidenceArea.areaSha256 !== entry.areaSha256) errors.push(`area audit artifact digest does not attest current record for ${area}`);
      if (evidenceArea.verdict !== 'accepted') errors.push(`area audit artifact verdict for ${area} must be accepted`);
      if (evidence.evidence.reviewedAt !== entry.lastAuditedAt) errors.push(`area audit artifact reviewedAt does not match ${area} lastAuditedAt`);
      const evidenceKeys = Object.keys(evidenceArea).sort();
      if (JSON.stringify(evidenceKeys) !== JSON.stringify(['areaSha256', 'verdict'])) {
        errors.push(`area audit artifact entry for ${area} must contain exactly areaSha256, verdict`);
      }
    }
  }
  errors.push(...unknownEvidenceClaims);

  if (isPlainObject(parsed) && canonicalText(raw) !== serializeAreaAuditLedger(parsed)) {
    errors.push('area audit ledger is not in canonical form (duplicate, unknown, or out-of-order fields may be present)');
  }
  return { ledger: parsed, errors };
}

function readBaseAreaAuditLedger() {
  const baseFile = process.env.STANDARDS_AREA_AUDIT_BASE_FILE;
  const required = process.env.STANDARDS_AREA_AUDIT_BASE_REQUIRED === '1';
  if (!baseFile) return { ledger: null, errors: required ? ['protected-base area ledger path is missing'] : [] };
  try {
    const raw = fs.readFileSync(baseFile, 'utf-8');
    const parsed = JSON.parse(raw);
    const errors = [];
    if (!isPlainObject(parsed) || parsed.schemaVersion !== AREA_AUDIT_SCHEMA_VERSION || !isPlainObject(parsed.areas) ||
      JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(['areas', 'schemaVersion'])) {
      errors.push('protected-base area ledger has unsupported schema');
    }
    if (isPlainObject(parsed?.areas)) {
      for (const area of Object.keys(parsed.areas)) {
        const entry = parsed.areas[area];
        if (!isPlainObject(entry) ||
          JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify([...AREA_AUDIT_KEYS].sort()) ||
          !canonicalTimestamp(entry.lastAuditedAt) ||
          Date.parse(entry.lastAuditedAt) > Date.now() + 5 * 60_000 ||
          typeof entry.auditRef !== 'string' || entry.auditRef.includes('\\') ||
          path.posix.normalize(entry.auditRef) !== entry.auditRef ||
          !entry.auditRef.startsWith('docs/audits/') || !entry.auditRef.endsWith('.json') ||
          typeof entry.auditSha256 !== 'string' || !SHA256_RE.test(entry.auditSha256) ||
          typeof entry.areaSha256 !== 'string' || !SHA256_RE.test(entry.areaSha256) ||
          !validFloor(entry.refResolutionFloor)) {
          errors.push(`protected-base area ledger has malformed record for ${area}`);
        }
      }
    }
    if (isPlainObject(parsed) && canonicalText(raw) !== serializeAreaAuditLedger(parsed)) {
      errors.push('protected-base area ledger is not in canonical form');
    }
    if (errors.length > 0) {
      return { ledger: null, errors };
    }
    return { ledger: parsed, errors: [] };
  } catch {
    return { ledger: null, errors: required ? ['protected-base area ledger is missing or unreadable'] : [] };
  }
}

function compareLedgerToBase(candidate) {
  const loaded = readBaseAreaAuditLedger();
  const base = loaded.ledger;
  const errors = [...loaded.errors];
  const status = base ? 'assessed' : loaded.errors.length > 0 ? 'invalid' : 'not-assessed';
  if (!base || !isPlainObject(candidate?.areas)) return { errors, status };
  for (const area of Object.keys(base.areas)) {
    const prior = base.areas[area];
    const next = candidate.areas[area];
    if (!isPlainObject(next)) {
      errors.push(`area family identity ${area} may not be removed or renamed; a future versioned migration must preserve its floor`);
      continue;
    }
    if (validFloor(prior?.refResolutionFloor) && validFloor(next.refResolutionFloor) &&
      ratioBelowFloor(next.refResolutionFloor.enforced, next.refResolutionFloor.total, prior.refResolutionFloor)) {
      // A floor may fall ONLY with a committed, reviewed record naming this exact
      // decrease. Operator ruling 2026-08-08: a floor satisfied by MISFILED articles
      // was passing on false composition, and correcting a filing mistake must not be
      // punishable by the meter the mistake was inflating. The escape is deliberately
      // narrow — it authorises one named decrease, not a lower bar in general — and it
      // lives in the diff where a reviewer meets it.
      const permit = findRebaselinePermit(area, prior.refResolutionFloor, next.refResolutionFloor);
      if (permit) {
        console.log(
          `[standards-coverage] FLOOR RE-BASELINE PERMITTED for ${area}: ` +
          `${prior.refResolutionFloor.enforced}/${prior.refResolutionFloor.total} -> ` +
          `${next.refResolutionFloor.enforced}/${next.refResolutionFloor.total} — ${permit.authority}`,
        );
      } else {
        errors.push(`area floor for ${area} may not decrease from ${prior.refResolutionFloor.enforced}/${prior.refResolutionFloor.total} to ${next.refResolutionFloor.enforced}/${next.refResolutionFloor.total}`);
      }
    }
    if (canonicalTimestamp(prior?.lastAuditedAt) && canonicalTimestamp(next.lastAuditedAt) &&
      Date.parse(next.lastAuditedAt) < Date.parse(prior.lastAuditedAt)) {
      errors.push(`area audit time for ${area} may not move backward`);
    }
  }
  for (const area of Object.keys(candidate.areas)) {
    if (Object.hasOwn(base.areas, area)) continue;
    const floor = candidate.areas[area]?.refResolutionFloor;
    if (!validFloor(floor) || ratioBelowNumericFloor(floor.enforced, floor.total, FLOORS.enforcedRatio)) {
      errors.push(`new area ${area} must be admitted at or above aggregate floor ${FLOORS.enforcedRatio}`);
    }
  }
  return { errors, status };
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
    // Full-checkout CI fails this state below. A deliberately partial consumer can
    // opt out explicitly; absence must never look like successful assessment.
    return {
      generatedAt: new Date().toISOString(),
      registryFound: false,
      total: 0, byKind: { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 },
      continuityTotal: 0, enforcedRatio: null, currentPopulationEnforcedRatio: null,
      gaps: [], falseClaimCount: 0, falseClaims: [],
      danglingCount: 0, danglingByStandard: [],
      areas: {},
      areaAudit: {
        status: 'not-assessed',
        path: path.relative(ROOT, AREA_AUDITS_PATH),
        schemaVersion: AREA_AUDIT_SCHEMA_VERSION,
        currentCount: 0,
        totalAreas: 0,
        errors: REQUIRE_ROOT ? ['standards registry missing (use --allow-partial-registry only for a deliberate partial checkout)'] : [],
      },
      areaModelAudit: {
        status: 'not-assessed',
        path: path.relative(ROOT, AREA_MODEL_AUDIT_PATH),
        schemaVersion: AREA_MODEL_AUDIT_SCHEMA_VERSION,
        currentAreaSetSha256: null,
        auditedAreaSetSha256: null,
        auditCurrent: false,
        lastAuditedAt: null,
        auditRef: null,
        errors: [],
      },
      cadence: { reviewAfterDays: 90, dueAreas: [], areaModelReviewDue: false, blocking: false },
      enforcementScope: {
        recognizedHeadings: [...ENFORCEMENT_SECTION_HEADINGS],
        excludedProvenanceHeadings: [...EXCLUDED_PROVENANCE_SECTION_HEADINGS],
        excludedNarrativeHeadings: [...EXCLUDED_NARRATIVE_SECTION_HEADINGS],
        capturedSections: 0,
        unrecognizedSections: [],
      },
      directionGuard: {
        status: REQUIRE_ROOT ? 'not-proven' : 'not-assessed',
        errors: REQUIRE_ROOT ? ['candidate standards registry is unavailable'] : [],
        changes: [],
        trustRoot: { origin: 'protected-base', source: null, revision: null, candidateTreeIgnored: true },
        population: { protectedBase: 0, candidate: 0, continuity: 0, additions: [], removals: [], byFamily: {} },
      },
      measurement: {
        status: 'not-proven',
        errors: ['candidate rule population is empty or unreadable'],
        basis: { source: null, protectedMainSha: null, baseRevision: null, candidateTreeMayRaiseStrength: false },
        population: { protectedBase: 0, candidate: 0, continuity: 0, additions: [], removals: [], byFamily: {} },
        protectedFloor: { enforced: 0, total: 0, ratio: null, byKind: { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 }, byFamily: {} },
        unverifiedReferences: [],
        articles: [],
      },
    };
  }

  const directionGuard = (() => {
    if (ALLOW_PARTIAL_REGISTRY) {
      return {
        status: 'not-assessed', errors: [], changes: [],
        trustRoot: { origin: 'not-assessed', source: null, revision: null, candidateTreeIgnored: true },
        population: { protectedBase: 0, candidate: 0, continuity: 0, additions: [], removals: [], byFamily: {} },
      };
    }
    const base = resolveProtectedBaseRegistry({
      root: ROOT,
      explicitFile: Object.hasOwn(process.env, 'STANDARDS_DIRECTION_BASE_FILE')
        ? process.env.STANDARDS_DIRECTION_BASE_FILE
        : undefined,
      explicitRevision: process.env.STANDARDS_DIRECTION_BASE_REVISION,
    });
    if (base.errors.length > 0 || base.markdown === null) {
      return {
        status: 'not-proven', errors: base.errors, changes: [],
        trustRoot: { origin: 'protected-base', source: null, revision: null, candidateTreeIgnored: true },
        population: { protectedBase: 0, candidate: 0, continuity: 0, additions: [], removals: [], byFamily: {} },
      };
    }
    const approvals = readDirectionApprovalLedger(DIRECTION_APPROVALS_PATH);
    const candidateKey = readCandidateApproverKey(DIRECTION_APPROVER_KEY_PATH);
    const key = resolveProtectedApproverKey({
      root: ROOT,
      explicitFile: Object.hasOwn(process.env, 'STANDARDS_DIRECTION_BASE_APPROVER_KEY_FILE')
        ? process.env.STANDARDS_DIRECTION_BASE_APPROVER_KEY_FILE
        : undefined,
      explicitRevision: process.env.STANDARDS_DIRECTION_BASE_REVISION,
    });
    if (key.revision !== base.revision) {
      key.errors.push('protected-base registry and approver trust root resolved from different revisions');
    }
    // PATH B context (2026-08-22). The WORKFLOW fetches the reviews and writes
    // them here, so this script performs no network I/O and stays testable.
    // Absent, unreadable or malformed => UNAVAILABLE, which falls back to
    // requiring a signed ratification. It never becomes an approval.
    const review = (() => {
      const file = process.env.STANDARDS_DIRECTION_REVIEW_FILE;
      if (!file) return null;
      let raw;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        return { approved: false, approvedBy: null, reason: `review context unreadable (${err.message})` };
      }
      if (!isPlainObject(raw)) return { approved: false, approvedBy: null, reason: 'review context is not an object' };
      return evaluateOperatorReviewApproval({
        reviews: raw.reviews,
        ownerLogin: raw.ownerLogin,
        ownerType: raw.ownerType,
        headSha: raw.headSha,
        prAuthorLogin: raw.prAuthorLogin,
      });
    })();

    const assessed = evaluateStandardsDirection({
      baseMarkdown: base.markdown,
      candidateMarkdown: markdown,
      approvalLedger: approvals.value,
      approverPublicKeyPem: key.pem,
      candidateApproverPublicKeyPem: candidateKey.pem,
      baseRevision: base.revision ?? 'unknown-protected-base',
      reviewApproval: review,
    });
    assessed.errors.unshift(...approvals.errors, ...candidateKey.errors, ...key.errors);
    if (assessed.errors.length > 0) assessed.status = 'not-proven';
    assessed.trustRoot = {
      origin: 'protected-base',
      source: key.source,
      revision: key.revision,
      candidateTreeIgnored: true,
      candidateTreeDriftBlocked: true,
    };
    return assessed;
  })();

  const parsedCandidate = parseRegistry(canonicalText(markdown));
  const candidateMeasured = measuredArticles(canonicalText(markdown), parsedCandidate.articles);
  const { enforcementScope, areaSha256, areaSectionCounts } = parsedCandidate;
  const articles = candidateMeasured.articles;
  const routeTable = loadRouteTable();
  const extracted = articles.map((a) => ({ a, refs: a.refs }));
  const wanted = new Set();
  for (const { refs } of extracted) for (const m of refs.markers) wanted.add(m);
  const symbolIndex = buildSymbolIndex(wanted);

  let measurement;
  try {
    const fixtureRoot = ALLOW_PARTIAL_REGISTRY
      ? (process.env.STANDARDS_ENFORCEMENT_BASE_ROOT || ROOT)
      : null;
    const snapshot = resolveProtectedMeasurementSnapshot({ root: ROOT, fixtureRoot });
    const protectedMarkdown = snapshot.readFile('docs/STANDARDS-REGISTRY.md');
    if (protectedMarkdown === null) throw new Error('protected rule population is empty or unreadable');
    const parsedProtected = parseRegistry(canonicalText(protectedMarkdown));
    const protectedMeasured = measuredArticles(canonicalText(protectedMarkdown), parsedProtected.articles);
    const protectedRouteTable = routeTableFromSnapshot(snapshot);
    measurement = measureAnchoredEnforcement({
      root: ROOT,
      protectedArticles: protectedMeasured.articles,
      candidateArticles: articles,
      snapshot,
      protectedRouteExists: (ref) => protectedRouteTable.has(ref),
      candidateRouteExists: (ref) => routeTable.has(ref),
      protectedMarkerExists: (ref) => snapshot.hasMarker(ref),
      candidateMarkerExists: (ref) => symbolIndex.has(ref),
    });
    const protectedBaseline = measureAnchoredEnforcement({
      root: ROOT,
      protectedArticles: protectedMeasured.articles,
      candidateArticles: protectedMeasured.articles,
      snapshot,
      protectedRouteExists: (ref) => protectedRouteTable.has(ref),
      candidateRouteExists: (ref) => protectedRouteTable.has(ref),
      protectedMarkerExists: (ref) => snapshot.hasMarker(ref),
      candidateMarkerExists: (ref) => snapshot.hasMarker(ref),
      candidateReadFile: (ref) => snapshot.readFile(ref),
    });
    const summarize = (articleResults) => {
      const byKind = { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 };
      const byFamily = Object.create(null);
      for (const article of articleResults) {
        byKind[article.strength] += 1;
        if (!byFamily[article.family]) byFamily[article.family] = { enforced: 0, total: 0 };
        byFamily[article.family].total += 1;
        if (['ratchet', 'gate', 'lint'].includes(article.strength)) byFamily[article.family].enforced += 1;
      }
      const enforced = byKind.ratchet + byKind.gate + byKind.lint;
      return {
        enforced,
        total: articleResults.length,
        ratio: articleResults.length === 0 ? null : Number((enforced / articleResults.length).toFixed(4)),
        byKind,
        byFamily,
      };
    };
    measurement.protectedFloor = summarize(protectedBaseline.articles);
    measurement.errors.unshift(...protectedBaseline.errors.map((error) => `protected baseline: ${error}`));
    measurement.errors.unshift(
      ...protectedMeasured.errors.map((error) => `protected census: ${error}`),
      ...candidateMeasured.errors.map((error) => `candidate census: ${error}`),
    );
    if (measurement.errors.length > 0) measurement.status = 'not-proven';
  } catch (error) {
    measurement = {
      status: 'not-proven',
      errors: [error instanceof Error ? error.message : String(error)],
      basis: { source: null, protectedMainSha: null, baseRevision: null, candidateTreeMayRaiseStrength: false },
      population: { protectedBase: 0, candidate: articles.length, continuity: 0, additions: [], removals: [], byFamily: {} },
      protectedFloor: { enforced: 0, total: 0, ratio: null, byKind: { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 }, byFamily: {} },
      unverifiedReferences: [],
      articles: articles.map((article) => ({
        id: article.id,
        family: article.family,
        name: article.name,
        strength: 'documented-only',
        references: [],
      })),
    };
  }
  const measuredById = new Map(measurement.articles.map((article) => [article.id, article]));

  const byKind = { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 };
  const areaTallies = new Map();
  const gaps = [];
  const falseClaims = [];
  const danglingByStandard = [];
  let danglingCount = 0;

  for (const { a, refs } of extracted) {
    if (!areaTallies.has(a.family)) {
      areaTallies.set(a.family, {
        total: 0,
        enforced: 0,
        byKind: { ratchet: 0, gate: 0, lint: 0, 'spec-only': 0, 'documented-only': 0 },
        gaps: [],
      });
    }
    const area = areaTallies.get(a.family);
    const dangling = [];
    let resolvedReferenceCount = 0;
    for (const ref of refs.files) {
      const verified = fs.existsSync(path.join(ROOT, ref));
      if (!verified) dangling.push(ref);
      else resolvedReferenceCount += 1;
    }
    for (const ref of refs.routes) {
      const verified = routeTable.has(ref);
      if (!verified) dangling.push(ref);
      else resolvedReferenceCount += 1;
    }
    for (const ref of refs.markers) {
      const verified = symbolIndex.has(ref);
      if (!verified) dangling.push(ref);
      else resolvedReferenceCount += 1;
    }
    const kind = measuredById.get(a.id)?.strength ?? 'documented-only';
    byKind[kind] += 1;
    area.total += 1;
    area.byKind[kind] += 1;
    if (kind === 'ratchet' || kind === 'gate' || kind === 'lint') area.enforced += 1;
    if (kind === 'documented-only') {
      gaps.push(a.name);
      area.gaps.push(a.name);
      // False-claim detection asks whether named machinery resolves at all. That is
      // deliberately separate from the stronger measurement question of whether
      // its behavior has relevance + fail-direction proof.
      if (resolvedReferenceCount === 0) {
        const claims = detectEnforcementClaims(a);
        if (claims.length > 0) falseClaims.push({ standard: a.name, claims });
      }
    }
    if (dangling.length > 0) { danglingByStandard.push({ standard: a.name, refs: dangling.sort() }); danglingCount += dangling.length; }
  }

  const total = articles.length;
  const enforced = byKind.ratchet + byKind.gate + byKind.lint;
  const continuityTotal = measurement.population.continuity;
  const currentPopulationEnforcedRatio = total === 0 ? null : Number((enforced / total).toFixed(4));
  const enforcedRatio = continuityTotal === 0 ? null : Number((enforced / continuityTotal).toFixed(4));
  const areaNames = [...areaTallies.keys()].sort();
  const loadedAreaAudits = loadAreaAuditLedger(areaNames);
  const loadedAreaModelAudit = loadAreaModelAudit(areaNames);
  const baseComparison = compareLedgerToBase(loadedAreaAudits.ledger);
  const rootSelfWiring = !REQUIRE_ROOT && !areaTallies.has('The Root')
    ? { status: 'not-assessed', errors: [] }
    : validateRootSelfWiring();
  const areaAuditErrors = [
    ...loadedAreaAudits.errors,
    ...baseComparison.errors,
    ...rootSelfWiring.errors,
  ];
  if (REQUIRE_ROOT) {
    if (total === 0) areaAuditErrors.push('standards registry contains no structurally parsed standards');
    if (areaSectionCounts['The Root'] !== 1 || !areaTallies.has('The Root')) {
      areaAuditErrors.push('standards registry must contain exactly one Rule-bearing The Root family section');
    }
  }
  const areas = nullObject();
  let currentAreaAudits = 0;
  for (const areaName of areaNames) {
    const tally = areaTallies.get(areaName);
    const audit = isPlainObject(loadedAreaAudits.ledger?.areas?.[areaName])
      ? loadedAreaAudits.ledger.areas[areaName]
      : null;
    const areaContinuityTotal = measurement.population.byFamily?.[areaName]?.continuity ?? tally.total;
    const currentPopulationRatio = tally.total === 0 ? null : Number((tally.enforced / tally.total).toFixed(4));
    const ratio = areaContinuityTotal === 0 ? null : Number((tally.enforced / areaContinuityTotal).toFixed(4));
    const auditCurrent = typeof audit?.areaSha256 === 'string' && audit.areaSha256 === areaSha256[areaName];
    if (audit && !auditCurrent) {
      areaAuditErrors.push(
        `area audit stale for ${areaName}: audited ${String(audit.areaSha256).slice(0, 12) || 'none'}, current ${areaSha256[areaName].slice(0, 12)}`,
      );
    }
    if (auditCurrent) currentAreaAudits += 1;
    areas[areaName] = {
      total: tally.total,
      continuityTotal: areaContinuityTotal,
      enforced: tally.enforced,
      byKind: tally.byKind,
      refResolutionRatio: ratio,
      currentPopulationRefResolutionRatio: currentPopulationRatio,
      gaps: tally.gaps,
      currentAreaSha256: areaSha256[areaName],
      lastAuditedAt: typeof audit?.lastAuditedAt === 'string' ? audit.lastAuditedAt : null,
      auditRef: typeof audit?.auditRef === 'string' ? audit.auditRef : null,
      auditedAreaSha256: typeof audit?.areaSha256 === 'string' ? audit.areaSha256 : null,
      auditCurrent,
      refResolutionFloor: validFloor(audit?.refResolutionFloor) ? audit.refResolutionFloor : null,
      refResolutionRatioFloor: floorRatio(audit?.refResolutionFloor),
    };
  }
  const reviewAfterDays = 90;
  const nowMs = Date.now();
  const dueAreas = Object.entries(areas)
    .filter(([, measurement]) => {
      const audited = Date.parse(measurement.lastAuditedAt ?? '');
      return !Number.isFinite(audited) || nowMs - audited >= reviewAfterDays * 86_400_000;
    })
    .map(([area]) => area);
  const modelLastAuditedMs = Date.parse(loadedAreaModelAudit.record?.lastAuditedAt ?? '');
  const areaModelReviewDue = !Number.isFinite(modelLastAuditedMs) ||
    nowMs - modelLastAuditedMs >= reviewAfterDays * 86_400_000;
  const modelRecord = loadedAreaModelAudit.record;
  const currentAreaSetSha256 = loadedAreaModelAudit.currentAreaSetSha256 ?? areaSetSha256(areaNames);
  const modelAuditCurrent = loadedAreaModelAudit.errors.length === 0 &&
    modelRecord?.areaSetSha256 === currentAreaSetSha256;
  return {
    generatedAt: new Date().toISOString(),
    registryFound: true,
    rootSelfWiring,
    total, continuityTotal, byKind, enforcedRatio, currentPopulationEnforcedRatio,
    gaps, enforcementScope, areas, directionGuard, measurement,
    areaAudit: {
      status: areaAuditErrors.length === 0 ? 'current' : 'invalid',
      path: path.relative(ROOT, AREA_AUDITS_PATH),
      schemaVersion: AREA_AUDIT_SCHEMA_VERSION,
      currentCount: currentAreaAudits,
      totalAreas: areaNames.length,
      protectedBaseStatus: baseComparison.status,
      errors: areaAuditErrors,
    },
    areaModelAudit: {
      status: loadedAreaModelAudit.errors.length === 0 ? 'current' : 'invalid',
      path: path.relative(ROOT, AREA_MODEL_AUDIT_PATH),
      schemaVersion: AREA_MODEL_AUDIT_SCHEMA_VERSION,
      currentAreaSetSha256,
      auditedAreaSetSha256: typeof modelRecord?.areaSetSha256 === 'string' ? modelRecord.areaSetSha256 : null,
      auditCurrent: modelAuditCurrent,
      lastAuditedAt: typeof modelRecord?.lastAuditedAt === 'string' ? modelRecord.lastAuditedAt : null,
      auditRef: typeof modelRecord?.auditRef === 'string' ? modelRecord.auditRef : null,
      errors: loadedAreaModelAudit.errors,
    },
    cadence: { reviewAfterDays, dueAreas, areaModelReviewDue, blocking: false },
    falseClaimCount: falseClaims.length, falseClaims,
    danglingCount, danglingByStandard,
  };
}

function readAreaAuditLedgerForRecord() {
  if (!fs.existsSync(AREA_AUDITS_PATH)) return { schemaVersion: AREA_AUDIT_SCHEMA_VERSION, areas: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(AREA_AUDITS_PATH, 'utf-8'));
  } catch (error) {
    throw new Error(`refusing to overwrite an unreadable area audit ledger: ${error instanceof Error ? error.message : String(error)}`);
  }
  const existingAreas = isPlainObject(parsed?.areas) ? Object.keys(parsed.areas) : [];
  const validation = loadAreaAuditLedger(existingAreas);
  if (validation.errors.length > 0) {
    throw new Error(`refusing to overwrite an invalid area audit ledger: ${validation.errors.join('; ')}`);
  }
  return parsed;
}

function recordAreaAudit(report, selection, auditRef) {
  if (!report.registryFound) throw new Error('cannot record an area audit because the standards registry is absent');
  if (!selection) throw new Error('--record-area-audit requires a family name or all');
  const auditEvidence = readAuditEvidence(auditRef);
  if (auditEvidence.errors.length > 0) throw new Error(`--audit-ref ${auditEvidence.errors.join('; ')}`);
  const currentAreas = Object.keys(report.areas).sort();
  const unknownEvidenceAreas = Object.keys(auditEvidence.evidence.areas)
    .filter((area) => !currentAreas.includes(area));
  if (unknownEvidenceAreas.length > 0) {
    throw new Error(`--audit-ref attests unknown families: ${unknownEvidenceAreas.join(', ')}`);
  }
  const selected = selection === 'all' ? currentAreas : [selection];
  for (const area of selected) {
    if (!currentAreas.includes(area)) {
      throw new Error(`unknown standards family "${area}" (expected one of: ${currentAreas.join(', ')})`);
    }
  }

  const existing = readAreaAuditLedgerForRecord();
  const existingNames = Object.keys(existing.areas).sort();
  const removed = existingNames.filter((area) => !currentAreas.includes(area));
  const added = currentAreas.filter((area) => !existingNames.includes(area));
  if (removed.length > 0) {
    throw new Error(
      `refusing family identity change during record mode (ledger: ${existingNames.join(', ')}; registry: ${currentAreas.join(', ')}); ` +
      'rename/remove requires a reviewed schema migration that preserves prior floors',
    );
  }
  if (added.length > 0) {
    if (!ADMIT_NEW_AREAS) {
      throw new Error(
        `new families require --admit-new-areas (added: ${added.join(', ')})`,
      );
    }
    if (selection !== 'all') {
      throw new Error('--admit-new-areas requires --record-area-audit=all so the prospective ledger closes over every family');
    }
    for (const area of added) {
      const measurement = report.areas[area];
      if (ratioBelowNumericFloor(measurement.enforced, measurement.total, FLOORS.enforcedRatio)) {
        throw new Error(`new area ${area} cannot be admitted below aggregate floor ${FLOORS.enforcedRatio}`);
      }
    }
  }
  const nextAreas = nullObject();
  for (const area of Object.keys(existing.areas)) nextAreas[area] = existing.areas[area];
  const lastAuditedAt = auditEvidence.evidence.reviewedAt;
  const auditDate = new Date(lastAuditedAt);
  if (auditDate.getTime() > Date.now() + 5 * 60_000) {
    throw new Error('lastAuditedAt may not be more than five minutes in the future');
  }

  for (const area of selected) {
    const measurement = report.areas[area];
    const evidenceArea = auditEvidence.evidence.areas?.[area];
    if (!isPlainObject(evidenceArea) || evidenceArea.areaSha256 !== measurement.currentAreaSha256 || evidenceArea.verdict !== 'accepted') {
      throw new Error(`--audit-ref does not accept current digest for family ${area}`);
    }
    const oldTimestamp = existing.areas?.[area]?.lastAuditedAt;
    if (canonicalTimestamp(oldTimestamp) && Date.parse(lastAuditedAt) < Date.parse(oldTimestamp)) {
      throw new Error(`lastAuditedAt for ${area} may not move backward`);
    }
    const measuredFloor = { enforced: measurement.enforced, total: measurement.continuityTotal ?? measurement.total };
    const oldFloor = existing.areas?.[area]?.refResolutionFloor;
    const rebaselining = typeof REBASELINE_REASON === 'string' && REBASELINE_REASON.trim().length > 0;
    const refResolutionFloor = !rebaselining
      && validFloor(oldFloor) && ratioBelowFloor(measuredFloor.enforced, measuredFloor.total, oldFloor)
      ? oldFloor
      : measuredFloor;
    if (rebaselining && validFloor(oldFloor) && ratioBelowFloor(measuredFloor.enforced, measuredFloor.total, oldFloor)) {
      console.log(
        `[standards-coverage] FLOOR RE-BASELINED for ${area}: ${oldFloor.enforced}/${oldFloor.total} -> ` +
        `${measuredFloor.enforced}/${measuredFloor.total} — reason: ${REBASELINE_REASON}`,
      );
    }
    nextAreas[area] = {
      lastAuditedAt,
      auditRef,
      auditSha256: auditEvidence.sha256,
      areaSha256: measurement.currentAreaSha256,
      refResolutionFloor,
    };
  }

  if (JSON.stringify(Object.keys(nextAreas).sort()) !== JSON.stringify(currentAreas)) {
    throw new Error('refusing to write an area ledger that does not close over the current family set');
  }

  const next = { schemaVersion: AREA_AUDIT_SCHEMA_VERSION, areas: nextAreas };
  const tmp = `${AREA_AUDITS_PATH}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(path.dirname(AREA_AUDITS_PATH), { recursive: true });
  // The random, exclusive temp plus same-directory rename makes a successful
  // write atomic. If rename itself fails, leave the uniquely-named temp as
  // evidence rather than invoking a direct destructive primitive in this
  // dependency-free prebuild script.
  fs.writeFileSync(tmp, serializeAreaAuditLedger(next), { flag: 'wx' });
  fs.renameSync(tmp, AREA_AUDITS_PATH);
}

function readAreaModelAuditForRecord() {
  if (!fs.existsSync(AREA_MODEL_AUDIT_PATH)) return null;
  let raw;
  let record;
  try {
    raw = fs.readFileSync(AREA_MODEL_AUDIT_PATH, 'utf-8');
    record = JSON.parse(raw);
  } catch (error) {
    throw new Error(`refusing to overwrite an unreadable area model audit record: ${error instanceof Error ? error.message : String(error)}`);
  }
  const keys = isPlainObject(record) ? Object.keys(record).sort() : [];
  const expectedKeys = ['areaSetSha256', 'auditRef', 'auditSha256', 'lastAuditedAt', 'schemaVersion'];
  if (!isPlainObject(record) || record.schemaVersion !== AREA_MODEL_AUDIT_SCHEMA_VERSION ||
    JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
    !canonicalTimestamp(record.lastAuditedAt) ||
    typeof record.auditRef !== 'string' ||
    typeof record.auditSha256 !== 'string' || !SHA256_RE.test(record.auditSha256) ||
    typeof record.areaSetSha256 !== 'string' || !SHA256_RE.test(record.areaSetSha256) ||
    canonicalText(raw) !== serializeAreaModelAuditRecord(record)) {
    throw new Error('refusing to overwrite an invalid area model audit record');
  }
  return record;
}

function recordAreaModelAudit(report, auditRef) {
  if (!report.registryFound) throw new Error('cannot record an area model audit because the standards registry is absent');
  const currentAreas = Object.keys(report.areas).sort();
  const evidence = readAreaModelEvidence(auditRef, currentAreas);
  if (evidence.errors.length > 0) {
    throw new Error(`--audit-ref areaModelReview ${evidence.errors.join('; ')}`);
  }
  const prior = readAreaModelAuditForRecord();
  const lastAuditedAt = evidence.evidence.reviewedAt;
  if (Date.parse(lastAuditedAt) > Date.now() + 5 * 60_000) {
    throw new Error('area model lastAuditedAt may not be more than five minutes in the future');
  }
  if (prior && Date.parse(lastAuditedAt) < Date.parse(prior.lastAuditedAt)) {
    throw new Error('area model lastAuditedAt may not move backward');
  }
  const next = {
    schemaVersion: AREA_MODEL_AUDIT_SCHEMA_VERSION,
    lastAuditedAt,
    auditRef,
    auditSha256: evidence.sha256,
    areaSetSha256: areaSetSha256(currentAreas),
  };
  const tmp = `${AREA_MODEL_AUDIT_PATH}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(path.dirname(AREA_MODEL_AUDIT_PATH), { recursive: true });
  fs.writeFileSync(tmp, serializeAreaModelAuditRecord(next), { flag: 'wx' });
  fs.renameSync(tmp, AREA_MODEL_AUDIT_PATH);
}

function main() {
  let report = compute();
  if (RECORD_AREA_ARG !== undefined) {
    try {
      recordAreaAudit(report, RECORD_AREA, AUDIT_REF);
      report = compute();
    } catch (error) {
      process.stderr.write(`❌ standards-coverage record failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }
  if (RECORD_AREA_MODEL) {
    try {
      recordAreaModelAudit(report, AUDIT_REF);
      report = compute();
    } catch (error) {
      process.stderr.write(`❌ standards-coverage area-model record failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }
  report.floors = {
    ...FLOORS,
    byArea: Object.fromEntries(
      Object.entries(report.areas).map(([area, measurement]) => [area, measurement.refResolutionFloor]),
    ),
  };
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
      `continuity-total=${report.continuityTotal ?? report.total} ` +
      `enforced-ratio=${report.enforcedRatio} (ratchet ${report.byKind.ratchet} / gate ${report.byKind.gate} / ` +
      `lint ${report.byKind.lint} / spec-only ${report.byKind['spec-only']} / gap ${report.byKind['documented-only']}) ` +
      `false-claims=${report.falseClaimCount} ` +
      `dangling=${report.danglingCount} ` +
      `unrecognized-sections=${report.enforcementScope.unrecognizedSections.length}`);
    console.error(`[standards-coverage] legacy-ref-resolution-floor=${FLOORS.enforcedRatio} ` +
      `explicit-headline-override=${Object.hasOwn(process.env, 'STANDARDS_ENFORCED_RATIO_FLOOR') ? FLOORS.enforcedRatio : 'none'} ` +
      `dangling<=${FLOORS.danglingCeiling} false-claims<=${FLOORS.falseClaimCeiling} ` +
      `unrecognized-sections<=${FLOORS.unrecognizedSectionCeiling}`);
    console.error(`[standards-coverage] measurement=${report.measurement.status} ` +
      `base=${report.measurement.basis.baseRevision ?? 'unavailable'} ` +
      `source=${report.measurement.basis.source ?? 'unavailable'} ` +
      `protected-population=${report.measurement.population.protectedBase} ` +
      `candidate-population=${report.measurement.population.candidate} ` +
      `unverified-references=${report.measurement.unverifiedReferences.length}`);
    console.error(`[standards-coverage] protected-strength-floor=${report.measurement.protectedFloor.enforced}/${report.measurement.protectedFloor.total} ` +
      `ratio=${report.measurement.protectedFloor.ratio} candidate-may-raise=false`);
    for (const error of report.measurement.errors) {
      console.error(`[standards-coverage] MEASUREMENT — ${error}`);
    }
    console.error(`[standards-coverage] direction-guard=${report.directionGuard.status} ` +
      `base=${report.directionGuard.baseRevision ?? 'not-assessed'} ` +
      `trust-root=${report.directionGuard.trustRoot?.origin ?? 'unknown'} ` +
      `candidate-pin-ignored-as-authority=${report.directionGuard.trustRoot?.candidateTreeIgnored === true} ` +
      `candidate-pin-drift-blocked=${report.directionGuard.trustRoot?.candidateTreeDriftBlocked === true}`);
    for (const [area, measurement] of Object.entries(report.areas)) {
      console.error(
        `[standards-coverage] area="${area}" total=${measurement.total} continuity-total=${measurement.continuityTotal ?? measurement.total} ` +
        `ref-resolution-ratio=${measurement.refResolutionRatio} ` +
        `floor=${measurement.refResolutionFloor ? `${measurement.refResolutionFloor.enforced}/${measurement.refResolutionFloor.total}` : 'missing'} ` +
        `last-audited=${measurement.lastAuditedAt ?? 'missing'} audit-ref=${measurement.auditRef ?? 'missing'} ` +
        `audit-current=${measurement.auditCurrent}`,
      );
    }
    for (const error of report.areaAudit.errors) {
      console.error(`[standards-coverage] AREA AUDIT — ${error}`);
    }
    for (const error of report.areaModelAudit.errors) {
      console.error(`[standards-coverage] AREA MODEL AUDIT — ${error}`);
    }
    for (const error of report.directionGuard.errors) {
      console.error(`[standards-coverage] DIRECTION GUARD — ${error}`);
    }
    for (const fc of report.falseClaims) {
      console.error(`[standards-coverage] FALSE CLAIM — "${fc.standard}" asserts running machinery (${fc.claims.map((c) => `"${c}"`).join(', ')}) but names no resolvable guard.`);
    }
  }

  if (CHECK) {
    const failures = [];
    const aggregateEnforced = report.byKind.ratchet + report.byKind.gate + report.byKind.lint;
    const continuityDenominator = report.continuityTotal;
    for (const error of report.measurement.errors) failures.push(`measurement: ${error}`);
    if (!Number.isInteger(continuityDenominator) || continuityDenominator <= 0 || report.enforcedRatio === null) {
      failures.push('measurement population is empty or unreadable (zero-of-zero is never clean)');
    }
    const protectedFloor = report.measurement.protectedFloor;
    if (protectedFloor.total > 0 && continuityDenominator > 0 &&
      aggregateEnforced * protectedFloor.total < protectedFloor.enforced * continuityDenominator) {
      failures.push(
        `proven-strength ratio ${aggregateEnforced}/${continuityDenominator} (${report.enforcedRatio}) < protected floor ` +
        `${protectedFloor.enforced}/${protectedFloor.total} (${protectedFloor.ratio})`,
      );
    }
    if (Object.hasOwn(process.env, 'STANDARDS_ENFORCED_RATIO_FLOOR') && continuityDenominator > 0 &&
      ratioBelowNumericFloor(aggregateEnforced, continuityDenominator, FLOORS.enforcedRatio)) {
      failures.push(`enforced ratio ${aggregateEnforced}/${continuityDenominator} (${report.enforcedRatio}) < explicit floor ${FLOORS.enforcedRatio}`);
    }
    for (const error of report.directionGuard.errors) failures.push(`direction guard: ${error}`);
    for (const error of report.areaAudit.errors) failures.push(error);
    for (const error of report.areaModelAudit.errors) failures.push(error);
    for (const [area, areaMeasurement] of Object.entries(report.areas)) {
      const areaContinuityDenominator = areaMeasurement.continuityTotal ?? areaMeasurement.total;
      const areaFloor = report.measurement.protectedFloor.byFamily[area];
      const belowProtected = areaFloor && areaFloor.total > 0 && areaContinuityDenominator > 0 &&
        areaMeasurement.enforced * areaFloor.total < areaFloor.enforced * areaContinuityDenominator;
      const belowFixtureLedger = ALLOW_PARTIAL_REGISTRY &&
        ratioBelowFloor(areaMeasurement.enforced, areaContinuityDenominator, areaMeasurement.refResolutionFloor);
      if (belowProtected || belowFixtureLedger) {
        if (belowProtected) {
          failures.push(
            `area "${area}" proven-strength ratio ${areaMeasurement.enforced}/${areaContinuityDenominator} < protected floor ` +
            `${areaFloor.enforced}/${areaFloor.total}`,
          );
        } else {
          failures.push(
            `area "${area}" ref-resolution ratio ${areaMeasurement.enforced}/${areaContinuityDenominator} < floor ` +
            `${areaMeasurement.refResolutionFloor.enforced}/${areaMeasurement.refResolutionFloor.total}`,
          );
        }
      }
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
      process.stderr.write('\nFix: build a guard for an unguarded standard, record the changed family audit without lowering its floor, record a converged area-model adequacy review, repair a dangling reference, classify each unknown article heading, or resolve a false claim whose prose asserts unnamed machinery.\n');
      process.exit(1);
    }
    if (!QUIET) console.error('✅ standards-coverage check passed.');
  }
}

main();
