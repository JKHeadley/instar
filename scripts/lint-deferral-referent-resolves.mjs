#!/usr/bin/env node
/**
 * lint-deferral-referent-resolves.mjs — a tracked deferral must point at something.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * *Deferral = Deletion* says a deferral without owned follow-through is a
 * deletion. The existing guard (`instar-dev-precommit.js` step 7.5) enforces
 * that a spec containing deferral language carries a tracking marker — and it
 * has been doing that job correctly since it was written.
 *
 * But it checks that a MARKER EXISTS. It cannot check that the marker refers to
 * anything, because the commitment and evolution-action registries the markers
 * point into are PER-MACHINE RUNTIME STATE (`.instar/`), not tracked in the
 * repository. A build has no way to resolve `ACT-1153`.
 *
 * Measured on 2026-08-08 across `docs/specs/`: **194 distinct tracked deferral
 * marker ids, of which 104 (54%) resolve to nothing anywhere in the repository.**
 * (An earlier figure of 178 / 110 / 62% is SUPERSEDED — it was measured over the
 * narrower prose-id population this guard originally used, before external review
 * rejected that population as narrower than its name. Do not quote it.) For
 * those, "tracked" is an unfalsifiable claim — the exact shape the standard was
 * written to forbid, wearing a tracking number.
 *
 * This is the difference the operator asked for on 2026-08-08: a guard that
 * verifies FUNCTION rather than existence. Existence = a marker is present.
 * Function = the marker refers to something a reader can follow.
 *
 * ── What this measures, and what it certifies ──────────────────────────────
 * Declared explicitly, per *Verify the State, Not Its Symbol* tooth (D):
 *
 *   MEASURED  — every id inside a `<!-- tracked: <id> -->` MARKER in `docs/specs/`
 *               (the population the commit-time step admits, whatever its id form),
 *               and whether that id appears ANYWHERE in the repository outside
 *               `docs/` (source, tests, fixtures, config).
 *   CERTIFIED — a NEW tracked deferral points at something the repository can
 *               show a reader, rather than at machine-local state no reviewer
 *               and no build can reach.
 *
 * **It does NOT certify that the deferral was KEPT.** An id referenced by a test
 * resolves here whether the underlying work shipped, stalled, or was abandoned.
 * The honest test — did this promise reach a terminal state — requires the
 * commitment/action registries, which are runtime state outside the repo, and is
 * therefore NOT checkable at build time by anything. That residual is real and
 * is named in the standard rather than implied away by this check's existence.
 *
 * What input passes this check while failing the claim? An author who writes a
 * tracked id into a test comment and nothing else. That resolves, and follows
 * through on nothing. Naming it, not hiding it.
 *
 * Boundary worth knowing, learned by getting it wrong while proving this guard:
 * the resolving corpus is `git ls-files`, so an UNTRACKED file cannot resolve a
 * marker. That is correct — an uncommitted file is not something a reviewer can
 * follow — but it means a referent added in the same working tree does not count
 * until it is staged. My first injection test failed for exactly this reason and
 * I briefly mistook a correct refusal for a broken check.
 *
 * ── Why a baseline ─────────────────────────────────────────────────────────
 * 104 pre-existing orphans cannot be fixed by the change that discovers them —
 * each needs its referent found or the deferral honestly closed. The baseline is
 * SHRINK-ONLY: the count may never rise, so the debt can only be paid down. A
 * new orphan fails immediately.
 *
 * Exit codes: 0 — clean; 1 — a new orphan, or a baseline that grew.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const JSON_OUT = process.argv.includes('--json');
const UPDATE = process.argv.includes('--update-baseline');
const BASELINE_REL = 'docs/deferral-referent-baseline.json';

/**
 * POPULATION — every id inside a tracking MARKER, which is the thing the commit-time
 * step actually admits: `<!-- tracked: <id> -->` with the SAME character class that
 * step accepts. Widened 2026-08-08 after an external review REJECTED the narrower
 * version: the original matched `CMT-\d+` / `ACT-\d+` anywhere in prose, which (a) let
 * a bare mention of an id count as a tracked deferral and (b) MISSED every marker
 * using any other id form. Measured at the moment of the fix: of 194 distinct marker
 * ids in docs/specs, only 92 were CMT/ACT-numeric — **102 (53%) were invisible to the
 * guard that claimed to police them.** A guard covering 47% of its own subject while
 * claiming the subject is the shape this whole window exists to catch.
 */
const MARKER_RE = /<!--\s*tracked:\s*([A-Za-z0-9._/-]+)\s*-->/g;
/** Resolving mentions may appear as bare ids anywhere outside docs/. */
const idPattern = (id) => new RegExp(`(?:^|[^A-Za-z0-9._/-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._/-])`);

/** Files that may RESOLVE a marker — anything a reader can follow that is not the prose asserting it. */
function repoFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').filter(Boolean);
}

const files = repoFiles();
if (files.length === 0) {
  console.error('[deferral-referent] git ls-files returned nothing — refusing to report clean.');
  process.exit(1);
}

const specFiles = files.filter((f) => f.startsWith('docs/specs/') && f.endsWith('.md'));
// A marker is RESOLVED by a mention outside the spec prose. Docs are excluded from the
// resolving set on purpose: one document citing another's promise is not follow-through,
// it is the same claim repeated.
const resolvingFiles = files.filter((f) => !f.startsWith('docs/') && !f.includes('node_modules/'));

const declared = new Map(); // id -> Set(spec paths)
for (const rel of specFiles) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), 'utf-8'); } catch { continue; }
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(text)) !== null) {
    const id = m[1];
    if (!declared.has(id)) declared.set(id, new Set());
    declared.get(id).add(rel);
  }
}

if (declared.size === 0) {
  console.error('[deferral-referent] parsed ZERO tracked deferral ids — the matcher is broken; refusing to report clean.');
  process.exit(1);
}

// One pass over the resolving corpus rather than one grep per id.
const resolved = new Set();
const wanted = [...declared.keys()].map((id) => ({ id, re: idPattern(id) }));
for (const rel of resolvingFiles) {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, rel), 'utf-8'); } catch { continue; }
  for (const w of wanted) {
    if (resolved.has(w.id)) continue;
    if (w.re.test(text)) resolved.add(w.id);
  }
}

const orphans = [...declared.keys()].filter((id) => !resolved.has(id)).sort();

const abs = path.join(ROOT, BASELINE_REL);
let baseline = null;
if (fs.existsSync(abs)) {
  try { baseline = JSON.parse(fs.readFileSync(abs, 'utf-8')); } catch { baseline = null; }
}

if (UPDATE) {
  fs.writeFileSync(abs, `${JSON.stringify({
    schemaVersion: 1,
    note: 'Tracked deferral ids that resolve to nothing outside the prose declaring them. SHRINK-ONLY: this list may lose entries as referents are found or deferrals honestly closed, and may never gain one. See scripts/lint-deferral-referent-resolves.mjs.',
    measuredAt: new Date().toISOString().slice(0, 10),
    orphans,
  }, null, 2)}\n`);
  console.log(`[deferral-referent] baseline written: ${orphans.length} orphan(s) of ${declared.size} tracked id(s).`);
  process.exit(0);
}

const failures = [];
const baselineSet = new Set(Array.isArray(baseline?.orphans) ? baseline.orphans : []);

if (!baseline) {
  failures.push(`${BASELINE_REL} is missing or unparseable — run with --update-baseline to establish it. Refusing to report clean without a baseline to ratchet against.`);
} else {
  const added = orphans.filter((id) => !baselineSet.has(id));
  for (const id of added) {
    const where = [...(declared.get(id) ?? [])].join(', ');
    failures.push(
      `${id} is tracked as a deferral in ${where} but resolves to NOTHING anywhere in the repository. ` +
      `A tracking marker that refers to machine-local state no build and no reviewer can reach is an ` +
      `unfalsifiable promise — the deletion this standard forbids, wearing a tracking number. Point it at ` +
      `something OUTSIDE docs/ that a reader can follow — a test, the code that implements it, a fixture, a config ` +
      `entry. A mention in another document does NOT resolve it: one document citing another's promise is the same ` +
      `claim repeated, not follow-through. Otherwise, close the deferral honestly.`,
    );
  }
  if (orphans.length > baselineSet.size) {
    failures.push(`orphan count rose from ${baselineSet.size} to ${orphans.length} — the baseline is shrink-only.`);
  }
}

const report = {
  trackedIds: declared.size,
  resolved: declared.size - orphans.length,
  orphans: orphans.length,
  baseline: baselineSet.size,
  failures,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (failures.length === 0) {
  console.log(
    `lint-deferral-referent-resolves: clean — ${declared.size} tracked deferral id(s), ` +
    `${report.resolved} resolve, ${orphans.length} orphaned (baseline ${baselineSet.size}, shrink-only).`,
  );
}

if (failures.length > 0) {
  console.error('\n❌ lint-deferral-referent-resolves failed:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
