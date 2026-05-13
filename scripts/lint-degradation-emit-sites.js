#!/usr/bin/env node
/**
 * lint-degradation-emit-sites.js — warning-only lint over DegradationReporter
 * emit sites.
 *
 * Per SELF-HEALING-REMEDIATOR-V2-SPEC.md §A33 / §A50, F-3 ships a back-compat
 * shim that lets legacy `.report(...)` callers continue to work. The lint
 * catalogues every emit site so an incremental migration to the go-forward
 * `reportStructured(...)` API can be tracked. **This lint NEVER blocks** —
 * it always exits 0. F-8 may upgrade it to blocking once the Remediator
 * dispatcher is live and a deprecation timeline is agreed.
 *
 * Output shape (one line per site):
 *   <category>  <relpath>:<line>  <snippet>
 *
 * Categories:
 *   legacy      — `.report({...})` call against a DegradationReporter
 *                 instance (uses the legacy quintuple shape).
 *   structured  — `.reportStructured({...})` call (already migrated).
 *
 * Counts go to stderr; the final exit code is always 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Walk src/ collecting .ts files. The reporter is only consumed from src/ at
// runtime — tests use their own reset/configure dance, and other paths are
// out of scope for the emit-site catalogue.
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip generated / vendored dirs.
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(full, acc);
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

// Match the bare expression `.report(` immediately following an identifier
// that plausibly references DegradationReporter. Two recognised shapes:
//   DegradationReporter.getInstance().report(
//   <name>.report(   where <name> is a binding to a reporter
// Plus `.reportStructured(` for migrated callers.
//
// This is intentionally string-matching: F-8 may upgrade to AST-aware
// detection, but for a warning-only catalogue grep is enough.
const LEGACY_RE = /\.(report)\s*\(/g;
const STRUCTURED_RE = /\.(reportStructured)\s*\(/g;

const SRC_DIR = path.join(ROOT, 'src');
if (!fs.existsSync(SRC_DIR)) {
  console.warn(`[lint-degradation-emit-sites] src/ not found at ${SRC_DIR} — nothing to scan.`);
  process.exit(0);
}

let legacyCount = 0;
let structuredCount = 0;
const lines = [];

for (const file of walk(SRC_DIR)) {
  // Skip the reporter itself — its `.report(` references are method
  // definitions / internal calls, not emit sites we want to track.
  const rel = path.relative(ROOT, file);
  if (rel === path.join('src', 'monitoring', 'DegradationReporter.ts')) continue;

  let content;
  try { content = fs.readFileSync(file, 'utf-8'); }
  catch { continue; }

  // Only files that mention DegradationReporter count as emit sites.
  if (!content.includes('DegradationReporter')) continue;

  const fileLines = content.split('\n');
  for (let i = 0; i < fileLines.length; i++) {
    const line = fileLines[i];
    if (STRUCTURED_RE.test(line)) {
      STRUCTURED_RE.lastIndex = 0;
      structuredCount += 1;
      lines.push(`structured  ${rel}:${i + 1}  ${line.trim()}`);
      continue;
    }
    LEGACY_RE.lastIndex = 0;
    if (LEGACY_RE.test(line)) {
      // Filter `reportStructured` false-positives (regex above matched
      // because `.report(` is a prefix of `.reportStructured(`). The
      // STRUCTURED_RE branch above already handled the structured case,
      // so a line matching both is structured and skipped here.
      if (/\.reportStructured\s*\(/.test(line)) continue;
      legacyCount += 1;
      lines.push(`legacy      ${rel}:${i + 1}  ${line.trim()}`);
    }
    LEGACY_RE.lastIndex = 0;
    STRUCTURED_RE.lastIndex = 0;
  }
}

// Print catalogue to stdout — caller can pipe to a file / grep further.
for (const line of lines) console.log(line);

// Summary to stderr so it doesn't pollute the parseable list.
console.error('');
console.error(`[lint-degradation-emit-sites] legacy:     ${legacyCount}`);
console.error(`[lint-degradation-emit-sites] structured: ${structuredCount}`);
console.error('[lint-degradation-emit-sites] warning-only — exit 0 always (per spec A33 / A50).');

process.exit(0);
