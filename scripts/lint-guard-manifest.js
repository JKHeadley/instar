#!/usr/bin/env node
/**
 * lint-guard-manifest.js — the guard-inventory CI ratchet
 * (GUARD-POSTURE-ENDPOINT-SPEC §2.1, "CI ratchet (manifest-driven, repo-wide)").
 *
 * THE RULE: every guard-shaped component in src/monitoring, src/messaging,
 * src/lifeline, src/core must be CLASSIFIED — it appears either as a
 * `component:` in GUARD_MANIFEST (it IS an inventory guard) or in NOT_A_GUARD
 * (it deliberately is not, with a real reason). A future guard cannot be
 * forgotten from the /guards inventory: the moment its file lands, this lint
 * fails until someone makes the classification decision explicitly
 * (Structure > Willpower — same contract as lint-dev-agent-dark-gate.js +
 * DARK_GATE_EXCLUSIONS).
 *
 * Three assertions:
 *
 *   A. EVERY CANDIDATE CLASSIFIED — a candidate component is (1) a .ts file in
 *      one of the four dirs whose basename matches the guard-shape suffix
 *      pattern (Sentinel|Reaper|Watchdog|Guard|Tripwire|Monitor|Beacon|
 *      Detector|Promoter|Pauser|Backstop), component name = basename, OR
 *      (2) a name in ADDITIONAL_CANDIDATES (enabled-gated boot constructs
 *      whose filenames don't match the pattern, e.g. QuotaTracker, PromptGate).
 *      Each candidate must appear in GUARD_MANIFEST's `component:` fields or
 *      in NOT_A_GUARD.
 *
 *   B. REAL REASONS — every NOT_A_GUARD entry's reason must be ≥12
 *      non-whitespace chars (defeats placeholder reasons; same bar as
 *      DARK_GATE_EXCLUSIONS).
 *
 *   C. EXACTLY ONE LIST — a component must not appear in BOTH GUARD_MANIFEST
 *      and NOT_A_GUARD (a dual classification is a contradiction the
 *      inventory cannot resolve).
 *
 * LIMITATIONS (P2 Signal-vs-Authority — do NOT claim full closure):
 *   - Detection is the file-basename suffix pattern + the explicit
 *     ADDITIONAL_CANDIDATES list. A guard-shaped component in a file whose
 *     name matches neither (e.g. a guard class defined inside server.ts)
 *     evades detection until someone names it in ADDITIONAL_CANDIDATES.
 *     Deliberate: cheap, deterministic, explainable — the precedent's
 *     pragmatism over an AST-grade analyzer.
 *   - The manifest is parsed STATICALLY (regex over the source — this lint
 *     must not import TS). `component:` and `reason:` must be single-line
 *     'single-' or "double-quoted" string literals, which is the file's
 *     enforced house style; a template-literal or multi-line reason would be
 *     invisible to the parse (and the entry would then fail assertion A,
 *     loudly, not silently pass).
 *
 * Exit codes:
 *   0 — no violations.
 *   1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-guard-manifest.js              # full scan of the four dirs
 *   node scripts/lint-guard-manifest.js path1 path2  # specific candidate files
 *
 * Test override:
 *   INSTAR_GUARDLINT_MANIFEST=<path>  # point the parse at a fixture manifest
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const MANIFEST_REL = 'src/monitoring/guardManifest.ts';
const MANIFEST_ABS = process.env.INSTAR_GUARDLINT_MANIFEST
  ? path.resolve(process.env.INSTAR_GUARDLINT_MANIFEST)
  : path.join(ROOT, MANIFEST_REL);

// The repo-wide scan boundary (spec §2.1: "in ANY of src/monitoring,
// src/messaging, src/lifeline, src/core" — path-pattern linting scoped to one
// directory would miss the spec's own canonical examples).
const GUARD_DIRS = ['src/monitoring', 'src/messaging', 'src/lifeline', 'src/core'];

// Guard-shape detection 1: the basename suffix pattern.
const GUARD_SHAPE_BASENAME =
  /(Sentinel|Reaper|Watchdog|Guard|Tripwire|Monitor|Beacon|Detector|Promoter|Pauser|Backstop)\.ts$/;

// Guard-shape detection 2: explicit additional candidates — enabled-gated
// boot-constructed components whose FILENAMES do not match the suffix pattern.
// Append here when a new guard-shaped component ships under a non-matching
// name (the lint then forces its classification like any other candidate).
const ADDITIONAL_CANDIDATES = [
  'QuotaTracker',          // monitoring.quotaTracking
  'ResourceLedger',        // monitoring.resourceLedger.enabled
  'TelemetryCollector',    // monitoring.telemetry.enabled
  'StallTriageNurse',      // monitoring.triage.enabled
  'TriageOrchestrator',    // monitoring.triageOrchestrator.enabled
  'GrowthMilestoneAnalyst',// monitoring.growthAnalyst.enabled (dev-gated)
  'BlockerLedger',         // monitoring.blockerLedger.enabled (dev-gated)
  'SecretSync',            // multiMachine.secretSync.enabled
  'CoherenceJournal',      // multiMachine.coherenceJournal.enabled
  'PromptGate',            // monitoring.promptGate.enabled
];

const MIN_REASON_NON_WS = 12;

/** Strip line + block comments so commented-out entries can't satisfy the rule. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Extract the source slice of `export const NAME ... = [ ... ] as const;`. */
function extractArrayBlock(src, name) {
  const declRe = new RegExp(`export\\s+const\\s+${name}\\b[\\s\\S]*?=\\s*\\[`);
  const m = declRe.exec(src);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = src.indexOf('] as const', start);
  if (end < 0) return null;
  return src.slice(start, end);
}

/**
 * Statically parse the manifest file (regex over source — never imports TS).
 * Returns { manifestComponents: Set, notAGuard: [{component, reason, line}] }.
 */
function parseManifest(manifestAbs) {
  const raw = fs.readFileSync(manifestAbs, 'utf-8');
  const src = stripComments(raw);

  const manifestBlock = extractArrayBlock(src, 'GUARD_MANIFEST');
  const notAGuardBlock = extractArrayBlock(src, 'NOT_A_GUARD');
  if (manifestBlock === null || notAGuardBlock === null) {
    return {
      error: `could not locate ${manifestBlock === null ? 'GUARD_MANIFEST' : 'NOT_A_GUARD'} array in ${manifestAbs}`,
    };
  }

  const manifestComponents = new Set();
  const componentRe = /component:\s*(['"])([^'"]+)\1/g;
  for (const m of manifestBlock.matchAll(componentRe)) manifestComponents.add(m[2]);

  // NOT_A_GUARD entries: `{ component: '...', reason: '...' }` (single-line
  // string literals — the file's house style; see header LIMITATIONS).
  const notAGuard = [];
  const entryRe = /component:\s*(['"])([^'"]+)\1\s*,\s*reason:\s*(['"])((?:[^\\]|\\.)*?)\3/g;
  for (const m of notAGuardBlock.matchAll(entryRe)) {
    notAGuard.push({ component: m[2], reason: m[4] });
  }

  return { manifestComponents, notAGuard };
}

/** Walk the four guard dirs for candidate .ts files (skip tests/declarations). */
function listCandidateFiles() {
  const out = [];
  for (const rel of GUARD_DIRS) {
    const dir = path.join(ROOT, rel);
    if (!fs.existsSync(dir)) continue;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules') continue;
          walk(full);
        } else if (
          e.name.endsWith('.ts') &&
          !e.name.endsWith('.test.ts') &&
          !e.name.endsWith('.d.ts')
        ) {
          out.push(full);
        }
      }
    };
    walk(dir);
  }
  return out;
}

function resolveCandidateFiles() {
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (explicit.length) return explicit.map((f) => path.resolve(ROOT, f));
  return listCandidateFiles();
}

// ── Run ──────────────────────────────────────────────────────────────────────

const violations = [];

if (!fs.existsSync(MANIFEST_ABS)) {
  console.error(`lint-guard-manifest: manifest not found at ${MANIFEST_ABS}`);
  process.exit(1);
}

const parsed = parseManifest(MANIFEST_ABS);
if (parsed.error) {
  console.error(`lint-guard-manifest: ${parsed.error}`);
  process.exit(1);
}
const { manifestComponents, notAGuard } = parsed;
const notAGuardComponents = new Set(notAGuard.map((e) => e.component));

// ── Assertion B: every NOT_A_GUARD reason is real (≥12 non-ws chars) ──
for (const e of notAGuard) {
  const reasonLen = (e.reason || '').replace(/\s/g, '').length;
  if (reasonLen < MIN_REASON_NON_WS) {
    violations.push({
      file: MANIFEST_REL, kind: 'B: NOT_A_GUARD reason too short',
      text: `${e.component} → reason '${e.reason}' (${reasonLen} non-ws chars)`,
      fix: `a NOT_A_GUARD reason must be ≥${MIN_REASON_NON_WS} non-whitespace chars (defeats placeholder reasons)`,
    });
  }
}

// ── Assertion C: exactly one list ──
for (const c of notAGuardComponents) {
  if (manifestComponents.has(c)) {
    violations.push({
      file: MANIFEST_REL, kind: 'C: dual classification',
      text: `${c} appears in BOTH GUARD_MANIFEST and NOT_A_GUARD`,
      fix: 'a component is a guard or it is not — remove it from one list',
    });
  }
}

// ── Assertion A: every candidate component is classified ──
const explicitArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const candidates = new Map(); // component name → where it was detected
for (const file of resolveCandidateFiles()) {
  if (!fs.existsSync(file)) continue;
  const base = path.basename(file);
  if (!GUARD_SHAPE_BASENAME.test(base)) continue;
  candidates.set(base.replace(/\.ts$/, ''), path.relative(ROOT, file));
}
// ADDITIONAL_CANDIDATES are repo-global names — only meaningful on a full
// scan (an explicit-args run, e.g. a test fixture, scopes to those files).
if (explicitArgs.length === 0) {
  for (const name of ADDITIONAL_CANDIDATES) {
    if (!candidates.has(name)) candidates.set(name, '(ADDITIONAL_CANDIDATES)');
  }
}

for (const [component, where] of [...candidates.entries()].sort()) {
  if (manifestComponents.has(component)) continue;
  if (notAGuardComponents.has(component)) continue;
  violations.push({
    file: where, kind: 'A: unclassified guard-shaped component',
    text: `${component} is in NEITHER GUARD_MANIFEST (component:) NOR NOT_A_GUARD`,
    fix: `declare it in GUARD_MANIFEST (it joins the /guards inventory) OR classify it in NOT_A_GUARD with a ≥${MIN_REASON_NON_WS}-char reason (${MANIFEST_REL})`,
  });
}

if (violations.length === 0) {
  console.log('lint-guard-manifest: clean');
  process.exit(0);
}

console.error('\n❌ lint-guard-manifest found violations of the guard-inventory classification standard:\n');
console.error('NOTE: detection is the file-basename suffix pattern + ADDITIONAL_CANDIDATES only —');
console.error('a guard-shaped component under a non-matching filename evades it until named in');
console.error('ADDITIONAL_CANDIDATES. This closes the forgotten-file hole, not every hole.\n');
for (const v of violations) {
  console.error(`  ${v.file}  [${v.kind}]`);
  console.error(`    ${v.text}`);
  console.error(`    fix: ${v.fix}\n`);
}
console.error('Standard: every guard-shaped component is CLASSIFIED — declared in GUARD_MANIFEST (it appears in the /guards inventory) or in NOT_A_GUARD with a real reason. A future guard cannot be silently forgotten. Spec: docs/specs/GUARD-POSTURE-ENDPOINT-SPEC.md §2.1\n');
process.exit(1);
