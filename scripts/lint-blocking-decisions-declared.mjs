#!/usr/bin/env node
/**
 * lint-blocking-decisions-declared.mjs — every code site that can BLOCK, REFUSE
 * or GATE must be visible to the enforcement apparatus.
 *
 * Enforces the constitutional standard **"A Decision That Can Block Must Live
 * Where the Checks Can See It"** (Standards Registry, The Substrate; a tree node
 * under *Observation Needs Structure*).
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — every `.sh` / `.js` / `.mjs` file under `src/templates/` is
 *               DECLARED, in the baseline manifest, as either a blocking
 *               decision surface or a non-blocking one; the blocking set has not
 *               grown past its committed ceiling; and every non-blocking
 *               declaration still matches the bytes it was made against.
 *   CERTIFIED — no blocking decision has been ADDED to this population without
 *               someone declaring it, and no file previously declared harmless
 *               has changed underneath its declaration.
 *
 * It does NOT certify that the twelve declared blockers behave correctly, nor
 * that the population is the only place blocking decisions live. It certifies
 * that this population cannot grow a blocking decision *silently*.
 *
 * What input passes this check while failing the claim? A change to a file that
 * is ALREADY declared blocking — it stays declared, so the ratchet stays quiet
 * while the decision changes. That is in scope for review, not for this check,
 * and it is named here rather than left to be discovered.
 *
 * ── Why a manifest rather than pattern-detection ───────────────────────────
 * A regex hunting `exit 2` / `"decision":"block"` would be a check whose passing
 * condition is narrower than its claim: it finds the refusal shapes it knows and
 * reports silence for the rest. A declaration forces a HUMAN verdict on every
 * file in the population, and the ratchet only holds the verdict in place.
 *
 * ── The shrink-only contract ───────────────────────────────────────────────
 * `blocking[]` may only shrink against `blockingCeiling`. The remedy for a new
 * blocking decision is to author it in TypeScript, where the ratchets already
 * look — not to raise the ceiling. Raising it is possible, deliberate, and
 * visible in review, which is the point.
 *
 * Earned from the 2026-08-05 F10 census (docs/audits/phase-b/f10-triage.md):
 * 26 files, 12 genuine blocking decision surfaces, and — measured, not assumed —
 * MUST-BE-SHELL 0. Two guards that Phase A recorded as sharing a use-versus-
 * mention defect are both on that list; the better explanation is that they
 * share a defect because they share the condition of being unwatched.
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-blocking-decisions-declared.mjs
 *   node scripts/lint-blocking-decisions-declared.mjs --json
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const MANIFEST_REL = 'scripts/blocking-decision-surfaces-baseline.json';
const POPULATION_DIR = 'src/templates';
const EXTENSIONS = new Set(['.sh', '.js', '.mjs']);
const JSON_OUT = process.argv.includes('--json');

/** Hash LF-normalized bytes so a CRLF checkout does not manufacture drift. */
function sha256OfFile(abs) {
  const raw = fs.readFileSync(abs);
  return crypto.createHash('sha256').update(raw.toString('binary').replace(/\r\n/g, '\n'), 'binary').digest('hex');
}

function walk(absDir, relBase, out) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const abs = path.join(absDir, entry.name);
    const rel = path.posix.join(relBase, entry.name);
    if (entry.isSymbolicLink()) continue; // never follow a symlink out of the population
    if (entry.isDirectory()) walk(abs, rel, out);
    else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) out.push(rel);
  }
  return out;
}

const failures = [];
const manifestAbs = path.join(ROOT, MANIFEST_REL);

if (!fs.existsSync(manifestAbs)) {
  console.error(`[blocking-decisions-declared] MISSING manifest ${MANIFEST_REL} — the ratchet cannot run.`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf-8'));
} catch (err) {
  console.error(`[blocking-decisions-declared] manifest is unparseable: ${err.message}`);
  process.exit(1);
}

const populationAbs = path.join(ROOT, POPULATION_DIR);
if (!fs.existsSync(populationAbs)) {
  // Fail LOUD, never silently clean: an empty population would otherwise read as
  // "no undeclared blockers", which is the false all-clear this standard exists
  // to refuse.
  console.error(`[blocking-decisions-declared] population directory ${POPULATION_DIR} does not exist — refusing to report clean.`);
  process.exit(1);
}

const onDisk = walk(populationAbs, POPULATION_DIR, []).sort();
const blocking = Array.isArray(manifest.blocking) ? manifest.blocking : [];
const nonBlocking = Array.isArray(manifest.nonBlocking) ? manifest.nonBlocking : [];
const ceiling = Number.isInteger(manifest.blockingCeiling) ? manifest.blockingCeiling : null;

const declared = new Map();
for (const e of blocking) declared.set(e.path, { kind: 'blocking', entry: e });
for (const e of nonBlocking) {
  if (declared.has(e.path)) failures.push(`${e.path} is declared BOTH blocking and non-blocking`);
  declared.set(e.path, { kind: 'nonBlocking', entry: e });
}

// (1) Every file in the population carries a declaration.
for (const rel of onDisk) {
  if (!declared.has(rel)) {
    failures.push(
      `UNDECLARED ${rel} — a new file in the blocking-decision population. Declare it in ` +
      `${MANIFEST_REL}: as "blocking" (and prefer authoring the decision in TypeScript instead), ` +
      `or as "nonBlocking" with a reason and its sha256.`,
    );
  }
}

// (2) No declaration points at a file that is gone (a dangling declaration reads
//     as coverage while covering nothing).
const onDiskSet = new Set(onDisk);
for (const [rel] of declared) {
  if (!onDiskSet.has(rel)) failures.push(`STALE DECLARATION ${rel} — declared in the manifest but not present on disk; remove it.`);
}

// (3) The blocking set is shrink-only against its committed ceiling.
if (ceiling === null) {
  failures.push('manifest has no integer blockingCeiling — the shrink-only contract cannot be enforced.');
} else if (blocking.length > ceiling) {
  failures.push(
    `BLOCKING SET GREW to ${blocking.length}, ceiling ${ceiling}. The remedy is to author the decision ` +
    `in TypeScript where the ratchets already look, not to raise the ceiling.`,
  );
}

// (4) Non-blocking declarations are content-pinned.
for (const e of nonBlocking) {
  if (!onDiskSet.has(e.path)) continue; // already reported as stale above
  if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) {
    failures.push(`${e.path} is declared non-blocking without a valid sha256 pin.`);
    continue;
  }
  const actual = sha256OfFile(path.join(ROOT, e.path));
  if (actual !== e.sha256) {
    failures.push(
      `RE-DECLARE ${e.path} — declared non-blocking, but its contents changed. Confirm it still makes ` +
      `no blocking decision, then update its sha256 to ${actual}.`,
    );
  }
}

const report = {
  population: onDisk.length,
  blocking: blocking.length,
  blockingCeiling: ceiling,
  nonBlocking: nonBlocking.length,
  failures,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-blocking-decisions-declared: clean — ${onDisk.length} file(s) in the population, ` +
    `${blocking.length}/${ceiling} declared blocking (shrink-only), ${nonBlocking.length} content-pinned as non-blocking.`,
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-blocking-decisions-declared failed:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\nWhy this exists: a blocking decision authored where the ratchets do not walk is unwatched by ` +
    `construction, and an unwatched decision surface does not stay correct because nothing could notice ` +
    `it drifting. See docs/proposals/standard-proposal-decisions-live-where-checks-can-see-them.md\n`,
  );
  process.exit(1);
}
