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
 *   FINGERPRINT  a standard's recorded mapping — which surfaces watch it at which
 *                moments, plus what its violations look like
 *   GAP          a recorded FAILURE-SHAPE — the way a violation slipped past a
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
 * **It does NOT certify the sweep was done WELL.** A lazy author can write every
 * standard into `unmatched` with an empty reason and pass. What the check forces is
 * that the question was asked about each one, in writing, in the diff — the same
 * narrow guarantee the fingerprint check makes, and stated here for the same
 * reason: a registry mistaken for proof of propagation would rebuild the defect it
 * exists to catch, one level up.
 *
 * Exit codes: 0 — clean; 1 — a malformed gap, a stale sweep, a non-partitioning
 * sweep, or an expired unswept gap.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');
const GAPS_REL = 'docs/enforcement-gaps.json';
const REGISTRY_REL = 'docs/STANDARDS-REGISTRY.md';

const FINGERPRINT_RE = /\*\*Enforcement fingerprint\.\*\*/;

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
  return out.filter((a) => FINGERPRINT_RE.test(a.body.join('\n'))).map((a) => a.name).sort();
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

const live = fingerprintedStandards();
const liveSet = new Set(live);
const failures = [];
const today = new Date().toISOString().slice(0, 10);
let swept = 0;

const nameOf = (entry) => (typeof entry === 'string' ? entry : entry?.standard);

for (const gap of gaps) {
  const id = gap?.id ?? '<no id>';

  // Leg 1 — the shape, stated as a NATURE that can be matched elsewhere.
  if (!gap?.shape || !gap?.shapeDescription) {
    failures.push(`${id} — a gap must record its SHAPE and a shapeDescription stating the NATURE of how a violation got through, not merely that one did. Without the nature there is nothing to match against other fingerprints, and the record cannot propagate.`);
  }
  // Leg 2 — which fingerprint it evaded, and HOW.
  if (!gap?.evaded?.standard || !gap?.evaded?.how) {
    failures.push(`${id} — a gap must name the FINGERPRINT it evaded (evaded.standard) and HOW it got past it (evaded.how). "It failed" is an outcome; this loop runs on the mechanism.`);
  }

  // Leg 3 — the sweep, or an honest, dated absence of one.
  const sweep = gap?.sweep ?? null;
  if (!sweep) {
    if (!gap?.countdown) {
      failures.push(`${id} — is UNSWEPT (sweep: null) and carries no countdown date. An unswept gap must be visibly unswept with a deadline, never silently assumed to have propagated.`);
    } else if (gap.countdown < today) {
      failures.push(`${id} — is UNSWEPT and its countdown ${gap.countdown} has expired. Sweep it against the ${live.length} fingerprinted standard(s), or close the gap honestly.`);
    }
    continue;
  }

  swept += 1;
  if (!sweep.sweptAt) {
    failures.push(`${id} — the sweep carries no sweptAt date. A sweep without a date cannot be told apart from one that never happened.`);
  }

  const population = Array.isArray(sweep.fingerprintPopulation) ? sweep.fingerprintPopulation : null;
  if (!population) {
    failures.push(`${id} — the sweep records no fingerprintPopulation. The population is what makes staleness detectable; without it the sweep is a claim rather than a record.`);
    continue;
  }

  // (2) STALENESS — the propagation loop's actual mechanism.
  const popSet = new Set(population);
  const newlyFingerprinted = live.filter((s) => !popSet.has(s));
  const goneFromRegistry = population.filter((s) => !liveSet.has(s));
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
  const missing = population.filter((s) => !verdicts.has(s));
  const extra = [...verdicts].filter((s) => !popSet.has(s));
  if (missing.length > 0) {
    failures.push(`${id} — the sweep reaches no verdict on ${missing.join(', ')}: named in fingerprintPopulation but in neither matched nor unmatched. A skipped standard reads as a clean one, which is the same defect this registry records.`);
  }
  if (extra.length > 0) {
    failures.push(`${id} — the sweep reaches a verdict on ${extra.join(', ')}, which is not in its own fingerprintPopulation. The population must be the exact set swept.`);
  }
  for (const m of Array.isArray(sweep.matched) ? sweep.matched : []) {
    if (typeof m === 'object' && !m?.why) {
      failures.push(`${id} — matched standard "${m?.standard ?? '?'}" gives no reason. A match is a finding about another standard; unexplained, it cannot be acted on.`);
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
