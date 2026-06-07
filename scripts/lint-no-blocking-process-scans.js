#!/usr/bin/env node
/**
 * lint-no-blocking-process-scans.js — refuses SYNCHRONOUS process-enumeration
 * scans (`ps`/`pgrep`/`lsof`/`pkill`) on the runtime hot path.
 *
 * Earned 2026-06-07 (topic 21816 post-mortem, docs/postmortems/2026-06-07-server-temporarily-down.md).
 * Root cause #4 of the "server temporarily down" incident: monitors ran
 * `spawnSync('ps' …)` / `execFileSync('lsof' …)` on a cadence. A single-threaded
 * Node process BLOCKS its event loop for the duration of a synchronous child
 * process — and `ps`/`lsof` get slow under CPU/IO load, exactly when monitors
 * fire most. The cumulative stall starved `/health`, which made the supervisor
 * declare the (alive) server unresponsive and restart it → the restart loop.
 * #972 converted SessionWatchdog to async; this lint stops the class from being
 * RE-INTRODUCED anywhere in the runtime dirs.
 *
 * Rule: in src/monitoring/ and src/server/, no synchronous child-process call
 * (`spawnSync` / `execSync` / `execFileSync`) may invoke a process-enumeration
 * command (`ps`, `pgrep`, `lsof`, `pkill`) given as a string literal. Use the
 * async equivalent (`promisify(execFile)` / `execFileAsync`) so the scan yields
 * the event loop. tmux/git/etc. calls are NOT covered (they are bounded and not
 * the load-sensitive enumeration commands this incident was about).
 *
 * Escape hatch (closed, reviewed): a genuinely one-shot, bounded call that
 * cannot run on a cadence may carry an inline justification comment on the same
 * line or the line directly above:
 *     // lint-allow-blocking-scan: <why this can't run periodically>
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-no-blocking-process-scans.js            # full repo
 *   node scripts/lint-no-blocking-process-scans.js --staged   # staged files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// Only the runtime hot dirs — where a periodic monitor stalling the loop is the
// documented failure. (src/core has tmux-heavy session plumbing that is a
// separate, bigger conversion tracked in the post-mortem follow-up.)
const SCAN_DIRS = ['src/monitoring', 'src/server'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

// A synchronous child-process call whose command literal is a process-scan tool.
// Matches e.g.  spawnSync('pgrep', …)   execFileSync('lsof', …)   execSync('ps …')
const VIOLATION = /\b(spawnSync|execSync|execFileSync)\s*\(\s*['"`]\s*(ps|pgrep|lsof|pkill)\b/;
const ALLOW = /lint-allow-blocking-scan:/;

const inScanDir = (p) => SCAN_DIRS.some((d) => p.startsWith(d + '/'));

function listFiles() {
  if (process.argv.includes('--staged')) {
    const out = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf-8' });
    // Only the runtime hot dirs are enforced for staged scans.
    return out.split('\n').filter(Boolean).filter((p) => inScanDir(p.split(path.sep).join('/')));
  }
  // Explicit file args are checked as-given (targeted use / self-tests).
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (explicit.length) return explicit;

  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
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
  if (!EXTENSIONS.has(path.extname(normalized))) continue;
  const full = path.isAbsolute(normalized) ? normalized : path.join(ROOT, normalized);
  let content;
  try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (/^(\/\/|\*|\/\*)/.test(trimmed)) continue; // comment-only mention
    if (!VIOLATION.test(lines[i])) continue;
    // Inline justification on this line or within the comment block directly
    // above (scan back up to 4 lines so a multi-line reason is honoured).
    let allowed = false;
    for (let j = i; j >= Math.max(0, i - 6); j--) {
      if (ALLOW.test(lines[j])) { allowed = true; break; }
    }
    if (allowed) continue;
    console.error(
      `${normalized}:${i + 1} — synchronous process scan (ps/pgrep/lsof/pkill) on the runtime hot path. ` +
      `Blocks the event loop and starves /health under load (topic 21816 root cause #4). ` +
      `Use an async exec (promisify(execFile)/execFileAsync), or, if it is a genuinely one-shot bounded call, ` +
      `add an inline "// lint-allow-blocking-scan: <reason>".`,
    );
    violations++;
  }
}

if (violations > 0) {
  console.error(`\nlint-no-blocking-process-scans: ${violations} violation(s). ` +
    `See docs/postmortems/2026-06-07-server-temporarily-down.md (root cause #4).`);
  process.exit(1);
}
console.log('lint-no-blocking-process-scans: clean');
