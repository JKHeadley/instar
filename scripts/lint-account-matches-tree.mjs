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
 *               numeric horizon literal of its own; (2) no SUPERSEDED_FIGURE appears on a reader-facing
 *               surface except on a line carrying an explicit `[SUPERSEDED` annotation.
 *   CERTIFIED — two specific false-closure shapes cannot be re-committed silently.
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
/** Surfaces an outside reader actually reads. `upgrades/next/` ships. */
const READER_FACING = [
  'upgrades/next/deferral-tracking-verified-not-assumed.md',
  'docs/specs/window10-deep-property-guards.eli16.md',
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

// ── ARM 2: no superseded figure on a reader-facing surface, unannotated ───────────────────────────
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
  failures,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-account-matches-tree: clean — ${report.countdownGuards} countdown guard(s) share one horizon ` +
    `definition, ${report.readerFacingSurfaces} reader-facing surface(s) free of unannotated superseded figures.`,
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
