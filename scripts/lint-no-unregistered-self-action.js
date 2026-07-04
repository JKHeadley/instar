#!/usr/bin/env node
// safe-git-allow: CI-only lint — single read-only `git diff --cached --name-only`
//   to list staged files; runs on runners where the TS SafeGitExecutor is not
//   importable from a standalone .js.
/**
 * lint-no-unregistered-self-action.js — the FORCING lint for the
 * `unbounded-self-action` defect class (docs/specs/self-action-convergence.md
 * → Part D4). Structural twin of `lint-no-unbounded-llm-spawn.js`, and — per
 * both external reviewers (codex + gemini) — emit-anchored and fail-closed, NOT
 * shape-heuristic: it keys on the self-action EMIT itself (the shared detector,
 * scripts/lib/self-action-detect.mjs), so a developer cannot dodge it by
 * renaming the driver method.
 *
 * THE RULE (fail-closed once enforcing): a self-action CONTROLLER source file
 * (the E1 scope predicate — a src/ *Monitor|*Sentinel|*Reaper|*Beacon|*Engine|
 * *Scheduler|*Watchdog|*Poller|*Manager.ts, or any file carrying the marker)
 * that contains a self-action emit MUST EITHER:
 *   - register — carry `@self-action-controller: <id>` AND have <id> present in
 *     SELF_ACTION_CONTROLLERS (so the convergence ratchet covers it), OR
 *   - be allowlisted — appear in ALLOWLIST with a stated reason that it is a
 *     genuine one-shot / user-driven action, not a self-triggered loop.
 * Anything else is a violation.
 *
 * ROLLOUT (matches the class-closure gate it composes with): REPORT-ONLY by
 * default — it prints the population of unregistered controllers and ALWAYS
 * exits 0. It exits nonzero ONLY when `prGate.classClosure.enabled && !dryRun`
 * (the enforcing flip the operator makes on measured population). This is
 * "enforcement first, report-only, graduate after a clean soak."
 *
 * SCOPE (report-only): controller-SHAPE files only (the E1 predicate) — the
 * exact files the class is about — so the telemetry is actionable rather than a
 * repo-wide wall of every `retry(` in src/. Widening to ALL src/ emits is gated
 * behind the enforcing flip + the obfuscation-resistant funnel (Part B).
 * <!-- tracked: CMT-1911 -->
 *
 * HONEST COVERAGE LIMIT (both reviewers, recorded): a string-based lint deters
 * ACCIDENTAL unbounded loops; it is not a hard boundary against DELIBERATE
 * obfuscation (`const v='swap'; self[v]()`). The obfuscation-resistant closure
 * is the funnel (Part B); deliberately obfuscating an emit to evade this gate is
 * a conduct violation, not a clever workaround.
 *
 * Usage:
 *   node scripts/lint-no-unregistered-self-action.js            # full repo
 *   node scripts/lint-no-unregistered-self-action.js --staged   # staged files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  SELF_ACTION_EMIT,
  isSelfActionControllerFile,
  selfActionControllerMarkerId,
} from './lib/self-action-detect.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const SCAN_DIRS = ['src'];
const EXTENSIONS = new Set(['.ts']);

// ── Allowlist (closed). Adding an entry requires a stated reason that the
//    file's self-action emit is a genuine one-shot / user-driven action or is
//    otherwise bounded outside the registry — same governance as the spawn
//    lint's allowlist. ─────────────────────────────────────────────────────
const ALLOWLIST = new Set([
  // The controller-registration harness itself names verbs + the marker.
  'src/testing/selfActionRegistry.ts',
]);

/** Read the prGate.classClosure config, or the report-only default. */
export function loadEnforcementConfig(repoRoot) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(repoRoot, '.instar', 'config.json'), 'utf-8'));
    const cc = cfg && cfg.prGate && cfg.prGate.classClosure;
    if (cc && typeof cc === 'object') {
      return { enabled: cc.enabled === true, dryRun: cc.dryRun !== false };
    }
  } catch {
    /* no config → report-only default */
  }
  return { enabled: false, dryRun: true };
}

/** Parse the registered controller ids out of the registry source (greppable `id: '...'`). */
export function loadRegistryIds(registrySource) {
  const ids = new Set();
  if (typeof registrySource !== 'string') return ids;
  const re = /\bid:\s*['"`]([A-Za-z0-9_-]+)['"`]/g;
  let m;
  while ((m = re.exec(registrySource)) !== null) ids.add(m[1]);
  return ids;
}

/** A line is an emitting statement if it matches the detector AND is not a comment/prose line. */
function lineIsEmit(line) {
  const t = line.trimStart();
  if (t === '' || /^(\/\/|\*|\/\*|#)/.test(t)) return false;
  if (/^(import|export)\b/.test(t) && /\bfrom\b/.test(t)) return false;
  return SELF_ACTION_EMIT.test(line);
}

/**
 * Pure evaluation over a prepared file set — exported for tests.
 * @param {{ files: string[], registryIds: Set<string>, allowlist?: Set<string>, readFile: (rel:string)=>string|null }} input
 * @returns {{ violations: Array<{file:string, reason:string, line:number}>, considered: number }}
 */
export function evaluateSelfActionLint({ files, registryIds, allowlist = ALLOWLIST, readFile }) {
  const violations = [];
  let considered = 0;
  for (const rel of files) {
    const norm = rel.split(path.sep).join('/');
    if (!EXTENSIONS.has(path.extname(norm))) continue;
    if (/(^|\/)tests\//.test(norm) || /\.test\.ts$/.test(norm)) continue;
    if (allowlist.has(norm)) continue;
    const content = readFile(norm);
    if (content == null) continue;
    // Scope: a controller-shape file OR a file carrying the marker.
    if (!isSelfActionControllerFile(norm, content)) continue;
    // Does it emit a self-action?
    const lines = content.split('\n');
    let emitLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lineIsEmit(lines[i])) { emitLine = i + 1; break; }
    }
    if (emitLine === -1) continue; // a controller-shape file with no emit is fine
    considered += 1;
    // Registered? — carries the marker AND its id is in the registry.
    const markerId = selfActionControllerMarkerId(content);
    if (markerId && registryIds.has(markerId)) continue; // registered — the ratchet covers it
    if (markerId && !registryIds.has(markerId)) {
      violations.push({
        file: norm,
        line: emitLine,
        reason: `carries @self-action-controller: ${markerId} but that id is NOT in SELF_ACTION_CONTROLLERS (register it in src/testing/selfActionRegistry.ts)`,
      });
      continue;
    }
    violations.push({
      file: norm,
      line: emitLine,
      reason: 'a self-action controller with an unregistered emit — add /* @self-action-controller: <id> */ and register <id> in SELF_ACTION_CONTROLLERS (or allowlist it with a one-shot/user-driven reason)',
    });
  }
  return { violations, considered };
}

// ── CLI: gather files, evaluate, report/enforce ────────────────────────────
function listFiles() {
  const staged = process.argv.includes('--staged');
  if (staged) {
    const out = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf-8' });
    return out.split('\n').filter(Boolean).filter((f) => EXTENSIONS.has(path.extname(f)));
  }
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

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const registrySource = (() => {
    try { return fs.readFileSync(path.join(ROOT, 'src', 'testing', 'selfActionRegistry.ts'), 'utf-8'); }
    catch { return ''; }
  })();
  const registryIds = loadRegistryIds(registrySource);
  const files = listFiles();
  const { violations, considered } = evaluateSelfActionLint({
    files,
    registryIds,
    readFile: (rel) => {
      try { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); } catch { return null; }
    },
  });
  const { enabled, dryRun } = loadEnforcementConfig(ROOT);
  const enforcing = enabled && !dryRun;

  console.log(`lint-no-unregistered-self-action: ${enforcing ? 'ENFORCING' : 'report-only'} — ` +
    `${considered} controller-shape emitter(s) scanned, ${violations.length} unregistered.`);
  for (const v of violations) {
    console[enforcing ? 'error' : 'log'](`  ${v.file}:${v.line} — ${v.reason}`);
  }
  if (enforcing && violations.length > 0) {
    console.error(`\nlint-no-unregistered-self-action: ${violations.length} violation(s). ` +
      `See docs/specs/self-action-convergence.md (Part D4).`);
    process.exit(1);
  }
  if (violations.length > 0) {
    console.log('  (report-only — no build failure; the enforcing flip is gated on prGate.classClosure.dryRun:false after a measured clean soak.)');
  }
  process.exit(0);
}
