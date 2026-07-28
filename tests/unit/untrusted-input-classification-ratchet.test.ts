/**
 * untrustedInput classification ratchet — the test-side enforcement of the
 * Authority-Clause standard's classification (docs/specs/authority-clause-standard.md §3).
 *
 * Guarantees, structurally:
 *   1. EVERY LLM component in COMPONENT_CATEGORY carries an EXPLICIT
 *      untrustedInput classification — there is NO default. A new LLM callsite
 *      that forgets to classify its untrusted-input story fails CI (a silent
 *      omission can never default toward the unguarded state).
 *   2. No dangling entries (classification keys must name real components).
 *   3. The argued-FALSE set is pinned SHRINK-ONLY and each false argues a real
 *      reason (>= 40 chars — a lazy "n/a" is refused), exactly like the
 *      bench-coverage exemptions.
 *   4. CROSS-CHECK: any sentinel/gate-category callsite marked `false` must be
 *      in the reviewed allowlist. A NEW false in a sentinel/gate category (the
 *      categories most likely to judge untrusted content) fails until it is
 *      added to the pinned allowlist — a visible, reviewed act (design §3).
 *
 * Ships DARK/report-only in the sense that it wires no runtime gate; it is a
 * pinned-baseline ratchet in the same family as llm-bench-coverage-ratchet.
 */
import { describe, it, expect } from 'vitest';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';
import {
  LLM_UNTRUSTED_INPUT,
  type UntrustedInputFlag,
} from '../../src/data/llmBenchCoverage.js';

function isArguedFalse(v: UntrustedInputFlag): v is { false: string } {
  return typeof v === 'object' && v !== null && 'false' in v;
}

// ── Pinned argued-FALSE baseline (2026-07-02). SHRINK-ONLY: flipping an entry
// to `true` removes it here; ADDING a name means you are declaring a component
// does NOT judge untrusted content — argue the reason in
// src/data/llmBenchCoverage.ts AND add it here (a visible, reviewed act). ──
const ARGUED_FALSE_BASELINE = [
  'PromiseBeacon',
  'InteractivePoolCanaryJudge',
  'AutoApprover',
  'IntegrationGate',
  'CoherenceGate',
  'InputDetector',
].sort();

// ── Pinned REVIEWED-false sentinel/gate allowlist. A sentinel or gate marked
// `false` is the highest-risk classification (these categories most often judge
// untrusted content), so each must be explicitly reviewed onto this list. A new
// sentinel/gate false NOT here fails the cross-check until reviewed. ──
const REVIEWED_FALSE_SENTINEL_GATE = [
  'PromiseBeacon', // sentinel — no live LLM prompt
  'InteractivePoolCanaryJudge', // sentinel — fixed canary constant
  'AutoApprover', // gate — no LLM prompt of its own
  'IntegrationGate', // gate — delegates, no own callsite
  'CoherenceGate', // gate — flows through CoherenceReviewer
  'InputDetector', // sentinel — attribution alias, live matcher is PromptGate
].sort();

describe('untrustedInput classification ratchet', () => {
  it('every COMPONENT_CATEGORY key has an EXPLICIT untrustedInput classification (no default)', () => {
    const missing = Object.keys(COMPONENT_CATEGORY).filter((k) => !(k in LLM_UNTRUSTED_INPUT));
    expect(
      missing,
      `LLM component(s) with no untrustedInput classification: ${missing.join(', ')}.\n` +
        'Add each to LLM_UNTRUSTED_INPUT in src/data/llmBenchCoverage.ts as `true` (it judges ' +
        'untrusted content) or `{ false: "<argued reason>" }` (it does not — ALSO add it to the ' +
        'ARGUED_FALSE_BASELINE in this test). authority-clause-standard.md §3.',
    ).toEqual([]);
  });

  it('no dangling classification entries (keys must exist in COMPONENT_CATEGORY)', () => {
    const dangling = Object.keys(LLM_UNTRUSTED_INPUT).filter((k) => !(k in COMPONENT_CATEGORY));
    expect(dangling, `classification entries for unknown components: ${dangling.join(', ')}`).toEqual(
      [],
    );
  });

  it('the argued-FALSE set matches the pinned shrink-only baseline exactly', () => {
    const actualFalse = Object.entries(LLM_UNTRUSTED_INPUT)
      .filter(([, v]) => isArguedFalse(v))
      .map(([k]) => k)
      .sort();
    expect(
      actualFalse,
      'The argued-false set drifted from the pinned baseline. Flipping a false→true is a ' +
        'shrink (remove it from ARGUED_FALSE_BASELINE); adding a new false requires editing this ' +
        'pinned baseline — a visible, reviewed act.',
    ).toEqual(ARGUED_FALSE_BASELINE);
  });

  it('every argued-false carries a real reason (>= 40 chars)', () => {
    const lazy = Object.entries(LLM_UNTRUSTED_INPUT)
      .filter(([, v]) => isArguedFalse(v))
      .filter(([, v]) => (v as { false: string }).false.trim().length < 40)
      .map(([k]) => k);
    expect(lazy, `argued-false entries with a too-short reason: ${lazy.join(', ')}`).toEqual([]);
  });

  it('cross-check: every sentinel/gate marked false is on the reviewed allowlist', () => {
    const unreviewed = Object.entries(LLM_UNTRUSTED_INPUT)
      .filter(([, v]) => isArguedFalse(v))
      .map(([k]) => k)
      .filter((k) => COMPONENT_CATEGORY[k] === 'sentinel' || COMPONENT_CATEGORY[k] === 'gate')
      .filter((k) => !REVIEWED_FALSE_SENTINEL_GATE.includes(k));
    expect(
      unreviewed,
      `sentinel/gate component(s) marked untrustedInput:false without review: ${unreviewed.join(', ')}.\n` +
        'A sentinel or gate that does NOT judge untrusted content is the highest-risk ' +
        'classification. Add it to REVIEWED_FALSE_SENTINEL_GATE in this test after confirming ' +
        'it genuinely has no live callsite that sees external content.',
    ).toEqual([]);
  });

  it('the reviewed allowlist has no stale entries (allowlisted names are actually false sentinels/gates)', () => {
    const stale = REVIEWED_FALSE_SENTINEL_GATE.filter((k) => {
      const v = LLM_UNTRUSTED_INPUT[k];
      const cat = COMPONENT_CATEGORY[k];
      return !(v && isArguedFalse(v) && (cat === 'sentinel' || cat === 'gate'));
    });
    expect(stale, `stale reviewed-allowlist entries: ${stale.join(', ')}`).toEqual([]);
  });
});
