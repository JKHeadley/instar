#!/usr/bin/env node
/**
 * lint-no-duplicate-definitions.mjs — refuses a SECOND definition of a
 * constitutional fact, where "kept in agreement" would be a standing tax paid
 * by attention.
 *
 * Enforces the constitutional standard **"Remove What Demands Attention. Do Not
 * Supply More Attention."** (Standards Registry, The Substrate; a tree node
 * under *Distrust Temporary Success — A Recurrence Is a Root Cause*).
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — inside `docs/STANDARDS-REGISTRY.md`, no family heading, no
 *               article heading, and no `Article ID` value is defined twice.
 *   CERTIFIED — the constitution cannot acquire a second, drifting definition
 *               of a standard. Nothing wider.
 *
 * It does NOT certify that no fact anywhere in the repo is duplicated. Prose
 * restating a count in two paragraphs is invisible to it — and that is the exact
 * shape that cost five gate rounds. This check covers the STRUCTURED half, where
 * a duplicate is unambiguous; the prose half stays a review question.
 *
 * What input passes this check while failing the claim?
 *   1. Two articles with DIFFERENT titles defining the same rule (the B5→B6
 *      renumber that recreated the collision one number over is this shape).
 *   2. A count or claim restated in two paragraphs of one article.
 * Both are named rather than hidden. Neither is structurally detectable without
 * a semantic judgment this deterministic check does not make.
 *
 * ── Two scope decisions, recorded because the near-misses are the useful part ──
 *
 * (1) Plan-document node ids were in the first draft and were REMOVED after
 *     measurement. The plan legitimately carries BOTH an authoritative summary
 *     table and a detail table for the same node, so "one row per node id per
 *     document" would fire on correct structure. A rule that must be suppressed
 *     on the very artifact it was written for is not a rule.
 *
 * (2) The first draft SKIPPED blockquoted lines as "retained history." Measured
 *     against the real plan it found 3 node rows where the plan defines 17 — the
 *     authoritative table is blockquoted for emphasis. It reported clean over a
 *     population it had discarded: this standard's sibling defect (a passing
 *     condition narrower than its claim) committed inside the lint enforcing it.
 *     Caught only by asking tooth (D) against its own first run. Blockquotes are
 *     now unwrapped, not skipped.
 *
 * ── Earned from ────────────────────────────────────────────────────────────
 * Six adversarial passes over one plan document, 2026-08-05. Five returned
 * INCOHERENT and every one was the same failure — fixing one site and leaving
 * another: a duplicate node id `B5`; the repair recreating the identical
 * collision at `B6`; a factual claim corrected in three places and left standing
 * in two; a count reading 13 in the header and 14 in the body. Round six passed
 * only after three of the count's four copies were DELETED, leaving one source
 * and pointers. ~4 of the ~14 instances of the defect the plan was auditing were
 * committed in that document, about that defect, under maximum attention.
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-no-duplicate-definitions.mjs
 *   node scripts/lint-no-duplicate-definitions.mjs --json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');
const REGISTRY_REL = 'docs/STANDARDS-REGISTRY.md';

const FAMILY_RE = /^##\s+(.+?)\s*$/;
const ARTICLE_RE = /^###\s+(.+?)\s*$/;
const ARTICLE_ID_RE = /^\*\*Article ID\.\*\*\s*`([^`]+)`/;

/**
 * Strip fenced code blocks; UNWRAP blockquotes rather than skipping them (see
 * scope decision 2 above). Struck-through text (`~~…~~`) is retained history and
 * never matches a definition pattern, so superseded prose cannot masquerade as
 * a live definition.
 */
function definitionLines(markdown) {
  const out = [];
  let fence = null;
  markdown.split('\n').forEach((raw, i) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (fence === null && fenceMatch) { fence = fenceMatch[1]; return; }
    if (fence !== null) { if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(trimmed)) fence = null; return; }
    out.push({ line: line.replace(/^\s*(?:>\s?)+/, ''), lineNo: i + 1 });
  });
  return out;
}

const failures = [];
const abs = path.join(ROOT, REGISTRY_REL);

if (!fs.existsSync(abs)) {
  // Fail LOUD. A missing registry would otherwise make this check report clean
  // over an empty set — the false all-clear this standard family exists to refuse.
  console.error(`[no-duplicate-definitions] ${REGISTRY_REL} is missing — refusing to report clean over a document that is not there.`);
  process.exit(1);
}

const lines = definitionLines(fs.readFileSync(abs, 'utf-8'));
const kinds = [
  { label: 'family heading', re: FAMILY_RE, seen: new Map() },
  { label: 'article', re: ARTICLE_RE, seen: new Map() },
  { label: 'Article ID', re: ARTICLE_ID_RE, seen: new Map() },
];

for (const { line, lineNo } of lines) {
  for (const kind of kinds) {
    const m = line.match(kind.re);
    if (!m) continue;
    const key = m[1].trim();
    if (kind.seen.has(key)) {
      failures.push(
        `DUPLICATE DEFINITION ${REGISTRY_REL}:${lineNo} — ${kind.label} "${key}" is already defined at ` +
        `line ${kind.seen.get(key)}. Delete one and point at the other; a pointer cannot disagree.`,
      );
    } else {
      kind.seen.set(key, lineNo);
    }
  }
}

// A registry that parsed to nothing is a broken parser, not a clean registry.
const articleCount = kinds[1].seen.size;
if (articleCount === 0) {
  failures.push(`parsed ZERO articles from ${REGISTRY_REL} — the matcher is broken; refusing to report clean.`);
}

const report = {
  registry: REGISTRY_REL,
  families: kinds[0].seen.size,
  articles: articleCount,
  articleIds: kinds[2].seen.size,
  failures,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-no-duplicate-definitions: clean — ${report.families} family heading(s), ` +
    `${report.articles} article(s), ${report.articleIds} article ID(s), no duplicate definitions.`,
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-no-duplicate-definitions failed:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nWhy this exists: a structure that must be held in agreement by attention will drift, and the drift ' +
    'rate is a property of the structure, not of the person attending to it. The remedy is deletion, not ' +
    'more care. See docs/proposals/standard-proposal-remove-what-demands-attention.md\n',
  );
  process.exit(1);
}
