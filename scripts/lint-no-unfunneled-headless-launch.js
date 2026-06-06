#!/usr/bin/env node
/**
 * lint-no-unfunneled-headless-launch.js — refuses direct `buildHeadlessLaunch`
 * use outside the subscription-path funnel.
 *
 * Part of the June-15 readiness arc (docs/specs/june15-headless-spawn-reroute.md,
 * review finding F5 — Structure > Willpower). After 2026-06-15, a headless
 * `claude -p` one-shot bills the Agent SDK credit pot. The reroute that sends
 * those spawns down the subscription lane lives in ONE funnel:
 * `SessionManager.spawnSession()`. A future callsite that imports
 * `buildHeadlessLaunch` directly bypasses the reroute — silently
 * re-introducing SDK-pot traffic that fails hard when the pot drains. That
 * bypass must fail CI, not be discovered on the bill.
 *
 * Rule: outside the allowlist below, no source file may reference
 * `buildHeadlessLaunch` (import OR call — an import is the bypass's first
 * commit, flag it at the door).
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-no-unfunneled-headless-launch.js            # full repo
 *   node scripts/lint-no-unfunneled-headless-launch.js --staged   # staged files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// ── Allowlist (closed). Adding an entry requires review of WHY the callsite
//    cannot route through SessionManager.spawnSession() (where the
//    subscription-path reroute lives), and how its post-June-15 billing is
//    accounted for. ──────────────────────────────────────────────────────
const ALLOWLIST = new Set([
  // The definition itself.
  'src/core/frameworkSessionLaunch.ts',
  // THE funnel — the subscription-path reroute decision lives here.
  'src/core/SessionManager.ts',
  // Deliberately-isolated fast path (spec Class 7): under force-mode it
  // refuses + degradation-reports instead of spawning; full SessionManager
  // integration is tracked under CMT-1112.
  'src/threadline/PipeSessionSpawner.ts',
  // This lint file mentions the symbol it greps for.
  'scripts/lint-no-unfunneled-headless-launch.js',
]);

const SCAN_DIRS = ['src', 'scripts', 'templates'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.sh']);

const PATTERNS = [
  // Any reference — import, re-export, or call. An import IS the violation:
  // there is no legitimate non-funnel consumer of the headless builder.
  /\bbuildHeadlessLaunch\b/,
];

function listFiles() {
  const staged = process.argv.includes('--staged');
  if (staged) {
    // Read-only staged-file detection (same bootstrap escape as the other
    // lint scripts — runs pre-compile, can't use the TS funnel).
    const out = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf-8' });
    return out.split('\n').filter(Boolean);
  }
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (explicit.length) return explicit;

  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (EXTENSIONS.has(path.extname(e.name))) files.push(path.relative(ROOT, full));
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d));
  return files;
}

let violations = 0;
for (const rel of listFiles()) {
  const normalized = rel.split(path.sep).join('/');
  if (ALLOWLIST.has(normalized)) continue;
  if (!EXTENSIONS.has(path.extname(normalized))) continue;
  // Explicit args may be absolute (e.g. the lint's own self-test sandbox);
  // repo-walk entries are always ROOT-relative.
  const full = path.isAbsolute(normalized) ? normalized : path.join(ROOT, normalized);
  let content;
  try {
    content = fs.readFileSync(full, 'utf-8');
  } catch {
    continue;
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    // Comment-only mentions are documentation, not a bypass — code can't
    // call through a comment. (`//`, `*`, `/*` line starts and `#` for .sh.)
    const trimmed = lines[i].trimStart();
    if (/^(\/\/|\*|\/\*|#)/.test(trimmed)) continue;
    for (const pattern of PATTERNS) {
      if (pattern.test(lines[i])) {
        console.error(
          `${normalized}:${i + 1} — direct buildHeadlessLaunch reference outside the subscription-path funnel. ` +
          `Spawn through SessionManager.spawnSession() (which carries the June-15 reroute), ` +
          `or add an allowlist entry here with a billing-accountability justification.`,
        );
        violations++;
      }
    }
  }
}

if (violations > 0) {
  console.error(`\nlint-no-unfunneled-headless-launch: ${violations} violation(s). ` +
    `See docs/specs/june15-headless-spawn-reroute.md (finding F5).`);
  process.exit(1);
}
console.log('lint-no-unfunneled-headless-launch: clean');
