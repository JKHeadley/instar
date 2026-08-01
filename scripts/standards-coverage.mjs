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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const JSON_ONLY = args.has('--json');
const QUIET = args.has('--quiet');
const RECORD_AREA_ARG = [...args].find((arg) => arg.startsWith('--record-area-audit='));
const RECORD_AREA = RECORD_AREA_ARG?.slice('--record-area-audit='.length) ?? null;
const AUDIT_REF_ARG = [...args].find((arg) => arg.startsWith('--audit-ref='));
const AUDIT_REF = AUDIT_REF_ARG?.slice('--audit-ref='.length) ?? null;
const ALLOW_PARTIAL_REGISTRY = args.has('--allow-partial-registry');
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
const CI_WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'ci.yml');
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

// ── Per-area audit facts + floors ────────────────────────────────────────────

const AREA_AUDIT_SCHEMA_VERSION = 2;
const AUDIT_EVIDENCE_SCHEMA_VERSION = 1;
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
  const expectedBaseRun = [
    'git cat-file -e "$BASE_SHA^{commit}"',
    'if git cat-file -e "$BASE_SHA:docs/standards-registry-area-audits.json"; then',
    '  git show "$BASE_SHA:docs/standards-registry-area-audits.json" > "$RUNNER_TEMP/standards-area-audits-base.json"',
    '  echo "required=1" >> "$GITHUB_OUTPUT"',
    'else',
    '  echo "required=0" >> "$GITHUB_OUTPUT"',
    'fi',
    '',
  ].join('\n');
  const expectedBaseSha = "${{ github.event.pull_request.base.sha || github.event.before || format('{0}^', github.sha) }}";
  const exactPrefix = [checkoutStep, setupStep, installStep, baseStep, checkStep];
  const ordered = exactPrefix.every((step, index) => step && steps[index] === step);
  const protectedBaseWired = ordered &&
    exactKeys(checkoutStep, ['uses', 'with']) && exactKeys(checkoutStep.with, ['fetch-depth']) && checkoutStep.with['fetch-depth'] === 0 &&
    exactKeys(setupStep, ['uses', 'with']) && exactKeys(setupStep.with, ['node-version']) && setupStep.with['node-version'] === 20 &&
    exactKeys(installStep, ['run']) &&
    exactKeys(baseStep, ['name', 'id', 'env', 'run']) &&
    baseStep.name === 'Resolve protected-base area ledger' &&
    exactKeys(baseStep.env, ['BASE_SHA']) && baseStep.env.BASE_SHA === expectedBaseSha &&
    baseStep.run === expectedBaseRun;
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
      errors.push(`area floor for ${area} may not decrease from ${prior.refResolutionFloor.enforced}/${prior.refResolutionFloor.total} to ${next.refResolutionFloor.enforced}/${next.refResolutionFloor.total}`);
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
      enforcedRatio: 1, gaps: [], falseClaimCount: 0, falseClaims: [],
      danglingCount: 0, danglingByStandard: [],
      areas: {},
      areaAudit: {
        status: 'not-assessed',
        path: path.relative(ROOT, AREA_AUDITS_PATH),
        schemaVersion: AREA_AUDIT_SCHEMA_VERSION,
        currentCount: 0,
        totalAreas: 0,
        errors: ALLOW_PARTIAL_REGISTRY ? [] : ['standards registry missing (use --allow-partial-registry only for a deliberate partial checkout)'],
      },
      enforcementScope: {
        recognizedHeadings: [...ENFORCEMENT_SECTION_HEADINGS],
        excludedProvenanceHeadings: [...EXCLUDED_PROVENANCE_SECTION_HEADINGS],
        excludedNarrativeHeadings: [...EXCLUDED_NARRATIVE_SECTION_HEADINGS],
        capturedSections: 0,
        unrecognizedSections: [],
      },
    };
  }

  const { articles, enforcementScope, areaSha256, areaSectionCounts } = parseRegistry(canonicalText(markdown));
  const routeTable = loadRouteTable();
  const extracted = articles.map((a) => ({ a, refs: extractRefs(a) }));
  const wanted = new Set();
  for (const { refs } of extracted) for (const m of refs.markers) wanted.add(m);
  const symbolIndex = buildSymbolIndex(wanted);

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
    area.total += 1;
    area.byKind[kind] += 1;
    if (kind === 'ratchet' || kind === 'gate' || kind === 'lint') area.enforced += 1;
    if (kind === 'documented-only') {
      gaps.push(a.name);
      area.gaps.push(a.name);
      // A gap that ASSERTS running machinery is a false claim, not an honest gap.
      const claims = detectEnforcementClaims(a);
      if (claims.length > 0) falseClaims.push({ standard: a.name, claims });
    }
    if (dangling.length > 0) { danglingByStandard.push({ standard: a.name, refs: dangling.sort() }); danglingCount += dangling.length; }
  }

  const total = articles.length;
  const enforced = byKind.ratchet + byKind.gate + byKind.lint;
  const enforcedRatio = total === 0 ? 1 : Number((enforced / total).toFixed(4));
  const areaNames = [...areaTallies.keys()].sort();
  const loadedAreaAudits = loadAreaAuditLedger(areaNames);
  const baseComparison = compareLedgerToBase(loadedAreaAudits.ledger);
  const rootSelfWiring = ALLOW_PARTIAL_REGISTRY
    ? { status: 'not-assessed', errors: [] }
    : validateRootSelfWiring();
  const areaAuditErrors = [
    ...loadedAreaAudits.errors,
    ...baseComparison.errors,
    ...rootSelfWiring.errors,
  ];
  if (!ALLOW_PARTIAL_REGISTRY) {
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
    const ratio = tally.total === 0 ? 1 : Number((tally.enforced / tally.total).toFixed(4));
    const auditCurrent = typeof audit?.areaSha256 === 'string' && audit.areaSha256 === areaSha256[areaName];
    if (audit && !auditCurrent) {
      areaAuditErrors.push(
        `area audit stale for ${areaName}: audited ${String(audit.areaSha256).slice(0, 12) || 'none'}, current ${areaSha256[areaName].slice(0, 12)}`,
      );
    }
    if (auditCurrent) currentAreaAudits += 1;
    areas[areaName] = {
      total: tally.total,
      enforced: tally.enforced,
      byKind: tally.byKind,
      refResolutionRatio: ratio,
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
  return {
    generatedAt: new Date().toISOString(),
    registryFound: true,
    rootSelfWiring,
    total, byKind, enforcedRatio, gaps, enforcementScope, areas,
    areaAudit: {
      status: areaAuditErrors.length === 0 ? 'current' : 'invalid',
      path: path.relative(ROOT, AREA_AUDITS_PATH),
      schemaVersion: AREA_AUDIT_SCHEMA_VERSION,
      currentCount: currentAreaAudits,
      totalAreas: areaNames.length,
      protectedBaseStatus: baseComparison.status,
      errors: areaAuditErrors,
    },
    cadence: { reviewAfterDays, dueAreas, blocking: false },
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
    const measuredFloor = { enforced: measurement.enforced, total: measurement.total };
    const oldFloor = existing.areas?.[area]?.refResolutionFloor;
    const refResolutionFloor = validFloor(oldFloor) && ratioBelowFloor(measuredFloor.enforced, measuredFloor.total, oldFloor)
      ? oldFloor
      : measuredFloor;
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
      `enforced-ratio=${report.enforcedRatio} (ratchet ${report.byKind.ratchet} / gate ${report.byKind.gate} / ` +
      `lint ${report.byKind.lint} / spec-only ${report.byKind['spec-only']} / gap ${report.byKind['documented-only']}) ` +
      `false-claims=${report.falseClaimCount} ` +
      `dangling=${report.danglingCount} ` +
      `unrecognized-sections=${report.enforcementScope.unrecognizedSections.length}`);
    console.error(`[standards-coverage] floors: enforced-ratio>=${FLOORS.enforcedRatio} dangling<=${FLOORS.danglingCeiling} false-claims<=${FLOORS.falseClaimCeiling} unrecognized-sections<=${FLOORS.unrecognizedSectionCeiling}`);
    for (const [area, measurement] of Object.entries(report.areas)) {
      console.error(
        `[standards-coverage] area="${area}" total=${measurement.total} ` +
        `ref-resolution-ratio=${measurement.refResolutionRatio} ` +
        `floor=${measurement.refResolutionFloor ? `${measurement.refResolutionFloor.enforced}/${measurement.refResolutionFloor.total}` : 'missing'} ` +
        `last-audited=${measurement.lastAuditedAt ?? 'missing'} audit-ref=${measurement.auditRef ?? 'missing'} ` +
        `audit-current=${measurement.auditCurrent}`,
      );
    }
    for (const error of report.areaAudit.errors) {
      console.error(`[standards-coverage] AREA AUDIT — ${error}`);
    }
    for (const fc of report.falseClaims) {
      console.error(`[standards-coverage] FALSE CLAIM — "${fc.standard}" asserts running machinery (${fc.claims.map((c) => `"${c}"`).join(', ')}) but names no resolvable guard.`);
    }
  }

  if (CHECK) {
    const failures = [];
    const aggregateEnforced = report.byKind.ratchet + report.byKind.gate + report.byKind.lint;
    if (report.total > 0 && ratioBelowNumericFloor(aggregateEnforced, report.total, FLOORS.enforcedRatio)) {
      failures.push(`enforced ratio ${aggregateEnforced}/${report.total} (${report.enforcedRatio}) < floor ${FLOORS.enforcedRatio}`);
    }
    for (const error of report.areaAudit.errors) failures.push(error);
    for (const [area, measurement] of Object.entries(report.areas)) {
      if (ratioBelowFloor(measurement.enforced, measurement.total, measurement.refResolutionFloor)) {
        failures.push(
          `area "${area}" ref-resolution ratio ${measurement.enforced}/${measurement.total} < floor ` +
          `${measurement.refResolutionFloor.enforced}/${measurement.refResolutionFloor.total}`,
        );
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
      process.stderr.write('\nFix: build a guard for an unguarded standard, record the changed family audit without lowering its floor, repair a dangling reference, classify each unknown article heading, or resolve a false claim whose prose asserts unnamed machinery.\n');
      process.exit(1);
    }
    if (!QUIET) console.error('✅ standards-coverage check passed.');
  }
}

main();
