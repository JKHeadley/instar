#!/usr/bin/env node
/**
 * lint-account-matches-tree.mjs — the repository's account of itself must match the tree.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Twenty external review passes. The composition narrowed to one class: **a closure claimed and not
 * delivered.** Pass 19 prescribed two static arms; they were built, and pass 20 found BOTH shipped with a
 * population NARROWER than the class their prose named, letting live instances through:
 *
 *   - the figure list encoded four of the SIX numerals its own cited authority forbids, and one of the two
 *     it omitted (`194`) was live and unannotated, twice, on the reader-facing explainer this arm exists
 *     to protect — one line above a line the repair DID annotate;
 *   - [SUPERSEDED — quoting both retired wordings deliberately] the claim list contained `already used four times` while the live site read `…convention for retiring a wrong line, used four times`, eight words apart, so an exact substring never matched.
 *
 * Pass 20's prescription, quoted because it is the reason this file was rewritten rather than extended:
 *
 *   "derive the two populations from their sources instead of transcribing them, because a hand-transcribed
 *    population is this branch's own recorded blind spot and it has now produced the finding twice in one
 *    guard."
 *
 * So BOTH hand-maintained lists are DELETED. Nothing is transcribed here:
 *
 *   FIGURES are parsed from `scripts/lint-deferral-referent-resolves.mjs` — the authority this arm always
 *   cited but never read. Its header names the retired triples and says "Do not quote either." Adding a
 *   third retired triple there now enrolls it here automatically.
 *
 *   CLAIMS are parsed from the `[SUPERSEDED (em-dash) then the retired wording in double quotes]` annotations already present in the tree. The
 *   QUOTED annotations are the registry — and only the quoted form. The exact share is DERIVED and
 *   printed on every clean run rather than written here: review pass 21 finding 8 caught the sentence
 *   claiming all annotations, and review pass 22 finding 3 caught its replacement publishing a count
 *   copied from that reviewer's verdict, which the guard's own output contradicted four lines later.
 *   A number about this guard's own population belongs in its output, not in its prose.
 *   Correcting a claim once — which requires annotating the place that
 *   quotes it — immunises every tracked surface against that claim thereafter. A population discovered
 *   from the material, not a list someone must remember to extend.
 *
 * ── Matching ───────────────────────────────────────────────────────────────
 * Two changes from the version pass 20 falsified, both deletions of a mechanism rather than additions:
 *
 *   The two-line sliding window is GONE. The file is normalised once with an offset→line map and matched
 *   whole, so a claim wrapped across any number of lines is found exactly once at the line where it
 *   starts. A continuation may begin with any amount of indentation, and — in a SCRIPT — with a comment
 *   marker, or — in MARKDOWN — with a blockquote marker. It may NOT begin with a markdown list bullet or
 *   heading marker followed by whitespace: that opens a new item rather than continuing one, and
 *   stripping it joined separate bullets into one false claim. A marker followed by NON-space is emphasis
 *   opening a continuation, and it does continue. That asymmetry is deliberate and is the whole of the
 *   rule. Matching the file whole also removes pass 20's finding 4 (a violation on one line reported twice, one copy naming a
 *   line that did not contain it) and finding 5 (a claim sandwiched between two annotated lines was
 *   invisible, because the escape checked NEIGHBOURS). The escape is now the matched span's OWN lines.
 *
 *   The annotated wording IS the matcher, verbatim — a tail heuristic was tried and immediately fired on
 *   a CORRECTED sentence, because it stripped the one word that had been wrong. Whoever writes the
 *   correction quotes the PAYLOAD; the guard obeys it literally.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — (1) every file in COUNTDOWN_GUARDS references the shared horizon symbol and declares no
 *               `const`/`let`/`var` WHOSE NAME CONTAINS "horizon" bound to a numeric literal; (2) no
 *               derived superseded figure appears on a reader-facing surface, and no derived retired claim
 *               appears on a tracked surface, except where the line it sits on carries `[SUPERSEDED`.
 *               (3) every review pass the tree CITES has its verbatim verdict archived, contiguously.
 *   CERTIFIED — four specific false-closure shapes cannot be re-committed silently.
 *
 * **It does NOT certify that the repository's account is true in general**, and two limits are named here
 * rather than found later:
 *
 *   ARM 1 checks a NAMING PATTERN. A same-value duplicate hidden under a constant whose name does not
 *   contain "horizon" (`const GAP_DEADLINE_DAYS = 180`) passes — pass 20's finding 6. The clean line below
 *   says exactly what is checked and no longer claims the guards "share one horizon definition", which was
 *   broader than the evidence.
 *
 *   A retired claim RE-EXPRESSED IN DIFFERENT WORDS is beyond any string matcher. "two of the eleven
 *   streak defects" and "two of those eleven were alarms I had accidentally disconnected" share no tail.
 *   This guards recurrence of a known wording, not of an idea.
 *
 *   The SURFACE lists remain declared, and that is a real weakness: a new reader-facing document is not
 *   covered until someone adds it. Same limitation the countdown lint declares about REQUIRE_COUNTDOWN.
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

/** The authority for the figure population. Parsed, never transcribed. */
const FIGURE_AUTHORITY = 'scripts/lint-deferral-referent-resolves.mjs';
const SUPERSEDED_MARK = '[SUPERSEDED';
/** Below this length a matcher is too generic to be evidence of anything. */
const MIN_MATCHER_CHARS = 14;

/** Surfaces for the FIGURE arm: what an outside reader actually meets. `upgrades/next/` ships. */
const READER_FACING = [
  'upgrades/next/deferral-tracking-verified-not-assumed.md',
  'docs/specs/window10-deep-property-guards.eli16.md',
];
/** Surfaces for the CLAIM arm — wider, because pass 19's finding-3 sites lived in the log and the test. */
const CLAIM_SURFACES = [
  ...READER_FACING,
  'upgrades/side-effects/window10-deep-property-guards.md',
  'tests/unit/window10-guards-behaviour.test.ts',
  // Review pass 21 finding 11: this file defined the claim registry and was exempt from it, while its own
  // header repeated a retired wording twice. A guard that does not hold itself to its rule is the rule's
  // first counter-example.
  'scripts/lint-account-matches-tree.mjs',
];
/**
 * A file can be WATCHED without being a SOURCE, and conflating the two is a mistake this guard has now
 * made twice. The behavioural test is watched — review pass 19 found a real retired claim in its header
 * prose — but it must never be a source, because its fixtures deliberately contain a fabricated
 * annotation, a fabricated repetition of it, and a fabricated citation of a review pass that does not
 * exist. Treating those as real enrolled a phantom matcher and demanded a verdict for a nonexistent pass.
 * A negative control has to contain the thing it provokes; that is what makes it a control and not a
 * defect.
 */
const SOURCE_EXCLUDED = new Set(['tests/unit/window10-guards-behaviour.test.ts']);
/** Where annotated wordings are harvested from: a claim retired anywhere real is retired everywhere. */
// De-duplicated: this file reaches the list twice — once via CLAIM_SURFACES, once appended here — so the
// refusal published "7 source file(s)" for six distinct files. Review pass 24 finding 4. A Set made the
// BEHAVIOUR correct while the printed self-count stayed wrong, which is the shape the sibling guard exists
// to catch, in the guard whose subject is that a count about itself must be true.
const ANNOTATION_SOURCES = [...new Set(
  [...CLAIM_SURFACES, ...COUNTDOWN_GUARDS, 'scripts/lint-account-matches-tree.mjs'],
)].filter((rel) => !SOURCE_EXCLUDED.has(rel));

/**
 * Citation forms ARM 3 recognises. Review pass 21 finding 2: the first version parsed only `pass N`,
 * while the reader-facing explainer states the obligation in the ordinal form and uses that form for
 * every one of its section headings — so the arm could not see the idiom its own claim was written in.
 */
const CITATION_NUMERIC_RE = /\b(?:review\s+)?pass\s*#?\s*(\d{1,3})\b/gi;
/** A following unit disqualifies it: "the tests pass 100% of the time" is English, not a citation. */
// Review pass 22 finding 7: this carried an `of` alternative, which is a PREPOSITION, not a unit — so a
// citation followed by "of this series" armed nothing. Only the percent sign is load-bearing for the
// current tree; the rest are kept because they are genuine units, and the preposition is removed.
// The word-boundary applies to the WORD alternatives only. Hoisting it outside the group silently
// killed the percent case — '%' is not a word character, so there is no boundary between it and the
// following space, and the one alternative that is actually load-bearing for this tree stopped matching.
// Caught by the guard refusing its own comment about the previous repair, one minute after making it.
const CITATION_UNIT_RE = /^\s*(?:%|(?:percent|minutes?|seconds?|hours?|days?|checks?|tests?|files?|lines?|times)\b)/i;
const ORDINAL_WORDS = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
  'eighteenth', 'nineteenth', 'twentieth',
];
const ORDINAL_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
/**
 * The ROUND ordinals, which the tens table alone cannot express: "thirtieth" is not "thirty" + a unit
 * word, it is its own token. Review pass 22 finding 2 — the previous version resolved compound ordinals
 * but no ROUND one, while two committed artifacts justified the tens table by saying "a decoder that stops
 * at a round number is the same narrow-population defect one order up". It stopped at every round number,
 * so the natural section heading for the next round reading would have armed nothing. (No example numeral
 * or ordinal appears in this comment: this file is a citing surface, so an example would arm the arm
 * against prose ABOUT the arm — the fourth time that has happened here.)
 */
const ORDINAL_ROUND = {
  thirtieth: 30, fortieth: 40, fiftieth: 50, sixtieth: 60,
  seventieth: 70, eightieth: 80, ninetieth: 90, hundredth: 100,
};
const ORDINAL_TENS_RE = Object.keys(ORDINAL_TENS).join('|');
// Round forms are alternatives in their own right, listed FIRST so the longest match wins.
const ORDINAL_READING_RE = new RegExp(
  `\\b(?:(${Object.keys(ORDINAL_ROUND).join('|')})|((?:${ORDINAL_TENS_RE})[- ])?(${ORDINAL_WORDS.join('|')}))\\s+(?:reading|pass|review)\\b`,
  'gi',
);
function ordinalToNumber(raw) {
  const s = String(raw).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(ORDINAL_ROUND, s)) return ORDINAL_ROUND[s];
  const tensKey = Object.keys(ORDINAL_TENS).find((k) => s.startsWith(k));
  const tens = tensKey ? ORDINAL_TENS[tensKey] : 0;
  const unit = tensKey ? s.slice(tensKey.length).replace(/^[- ]/, '') : s;
  const idx = ORDINAL_WORDS.indexOf(unit);
  if (idx === -1) return tens || null;
  return tens > 0 ? tens + (idx + 1) : idx + 1;
}

/** The review archive. ARM 3's obligation is derived from the tree's own citations of it. */
const ARCHIVE_DIR = 'docs/specs/reports/window10-external-passes';
/** Surfaces whose prose cites review passes — sources, so the behavioural test is excluded (see above). */
const CITING_SURFACES = [...CLAIM_SURFACES].filter((rel) => !SOURCE_EXCLUDED.has(rel));

let CITED_COUNT = 0;
const failures = [];

// ── Derive the FIGURE population from the authority the arm cites ─────────────────────────────────
function deriveFigures() {
  const abs = path.join(ROOT, FIGURE_AUTHORITY);
  if (!fs.existsSync(abs)) {
    failures.push(
      `${FIGURE_AUTHORITY} is missing — the superseded-figure population is DERIVED from its header, so ` +
      `without it this arm would silently watch nothing. Refusing rather than reporting clean over an ` +
      `empty population.`,
    );
    return [];
  }
  // Review pass 21 finding 10: this was `.slice(0, 4000)`, so a retired triple written past that byte
  // silently failed to enrol. Bound it by STRUCTURE — the leading block comment — not by a byte count.
  const whole = fs.readFileSync(abs, 'utf-8');
  const headerEnd = whole.indexOf('*/');
  const header = headerEnd === -1 ? whole : whole.slice(0, headerEnd);
  // Retired triples are written either `178/110/62%` or as a raw fraction — the header uses both, and
  // "TWO earlier figures are SUPERSEDED and neither should be quoted".
  // The third element's percent sign is OPTIONAL. Review pass 26 finding 1: requiring it meant this
  // derivation could not enrol a triple written in the notation its own authority ADOPTED — that header
  // says, in as many words, "The percentage is gone on purpose… A raw fraction can go stale, but it
  // cannot disagree with itself." So the parser sided with the abandoned notation while this file's
  // header certified that a third retired triple "now enrols here automatically". Proven with a control:
  // a percent-free triple added to the authority left the count unmoved; the same triple with a percent
  // sign moved it. The derived-population design was adopted because a hand-transcribed population
  // shipped narrower than its class — and the parse reintroduced exactly that narrowness one layer down.
  // ALTERNATION, not an optional percent. Review pass 27 finding 1: `(\d{1,4}%?)\b` cannot hold the `%`
  // in ordinary prose — a word boundary after `%` needs a word character next, so the engine backtracks
  // and drops it. My pass-26 "widening" therefore SHIFTED the population instead: the two notations the
  // authority actually names went unwatched while two bare two-digit numerals began false-positiving.
  // Verified in both directions with controls, before and after. The alternation captures the percent
  // form when present and the bare form otherwise, and needs no boundary after the `%`.
  const triples = [...header.matchAll(/\b(\d{2,4})\/(\d{2,4})\/(\d{1,4}%|\d{1,4}\b)/g)];
  const figs = [...new Set(triples.flatMap((m) => [m[1], m[2], m[3]]))];
  if (figs.length === 0) {
    failures.push(
      `${FIGURE_AUTHORITY} no longer states any retired figure triple in the \`N/N/N%\` form this arm ` +
      `parses. Either the header was reworded or the figures were retired — either way this arm is now ` +
      `watching NOTHING, which is exactly the alive-but-inert shape. Fix the parse or retire the arm.`,
    );
  }
  return figs;
}

// ── Derive the CLAIM population from the annotations already in the tree ──────────────────────────
function deriveClaims() {
  const wordings = new Set();
  for (const rel of ANNOTATION_SOURCES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf-8');
    for (const m of text.matchAll(/\[SUPERSEDED\s*—\s*"([^"]{4,160})"/g)) wordings.add(m[1].trim());
  }
  // The quoted wording IS the matcher, verbatim. No heuristic derives one.
  //
  // A tail heuristic was tried first and it manufactured a FALSE POSITIVE within a minute: from
  // [SUPERSEDED — quoting the retired wording deliberately] "two of the eleven streak defects were arms I made unreachable" — it derived a tail that dropped the
  // opening words, and that tail then fired on the CORRECTED sentence — it had stripped the single word
  // that was wrong. The payload of a retired claim is sometimes at its end and sometimes at its start,
  // and NO automatic rule can tell which. Whoever writes the correction is the only party who knows, so
  // the convention is that they quote the PAYLOAD and the guard obeys it literally.
  //
  // Wordings shorter than MIN_MATCHER_CHARS are skipped as too generic to be evidence, and the skipped
  // count is REPORTED on the clean line so the exclusion is never silent.
  const matcherSet = new Set();
  let skippedShort = 0;
  for (const w of wordings) {
    if (w.length < MIN_MATCHER_CHARS) { skippedShort += 1; continue; }
    matcherSet.add(w.replace(/\s+/g, ' ').toLowerCase());
  }
  const matchers = [...matcherSet];
  if (matchers.length === 0) {
    // Review pass 21 finding 4: the figure arm refuses over an empty derived population and the claim arm
    // did not, so rewriting one paragraph of the engineering log would silently empty this arm while it
    // printed clean — the alive-but-inert shape, in the file whose header names that shape.
    failures.push(
      `No retired claim could be derived from any ${SUPERSEDED_MARK}…] annotation in ${ANNOTATION_SOURCES.length} ` +
      `source file(s). This arm is now watching NOTHING while reporting clean, which is exactly the ` +
      `alive-but-inert shape. Either a correction removed the last quoted annotation, or the parse broke. ` +
      `Fix it or retire the arm — do not let it print clean over an empty population.`,
    );
  }
  return { wordings: [...wordings], matchers, skippedShort };
}

// ── One normalised search over a file, with an exact offset→line map ──────────────────────────────
/**
 * Which leading marker begins a CONTINUATION, by language. Review pass 23 finding 4: stripping every
 * marker on every surface joined two separate markdown bullets into one sentence and reported them as a
 * wrapped claim, while the identical content written with hyphen bullets was left alone — a guard that
 * flags correct prose is one its reader learns to skip. In a script a leading `*` or `//` continues a
 * comment; in markdown it starts a NEW list item or heading, and only `>` continues a blockquote.
 */
function continuationMarkerRe(rel) {
  return /\.(m?[jt]sx?|c[jt]s)$/i.test(rel)
    // No trailing \s* here: the caller trims after stripping, so whitespace handling lives in ONE place.
    // Review pass 23 finding 1 was a whitespace boundary; having two mechanisms both fix it meant no
    // single sabotage could red the test that covers it, which is a covered-looking arm with a masked
    // control. One mechanism, one sabotage, one red.
    //
    // The MARKDOWN branch discriminates on what follows the marker, not on the marker alone. Review pass
    // 24 finding 1: excluding every non-blockquote opener closed a class with ZERO instances in this
    // corpus (there are no star-bullet list items — the docs bullet with hyphens) and opened one with
    // twenty-two (a single star opening a continuation line is emphasis, and it is how these documents
    // wrap). I re-derived the zero myself before acting on it. A bullet is marker+WHITESPACE and never
    // continues; an emphasis run is marker+NON-space and does. One character class, both directions.
    ? /^(?:\/\/+|\*+)/            // script: comment continuation
    : /^(?:>+|\*+(?!\s))/;        // markdown: blockquote, or emphasis opening a continuation
}

function scan(abs, needles, rel) {
  const lines = fs.readFileSync(abs, 'utf-8').split('\n');
  const markerRe = continuationMarkerRe(rel ?? abs);
  // Build a whitespace-collapsed haystack and remember which line each character came from.
  let hay = '';
  const lineOf = [];
  lines.forEach((line, i) => {
    // `.trim()` first: leading indentation must NOT survive into the haystack. Without it the join
    // between a line and its continuation is TWO spaces while every needle carries one, so an indented
    // continuation — the dominant wrap shape in these documents, and in this very comment — is invisible.
    // Review pass 21 finding 1: the version this rewrite replaced collapsed that indentation and caught
    // the case, so the rewrite was a capability REGRESSION announced as a strengthening.
    // Strip a leading comment or blockquote marker as well as indentation. Review pass 22 finding 1:
    // `.trim()` alone closed the plain-indent wrap but not a continuation beginning `*`, `//` or `>` —
    // and the previous commit had just added THIS file, whose every wrapped sentence is a block comment,
    // to the watched surfaces. The arm covered that surface only for claims that never wrap.
    // `\\s*` not `\\s?`: the strip must consume the WHOLE leading run. Review pass 23 finding 1 — with
    // `\\s?` a marker followed by two or more spaces left one behind, so the join carried two spaces
    // against single-spaced needles and the continuation stayed invisible. Three spaces after `*` is the
    // house indentation of this file's own header, so the arm could not read the sentence certifying it
    // could. `.trim()` afterwards removes any residue the marker pattern did not.
    const collapsed = `${line.trim().replace(markerRe, '').trim().replace(/\s+/g, ' ')} `;
    for (let k = 0; k < collapsed.length; k += 1) lineOf.push(i);
    hay += collapsed;
  });
  const lower = hay.toLowerCase();
  const hits = [];
  for (const needle of needles) {
    const n = needle.toLowerCase();
    let from = 0;
    for (;;) {
      const at = lower.indexOf(n, from);
      if (at === -1) break;
      from = at + 1;
      const startLine = lineOf[at];
      const endLine = lineOf[Math.min(at + n.length - 1, lineOf.length - 1)];
      // The escape is the matched span's OWN lines — never a neighbour's annotation (pass 20 finding 5).
      let released = false;
      for (let l = startLine; l <= endLine; l += 1) if (lines[l].includes(SUPERSEDED_MARK)) released = true;
      if (released) continue;
      hits.push({ needle, line: startLine + 1, text: lines[startLine].trim().slice(0, 90) });
    }
  }
  // One report per (needle, line): a claim is a defect once, wherever the window happened to land.
  const seen = new Set();
  return hits.filter((h) => {
    const k = `${h.needle}@${h.line}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ── ARM 3: a cited review pass must have its verdict on disk ──────────────────────────────────────
//
// Review pass 20 named this the single cheapest closure still available, and named why it was still open:
// "grep -rl window10-external-passes scripts/ tests/ .github/ .husky/ returns nothing — no lint, test,
// hook or CI step asserts the latest verdict is on disk before a repair commit. That limb has now lapsed
// ten times, the tenth inside the commit that made the other two mechanical."
//
// Ten lapses, four of them consecutive, every one of them "I will remember next time". The obligation is
// DERIVED, not declared: the moment an artifact CITES a pass — "review pass 20 found…" — that citation
// creates the requirement that the pass's verdict be archived. The claim arms the guard. Writing about a
// reading and not filing it is the exact shape, and it is now a build failure rather than a resolution.
{
  const cited = new Set();
  for (const rel of CITING_SURFACES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf-8');
    for (const m of text.matchAll(CITATION_NUMERIC_RE)) {
      // Review pass 21 finding 5: "pass" is also a verb. "The tests pass 100% of the time" is correct
      // English, and the first version of this arm demanded a verdict file for it. A citation is a NOUN
      // phrase, so a following unit word
      // or percent sign disqualifies it. Narrow and deterministic, not a guess at intent.
      const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
      if (CITATION_UNIT_RE.test(tail)) continue;
      cited.add(Number(m[1]));
    }
    for (const m of text.matchAll(/\bpass\s*#?\s*(\d{1,3})-?verdict\b/gi)) cited.add(Number(m[1]));
    // The ORDINAL form is these documents' house convention — the explainer writes "the twentieth
    // reading" for every one of its sections, including the heading two paragraphs above the sentence
    // that told the reader this obligation fires "anywhere". Review pass 21 finding 2: the arm could not
    // parse the form its own reader-facing claim was written in.
    for (const m of text.matchAll(ORDINAL_READING_RE)) {
      // Groups are (tens?)(unit) — hand it BOTH. Passing only the first group gave the decoder the
      // TENS fragment alone, so a compound ordinal enrolled its round tens instead of the real number.
      // Note this comment names no example number: this file is itself a citing surface, so an example
      // written as a numeral would arm the arm against prose ABOUT the arm.
      // Group 1 is a round ordinal on its own; groups 2+3 are (tens?)(unit).
      const n = m[1] ? ordinalToNumber(m[1]) : ordinalToNumber(`${m[2] ?? ''}${m[3]}`);
      if (n) cited.add(n);
    }
    // The PLURAL form, used five times across the tracked surfaces ("Passes 12 and 13 run against...").
    for (const m of text.matchAll(/\bpasses\s+(\d{1,3})\s+and\s+(\d{1,3})\b/gi)) {
      cited.add(Number(m[1])); cited.add(Number(m[2]));
    }
  }
  const dir = path.join(ROOT, ARCHIVE_DIR);
  const present = new Set(
    (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      .map((f) => /^pass(\d{1,3})-verdict\.md$/.exec(f)).filter(Boolean).map((m) => Number(m[1])),
  );
  if (cited.size === 0 && present.size === 0) {
    // Review pass 22 finding 8: both sibling arms refuse over an empty derived population and this one
    // printed clean. "One failure teaches every guard" was not swept here in the commit that applied it
    // to the claim arm. An archive with no verdicts AND a tree that cites none is not a healthy state —
    // it is a parse that has stopped finding anything.
    failures.push(
      `ARM 3 derived NO citations from ${CITING_SURFACES.length} surface(s) AND found no archived verdict. ` +
      `This arm is watching NOTHING while reporting clean, which is the alive-but-inert shape its two ` +
      `sibling arms already refuse. Either the citation parse broke or the archive is gone.`,
    );
  }
  CITED_COUNT = cited.size;
  const missing = [...cited].filter((n) => n >= 1 && !present.has(n)).sort((a, b) => a - b);
  for (const n of missing) {
    failures.push(
      `${ARCHIVE_DIR}/pass${n}-verdict.md is MISSING, and the tree cites review pass ${n}. A citation is ` +
      `the obligation: an artifact that reasons from a reading whose verdict is not on disk leaves every ` +
      `claim about that reading uncheckable. This limb lapsed TEN times as a resolution before it became ` +
      `this arm. File the verbatim verdict, in its own commit, before the repairs it prompts.`,
    );
  }
  // Contiguity: a gap BETWEEN filed verdicts is the same defect discovered later. Bounded by what is
  // actually filed — demanding 1..N from a single archived verdict would refuse a legitimately young
  // archive, and a guard that refuses correct states is one its reader learns to skip.
  const maxPresent = present.size > 0 ? Math.max(...present) : 0;
  const minPresent = present.size > 0 ? Math.min(...present) : 1;
  for (let n = minPresent; n <= maxPresent; n += 1) {
    if (!present.has(n) && !missing.includes(n)) {
      failures.push(
        `${ARCHIVE_DIR}/pass${n}-verdict.md is missing from an otherwise contiguous archive running to ` +
        `pass ${maxPresent}. A hole in the middle is the same defect as a missing latest, found later.`,
      );
    }
  }
}

// ── ARM 1: one horizon definition, no horizon-named literals ──────────────────────────────────────
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
      `one shared definition in scripts/lib/baseline-history.mjs. This is the arm that caught an ` +
      `earlier reading's finding, which the behavioural suite structurally cannot: a private literal equal to the ` +
      `shared value produces identical output.`,
    );
  }
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

// ── ARM 2a: no retired CLAIM on a tracked surface, unannotated ────────────────────────────────────
const { wordings, matchers, skippedShort } = deriveClaims();
for (const rel of CLAIM_SURFACES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  for (const h of scan(abs, matchers, rel)) {
    failures.push(
      `${rel}:${h.line} repeats the RETIRED claim "${h.needle}" without a ${SUPERSEDED_MARK}…] annotation ` +
      `— \`${h.text}\`. This population is DERIVED from the ${SUPERSEDED_MARK}…] annotations already in the ` +
      `tree, so this wording was retired somewhere and is being repeated here. Correct it AT the claim, or ` +
      `annotate it if the retired wording is being quoted deliberately.`,
    );
  }
}

// ── ARM 2b: no superseded figure on a reader-facing surface, unannotated ──────────────────────────
const figures = deriveFigures();
for (const rel of READER_FACING) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue; // a release note may legitimately be consumed and removed
  const lines = fs.readFileSync(abs, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    if (line.includes(SUPERSEDED_MARK)) return; // explicitly annotated — the sanctioned form
    for (const fig of figures) {
      // Word-boundary match so "1780" or "2110" do not trip it.
      const re = new RegExp(`(^|[^0-9.])${fig.replace('%', '\\%')}([^0-9%]|$)`);
      if (re.test(line)) {
        failures.push(
          `${rel}:${i + 1} publishes the SUPERSEDED figure "${fig}" without a ${SUPERSEDED_MARK}…] ` +
          `annotation — \`${line.trim().slice(0, 90)}\`. This population is DERIVED from ` +
          `${FIGURE_AUTHORITY}, which says of these figures, verbatim, "Do not quote either." The live ` +
          `figure is 201 of 217.`,
        );
        return;
      }
    }
  });
}

const report = {
  countdownGuards: COUNTDOWN_GUARDS.length,
  citedPasses: CITED_COUNT,
  archivedVerdicts: (fs.existsSync(path.join(ROOT, ARCHIVE_DIR)) ? fs.readdirSync(path.join(ROOT, ARCHIVE_DIR)) : []).filter((f) => /^pass\d+-verdict\.md$/.test(f)).length,
  figuresDerived: figures.length,
  claimsDerived: wordings.length,
  matchersDerived: matchers.length,
  matchersSkippedTooShort: skippedShort,
  readerFacingSurfaces: READER_FACING.filter((r) => fs.existsSync(path.join(ROOT, r))).length,
  claimSurfaces: CLAIM_SURFACES.filter((r) => fs.existsSync(path.join(ROOT, r))).length,
  failures,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-account-matches-tree: clean — ${report.countdownGuards} countdown guard(s) reference the shared ` +
    `horizon symbol and declare no horizon-named numeric literal; ${report.figuresDerived} superseded ` +
    `figure(s) derived from ${FIGURE_AUTHORITY} absent from ${report.readerFacingSurfaces} reader-facing ` +
    `surface(s); ${report.claimsDerived} retired claim(s) derived from the tree's own annotations ` +
    `(${report.matchersDerived} matcher(s), ${report.matchersSkippedTooShort} skipped as too generic) ` +
    `absent from ${report.claimSurfaces} tracked surface(s); ${report.citedPasses} cited review pass(es), ` +
    `${report.archivedVerdicts} verdict(s) archived, contiguous.`,
  );
} else {
  console.error('\n❌ lint-account-matches-tree failed:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nWhy this exists: a long series of adversarial readings narrowed to one class — a closure claimed and ' +
    'not delivered. ' +
    'Both populations are DERIVED from their sources rather than transcribed, because a reading found ' +
    'that both hand-transcribed lists shipped narrower than the class their prose named.',
  );
}

process.exit(failures.length === 0 ? 0 : 1);
