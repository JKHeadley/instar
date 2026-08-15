#!/usr/bin/env node
/**
 * lint-no-direct-url-log.js — ban logging credentialed URLs.
 *
 * The 2026-05-27 incident: `instar join` logged a clone URL containing a live
 * GitHub token. This lint fails CI if any source file logs a string that
 * looks like it could embed credentials (a `scheme://user:pass@` literal, or a
 * console.* call interpolating a known credential-bearing variable) WITHOUT
 * routing it through the redaction funnel `src/core/redactUrl.ts`.
 *
 * Conservative by design: it flags the two concrete shapes we know leak, not
 * every URL log. The redactUrl module + its tests are exempt.
 *
 * SCOPE, split by whether the match detects the prohibited FACT or a SPELLING
 * of it (the distinction that decides which half is worth widening):
 *
 *   - CREDENTIALED_URL_LITERAL is the FACT. A `user:pass@` inside a URL literal
 *     IS the leak, whatever it is called or where it is logged. So resolving a
 *     split literal is a real closure, not a bigger net: as of 2026-08-15 the
 *     line is scanned with adjacent string concatenations folded, because
 *     `"https://user:" + "tok@host"` leaked exactly as much as the one-piece
 *     form and was invisible. Folding joins only ADJACENT literals of the same
 *     quote style and invents no text.
 *
 *   - RISKY_URL_VAR_LOG is a SPELLING. It matches five variable names logged
 *     through `console.*`. Renaming the variable (`originUrl`, `endpoint`) or
 *     using any other sink (`logger.info`) defeats it — both measured. Growing
 *     the name list would make the net finer while leaving the judgment inside
 *     the pattern, so it is deliberately NOT widened here. The right repair is
 *     to demote it from decider to candidate-gatherer and put the weighing
 *     downstream; that changes the check's authority and belongs in a spec, not
 *     in a regex edit.
 *
 * Exit 0 = clean. Exit 1 = at least one offending site (printed).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

// Files that are allowed to contain the patterns (the funnel + its tests).
const EXEMPT = [
  path.join('src', 'core', 'redactUrl.ts'),
];

/** A literal `scheme://user:pass@` in a string that is being logged. */
const CREDENTIALED_URL_LITERAL = /['"`][a-z][a-z0-9+.-]*:\/\/[^/@'"`\s]+:[^/@'"`\s]+@/i;

/**
 * Fold `"a" + "b"` (adjacent string literals, same quote style) into `"ab"` so a
 * credentialed URL split across a concatenation is scanned as the string it
 * actually builds. Only literal+literal joins are folded — a variable operand
 * ends the fold, so nothing is invented and no non-literal is assumed.
 */
export function collapseConcatenation(line) {
  let out = line;
  for (let i = 0; i < 8; i += 1) {
    const next = out.replace(/(['"])((?:\\.|(?!\1)[^\\])*)\1\s*\+\s*(['"])((?:\\.|(?!\3)[^\\])*)\3/g,
      (_m, q1, a, _q2, b) => `${q1}${a}${b}${q1}`);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** console.* logging a variable named like a clone/remote URL without redactUrl on the same line. */
const RISKY_URL_VAR_LOG = /console\.(log|error|warn|info)\([^)]*\b(repoUrl|cloneUrl|remoteUrl|pushUrl|gitUrl)\b/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'templates') continue;
      walk(full, out);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The scan, callable. Returns the offender list instead of exiting, so the
 * behaviour can be unit-tested.
 *
 * This module previously exported nothing, so running the whole scan at module
 * scope and calling process.exit() was harmless. Adding an export above makes
 * that live: importing it to test the fold would run the repo scan and kill the
 * test process the moment the repo had a real violation. Hence the
 * direct-invocation guard at the bottom.
 */
// `srcDir`/`rootDir` default to this repo, so the shipped CLI behaviour is
// unchanged. They exist so the scanner can be driven over a throwaway tree in a
// test WITHOUT planting a probe file inside `src/` — planting one there both
// trips SourceTreeGuard (which refuses any delete inside the instar source
// tree) and is visible to every other test running at the same time.
export function scanForCredentialedUrlLogs(srcDir = SRC, rootDir = ROOT) {
const offenders = [];
for (const file of walk(srcDir)) {
  const rel = path.relative(rootDir, file);
  if (EXEMPT.includes(rel)) continue;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    const hasRedact = line.includes('redactUrl') || line.includes('redactUrlsInText');
    // The FACT half is tested against the folded line; the SPELLING half is
    // tested against the raw line exactly as before (unchanged behaviour).
    if (CREDENTIALED_URL_LITERAL.test(collapseConcatenation(line))) {
      offenders.push(`${rel}:${i + 1}  credentialed-URL literal: ${line.trim().slice(0, 100)}`);
    } else if (RISKY_URL_VAR_LOG.test(line) && !hasRedact) {
      offenders.push(`${rel}:${i + 1}  logs a clone/remote URL var without redactUrl(): ${line.trim().slice(0, 100)}`);
    }
  });
}

return offenders;
}

// Only scan + exit when RUN, never when imported (see the note above).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const offenders = scanForCredentialedUrlLogs();
  if (offenders.length > 0) {
    console.error('[lint-no-direct-url-log] credentialed-URL logging detected:');
    for (const o of offenders) console.error(`  - ${o}`);
    console.error('\nRoute the URL through redactUrl()/redactUrlsInText() from src/core/redactUrl.ts before logging.');
    process.exit(1);
  }
  console.log('[lint-no-direct-url-log] ✓ no credentialed-URL logging found');
  process.exit(0);
}
