/**
 * LLM routing-nature ratchet — INSTAR-Bench v3 (Task-4 Piece 3, G1 join).
 *
 * `LLM_BENCH_COVERAGE` proves a component is BENCHED; `LLM_ROUTING_NATURE`
 * carries the bench-cited task-NATURE + production CHAIN for it, so *routing*
 * (not just existence) is benchmark-cited. This test keeps that map honest:
 *
 *   1. No dangling routing claim — every key exists in COMPONENT_CATEGORY.
 *   2. Cite-the-bench — every key present here is bench-COVERED in
 *      LLM_BENCH_COVERAGE (you may not cite a routing nature for an unbenched
 *      or merely-pending/exempt component).
 *   3. Valid enums — nature ∈ {A,B,D,E}, chain ∈ {FAST,SORT,JUDGE,WRITE}.
 *   4. Nature→chain coherence — A→FAST|SORT, B→JUDGE, D→SORT|WRITE, E→JUDGE.
 *
 * Companion to llm-bench-coverage-ratchet (existence) and
 * routing-registry-freshness (the human intentional-defaults doc). Together the
 * chain is: new LLM call → COMPONENT_CATEGORY → bench coverage → (when its
 * nature is unambiguous) a bench-cited routing nature. Structure > Willpower.
 */
import { describe, it, expect } from 'vitest';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';
import {
  LLM_BENCH_COVERAGE,
  LLM_ROUTING_NATURE,
} from '../../src/data/llmBenchCoverage.js';

const NATURES = new Set(['A', 'B', 'D', 'E']);
const CHAINS = new Set(['FAST', 'SORT', 'JUDGE', 'WRITE']);

// Nature → allowed chains (the four production ladders, ELI16 §11).
const ALLOWED_CHAINS: Record<string, Set<string>> = {
  A: new Set(['FAST', 'SORT']),
  B: new Set(['JUDGE']),
  D: new Set(['SORT', 'WRITE']),
  E: new Set(['JUDGE']),
};

describe('llm-routing-nature ratchet', () => {
  it('no dangling routing claim — every key exists in COMPONENT_CATEGORY', () => {
    const dangling = Object.keys(LLM_ROUTING_NATURE).filter((k) => !(k in COMPONENT_CATEGORY));
    expect(
      dangling,
      `routing-nature entries for unknown components: ${dangling.join(', ')}`,
    ).toEqual([]);
  });

  it('cite-the-bench — every routing-nature key is bench-COVERED (has a task)', () => {
    const uncited = Object.keys(LLM_ROUTING_NATURE).filter((k) => {
      const cov = LLM_BENCH_COVERAGE[k];
      return !cov || !('task' in cov);
    });
    expect(
      uncited,
      `routing nature cited for component(s) that are not bench-COVERED: ${uncited.join(', ')}. ` +
        'A routing nature may only be cited for a { task }-covered component — bench it (graduate ' +
        'it out of pending/exempt) before declaring its routing nature. INSTAR-Bench v3, Task-4 G1.',
    ).toEqual([]);
  });

  it('valid enums — nature ∈ {A,B,D,E}, chain ∈ {FAST,SORT,JUDGE,WRITE}', () => {
    for (const [k, v] of Object.entries(LLM_ROUTING_NATURE)) {
      expect(NATURES.has(v.nature), `${k}: invalid nature '${v.nature}'`).toBe(true);
      expect(CHAINS.has(v.chain), `${k}: invalid chain '${v.chain}'`).toBe(true);
    }
  });

  it('nature→chain coherence — A→FAST|SORT, B→JUDGE, D→SORT|WRITE, E→JUDGE', () => {
    const violations: string[] = [];
    for (const [k, v] of Object.entries(LLM_ROUTING_NATURE)) {
      const allowed = ALLOWED_CHAINS[v.nature];
      if (allowed && !allowed.has(v.chain)) {
        violations.push(`${k}: nature ${v.nature} may not ride chain ${v.chain}`);
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the map is non-empty (the G1 join is actually populated)', () => {
    expect(Object.keys(LLM_ROUTING_NATURE).length).toBeGreaterThan(0);
  });

  it('bench rule R2 — the emergency-stop classifier is nature A on the FAST chain (never a reasoning/CLI Opus door)', () => {
    // Regression pin: MessageSentinel is the emergency-stop classifier; its
    // bench-established route is fast bounded, and the SAFETY guardrail (S2)
    // keeps any claude-code fallback off Opus. If this ever flips to JUDGE, the
    // guardrail's assumption changes — force a reviewer to look.
    expect(LLM_ROUTING_NATURE.MessageSentinel).toEqual({ nature: 'A', chain: 'FAST' });
  });
});
