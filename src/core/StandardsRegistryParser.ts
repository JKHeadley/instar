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

export interface StandardArticle {
  /** The standards family the article lives under (Root / Substrate / Building / Shipping / Interaction). */
  family: string;
  /** The article heading (e.g. "No Manual Work (user *or* agent)"). */
  name: string;
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
}

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
/** Any `##` heading opens a new section scope. */
const ANY_H2_RE = /^##\s+/;
const H2_NAME_RE = /^##\s+(.+?)\s*$/;
const ARTICLE_RE = /^###\s+(.+?)\s*$/;
/**
 * Family display name: the heading text up to the first dash separator, so
 * "The Substrate — the model-level truths …" stays "The Substrate" (the value
 * the `?family=` filter and the coverage report have always carried).
 */
function familyName(heading: string): string {
  return heading.split(/\s+[—–-]\s+/)[0].trim();
}

/** Extract the text after a `**Label.**` marker on a line (or '' if absent). */
function fieldAfter(line: string, label: string): string | null {
  const m = line.match(new RegExp(`^\\*\\*${label}\\.\\*\\*\\s*(.*)$`));
  return m ? m[1].trim() : null;
}

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
}

interface RawSection { heading: string; blocks: { name: string; article: StandardArticle }[] }

/** Split the registry into `##` sections, each holding its `###` blocks. */
function readSections(markdown: string): RawSection[] {
  const sections: RawSection[] = [];
  let section: RawSection | null = null;
  let cur: StandardArticle | null = null;
  let curName = '';

  const flush = () => {
    if (section && cur) section.blocks.push({ name: curName, article: cur });
    cur = null;
    curName = '';
  };

  for (const line of markdown.split('\n')) {
    if (ANY_H2_RE.test(line)) {
      flush();
      const h2 = line.match(H2_NAME_RE);
      section = { heading: h2 ? h2[1].trim() : '', blocks: [] };
      sections.push(section);
      continue;
    }
    if (!section) continue;

    const artMatch = line.match(ARTICLE_RE);
    if (artMatch) {
      flush();
      curName = artMatch[1].trim();
      cur = { family: familyName(section.heading), name: curName, rule: '', inPractice: '' };
      continue;
    }
    if (!cur) continue;

    const rule = fieldAfter(line, 'Rule');
    if (rule !== null) { cur.rule = rule; continue; }
    const inPractice = fieldAfter(line, 'In practice');
    if (inPractice !== null) { cur.inPractice = inPractice; continue; }
    // Additive (spec #3): capture the `**Applied through.**` line if present. Same
    // `fieldAfter` extraction as Rule/In practice; absent on articles without one.
    const appliedThrough = fieldAfter(line, 'Applied through');
    if (appliedThrough !== null) { cur.appliedThrough = appliedThrough; continue; }
  }
  flush();
  return sections;
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
      if (b.article.rule) { articles.push(b.article); diagnostics.parsed += 1; }
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
 * check: every article heading present in a standards family must have parsed.
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
