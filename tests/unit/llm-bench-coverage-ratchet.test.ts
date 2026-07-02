/**
 * LLM benchmark-coverage ratchet (INSTAR-Bench v2 spec §6, ratchet #2;
 * operator directive 2026-07-02, topic 29723).
 *
 * Guarantees, structurally:
 *   1. EVERY LLM component in COMPONENT_CATEGORY has a bench-coverage entry —
 *      adding an LLM callsite without deciding its benchmark story fails CI
 *      with instructions (Structure > Willpower).
 *   2. The PENDING set is pinned SHRINK-ONLY — entries may graduate to
 *      covered, never multiply silently.
 *   3. The EXEMPT set is pinned shrink-only AND each exemption argues a real
 *      reason (>= 40 chars — a lazy "n/a" is refused).
 *
 * Companion: componentCategories-evaluate-coverage keeps COMPONENT_CATEGORY
 * exhaustive over .evaluate() callsites; this test extends that chain to
 * benchmark coverage. Together: new LLM call → must join the category map →
 * must have a bench-coverage decision.
 */
import { describe, it, expect } from 'vitest';
import { COMPONENT_CATEGORY } from '../../src/core/componentCategories.js';
import { LLM_BENCH_COVERAGE } from '../../src/data/llmBenchCoverage.js';

// ── Pinned baselines (2026-07-02). SHRINK-ONLY: graduating an entry to
// covered removes it here; ADDING a name means you are shipping a new LLM
// component without bench coverage — author its bench task instead, or argue
// a real exemption in the map (both are visible, reviewed acts). ──
const PENDING_BASELINE = [
  // Wave-3 only — the wave-2 set graduated to covered/exempt on 2026-07-02
  // (INSTAR-Bench v2 wave-2 authoring: 19 task batteries + 5 argued exemptions).
  'CartographerSweep', 'ContextualEvaluator', 'DiscoveryEvaluator',
  'JobReflector', 'LLMConflictResolver', 'PipeSessionSpawner',
  'PreCompactionFlush', 'RelationshipManager', 'SelfKnowledgeTree',
  'StandardsConformanceReviewer', 'StandardsCoverageEnrichment',
  'TopicSummarizer', 'TreeSynthesis', 'TreeTriage', 'a2a-checkin',
  'crossModelReviewer', 'mentor-stage-b', 'openConversationBrief',
].sort();

const EXEMPT_BASELINE = [
  'InteractivePoolCanaryJudge',
  // Wave-2 argued exemptions (2026-07-02) — each argues a real reason in
  // src/data/llmBenchCoverage.ts; evidence trail in the bench harness's
  // tasks-wave2/SKIPPED.md (grep-verified delegation/alias/unwired claims).
  'IntegrationGate', 'CoherenceGate', 'AutoApprover', 'InputDetector', 'PromiseBeacon',
].sort();

describe('llm-bench-coverage ratchet', () => {
  it('every COMPONENT_CATEGORY key has a bench-coverage entry (new LLM components must decide their benchmark story)', () => {
    const missing = Object.keys(COMPONENT_CATEGORY).filter((k) => !(k in LLM_BENCH_COVERAGE));
    expect(
      missing,
      `LLM component(s) without a bench-coverage decision: ${missing.join(', ')}.\n` +
        'Add each to src/data/llmBenchCoverage.ts as { task } (author the bench task), ' +
        '{ pending } (ALSO add it to the pinned baseline in this test — a visible act), ' +
        'or { exempt } with a real argument. INSTAR-BENCH-V2-SPEC §6.',
    ).toEqual([]);
  });

  it('no dangling coverage entries (map keys must exist in COMPONENT_CATEGORY)', () => {
    const dangling = Object.keys(LLM_BENCH_COVERAGE).filter((k) => !(k in COMPONENT_CATEGORY));
    expect(dangling, `coverage entries for unknown components: ${dangling.join(', ')}`).toEqual([]);
  });

  it('the pending set is pinned (shrink-only ratchet)', () => {
    const pending = Object.entries(LLM_BENCH_COVERAGE)
      .filter(([, v]) => 'pending' in v)
      .map(([k]) => k)
      .sort();
    // Shrink-only: every current pending entry must be in the baseline
    // (graduating removes from BOTH; adding to pending requires editing the
    // baseline here — the reviewed act the ratchet exists to force).
    const added = pending.filter((k) => !PENDING_BASELINE.includes(k));
    expect(added, `NEW pending entries (author bench tasks instead): ${added.join(', ')}`).toEqual([]);
  });

  it('the exempt set is pinned and every exemption argues a real reason', () => {
    const exempts = Object.entries(LLM_BENCH_COVERAGE).filter(([, v]) => 'exempt' in v);
    const names = exempts.map(([k]) => k).sort();
    const added = names.filter((k) => !EXEMPT_BASELINE.includes(k));
    expect(added, `NEW exemptions (must be argued AND pinned here): ${added.join(', ')}`).toEqual([]);
    for (const [k, v] of exempts) {
      expect(
        ('exempt' in v ? v.exempt : '').length,
        `${k}: exemption reason must be a real argument (>= 40 chars)`,
      ).toBeGreaterThanOrEqual(40);
    }
  });

  it('covered entries carry non-empty task ids', () => {
    for (const [k, v] of Object.entries(LLM_BENCH_COVERAGE)) {
      if ('task' in v) expect(v.task.length, `${k}: empty task id`).toBeGreaterThan(0);
    }
  });

  it('Wave-1 critical components are covered (regression pin — these may never slide back to pending)', () => {
    for (const critical of [
      'MessageSentinel', 'MessagingToneGate', 'CompletionEvaluator',
      'ExternalOperationGate', 'LLMSanitizer', 'WarrantsReplyGate',
      'InputClassifier', 'Usher', 'correction-learning', 'CoherenceReviewer',
    ]) {
      const v = LLM_BENCH_COVERAGE[critical];
      expect(v && 'task' in v, `${critical} must stay bench-covered`).toBe(true);
    }
  });
});
