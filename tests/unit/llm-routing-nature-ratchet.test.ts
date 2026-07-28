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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';
import {
  LLM_BENCH_COVERAGE,
  LLM_ROUTING_NATURE,
  NATURE_ROUTING_DEFAULT_CHAINS,
  CLAUDE_CODE_RESERVE_MODEL_ID,
  type ChainPosition,
  type RoutingChain,
} from '../../src/data/llmBenchCoverage.js';
import {
  validateNatureRoutingChains,
  validateChainPosition,
} from '../../src/core/IntelligenceRouter.js';
// The build-lint's pure surface — the SAME invariant, enforced at compile time.
import {
  runNatureChainsLint,
  banViolationForPosition,
} from '../../scripts/lint-nature-chains.mjs';

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

// ─────────────────────────────────────────────────────────────────────────────
// FD4 HARNESS-DOOR BAN — the build-lint ratchet (docs/specs/nature-axis-routing.md
// FD4 §188-232, FD4.1 §205, FD8 §393). This runs `scripts/lint-nature-chains.mjs`
// (the compile-time place of the three-place ban) as a CI gate over the REAL authored
// chain map, plus drift-checks that the build-lint predicate AGREES with the runtime TS
// validator (`validateNatureRoutingChains`). Structure > Willpower.
// ─────────────────────────────────────────────────────────────────────────────
const __dirname_test = path.dirname(fileURLToPath(import.meta.url));
const COVERAGE_SRC_TEXT = fs.readFileSync(
  path.resolve(__dirname_test, '../../src/data/llmBenchCoverage.ts'),
  'utf8',
);

/** Build a minimal synthetic llmBenchCoverage-shaped source for the full-lint negative cases. */
function synthSource(chainsBody: string): string {
  return [
    "export const ROUTING_LABEL_TO_MODEL_ID: Readonly<Record<string, Readonly<Record<string, string>>>> = {",
    "  'claude-code': { balanced: 'claude-sonnet-4-6' },",
    "  'openrouter-api': { 'opus-4.8': 'anthropic/claude-opus-4-8' },",
    '};',
    '',
    'export const NATURE_ROUTING_DEFAULT_CHAINS: NatureRoutingChains = {',
    chainsBody,
    '};',
    '',
  ].join('\n');
}

describe('FD4 harness-door ban — build-lint ratchet', () => {
  it('the REAL authored chain map passes the build-lint (0 violations)', () => {
    const { violations, reserveId } = runNatureChainsLint(COVERAGE_SRC_TEXT);
    expect(reserveId).toBe(CLAUDE_CODE_RESERVE_MODEL_ID);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('the build-lint and the runtime TS validator AGREE on the real chains (both clean)', () => {
    const lintViolations = runNatureChainsLint(COVERAGE_SRC_TEXT).violations;
    const tsViolations = validateNatureRoutingChains(NATURE_ROUTING_DEFAULT_CHAINS);
    expect(lintViolations.length).toBe(0);
    expect(tsViolations.length).toBe(0);
  });

  it('NEGATIVE — an Opus-family claude-code position in a JUDGE chain FAILS the lint', () => {
    const src = synthSource(
      "  FAST: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  SORT: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  JUDGE: [{ door: 'claude-code', model: 'claude-opus-4-8' }],\n" +
        "  WRITE: [{ door: 'claude-code', model: 'capable' }],",
    );
    const { violations } = runNatureChainsLint(src);
    expect(violations.map((v) => v.rule)).toContain('claude-code-non-reserve');
  });

  it('NEGATIVE — a claude-code TIER LABEL (not the pinned concrete reserve) in SORT FAILS the lint', () => {
    const src = synthSource(
      "  FAST: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  SORT: [{ door: 'claude-code', model: 'capable' }],\n" +
        "  JUDGE: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  WRITE: [{ door: 'codex-cli', model: 'gpt-5.4-mini' }],",
    );
    const { violations } = runNatureChainsLint(src);
    expect(violations.map((v) => v.rule)).toContain('claude-code-tier-label');
  });

  it('NEGATIVE — any position resolving to a Fable model FAILS the lint (FD8 §393), even on WRITE', () => {
    const src = synthSource(
      "  FAST: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  SORT: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  JUDGE: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  WRITE: [{ door: 'claude-code', model: 'claude-fable-5' }],",
    );
    const { violations } = runNatureChainsLint(src);
    expect(violations.map((v) => v.rule)).toContain('fable-banned');
  });

  it('POSITIVE — the registry-pinned `balanced` label on claude-code passes in every bounded/gating chain', () => {
    const src = synthSource(
      "  FAST: [{ door: 'claude-code', model: 'balanced' }],\n" +
        "  SORT: [{ door: 'claude-code', model: 'balanced' }],\n" +
        "  JUDGE: [{ door: 'claude-code', model: 'balanced' }],\n" +
        "  WRITE: [{ door: 'claude-code', model: 'capable' }],",
    );
    expect(runNatureChainsLint(src).violations).toEqual([]);
  });

  it('DRIFT GUARD — build-lint `banViolationForPosition` agrees with TS `validateChainPosition` position-by-position', () => {
    const labelMap = { 'claude-code': { balanced: CLAUDE_CODE_RESERVE_MODEL_ID } };
    const cases: Array<{ chain: RoutingChain; pos: ChainPosition }> = [
      { chain: 'JUDGE', pos: { door: 'claude-code', model: 'balanced' } }, // ok
      { chain: 'JUDGE', pos: { door: 'claude-code', model: 'claude-opus-4-8' } }, // non-reserve
      { chain: 'SORT', pos: { door: 'claude-code', model: 'capable' } }, // tier-label
      { chain: 'WRITE', pos: { door: 'claude-code', model: 'capable' } }, // ok (WRITE exempt)
      { chain: 'WRITE', pos: { door: 'claude-code', model: 'claude-fable-5' } }, // fable
      { chain: 'FAST', pos: { door: 'pi-cli', model: 'gpt-5.5' } }, // ok (clean door)
    ];
    for (const { chain, pos } of cases) {
      const lintV = banViolationForPosition(chain, pos, 0, labelMap, CLAUDE_CODE_RESERVE_MODEL_ID);
      const tsV = validateChainPosition(chain, pos, 0);
      // Same verdict (both null, or both a violation with the same rule).
      expect(Boolean(lintV), `${chain}/${pos.model}: lint hasViolation`).toBe(Boolean(tsV));
      if (lintV && tsV) expect(lintV.rule).toBe(tsV.rule);
    }
  });
});
