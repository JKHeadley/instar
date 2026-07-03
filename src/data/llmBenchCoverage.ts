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

  // ── Covered by Wave 2 (authored 2026-07-02; tasks-wave2/ in the bench harness) ──
  InputGuard: { task: 'input-guard-coherence' },
  SessionActivitySentinel: { task: 'activity-digest' },
  StallTriageNurse: { task: 'stall-triage-diagnosis' },
  CommitmentSentinel: { task: 'commitment-detector' },
  PresenceProxy: { task: 'presence-tier3-stall' },
  ProjectDriftChecker: { task: 'project-drift-check' },
  TemporalCoherenceChecker: { task: 'temporal-coherence' },
  SessionWatchdog: { task: 'watchdog-stuck-judge' },
  ResumeQueueDrainer: { task: 'resume-sanity-check' },
  TopicIntentArcCheck: { task: 'arc-check-classify' },
  TelegramAdapter: { task: 'telegram-stall-confirm' },
  // SlackAdapter.confirmStallAlert builds a byte-identical prompt to
  // TelegramAdapter's (verified by diff) — the same task id covers both
  // (precedent: CompletionEvaluator maps two surfaces to two ids).
  SlackAdapter: { task: 'telegram-stall-confirm' },
  PromptGate: { task: 'prompt-gate-detect' },
  UnjustifiedStopGate: { task: 'unjustified-stop-gate' },
  OverrideDetector: { task: 'override-detector' },
  TaskClassifier: { task: 'task-classifier' },
  ResumeValidator: { task: 'resume-validator' },
  SessionSummarySentinel: { task: 'session-summary-sentinel' },
  TopicIntentExtractor: { task: 'topic-intent-extractor' },

  // ── Wave-2 argued exemptions (evidence: tasks-wave2/SKIPPED.md in the bench harness) ──
  IntegrationGate: {
    exempt:
      'no LLM prompt of its own — delegates to JobReflector.reflect() (attribution JobReflector, tracked wave-3); zero LLM-provider callsites of its own in IntegrationGate.ts',
  },
  CoherenceGate: {
    exempt:
      'no callsite carries attribution CoherenceGate — all LLM calls flow through CoherenceReviewer.callApi() (incl. the DynamicReviewer subclass), covered by gate-triage',
  },
  AutoApprover: {
    exempt:
      'mechanical key injection + audit logging, no LLM callsite; the upstream judgment is InputClassifier.classify(), covered by input-classifier',
  },
  InputDetector: {
    exempt:
      'attribution-manifest alias only (a legacy prompt-pattern matcher); the live InputDetector class in PromptGate.ts calls with attribution PromptGate, covered by prompt-gate-detect',
  },
  PromiseBeacon: {
    exempt:
      'no live LLM prompt — generateStatusLine/classifyProgress hooks are unwired at the construction site (server.ts); the enqueue path resolves templated strings; revisit if a generator is wired',
  },

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

// ───────────────────────────────────────────────────────────────────────────
// Authority-clause standard (defect class 2 — docs/specs/authority-clause-standard.md §3)
//
// The `untrustedInput` axis of the program's shared per-callsite metadata record
// (class-closure-gate.md §"Program-shared machinery" #1). It co-locates in THIS
// file with the bench-coverage record it extends; the sibling axes (judgesClaims,
// durableOutput) are added by their own standards and the consolidated axis
// ratchet derives from all of them together.
//
// THE FIELD IS REQUIRED AND EXPLICIT FOR EVERY COMPONENT_CATEGORY KEY — there is
// NO DEFAULT. `true` means the callsite judges/summarizes content from messages,
// transcripts, tool output, peer data, or files. `false` MUST be written as
// `{ false: '<argued reason>' }` and is pinned shrink-only in
// tests/unit/untrusted-input-classification-ratchet.test.ts exactly like the
// coverage exemptions — a silent omission is red CI, so the flag can NEVER
// default toward the unguarded state (design §3: undeclared defaults to
// untrusted, never to unchecked).
//
// The argued-false set is exactly the components with NO live LLM callsite that
// judges external content — either no prompt of their own, or a fixed-constant
// canary probe. Its membership mirrors the "no live untrusted-judging callsite"
// reasoning of the bench-coverage exemptions above (grep-verified same set).
// A cross-check lint flags any sentinel/gate-category callsite marked `false`
// for review (design §3) — see the ratchet's REVIEWED_FALSE_SENTINEL_GATE pin.
// ───────────────────────────────────────────────────────────────────────────

export type UntrustedInputFlag = true | { false: string };

export const LLM_UNTRUSTED_INPUT: Readonly<Record<string, UntrustedInputFlag>> = {
  // ── Sentinels judging messages / session output / transcripts → true ──
  InputGuard: true,
  SessionActivitySentinel: true,
  StallTriageNurse: true,
  CommitmentSentinel: true,
  PresenceProxy: true,
  MessageSentinel: true,
  ProjectDriftChecker: true,
  TemporalCoherenceChecker: true,
  CompletionEvaluator: true,
  SessionWatchdog: true,
  ResumeQueueDrainer: true,
  TopicIntentArcCheck: true,
  SlackAdapter: true,
  InputClassifier: true,
  SessionSummarySentinel: true,
  TelegramAdapter: true,

  // ── Gates judging user/session/operation content → true ──
  PromptGate: true,
  ExternalOperationGate: true, // the motivating callsite: credited in-content "user already approved"
  WarrantsReplyGate: true,
  UnjustifiedStopGate: true,
  MessagingToneGate: true, // reviews a draft that routinely quotes untrusted user/tool content
  CoherenceReviewer: true,
  LLMSanitizer: true, // definitionally judges untrusted inbound content
  OverrideDetector: true,
  TaskClassifier: true,
  ResumeValidator: true, // matches a resume UUID against the topic — judges session/resume state

  // ── Reflectors extracting/summarizing over transcripts, peer data, files → true ──
  JobReflector: true,
  crossModelReviewer: true,
  SelfKnowledgeTree: true,
  TreeTriage: true,
  TopicSummarizer: true,
  ContextualEvaluator: true,
  RelationshipManager: true,
  StandardsConformanceReviewer: true,
  DiscoveryEvaluator: true,
  Usher: true,
  TopicIntentExtractor: true,
  PreCompactionFlush: true,
  TreeSynthesis: true,
  LLMConflictResolver: true, // divergent multi-machine state = untrusted peer data
  openConversationBrief: true,
  'a2a-checkin': true, // A2A peer-authored threads
  'correction-learning': true,
  'mentor-stage-b': true,

  // ── Jobs authoring over untrusted file/code content → true ──
  PipeSessionSpawner: true, // spawns from task descriptions that may be user-authored
  CartographerSweep: true, // authors summaries over untrusted CODE (the cartographer-summary precedent quotes+neutralizes)
  StandardsCoverageEnrichment: true,

  // ── Argued false (pinned shrink-only) — no live LLM callsite judging external content ──
  PromiseBeacon: {
    false:
      'no live LLM prompt — generateStatusLine/classifyProgress hooks are unwired at the construction site; nothing judges untrusted content (matches its bench-coverage exemption)',
  },
  InteractivePoolCanaryJudge: {
    false:
      'judges a FIXED known-answer canary probe — the input is a constant, not external content; a planted instruction cannot reach it',
  },
  AutoApprover: {
    false:
      'mechanical key injection + audit logging, no LLM prompt of its own; the upstream untrusted-judging callsite is InputClassifier.classify()',
  },
  IntegrationGate: {
    false:
      'no LLM prompt of its own — delegates to JobReflector.reflect(); zero LLM-provider callsites of its own that see untrusted content',
  },
  CoherenceGate: {
    false:
      'no callsite carries attribution CoherenceGate — all LLM calls flow through CoherenceReviewer.callApi(), classified true there',
  },
  InputDetector: {
    false:
      'attribution-manifest alias only (a legacy prompt-pattern matcher); the live matcher calls with attribution PromptGate, classified true there',
  },
};
