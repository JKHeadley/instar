/**
 * FD4.2 — the R-rule STRUCTURAL-EXCLUSION lints (R3–R8).
 *
 * Spec: docs/specs/nature-axis-routing.md FD5(c) §296-314; LLM-ROUTING-REGISTRY
 * hard rules #3/#5/#6. These are STRUCTURAL checks over the authored chains/maps —
 * they change NO runtime selection (the shipped defaults are clean, so the resolve/
 * config-load rejection branch is never taken; the point is that a future edit that
 * reintroduced a bench-condemned placement is caught).
 *
 *   R3 — qwen-tier never in a strict-format (FAST/SORT) bounded-contract position.
 *   R4 — gemini-cli (consumer Flash 2.5) never in an injection-exposed JUDGE position.
 *   R5 — gpt-oss-20b / llama-4-scout never take a gate (JUDGE) verdict position.
 *   R6 — doc-tree/cartographer (claude-banned) components never route to claude-code.
 *   R7 — any DeepSeek door/model never in an injection-exposed JUDGE position.
 *   R8 — input-classifier components are injection-exposed AND pinned off Flash-Lite.
 *
 * R3/R4/R5/R7 are POSITION bans mirrored in both the build-lint and the pure TS
 * predicate (a drift guard asserts the two agree). R6/R8 are COMPONENT-scoped map
 * pins — build-lint only, since the maps they guard are never operator-overridable.
 * Structure > Willpower.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NATURE_ROUTING_DEFAULT_CHAINS,
  type ChainPosition,
  type RoutingChain,
} from '../../src/data/llmBenchCoverage.js';
import {
  validateChainPositionRRule,
  validateNatureRoutingChainRRules,
  validateNatureRoutingChainAll,
  mergeNatureRoutingChains,
} from '../../src/core/IntelligenceRouter.js';
import {
  runNatureRuleLints,
  rruleViolationForPosition,
  r6Violations,
  r8Violations,
  extractChains,
} from '../../scripts/lint-nature-chains.mjs';

const __dirname_test = path.dirname(fileURLToPath(import.meta.url));
const COVERAGE_SRC_TEXT = fs.readFileSync(
  path.resolve(__dirname_test, '../../src/data/llmBenchCoverage.ts'),
  'utf8',
);
const LABEL_MAP: Record<string, Record<string, string>> = {};

/**
 * Build a synthetic llmBenchCoverage-shaped source carrying the blocks the R6/R8
 * source-parsing lints read. Overridable pieces default to a clean, R-rule-passing shape.
 */
function synthSource(opts: {
  chains?: string;
  natureMap?: string;
  exposureMap?: string;
  claudeBanned?: string;
  inputClassifiers?: string;
  metered?: string;
}): string {
  const chains =
    opts.chains ??
    "  FAST: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
      "  SORT: [{ door: 'codex-cli', model: 'gpt-5.4-mini' }],\n" +
      "  JUDGE: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
      "  WRITE: [{ door: 'codex-cli', model: 'gpt-5.4-mini' }],";
  const natureMap =
    opts.natureMap ?? "  MessageSentinel: { nature: 'A', chain: 'FAST' },\n  InputClassifier: { nature: 'A', chain: 'SORT' },";
  const exposureMap =
    opts.exposureMap ??
    "  InputClassifier: exposed(EXPOSED_USER),\n  MessageSentinel: exposed(EXPOSED_USER),\n  TaskClassifier: exposed(EXPOSED_USER),";
  const claudeBanned = opts.claudeBanned ?? "  'CartographerSweep',";
  const inputClassifiers = opts.inputClassifiers ?? "  'InputClassifier',\n  'MessageSentinel',\n  'TaskClassifier',";
  const metered = opts.metered ?? "  'gemini-api',\n  'openrouter-api',\n  'groq-api',";
  return [
    "export const ROUTING_LABEL_TO_MODEL_ID: Readonly<Record<string, Readonly<Record<string, string>>>> = {",
    "  'claude-code': { balanced: 'claude-sonnet-4-6' },",
    '};',
    '',
    'export const LLM_ROUTING_NATURE: Readonly<Record<string, RoutingNature>> = {',
    natureMap,
    '};',
    '',
    'export const LLM_ROUTING_INJECTION_EXPOSURE: Readonly<Record<string, InjectionExposure>> = {',
    exposureMap,
    '};',
    '',
    'export const METERED_ROUTING_DOORS: ReadonlySet<RoutingDoor> = new Set([',
    metered,
    ']);',
    '',
    'export const NATURE_ROUTING_DEFAULT_CHAINS: NatureRoutingChains = {',
    chains,
    '};',
    '',
    'export const NATURE_ROUTING_CLAUDE_BANNED_COMPONENTS: ReadonlySet<string> = new Set([',
    claudeBanned,
    ']);',
    '',
    'export const NATURE_ROUTING_INPUT_CLASSIFIER_COMPONENTS: ReadonlySet<string> = new Set([',
    inputClassifiers,
    ']);',
    '',
  ].join('\n');
}

describe('FD4.2 R-rule structural-exclusion lints (R3–R8)', () => {
  it('the REAL authored chain map + maps pass ALL R-rule lints (0 violations)', () => {
    const { violations } = runNatureRuleLints(COVERAGE_SRC_TEXT);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });

  it('the REAL authored chains pass the TS R-rule validator (0 violations)', () => {
    const out: unknown[] = [];
    for (const c of ['FAST', 'SORT', 'JUDGE', 'WRITE'] as RoutingChain[]) {
      out.push(...validateNatureRoutingChainRRules(c, NATURE_ROUTING_DEFAULT_CHAINS[c]));
    }
    expect(out).toEqual([]);
  });

  // ── R3 ──────────────────────────────────────────────────────────────────────
  it('NEGATIVE R3 — a qwen-tier model in a FAST (strict-format) position FAILS', () => {
    const pos: ChainPosition = { door: 'groq-api', model: 'qwen-3-32b' };
    expect(rruleViolationForPosition('FAST', pos, 0, LABEL_MAP)?.rule).toBe('rrule-r3-qwen-strict-format');
    expect(validateChainPositionRRule('FAST', pos, 0)?.rule).toBe('rrule-r3-qwen-strict-format');
  });
  it('POSITIVE R3 — qwen in a WRITE (non-strict-format) position is NOT an R3 violation', () => {
    const pos: ChainPosition = { door: 'groq-api', model: 'qwen-3-32b' };
    expect(rruleViolationForPosition('WRITE', pos, 0, LABEL_MAP)).toBeNull();
    expect(validateChainPositionRRule('WRITE', pos, 0)).toBeNull();
  });

  // ── R4 ──────────────────────────────────────────────────────────────────────
  it('NEGATIVE R4 — the gemini-cli door in a JUDGE position FAILS', () => {
    const pos: ChainPosition = { door: 'gemini-cli', model: 'gemini-flash' };
    expect(rruleViolationForPosition('JUDGE', pos, 0, LABEL_MAP)?.rule).toBe('rrule-r4-gemini-cli-judge');
    expect(validateChainPositionRRule('JUDGE', pos, 0)?.rule).toBe('rrule-r4-gemini-cli-judge');
  });
  it('POSITIVE R4 — gemini-cli in FAST is NOT an R4 violation (R4 is JUDGE-only)', () => {
    const pos: ChainPosition = { door: 'gemini-cli', model: 'gemini-flash' };
    expect(rruleViolationForPosition('FAST', pos, 0, LABEL_MAP)).toBeNull();
    expect(validateChainPositionRRule('FAST', pos, 0)).toBeNull();
  });

  // ── R5 ──────────────────────────────────────────────────────────────────────
  it('NEGATIVE R5 — gpt-oss-20b in a JUDGE position FAILS', () => {
    const pos: ChainPosition = { door: 'groq-api', model: 'gpt-oss-20b' };
    expect(rruleViolationForPosition('JUDGE', pos, 0, LABEL_MAP)?.rule).toBe('rrule-r5-weak-model-judge');
    expect(validateChainPositionRRule('JUDGE', pos, 0)?.rule).toBe('rrule-r5-weak-model-judge');
  });
  it('NEGATIVE R5 — llama-4-scout in a JUDGE position FAILS', () => {
    const pos: ChainPosition = { door: 'groq-api', model: 'llama-4-scout' };
    expect(rruleViolationForPosition('JUDGE', pos, 0, LABEL_MAP)?.rule).toBe('rrule-r5-weak-model-judge');
    expect(validateChainPositionRRule('JUDGE', pos, 0)?.rule).toBe('rrule-r5-weak-model-judge');
  });

  // ── R7 ──────────────────────────────────────────────────────────────────────
  it('NEGATIVE R7 — a DeepSeek model in a JUDGE position FAILS', () => {
    const pos: ChainPosition = { door: 'openrouter-api', model: 'deepseek-v4-pro' };
    expect(rruleViolationForPosition('JUDGE', pos, 0, LABEL_MAP)?.rule).toBe('rrule-r7-deepseek-judge');
    expect(validateChainPositionRRule('JUDGE', pos, 0)?.rule).toBe('rrule-r7-deepseek-judge');
  });

  // ── DRIFT GUARD (R3/R4/R5/R7) ────────────────────────────────────────────────
  it('DRIFT GUARD — lint `rruleViolationForPosition` agrees with TS `validateChainPositionRRule`', () => {
    const cases: Array<{ chain: RoutingChain; pos: ChainPosition }> = [
      { chain: 'FAST', pos: { door: 'groq-api', model: 'qwen-3-32b' } }, // R3
      { chain: 'SORT', pos: { door: 'groq-api', model: 'qwen-3-32b' } }, // R3
      { chain: 'JUDGE', pos: { door: 'gemini-cli', model: 'gemini-flash' } }, // R4
      { chain: 'JUDGE', pos: { door: 'groq-api', model: 'gpt-oss-20b' } }, // R5
      { chain: 'JUDGE', pos: { door: 'groq-api', model: 'llama-4-scout' } }, // R5
      { chain: 'JUDGE', pos: { door: 'openrouter-api', model: 'deepseek-v4-pro' } }, // R7
      { chain: 'JUDGE', pos: { door: 'pi-cli', model: 'gpt-5.5' } }, // clean
      { chain: 'FAST', pos: { door: 'pi-cli', model: 'gpt-5.5' } }, // clean
    ];
    for (const { chain, pos } of cases) {
      const lintV = rruleViolationForPosition(chain, pos, 0, LABEL_MAP);
      const tsV = validateChainPositionRRule(chain, pos, 0);
      expect(Boolean(lintV), `${chain}/${pos.model}: lint hasViolation`).toBe(Boolean(tsV));
      if (lintV && tsV) expect(lintV.rule).toBe(tsV.rule);
    }
  });

  // ── R6 (build-lint only) ─────────────────────────────────────────────────────
  it('NEGATIVE R6 — a claude-banned component whose chain routes to claude-code FAILS', () => {
    const src = synthSource({
      natureMap: "  CartographerSweep: { nature: 'D', chain: 'WRITE' },",
      chains:
        "  FAST: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  SORT: [{ door: 'codex-cli', model: 'gpt-5.4-mini' }],\n" +
        "  JUDGE: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  WRITE: [{ door: 'claude-code', model: 'capable' }],",
    });
    const chains = extractChains(src);
    const v = r6Violations(src, chains);
    expect(v.map((x: { rule: string }) => x.rule)).toContain('rrule-r6-claude-banned-component');
  });
  it('POSITIVE R6 — a claude-banned component on an off-Claude chain passes', () => {
    const src = synthSource({
      natureMap: "  CartographerSweep: { nature: 'D', chain: 'WRITE' },",
      chains:
        "  FAST: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  SORT: [{ door: 'codex-cli', model: 'gpt-5.4-mini' }],\n" +
        "  JUDGE: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  WRITE: [{ door: 'codex-cli', model: 'gpt-5.4-mini' }],",
    });
    expect(r6Violations(src, extractChains(src))).toEqual([]);
  });
  it('R6 fails CLOSED — an empty claude-banned set is a build failure', () => {
    const src = synthSource({ claudeBanned: '' });
    expect(() => r6Violations(src, extractChains(src))).toThrow();
  });

  // ── R8 (build-lint only) ─────────────────────────────────────────────────────
  it('NEGATIVE R8(a) — an input-classifier marked NOT injection-exposed FAILS', () => {
    const src = synthSource({
      exposureMap:
        "  InputClassifier: notExposed('bogus'),\n  MessageSentinel: exposed(EXPOSED_USER),\n  TaskClassifier: exposed(EXPOSED_USER),",
    });
    const v = r8Violations(src, extractChains(src));
    expect(v.map((x: { rule: string }) => x.rule)).toContain('rrule-r8-input-classifier-not-exposed');
  });
  it('NEGATIVE R8(b) — flash-lite placed on a NON-metered (reachable CLI) door FAILS', () => {
    const src = synthSource({
      chains:
        "  FAST: [{ door: 'gemini-cli', model: 'flash-lite' }],\n" +
        "  SORT: [{ door: 'codex-cli', model: 'gpt-5.4-mini' }],\n" +
        "  JUDGE: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  WRITE: [{ door: 'codex-cli', model: 'gpt-5.4-mini' }],",
    });
    const v = r8Violations(src, extractChains(src));
    expect(v.map((x: { rule: string }) => x.rule)).toContain('rrule-r8-flash-lite-reachable');
  });
  it('POSITIVE R8 — input-classifiers exposed AND flash-lite behind the metered gate passes', () => {
    const src = synthSource({
      chains:
        "  FAST: [{ door: 'gemini-api', model: 'flash-lite', keyRef: 'k', moneyGated: true }],\n" +
        "  SORT: [{ door: 'codex-cli', model: 'gpt-5.4-mini' }],\n" +
        "  JUDGE: [{ door: 'pi-cli', model: 'gpt-5.5' }],\n" +
        "  WRITE: [{ door: 'codex-cli', model: 'gpt-5.4-mini' }],",
    });
    expect(r8Violations(src, extractChains(src))).toEqual([]);
  });

  // ── Config-load / resolve-time enforcement (R3/R4/R5/R7 via the combined validator) ──
  it('config-load REJECTS an operator override that violates an R-rule → built-in default', () => {
    const rejected: RoutingChain[] = [];
    const merged = mergeNatureRoutingChains(
      { JUDGE: [{ door: 'gemini-cli', model: 'gemini-flash' }] }, // R4 violation
      (c) => rejected.push(c),
    );
    expect(rejected).toContain('JUDGE');
    // The banned override is discarded — the JUDGE chain falls back to the lint-clean default.
    expect(merged.JUDGE).toBe(NATURE_ROUTING_DEFAULT_CHAINS.JUDGE);
  });
  it('the combined validator flags BOTH FD4 and R-rule violations on one chain', () => {
    const viol = validateNatureRoutingChainAll('JUDGE', [
      { door: 'claude-code', model: 'claude-opus-4-8' }, // FD4 non-reserve
      { door: 'gemini-cli', model: 'gemini-flash' }, // R4
    ]);
    const rules = viol.map((v) => v.rule);
    expect(rules).toContain('claude-code-non-reserve');
    expect(rules).toContain('rrule-r4-gemini-cli-judge');
  });
});
