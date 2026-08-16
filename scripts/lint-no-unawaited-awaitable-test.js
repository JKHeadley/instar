#!/usr/bin/env node
/**
 * lint-no-unawaited-awaitable-test.js — refuses an `Awaitable<T>` signal used in a
 * BOOLEAN position without `await`.
 *
 * Earned 2026-07-30 (topic 37155, worktree read-path event-loop safety). The
 * defect it pins, in full, because the shape is what matters:
 *
 *   A set of signal functions on an injected deps object were widened from `T` to
 *   `Awaitable<T>` so production could supply non-blocking readers. One consumer —
 *   the guard that re-confirms three signals immediately before an IRREVERSIBLE
 *   worktree delete — kept reading them WITHOUT awaiting. A pending promise is
 *   always truthy and `!promise` is always false, so:
 *     - `if (deps.isInUse(p))`  became permanently TRUE  → every delete refused →
 *       a silently inert reaper that looks healthy and simply never finds anything;
 *     - `if (!(await ...))` written as `if (!deps.isClean(p))` became permanently
 *       FALSE → the gate that protects UNCOMMITTED WORK always passed. A reviewer
 *       proved by execution that in the mixed sync/async configuration a worktree
 *       which went dirty between evaluation and deletion IS DELETED.
 *
 * The type system cannot catch this: a promise in a boolean test is legal
 * TypeScript, and every existing test injected SYNCHRONOUS fakes, so the async
 * shape production actually uses never appeared under test. Both the wrong-way
 * and the dangerous-way failure shipped past six reviewers; only executing the
 * code found it. That is precisely the case for a lint rather than a comment.
 *
 * Rule: in the scan dirs, for any identifier whose declared type CAN be a promise —
 * whether spelled `Awaitable<T>` or as an inline union like
 * `boolean | 'unknown' | Promise<boolean | 'unknown'>` — flag a call to it that sits
 * directly in a boolean position (`if (…)`, `while (…)`, `!x(…)`, `x(…) ? :`,
 * `&&` / `||` operands) with no `await` between the boolean context and the call.
 *
 * ROUND-FOUR CORRECTION — it used to key on the SPELLING. The first version matched
 * only the `Awaitable<` alias and skipped any file that did not contain that literal.
 * Three reviewers independently found the hole: `OrphanedWorkSentinel.ts` was widened
 * BY THE SAME CHANGE using inline unions, so the one other file where this diff
 * introduced the hazard was excluded outright — and reintroducing the defect there
 * (which blinds the stranded-work detector completely) shipped green. A guard keyed
 * on how a type is written rather than on what it means protects the file that
 * happens to use the preferred spelling, which is not the property anyone wanted.
 *
 * This is intentionally narrow (same-file declarations, direct call syntax). It
 * catches the exact recurrence, not every theoretical variant; a lint that is
 * mostly false positives gets disabled, which protects nothing.
 *
 * Escape hatch (closed, reviewed): a genuinely deliberate truthiness test of the
 * FUNCTION ITSELF (e.g. an optional dep: `if (deps.hasMarker)`) is not a call and
 * is never flagged. For anything else, justify inline on the line or within the
 * comment block directly above:
 *     // lint-allow-unawaited-awaitable: <why this is correct here>
 *
 * Exit codes: 0 — clean; 1 — at least one violation.
 *
 * Usage:
 *   node scripts/lint-no-unawaited-awaitable-test.js            # full repo
 *   node scripts/lint-no-unawaited-awaitable-test.js --staged   # staged files
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// Where a signal that gates a destructive or safety decision actually lives.
const SCAN_DIRS = ['src/monitoring', 'src/core', 'src/server'];
const EXTENSIONS = new Set(['.ts', '.tsx']);
const ALLOW = /lint-allow-unawaited-awaitable:/;

const inScanDir = (p) => SCAN_DIRS.some((d) => p.startsWith(d + '/'));

/**
 * Names declared with an `Awaitable<...>` type in this file. Covers both the
 * interface-member form (`isClean: (path: string) => Awaitable<boolean>;`) and
 * the local-annotation form (`const f: () => Awaitable<X> = …`).
 */
function awaitableNames(content) {
  const names = new Set();
  // Two spellings, one meaning: the `Awaitable<T>` alias, and an inline union with a
  // `Promise<…>` arm. Both declare "this may be a promise", which is the property
  // that makes a bare boolean test wrong.
  // ANCHORED ON `=>`, and that anchor is load-bearing (round-five integration
  // finding). The matcher is line-scoped, not declaration-scoped, so without it a
  // one-line async signature registers its PARAMETERS: in
  //     private async f(a: string, reason: 'x' | 'y'): Promise<void>
  // the `Promise<` is the RETURN type, and `reason` was registered as
  // "may be a promise". Measured across the scan dirs, that falsely registered
  // `reason`, `origin`, `tier`, `priority`, `text`, `body`, `message` and more —
  // some of the most common identifiers in the codebase, including in the 34k-line
  // routes file. Nothing fired today only because a CALL in boolean position is
  // also required; the day someone writes `if (reason(x))` this lint hard-fails the
  // blocking chain and prescribes the WRONG remedy ("await it"), and the realistic
  // response is to disable it. A guard that will predictably be disabled protects
  // nothing, which is this lint's own stated design rule.
  //
  // Every signal this exists to pin is declared as a FUNCTION type
  // (`name: (args) => Awaitable<T>`), so requiring `=>` before the promise-ish arm
  // keeps the intended catch and drops the parameter class entirely — verified
  // against both target modules.
  for (const re of [
    /(?:^|[\s{;,])([A-Za-z_$][\w$]*)\s*(?:\?)?\s*:[^;\n]*=>[^;\n]*\bAwaitable\s*</g,
    /(?:^|[\s{;,])([A-Za-z_$][\w$]*)\s*(?:\?)?\s*:[^;\n]*=>[^;\n]*\|[^;\n]*\bPromise\s*</g,
    /(?:^|[\s{;,])([A-Za-z_$][\w$]*)\s*(?:\?)?\s*:[^;\n]*=>[^;\n]*\bPromise\s*<[^;\n]*\|/g,
  ]) {
    let m;
    while ((m = re.exec(content)) !== null) names.add(m[1]);
  }
  return names;
}

function listFiles() {
  if (process.argv.includes('--staged')) {
    const out = execSync('git diff --cached --name-only', { cwd: ROOT, encoding: 'utf-8' });
    return out.split('\n').filter(Boolean).filter((p) => inScanDir(p.split(path.sep).join('/')));
  }
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

/**
 * Boolean-position call sites for `name` on one line, with no `await` guarding
 * the call. `guard` is the text immediately preceding the call — an `await`
 * there (possibly through `(` or `!`) means the value, not the promise, is tested.
 */
function violatingCalls(line, name) {
  const hits = [];
  // The call itself: `foo(`, `this.deps.foo(`, `d.foo(`.
  const call = new RegExp(`(?:^|[^\\w$.])((?:[\\w$]+\\.)*)${name}\\s*\\(`, 'g');
  let m;
  while ((m = call.exec(line)) !== null) {
    const before = line.slice(0, m.index + m[0].length - (m[1].length + name.length + 1));
    // Is this call in a boolean position?
    const inBooleanPosition =
      /\b(?:if|while)\s*\(\s*[!(\s]*$/.test(before) ||
      /[!&|]{1,2}\s*[(\s]*$/.test(before) ||
      /\breturn\s+[!(\s]*$/.test(before) && /\?/.test(line);
    if (!inBooleanPosition) continue;
    // An `await` anywhere in the guarding prefix (after the last boolean opener)
    // means the awaited VALUE is what is tested.
    const lastOpener = Math.max(
      before.lastIndexOf('('), before.lastIndexOf('&'), before.lastIndexOf('|'), before.lastIndexOf('!'),
    );
    const guard = before.slice(lastOpener + 1);
    if (/\bawait\b/.test(guard) || /\bawait\b/.test(before.slice(Math.max(0, lastOpener - 6)))) continue;
    hits.push(name);
  }
  return hits;
}

let violations = 0;
for (const rel of listFiles()) {
  const normalized = rel.split(path.sep).join('/');
  if (!EXTENSIONS.has(path.extname(normalized))) continue;
  const full = path.isAbsolute(normalized) ? normalized : path.join(ROOT, normalized);
  let content;
  try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
  // Cheap pre-filter on the two spellings the extractor understands. Keyed on
  // MEANING (a possibly-promise declaration), never on the alias alone — see the
  // round-four correction in the header.
  if (!content.includes('Awaitable<') && !content.includes('Promise<')) continue;
  const names = awaitableNames(content);
  if (names.size === 0) continue;

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    if (/^(\/\/|\*|\/\*)/.test(trimmed)) continue; // comment-only mention
    for (const name of names) {
      if (!lines[i].includes(name)) continue;
      if (violatingCalls(lines[i], name).length === 0) continue;
      let allowed = false;
      for (let j = i; j >= Math.max(0, i - 6); j--) {
        if (ALLOW.test(lines[j])) { allowed = true; break; }
      }
      if (allowed) continue;
      console.error(
        `${normalized}:${i + 1} — '${name}' is declared Awaitable<…> and is tested as a boolean ` +
        `without await. A pending promise is ALWAYS truthy and '!promise' is ALWAYS false, so this ` +
        `gate does not evaluate what it appears to (2026-07-30: this exact shape made a worktree ` +
        `deletion guard both permanently-refusing and, in the mixed configuration, delete-anyway). ` +
        `Await it, or add an inline "// lint-allow-unawaited-awaitable: <reason>".`,
      );
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(`\nlint-no-unawaited-awaitable-test: ${violations} violation(s). ` +
    `See docs/findings/2026-07-30-shared-signal-opposite-polarity.md for the sibling class.`);
  process.exit(1);
}
console.log('lint-no-unawaited-awaitable-test: clean');
