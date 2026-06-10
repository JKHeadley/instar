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
 * Two assertions over `src/`:
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

/** Strip a `//` line comment; return null if the line is a pure comment line. */
function codeOnly(line) {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
    return null; // comment line — no code
  }
  const idx = line.indexOf('//');
  return idx >= 0 ? line.slice(0, idx) : line;
}

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
        if (HARDCODED_ENABLED.test(codeJ) && !reportedB.has(j)) {
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

if (violations.length === 0) {
  console.log('lint-dev-agent-dark-gate: clean');
  process.exit(0);
}

console.error('\n❌ lint-dev-agent-dark-gate found violations of the developmentAgent dark-feature gate standard:\n');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.kind}]`);
  console.error(`    ${v.text}`);
  console.error(`    fix: ${v.fix}\n`);
}
console.error('Standard: a dev-gated feature OMITS `enabled` and resolves it through resolveDevAgentGate so it runs LIVE on dev agents and DARK on the fleet. Spec: docs/specs/DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC.md\n');
process.exit(1);
