#!/usr/bin/env node
/**
 * lint-sync-subprocess-chokepoint.js — tmux Event-Loop Resilience, Increment 1.
 *
 * A SYNCHRONOUS subprocess spawn (`spawnSync` / `execSync` / `execFileSync`) blocks
 * the single-threaded Node event loop for the FULL duration of the child process. A
 * slow/wedged tmux (or any slow sync spawn) on the runtime hot path is exactly the
 * ~0-CPU I/O-wait block this increment exists to make survivable: the marker module
 * (src/core/InFlightSyncOpMarker.ts) is the SOLE funnel through which a sync blocking
 * op may run — `withSyncOp(() => execFileSync(...))` records depth so SleepWakeDetector
 * + ServerSupervisor can tell the block apart from a real sleep instead of mis-reaping
 * the session or restarting a live-but-blocked server.
 *
 * Rule: in src/core/, src/monitoring/, and src/server/, no RAW synchronous child-process
 * spawn (`spawnSync` / `execSync` / `execFileSync`) outside the chokepoint module. A
 * raw sync spawn must EITHER funnel through `withSyncOp` (so the (B) marker sees it) OR,
 * if it is a genuinely pre-runtime / CLI-boot call that can never run on a cadence,
 * carry an inline justification comment on the same line or the line directly above:
 *     // lint-allow-sync-spawn: <why this never blocks the runtime event loop>
 *
 * This lint bans the RAW spawn outside the funnel — NOT sync-ness itself: the marker
 * module legitimately WRAPS sync calls, and the D1-excluded injection-sequence callsites
 * (send-keys + /bin/sleep, where synchronous timing IS the correctness mechanism) stay
 * sync but funnel through `withSyncOp`. So this lint is satisfied when a sync spawn is
 * funneled, allow-commented, or grandfathered in the FROZEN baseline.
 *
 * COVERAGE HONESTY (No Silent Degradation): a static line-regex, NOT complete — it cannot
 * prove a flagged line is actually WRAPPED by withSyncOp at runtime (that is the (B) unit
 * tests' job). It is the cheap FORWARD ratchet that stops a NEW raw sync spawn from being
 * introduced outside the funnel. The 40+ existing SessionManager callsites are
 * grandfathered by the baseline so this increment's conversion can land incrementally.
 *
 * Ships baseline-grandfathered: a FROZEN baseline records today's literal hits; a NEW hit
 * (not in the baseline, not funneled, not allow-commented) FAILS. The baseline may only
 * shrink. Exit codes: 0 — clean; 1 — at least one new violation.
 *
 * Usage:
 *   node scripts/lint-sync-subprocess-chokepoint.js                     # full scan dirs
 *   node scripts/lint-sync-subprocess-chokepoint.js --staged            # staged files
 *   node scripts/lint-sync-subprocess-chokepoint.js path/to/file.ts     # explicit files
 *   node scripts/lint-sync-subprocess-chokepoint.js --write-baseline    # (re)generate baseline
 *   node scripts/lint-sync-subprocess-chokepoint.js --baseline <p> --root <p>  # test overrides
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const BASELINE = path.resolve(
  argVal('--baseline') || path.join(ROOT, 'scripts', 'sync-subprocess-chokepoint-baseline.json'),
);
// --root overrides the repo root the SCAN_DIRS are resolved against (tests / alternate checkouts).
const SCAN_BASE = path.resolve(argVal('--root') || ROOT);
const SCAN_DIRS = ['src/core', 'src/monitoring', 'src/server'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

// The chokepoint module itself — the SOLE place a raw sync spawn may legitimately live
// (it WRAPS the call in withSyncOp; everything else must route through it).
const CHOKEPOINT = 'src/core/InFlightSyncOpMarker.ts';

// A BARE synchronous child-process spawn imported from node:child_process. The
// negative lookbehind `(?<![.\w])` rejects a member-access form (`SafeGitExecutor.execSync(`,
// `SafeFsExecutor.execFileSync(`) — those are the SAFE funnels, not a raw event-loop block —
// and a longer identifier (`myExecSync`). `\s*\(` so only an actual call matches, never an
// import name. The *Async variants (execFileAsync / execFile) never match (different verb).
const VIOLATION = /(?<![.\w])(spawnSync|execSync|execFileSync)\s*\(/;
const ALLOW = /lint-allow-sync-spawn:/;
// The FUNNEL: a sync spawn lexically wrapped by withSyncOp(...) on the same line is the
// REQUIRED pattern (the (B) marker sees it) — never a violation, regardless of baseline.
const FUNNELED = /\bwithSyncOp\s*\(/;

const inScanDir = (p) => SCAN_DIRS.some((d) => p === d || p.startsWith(d + '/'));
const normalize = (p) => p.split(path.sep).join('/');

function listFiles() {
  if (process.argv.includes('--staged')) {
    const out = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf-8' });
    return out
      .split('\n')
      .filter(Boolean)
      .map(normalize)
      .filter((p) => inScanDir(p));
  }
  // Explicit file args are checked as-given (targeted use / self-tests).
  const explicit = process.argv
    .slice(2)
    .filter((a) => !a.startsWith('--'))
    // Drop the values consumed by --baseline / --root.
    .filter((a) => a !== argVal('--baseline') && a !== argVal('--root'));
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
      else if (EXTENSIONS.has(path.extname(e.name))) files.push(full);
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(SCAN_BASE, d));
  return files;
}

// Collect every raw sync-spawn hit not allow-commented and not in the chokepoint module.
// Keyed on file + the trimmed call line + the occurrence index of that exact line text
// within the file (line-number-independent so the baseline survives edits above it).
function collectHits() {
  const hits = [];
  for (const fileArg of listFiles()) {
    const abs = path.isAbsolute(fileArg) ? fileArg : path.join(ROOT, fileArg);
    const rel = normalize(path.relative(ROOT, abs));
    if (!EXTENSIONS.has(path.extname(rel))) continue;
    if (rel === CHOKEPOINT) continue; // the funnel may wrap sync calls
    let content;
    try {
      content = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const seenLineText = new Map(); // trimmed-line-text → occurrence count so far
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trimStart();
      if (/^(\/\/|\*|\/\*)/.test(trimmed)) continue; // comment-only mention
      if (!VIOLATION.test(raw)) continue;
      // FUNNELED: a sync spawn wrapped by withSyncOp(...) on the same line is the required
      // pattern (the marker sees it) — allowed unconditionally, never grandfathered/baselined.
      if (FUNNELED.test(raw)) continue;
      // Inline justification on this line or within the 6 lines directly above.
      let allowed = false;
      for (let j = i; j >= Math.max(0, i - 6); j--) {
        if (ALLOW.test(lines[j])) {
          allowed = true;
          break;
        }
      }
      if (allowed) continue;
      const text = raw.trim();
      const occ = seenLineText.get(text) ?? 0;
      seenLineText.set(text, occ + 1);
      hits.push({ file: rel, line: i + 1, text, key: `${rel}::${text}::${occ}` });
    }
  }
  return hits;
}

const hits = collectHits();

// Generate-baseline mode: record current hits as grandfathered.
if (process.argv.includes('--write-baseline')) {
  fs.writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        note:
          'FROZEN baseline of RAW synchronous subprocess spawns (spawnSync/execSync/execFileSync) outside the InFlightSyncOpMarker funnel, at tmux Event-Loop Resilience Increment 1. These are grandfathered while the (A)/(B) conversion lands incrementally. May only SHRINK — a NEW raw sync spawn outside the funnel fails the lint. Funnel a call through withSyncOp(), or add an inline "// lint-allow-sync-spawn: <reason>" for a genuine pre-runtime/CLI-boot call.',
        frozenAt: '2026-06-22',
        keys: hits.map((h) => h.key).sort(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`lint-sync-subprocess-chokepoint: wrote baseline with ${hits.length} grandfathered hit(s).`);
  process.exit(0);
}

let baseline = { keys: [] };
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
} catch {
  // No baseline yet → treat as empty (every current hit is a NEW violation).
}
const baselineSet = new Set(baseline.keys || []);

const newViolations = hits.filter((h) => !baselineSet.has(h.key));
if (newViolations.length) {
  console.error('lint-sync-subprocess-chokepoint: FAIL — new RAW synchronous subprocess spawn(s) outside the InFlightSyncOpMarker funnel:');
  for (const v of newViolations) {
    console.error(
      `  • ${v.file}:${v.line} — raw sync spawn (${v.text}). A sync blocking op must funnel through ` +
        `withSyncOp() so the in-flight marker sees it (or add "// lint-allow-sync-spawn: <reason>" for a genuine ` +
        `pre-runtime/CLI-boot call). See docs/specs/tmux-event-loop-resilience-spec.md.`,
    );
  }
  console.error(`\nlint-sync-subprocess-chokepoint: ${newViolations.length} new violation(s).`);
  process.exit(1);
}
console.log(
  `lint-sync-subprocess-chokepoint: clean — ${hits.length} raw sync spawn(s), all grandfathered (${baselineSet.size} baselined).`,
);
process.exit(0);
