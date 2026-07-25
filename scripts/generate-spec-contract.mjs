#!/usr/bin/env node
/**
 * Generate a spec's IMPLEMENTATION CONTRACT — the normative sections only,
 * with the review history stripped out.
 *
 * Why this exists (outbound-gate-advisory-override rounds 22/23/24): a spec that
 * records its own review honestly accumulates change logs describing designs that
 * were REVERSED. Both external reviewers independently named the same risk — an
 * implementer cargo-culting a retired term out of a change log — and the same
 * fix: publish the contract separately from the history.
 *
 * The rule is deliberately dumb and mechanical: everything up to the first
 * history heading is the contract; everything from there on is history. A
 * generator that had to understand the document would drift like the document.
 *
 * Usage:
 *   node scripts/generate-spec-contract.mjs --spec docs/specs/<slug>.md
 *   node scripts/generate-spec-contract.mjs --spec <path> --check   # CI: fail if stale
 */

import fs from 'node:fs';
import path from 'node:path';

/** A heading that begins the review-history half. Matched case-insensitively. */
const HISTORY_HEADING_RE = /^##\s+(?:\d+\.\s+)?(?:Round-\d+\b[^\n]*?(?:change log|hand-check|consistency sweep)|Appendix\b)/i;

/** Headings that are contract even though they sort after a history heading. */
const ALWAYS_CONTRACT_RE = /^##\s+(?:\d+\.\s+)?(?:Decision points touched|Open questions|Frontloaded Decisions|Dependencies|Honest limits|Multi-machine posture|What this does not do)/i;

/**
 * Inline review annotations inside NORMATIVE prose — "(round-12, codex — ...)",
 * "*(Round-25, codex: ...)*". They are provenance, not contract. Both external
 * reviewers named them as the reason §§0-11 still read as history (rounds 24/25).
 * Stripped from the generated contract; untouched in the source spec, where they
 * are the record of why a decision is what it is.
 *
 * Deliberately conservative: only fully-delimited groups are removed, so a
 * malformed annotation is left visible rather than silently eating prose.
 */
const INLINE_ANNOTATION_RES = [
  // *( Round-N ... )* — a complete italic aside
  /\*\((?:round|rounds)[- ]\d+[^()*]*\)\*/gi,
  // ( round-N, reviewer — ... ) — a complete parenthetical with no nesting
  /\s*\((?:round|rounds)[- ]\d+[^()]*\)/gi,
  // — round-N, codex …  (an em-dash aside running to the end of a sentence)
  /\s+—\s+(?:round|rounds)[- ]\d+,[^.;]*(?=[.;])/gi,
];

export function stripInlineAnnotations(text) {
  let out = text;
  for (const re of INLINE_ANNOTATION_RES) out = out.replace(re, '');
  // Collapse the double spaces a removal can leave mid-sentence.
  return out.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:])/g, '$1');
}

export function splitContract(markdown) {
  const lines = markdown.split('\n');
  const kept = [];
  let inHistory = false;
  let droppedSections = 0;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (HISTORY_HEADING_RE.test(line) && !ALWAYS_CONTRACT_RE.test(line)) {
        if (!inHistory) inHistory = true;
        droppedSections++;
        continue;
      }
      // A non-history H2 ends a history run (sections are not strictly ordered).
      inHistory = false;
    }
    if (!inHistory) kept.push(line);
  }
  const body = stripInlineAnnotations(kept.join('\n')).replace(/\n{4,}/g, '\n\n\n');
  return { contract: body, droppedSections };
}

/** The banner that makes the generated file unmistakable and un-editable-by-hand. */
function banner(specRel) {
  return [
    '<!-- GENERATED FILE — DO NOT EDIT.',
    `     Source: ${specRel}`,
    '     Regenerate: node scripts/generate-spec-contract.mjs --spec ' + specRel,
    '     This is the IMPLEMENTATION CONTRACT: the normative design only.',
    '     Review history (change logs, retired designs, reversed decisions) is',
    '     deliberately absent — read the source spec for how the design got here.',
    '-->',
    '',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const specIdx = args.indexOf('--spec');
  if (specIdx === -1 || !args[specIdx + 1]) {
    console.error('usage: generate-spec-contract.mjs --spec <path> [--check]');
    process.exit(2);
  }
  const specPath = path.resolve(args[specIdx + 1]);
  const check = args.includes('--check');
  const specRel = path.relative(process.cwd(), specPath);

  const markdown = fs.readFileSync(specPath, 'utf8');
  const { contract, droppedSections } = splitContract(markdown);
  const output = banner(specRel) + contract;

  const slug = path.basename(specPath, '.md');
  const outPath = path.join(path.dirname(specPath), 'generated', `${slug}.contract.md`);

  if (check) {
    if (!fs.existsSync(outPath)) {
      console.error(`STALE: ${path.relative(process.cwd(), outPath)} does not exist. Run without --check.`);
      process.exit(1);
    }
    const existing = fs.readFileSync(outPath, 'utf8');
    if (existing !== output) {
      console.error(
        `STALE: ${path.relative(process.cwd(), outPath)} does not match ${specRel}.\n` +
          'The contract is generated — regenerate it rather than editing it.',
      );
      process.exit(1);
    }
    console.log(`OK: contract is current (${droppedSections} history sections excluded).`);
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, output, 'utf8');
  const pct = Math.round((1 - output.length / markdown.length) * 100);
  console.log(
    `wrote ${path.relative(process.cwd(), outPath)} — ${droppedSections} history sections excluded, ${pct}% smaller.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('generate-spec-contract.mjs')) {
  main();
}
