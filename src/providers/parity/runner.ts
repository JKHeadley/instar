/**
 * Behavior-parity test runner.
 *
 * Phase 2 conformance suites verify a single adapter's contract shape.
 * Phase 3c parity scenarios go one level deeper: given TWO adapters that
 * claim the same capability, send identical inputs to both and assert
 * observable equivalence.
 *
 * This catches drift between sibling adapters (e.g. anthropic-headless vs
 * anthropic-interactive-pool) where each correctly implements the
 * primitive contract in isolation but their externally-observable behavior
 * disagrees on edge cases — empty prompts, control characters, very long
 * outputs, error shapes, cancellation semantics.
 *
 * Design notes:
 *   - Scenarios are async functions that receive a ParityHarness and
 *     return a ParityResult describing what they observed.
 *   - The runner orchestrates lifecycle (start / dispose) for both
 *     adapters and aggregates results.
 *   - "Equivalent" is scenario-defined — scenarios assert structural
 *     equivalence (same error class, same response length bucket) rather
 *     than literal string equality, because LLM outputs aren't
 *     deterministic.
 *   - Real-API scenarios are gated by ctx.realApi; structural-only
 *     scenarios (capability-flag presence, primitive instantiation)
 *     always run.
 */

import type { ProviderAdapter } from '../registry.js';

export interface ParityContext {
  /** Whether to run scenarios that hit a real provider API. */
  realApi: boolean;
  /** Per-scenario timeout in milliseconds. */
  timeoutMs?: number;
  /** Optional skip patterns — scenarios whose name matches are skipped. */
  skipPatterns?: ReadonlyArray<RegExp>;
}

export interface ParityHarness {
  readonly left: ProviderAdapter & { start?(): Promise<void>; dispose?(): Promise<void> };
  readonly right: ProviderAdapter & { start?(): Promise<void>; dispose?(): Promise<void> };
  readonly ctx: ParityContext;
}

export interface ParityResult {
  scenario: string;
  status: 'pass' | 'fail' | 'skip';
  reason?: string;
  /**
   * Free-form scenario-specific observations attached to the result for
   * post-hoc inspection. Scenarios typically include both adapters'
   * observable outputs (under `left`/`right`) plus any context (counts,
   * timings) the failure mode needs to be diagnosable.
   */
  observations?: Record<string, unknown>;
}

export type ParityScenario = (h: ParityHarness) => Promise<ParityResult>;

export const PARITY_SUMMARY_SCHEMA = 'instar-parity-summary/v1' as const;

export interface ParitySummary {
  schema: typeof PARITY_SUMMARY_SCHEMA;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * Run every scenario against the pair of adapters and aggregate results.
 *
 * Adapter lifecycle: start() called once before scenarios (if defined),
 * dispose() called once after (if defined). Scenarios run sequentially —
 * concurrent execution against pool-backed adapters can cause queueing
 * effects that confound parity comparisons.
 */
export async function runParitySuite(
  harness: ParityHarness,
  scenarios: ReadonlyArray<{ name: string; run: ParityScenario }>,
): Promise<ReadonlyArray<ParityResult>> {
  const { left, right, ctx } = harness;
  try {
    await left.start?.();
    await right.start?.();
  } catch (err) {
    return [
      {
        scenario: '_startup',
        status: 'fail',
        reason: `adapter start() failed: ${(err as Error).message}`,
      },
    ];
  }

  const results: ParityResult[] = [];
  for (const { name, run } of scenarios) {
    if (ctx.skipPatterns?.some((p) => p.test(name))) {
      results.push({ scenario: name, status: 'skip', reason: 'skip-pattern match' });
      continue;
    }
    try {
      const r = await run(harness);
      results.push({ ...r, scenario: name });
    } catch (err) {
      results.push({
        scenario: name,
        status: 'fail',
        reason: `scenario threw: ${(err as Error).message}`,
      });
    }
  }

  try {
    await left.dispose?.();
    await right.dispose?.();
  } catch {
    // Dispose errors don't invalidate scenario results.
  }

  return results;
}

/**
 * Pretty-print a parity result set to stdout. Returns process exit code
 * (0 if all pass-or-skip, 1 if any fail).
 */
export function reportParityResults(results: ReadonlyArray<ParityResult>): number {
  const summary = summarizeParityResults(results);
  for (const r of results) {
    const tag = r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL';
    const detail = r.reason ? ` — ${r.reason}` : '';
    // eslint-disable-next-line no-console
    console.log(`[${tag}] ${r.scenario}${detail}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${summary.total} scenario(s): ${summary.total - summary.failed} ok, ${summary.failed} fail`);
  return summary.failed === 0 ? 0 : 1;
}

export function summarizeParityResults(results: ReadonlyArray<ParityResult>): ParitySummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const result of results) {
    if (result.status === 'pass') passed += 1;
    else if (result.status === 'fail') failed += 1;
    else skipped += 1;
  }
  return {
    schema: PARITY_SUMMARY_SCHEMA,
    total: results.length,
    passed,
    failed,
    skipped,
  };
}

/** Print one machine-readable document and return the same failure exit semantics as the text reporter. */
export function reportParityResultsJson(results: ReadonlyArray<ParityResult>): number {
  const summary = summarizeParityResults(results);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary));
  return summary.failed === 0 ? 0 : 1;
}
