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
 * The `##` families that contain standards ARTICLES. Other `##` sections (Why
 * this exists, Genesis, Two layers, How a standard joins, The Stakes) contain
 * `###` subheadings that are NOT articles and must be excluded.
 */
const STANDARDS_FAMILY_RE = /^##\s+(The Root|The Substrate|Building|Shipping|Interaction)\b/;
/** Any `##` heading ends the current family's article-collection scope. */
const ANY_H2_RE = /^##\s+/;
const ARTICLE_RE = /^###\s+(.+?)\s*$/;

/** Extract the text after a `**Label.**` marker on a line (or '' if absent). */
function fieldAfter(line: string, label: string): string | null {
  const m = line.match(new RegExp(`^\\*\\*${label}\\.\\*\\*\\s*(.*)$`));
  return m ? m[1].trim() : null;
}

/**
 * Parse the registry markdown into standards articles. Pure function — no I/O —
 * so tests can feed fixture content and production feeds the real file.
 */
export function parseStandardsRegistry(markdown: string): StandardArticle[] {
  const lines = markdown.split('\n');
  const articles: StandardArticle[] = [];

  let currentFamily: string | null = null;
  let cur: StandardArticle | null = null;

  const flush = () => {
    if (cur && cur.rule) articles.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const famMatch = line.match(STANDARDS_FAMILY_RE);
    if (famMatch) {
      flush();
      currentFamily = famMatch[1];
      continue;
    }
    // A non-standards H2 closes the current family scope (so e.g. "## Two layers"
    // stops us from collecting its ### subheadings as articles).
    if (ANY_H2_RE.test(line) && !famMatch) {
      flush();
      currentFamily = null;
      continue;
    }
    if (!currentFamily) continue;

    const artMatch = line.match(ARTICLE_RE);
    if (artMatch) {
      flush();
      cur = { family: currentFamily, name: artMatch[1].trim(), rule: '', inPractice: '' };
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
  return articles;
}

/** Resolve + read + parse the on-disk registry. Throws if the file is missing. */
export function loadStandardsRegistry(registryPath: string): StandardArticle[] {
  const content = fs.readFileSync(registryPath, 'utf-8');
  return parseStandardsRegistry(content);
}

// ── Canary (state-detector drift guard) ───────────────────────────────────

/** Minimum plausible article count — far below the real ~21, catches a parse collapse. */
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
}

/** Run the registry parse canary over a parsed article set. */
export function runRegistryCanary(articles: StandardArticle[]): RegistryCanaryResult {
  const failures: string[] = [];
  if (articles.length < MIN_EXPECTED_ARTICLES) {
    failures.push(`only ${articles.length} articles parsed (expected ≥ ${MIN_EXPECTED_ARTICLES}) — registry format may have drifted`);
  }
  for (const anchor of ANCHOR_ARTICLES) {
    const hit = articles.find(a => a.name.toLowerCase().includes(anchor.toLowerCase()));
    if (!hit) failures.push(`anchor article not found: "${anchor}"`);
    else if (!hit.rule) failures.push(`anchor article "${anchor}" parsed with an empty rule`);
  }
  return { ok: failures.length === 0, articleCount: articles.length, failures };
}
