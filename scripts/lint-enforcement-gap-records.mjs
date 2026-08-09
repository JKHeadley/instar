#!/usr/bin/env node
/**
 * lint-enforcement-gap-records.mjs — a GAP must be swept against every FINGERPRINT.
 *
 * ── Vocabulary (fixed by the operator, 2026-08-08) ─────────────────────────
 *   STANDARD     a rule we enforce
 *   SURFACE      a place where enforcement can act (12 CI workflows, 42 lints,
 *                2 git hooks, 33 scheduled jobs, 21 tone-gate rules, 11 response
 *                reviewers, 12 session hooks — counted, not asserted, in
 *                docs/specs/enforcement-fingerprint-measurement.md)
 *   MOMENT       when a surface acts (the closed set in
 *                scripts/lint-enforcement-fingerprint.mjs)
 *   ENFORCEMENT FINGERPRINT
 *                a standard's recorded mapping — which surfaces watch it at which
 *                moments, plus what its violations look like
 *   ENFORCEMENT GAP
 *                a recorded FAILURE-SHAPE — the way a violation slipped past a
 *                fingerprint
 *
 * ── Why this exists: the gap-propagation loop ──────────────────────────────
 * When a standard fails DESPITE a fingerprint, that failure is evidence about
 * FINGERPRINTS, not about that one standard. So a gap records the NATURE of how
 * it got through — the shape, stated so it can be matched against other
 * fingerprints — and is then SWEPT against all of them, so one failure upgrades
 * every standard sharing the hole-shape.
 *
 * The week that produced this is the proof: `alive-but-inert` appeared in three
 * independent guards inside 48 hours. Under this loop the first occurrence would
 * have flagged the other two before they failed.
 *
 * ── The teeth, and why they are these ──────────────────────────────────────
 * The failure mode of a registry like this is a sweep that was true once. A gap
 * swept against 1 fingerprint is not swept against 87, and nothing about the
 * record itself would say so — it would sit there looking complete while new
 * standards arrived unchecked. So:
 *
 *   (1) THREE LEGS REQUIRED. A gap states its shape (the nature, not just that it
 *       happened), which fingerprint it evaded and HOW, and the sweep.
 *   (2) SWEEP STALENESS AGAINST THE LIVE POPULATION. A sweep records the exact set
 *       of fingerprinted standards it ran against. That set is re-derived here from
 *       the registry. If a standard has gained a fingerprint since, EVERY sweep
 *       that predates it fails — you cannot add a fingerprint without checking it
 *       against every known failure-shape. This is the propagation loop's actual
 *       mechanism; the rest is bookkeeping.
 *   (3) THE SWEEP MUST PARTITION. matched ∪ unmatched must equal the population
 *       exactly. A sweep that quietly skipped a standard is the same defect as a
 *       matcher that stops at the first hit — silence reading as a clean pass.
 *   (4) AN UNSWEPT GAP IS VISIBLY UNSWEPT. `sweep: null` is legal and honest, but
 *       it requires a countdown date and fails once expired. A gap nobody ever
 *       propagated is not the same as a gap that propagated to nothing.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — every gap record carries its three legs; every sweep's population
 *               equals the live fingerprinted set and partitions it.
 *   CERTIFIED — no fingerprinted standard can exist that has not been LOOKED AT
 *               through every recorded failure-shape.
 *
 * **What it does NOT certify — the full list, because a short list here is the same
 * over-claim this registry exists to record** (external review, 2026-08-08, which
 * REJECTED an earlier draft of this file for declaring only the first item):
 *
 *   1. That a sweep was done WELL. A thin reason on every standard passes.
 *   2. **That a real failure ever BECOMES a gap record.** Every record here is
 *      VOLUNTARILY authored. Nothing detects an unrecorded failure, so the registry
 *      is silent about exactly the failures nobody wrote down — which is the
 *      population that matters most.
 *   3. **That a MATCH is ever acted on.** A matched fingerprint needs no
 *      remediation to stay green; the match is a finding, not a fix, and the loop
 *      does not close it.
 *   4. That an unswept gap gets swept — only that it is visibly unswept and dated.
 *   5. **That a re-touched verdict was RE-REACHED rather than RE-STAMPED.** The atDigest arm
 *      forces an author to open a verdict whose article changed; it cannot force them to
 *      reconsider it, and pasting the new digest passes. Named because the commit that
 *      introduced that arm claimed "a verdict must be re-reached rather than re-stamped" —
 *      which is `GAP-fix-restates-the-claim` committed inside the fix for the previous
 *      instance of it, caught by review pass 4 within the hour.
 *   6. That the digest notices everything that could stale a verdict. It covers the ARTICLE.
 *      A change to the cited guard's implementation, to a gap's own shape or sweep method, or
 *      to the evidence a verdict rests on, leaves every verdict machine-valid.
 *
 * So the honest name for what this check delivers is **freshness bookkeeping over
 * voluntarily authored records**, not failure capture and not automatic upgrade. The
 * phrase "one failure upgrades every standard sharing the hole-shape" describes the
 * PRACTICE this file supports; the machinery only guarantees that a recorded shape
 * cannot silently go unswept as fingerprints are added. Stating that gap plainly,
 * because a registry mistaken for proof of propagation would rebuild the defect it
 * exists to catch, one level up.
 *
 * Exit codes: 0 — clean; 1 — a malformed gap, a stale sweep, a non-partitioning
 * sweep, or an expired unswept gap.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkGrowOnlyAgainstHistory, validateEvidenceRef, canonicalDate } from './lib/baseline-history.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');
const GAPS_REL = 'docs/enforcement-gaps.json';
const FLOOR_REL = 'docs/enforcement-gaps-floor.json';
const REGISTRY_REL = 'docs/STANDARDS-REGISTRY.md';

// SAME shape the requirement lint uses (review pass 3, finding 8): the two lints previously
// disagreed — this one matched the bare phrase, so quoted or malformed prose could enter the sweep
// population while staying grandfathered by the requirement lint. Two definitions of one thing is
// the ambiguity this registry exists to remove.
const FINGERPRINT_RE = /\*\*Enforcement fingerprint\.\*\*\s*moments:\s*([a-z, -]+?)\s*(?:[;.]|\*\*|$)/;

/**
 * A sweep's population is CONTENT-ADDRESSED, not name-addressed. Storing names alone made the
 * freshness guarantee half-true: adding a standard staled every sweep, but CHANGING an existing
 * fingerprint's moments or surfaces staled nothing — so a sweep could describe an obsolete
 * fingerprint and still report clean. Found by external review pass 2 on the submitted data
 * itself: *Deferral = Deletion* had withdrawn its commit-time moment while every sweep record
 * still described it as covering commit-time, and this lint said clean. The digest is taken over
 * the fingerprint declaration through the end of the article, so any edit to the moments, the
 * surfaces, or the coverage argument stales every sweep that examined it.
 */
function fingerprintDigest(bodyText) {
  // WIDENED (review pass 3, finding 1): the digest was taken over the fingerprint declaration
  // onward, so an edit to the Rule or Applied-through — which can change what a standard demands
  // and therefore what a verdict about it means — staled nothing. It is now the WHOLE article body.
  // Over-sensitive on purpose: re-sweeping is cheap, a silently stale verdict is not.
  return crypto.createHash('sha256').update(bodyText.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/** Re-derive the live fingerprinted population from the registry — never trust a cached list. */
function fingerprintedStandards() {
  const abs = path.join(ROOT, REGISTRY_REL);
  const lines = fs.readFileSync(abs, 'utf-8').split('\n');
  const out = [];
  let current = null;
  let fence = null;
  for (const line of lines) {
    const t = line.trimStart();
    const f = t.match(/^(`{3,}|~{3,})/);
    if (fence === null && f) { fence = f[1]; if (current) current.body.push(line); continue; }
    if (fence !== null) { if (new RegExp(`^${fence[0]}{${fence.length},}\\s*$`).test(t)) fence = null; if (current) current.body.push(line); continue; }
    const h = line.match(/^###\s+(.+?)\s*$/);
    if (h) { current = { name: h[1].trim(), body: [] }; out.push(current); continue; }
    if (current) current.body.push(line);
  }
  if (out.length === 0) {
    console.error('[enforcement-gap-records] parsed ZERO articles — the matcher is broken; refusing to report clean.');
    process.exit(1);
  }
  return out
    .filter((a) => FINGERPRINT_RE.test(a.body.join('\n')))
    .map((a) => ({ name: a.name, digest: fingerprintDigest(a.body.join('\n')) }))
    .sort((x, y) => (x.name < y.name ? -1 : 1));
}

const gapsAbs = path.join(ROOT, GAPS_REL);
if (!fs.existsSync(gapsAbs)) {
  console.error(`[enforcement-gap-records] ${GAPS_REL} is missing — refusing to report clean.`);
  process.exit(1);
}

let doc;
try { doc = JSON.parse(fs.readFileSync(gapsAbs, 'utf-8')); } catch (err) {
  console.error(`[enforcement-gap-records] ${GAPS_REL} is unparseable: ${err.message}`);
  process.exit(1);
}

const gaps = Array.isArray(doc?.gaps) ? doc.gaps : null;
if (!gaps) {
  console.error(`[enforcement-gap-records] ${GAPS_REL} has no gaps array — refusing to report clean.`);
  process.exit(1);
}

const liveEntries = fingerprintedStandards();
// (5) THE GAP SET IS FLOORED, FROM OUTSIDE. Demonstrated by an independent reviewer: deleting a
// gap record made this lint report clean with one fewer gap, so the sweep obligation was escapable
// by removing the thing that creates it and the shape stopped propagating forever. A floor kept
// inside the file it floors is not a floor.
const floorAbs = path.join(ROOT, FLOOR_REL);
let floor = null;
try { floor = JSON.parse(fs.readFileSync(floorAbs, 'utf-8')); } catch { floor = null; }
const live = liveEntries.map((e) => e.name);
const liveSet = new Set(live);
const liveDigest = new Map(liveEntries.map((e) => [e.name, e.digest]));
const failures = [];
const today = new Date().toISOString().slice(0, 10);
const gapIdSeen = new Set();
for (const g of gaps) {
  if (!g?.id) continue;
  if (gapIdSeen.has(g.id)) failures.push(`${GAPS_REL} contains "${g.id}" more than once — two records under one id can disagree and both pass. (Pass 6 finding: the duplicate check covered only the floor.)`);
  gapIdSeen.add(g.id);
}

if (!floor || !Array.isArray(floor.knownGapIds)) {
  failures.push(`${FLOOR_REL} is missing or unparseable — refusing to report clean without the grow-only floor that makes a gap record undeletable.`);
} else {
  const present = new Set(gaps.map((g) => g?.id));
  const retired = new Set((floor.retired ?? []).map((r) => r?.id));
  for (const id of floor.knownGapIds) {
    if (present.has(id) || retired.has(id)) continue;
    failures.push(
      `${id} was recorded as an ENFORCEMENT GAP and is now ABSENT from ${GAPS_REL}. Deleting a gap ends its ` +
      `sweep obligation permanently and stops the shape propagating to every future standard — silently, with a ` +
      `green build. Restore it, or record a deliberate retirement in ${FLOOR_REL} with a reason.`,
    );
  }
  // The floor is only a floor if its own reference point is outside the commit. Review pass 5:
  // "deleting an ID simultaneously from both current JSON files passes; the purported external
  // grow-only floor is another editable list, not historical enforcement."
  failures.push(...checkGrowOnlyAgainstHistory({
    relPath: FLOOR_REL, cwd: ROOT, field: 'knownGapIds', current: floor.knownGapIds,
    retiredIds: (floor.retired ?? []).map((r) => r?.id).filter(Boolean), label: 'gap floor',
    envPrefix: 'ENFORCEMENT_GAP_FLOOR',
  }));
  failures.push(...checkGrowOnlyAgainstHistory({
    relPath: FLOOR_REL, cwd: ROOT, field: 'everSweptGapIds', current: floor.everSweptGapIds ?? [],
    retiredIds: (floor.retired ?? []).map((r) => r?.id).filter(Boolean), label: 'ever-swept floor',
    envPrefix: 'ENFORCEMENT_GAP_FLOOR',
  }));
  const seenFloorIds = new Set();
  for (const fid of floor.knownGapIds) {
    if (seenFloorIds.has(fid)) failures.push(`${FLOOR_REL} lists "${fid}" more than once — a duplicate id makes the floor's own count untrue.`);
    seenFloorIds.add(fid);
  }
  // A retirement is a deliberate act and must look like one. The note promised a reason; the check did not.
  for (const r of floor.retired ?? []) {
    const evErr = validateEvidenceRef(r?.evidence, ROOT);
    if (evErr) {
      failures.push(
        `${FLOOR_REL} retires "${r?.id ?? '?'}" — ${evErr}. Evidence is a JAILED repo-relative path plus the sha256 ` +
        `of its bytes (the shape standards-coverage.mjs already requires of auditRef/auditSha256), because a free ` +
        `string cannot be checked: the previous version accepted the literal value \`true\`.`,
      );
    }
    if (!canonicalDate(r?.at)) {
      failures.push(`${FLOOR_REL} retires "${r?.id ?? '?'}" with at=${JSON.stringify(r?.at)} — not a real, non-future YYYY-MM-DD date. The previous version accepted 9999-99-99.`);
    }
    const missing = ['id', 'reason'].filter((k) => !r?.[k] || String(r[k]).trim().length === 0);
    if (missing.length > 0) {
      failures.push(
        `${FLOOR_REL} retires "${r?.id ?? '?'}" without ${missing.join(', ')}. Retiring a failure-shape ends its ` +
        `propagation to every future standard, permanently — the note promised a reason, a date and evidence, and ` +
        `the check accepted a bare id, which is the promise-vs-mechanism gap this whole registry records.`,
      );
    } else if (String(r.reason).trim().length < 40) {
      failures.push(`${FLOOR_REL} retires "${r.id}" with a reason under 40 characters. A one-word reason is not a reason.`);
    }
  }
  for (const g of gaps) {
    if (g?.id && !floor.knownGapIds.includes(g.id)) {
      failures.push(`${g.id} is recorded in ${GAPS_REL} but absent from ${FLOOR_REL}'s knownGapIds. Add it — the floor is what makes it undeletable.`);
    }
  }
}
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
let swept = 0;

const nameOf = (entry) => (typeof entry === 'string' ? entry : entry?.standard);

for (const gap of gaps) {
  const id = gap?.id ?? '<no id>';

  // Leg 1 — the shape, stated as a NATURE that can be matched elsewhere.
  if (!gap?.shape || !gap?.shapeDescription) {
    failures.push(`${id} — a gap must record its SHAPE and a shapeDescription stating the NATURE of how a violation got through, not merely that one did. Without the nature there is nothing to match against other fingerprints, and the record cannot propagate.`);
  }
  // Leg 2 — which fingerprint it evaded, and HOW.
  const evadedName = String(gap?.evaded?.standard ?? '').replace(/\s*\(.*$/s, '').trim();
  const evadedResolves = liveDigest.has(evadedName);
  const allNames = new Set(liveEntries.map((e) => e.name));
  void allNames;
  if (gap?.evaded?.standard && !evadedResolves && gap?.evaded?.hadNoFingerprint !== true) {
    failures.push(
      `${id} — evaded.standard names "${evadedName}", which carries no enforcement fingerprint, and the record ` +
      `does not declare evaded.hadNoFingerprint. A gap that says a failure evaded a FINGERPRINT which never ` +
      `existed is manufactured enforcement inside the registry built to catch it (review pass 4 found exactly ` +
      `that here). Either name a fingerprinted standard, or set hadNoFingerprint:true and say what was actually ` +
      `there instead.`,
    );
  }
  if (!gap?.evaded?.standard || !gap?.evaded?.how) {
    failures.push(`${id} — a gap must name the FINGERPRINT it evaded (evaded.standard) and HOW it got past it (evaded.how). "It failed" is an outcome; this loop runs on the mechanism.`);
  }

  // Leg 3 — the sweep, or an honest, dated absence of one.
  const sweep = gap?.sweep ?? null;
  if (!sweep && (floor?.everSweptGapIds ?? []).includes(id)) {
    failures.push(
      `${id} has been SWEPT before and is now recorded as unswept. Freshness must run one way: a far-future countdown beside ` +
      `an honest-looking absence passed every arm while silently undoing work already done (found by independent injection). ` +
      `Restore the sweep, or record a deliberate retirement in ${FLOOR_REL} with a reason.`,
    );
  }
  if (!sweep) {
    if (!canonicalDate(gap?.countdown)) {
      failures.push(`${id} — is UNSWEPT (sweep: null) and its countdown is "${gap?.countdown}", not a YYYY-MM-DD date. An unvalidated countdown lets \`"never"\` sit green forever (review pass 3, finding 6).`);
    } else if (gap.countdown < today) {
      failures.push(`${id} — is UNSWEPT and its countdown ${gap.countdown} has expired. Sweep it against the ${live.length} fingerprinted standard(s), or close the gap honestly.`);
    }
    continue;
  }

  swept += 1;
  if (!canonicalDate(sweep.sweptAt)) {
    failures.push(`${id} — sweptAt is "${sweep.sweptAt}", not a YYYY-MM-DD date. An unvalidated date field is not a date: a sweep without one cannot be told apart from one that never happened.`);
  }

  const population = Array.isArray(sweep.fingerprintPopulation) ? sweep.fingerprintPopulation : null;
  if (!population) {
    failures.push(`${id} — the sweep records no fingerprintPopulation. The population is what makes staleness detectable; without it the sweep is a claim rather than a record.`);
    continue;
  }

  // (2) STALENESS — the propagation loop's actual mechanism.
  const popNames = population.map((e) => (typeof e === 'string' ? e : e?.standard)).filter(Boolean);
  const popSet = new Set(popNames);
  // (6) SET membership hid duplicates: two entries for one standard, or a verdict recorded twice,
  // passed every arm while the record silently disagreed with itself about that standard.
  if (popSet.size !== popNames.length) {
    const dupes = popNames.filter((n, i) => popNames.indexOf(n) !== i);
    failures.push(`${id} — fingerprintPopulation names ${[...new Set(dupes)].join(', ')} more than once. Set comparison hid it; the population must be exactly one record per standard, or two entries can disagree and both pass.`);
  }
  for (const bucket of ['matched', 'unmatched']) {
    const names = (Array.isArray(sweep[bucket]) ? sweep[bucket] : []).map((m) => (typeof m === 'string' ? m : m?.standard)).filter(Boolean);
    if (new Set(names).size !== names.length) {
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      failures.push(`${id} — ${bucket} records ${[...new Set(dupes)].join(', ')} more than once. Two verdicts on one standard can contradict each other and both pass.`);
    }
  }
  const newlyFingerprinted = live.filter((s) => !popSet.has(s));
  const goneFromRegistry = popNames.filter((s) => !liveSet.has(s));

  // CONTENT staleness — the arm name-only population could not express.
  const undigested = population.filter((e) => typeof e === 'string' || !e?.fingerprintDigest);
  if (undigested.length > 0) {
    failures.push(
      `${id} — ${undigested.length} population entr(ies) record only a NAME, with no fingerprintDigest. ` +
      `A name-addressed population cannot notice a fingerprint being CHANGED, so the sweep could describe ` +
      `an obsolete fingerprint and still pass. Record {"standard": "...", "fingerprintDigest": "..."} using ` +
      `the current digest.`,
    );
  }
  const changed = population
    .filter((e) => typeof e === 'object' && e?.standard && e?.fingerprintDigest && liveDigest.has(e.standard))
    .filter((e) => liveDigest.get(e.standard) !== e.fingerprintDigest);
  for (const e of changed) {
    failures.push(
      `${id} — the sweep examined "${e.standard}" at fingerprint ${e.fingerprintDigest} but its fingerprint is now ` +
      `${liveDigest.get(e.standard)}. The moments, surfaces or coverage argument CHANGED since this verdict was ` +
      `reached, so the recorded verdict describes a fingerprint that no longer exists. Re-sweep it and update the digest.`,
    );
  }
  if (newlyFingerprinted.length > 0) {
    failures.push(
      `${id} — the sweep of ${sweep.sweptAt ?? '?'} is STALE: ${newlyFingerprinted.length} standard(s) have gained a fingerprint since and were never checked against this failure-shape — ${newlyFingerprinted.join(', ')}. ` +
      `Sweep them, then update fingerprintPopulation. A gap that upgraded every standard EXCEPT the ones added afterwards is the propagation loop failing silently, which is this registry's own worst failure mode.`,
    );
  }
  if (goneFromRegistry.length > 0) {
    failures.push(`${id} — the sweep names ${goneFromRegistry.join(', ')}, which no longer carry a fingerprint in ${REGISTRY_REL}. Re-derive the population rather than leaving a record that refers to something absent.`);
  }

  // (3) PARTITION — matched ∪ unmatched must equal the population exactly.
  const matched = (Array.isArray(sweep.matched) ? sweep.matched : []).map(nameOf).filter(Boolean);
  const unmatched = (Array.isArray(sweep.unmatched) ? sweep.unmatched : []).map(nameOf).filter(Boolean);
  const verdicts = new Set([...matched, ...unmatched]);
  const both = matched.filter((s) => unmatched.includes(s));
  if (both.length > 0) {
    failures.push(`${id} — the sweep reaches CONTRADICTORY verdicts on ${both.join(', ')}: named in both matched and unmatched. A standard cannot both have and not have a failure-shape; the union test alone accepted this, which is the same over-claim this registry records.`);
  }
  const missing = popNames.filter((s) => !verdicts.has(s));
  const extra = [...verdicts].filter((s) => !popSet.has(s));
  if (missing.length > 0) {
    failures.push(`${id} — the sweep reaches no verdict on ${missing.join(', ')}: named in fingerprintPopulation but in neither matched nor unmatched. A skipped standard reads as a clean one, which is the same defect this registry records.`);
  }
  if (extra.length > 0) {
    failures.push(`${id} — the sweep reaches a verdict on ${extra.join(', ')}, which is not in its own fingerprintPopulation. The population must be the exact set swept.`);
  }
  for (const [bucket, entries] of [['matched', sweep.matched], ['unmatched', sweep.unmatched]]) {
    for (const m of Array.isArray(entries) ? entries : []) {
      const name = typeof m === 'string' ? m : m?.standard;
      if (!name || !liveDigest.has(name)) continue;
      const at = typeof m === 'object' ? m?.atDigest : undefined;
      if (typeof at !== 'string') {
        failures.push(`${id} — ${bucket} verdict on "${name}" records no atDigest. Bumping the POPULATION digest without touching the verdict left a substantively stale conclusion machine-clean (review pass 3, finding 1); a verdict must name the article state it was reached against.`);
      } else if (at !== liveDigest.get(name)) {
        failures.push(`${id} — ${bucket} verdict on "${name}" was reached at ${at} but the article is now ${liveDigest.get(name)}. Go and re-reach the verdict; note that this check can only force you to TOUCH it (see the certification list — re-thinking is not mechanically provable).`);
      }
    }
  }
  for (const m of Array.isArray(sweep.matched) ? sweep.matched : []) {
    if (typeof m === 'object' && m && typeof m.evidence !== 'string' && typeof m.action !== 'string') {
      failures.push(
        `${id} — matched standard "${m.standard ?? '?'}" carries a reason but no EVIDENCE and no ACTION. ` +
        `A match is an ACCUSATION about another standard, and a reason is cheap: on 2026-08-08 a match here was recorded ` +
        `against a guard that in fact had 19 proven refusal cases, because the shape FELT familiar and the check asked only ` +
        `for prose. Name what was actually run or read (a test file, an injection, a line of code), or the action it triggers.`,
      );
    }
  }
  for (const [bucket, entries] of [['matched', sweep.matched], ['unmatched', sweep.unmatched]]) {
    for (const m of Array.isArray(entries) ? entries : []) {
      if (typeof m === 'string' || typeof m?.why !== 'string' || m.why.trim().length < 20) {
        failures.push(
          `${id} — ${bucket} standard "${typeof m === 'string' ? m : (m?.standard ?? '?')}" gives no reason. ` +
          `A MATCH is a finding about another standard and is useless unexplained; an UNMATCH is the claim "I looked and this one does not have the shape", ` +
          `which is exactly the claim a bare name cannot support. Requiring a reason on BOTH sides is what makes "the question was asked in writing" true rather than asserted.`,
        );
      }
    }
  }
}

const report = { gaps: gaps.length, swept, unswept: gaps.length - swept, fingerprintedStandards: live.length, failures };

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-enforcement-gap-records: clean — ${gaps.length} gap(s), ${swept} swept against the live population of ` +
    `${live.length} fingerprinted standard(s)${report.unswept ? `, ${report.unswept} unswept (dated)` : ''}.`,
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-enforcement-gap-records failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
