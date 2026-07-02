/**
 * LLM Benchmark Coverage Map — INSTAR-Bench v2 ratchet #2.
 *
 * Every LLM-driven component (a key of COMPONENT_CATEGORY in
 * src/core/componentCategories.ts) must map to exactly one of:
 *   - { task: '<bench-task-id>' } — covered by an INSTAR-Bench v2 task
 *     (task definitions live in the bench harness:
 *     research/llm-pathway-bench/instar-bench-v2/tasks/ on the benching
 *     agent; the id here is the durable contract),
 *   - { pending: '<wave>' } — authoring queued; the pending set is PINNED
 *     shrink-only in tests/unit/llm-bench-coverage-ratchet.test.ts (you can
 *     graduate an entry to covered, you cannot add one without editing the
 *     pinned test — a visible, reviewed act),
 *   - { exempt: '<argued reason>' } — a real argument why benching this
 *     component is not meaningful (also pinned shrink-only).
 *
 * WHY (operator directive 2026-07-02, topic 29723 + INSTAR-BENCH-V2-SPEC §6):
 * adding an LLM callsite without benchmark coverage must fail the build —
 * an unbenched decision-maker is an unmeasured one, and routing defaults are
 * benchmark-derived. Structure > Willpower.
 *
 * Companion ratchet: the wiring test (componentCategories-evaluate-coverage)
 * keeps COMPONENT_CATEGORY exhaustive over .evaluate() callsites; THIS map +
 * its test keep bench coverage exhaustive over COMPONENT_CATEGORY.
 */

export type BenchCoverage =
  | { task: string }
  | { pending: 'wave-2' | 'wave-3' }
  | { exempt: string };

export const LLM_BENCH_COVERAGE: Readonly<Record<string, BenchCoverage>> = {
  // ── Covered by the critical set (Wave 1 — authored 2026-07-02) ──
  MessageSentinel: { task: 'sentinel-classify' },
  MessagingToneGate: { task: 'tone-gate' },
  // CompletionEvaluator has TWO judged surfaces; both benched.
  CompletionEvaluator: { task: 'completion-judge+p13-stop-judge' },
  ExternalOperationGate: { task: 'external-op-gate' },
  LLMSanitizer: { task: 'injection-sanitizer' },
  WarrantsReplyGate: { task: 'warrants-reply' },
  InputClassifier: { task: 'input-classifier' },
  Usher: { task: 'usher' },
  'correction-learning': { task: 'correction-distiller' },
  CoherenceReviewer: { task: 'gate-triage' },

  // ── Argued exemptions (pinned; each must carry a real reason) ──
  InteractivePoolCanaryJudge: {
    exempt:
      'judges a FIXED known-answer canary probe — the canary is its own benchmark; a bench task would re-test the same constant',
  },

  // ── Wave 2 (sentinels/gates/extractors still to author) ──
  InputDetector: { pending: 'wave-2' },
  InputGuard: { pending: 'wave-2' },
  SessionActivitySentinel: { pending: 'wave-2' },
  StallTriageNurse: { pending: 'wave-2' },
  CommitmentSentinel: { pending: 'wave-2' },
  PresenceProxy: { pending: 'wave-2' },
  PromiseBeacon: { pending: 'wave-2' },
  ProjectDriftChecker: { pending: 'wave-2' },
  TemporalCoherenceChecker: { pending: 'wave-2' },
  SessionWatchdog: { pending: 'wave-2' },
  ResumeQueueDrainer: { pending: 'wave-2' },
  TopicIntentArcCheck: { pending: 'wave-2' },
  SlackAdapter: { pending: 'wave-2' },
  TelegramAdapter: { pending: 'wave-2' },
  PromptGate: { pending: 'wave-2' },
  AutoApprover: { pending: 'wave-2' },
  IntegrationGate: { pending: 'wave-2' },
  UnjustifiedStopGate: { pending: 'wave-2' },
  CoherenceGate: { pending: 'wave-2' },
  OverrideDetector: { pending: 'wave-2' },
  TaskClassifier: { pending: 'wave-2' },
  ResumeValidator: { pending: 'wave-2' },
  SessionSummarySentinel: { pending: 'wave-2' },
  TopicIntentExtractor: { pending: 'wave-2' },

  // ── Wave 3 (reflectors + background/job tasks) ──
  JobReflector: { pending: 'wave-3' },
  crossModelReviewer: { pending: 'wave-3' },
  SelfKnowledgeTree: { pending: 'wave-3' },
  TreeTriage: { pending: 'wave-3' },
  TopicSummarizer: { pending: 'wave-3' },
  ContextualEvaluator: { pending: 'wave-3' },
  RelationshipManager: { pending: 'wave-3' },
  StandardsConformanceReviewer: { pending: 'wave-3' },
  DiscoveryEvaluator: { pending: 'wave-3' },
  PipeSessionSpawner: { pending: 'wave-3' },
  CartographerSweep: { pending: 'wave-3' },
  StandardsCoverageEnrichment: { pending: 'wave-3' },
  PreCompactionFlush: { pending: 'wave-3' },
  TreeSynthesis: { pending: 'wave-3' },
  LLMConflictResolver: { pending: 'wave-3' },
  openConversationBrief: { pending: 'wave-3' },
  'a2a-checkin': { pending: 'wave-3' },
  'mentor-stage-b': { pending: 'wave-3' },
};
