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

// ───────────────────────────────────────────────────────────────────────────
// Evidence-Bar Extension — Judge Prompts (defect class 3 / claim-vs-evidence —
// docs/specs/evidence-bar-judge-extension.md §2 "the judge-nature classification")
//
// The `judgesClaims` axis of the program's shared per-callsite metadata record
// (class-closure-gate.md §"Program-shared machinery"; co-located in THIS file
// with the bench-coverage record it extends, exactly like the sibling
// `untrustedInput` axis). The consolidated axis ratchet derives the required
// bench axes from all these per-callsite axes together.
//
// WHY (earned): on 2026-07-02 the INSTAR-Bench v2 defect-class review found the
// completion judge (and four other model routes on the same case) credited a
// BARE assertion ("tests pass," no output shown) as satisfied evidence — the
// judge prompt never defined what counts as evidence, so models defaulted to
// crediting the claim. The agent-facing "Bug-Fix Evidence Bar" holds the
// CLAIMANT ("verify before you claim"); the prompts that JUDGE such claims were
// never given the same rule. This classification is the structural record of
// WHICH callsites judge a claim, so the (deferred) bench-axis ratchet can
// require both a bare-claim (false-accept) AND a real-evidence (false-reject)
// case for each — the known over-correction hazard (the first fix rejected REAL
// evidence on 6 routes) makes the false-reject direction mandatory.
//
// INCLUSION CRITERIA (spec §2): the callsite's task is to CREDIT or REFUSE an
// agent/session claim of completion, progress, or health — verdict gates,
// completion evaluators, stuck/stall/health classifiers, and scored evaluators
// that award credit for claimed work. EXCLUSION: pure summarizers and
// extractors are out unless they score or credit a claim.
//
// THE FIELD IS REQUIRED AND EXPLICIT FOR EVERY COMPONENT_CATEGORY KEY — there is
// NO DEFAULT (same polarity rule as `untrustedInput`). A `{ claimKind }` entry
// is a judge (true) and declares WHICH kind of claim it judges (the axis cases +
// accepted evidence classes are authored per kind). Plain `false` is a callsite
// that does not judge a completion/progress/health claim. A judge-SHAPED
// callsite that argues it does NOT judge claims is written as
// `{ false: '<argued reason>' }` and pinned shrink-only in
// tests/unit/judges-claims-classification-ratchet.test.ts — a silent omission
// is red CI, so the flag can never default toward the un-benched state.
//
// DETERMINISTIC ARM (spec "Honest reach"): the real-check `verification_command`
// verifier is NAMED in the spec seed but is NOT an LLM callsite (it runs the
// actual command on a met-verdict) — it has no COMPONENT_CATEGORY key and is
// therefore out of this LLM classification by construction. A prompt bar governs
// what is SHOWN; verification of what is TRUE belongs to that deterministic arm.
// ───────────────────────────────────────────────────────────────────────────

/** The kind of claim a judge callsite credits/refuses (spec §2). Different kinds
 * take different evidence, so each `judgesClaims: true` entry declares its kind:
 *   - completionClaim: proof of asserted work ("the task is done / tests pass");
 *   - healthClaim: behavioral-signal sufficiency (stall/stuck/health classifiers);
 *   - scoredCredit: rubric evaluators that award credit for claimed work. */
export type ClaimKind = 'completionClaim' | 'healthClaim' | 'scoredCredit';

export const CLAIM_KINDS: ReadonlyArray<ClaimKind> = [
  'completionClaim',
  'healthClaim',
  'scoredCredit',
];

/** The `judgesClaims` classification of one LLM callsite:
 *   - `{ claimKind }`  → judges a claim (true), of the declared kind;
 *   - `false`          → does not judge a completion/progress/health claim;
 *   - `{ false: '<reason>' }` → a judge-SHAPED callsite argued OUT of scope
 *     (pinned shrink-only + reviewed, like the untrustedInput argued-false set). */
export type JudgesClaimsFlag = { claimKind: ClaimKind } | false | { false: string };

export const LLM_JUDGES_CLAIMS: Readonly<Record<string, JudgesClaimsFlag>> = {
  // ── Judges (judgesClaims: true) ────────────────────────────────────────────
  // Completion evaluators — credit/refuse a claim of asserted work.
  CompletionEvaluator: { claimKind: 'completionClaim' }, // THE motivating callsite: credited a bare "tests pass"
  UnjustifiedStopGate: { claimKind: 'completionClaim' }, // judges whether a stop is justified = is the claimed work actually done/blocked
  JobReflector: { claimKind: 'completionClaim' }, // reflects on job success/completion (spec §2 pending-wave judge; classified now so the asymmetry can't silently reopen)

  // Stall/stuck/health classifiers — credit/refuse a health claim about a session.
  SessionWatchdog: { claimKind: 'healthClaim' }, // stuck-judge
  PresenceProxy: { claimKind: 'healthClaim' }, // tier-3 stall judge
  StallTriageNurse: { claimKind: 'healthClaim' }, // stall-triage diagnosis
  TelegramAdapter: { claimKind: 'healthClaim' }, // confirmStallAlert — judges whether a session is genuinely stalled before alerting (inclusion criteria: stall/health classifier)
  SlackAdapter: { claimKind: 'healthClaim' }, // confirmStallAlert (byte-identical prompt to Telegram's; parity)

  // Scored evaluators — award credit for claimed work.
  'mentor-stage-b': { claimKind: 'scoredCredit' }, // classifies mentor signals over mentee output (spec §2 pending-wave judge)

  // ── Not a completion/progress/health judge (judgesClaims: false) ────────────
  // Sentinels that classify/summarize but do not credit a completion/health claim.
  InputDetector: false, // legacy prompt-pattern matcher alias
  InputGuard: false, // input-coherence, not a completion/health claim
  SessionActivitySentinel: false, // activity DIGEST — summarizes activity, does not credit a claim (exclusion: pure summarizer)
  CommitmentSentinel: false, // detects commitments in text
  PromiseBeacon: false, // no live LLM prompt (hooks unwired at construction — see its bench exemption)
  MessageSentinel: false, // classifies message intent (pause/emergency), not a completion claim
  TopicIntentArcCheck: false, // arc-check classification of a topic's intent, not a completion/health claim
  InputClassifier: false, // input auto-approve vs relay classification
  SessionSummarySentinel: false, // summarizes tmux output → task/phase/files (exclusion: pure summarizer)
  ProjectDriftChecker: false, // is-work-on-project coherence, not a completion/health claim
  TemporalCoherenceChecker: false, // temporal-coherence classification
  ResumeQueueDrainer: false, // inspects session state before a resume — judges STATE validity, not an agent's claim
  InteractivePoolCanaryJudge: false, // judges a FIXED known-answer canary constant, not an agent claim

  // Gates that classify an action/message but do not credit a completion/health claim.
  PromptGate: false, // detects prompt-injection in content
  AutoApprover: false, // mechanical key injection, no LLM prompt of its own
  IntegrationGate: false, // delegates to JobReflector.reflect(), no own callsite
  ExternalOperationGate: false, // classifies operation mutability/reversibility, not a completion claim
  WarrantsReplyGate: false, // "should I reply?" — not a completion/health claim
  CoherenceGate: false, // no own callsite — flows through CoherenceReviewer
  MessagingToneGate: false, // reviews outbound tone/leaks
  CoherenceReviewer: false, // reviews outbound coherence
  LLMSanitizer: false, // sanitizes untrusted inbound content
  OverrideDetector: false, // detects override intent in a turn
  TaskClassifier: false, // classifies task type
  ResumeValidator: false, // matches a resume UUID against a topic — a state match, not a claim

  // Reflectors/jobs that extract/summarize/route but do not credit a completion/health claim.
  crossModelReviewer: false, // reviews a SPEC document, not a session's completion claim
  SelfKnowledgeTree: false, // extracts self-knowledge
  TreeTriage: false, // triages tree fragments
  TopicSummarizer: false, // summarizes a topic
  ContextualEvaluator: false, // evaluates context relevance
  RelationshipManager: false, // extracts relationship facts
  StandardsConformanceReviewer: false, // reviews artifact-vs-standard conformance, not a session completion claim
  DiscoveryEvaluator: false, // evaluates serendipity discoveries
  Usher: false, // routes a turn to candidate topics
  TopicIntentExtractor: false, // extracts topic intent from a turn
  PreCompactionFlush: false, // extracts durable facts before compaction
  TreeSynthesis: false, // synthesizes knowledge fragments → answer
  LLMConflictResolver: false, // resolves divergent multi-machine state
  openConversationBrief: false, // generates an A2A conversation brief
  'a2a-checkin': false, // summarizes A2A check-in threads
  'correction-learning': false, // distills recurring corrections → preference
  PipeSessionSpawner: false, // spawns from task descriptions
  CartographerSweep: false, // authors doc-tree summaries over code
  StandardsCoverageEnrichment: false, // enriches standards-coverage rows
};
