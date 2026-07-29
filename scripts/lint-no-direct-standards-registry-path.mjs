#!/usr/bin/env node
/**
 * lint-no-direct-standards-registry-path — the constitution has ONE resolver.
 *
 * `src/core/standardsRegistryPath.ts` is the only place a standards-registry path
 * may be constructed. Every reader takes the typed `RegistryResolution` it returns
 * and never builds a path of its own.
 *
 * WHAT THIS PREVENTS (measured 2026-07-26): three separate readers had each
 * independently written `path.join(projectDir, 'docs', 'STANDARDS-REGISTRY.md')` —
 * the agent-home snapshot, frozen at install, 22 standards against an authored 81.
 * One of them swallowed the read failure and returned an empty list. The bug was
 * not that any single reader was wrong; it was that constructing the path was
 * something any reader could just DO.
 *
 * This is the SUPPLEMENTAL half of a pair, not the mechanism. The primary
 * enforcement is the API boundary: the resolver exports no raw path, so there is
 * nothing for a caller to shortcut. This lint catches the remaining case — someone
 * rebuilding the string from scratch — and is deliberately narrow.
 *
 * Spec: docs/specs/standards-registry-snapshot-refresh.md §9.7.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');

/** The resolver itself is the one place allowed to name the asset. */
const ALLOWED = new Set([
  path.join('src', 'core', 'standardsRegistryPath.ts'),
  // The generator + migrator comment reference the AUTHORED doc by name in prose;
  // both are stripped of comments before matching, so neither needs an exemption.
]);

/**
 * Strip line and block comments before matching.
 *
 * Recorded because the repo has been bitten by the inverse: a text check that
 * reads prose DESCRIBING the forbidden shape fires on documentation and nothing
 * real, so it gets muted and then guards nothing.
 */
function stripComments(src) {
  return src
    // Replace each block comment with the SAME number of newlines it spanned, so
    // reported line numbers still match the real file. Collapsing them to '' made
    // the lint point at line 3 for a violation on line 34 — a guard that fires
    // correctly but sends you to the wrong place is only half a guard.
    .replace(/\/\*[\s\S]*?\*\//g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|js|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(SRC)) {
  const rel = path.relative(ROOT, file);
  if (ALLOWED.has(rel)) continue;
  const code = stripComments(fs.readFileSync(file, 'utf-8'));
  code.split('\n').forEach((line, i) => {
    if (/['"`]STANDARDS-REGISTRY\.md['"`]/.test(line) || /standards-registry\.md['"`]/.test(line)) {
      violations.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
}

if (violations.length > 0) {
  console.error('\n✖ lint-no-direct-standards-registry-path: a registry path is being constructed outside the resolver.\n');
  for (const v of violations) console.error(`   ${v}`);
  console.error(
    '\n  Use `resolveStandardsRegistry()` from src/core/standardsRegistryPath.ts and handle the\n' +
      '  `usable: false` case honestly. Building the path yourself reaches the agent-home snapshot,\n' +
      '  which is frozen at install time and cannot be refreshed — the exact defect this closes.\n',
  );
  process.exit(1);
}

console.log('✓ lint-no-direct-standards-registry-path: the resolver is the only path constructor.');
