#!/usr/bin/env node
/**
 * lint-routing-registry-freshness.js — the human intentional-defaults layer
 * (docs/LLM-ROUTING-REGISTRY.md) must stay EXHAUSTIVE over the LLM callsite set.
 *
 * INSTAR-Bench v3, Task-4 Piece 3 (gap G2). The routing registry is the layer
 * where a HUMAN records, per benched component, the intended default route +
 * nature — the decision layer above `COMPONENT_CATEGORY` (which framework?) and
 * `LLM_BENCH_COVERAGE` (which benchmark?). If a component exists in the category
 * map but is ABSENT from the registry doc, its routing default was never
 * intentionally decided — an unmeasured routing decision, the exact gap the
 * benchmark discipline exists to close. This lint fails when that happens.
 *
 * WHAT IT CHECKS: every key of `COMPONENT_CATEGORY`
 * (src/core/componentCategories.ts) must appear — as a literal substring — SOME-
 * WHERE in docs/LLM-ROUTING-REGISTRY.md. Substring (not table-row) matching is
 * deliberate: the doc legitimately groups aliases ("TaskClassifier /
 * OverrideDetector / …") and annotates counts ("SessionActivitySentinel ×3"),
 * so a strict per-row parse would false-positive. The invariant is presence, not
 * shape — mirrors the shrink-only spirit of the bench-coverage ratchet.
 *
 * ALLOWLIST: seeded EMPTY. A component that genuinely has no registry row (e.g.
 * a router-bypass callsite documented elsewhere) must be added here WITH A
 * REASON — a visible, reviewed act, exactly like the bench-coverage exemptions.
 * The companion ratchet test (tests/unit/routing-registry-freshness.test.ts)
 * pins the same invariant in CI over the real imported symbol.
 *
 * Exit codes: 0 — every key present; 1 — at least one missing (or a stale
 * allowlist entry: an allowlisted name that is now present fails with "remove me").
 *
 * Usage:
 *   node scripts/lint-routing-registry-freshness.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const CATEGORY_SRC = path.join(ROOT, 'src', 'core', 'componentCategories.ts');
const REGISTRY_DOC = path.join(ROOT, 'docs', 'LLM-ROUTING-REGISTRY.md');

/**
 * Components with no registry row, each with a REASON. Seeded EMPTY (the doc is
 * exhaustive today). Adding a name is a visible, reviewed act; an entry that is
 * no longer missing fails this lint with "remove me".
 * @type {Record<string,string>}
 */
export const REGISTRY_FRESHNESS_ALLOWLIST = {};

/**
 * Extract COMPONENT_CATEGORY keys from the TypeScript source by lexical scan
 * (the house pattern for lint scripts — they run pre-compile, so they read
 * source text, not the compiled module). Matches `Name: 'category'` and
 * `'quoted-name': 'category'` where category is a known ComponentCategory.
 * @param {string} src
 * @returns {string[]}
 */
export function extractCategoryKeys(src) {
  const start = src.indexOf('COMPONENT_CATEGORY: Readonly');
  if (start < 0) throw new Error('COMPONENT_CATEGORY object not found in componentCategories.ts');
  const body = src.slice(start, src.indexOf('};', start));
  const keyRe =
    /^\s*(?:([A-Za-z][A-Za-z0-9_]*)|["']([^"']+)["'])\s*:\s*["'](?:sentinel|gate|job|reflector|other)["']/gm;
  const keys = [];
  let m;
  while ((m = keyRe.exec(body)) !== null) keys.push(m[1] || m[2]);
  return [...new Set(keys)];
}

/**
 * @param {string} categorySrc
 * @param {string} docText
 * @param {Record<string,string>} allowlist
 * @returns {{ missing: string[], staleAllowlist: string[] }}
 */
export function runRegistryFreshness(categorySrc, docText, allowlist = REGISTRY_FRESHNESS_ALLOWLIST) {
  const keys = extractCategoryKeys(categorySrc);
  const missing = [];
  for (const k of keys) {
    if (docText.includes(k)) continue;
    if (k in allowlist) continue;
    missing.push(k);
  }
  // Stale allowlist: an allowlisted name that IS present in the doc now.
  const staleAllowlist = Object.keys(allowlist).filter((k) => docText.includes(k));
  return { missing, staleAllowlist };
}

function main() {
  let categorySrc;
  let docText;
  try {
    categorySrc = fs.readFileSync(CATEGORY_SRC, 'utf8');
    docText = fs.readFileSync(REGISTRY_DOC, 'utf8');
  } catch (err) {
    console.error(`lint-routing-registry-freshness: cannot read inputs — ${err.message}`);
    process.exit(1);
  }
  const { missing, staleAllowlist } = runRegistryFreshness(categorySrc, docText);
  if (missing.length === 0 && staleAllowlist.length === 0) {
    console.log('lint-routing-registry-freshness: OK — every COMPONENT_CATEGORY key has a registry row.');
    process.exit(0);
  }
  if (missing.length > 0) {
    console.error(
      'lint-routing-registry-freshness: the following LLM component(s) have NO row in ' +
        'docs/LLM-ROUTING-REGISTRY.md (their routing default was never intentionally decided):\n' +
        missing.map((m) => `  - ${m}`).join('\n') +
        '\n\nAdd a row for each to docs/LLM-ROUTING-REGISTRY.md (the callsite inventory), or — if it ' +
        'genuinely has no registry row — add it to REGISTRY_FRESHNESS_ALLOWLIST with a reason. ' +
        'INSTAR-Bench v3, Task-4 Piece 3 (G2).',
    );
  }
  if (staleAllowlist.length > 0) {
    console.error(
      '\nlint-routing-registry-freshness: allowlist entries that are now present in the doc — remove me:\n' +
        staleAllowlist.map((m) => `  - ${m}`).join('\n'),
    );
  }
  process.exit(1);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) main();
