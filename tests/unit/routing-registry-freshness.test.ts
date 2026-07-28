/**
 * Routing-registry freshness ratchet — INSTAR-Bench v3, Task-4 Piece 3 (G2).
 *
 * The CI-authoritative companion to scripts/lint-routing-registry-freshness.js:
 * the human intentional-defaults doc (docs/LLM-ROUTING-REGISTRY.md) must stay
 * EXHAUSTIVE over the LLM callsite set. Where the lint parses source text for
 * pre-commit speed, this test imports the REAL COMPONENT_CATEGORY symbol (robust
 * to any refactor of the map's literal shape) and asserts every key appears in
 * the registry doc — so a new LLM component whose routing default was never
 * intentionally recorded fails the build with instructions.
 *
 * Substring (not table-row) matching, matching the lint: the doc groups aliases
 * and annotates counts, so presence — not row shape — is the invariant.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';
import { REGISTRY_FRESHNESS_ALLOWLIST } from '../../scripts/lint-routing-registry-freshness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_DOC = path.resolve(__dirname, '../../docs/LLM-ROUTING-REGISTRY.md');

describe('routing-registry freshness ratchet', () => {
  const docText = fs.readFileSync(REGISTRY_DOC, 'utf8');

  it('every COMPONENT_CATEGORY key has a row in docs/LLM-ROUTING-REGISTRY.md', () => {
    const missing = Object.keys(COMPONENT_CATEGORY).filter(
      (k) => !docText.includes(k) && !(k in REGISTRY_FRESHNESS_ALLOWLIST),
    );
    expect(
      missing,
      `LLM component(s) with no routing-registry row (routing default never intentionally decided): ` +
        `${missing.join(', ')}.\nAdd a row to docs/LLM-ROUTING-REGISTRY.md (the callsite inventory), ` +
        `or add the name to REGISTRY_FRESHNESS_ALLOWLIST with a reason. INSTAR-Bench v3, Task-4 G2.`,
    ).toEqual([]);
  });

  it('no stale allowlist entry (an allowlisted name that is now present in the doc)', () => {
    const stale = Object.keys(REGISTRY_FRESHNESS_ALLOWLIST).filter((k) => docText.includes(k));
    expect(stale, `remove now-present allowlist entries: ${stale.join(', ')}`).toEqual([]);
  });
});
