#!/usr/bin/env node
/**
 * lint-no-mainthread-cartographer-walk.js — refuses the O(nodeCount)/67MB
 * synchronous cartographer operations on the server's main-thread surfaces.
 *
 * Earned by instar#1069: enabling the doc-freshness sweep on a real tree
 * (366,757 nodes / 67MB index) put the AgentServer into a supervisor kill-loop.
 * The "what's stale?" detect read + walked the whole index ON THE MAIN EVENT
 * LOOP, starving /health for ~35s at a stretch, so the supervisor declared the
 * (alive) server dead and force-restarted it — every ~10-15 min.
 *
 * The fix moved the detect + index writes off the event loop (a worker thread)
 * and made every /cartographer/* route serve a cheap snapshot. This lint stops
 * the regression from returning: "Structure > Willpower", not "enforced by review".
 *
 * Rule (PATH-ALLOWLIST — a callsite lint matches FILES, not runtime threads):
 *   FORBIDDEN in the main-thread surfaces:
 *     - src/server/routes.ts                 (the request thread)
 *     - src/core/CartographerSweepEngine.ts  (the sweep poller thread = main loop)
 *   the heavy calls: .staleNodes(  .loadIndex(  .freshnessHealth(  .scaffold(
 *   PERMITTED everywhere else, specifically:
 *     - src/core/cartographerDetect.ts  (the pure module — legitimately parses, OFF-thread)
 *     - src/core/CartographerTree.ts    (the definitions of these methods)
 *     - tests/                          (tests scaffold/load directly)
 *   The bounded request loader (`.loadIndexBounded(`) is NOT matched — it stats
 *   the file and refuses before parsing, so it is safe on the request thread.
 *
 * Escape hatch (closed, reviewed): a genuinely off-thread / boot-only call may
 * carry an inline justification on the same line or directly above:
 *     // lint-allow-carto-heavy: <why this can't starve the event loop>
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 * Usage:
 *   node scripts/lint-no-mainthread-cartographer-walk.js            # full repo
 *   node scripts/lint-no-mainthread-cartographer-walk.js --staged   # staged files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// The main-thread surfaces where these heavy calls re-introduce #1069.
const FORBIDDEN_FILES = new Set([
  'src/server/routes.ts',
  'src/core/CartographerSweepEngine.ts',
]);

// .staleNodes( / .loadIndex( / .freshnessHealth( / .scaffold(  — note the trailing
// `\(` means `.loadIndexBounded(` (the safe byte-bounded loader) is NOT matched.
const VIOLATION = /\.(staleNodes|loadIndex|freshnessHealth|scaffold)\(/;
const ALLOW = /lint-allow-carto-heavy:/;

function listFiles() {
  if (process.argv.includes('--staged')) {
    const out = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf-8' });
    return out.split('\n').filter(Boolean);
  }
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (explicit.length) return explicit;
  return [...FORBIDDEN_FILES];
}

let violations = 0;
for (const rel of listFiles()) {
  const normalized = rel.split(path.sep).join('/');
  if (!FORBIDDEN_FILES.has(normalized)) continue; // only the main-thread surfaces are enforced
  const full = path.isAbsolute(normalized) ? normalized : path.join(ROOT, normalized);
  let content;
  try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (/^(\/\/|\*|\/\*)/.test(trimmed)) continue; // comment-only mention
    if (!VIOLATION.test(lines[i])) continue;
    let allowed = false;
    for (let j = i; j >= Math.max(0, i - 6); j--) {
      if (ALLOW.test(lines[j])) { allowed = true; break; }
    }
    if (allowed) continue;
    const m = lines[i].match(VIOLATION);
    console.error(
      `${normalized}:${i + 1} — main-thread cartographer ${m ? m[1] + '()' : 'walk'} ` +
      `(O(nodeCount)/67MB synchronous) on a server hot path. This is the instar#1069 ` +
      `kill-loop regression. Use the off-event-loop detect (cartographerDetect.runDetect) ` +
      `or serve the snapshot / use loadIndexBounded(). If genuinely off-thread/boot-only, ` +
      `add "// lint-allow-carto-heavy: <reason>".`,
    );
    violations++;
  }
}

if (violations > 0) {
  console.error(`\nlint-no-mainthread-cartographer-walk: ${violations} violation(s). ` +
    `See docs/specs/CARTOGRAPHER-SWEEP-EVENTLOOP-SAFETY.md (fix instar#1069).`);
  process.exit(1);
}
console.log('lint-no-mainthread-cartographer-walk: clean');
