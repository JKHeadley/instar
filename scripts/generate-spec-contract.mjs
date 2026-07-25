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
const HISTORY_HEADING_RE =
  /^##\s+(?:\d+\.\s+)?(?:Round-\d+\b[^\n]*?(?:change log|hand-check|consistency sweep)|Review record\b|Appendix\b)/i;

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

/**
 * A blockquote block that exists to talk ABOUT the document — normative-boundary
 * markers, "this file is rationale", scope-changed notices. They are meta, not
 * contract, and they read as especially authoritative because of the `>` and the
 * bold. Round-37 (codex) found several of them surviving into the generated
 * contract, where a "NON-NORMATIVE FROM HERE" marker inside a file that claims to
 * be normative-only is worse than no marker at all.
 */
const META_BLOCKQUOTE_RE =
  /^>\s*(?:#{1,4}\s*)?\**\s*(?:NON-)?NORMATIVE\b|^>\s*\**\s*(?:It (?:is|began)|This file|Build from|The normative artifact|And the review)/i;

/**
 * A residual the generator CANNOT remove: narrative prose that states a rule and
 * narrates its history in the same sentence ("round-36 found this paragraph
 * stating only the p99"). Counting them is the honest alternative to pretending
 * they are gone — the run reports the number so a reader knows what they are
 * getting.
 */
const NARRATIVE_HISTORY_RE = /\b(?:round|rounds)[- ]\d+\b/gi;

/**
 * STRICT mode (`--strict`): an ALLOWLIST of contract-bearing headings, instead of
 * the default denylist of history headings.
 *
 * The denylist answers "what is definitely history?" and keeps everything else.
 * That is the wrong default for an implementation artifact: rationale, accepted
 * residuals and self-correcting narrative are all "not definitely history", so
 * they survive — and SEVEN consecutive review rounds (33-39) said the resulting
 * contract still read as archaeology. An allowlist answers the question that
 * actually matters, "what must be built?", and everything else is absent by
 * default rather than by pattern-match.
 *
 * Kept deliberately narrow: the contract table, rollout/acceptance, honest
 * limits, decision points, and the test plan. Rationale lives in the source spec,
 * which is where a reader goes for judgment.
 */
const STRICT_CONTRACT_HEADING_RE =
  /^#{2,3}\s+(?:\d+(?:\.\d+)*\.?\s+)?(?:Final contract|What an implementer builds|Current design overview|Glossary|Normative outcome table|Rollout|Honest limits|Privacy posture|Decision points touched|Open questions|Frontloaded Decisions|Dependencies|Multi-machine posture|Test plan|Fail directions|What this does not do)/i;

export function splitStrictContract(markdown) {
  const lines = markdown.split('\n');
  // Pre-pass: how big is each allowlisted section in the SOURCE (to the next
  // heading of the same-or-higher level)?
  const sourceSizes = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!STRICT_CONTRACT_HEADING_RE.test(lines[i])) continue;
    const level = (lines[i].match(/^#+/) || ['##'])[0].length;
    let bytes = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const m = lines[j].match(/^(#+)\s/);
      // The source measure must NOT use the capture's stopping rule, or it
      // shrinks in lockstep with the truncation it is meant to detect (an
      // interior non-allowlisted H3 would end both, and the guard sees nothing).
      // Stop at the next ALLOWLISTED heading, the next H2, or a NUMBERED SIBLING
      // at the same level.
      //
      // The sibling test is what separates the two shapes this guard cannot
      // otherwise tell apart (both are "a same-level heading follows"):
      //   "### 3.0 Final contract" → "### Normative checklist"  = meant as a CHILD;
      //       its content belongs to 3.0 and capture losing it is a real defect.
      //   "### 3.10 Test plan"     → "### 3.11 Judgeable-record" = a genuine SIBLING;
      //       its content was never 3.10's and excluding it is correct.
      // Without this, the guard fired permanently on every numbered spec — and a
      // warning that always fires is one nobody reads (the lesson from its own
      // second implementation).
      const isNumberedSibling = m && m[1].length === level && /^#+\s+\d+(\.\d+)*[.\s]/.test(lines[j]);
      if (m && (STRICT_CONTRACT_HEADING_RE.test(lines[j]) || m[1].length <= 2 || isNumberedSibling)) break;
      // Content that belongs to a NESTED allowlisted subsection is captured
      // under that subsection's own entry — it is not lost, so it must not
      // count against this section (otherwise a container heading like
      // "## 4. Honest limits" followed by an allowlisted "### 4.0 …" warns
      // forever, and a guard that always warns is a guard nobody reads).
      bytes += lines[j].length + 1;
    }
    sourceSizes.set(lines[i].trim(), bytes);
  }
  const kept = [];
  let keeping = false;
  let keptSections = 0;
  const sectionSizes = [];
  // Front matter always rides along — it carries the approval + convergence tags.
  let inFrontMatter = lines[0] === '---';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFrontMatter) {
      kept.push(line);
      if (i > 0 && line === '---') inFrontMatter = false;
      continue;
    }
    if (/^#{1,3}\s/.test(line)) {
      keeping = STRICT_CONTRACT_HEADING_RE.test(line);
      if (keeping) {
        keptSections++;
        sectionSizes.push({ heading: line.trim(), bytes: 0, sourceBytes: sourceSizes.get(line.trim()) || 0 });
      }
      // An H1 (the title) is kept as an anchor but does not open a section.
      if (/^#\s/.test(line)) {
        kept.push(line);
        keeping = false;
        continue;
      }
    }
    if (keeping) {
      kept.push(line);
      if (sectionSizes.length) sectionSizes[sectionSizes.length - 1].bytes += line.length + 1;
    }
  }
  const body = stripInlineAnnotations(kept.join('\n')).replace(/\n{4,}/g, '\n\n\n');
  const narrativeResidual = (body.match(NARRATIVE_HISTORY_RE) || []).length;
  // Guard against the allowlist's own failure mode: SILENT OMISSION. If strict
  // mode keeps only a small slice of a large spec, the likely cause is that the
  // spec's headings do not match the allowlist — not that the spec is mostly
  // rationale. Confirmed in practice on outbound-gate-advisory-override, where
  // the normative outcome table lived under headings the list did not name, and
  // the reviewer's first finding was "normative behavior is missing".
  const sourceHeadings = (markdown.match(/^#{2,3}\s/gm) || []).length;
  const keptRatio = sourceHeadings ? keptSections / sourceHeadings : 1;
  // Section COUNT is not content coverage: an H3 inside an allowlisted section
  // ends its capture, silently emptying it while the count stays identical.
  // Observed live (2026-07-25) — a new "### Normative checklist" heading inside
  // §3.0 dropped the entire contract table and the checklist itself from the
  // output, and the capture-ratio guard below did not fire because 10 sections
  // still "matched". So also guard on captured BYTES per kept section.
  // A short section is only suspicious when the SOURCE section is long — a
  // container heading (e.g. "## 4. Honest limits" immediately followed by an
  // allowlisted "### 4.0 …") is legitimately near-empty and must not warn.
  const truncated = sectionSizes.filter(
    (x) => x.sourceBytes > 1000 && x.bytes < x.sourceBytes * 0.25,
  );
  const thinSectionWarning = truncated.length
    ? `${truncated.length} allowlisted section(s) captured far less than the ` +
      `source contains: ` +
      truncated
        .map((x) => `${x.heading} (${x.bytes}/${x.sourceBytes} bytes)`)
        .join(' | ') +
      ` — an H3 inside an allowlisted section ENDS its capture, emptying it while ` +
      `the section count stays the same. Sub-headings inside a contract section ` +
      `must be H4.`
    : null;
  const underCaptureWarning =
    sourceHeadings >= 8 && keptRatio < 0.25
      ? `only ${keptSections}/${sourceHeadings} sections matched the allowlist ` +
        `(${Math.round(keptRatio * 100)}%) — the strict contract may be MISSING ` +
        `normative sections whose headings are not on the list. Verify before ` +
        `building from it.`
      : null;
  return { contract: body, keptSections, narrativeResidual, sourceHeadings, underCaptureWarning, thinSectionWarning };
}

export function splitContract(markdown) {
  const lines = markdown.split('\n');
  const kept = [];
  let inHistory = false;
  let inMetaQuote = false;
  let droppedSections = 0;
  let droppedMetaBlocks = 0;
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
    // Meta blockquotes run until the first non-blockquote, non-blank line.
    if (!inHistory) {
      if (!inMetaQuote && META_BLOCKQUOTE_RE.test(line)) {
        inMetaQuote = true;
        droppedMetaBlocks++;
      } else if (inMetaQuote && !/^>/.test(line) && line.trim() !== '') {
        inMetaQuote = false;
      }
      if (inMetaQuote) continue;
    }
    if (!inHistory) kept.push(line);
  }
  const body = stripInlineAnnotations(kept.join('\n')).replace(/\n{4,}/g, '\n\n\n');
  const narrativeResidual = (body.match(NARRATIVE_HISTORY_RE) || []).length;
  return { contract: body, droppedSections, droppedMetaBlocks, narrativeResidual };
}

/** The banner that makes the generated file unmistakable and un-editable-by-hand. */
function banner(specRel, narrativeResidual, strict) {
  if (strict) {
    return [
      '<!-- GENERATED FILE — DO NOT EDIT.',
      `     Source: ${specRel}`,
      '     Regenerate: node scripts/generate-spec-contract.mjs --spec ' + specRel + ' --strict',
      '     STRICT IMPLEMENTATION CONTRACT: allowlisted contract sections only.',
      '',
      '     Everything not on the allowlist is ABSENT BY DEFAULT — including all',
      '     rationale. This file says WHAT to build, never why. Read the source',
      '     spec for the reasoning, the alternatives, and the accepted residuals',
      '     in their full form.',
      `     (${narrativeResidual} residual "round-N" reference(s) remain inline.)`,
      '-->',
      '',
    ].join('\n');
  }
  return [
    '<!-- GENERATED FILE — DO NOT EDIT.',
    `     Source: ${specRel}`,
    '     Regenerate: node scripts/generate-spec-contract.mjs --spec ' + specRel,
    '     This is the IMPLEMENTATION CONTRACT.',
    '',
    '     REMOVED: history sections, delimited round-annotations, and blockquote',
    '     meta-blocks that talk about the document rather than the design.',
    '',
    '     NOT REMOVED: narrative prose that states a rule and narrates its own',
    '     history in the same sentence. A transform cannot separate those without',
    '     judgment it deliberately does not have, so some review references remain',
    `     below (${narrativeResidual} occurrence(s) of "round-N" in this file).`,
    '     Where such a sentence describes what a design USED to be, the surrounding',
    '     normative statement governs. Read the source spec for full context.',
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

  const strict = args.includes('--strict');
  if (!fs.existsSync(specPath)) {
    console.error(`ERROR: spec not found: ${specRel}`);
    process.exit(2);
  }
  let markdown;
  try {
    markdown = fs.readFileSync(specPath, 'utf8');
  } catch (err) {
    console.error(`ERROR: cannot read ${specRel}: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
  const res = strict ? splitStrictContract(markdown) : splitContract(markdown);
  const { contract, narrativeResidual } = res;
  const droppedSections = res.droppedSections ?? 0;
  const droppedMetaBlocks = res.droppedMetaBlocks ?? 0;
  const keptSections = res.keptSections ?? 0;
  const output = banner(specRel, narrativeResidual, strict) + contract;
  if (res.underCaptureWarning) {
    console.error(`WARNING (strict): ${res.underCaptureWarning}`);
  }
  if (res.thinSectionWarning) {
    console.error(`WARNING (strict): ${res.thinSectionWarning}`);
  }

  const slug = path.basename(specPath, '.md');
  const suffix = strict ? '.contract.strict.md' : '.contract.md';
  const outPath = path.join(path.dirname(specPath), 'generated', `${slug}${suffix}`);

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
    console.log(
      strict
        ? `OK: strict contract is current (${keptSections} allowlisted sections; ` +
            `${narrativeResidual} narrative round-references remain).`
        : `OK: contract is current (${droppedSections} history sections, ` +
            `${droppedMetaBlocks} meta-blocks excluded; ${narrativeResidual} narrative ` +
            `round-references remain).`,
    );
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, output, 'utf8');
  const pct = Math.round((1 - output.length / markdown.length) * 100);
  console.log(
    strict
    ? `wrote ${path.relative(process.cwd(), outPath)} — STRICT: ${keptSections} ` +
        `allowlisted sections kept, ${pct}% smaller. RESIDUAL: ${narrativeResidual} ` +
        `narrative round-reference(s).`
    : `wrote ${path.relative(process.cwd(), outPath)} — ${droppedSections} history ` +
      `sections + ${droppedMetaBlocks} meta-blocks excluded, ${pct}% smaller. ` +
      `RESIDUAL: ${narrativeResidual} narrative round-reference(s) the transform ` +
      `cannot remove.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('generate-spec-contract.mjs')) {
  main();
}
