#!/usr/bin/env node
/**
 * lint-model-registry-freshness.mjs — the model-registry FRESHNESS ratchet.
 *
 * THE PROBLEM (2026-07-03, operator directive): Instar's per-provider "capable/
 * latest/frontier" model pins rot SILENTLY. Nothing forces anyone to re-check
 * that (e.g.) the gemini `capable` tier still points at a current model — so
 * `gemini-2.5-pro` kept routing spec-review/converge work long after
 * Gemini 3-class shipped. A stale pin is invisible until it degrades output.
 *
 * THE GUARD (model-id-AGNOSTIC by construction): a deterministic check with
 * TWO teeth, both driven by scripts/model-registry-freshness.manifest.json —
 * the single human-edit surface:
 *
 *   TOOTH 1 — STALENESS. `lastReviewedAt` must be within `stalenessWindowDays`
 *     of today. An un-reviewed list ages out and fails LOUDLY, forcing a
 *     periodic "is each pin still frontier?" review + a date bump. This is the
 *     anti-rot mechanism: it fails even if no id ever changes.
 *
 *   TOOTH 2 — DRIFT. Every pinned capable/latest model id (extracted live from
 *     the real source files via each pin's regex) must be a member of that
 *     door's DERIVED frontier set (spec §1.4, docs/specs/DOORWAY-MODEL-KNOWLEDGE-
 *     REGISTRY-SPEC.md): the ids in `doors[door].topModels[]` carrying
 *     `frontier: true`. `topModels` is the ONE hand-edited structure; the
 *     frontier set is a *view* of it and cannot diverge by construction (this
 *     supersedes the old hand-maintained `frontierAllowlist` — a second list is
 *     exactly the rot this guard fights). A pin that names a model not in the
 *     derived set fails — either the pin is stale, or `topModels` wasn't updated.
 *     To go green a human must reconcile the two, which IS the review.
 *
 *     BACKWARD-COMPAT (un-enriched manifests): a door with a literal
 *     `frontierAllowlist[door]` and NO `topModels` is read from the literal list
 *     EXACTLY as before (no behavior change). A door with BOTH a literal
 *     `frontierAllowlist[door]` AND `topModels` emits a TRANSITION finding
 *     ("migrated to derived — delete the literal") so the old hand-list can't
 *     silently linger and re-rot; the derived set is authoritative there.
 *
 * Plus: `flaggedStale[]` entries (known-stale-pending-operator-confirmation) are
 * always printed as WARN lines and, under strict enforcement, count as findings.
 *
 * The guard NEVER hard-codes what the "right" model id is — it only asserts the
 * pins and the allowlist agree and that the review is fresh. Swapping to a new
 * frontier id is a manifest edit (allowlist + date), never a code change here.
 *
 * ENFORCEMENT (dark/reversible): manifest `enforcement` field —
 *   "report" (default) — prints findings, ALWAYS exits 0 (non-gating). Safe to
 *     wire into CI today while the current list is known-stale: it stays VISIBLE
 *     in the lint log without breaking the build.
 *   "strict" — exits 1 on any finding (staleness, drift, or a flaggedStale row).
 *     Flip here once the flagged door swaps are operator-confirmed + applied.
 *   Env INSTAR_MODEL_FRESHNESS_STRICT=1 forces strict for a one-off run.
 *
 * Exit codes:
 *   0 — no findings, OR findings under "report" enforcement (non-gating).
 *   1 — findings under "strict" enforcement, or a manifest/parse error.
 *
 * Usage:
 *   node scripts/lint-model-registry-freshness.mjs            # honor manifest enforcement
 *   INSTAR_MODEL_FRESHNESS_STRICT=1 node scripts/lint-model-registry-freshness.mjs
 *
 * Test overrides:
 *   INSTAR_MODEL_FRESHNESS_MANIFEST=<path>   # point at a fixture manifest
 *   INSTAR_MODEL_FRESHNESS_ROOT=<path>       # resolve pin files under this root
 *   INSTAR_MODEL_FRESHNESS_NOW=<ISO date>    # inject the clock (staleness tests)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.INSTAR_MODEL_FRESHNESS_ROOT
  ? path.resolve(process.env.INSTAR_MODEL_FRESHNESS_ROOT)
  : path.resolve(__dirname, '..');
const MANIFEST_PATH = process.env.INSTAR_MODEL_FRESHNESS_MANIFEST
  ? path.resolve(process.env.INSTAR_MODEL_FRESHNESS_MANIFEST)
  : path.join(__dirname, 'model-registry-freshness.manifest.json');

/**
 * Compute a door's effective frontier set — the ONE source of truth (spec §1.4).
 *
 *   DERIVED (schema v2): `doors[door].topModels` present (an array) → the set is
 *     the ids of entries with `frontier === true`. `topModels` is the only
 *     hand-edited structure; the frontier set is a view of it (cannot diverge).
 *   LITERAL (backward-compat): no `topModels` for the door but a literal
 *     `frontierAllowlist[door]` present → use it verbatim (un-enriched manifest,
 *     today's exact behavior).
 *   NONE: neither present → empty set (a pin on that door drifts, as before).
 *
 * `transition` is true when a door carries BOTH a literal `frontierAllowlist[door]`
 * AND `topModels` — the derived set is authoritative and a transition finding is
 * raised so the stale literal can't linger.
 *
 * @param {Record<string, any>} manifest
 * @param {string} door
 * @returns {{ set: string[], source: 'derived'|'literal'|'none', transition: boolean }}
 */
export function frontierSetForDoor(manifest, door) {
  const doorEntry = (manifest && manifest.doors && manifest.doors[door]) || null;
  const topModels = doorEntry && Array.isArray(doorEntry.topModels) ? doorEntry.topModels : null;
  const literal =
    manifest && manifest.frontierAllowlist && Array.isArray(manifest.frontierAllowlist[door])
      ? manifest.frontierAllowlist[door]
      : null;
  if (topModels) {
    const set = topModels
      .filter((m) => m && m.frontier === true && typeof m.id === 'string')
      .map((m) => m.id);
    return { set, source: 'derived', transition: literal !== null };
  }
  if (literal) return { set: literal, source: 'literal', transition: false };
  return { set: [], source: 'none', transition: false };
}

/**
 * Run the freshness check. Pure over its inputs (manifest + files under root +
 * the injected clock), so the unit test drives it directly with fixtures.
 * @returns {{ findings: string[], warnings: string[], info: string[], strict: boolean, error: string|null }}
 */
export function checkModelRegistryFreshness({
  manifestPath = MANIFEST_PATH,
  repoRoot = REPO_ROOT,
  now = process.env.INSTAR_MODEL_FRESHNESS_NOW
    ? new Date(process.env.INSTAR_MODEL_FRESHNESS_NOW)
    : new Date(),
  forceStrict = process.env.INSTAR_MODEL_FRESHNESS_STRICT === '1',
} = {}) {
  const findings = [];
  const warnings = [];
  const info = [];

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { findings: [], warnings: [], info: [], strict: true, error: `cannot read/parse manifest ${manifestPath}: ${e.message}` };
  }

  const strict = forceStrict || manifest.enforcement === 'strict';

  // --- TOOTH 1: staleness ---
  const reviewedRaw = manifest.lastReviewedAt;
  const reviewed = reviewedRaw ? new Date(reviewedRaw) : null;
  const windowDays = Number(manifest.stalenessWindowDays);
  if (!reviewed || Number.isNaN(reviewed.getTime())) {
    findings.push(`STALENESS: manifest.lastReviewedAt is missing or unparseable (got ${JSON.stringify(reviewedRaw)}).`);
  } else if (!Number.isFinite(windowDays) || windowDays <= 0) {
    findings.push(`STALENESS: manifest.stalenessWindowDays is missing or invalid (got ${JSON.stringify(manifest.stalenessWindowDays)}).`);
  } else {
    const ageDays = Math.floor((now.getTime() - reviewed.getTime()) / 86_400_000);
    if (ageDays > windowDays) {
      findings.push(
        `STALENESS: model registry last reviewed ${reviewedRaw} (${ageDays}d ago) exceeds the ${windowDays}d window. ` +
        `Re-review each capable/latest pin against current frontier, update frontierAllowlist if a model has moved, then bump lastReviewedAt.`
      );
    } else {
      info.push(`Staleness OK: reviewed ${reviewedRaw} (${ageDays}d ago, window ${windowDays}d).`);
    }
  }

  // --- TRANSITION: a door carrying BOTH a literal frontierAllowlist entry AND
  //     topModels has migrated to the derived set — flag the lingering literal so
  //     it can't silently re-rot (spec §1.4). Deduped per door, independent of pins.
  const doorsObj = manifest.doors || {};
  const litAllow = manifest.frontierAllowlist || {};
  for (const door of Object.keys(doorsObj)) {
    const entry = doorsObj[door];
    if (entry && Array.isArray(entry.topModels) && Array.isArray(litAllow[door])) {
      findings.push(
        `TRANSITION: door '${door}' has BOTH a literal frontierAllowlist['${door}'] and topModels[] — ` +
        `it migrated to the DERIVED frontier set (§1.4; the derived set is now authoritative). ` +
        `Delete the literal frontierAllowlist['${door}'] so the old hand-maintained list can't silently linger and re-rot.`
      );
    }
  }

  // --- TOOTH 2: drift (pin id must be in its door's DERIVED frontier set) ---
  for (const pin of manifest.pins || []) {
    const abs = path.join(repoRoot, pin.file);
    let src;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch {
      findings.push(`DRIFT: pin '${pin.id}' references ${pin.file} which is missing under ${repoRoot} (a pin site moved or was deleted — re-anchor it).`);
      continue;
    }
    let re;
    try {
      re = new RegExp(pin.regex);
    } catch (e) {
      findings.push(`DRIFT: pin '${pin.id}' has an invalid regex (${e.message}).`);
      continue;
    }
    const m = src.match(re);
    if (!m) {
      findings.push(`DRIFT: pin '${pin.id}' pattern did not match in ${pin.file} (the pinned site changed shape — re-anchor the regex).`);
      continue;
    }
    // All capture groups are candidate model ids (e.g. default + escalated).
    const ids = m.slice(1).filter(Boolean);
    const { set: doorFrontier, source } = frontierSetForDoor(manifest, pin.door);
    const setLabel =
      source === 'literal'
        ? `frontierAllowlist['${pin.door}']`
        : `the derived frontier set for '${pin.door}' (doors['${pin.door}'].topModels[frontier=true])`;
    for (const id of ids) {
      if (!doorFrontier.includes(id)) {
        findings.push(
          `DRIFT: pin '${pin.id}' (${pin.door}) pins '${id}' in ${pin.file}, which is NOT in ${setLabel} = [${doorFrontier.join(', ')}]. ` +
          `Either the pin is stale or the frontier set wasn't updated — reconcile the two (operator-confirm the frontier id).`
        );
      } else {
        info.push(`Drift OK: ${pin.door} '${pin.id}' -> '${id}' (in ${source === 'literal' ? 'allowlist' : 'derived frontier set'}).`);
      }
    }
  }

  // --- flaggedStale (known-stale-pending-confirmation): always WARN; strict counts them ---
  for (const f of manifest.flaggedStale || []) {
    const line =
      `FLAGGED-STALE: ${f.door} pin '${f.pin}' currently '${f.currentId}' -> suspected frontier '${f.suspectedFrontier}'. ` +
      `${f.evidence || ''} ${f.note || ''}`.trim();
    warnings.push(line);
    if (strict) findings.push(line);
  }

  return { findings, warnings, info, strict, error: null };
}

// --- CLI entry ---
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const res = checkModelRegistryFreshness();
  const B = '\x1b[1m', R = '\x1b[0m', Y = '\x1b[33m', RED = '\x1b[31m', G = '\x1b[32m';
  console.log(`${B}[lint-model-registry-freshness]${R} enforcement=${res.strict ? 'strict' : 'report'}`);

  if (res.error) {
    console.error(`${RED}ERROR:${R} ${res.error}`);
    process.exit(1);
  }
  for (const i of res.info) console.log(`  ${G}ok${R}   ${i}`);
  for (const w of res.warnings) console.log(`  ${Y}warn${R} ${w}`);
  for (const f of res.findings) console.log(`  ${RED}FIND${R} ${f}`);

  if (res.findings.length === 0) {
    console.log(`${G}PASS${R} — model registry pins fresh and in-allowlist.`);
    process.exit(0);
  }
  if (res.strict) {
    console.error(`${RED}FAIL${R} — ${res.findings.length} finding(s) under strict enforcement.`);
    process.exit(1);
  }
  console.log(
    `${Y}REPORT-ONLY${R} — ${res.findings.length} finding(s) surfaced but NOT gating (manifest enforcement="report"). ` +
    `Resolve them, then flip enforcement to "strict".`
  );
  process.exit(0);
}
