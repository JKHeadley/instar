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
import { checkEli16Overview } from '../../../scripts/eli16-overview-check.mjs';

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    spec: null,
    iterations: null,
    report: null,
    crossModelReview: null,
    crossModelReason: null,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--spec') out.spec = args[++i];
    else if (a === '--iterations') out.iterations = parseInt(args[++i], 10);
    else if (a === '--report') out.report = args[++i];
    else if (a === '--cross-model-review') out.crossModelReview = args[++i];
    else if (a === '--cross-model-reason') out.crossModelReason = args[++i];
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!out.spec || !out.report || !Number.isFinite(out.iterations)) {
    console.error(
      'Usage: write-convergence-tag.mjs --spec PATH --iterations N --report PATH ' +
        '[--cross-model-review VALUE] [--cross-model-reason REASON]',
    );
    process.exit(1);
  }
  return out;
}

const {
  spec: specArg,
  iterations,
  report: reportArg,
  crossModelReview,
  crossModelReason,
} = parseArgs();

const ROOT = path.resolve(new URL('../../..', import.meta.url).pathname);
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

// Strip any existing managed lines (review-* chain + cross-model-review chain)
// so re-runs are idempotent — the field is rewritten, never duplicated.
const preservedLines = fmBody
  .split('\n')
  .filter(
    (l) =>
      !/^\s*review-convergence\s*:/.test(l) &&
      !/^\s*review-iterations\s*:/.test(l) &&
      !/^\s*review-completed-at\s*:/.test(l) &&
      !/^\s*review-report\s*:/.test(l) &&
      !/^\s*cross-model-review\s*:/.test(l) &&
      !/^\s*cross-model-review-reason\s*:/.test(l),
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

const newFm = newFmLines.join('\n');

const newContent = `---\n${newFm}\n---\n${rest}`;
fs.writeFileSync(specPath, newContent, 'utf-8');

console.log(
  `Tagged ${specArg}:\n` +
    `  review-convergence=${ts}\n` +
    `  review-iterations=${iterations}\n` +
    `  review-report=${reportRel}`,
);
