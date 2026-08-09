#!/usr/bin/env node
/**
 * lint-registry-self-counts.mjs — a count the registry states about ITSELF must be true.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Stale self-description is the single most frequent defect this registry produces,
 * and it is not close. Measured on 2026-08-08 alone, across one night's work:
 *
 *   • the family intro announced "six properties" from 2026-05-23 to 2026-08-08,
 *     while holding thirty — false for over two months;
 *   • *Verify the State, Not Its Symbol* said "Three teeth" while enumerating five;
 *   • the same article said "no standard carries a fingerprint field" hours after
 *     six did;
 *   • the enforcement measurement doc said "86 of 87 lack one" against 82 of 88;
 *   • a paragraph said "a reader cannot see the tree" hours after the tree was
 *     rendered directly above it;
 *   • the deferral guard's headline carried 178/110/62% after the population had
 *     been re-measured twice, ending at 217/114/103.
 *
 * Every one was caught by an external reviewer, never by the author, and every one
 * had been false for hours or months. A number that goes stale silently is the
 * cheapest possible instance of *Documentation IS Being*: the document says a thing
 * about the world that the world no longer does, and nothing notices.
 *
 * ── The trigger is DISCOVERED, not declared ────────────────────────────────
 * Deliberately: a check that reads a hand-maintained list of "counts to verify"
 * has the same blind spot as the thing it guards — someone must remember to
 * register each claim, and the ones nobody registers are exactly the ones that rot.
 * So the count claims are found by scanning the registry's own prose for
 * self-referential count patterns, and a NEW claim is checked the moment it is
 * written, without anyone opting it in.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — every count claim in `docs/STANDARDS-REGISTRY.md` matching a
 *               recognised self-referential pattern, compared against the value
 *               re-derived from the document's own structure.
 *   CERTIFIED — a claim of one of those SHAPES is arithmetically true right now.
 *
 * **It does NOT certify that the registry's self-description is accurate.** Three
 * limits, all real, all demonstrated by the very examples above:
 *
 *   1. Only COUNTS are checkable this way. "A reader cannot see the tree" and
 *      "the gate already hard-blocks these modes" are stale STATE claims with no
 *      number in them; nothing here touches those, and they were two of the worst.
 *   2. Only RECOGNISED SHAPES are found. A count phrased in a way the patterns do
 *      not match is invisible, and the pattern list is mine, so its coverage is
 *      exactly as good as my imagination on the day. This is the same limit that
 *      made the deferral guard see 47% and then 89% of its subject while claiming
 *      the subject — named here, in the guard, rather than discovered later.
 *   3. A claim about a file OTHER than the registry (a spec's own counts, a lint
 *      header's measurements) is out of scope. Two of the six examples above live
 *      in such files.
 *
 * So this closes the cheapest third of a class it does not close. That is worth
 * building and worth not overstating.
 *
 * Exit codes: 0 — every recognised count claim is true; 1 — one is not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');
const REGISTRY_REL = 'docs/STANDARDS-REGISTRY.md';

const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const toNum = (t) => (WORDS[String(t).toLowerCase()] ?? Number(t));

const abs = path.join(ROOT, REGISTRY_REL);
if (!fs.existsSync(abs)) {
  console.error(`[registry-self-counts] ${REGISTRY_REL} is missing — refusing to report clean.`);
  process.exit(1);
}
const raw = fs.readFileSync(abs, 'utf-8');

// ── Re-derive the document's real structure (same parse as the sibling registry lints) ──
const lines = raw.split('\n');
const articles = [];
const families = [];
let current = null;
let fence = null;
for (const line of lines) {
  const t = line.trimStart();
  const f = t.match(/^(`{3,}|~{3,})/);
  if (fence === null && f) { fence = f[1]; if (current) current.body.push(line); continue; }
  if (fence !== null) { if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(t)) fence = null; if (current) current.body.push(line); continue; }
  const fam = line.match(/^##\s+(?!#)(.+?)\s*$/);
  if (fam) { families.push({ name: fam[1].trim(), articles: [] }); current = null; continue; }
  const h = line.match(/^###\s+(.+?)\s*$/);
  if (h) { current = { name: h[1].trim(), body: [], family: families[families.length - 1] }; articles.push(current); families[families.length - 1]?.articles.push(current); continue; }
  if (current) current.body.push(line);
}
if (articles.length === 0) {
  console.error('[registry-self-counts] parsed ZERO articles — the matcher is broken; refusing to report clean.');
  process.exit(1);
}

const familyByName = new Map(families.map((f) => [f.name.split('—')[0].trim().toLowerCase(), f]));
const lineOf = (idx) => raw.slice(0, idx).split('\n').length;

const failures = [];
const checked = [];

/** Record a checked claim; fail when the stated number is not the derived one. */
function check(kind, stated, derived, idx, hint) {
  checked.push({ kind, stated, derived });
  if (stated !== derived) {
    failures.push(
      `${REGISTRY_REL}:${lineOf(idx)} — the registry states ${kind} = ${stated}; the document itself yields ${derived}. ` +
      `${hint} A count about this file that this file contradicts is stale self-description — the defect that ran for over ` +
      `two months here ("six properties" against thirty) and four more times in a single night, every time caught by someone else.`,
    );
  }
}

// (1) "the family holds N articles" — a family's own article count.
for (const m of raw.matchAll(/the family holds\s+(\d+)\s+articles?/gi)) {
  const before = raw.slice(0, m.index);
  const famHead = [...before.matchAll(/^##\s+(?!#)(.+?)\s*$/gm)].pop();
  const fam = famHead ? familyByName.get(famHead[1].split('—')[0].trim().toLowerCase()) : null;
  if (!fam) continue;
  check(`"${fam.name.split('—')[0].trim()}" article count`, Number(m[1]), fam.articles.length, m.index,
    'The family heading it sits under is the one re-derived.');
}

// (2) "<Family> holds N articles of which M resolve" — count plus resolving count.
for (const m of raw.matchAll(/\b([A-Z][A-Za-z ]{2,20}?)\s+holds\s+(\d+)\s+articles?/g)) {
  const fam = familyByName.get(m[1].trim().toLowerCase());
  if (!fam) continue;
  check(`"${fam.name.split('—')[0].trim()}" article count`, Number(m[2]), fam.articles.length, m.index,
    'Named explicitly in the prose, so re-derived by name rather than by position.');
}

// (3) "N teeth" inside an article that enumerates **(A)**…**(E)** style teeth.
for (const a of articles) {
  const body = a.body.join('\n');
  const stated = body.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+teeth\b/i);
  if (!stated) continue;
  // Both marker forms the registry actually uses, discovered from the text rather than assumed:
  // `**(A) …` and `**TOOTH (E) …`. The first version of this check missed the second and reported a
  // false discrepancy against an article that was correct — recorded because a guard's first run
  // producing a wrong finding is the same class as a guard producing none.
  const letters = new Set([...body.matchAll(/\*\*(?:TOOTH\s+)?\(?([A-J])\)/g)].map((x) => x[1]));
  const enumerated = [...'ABCDEFGHIJ'].filter((L) => letters.has(L)).length;
  if (enumerated === 0) continue;
  check(`"${a.name}" tooth count`, toNum(stated[1]), enumerated, raw.indexOf(stated[0], raw.indexOf(`### ${a.name}`)),
    'Teeth are re-derived from the bold (A)…(J) markers the article itself enumerates.');
}

// (4) DELIBERATELY NOT CHECKED: "The other N articles declare no parent".
// That tally lives inside the GENERATED hierarchy block, whose own generator re-derives it and whose
// `--check` fails the build when it drifts. A first draft of this lint re-derived it independently —
// counting articles carrying the tree-node phrase — got 79 against the block's 75, and would have
// shipped a false finding against a correct number, because a relation is declared bidirectionally and
// a phrase count sees only one side. Two owners of one obligation is the defect *Remove What Demands
// Attention* names, and the weaker owner should not be the one that blocks a build. Left to its
// generator on purpose, and recorded rather than silently dropped.

const report = { articles: articles.length, families: families.length, claimsChecked: checked.length, checked, failures };

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-registry-self-counts: clean — ${checked.length} self-referential count claim(s) checked against the ` +
    `document's own structure (${articles.length} articles, ${families.length} families).`,
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-registry-self-counts failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
