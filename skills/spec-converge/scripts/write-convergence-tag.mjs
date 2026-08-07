#!/usr/bin/env node
/**
 * write-convergence-tag.mjs — stamp a spec's frontmatter with the convergence tag.
 *
 * Called by the /spec-converge skill at Phase 5 after a round produces zero
 * material findings. Writes review-convergence, review-iterations, and
 * review-report fields into the spec's YAML frontmatter (preserving any other
 * frontmatter fields the spec author set).
 *
 * Usage:
 *   node skills/spec-converge/scripts/write-convergence-tag.mjs \
 *     --spec docs/specs/<slug>.md \
 *     --iterations 3 \
 *     --report docs/specs/reports/<slug>-convergence.md \
 *     [--cross-model-review "<flag value>"] \
 *     [--cross-model-reason "<reason>"]
 *
 * The optional --cross-model-review flag records the external (non-Claude)
 * reviewer posture on the spec frontmatter (Step B of the tiered-dev process,
 * docs/specs/codex-crossreview-stepB-spec.md §2/§4). This is the FINAL
 * spec-level value the skill computes via aggregateRoundOutcomes() across all
 * convergence rounds (a single round's status is per-round; the spec gets one).
 * Valid values:
 *   - codex-cli:<model>                       (a supported reviewer ran in >=1 round)
 *   - codex-cli:<model> (degraded: <reason>)  (present but a given round's call failed)
 *   - degraded-all-rounds                     (present every round, ZERO succeeded —
 *                                              as loud as unavailable; spec converged
 *                                              with no real external opinion)
 *   - unavailable                             (no supported framework)
 *   - skipped-abbreviated                     (author chose the fast path)
 * This script does NOT enum-validate the value (it accepts any string and
 * quotes it safely) — the canonical accepted set lives in crossModelReviewer.ts
 * (CrossModelFlagStatus) and is documented here for the caller.
 * It is DISCLOSURE, not a gate — it does not change /instar-dev's
 * review-convergence + approved enforcement. Idempotent (re-run strips and
 * rewrites the field, like the review-* fields).
 *
 * Does NOT write `approved: true` — that tag is the user's structural
 * contribution. /spec-converge only ever writes the machine-verifiable
 * review-convergence chain.
 *
 * Exit codes:
 *   0 — tag written successfully
 *   1 — usage error, spec not found, or frontmatter malformed
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEli16Overview } from '../../../scripts/eli16-overview-check.mjs';
import { findMaturationPlanGaps, REQUIRED_FIELDS } from '../../../scripts/feature-maturation-plan-gate.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    spec: null,
    iterations: null,
    report: null,
    crossModelReview: null,
    crossModelReason: null,
    // Decision-Completeness counts (Autonomy Principle 2, Piece 2). Optional —
    // when provided, the spec earns `single-run-completable: true` + the counts.
    frontloadedDecisions: null,
    cheapTags: null,
    contestedCleared: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--spec') out.spec = args[++i];
    else if (a === '--iterations') out.iterations = parseInt(args[++i], 10);
    else if (a === '--report') out.report = args[++i];
    else if (a === '--cross-model-review') out.crossModelReview = args[++i];
    else if (a === '--cross-model-reason') out.crossModelReason = args[++i];
    else if (a === '--frontloaded-decisions') out.frontloadedDecisions = parseInt(args[++i], 10);
    else if (a === '--cheap-tags') out.cheapTags = parseInt(args[++i], 10);
    else if (a === '--contested-cleared') out.contestedCleared = parseInt(args[++i], 10);
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!out.spec || !out.report || !Number.isFinite(out.iterations)) {
    console.error(
      'Usage: write-convergence-tag.mjs --spec PATH --iterations N --report PATH ' +
        '[--cross-model-review VALUE] [--cross-model-reason REASON] ' +
        '[--frontloaded-decisions N --cheap-tags N --contested-cleared N]',
    );
    process.exit(1);
  }
  return out;
}

/**
 * Decision-Completeness convergence criterion 2 (Autonomy Principle 2):
 * a spec CANNOT converge while an unresolved user-decision remains in
 * `## Open questions`. Returns the list of unresolved entry lines (empty = ok).
 *
 * Resolution markers that do NOT count as unresolved:
 *   - a none-marker line: `*(none)*`, `(none)`, `None`, `None.`, `N/A`
 *   - blockquote commentary (`> …`) explaining the section
 *   - blank lines / horizontal rules
 * Anything else with content (e.g. a `- **Q1:** …` bullet or a paragraph posing
 * a question) is an unresolved entry.
 */
/**
 * Builds the H2 matcher for a named gate section.
 *
 * ONE builder, used by BOTH gate sections, deliberately: the numbered-heading
 * hole below existed because the two matchers were written separately and only
 * one of them ever got a heading-variance fix. A shared builder means the next
 * variance fix cannot land on one gate and miss its sibling.
 *
 * Tolerated shapes:
 *   - `## Open questions`                    (canonical)
 *   - `## 9. Open questions`                 (numbered — the hole this closes)
 *   - `## 8b. Open questions` / `## 3) …`    (lettered / paren'd)
 *   - `## 1.2 Open questions`                (dotted)
 *   - `## Open questions (round 2)`          (suffix variant — already worked)
 *
 * Why this was load-bearing: `findOpenQuestions` returns `[]` when the heading
 * does not match, and `[]` means "nothing parked on the user". So a NUMBERED
 * heading made a LIVE, unresolved user-decision invisible to the gate the skill
 * calls structural ("cannot be skipped by prose"). Verified with a control
 * before the fix: numbered heading + a live question → `[]`; the identical
 * question under a plain heading → caught. Its sibling `findDecisionPointGaps`
 * failed CLOSED on the very same input — two defaults for one quantity.
 */
const SECTION_LABEL = String.raw`(?:\d+(?:\.\d+)*[a-z]?[.)]?\s+)?`;
function gateSectionHeadingRe(name) {
  return new RegExp(String.raw`^##\s+${SECTION_LABEL}${name}\b[^\n]*$`, 'im');
}

export function findOpenQuestions(specBody) {
  // \b…[^\n]*$ (not \s*$) so heading variants like "## Open questions (round 2)"
  // or "## Open Questions & Decisions" are still recognized — a variant heading
  // must not make the section invisible to the gate (reviewer finding, PR 2).
  // SECTION_LABEL additionally tolerates a numbered prefix (see the builder).
  const m = specBody.match(gateSectionHeadingRe('Open questions'));
  // A genuinely ABSENT section still means nothing is parked on the user; that
  // semantic is unchanged and separately tested. What changed is that a present
  // section can no longer hide behind its own section number.
  if (!m) return [];
  const start = m.index + m[0].length;
  const restAfter = specBody.slice(start);
  const nextHeading = restAfter.search(/^##\s+/m);
  const section = nextHeading === -1 ? restAfter : restAfter.slice(0, nextHeading);
  const NONE_RE = /^\s*[*_]*\(?\s*(none|n\/a)\s*\.?\)?[*_]*\s*$/i;
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith('>')) // blockquote commentary
    .filter((l) => !/^-{3,}$/.test(l)) // horizontal rule
    .filter((l) => !NONE_RE.test(l));
}

/**
 * Decision-point classification gate (Judgment Within Floors standard,
 * docs/specs/ownership-gated-spawn-and-judgment-within-floors.md §3.6 / FD12):
 * a spec cannot converge unless `## Decision points touched` exists and every
 * row/bullet in it carries a classification — `invariant` or
 * `judgment-candidate`. The section's PRESENCE + per-row token is the cheap
 * deterministic signal; the semantic correctness of each classification is the
 * lessons-aware reviewer's authority (Signal vs. Authority).
 *
 * Grandfathering: specs already past round 1 when this gate landed are exempt
 * via GRANDFATHERED_SLUGS — hardcoded in source, extended only by PR (the
 * emergency-allowlist precedent: code can't add to it at runtime).
 *
 * Returns { ok: true } | { ok: false, reason: 'missing-section' } |
 *         { ok: false, reason: 'unclassified', rows: string[] }.
 */
export const GRANDFATHERED_SLUGS = [
  // Specs mid-review (past round 1) at gate-land time. Extend only by PR.
];

export function findDecisionPointGaps(specBody, slug) {
  if (slug && GRANDFATHERED_SLUGS.includes(slug)) return { ok: true };
  // Same shared builder as findOpenQuestions — this gate already failed CLOSED
  // on a numbered heading (correct direction), but it was refusing specs whose
  // section was PRESENT and merely numbered, which is a false refusal rather
  // than a safety property. Both gates now recognise the same heading shapes.
  const m = specBody.match(gateSectionHeadingRe('Decision points touched'));
  if (!m) return { ok: false, reason: 'missing-section' };
  const start = m.index + m[0].length;
  const restAfter = specBody.slice(start);
  const nextHeading = restAfter.search(/^##\s+/m);
  const section = nextHeading === -1 ? restAfter : restAfter.slice(0, nextHeading);
  const NONE_RE = /^\s*[*_]*\(?\s*(none|n\/a)\s*\.?\)?[*_]*\s*$/i;
  const CLASSIFIED_RE = /\binvariant\b|\bjudgment-candidate\b/i;
  const lines = section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !l.startsWith('>')) // blockquote commentary
    .filter((l) => !/^-{3,}$/.test(l)) // horizontal rule
    // table header + separator rows carry no classification by design
    .filter((l) => !/^\|[\s|:-]*$/.test(l))
    .filter((l) => !/^\|\s*Decision\b/i.test(l));
  if (lines.length === 0) return { ok: false, reason: 'missing-section' };
  if (lines.length === 1 && NONE_RE.test(lines[0])) return { ok: true };
  const unclassified = lines.filter((l) => !NONE_RE.test(l)).filter((l) => !CLASSIFIED_RE.test(l));
  if (unclassified.length > 0) return { ok: false, reason: 'unclassified', rows: unclassified };
  return { ok: true };
}

// ─── main (guarded so the module is importable for tests) ────────────────
// fileURLToPath (not URL.pathname) so %-encoded paths (spaces) compare correctly,
// and realpathSync so a symlinked invocation still matches — a mismatch here
// would otherwise silently exit 0 having done NOTHING (fail-loud lesson).
const IS_MAIN = (() => {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(path.resolve(process.argv[1])) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    // @silent-fallback-ok — an unresolvable argv path simply isn't this module.
    return false;
  }
})();
if (IS_MAIN) {
  main();
}

function main() {
const {
  spec: specArg,
  iterations,
  report: reportArg,
  crossModelReview,
  crossModelReason,
  frontloadedDecisions,
  cheapTags,
  contestedCleared,
} = parseArgs();

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const specPath = path.resolve(ROOT, specArg);
const reportPath = path.resolve(ROOT, reportArg);

if (!fs.existsSync(specPath)) {
  console.error(`Spec not found: ${specArg}`);
  process.exit(1);
}
if (!fs.existsSync(reportPath)) {
  console.error(`Report not found: ${reportArg}`);
  process.exit(1);
}

const content = fs.readFileSync(specPath, 'utf-8');

// ─── ELI16 overview check ────────────────────────────────────────────────
// Convergence cannot be stamped onto a spec without a plain-English overview.
const _fmHeadMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
const _eli16Result = checkEli16Overview(specPath, _fmHeadMatch ? _fmHeadMatch[1] : '');
if (!_eli16Result.ok) {
  if (_eli16Result.reason === 'missing') {
    console.error(
      `Spec ${specArg} has no ELI16 overview.\n` +
      `Convergence cannot be stamped without a plain-English companion at:\n` +
      `  • Sibling path: ${path.relative(ROOT, _eli16Result.siblingPath)}\n` +
      `  • OR declared via spec frontmatter: eli16-overview: <relative-path>\n` +
      `See skills/instar-dev/templates/eli16-overview.md for the expected shape.`,
    );
  } else if (_eli16Result.reason === 'declared-not-found') {
    console.error(
      `Spec ${specArg} declares an ELI16 overview at ${path.relative(ROOT, _eli16Result.declaredPath)},\n` +
      `but that file does not exist.`,
    );
  } else if (_eli16Result.reason === 'too-short') {
    console.error(
      `Spec ${specArg}'s ELI16 overview at ${path.relative(ROOT, _eli16Result.declaredPath)} is too short ` +
      `(${_eli16Result.charCount} chars, need ${_eli16Result.minChars}).\n` +
      `A stub isn't an overview. See skills/instar-dev/templates/eli16-overview.md.`,
    );
  }
  process.exit(1);
}

// ─── Open-questions gate (Decision-Completeness, Autonomy Principle 2) ────
// Convergence criterion 2: a spec CANNOT converge while an unresolved
// user-decision remains in `## Open questions`. Structural — prose can't skip it.
const openQuestions = findOpenQuestions(content);
if (openQuestions.length > 0) {
  console.error(
    `Spec ${specArg} still has ${openQuestions.length} unresolved entr${openQuestions.length === 1 ? 'y' : 'ies'} in ## Open questions:\n` +
      openQuestions.map((q) => `  • ${q.slice(0, 120)}`).join('\n') +
      `\n\nA spec cannot converge while a user-decision is still open (Autonomy Principle 2).\n` +
      `Resolve each into ## Frontloaded Decisions (or a contested-and-surviving\n` +
      `cheap-to-change-after tag), leave the section reading "*(none)*", then re-run.`,
  );
  process.exit(1);
}

// ─── Decision-point classification gate (Judgment Within Floors, FD12) ────
// Convergence cannot be stamped while `## Decision points touched` is missing
// or carries an unclassified row. Structural — prose can't skip it.
const specSlug = path.basename(specPath, '.md');
const dpGate = findDecisionPointGaps(content, specSlug);
if (!dpGate.ok) {
  if (dpGate.reason === 'missing-section') {
    console.error(
      `Spec ${specArg} has no \`## Decision points touched\` section (or it is empty).\n` +
        `Per the Judgment Within Floors standard, every spec must classify each decision\n` +
        `point it touches as \`invariant\` (with justification) or \`judgment-candidate\`\n` +
        `(floor + arbiter declared, or an argued exemption). A spec with no decision-point\n` +
        `surface satisfies this with a section reading "*(none)*". Then re-run.`,
    );
  } else {
    console.error(
      `Spec ${specArg} has ${dpGate.rows.length} unclassified row(s) in ## Decision points touched:\n` +
        dpGate.rows.map((r) => `  • ${r.slice(0, 120)}`).join('\n') +
        `\n\nEach row must carry \`invariant\` or \`judgment-candidate\` (Judgment Within Floors).\n` +
        `Classify each, then re-run.`,
    );
  }
  process.exit(1);
}

// Feature Maturation Discipline v2: REFUSES. Promoted from warn-only by operator
// ruling 2026-08-07 (Maturation Path amendment clause (a)).
//
// v1 shipped as SIGNAL deliberately, so the corpus of real specs could be reviewed
// before promotion. That review is what promoted it: a warn that never blocks is
// advice, and advice is exactly what "ships dark, matures never" already ignores.
// The standard's own words are "'ships dark' is a starting state, never a finished
// one" — a check that merely mentions the missing plan cannot hold that line.
//
// The refusal is STRUCTURAL, not semantic: it fires only on a missing, duplicated,
// or field-incomplete `## Maturation plan` section. Whether a plan is any GOOD
// remains spec-converge's lessons-aware reviewer's judgment — this refuses the
// absence of a declaration, never the adequacy of one.
const maturationGate = findMaturationPlanGaps(content);
if (!maturationGate.ok) {
  const details = [
    maturationGate.reason,
    maturationGate.missing?.length ? `missing=${maturationGate.missing.join(',')}` : '',
    maturationGate.duplicates?.length ? `duplicates=${maturationGate.duplicates.join(',')}` : '',
  ].filter(Boolean).join(' ');
  console.error(
    `MATURATION_PLAN_REFUSED ${specArg}: ${details}\n\n` +
    `A spec cannot converge without a complete \`## Maturation plan\`. Add the section with ` +
    `every required field (${REQUIRED_FIELDS.join(', ')}), each declared exactly once, then re-run.\n` +
    `A feature with no declared path to maturity ships dark forever — which is incoherence on the ` +
    `maturation axis, not caution.`,
  );
  process.exit(1);
}

// Parse YAML frontmatter manually (no dependency).
// Expect: /^---\n<body>\n---\n<rest>/
const FM_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
const match = content.match(FM_RE);
if (!match) {
  console.error(
    `Spec ${specArg} has no YAML frontmatter block at the top. ` +
    'Add one before running /spec-converge.',
  );
  process.exit(1);
}
const [, fmBody, rest] = match;

// Strip any existing managed lines (review-* chain + cross-model-review chain +
// the single-run-completable chain) so re-runs are idempotent — the field is
// rewritten, never duplicated.
const preservedLines = fmBody
  .split('\n')
  .filter(
    (l) =>
      !/^\s*review-convergence\s*:/.test(l) &&
      !/^\s*review-iterations\s*:/.test(l) &&
      !/^\s*review-completed-at\s*:/.test(l) &&
      !/^\s*review-report\s*:/.test(l) &&
      !/^\s*cross-model-review\s*:/.test(l) &&
      !/^\s*cross-model-review-reason\s*:/.test(l) &&
      !/^\s*single-run-completable\s*:/.test(l) &&
      !/^\s*frontloaded-decisions\s*:/.test(l) &&
      !/^\s*cheap-to-change-tags\s*:/.test(l) &&
      !/^\s*contested-then-cleared\s*:/.test(l),
  )
  .join('\n')
  .trim();

const ts = new Date().toISOString();
const reportRel = path
  .relative(ROOT, reportPath)
  .replace(/\\/g, '/');

// Double-quote a YAML scalar value, escaping embedded quotes/backslashes so a
// flag like `codex-cli:gpt-5.5 (degraded: timeout)` (colon + parens) parses.
function yamlQuote(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const newFmLines = [
  preservedLines,
  `review-convergence: "${ts}"`,
  `review-iterations: ${iterations}`,
  `review-completed-at: "${ts}"`,
  `review-report: "${reportRel}"`,
];

// Cross-model review posture (Step B). Disclosure-only; additive.
if (crossModelReview) {
  newFmLines.push(`cross-model-review: ${yamlQuote(crossModelReview)}`);
  if (crossModelReason) {
    newFmLines.push(`cross-model-review-reason: ${yamlQuote(crossModelReason)}`);
  }
}

// Decision-Completeness evidence (Autonomy Principle 2). The tag is EARNED:
// it is only written here, after the open-questions gate above passed, and it
// carries the reviewer's final-round counts so a downstream reader sees WHAT
// was frontloaded, not just that a boolean is true.
if (
  Number.isFinite(frontloadedDecisions) ||
  Number.isFinite(cheapTags) ||
  Number.isFinite(contestedCleared)
) {
  newFmLines.push('single-run-completable: true');
  if (Number.isFinite(frontloadedDecisions)) {
    newFmLines.push(`frontloaded-decisions: ${frontloadedDecisions}`);
  }
  if (Number.isFinite(cheapTags)) newFmLines.push(`cheap-to-change-tags: ${cheapTags}`);
  if (Number.isFinite(contestedCleared)) {
    newFmLines.push(`contested-then-cleared: ${contestedCleared}`);
  }
}

const newFm = newFmLines.join('\n');

const newContent = `---\n${newFm}\n---\n${rest}`;
fs.writeFileSync(specPath, newContent, 'utf-8');

console.log(
  `Tagged ${specArg}:\n` +
    `  review-convergence=${ts}\n` +
    `  review-iterations=${iterations}\n` +
    `  review-report=${reportRel}`,
);
}
