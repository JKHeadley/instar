#!/usr/bin/env node
/**
 * lint-dev-agent-dark-gate.js — enforces the developmentAgent dark-feature gate
 * standard (standard_development_agent_dark_feature_gate).
 *
 * Born from PR #1001: the GrowthMilestoneAnalyst hardcoded `enabled: false` in
 * its config default instead of omitting it, so it shipped dark for EVERY agent
 * (dev agents included), silently contradicting the standard. Caught only by
 * operator review — there was no structural guard. This is that guard.
 *
 * Three assertions over `src/`:
 *
 *   A. FUNNEL — every dev-agent gate resolution must go through
 *      `resolveDevAgentGate` (src/core/devAgentGate.ts). A hand-rolled
 *      `?? !!<x>.developmentAgent` / `?? <x>.developmentAgent` anywhere else is a
 *      violation (same contract as lint-no-direct-destructive: one funnel, no
 *      forks). Comments that merely describe the pattern are ignored.
 *
 *   B. NO HARDCODED `enabled: false` UNDER A GATE MARKER — in
 *      src/config/ConfigDefaults.ts, a config block whose comment references the
 *      dev-gate convention (mentions `developmentAgent` + `dark`/`gate`) must NOT
 *      hardcode `enabled: false` in the CODE lines that follow. The convention is
 *      to OMIT `enabled` so the gate decides; a baked-in `false` in the shipped
 *      default is the exact #1001 shape (it darks dev agents too). `enabled: true`
 *      is NOT flagged — that is an allowed deliberate fleet-flip. Comment prose is
 *      skipped so the convention's own documentation never trips the check.
 *
 *   C. NO UNCLASSIFIED DARK DEFAULT (DEV-AGENT-DARK-GATE-ENFORCEMENT B2) — every
 *      literal `enabled: false` in src/config/ConfigDefaults.ts must be a DECLARED
 *      choice: its brace-attributed config path is EITHER in DEV_GATED_FEATURES
 *      (and then must NOT also hardcode false — a dev-gated feature OMITS enabled)
 *      OR in DARK_GATE_EXCLUSIONS with a valid category + a ≥12-char reason. This
 *      closes the hole assertion B left: a marker-less hardcoded `enabled: false`
 *      (exactly the cartographer specs) shipped dark for everyone, invisibly.
 *      LIMITATION: C matches the literal `enabled: false` spelling only.
 *
 * Exit codes:
 *   0 — no violations.
 *   1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-dev-agent-dark-gate.js              # full src/ tree
 *   node scripts/lint-dev-agent-dark-gate.js --staged     # staged files only
 *   node scripts/lint-dev-agent-dark-gate.js path1 path2  # specific files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  codeOnly,
  attributeEnabledFalsePaths,
  extractRegistry,
  VALID_CATEGORIES,
} from './lib/dark-gate-attribution.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src');

// The funnel itself, plus this lint, legitimately name the pattern.
const FUNNEL_ALLOWLIST = new Set([
  'src/core/devAgentGate.ts',
]);

// Hand-rolled dev-agent gate resolution: `?? [!! | Boolean(]<expr>.developmentAgent`,
// including bracket access `['developmentAgent']`. Catches the canonical `!!`
// form, the `Boolean(...)` form, and quoted-key access — the realistic spellings.
// (It cannot catch arbitrary aliases/wrapper helpers; that limit is documented
// in the spec's Layer-1 "misses" row.)
const HANDROLLED_GATE =
  /\?\?\s*(?:!{1,2}\s*|Boolean\s*\(\s*)?[A-Za-z_$][\w$.?]*(?:\.developmentAgent\b|\[\s*['"]developmentAgent['"]\s*\])/;
// A comment referencing the gate convention (for assertion B).
const GATE_MARKER = /developmentAgent/i;
const GATE_MARKER_QUALIFIER = /\b(dark|gate)\b/i;
// Only a baked-in `false` is the #1001 bug; `true` is an allowed fleet-flip.
// Catches both bare and quoted keys (`enabled: false` / `"enabled": false`).
const HARDCODED_ENABLED = /(["']?)enabled\1\s*:\s*false\b/;
// Once a marker comment is found, scan the config block it introduces (brace-
// matched, NOT a fixed line window — a long marker comment must not push the
// block out of range, the bug that let a regressed growthAnalyst slip through).
const BLOCK_OPEN_SEARCH = 15; // max non-code lines between marker and the block's `{`
const BLOCK_MAX_LINES = 120; // safety bound on block-body scan

/** Is this line (trimmed) a comment line? */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
}

function listSourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(e.name) && !/\.test\.[tj]s$/.test(e.name)) {
        out.push(full);
      }
    }
  };
  walk(SRC_DIR);
  return out;
}

function resolveTargets() {
  const args = process.argv.slice(2);
  if (args.includes('--staged')) {
    const staged = execSync('git diff --cached --name-only --diff-filter=ACM', { cwd: ROOT, encoding: 'utf-8' })
      .split('\n').map((s) => s.trim()).filter(Boolean)
      .filter((f) => f.startsWith('src/') && /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !/\.test\.[tj]s$/.test(f))
      .map((f) => path.join(ROOT, f));
    return staged;
  }
  const explicit = args.filter((a) => !a.startsWith('--'));
  if (explicit.length) return explicit.map((f) => path.resolve(ROOT, f));
  return listSourceFiles();
}

const violations = [];

// Paths used by assertions B (skip-classified) and C (classification check).
// Tests inject fixtures via env overrides (the C-assertion reads the registry +
// ConfigDefaults directly, independent of the file args, so without an override a
// test could not exercise C's failure modes). Absolute paths only; default to the
// real repo files.
const CONFIG_DEFAULTS_REL = 'src/config/ConfigDefaults.ts';
const DEV_GATED_FEATURES_REL = 'src/core/devGatedFeatures.ts';
const CONFIG_DEFAULTS_ABS = process.env.INSTAR_DARKGATE_CONFIG_DEFAULTS
  ? path.resolve(process.env.INSTAR_DARKGATE_CONFIG_DEFAULTS)
  : path.join(ROOT, CONFIG_DEFAULTS_REL);
const REGISTRY_ABS = process.env.INSTAR_DARKGATE_REGISTRY
  ? path.resolve(process.env.INSTAR_DARKGATE_REGISTRY)
  : path.join(ROOT, DEV_GATED_FEATURES_REL);

// Precompute the registry + path attribution so assertion B can SKIP a hardcoded
// `enabled: false` whose attributed path is a DELIBERATE classification (a nested
// DARK_GATE_EXCLUSIONS entry under a gate-marker comment, e.g. the cost-bearing
// cartographer sweep). Without this, B false-flags a declared dark default that a
// parent block's gate-marker comment happens to enclose. The full classification
// check is assertion C below; B only needs the exclusion line-set to stay quiet on
// already-classified lines.
const _configDefaultsAbs = CONFIG_DEFAULTS_ABS;
const _registryAbs = REGISTRY_ABS;
let _exclusionClassifiedLines = new Set(); // 1-based ConfigDefaults.ts line numbers
if (fs.existsSync(_configDefaultsAbs) && fs.existsSync(_registryAbs)) {
  try {
    const { exclusionPaths } = extractRegistry(_registryAbs);
    const exclSet = new Set(exclusionPaths);
    const { paths: attributed, error } = attributeEnabledFalsePaths(_configDefaultsAbs);
    if (!error) {
      for (const { line, dottedPath } of attributed) {
        if (exclSet.has(dottedPath)) _exclusionClassifiedLines.add(line);
      }
    }
  } catch {
    // If precompute fails, B falls back to its original behavior (flag all);
    // assertion C reports the real desync/error loudly.
    _exclusionClassifiedLines = new Set();
  }
}

for (const file of resolveTargets()) {
  if (!fs.existsSync(file)) continue;
  const rel = path.relative(ROOT, file);
  const lines = fs.readFileSync(file, 'utf-8').split('\n');

  // ── Assertion A: funnel ──
  if (!FUNNEL_ALLOWLIST.has(rel)) {
    lines.forEach((line, i) => {
      const code = codeOnly(line);
      if (code === null) return;
      if (HANDROLLED_GATE.test(code)) {
        violations.push({
          file: rel, line: i + 1, kind: 'A: hand-rolled gate',
          text: line.trim(),
          fix: 'route through resolveDevAgentGate(explicitEnabled, config) from src/core/devAgentGate.ts',
        });
      }
    });
  }

  // ── Assertion B: ConfigDefaults marker (any ConfigDefaults.ts) ──
  if (path.basename(file) === 'ConfigDefaults.ts') {
    const reportedB = new Set(); // a multi-line marker comment fires per line — dedupe by target line
    lines.forEach((line, i) => {
      if (!isCommentLine(line)) return;
      if (!(GATE_MARKER.test(line) && GATE_MARKER_QUALIFIER.test(line))) return;
      // Find the config block this marker introduces: the first CODE line with an
      // opening `{`, skipping any further comment/blank lines. A NON-comment line
      // without a `{` means the marker doesn't introduce an object — stop.
      let openIdx = -1;
      for (let j = i + 1; j <= Math.min(i + BLOCK_OPEN_SEARCH, lines.length - 1); j++) {
        const codeJ = codeOnly(lines[j]);
        if (codeJ === null || codeJ.trim() === '') continue;
        if (codeJ.includes('{')) { openIdx = j; }
        break;
      }
      if (openIdx < 0) return;
      // Brace-match from the opener and scan the block BODY (code lines only, so
      // comment prose like "the fleet-flip registers `enabled: true` here" can't
      // trip it) for a hardcoded `enabled: false`. Brace-matched rather than a
      // fixed window so a long marker comment can't push the block out of range.
      let depth = 0;
      for (let j = openIdx; j <= Math.min(openIdx + BLOCK_MAX_LINES, lines.length - 1); j++) {
        const codeJ = codeOnly(lines[j]);
        if (codeJ === null) continue;
        // Skip a line that is a DELIBERATE DARK_GATE_EXCLUSIONS classification
        // (a nested dark default that a parent block's gate-marker comment merely
        // encloses — e.g. the cost-bearing cartographer sweep). Assertion C still
        // requires it to be classified; B should not double-flag it.
        if (
          HARDCODED_ENABLED.test(codeJ) &&
          !reportedB.has(j) &&
          !(rel === CONFIG_DEFAULTS_REL && _exclusionClassifiedLines.has(j + 1))
        ) {
          reportedB.add(j);
          violations.push({
            file: rel, line: j + 1, kind: 'B: hardcoded enabled under gate marker',
            text: lines[j].trim(),
            fix: 'OMIT `enabled` from the default so the gate decides (resolved as enabled ?? !!developmentAgent at runtime)',
          });
        }
        for (const ch of codeJ) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        if (depth <= 0 && j > openIdx) break; // block closed
      }
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Assertion C — NO UNCLASSIFIED DARK DEFAULT (DEV-AGENT-DARK-GATE-ENFORCEMENT B2)
//
// Every literal `enabled: false` in src/config/ConfigDefaults.ts must be a
// DECLARED choice: its attributed config path is EITHER registered in
// DEV_GATED_FEATURES (→ but then it must NOT also hardcode `enabled: false`; a
// dev-gated feature OMITS enabled) OR classified in DARK_GATE_EXCLUSIONS with a
// category + reason. Neither → violation. This closes the cartographer hole:
// assertion B only fires under a comment marker; a marker-less hardcoded
// `enabled: false` (exactly the cartographer specs) was invisible.
//
// LIMITATION (P2 Signal-vs-Authority — do NOT claim full closure): assertion C
// matches the LITERAL `enabled: false` spelling ONLY. A non-literal default
// (`enabled: someFlag ?? false`) evades it — the same miss named in the prior
// conformance spec's Layer-2 row. C closes the literal-false hole (cartographer +
// #1001), not the non-literal-expression hole.
//
// Path attribution reuses codeOnly() for depth (shared with the golden-path test
// via scripts/lib/dark-gate-attribution.js — ONE attributor implementation).
// codeOnly() strips `//` comments but does NOT skip braces inside string/template
// literals — so a loud-fail guard in attributeEnabledFalsePaths errors if any line
// in the defaults-block region carries a `{`/`}` inside a string, rather than
// silently desyncing.
// ════════════════════════════════════════════════════════════════════════════

// Run assertion C only on a full-tree / explicit run that includes ConfigDefaults
// (the path attribution needs the whole file; a --staged run that doesn't touch
// it is a no-op for C, which is fine — CI runs the full tree).
(() => {
  const configDefaultsAbs = CONFIG_DEFAULTS_ABS;
  const registryAbs = REGISTRY_ABS;
  if (!fs.existsSync(configDefaultsAbs) || !fs.existsSync(registryAbs)) return;

  const { gatedPaths, exclusionPaths, exclusionEntries } = extractRegistry(registryAbs);
  const gatedSet = new Set(gatedPaths);
  const exclusionSet = new Set(exclusionPaths);

  // Validate exclusion-entry quality (closed enum + reason length).
  for (const e of exclusionEntries) {
    if (!VALID_CATEGORIES.has(e.category)) {
      violations.push({
        file: DEV_GATED_FEATURES_REL, line: 0, kind: 'C: invalid exclusion category',
        text: `${e.configPath} → category '${e.category}'`,
        fix: `category must be one of: ${[...VALID_CATEGORIES].join(', ')}`,
      });
    }
    const reasonLen = (e.reason || '').replace(/\s/g, '').length;
    if (reasonLen < 12) {
      violations.push({
        file: DEV_GATED_FEATURES_REL, line: 0, kind: 'C: exclusion reason too short',
        text: `${e.configPath} → reason '${e.reason}' (${reasonLen} non-ws chars)`,
        fix: 'a DARK_GATE_EXCLUSIONS reason must be ≥12 non-whitespace chars (defeats placeholder reasons)',
      });
    }
  }

  const { paths: attributed, error } = attributeEnabledFalsePaths(configDefaultsAbs);
  if (error) {
    violations.push({
      file: CONFIG_DEFAULTS_REL, line: 0, kind: 'C: path-attribution error',
      text: error,
      fix: 'resolve the desync condition before the lint can attribute dark defaults',
    });
    return;
  }

  for (const { line, dottedPath } of attributed) {
    const inGated = gatedSet.has(dottedPath);
    const inExcluded = exclusionSet.has(dottedPath);
    if (inGated) {
      // Registered as dev-gated but still hardcodes `enabled: false` — the #1001
      // shape. A dev-gated feature OMITS enabled.
      violations.push({
        file: CONFIG_DEFAULTS_REL, line, kind: 'C: registered but hardcodes false',
        text: `${dottedPath} is in DEV_GATED_FEATURES but still hardcodes \`enabled: false\``,
        fix: 'OMIT `enabled` from the default so the gate decides (resolved as enabled ?? !!developmentAgent)',
      });
    } else if (!inExcluded) {
      violations.push({
        file: CONFIG_DEFAULTS_REL, line, kind: 'C: unclassified dark default',
        text: `${dottedPath} has \`enabled: false\` but is in NEITHER DEV_GATED_FEATURES NOR DARK_GATE_EXCLUSIONS`,
        fix: 'dev-gate it (omit `enabled` + register in DEV_GATED_FEATURES) OR add it to DARK_GATE_EXCLUSIONS with a category+reason',
      });
    }
  }
})();

if (violations.length === 0) {
  console.log('lint-dev-agent-dark-gate: clean');
  process.exit(0);
}

console.error('\n❌ lint-dev-agent-dark-gate found violations of the developmentAgent dark-feature gate standard:\n');
console.error('NOTE: assertion C matches the literal `enabled: false` spelling only — a non-literal');
console.error('default (`enabled: someFlag ?? false`) evades it. C closes the literal-false hole');
console.error('(cartographer + #1001), not the non-literal-expression hole.\n');
for (const v of violations) {
  const loc = v.line ? `${v.file}:${v.line}` : v.file;
  console.error(`  ${loc}  [${v.kind}]`);
  console.error(`    ${v.text}`);
  console.error(`    fix: ${v.fix}\n`);
}
console.error('Standard: a dev-gated feature OMITS `enabled` and resolves it through resolveDevAgentGate so it runs LIVE on dev agents and DARK on the fleet; every other `enabled: false` default must be classified in DARK_GATE_EXCLUSIONS. Spec: docs/specs/DEV-AGENT-DARK-GATE-ENFORCEMENT-SPEC.md\n');
process.exit(1);
