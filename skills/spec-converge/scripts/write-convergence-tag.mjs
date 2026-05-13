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
 *     --report docs/specs/reports/<slug>-convergence.md
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
  const out = { spec: null, iterations: null, report: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--spec') out.spec = args[++i];
    else if (a === '--iterations') out.iterations = parseInt(args[++i], 10);
    else if (a === '--report') out.report = args[++i];
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!out.spec || !out.report || !Number.isFinite(out.iterations)) {
    console.error(
      'Usage: write-convergence-tag.mjs --spec PATH --iterations N --report PATH',
    );
    process.exit(1);
  }
  return out;
}

const { spec: specArg, iterations, report: reportArg } = parseArgs();

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

// Strip any existing review-convergence / review-iterations / review-completed-at / review-report lines
const preservedLines = fmBody
  .split('\n')
  .filter(
    (l) =>
      !/^\s*review-convergence\s*:/.test(l) &&
      !/^\s*review-iterations\s*:/.test(l) &&
      !/^\s*review-completed-at\s*:/.test(l) &&
      !/^\s*review-report\s*:/.test(l),
  )
  .join('\n')
  .trim();

const ts = new Date().toISOString();
const reportRel = path
  .relative(ROOT, reportPath)
  .replace(/\\/g, '/');

const newFm = [
  preservedLines,
  `review-convergence: "${ts}"`,
  `review-iterations: ${iterations}`,
  `review-completed-at: "${ts}"`,
  `review-report: "${reportRel}"`,
].join('\n');

const newContent = `---\n${newFm}\n---\n${rest}`;
fs.writeFileSync(specPath, newContent, 'utf-8');

console.log(
  `Tagged ${specArg}:\n` +
    `  review-convergence=${ts}\n` +
    `  review-iterations=${iterations}\n` +
    `  review-report=${reportRel}`,
);
