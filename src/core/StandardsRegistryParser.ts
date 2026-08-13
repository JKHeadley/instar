/**
 * StandardsRegistryParser — read the living constitution into structure.
 *
 * Parses `docs/STANDARDS-REGISTRY.md` into the set of standards articles the
 * conformance gate checks a spec against. Deterministic by design: the registry
 * has a stable, authored structure (no LLM needed to parse it).
 *
 * Because it parses an EVOLVING document, it is a state-detector per
 * `[[feedback_state_detection_robustness]]` and ships with `runRegistryCanary`
 * (asserts a sane article count + that known anchor articles parse with a
 * non-empty rule), run in tests + at load. Silent failure it guards:
 * registry-format drift → articles silently dropped → the gate checks against a
 * partial constitution and misses violations. Registered in
 * docs/specs/06-state-detector-registry.md.
 *
 * Spec: docs/specs/standards-conformance-gate.md §1.
 */

import fs from 'node:fs';
import { articleIds, parseRegistryStructure } from '../../scripts/standards-registry-article-core.mjs';

export interface StandardArticle {
  /** The standards family the article lives under (Root / Substrate / Building / Shipping / Interaction). */
  family: string;
  /** The article heading (e.g. "No Manual Work (user *or* agent)"). */
  name: string;
  /** Stable audit-provenance identifier, present on articles cited by stamped audits. */
  articleId?: string;
  /** The `**Rule.**` line — the normative statement. */
  rule: string;
  /** The `**In practice.**` line, when present. */
  inPractice: string;
  /**
   * The `**Applied through.**` line, when present — names the structural guard(s)
   * that enforce the article (a test, lint, gate marker, route, or spec). Additive
   * field (cartographer-conformance-audit spec #3); the enforcement-coverage audit
   * scans `inPractice` + `appliedThrough` for verifiable enforcement references.
   */
  appliedThrough?: string;
  /**
   * Complete blocks whose headings are explicitly allowed to name enforcement.
   * Unlike the legacy `appliedThrough` field, these retain continuation lines
   * (including bullet lists) and preserve which closed-enum heading admitted the
   * text. Provenance/narrative blocks never enter this collection.
   */
  enforcementSections?: StandardEnforcementSection[];
}

/** Headings whose content the enforcement auditor is allowed to inspect. */
export const ENFORCEMENT_SECTION_HEADINGS = [
  'Applied through',
  'Enforced by (structure, not willpower)',
  'Enforcement',
  'Full spec',
  'Full specs',
] as const;

export type EnforcementSectionHeading = typeof ENFORCEMENT_SECTION_HEADINGS[number];

export interface StandardEnforcementSection {
  heading: EnforcementSectionHeading;
  text: string;
}

/**
 * Sections that may contain paths but are evidence of origin, not live guards.
 * Keep this closed and explicit: widening enforcement extraction to arbitrary
 * bold headings would turn postmortems and design provenance into enforcement.
 */
export const EXCLUDED_PROVENANCE_SECTION_HEADINGS = [
  'Articulated during',
  'Derives from',
  'Earned from',
  'Grounded in',
  // Added 2026-08-13 by operator rulings 4b and 4c on the Window-12 decision package.
  //
  // An article whose provenance claimed an incident it never had was borrowing that
  // incident's authority — the quiet route by which a constitution drifts. The rulings
  // split the honest cases apart from `Earned from`: `Grounded in` and `Articulated
  // during` for stated values that were never incident-derived, `Ratified from operator
  // policy` for an operator-named rule, and `Provenance status` for an article whose
  // origin is genuinely lost and whose re-earning evidence is named in its place.
  //
  // PROVENANCE, never ENFORCEMENT — same reasoning as the fields above. These say where
  // an article CAME FROM; scanning them for guards would let an origin story read as a
  // live check.
  'Provenance status',
  'Ratified by',
  'Ratified from operator policy',
  'Source documents',
  'Traces to the goal',
] as const;

/**
 * Known explanatory article blocks that are neither core fields, provenance, nor
 * enforcement. Enumerating them keeps the real registry's unrecognized baseline
 * at zero: a newly-authored bold heading must be deliberately classified.
 */
export const EXCLUDED_NARRATIVE_SECTION_HEADINGS = [
  'Applied at the shipping layer',
  'Balanced by — Responsible Resource',
  'Benchmarks earn a real job',
  'Composition with No Silent Degradation',
  'Constrain the model\'s output with structure, never by matching its prose',
  'Distinct from Cross-Machine Coherence',
  'Distinct from Deferral = Deletion',
  'Distinct from the OnboardingGate',
  // Added 2026-08-07 by operator ruling on external-review finding 4. A
  // `documented-only` article must carry a COUNTDOWN — a deadline plus a tracked
  // id — because "documented-only MUST force a change in the near future."
  //
  // NARRATIVE, never ENFORCEMENT: a countdown says a guard is OWED, not that one
  // exists, so its refs must not be scanned. Filing it as enforcement would let a
  // promise-to-build flip an article to `enforced` — the exact over-claim the
  // ruling was raised against.
  'Documented-only until',
  // Added 2026-08-13 by operator ruling on decision-package item 2. An article that
  // depends on machinery (a gate, lint, sentinel, reviewer, model call, hook, job) must
  // state which way it fails when that machinery is ABSENT — 57 of the 82 machinery-
  // dependent articles were silent, and an unstated direction becomes whatever the
  // implementation happened to do, discovered mid-incident.
  //
  // NARRATIVE, never ENFORCEMENT: a failure direction says what SHOULD happen when a
  // guard is missing, which is the opposite of evidence that a guard exists. Filing it as
  // enforcement would let an article's account of its own absence read as a live check —
  // the same over-claim the `Documented-only until` classification above guards against.
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
] as const;

const CORE_SECTION_HEADINGS = ['Article ID', 'Rule', 'In practice'] as const;
const ENFORCEMENT_SECTION_HEADING_SET = new Set<string>(ENFORCEMENT_SECTION_HEADINGS);
const EXCLUDED_PROVENANCE_SECTION_HEADING_SET = new Set<string>(EXCLUDED_PROVENANCE_SECTION_HEADINGS);
const EXCLUDED_NARRATIVE_SECTION_HEADING_SET = new Set<string>(EXCLUDED_NARRATIVE_SECTION_HEADINGS);
const CORE_SECTION_HEADING_SET = new Set<string>(CORE_SECTION_HEADINGS);

/**
 * Standards families are detected STRUCTURALLY, not by name: a `##` section is a
 * standards family iff it contains at least one `###` heading carrying a
 * `**Rule.**` line. Other `##` sections (Why this exists, Genesis, Two layers,
 * How a standard joins, The Stakes) carry `###` subheadings with no Rule line
 * and are therefore excluded automatically.
 *
 * This replaced a hardcoded five-name allowlist (`The Root|The Substrate|
 * Building|Shipping|Interaction`). That allowlist was a silent-drop generator:
 * the registry grew a SIXTH family ("The Fractal — the framework that develops
 * itself") and every article under it was discarded with no signal anywhere —
 * found 2026-07-25 auditing this instrument (honest-denominators, instance 4).
 * A name allowlist can only ever be as current as the last person who edited it;
 * the structural rule needs no maintenance.
 */
/**
 * Family display name: the heading text up to the first dash separator, so
 * "The Substrate — the model-level truths …" stays "The Substrate" (the value
 * the `?family=` filter and the coverage report have always carried).
 */
function familyName(heading: string): string {
  return heading.split(/\s+[—–-]\s+/)[0].trim();
}

/** A bold article-field heading plus any text carried on the same line. */
const FIELD_HEADING_RE = /^\*\*(.+?)\.\*\*\s*(.*)$/;

/**
 * What the parse SAW, so a caller can tell "nothing was dropped" apart from
 * "nothing could be seen" — the honest-denominator rule applied to the parse
 * itself. `articleHeadings` is the denominator (`###` headings inside detected
 * families); `parsed` is the numerator; `droppedHeadings` names the difference.
 */
export interface RegistryParseDiagnostics {
  /** Families detected structurally (a `##` section with ≥1 Rule-bearing `###`). */
  families: string[];
  /** `###` headings inside detected families — the denominator. */
  articleHeadings: number;
  /** Headings that parsed into an article (i.e. carried a `**Rule.**`). */
  parsed: number;
  /** Headings inside a detected family that carried NO Rule line — silently lost before. */
  droppedHeadings: string[];
  /** `##` sections skipped because no `###` under them carried a Rule (Genesis, Two layers, …). */
  nonFamilySections: string[];
  /** The exact enforcement-section scope used by this parse. */
  enforcementScope: RegistryEnforcementParseScope;
}

/**
 * Makes the parser's trust boundary inspectable at the API surface. A reader can
 * distinguish "the article named no guard" from "the parser did not classify
 * this section heading" without widening extraction to provenance by accident.
 */
export interface RegistryEnforcementParseScope {
  /** Closed enum whose blocks may contribute enforcement references. */
  recognizedHeadings: string[];
  /** Closed enum deliberately excluded even when its prose contains path-shaped refs. */
  excludedProvenanceHeadings: string[];
  /** Closed enum of explanatory blocks deliberately excluded from enforcement. */
  excludedNarrativeHeadings: string[];
  /** Number of allowlisted blocks captured across parsed standards. */
  capturedSections: number;
  /** Article-qualified bold headings outside the core, allowlist, and provenance denylist. */
  unrecognizedSections: string[];
}

interface RawArticleBlock {
  name: string;
  article: StandardArticle;
  observedSections: string[];
}

interface RawSection { heading: string; blocks: RawArticleBlock[] }

/** Split the registry into `##` sections, each holding its `###` blocks. */
function readSections(markdown: string): RawSection[] {
  return parseRegistryStructure(markdown).map((rawSection) => {
    const section: RawSection = { heading: rawSection.heading, blocks: [] };
    for (const block of rawSection.blocks) {
      const ids = articleIds(block);
      const cur: StandardArticle = {
        family: familyName(rawSection.heading),
        name: block.name,
        ...(ids.length === 1 ? { articleId: ids[0] } : {}),
        rule: '',
        inPractice: '',
      };
      const observedSections: string[] = [];
      let field: { heading: string; lines: string[] } | null = null;
      const flushField = () => {
        if (!field) return;
        const heading = field.heading;
        const text = field.lines.join('\n').trim();
        observedSections.push(heading);
        if (heading === 'Rule') cur.rule = text;
        else if (heading === 'In practice') cur.inPractice = text;
        else if (ENFORCEMENT_SECTION_HEADING_SET.has(heading)) {
          const typedHeading = heading as EnforcementSectionHeading;
          (cur.enforcementSections ??= []).push({ heading: typedHeading, text });
          if (typedHeading === 'Applied through') cur.appliedThrough = text;
        }
        field = null;
      };
      for (const line of block.visibleLines) {
        if (line === null) continue;
        const fieldMatch = line.match(FIELD_HEADING_RE);
        if (fieldMatch) {
          flushField();
          field = { heading: fieldMatch[1].trim(), lines: [fieldMatch[2]] };
        } else if (field) {
          field.lines.push(line);
        }
      }
      flushField();
      section.blocks.push({ name: block.name, article: cur, observedSections });
    }
    return section;
  });
}

/**
 * Parse the registry markdown into standards articles PLUS what the parse saw.
 * Pure function — no I/O — so tests can feed fixture content and production
 * feeds the real file.
 */
export function parseStandardsRegistryDetailed(
  markdown: string,
): { articles: StandardArticle[]; diagnostics: RegistryParseDiagnostics } {
  const sections = readSections(markdown);
  const articles: StandardArticle[] = [];
  const diagnostics: RegistryParseDiagnostics = {
    families: [], articleHeadings: 0, parsed: 0, droppedHeadings: [], nonFamilySections: [],
    enforcementScope: {
      recognizedHeadings: [...ENFORCEMENT_SECTION_HEADINGS],
      excludedProvenanceHeadings: [...EXCLUDED_PROVENANCE_SECTION_HEADINGS],
      excludedNarrativeHeadings: [...EXCLUDED_NARRATIVE_SECTION_HEADINGS],
      capturedSections: 0,
      unrecognizedSections: [],
    },
  };

  for (const section of sections) {
    // Structural family test: at least one `###` block under this `##` carries a Rule.
    const isFamily = section.blocks.some((b) => b.article.rule);
    if (!isFamily) {
      if (section.heading) diagnostics.nonFamilySections.push(section.heading);
      continue;
    }
    diagnostics.families.push(familyName(section.heading));
    for (const b of section.blocks) {
      diagnostics.articleHeadings += 1;
      if (b.article.rule) {
        articles.push(b.article);
        diagnostics.parsed += 1;
        diagnostics.enforcementScope.capturedSections += b.article.enforcementSections?.length ?? 0;
        for (const heading of b.observedSections) {
          if (
            CORE_SECTION_HEADING_SET.has(heading) ||
            ENFORCEMENT_SECTION_HEADING_SET.has(heading) ||
            EXCLUDED_PROVENANCE_SECTION_HEADING_SET.has(heading) ||
            EXCLUDED_NARRATIVE_SECTION_HEADING_SET.has(heading)
          ) continue;
          diagnostics.enforcementScope.unrecognizedSections.push(
            `${familyName(section.heading)} › ${b.name} › ${heading}`,
          );
        }
      }
      else diagnostics.droppedHeadings.push(`${familyName(section.heading)} › ${b.name}`);
    }
  }
  return { articles, diagnostics };
}

/** Parse the registry markdown into standards articles. */
export function parseStandardsRegistry(markdown: string): StandardArticle[] {
  return parseStandardsRegistryDetailed(markdown).articles;
}

/** Resolve + read + parse the on-disk registry. Throws if the file is missing. */
export function loadStandardsRegistry(registryPath: string): StandardArticle[] {
  const content = fs.readFileSync(registryPath, 'utf-8');
  return parseStandardsRegistry(content);
}

/** Read + parse the on-disk registry WITH parse diagnostics. Throws if missing. */
export function loadStandardsRegistryDetailed(
  registryPath: string,
): { articles: StandardArticle[]; diagnostics: RegistryParseDiagnostics } {
  return parseStandardsRegistryDetailed(fs.readFileSync(registryPath, 'utf-8'));
}

// ── Canary (state-detector drift guard) ───────────────────────────────────

/**
 * Coarse backstop only — catches a TOTAL parse collapse, nothing subtler.
 *
 * This constant used to be the canary's whole strength, with a comment reading
 * "far below the real ~21". The registry grew to 81 articles and the constant
 * never moved, so by 2026-07-25 it would have passed happily while 65 of 81
 * articles vanished: a guard whose threshold never grew with the thing it
 * guards. The real check is now `droppedHeadings` — a COMPLETENESS comparison
 * against the count of article headings actually present, which needs no
 * maintenance as the registry grows. Keep this floor as a backstop for callers
 * that have no diagnostics to compare against; never treat it as sufficient.
 */
export const MIN_EXPECTED_ARTICLES = 15;

/**
 * Anchor articles that MUST parse (with a non-empty rule) for the gate to be
 * trustworthy. Matched by case-insensitive substring on the article name so
 * minor heading edits (parentheticals, em-dashes) don't break the canary.
 */
export const ANCHOR_ARTICLES: readonly string[] = [
  'Structure beats Willpower',
  'No Manual Work',
  'Signal vs. Authority',
  'Observability',
  'Never-Waste Feedback',
];

export interface RegistryCanaryResult {
  ok: boolean;
  articleCount: number;
  failures: string[];
  /**
   * The denominator the completeness check ran against — `###` headings found
   * inside detected families. `null` when the caller supplied no diagnostics,
   * which means completeness was NOT assessed (only the coarse floor ran).
   */
  articleHeadings: number | null;
  /** False when no diagnostics were supplied — the canary could not check completeness. */
  completenessAssessed: boolean;
}

/**
 * Run the registry parse canary over a parsed article set.
 *
 * Pass `diagnostics` (from `parseStandardsRegistryDetailed`) to get the real
 * check: every article heading present in a standards family must have parsed,
 * and every bold article field must have an explicitly classified role.
 * Without it only the coarse floor + anchor checks run, and the result says so
 * via `completenessAssessed: false` rather than implying a clean bill of health.
 */
export function runRegistryCanary(
  articles: StandardArticle[],
  diagnostics?: RegistryParseDiagnostics,
): RegistryCanaryResult {
  const failures: string[] = [];
  if (articles.length < MIN_EXPECTED_ARTICLES) {
    failures.push(`only ${articles.length} articles parsed (expected ≥ ${MIN_EXPECTED_ARTICLES}) — registry format may have drifted`);
  }
  if (diagnostics && diagnostics.droppedHeadings.length > 0) {
    failures.push(
      `${diagnostics.droppedHeadings.length} of ${diagnostics.articleHeadings} article headings parsed with no **Rule.** line and were dropped: ${diagnostics.droppedHeadings.join('; ')}`,
    );
  }
  if (diagnostics && diagnostics.enforcementScope.unrecognizedSections.length > 0) {
    failures.push(
      `${diagnostics.enforcementScope.unrecognizedSections.length} article sections have an unrecognized role and were excluded from enforcement extraction: ${diagnostics.enforcementScope.unrecognizedSections.join('; ')}`,
    );
  }
  for (const anchor of ANCHOR_ARTICLES) {
    const hit = articles.find(a => a.name.toLowerCase().includes(anchor.toLowerCase()));
    if (!hit) failures.push(`anchor article not found: "${anchor}"`);
    else if (!hit.rule) failures.push(`anchor article "${anchor}" parsed with an empty rule`);
  }
  return {
    ok: failures.length === 0,
    articleCount: articles.length,
    failures,
    articleHeadings: diagnostics ? diagnostics.articleHeadings : null,
    completenessAssessed: Boolean(diagnostics),
  };
}
