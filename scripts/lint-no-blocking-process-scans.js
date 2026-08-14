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
 * ── 2026-08-14: the command name does not have to be written at the callsite.
 * The original pattern required the scan command as a string literal INSIDE the
 * call, so putting the name one step away walked past it — while the event loop
 * stalled just the same, because the incident was about what the process DOES,
 * not how the argument was spelled. instar-codey reproduced the concatenation
 * form (`const cmd = 'pg' + 'rep'; execFileSync(cmd, ['node'])` → exit 0) while
 * auditing rename-defeatable checks, and scoped the fix.
 *
 * NOW RESOLVED before the decision: literal `+` chains, local `const` string
 * bindings, and import aliases of the sync entry points. The VALUE decides, so
 * `const pgrep = 'tmux'` is legal and `const cmd = 'psql'` is not a `ps`.
 *
 * DELIBERATELY NOT CLOSED, so it is stated rather than implied:
 *   · A call split across MULTIPLE LINES. This lint is line-oriented; making it
 *     multi-line means an AST, which is a different check at a different layer.
 *     Pre-existing, not introduced here.
 *   · A command read from config, an argv, or another module. Not foldable
 *     without dataflow analysis, and guessing would over-block correct code —
 *     the more expensive failure for a check that blocks commits.
 *   · Scope: bindings are collected file-wide rather than per-scope, so an
 *     identifier bound twice to DIFFERENT values is treated as unresolvable and
 *     never flagged. That is the safe direction, chosen on purpose.
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

// The scan commands themselves. Word-boundary matched against the RESOLVED
// command value, so `psql` never counts as `ps`.
const SCAN_COMMAND = /^(ps|pgrep|lsof|pkill)\b/;

// The synchronous child-process entry points. Import aliases of these are
// resolved per-file below — `import { execFileSync as run }` then `run('pgrep')`
// stalls the loop exactly as much as calling it by its own name.
const SYNC_BUILTINS = ['spawnSync', 'execSync', 'execFileSync'];

const ALLOW = /lint-allow-blocking-scan:/;

/** A string literal, or a `+` chain of string literals. Nothing else folds. */
const FOLDABLE = /^\s*(?:(?:'[^'\\]*'|"[^"\\]*"|`[^`\\$]*`)\s*\+\s*)*(?:'[^'\\]*'|"[^"\\]*"|`[^`\\$]*`)\s*$/;

/**
 * Fold an expression to its string value, or null if it is not a pure literal
 * chain. `'pg' + 'rep'` → `pgrep`. A template with `${}` never folds.
 */
function foldLiteral(expr) {
  if (!FOLDABLE.test(expr)) return null;
  const parts = expr.match(/'[^'\\]*'|"[^"\\]*"|`[^`\\$]*`/g);
  if (!parts) return null;
  return parts.map((p) => p.slice(1, -1)).join('');
}

/**
 * Local `const NAME = <literal chain>` bindings, file-wide.
 *
 * Deliberately NOT scope-aware: this is a line-oriented lint, not a compiler.
 * The safe direction for a check that BLOCKS COMMITS is to refuse to resolve
 * anything ambiguous, so an identifier bound more than once to DIFFERENT values
 * is recorded as unresolvable and never produces a violation. Over-blocking
 * correct code is the more expensive failure here.
 */
function collectStringConsts(lines) {
  const map = new Map();
  const conflicted = new Set();
  const DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=\s*([^;\n]+)/g;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (/^(\/\/|\*|\/\*)/.test(trimmed)) continue; // a commented-out const binds nothing
    DECL.lastIndex = 0;
    let m;
    while ((m = DECL.exec(line)) !== null) {
      const [, name, rhs] = m;
      const value = foldLiteral(rhs);
      if (value === null) { conflicted.add(name); continue; }
      if (map.has(name) && map.get(name) !== value) conflicted.add(name);
      else map.set(name, value);
    }
  }
  for (const name of conflicted) map.delete(name);
  return map;
}

/** Names in this file that reach a synchronous child-process call. */
function collectSyncNames(text) {
  const names = new Set(SYNC_BUILTINS);
  const IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"]node:child_process['"]/g;
  let m;
  while ((m = IMPORT.exec(text)) !== null) {
    for (const clause of m[1].split(',')) {
      const alias = clause.match(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/);
      if (alias && SYNC_BUILTINS.includes(alias[1])) names.add(alias[2]);
    }
  }
  return names;
}

/**
 * The first argument of `name(` starting at `from`, as source text. Bounded to
 * the line, matching this lint's existing granularity — a call split across
 * lines is a separate, pre-existing gap, declared in the header rather than
 * silently implied.
 */
function firstArg(line, from) {
  let depth = 0;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return line.slice(from, i);
      depth--;
    } else if (c === ',' && depth === 0) return line.slice(from, i);
  }
  return line.slice(from);
}

/**
 * Does this line perform a synchronous scan? Resolves the command through
 * literal folding and local constants before deciding.
 */
function scanViolation(line, syncNames, constMap) {
  for (const name of syncNames) {
    const call = new RegExp(`\\b${name}\\s*\\(`, 'g');
    let m;
    while ((m = call.exec(line)) !== null) {
      const arg = firstArg(line, m.index + m[0].length).trim();
      let value = foldLiteral(arg);
      if (value === null && /^[A-Za-z_$][\w$]*$/.test(arg)) value = constMap.get(arg) ?? null;
      if (value !== null && SCAN_COMMAND.test(value.trim())) return true;
    }
  }
  return false;
}

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
  const syncNames = collectSyncNames(content);
  const constMap = collectStringConsts(lines);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (/^(\/\/|\*|\/\*)/.test(trimmed)) continue; // comment-only mention
    if (!scanViolation(lines[i], syncNames, constMap)) continue;
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
