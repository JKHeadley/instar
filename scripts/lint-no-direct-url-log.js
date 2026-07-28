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

const offenders = [];
for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file);
  if (EXEMPT.includes(rel)) continue;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    const hasRedact = line.includes('redactUrl') || line.includes('redactUrlsInText');
    if (CREDENTIALED_URL_LITERAL.test(line)) {
      offenders.push(`${rel}:${i + 1}  credentialed-URL literal: ${line.trim().slice(0, 100)}`);
    } else if (RISKY_URL_VAR_LOG.test(line) && !hasRedact) {
      offenders.push(`${rel}:${i + 1}  logs a clone/remote URL var without redactUrl(): ${line.trim().slice(0, 100)}`);
    }
  });
}

if (offenders.length > 0) {
  console.error('[lint-no-direct-url-log] credentialed-URL logging detected:');
  for (const o of offenders) console.error(`  - ${o}`);
  console.error('\nRoute the URL through redactUrl()/redactUrlsInText() from src/core/redactUrl.ts before logging.');
  process.exit(1);
}
console.log('[lint-no-direct-url-log] ✓ no credentialed-URL logging found');
process.exit(0);
