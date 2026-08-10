#!/usr/bin/env node
/**
 * lint-account-matches-tree.mjs — the repository's account of itself must match the tree.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Nineteen external review passes. For thirteen consecutive ones, the previous pass's repair
 * introduced the next pass's findings — and by pass 19 the composition had narrowed to a single class:
 * **a closure claimed and not delivered.** Zero of pass 19's three load-bearing findings were guard
 * defects. All three were artifacts asserting that work had been done which had not.
 *
 * Pass 19's own prescription, quoted because it is the reason this file exists rather than another
 * paragraph of intent:
 *
 *   "Finding defects faster will not end this, and neither will another prose commitment. The
 *    mechanical closure available here is small and concrete: a static lint asserting each countdown
 *    guard's source imports the shared symbol and contains no numeric horizon literal; a lint asserting
 *    the forbidden numerals appear on no reader-facing surface except inside an explicit [SUPERSEDED]
 *    annotation … Note that finding 2 is exactly the second of those, and the repository has now been
 *    told about it twice."
 *
 * Both arms below are that prescription, verbatim. Neither could be a behavioural test, and that is the
 * point of making them static:
 *
 *   ARM 1 is UNCLOSABLE BEHAVIOURALLY. Pass 18's defect was a private `const HORIZON_DAYS = 180`
 *   duplicating a shared constant that was ALSO 180. Every behavioural test compares printed output, so
 *   a duplicate at the SAME value is invisible — the suite passes 23/23 against the exact code pass 18
 *   rejected, which I verified before writing this. Only the SOURCE can tell a shared bound from a
 *   coincidentally-equal copy.
 *
 *   ARM 2 catches a class no test can reach either: a superseded figure sitting on a document a human
 *   reads. It was found live on a SHIPPING release note at pass 18, recorded as corrected, and found
 *   again eleven lines under its own "the numerals are deliberately not repeated" disclaimer at pass 19.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — (1) every file in COUNTDOWN_GUARDS imports the shared horizon symbols and declares no
 *               numeric horizon literal of its own; (2) no SUPERSEDED_FIGURE and no RETIRED_CLAIM appears
 *               on a tracked surface except within a two-line window carrying an explicit `[SUPERSEDED`
 *               annotation.
 *   CERTIFIED — three specific false-closure shapes cannot be re-committed silently.
 *
 * **It does NOT certify that the repository's account is true in general.** It covers two named shapes
 * that recurred often enough to earn a guard, and nothing else — a document can still misdescribe the
 * machinery in a hundred other ways. Saying so plainly, because a guard whose scope is assumed wider
 * than it is would be this registry's signature failure, and pass 19's finding 1 was exactly a test
 * whose stated reach exceeded what it checked.
 *
 * The populations are DECLARED, not discovered, which is a real weakness and is named here rather than
 * found later: a new countdown guard, or a new reader-facing surface, is not covered until someone adds
 * it below. That is the same limitation the countdown lint declares about REQUIRE_COUNTDOWN.
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');

/** Guards that must share ONE horizon definition rather than each carrying a literal. */
const COUNTDOWN_GUARDS = [
  'scripts/lint-enforcement-gap-records.mjs',
  'scripts/lint-documented-only-countdown.mjs',
];
const SHARED_SYMBOL = 'COUNTDOWN_HORIZON_DAYS';
/** A bare number assigned to something horizon-named — the shape of the duplicate pass 18 found. */
const HORIZON_LITERAL_RE = /\b(?:const|let|var)\s+\w*HORIZON\w*\s*=\s*\d+/i;

/**
 * Figures the deferral guard's own header says, verbatim, "Do not quote either." They measured a
 * narrower id population through a character class a space terminates; the live figure is 201 of 217.
 */
const SUPERSEDED_FIGURES = ['178', '110', '62%', '54%'];

/**
 * Retired CLAIMS-ABOUT-THIS-WORK, in the same arm because they fail the same way and the same annotation
 * releases them. Each was corrected on the record and then survived at its original site — review pass 19
 * finding 3 found two of them still live after the commit that announced their correction, which was
 * itself the verbatim repeat of what that file diagnoses for pass 17 eighty lines earlier.
 *
 *   "six major findings"  — pass1-verdict.md is 5 major + 1 minor. Corrected by passes 6, 10 and 18, and
 *                           applied at the claim for the first time at review pass 19. Note a naive grep
 *                           for /SEVERITY:/ counts 1 critical + 5 major + 1 minor + 1 nit, because two of
 *                           the eight lines are EMPTY-CLASS declarations ("No critical findings.").
 *   "two of the eleven"   — one of the two (the gap guard's leg 4) dates to the pass-3 repair, which
 *                           pass15-verdict.md finding 5 ends by excluding: "Introduced at the pass-3
 *                           repair; eleven subsequent passes did not reach it."
 */
const RETIRED_CLAIMS = [
  'six major findings',
  'two of the eleven streak defects',
  'two of those eleven were arms',
  'two of those eleven were alarms',
  'already used four times',
];

/**
 * Surfaces for the FIGURE arm: what an outside reader actually meets. `upgrades/next/` ships.
 *
 * Deliberately NOT the engineering log. That file's subject IS the figure's history — it narrates the
 * value moving across five corrections, and each mention is the point of its sentence, not a stale claim.
 * Pointing this arm at it produced fourteen findings, none of which any review pass has ever raised, and
 * a guard that flags correct prose trains its reader to skip it.
 */
const READER_FACING = [
  'upgrades/next/deferral-tracking-verified-not-assumed.md',
  'docs/specs/window10-deep-property-guards.eli16.md',
];

/**
 * Surfaces for the CLAIM arm, which is wider because every one of review pass 19's finding-3 sites lived
 * in the engineering log or the test file. Covering only reader-facing surfaces would have caught none.
 */
const CLAIM_SURFACES = [
  ...READER_FACING,
  'upgrades/side-effects/window10-deep-property-guards.md',
  'tests/unit/window10-guards-behaviour.test.ts',
];
const SUPERSEDED_MARK = '[SUPERSEDED';

const failures = [];

// ── ARM 1: one horizon definition, no private literals ────────────────────────────────────────────
for (const rel of COUNTDOWN_GUARDS) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    failures.push(`${rel} is missing — refusing to report clean over a guard that is not there.`);
    continue;
  }
  const src = fs.readFileSync(abs, 'utf-8');
  if (!src.includes(SHARED_SYMBOL)) {
    failures.push(
      `${rel} does not reference ${SHARED_SYMBOL}. Both countdown guards must take the horizon from the ` +
      `one shared definition in scripts/lib/baseline-history.mjs. This is the arm that would have caught ` +
      `review pass 18's finding, which the behavioural suite structurally cannot: a private literal equal ` +
      `to the shared value produces identical output.`,
    );
  }
  // Ignore comment lines: this file's own header quotes the offending pattern.
  const offending = src.split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .filter(({ line }) => HORIZON_LITERAL_RE.test(line));
  for (const { line, no } of offending) {
    failures.push(
      `${rel}:${no} declares a NUMERIC horizon literal — \`${line.trim()}\`. A bound duplicated into a ` +
      `guard is a second thing that can drift from the shared one, and when the two happen to be EQUAL ` +
      `no behavioural test can tell. Import ${SHARED_SYMBOL} instead.`,
    );
  }
}

// ── ARM 2a: no retired CLAIM-about-this-work on any tracked surface, unannotated ───────────────────
for (const rel of CLAIM_SURFACES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const lines = fs.readFileSync(abs, 'utf-8').split('\n');

  // Retired claims are checked over a TWO-LINE window, because prose wraps: the announcement paragraph
  // that quotes "six major\nfindings" splits it across a line break, and a per-line check would miss
  // exactly the sentence most likely to reproduce the retired wording. The escape is the same mark, on
  // either line of the window — a quotation that is explicitly labelled as the superseded wording is the
  // sanctioned way to describe a correction.
  lines.forEach((line, i) => {
    const next = lines[i + 1] ?? '';
    if (line.includes(SUPERSEDED_MARK) || next.includes(SUPERSEDED_MARK)) return;
    const window = `${line} ${next}`.replace(/\s+/g, ' ').toLowerCase();
    for (const claim of RETIRED_CLAIMS) {
      if (window.includes(claim.toLowerCase())) {
        failures.push(
          `${rel}:${i + 1} repeats the RETIRED claim "${claim}" without a ${SUPERSEDED_MARK}…] annotation ` +
          `— \`${line.trim().slice(0, 90)}\`. Review pass 19 finding 3 found two retired claims still live at ` +
          `their original sites in the commit that announced their correction. Correct it AT the claim, or ` +
          `annotate it if the retired wording is being quoted deliberately.`,
        );
        return;
      }
    }
  });
}

// ── ARM 2b: no superseded figure on a reader-facing surface, unannotated ──────────────────────────
for (const rel of READER_FACING) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue; // a release note may legitimately be consumed and removed
  const lines = fs.readFileSync(abs, 'utf-8').split('\n');


  lines.forEach((line, i) => {
    if (line.includes(SUPERSEDED_MARK)) return; // explicitly annotated — that is the sanctioned form
    for (const fig of SUPERSEDED_FIGURES) {
      // Word-boundary match so "1780" or "2110" do not trip it.
      const re = new RegExp(`(^|[^0-9.])${fig.replace('%', '%')}([^0-9%]|$)`);
      if (re.test(line)) {
        failures.push(
          `${rel}:${i + 1} publishes the SUPERSEDED figure "${fig}" without a ${SUPERSEDED_MARK}…] ` +
          `annotation — \`${line.trim().slice(0, 90)}\`. scripts/lint-deferral-referent-resolves.mjs says ` +
          `of these figures, verbatim, "Do not quote either." The live figure is 201 of 217. Found on a ` +
          `SHIPPING release note at review pass 18, recorded as corrected, and found again at pass 19 ` +
          `eleven lines under this file's own promise not to repeat the numerals.`,
        );
        return;
      }
    }
  });
}

const report = {
  countdownGuards: COUNTDOWN_GUARDS.length,
  readerFacingSurfaces: READER_FACING.filter((r) => fs.existsSync(path.join(ROOT, r))).length,
  claimSurfaces: CLAIM_SURFACES.filter((r) => fs.existsSync(path.join(ROOT, r))).length,
  failures,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-account-matches-tree: clean — ${report.countdownGuards} countdown guard(s) share one horizon ` +
    `definition, ${report.readerFacingSurfaces} reader-facing surface(s) free of ${SUPERSEDED_FIGURES.length} ` +
    `superseded figure(s), ${report.claimSurfaces} tracked surface(s) free of ${RETIRED_CLAIMS.length} retired claim(s).`,
  );
} else {
  console.error('\n❌ lint-account-matches-tree failed:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nWhy this exists: nineteen review passes narrowed to one class — a closure claimed and not ' +
    'delivered. Both arms are review pass 19\'s own prescription, made mechanical because four ' +
    'consecutive passes showed that announcing it is not the same as doing it.',
  );
}

process.exit(failures.length === 0 ? 0 : 1);
