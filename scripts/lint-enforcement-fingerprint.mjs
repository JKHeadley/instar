#!/usr/bin/env node
/**
 * lint-enforcement-fingerprint.mjs — a NEW standard must say WHEN it is enforced.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Operator charter, 2026-08-08: for each standard, where and when and how is it
 * enforced — and how do we know that set of points is complete enough that
 * violations cannot sneak through between them?
 *
 * The motivating failure: the self-unblock standard passed every existence check
 * and still failed. The measurement pass
 * (`docs/specs/enforcement-fingerprint-measurement.md`) found the situation is
 * worse than "no guard at that moment" — FIVE blocking rules sit at the
 * escalation moment, the gate was live, and the violation passed anyway. The
 * reason nobody noticed is that no record anywhere says which MOMENTS a standard
 * is supposed to act at, so a hole at the decisive moment is invisible.
 *
 * The registry already records WHAT a standard demands and (often) WHICH guard
 * enforces it. It has never recorded WHEN. This check makes that field required
 * for every standard added from now on — catching the no-teeth-at-the-decisive-
 * moment class when the standard is WRITTEN rather than after its first failure.
 *
 * ── Vocabulary (fixed by the operator, 2026-08-08) ─────────────────────────
 *   STANDARD     a rule we enforce
 *   SURFACE      a place where enforcement can act
 *   MOMENT       when a surface acts — the closed set below
 *   ENFORCEMENT FINGERPRINT
 *                a standard's recorded mapping of surfaces to moments, plus what
 *                its violations look like — the field this check requires
 *   ENFORCEMENT GAP
 *                a recorded failure-shape: the way a violation slipped past a
 *                fingerprint. Gaps live in docs/enforcement-gaps.json and are swept
 *                against every fingerprint by scripts/lint-enforcement-gap-records.mjs,
 *                so a NEW fingerprint here stales every sweep there and must be
 *                checked against every known failure-shape before the build is green.
 *
 * ── The seven moments ──────────────────────────────────────────────────────
 * Measured from the tree, not invented (counts as of 2026-08-08):
 *
 *   author-time      session hooks + dispatch table            (12 hook scripts)
 *   commit-time      pre-commit, the instar-dev gate           (2 git hooks)
 *   push-time        pre-push                                  (2 git hooks)
 *   ci-time          25 CI jobs across 12 workflows, 42 lints
 *   outbound-message 21 tone-gate rules, 11 response reviewers
 *   periodic         33 shipped scheduled jobs
 *   runtime-floor    always-on floors (spawn cap, test-runner bound, …)
 *
 * A fingerprint names the moments where something acts on THIS standard, and
 * `none` is a legal and sometimes honest answer — an unguarded standard that
 * SAYS it is unguarded is exactly what the registry's countdown machinery is for.
 * What is not legal is silence.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — every `###` article outside the grandfathered baseline carries an
 *               `**Enforcement fingerprint.**` declaration naming at least one
 *               moment from the closed set above.
 *   CERTIFIED — a standard entering the registry from now on has had the "at
 *               which moment does this actually bite?" question PUT to its
 *               author, in writing, in the diff.
 *
 * **It does NOT certify that the fingerprint is TRUE**, that the named moment is
 * the one where violations occur, or that the surface at that moment is
 * effective — the measurement pass showed effectiveness is unmeasurable today for
 * the most consequential surface, because it keeps no verdict record. This check
 * forces the question to be answered, not the answer to be correct. Naming that,
 * because a fingerprint field mistaken for proof of coverage would rebuild this
 * week's central defect one level up.
 *
 * ── Why a grandfathered baseline ───────────────────────────────────────────
 * 87 existing articles have no fingerprint. Retrofitting them is real analysis
 * per standard, not a formatting pass, and the change that INTRODUCES a
 * requirement cannot also satisfy it 87 times. The baseline is SHRINK-ONLY: an
 * article may leave it by gaining a fingerprint, and may never be added back.
 *
 * Exit codes: 0 — clean; 1 — a new standard with no fingerprint, or a baseline
 * that grew.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkShrinkOnlyAgainstHistory } from './lib/baseline-history.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');
const UPDATE = process.argv.includes('--update-baseline');
const REGISTRY_REL = 'docs/STANDARDS-REGISTRY.md';
const BASELINE_REL = 'docs/enforcement-fingerprint-baseline.json';

/** The closed set of moments. A fingerprint naming something else is a typo, not a new moment. */
const MOMENTS = new Set([
  'author-time', 'commit-time', 'push-time', 'ci-time',
  'outbound-message', 'periodic', 'runtime-floor', 'none',
]);

const FINGERPRINT_RE = /\*\*Enforcement fingerprint\.\*\*\s*moments:\s*([a-z, -]+?)\s*(?:[;.]|\*\*|$)/;

const abs = path.join(ROOT, REGISTRY_REL);
if (!fs.existsSync(abs)) {
  console.error(`[enforcement-fingerprint] ${REGISTRY_REL} is missing — refusing to report clean.`);
  process.exit(1);
}

// Split into articles: heading → body. Same shape as the sibling registry lints.
const lines = fs.readFileSync(abs, 'utf-8').split('\n');
const articles = [];
let current = null;
let fence = null;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const t = line.trimStart();
  const f = t.match(/^(`{3,}|~{3,})/);
  if (fence === null && f) { fence = f[1]; if (current) current.body.push(line); continue; }
  if (fence !== null) { if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(t)) fence = null; if (current) current.body.push(line); continue; }
  const h = line.match(/^###\s+(.+?)\s*$/);
  if (h) { current = { name: h[1].trim(), lineNo: i + 1, body: [] }; articles.push(current); continue; }
  if (current) current.body.push(line);
}

if (articles.length === 0) {
  console.error('[enforcement-fingerprint] parsed ZERO articles — the matcher is broken; refusing to report clean.');
  process.exit(1);
}

const withFingerprint = [];
const badMoments = [];
for (const a of articles) {
  const m = a.body.join('\n').match(FINGERPRINT_RE);
  if (!m) continue;
  withFingerprint.push(a.name);
  const named = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = named.filter((n) => !MOMENTS.has(n));
  if (named.length === 0 || unknown.length > 0) {
    badMoments.push({ name: a.name, lineNo: a.lineNo, unknown });
  }
}

const fingerprinted = new Set(withFingerprint);

// NAME COLLISION — the sibling half of the refusal in lint-enforcement-gap-records.mjs. This lint
// reported "89 article(s), 7 fingerprinted" over a registry holding six distinct fingerprinted
// NAMES, because `withFingerprint` is an array and every set-membership question below is asked of
// `fingerprinted`, which is not. So the count it publishes and the population it actually reasons
// about were two different things, and the smaller one was the real one.
//
// That is this registry's own tooth (E) turned on this file: a check whose passing CONDITION is
// narrower than the CLAIM its result is read as certifying. "7 fingerprinted" was read as seven
// standards carrying enforcement declarations; what was verified was six. The gap between those two
// numbers is exactly where an unswept standard lives, and it was printed on screen every run.
//
// SCOPE, stated because pass 10 falsified the sentence that used to sit here: this arm covers ONLY the
// half of the collision space where the duplicate ALSO carries a fingerprint. The other half — a
// duplicate carrying none — is caught by the partition reconciliation below, which was added after this
// comment claimed a completeness it did not have.
//
// Refusing here, rather than only in the sweep guard, because the exact-membership baseline
// comparison below is also name-keyed: a duplicate cannot change `fingerprinted`, so a new
// fingerprinted standard sharing an existing heading would pass the membership check that exists to
// make a new fingerprint impossible to add silently.
const dupFingerprinted = [...new Set(withFingerprint.filter((n, i) => withFingerprint.indexOf(n) !== i))];
if (dupFingerprinted.length > 0) {
  console.error(
    `[enforcement-fingerprint] ${dupFingerprinted.length} article heading(s) carry an enforcement fingerprint ` +
    `MORE THAN ONCE: ${dupFingerprinted.map((d) => `"${d}"`).join(', ')}. Every membership question here is asked ` +
    `by heading, so a duplicate is invisible to the baseline comparison that exists to stop a fingerprint being ` +
    `added unnoticed. Give each article a distinct heading.`,
  );
  process.exit(1);
}

const missing = articles.filter((a) => !fingerprinted.has(a.name)).map((a) => a.name).sort();

// ── THE RECONCILIATION ────────────────────────────────────────────────────────────────────────────
// Added by external review pass 10, which falsified the certification written one increment earlier
// in this very file. That comment said: "after the refusal the printed count and the verified set are
// the same number by construction." It is not, and the counter-example is one line long.
//
// The refusal above covers only the half of the collision space where the DUPLICATE also carries a
// fingerprint. Append an article under an already-fingerprinted heading and give it NO fingerprint at
// all, and this lint prints `89 article(s), 6 fingerprinted, 82 grandfathered` and exits zero. Six
// plus eighty-two is eighty-eight. The new article is counted in neither bucket: it is absent from
// `withFingerprint` because it declares nothing, and absent from `missing` because `fingerprinted` is
// a Set of NAMES and its name is already in there, put there by the article it shadows. So a brand-new
// standard entered the document, evaded the requirement that every article carry a fingerprint or be
// grandfathered, and the arithmetic that exposes it was printed on screen — again.
//
// That is the SAME defect twice in two increments, and worth stating plainly rather than fixing
// quietly: the previous repair closed the demonstrated INSTANCE and then certified the CLASS. A claim
// whose proof covers a narrower case than the claim's words is the exact family this window exists to
// hunt, and I wrote a fresh one into the comment describing my fix for it.
//
// So this check is deliberately NOT another duplicate-name rule. It is the partition identity the lint
// already depends on and never asserted: every article lands in exactly one bucket. It holds no matter
// HOW an article goes missing — a duplicate heading, a parser change, a future bucket added without
// updating the arithmetic — because it compares the population to itself rather than enumerating the
// ways it can be wrong. The number was always there; nothing compared it.
const distinctNames = new Set(articles.map((a) => a.name));
if (distinctNames.size !== articles.length) {
  const dupAny = [...new Set(articles.map((a) => a.name).filter((n, i, all) => all.indexOf(n) !== i))];
  console.error(
    `[enforcement-fingerprint] ${dupAny.length} article heading(s) appear MORE THAN ONCE: ` +
    `${dupAny.map((d) => `"${d}"`).join(', ')}. Every bucket here is keyed by heading, so a repeat makes an ` +
    `article invisible to the fingerprint requirement — it is neither counted as fingerprinted nor reported as ` +
    `missing one. Give each article a distinct heading.`,
  );
  process.exit(1);
}
if (fingerprinted.size + missing.length !== articles.length) {
  console.error(
    `[enforcement-fingerprint] PARTITION BROKEN: ${articles.length} article(s), but ${fingerprinted.size} ` +
    `fingerprinted + ${missing.length} without a fingerprint = ${fingerprinted.size + missing.length}. ` +
    `Every article must land in exactly one bucket; the difference is articles this lint is not accounting ` +
    `for, and an unaccounted article is one the fingerprint requirement never reaches. Refusing to report clean ` +
    `over a population that does not add up.`,
  );
  process.exit(1);
}

const baseAbs = path.join(ROOT, BASELINE_REL);
let baseline = null;
if (fs.existsSync(baseAbs)) {
  try { baseline = JSON.parse(fs.readFileSync(baseAbs, 'utf-8')); } catch { baseline = null; }
}

if (UPDATE) {
  // PRESERVE the append-only rebaseline history. Found 2026-08-09 by running the real CI binding
  // end-to-end instead of trusting it: --update-baseline rewrote the whole file with a fresh object,
  // so the hash-chained `rebaselines` array was DESTROYED on every regeneration. A chain cannot
  // protect a file whose own writer drops the field — the regenerator was the hole in the ratchet.
  let priorRebaselines = [];
  let priorMeasuredAt;
  try {
    const prior = JSON.parse(fs.readFileSync(baseAbs, 'utf-8'));
    if (Array.isArray(prior?.rebaselines)) priorRebaselines = prior.rebaselines;
    priorMeasuredAt = prior?.measuredAt;
  } catch { /* establishing a new baseline */ }
  void priorMeasuredAt;
  fs.writeFileSync(baseAbs, `${JSON.stringify({
    schemaVersion: 1,
    note: 'Articles predating the enforcement-fingerprint requirement (charter 2026-08-08). SHRINK-ONLY: an article leaves this list by gaining a fingerprint and may never be added back. A NEW article must carry one. See scripts/lint-enforcement-fingerprint.mjs.',
    measuredAt: new Date().toISOString().slice(0, 10),
    grandfathered: missing,
    rebaselines: priorRebaselines,
  }, null, 2)}\n`);
  console.log(`[enforcement-fingerprint] baseline written: ${missing.length} grandfathered of ${articles.length} article(s).`);
  process.exit(0);
}

const failures = [];
const grandfathered = new Set(Array.isArray(baseline?.grandfathered) ? baseline.grandfathered : []);

if (!baseline) {
  failures.push(`${BASELINE_REL} is missing or unparseable — run with --update-baseline. Refusing to report clean without a baseline to ratchet against.`);
} else {
  for (const name of missing) {
    if (grandfathered.has(name)) continue;
    const a = articles.find((x) => x.name === name);
    failures.push(
      `${REGISTRY_REL}:${a?.lineNo ?? '?'} — "${name}" is a NEW standard with no enforcement fingerprint. ` +
      `Add: **Enforcement fingerprint.** moments: <one or more of ${[...MOMENTS].join(', ')}>; plus which surface ` +
      `acts at each and the coverage argument. A standard whose violations occur at a moment nothing watches is a ` +
      `hole — this field is how that becomes visible when the standard is WRITTEN rather than after its first ` +
      `failure. \`none\` is a legal answer; silence is not.`,
    );
  }
  if (missing.length > grandfathered.size) {
    failures.push(`articles without a fingerprint rose from ${grandfathered.size} to ${missing.length} — the baseline is shrink-only.`);
  }
  // EXACT MEMBERSHIP, not a count. External review pass 2 finding 2: comparing sizes let a
  // fingerprinted article STAY on the grandfathered list, so (a) the "N grandfathered" figure was
  // false, and (b) an article could silently LOSE its fingerprint and still pass, because the list
  // still exempted it. A count-based ratchet exempts by arithmetic; membership exempts by name.
  const knownArticles = new Set(articles.map((a) => a.name));
  for (const name of [...grandfathered].filter((n) => !knownArticles.has(n))) {
    failures.push(
      `${BASELINE_REL} exempts "${name}", which is NOT an article in the registry. Deleting or renaming a ` +
      `grandfathered article left a phantom exemption: the count is false, and a later article taking the same ` +
      `name would silently INHERIT the old exemption. Membership must be exact in BOTH directions (review pass 3, finding 2).`,
    );
  }
  failures.push(...checkShrinkOnlyAgainstHistory({
    relPath: BASELINE_REL, cwd: ROOT, field: 'grandfathered', current: [...grandfathered],
    label: 'fingerprint exemption baseline', envPrefix: 'ENFORCEMENT_FINGERPRINT',
  }));
  const staleExemptions = [...grandfathered].filter((name) => fingerprinted.has(name));
  for (const name of staleExemptions) {
    failures.push(
      `${BASELINE_REL} still exempts "${name}", which now CARRIES a fingerprint. Remove it — an article that has ` +
      `left the baseline must leave the list, or the exemption silently survives a later removal of its fingerprint ` +
      `and the grandfathered count is a false number.`,
    );
  }
}

for (const bad of badMoments) {
  failures.push(
    `${REGISTRY_REL}:${bad.lineNo} — "${bad.name}" declares a fingerprint naming ${bad.unknown.length ? `unknown moment(s) ${bad.unknown.join(', ')}` : 'no moment'}. ` +
    `The moment set is closed: ${[...MOMENTS].join(', ')}. An unrecognised moment is a typo that would silently ` +
    `exempt the article from the only check on this field.`,
  );
}

const report = {
  articles: articles.length,
  fingerprinted: withFingerprint.length,
  missing: missing.length,
  grandfathered: grandfathered.size,
  failures,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-enforcement-fingerprint: clean — ${articles.length} article(s), ${withFingerprint.length} fingerprinted, ` +
    `${grandfathered.size} grandfathered (shrink-only, exact membership).`,
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-enforcement-fingerprint failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
