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
  MoveIntentClassifier: {
    exempt:
      'ships its OWN dedicated discrimination benchmark — tests/unit/move-intent-discrimination.test.ts, a committed command-vs-discussion corpus run deterministically in CI PLUS an opt-in INSTAR_LIVE_MOVE_INTENT=1 real-model accuracy benchmark (the graduation gate before dryRun:false). A generic bench-harness task would re-test the same judgment less precisely (same rationale as InteractivePoolCanaryJudge: the co-located benchmark IS the benchmark). Spec: docs/specs/nickname-move-intent-llm-rebuild.md §Tests.',
  },
  HubIntentClassifier: {
    exempt:
      'ships its OWN dedicated discrimination benchmark — tests/unit/hub-intent-discrimination.test.ts, a committed command-vs-discussion corpus (open/tie vs question/mention + unknown-target guardrail + fail-open) run deterministically in CI PLUS an opt-in INSTAR_LIVE_HUB_INTENT=1 real-model accuracy benchmark (the graduation gate before dryRun:false). Same rationale as MoveIntentClassifier: the co-located benchmark IS the benchmark; a generic harness task would re-test the same judgment less precisely. Spec: docs/specs/keyword-intent-conversions-1-and-3.md §Tests.',
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
  HubIntentClassifier: true, // judges an inbound hub message's bind-intent (untrusted user text)
  PromptGate: true,
  ExternalOperationGate: true, // the motivating callsite: credited in-content "user already approved"
  WarrantsReplyGate: true,
  UnjustifiedStopGate: true,
  MessagingToneGate: true, // reviews a draft that routinely quotes untrusted user/tool content
  MoveIntentClassifier: true, // classifies an untrusted inbound user message + recent conversation context
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
  MoveIntentClassifier: false, // classifies a USER's move/pin intent over a message, not an agent/session claim of completion/health/credit
  HubIntentClassifier: false, // classifies a USER's hub bind-intent (open/tie) over a message, not an agent/session claim of completion/health/credit
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

// ───────────────────────────────────────────────────────────────────────────
// Prompt↔parser contract standard (defect class 1 — docs/specs/prompt-parser-
// contract-standard.md §4)
//
// The `contract` axis of the program's shared per-callsite metadata record
// (class-closure-gate.md §"Program-shared machinery"). It co-locates in THIS
// file with the bench-coverage record it extends, exactly like the sibling
// `untrustedInput` (authority-clause) and `judgesClaims` (evidence-bar) axes.
//
// THE FIELD IS REQUIRED AND EXPLICIT FOR EVERY COMPONENT_CATEGORY KEY — there is
// NO DEFAULT. A callsite whose output is machine-parsed into a CLOSED, taught
// verdict/decision vocabulary (the B15 failure surface: prompt teaches "B15",
// parser accepts only "B15_CONTEXT_DEATH_STOP") either NAMES its contract-test
// file (`{ contractTest: '<path>' }`, covered) or is queued in the shrink-only
// pending set (`{ pending: 'contract-wave-1' | 'contract-wave-2' }`). A callsite
// with NO such closed-vocabulary parse — no live LLM prompt, a fixed canary, or
// free-text / open-set CONTENT consumed as data (summaries, extractions,
// syntheses, briefs, reviews, open-set id routing) — is `{ false: '<reason>' }`
// and pinned shrink-only in
// tests/unit/parser-contract-classification-ratchet.test.ts. A silent omission
// is red CI, so the flag can NEVER default toward the un-contracted state.
//
// POLARITY (spec §3: "Undeclared content is hazard-scanned by default"): the
// default pulls TOWARD "needs a contract" — a callsite is `false` only with an
// argued reason, exactly like the sibling `untrustedInput` axis defaults toward
// `true`.
//
// WAVE-1 is the spec-named SHIPPED-FIX set (rollout §0/§1): the four
// highest-stakes parsed callsites — MessagingToneGate (the motivating B15
// defect), ExternalOperationGate, CompletionEvaluator (stop-judge), and
// InputClassifier. It is pinned as a seed floor in the ratchet so a
// highest-stakes callsite can never silently slip out of scope. WAVE-2 is every
// other enumerated-verdict/decision callsite, graduating on the shrink-only
// schedule (rollout §2).
//
// DARK / REPORT-ONLY: this record is build-time metadata read ONLY by the new
// pinned ratchet. Nothing here is a contract test yet (those render the REAL
// production prompt and need the live-builder render refactor, deferred to its
// own A/B-gated increments — spec rollout §0/§1). The pending set IS the report
// (spec §4: "report-only inventory happens by construction").
//
// A cross-check lint flags any GATE/SENTINEL-category callsite marked `false`
// for review (these categories most often parse a verdict) — see the ratchet's
// REVIEWED_FALSE_PARSER_GATE pin.
// ───────────────────────────────────────────────────────────────────────────

export type ParserContractFlag =
  | { contractTest: string }
  | { pending: 'contract-wave-1' | 'contract-wave-2' }
  | { false: string };

export const LLM_PARSER_CONTRACT: Readonly<Record<string, ParserContractFlag>> = {
  // ── WAVE-1: the four spec-named highest-stakes parsed callsites (rollout §0) ──
  MessagingToneGate: { pending: 'contract-wave-1' }, // THE motivating defect: prompt taught "B15", parser accepts only "B15_CONTEXT_DEATH_STOP"
  ExternalOperationGate: { pending: 'contract-wave-1' }, // parses a closed mutability/reversibility classification
  CompletionEvaluator: { pending: 'contract-wave-1' }, // the stop-judge surface parses a closed done/blocked/continue verdict
  InputClassifier: { pending: 'contract-wave-1' }, // parses a closed auto-approve vs relay decision

  // ── WAVE-2: every other enumerated-verdict / decision callsite (rollout §2) ──
  MessageSentinel: { pending: 'contract-wave-2' }, // closed intent set (pause / emergency / normal)
  LLMSanitizer: { pending: 'contract-wave-2' }, // parses a closed sanitize verdict/decision
  WarrantsReplyGate: { pending: 'contract-wave-2' }, // closed should-reply yes/no verdict
  MoveIntentClassifier: { pending: 'contract-wave-2' }, // parses a closed move-intent verdict (isCommand + intent enum + targetNickname enum + confidence)
  HubIntentClassifier: { pending: 'contract-wave-2' }, // parses a closed hub-intent verdict (intent enum open/tie/null + targetTopicId enum + confidence)
  InputGuard: { pending: 'contract-wave-2' }, // closed input-coherence verdict
  StallTriageNurse: { pending: 'contract-wave-2' }, // closed stall-triage diagnosis label
  CommitmentSentinel: { pending: 'contract-wave-2' }, // closed commitment-detected verdict + structured envelope
  PresenceProxy: { pending: 'contract-wave-2' }, // closed tier-3 stall verdict
  ProjectDriftChecker: { pending: 'contract-wave-2' }, // closed on-project verdict
  TemporalCoherenceChecker: { pending: 'contract-wave-2' }, // closed temporal-coherence verdict
  SessionWatchdog: { pending: 'contract-wave-2' }, // closed stuck verdict
  ResumeQueueDrainer: { pending: 'contract-wave-2' }, // closed resume-sanity verdict
  TopicIntentArcCheck: { pending: 'contract-wave-2' }, // closed arc-check classification label
  TelegramAdapter: { pending: 'contract-wave-2' }, // stall-confirm — closed genuinely-stalled verdict
  SlackAdapter: { pending: 'contract-wave-2' }, // stall-confirm (byte-identical prompt to Telegram's; parity)
  PromptGate: { pending: 'contract-wave-2' }, // closed injection-detected verdict
  UnjustifiedStopGate: { pending: 'contract-wave-2' }, // closed stop-justified verdict
  OverrideDetector: { pending: 'contract-wave-2' }, // closed override-intent verdict
  TaskClassifier: { pending: 'contract-wave-2' }, // closed task-type label set
  ResumeValidator: { pending: 'contract-wave-2' }, // closed resume-UUID match yes/no verdict
  CoherenceReviewer: { pending: 'contract-wave-2' }, // gate-triage — closed coherence verdict

  // ── Argued false (pinned shrink-only) — no closed-vocabulary verdict parse ──
  // No live LLM callsite, a fixed canary, or free-text / open-set content.
  InputDetector: {
    false:
      'attribution-manifest alias only (a legacy prompt-pattern matcher); the live matcher calls with attribution PromptGate, contracted there',
  },
  SessionActivitySentinel: {
    false:
      'authors a free-text activity DIGEST — the product is prose, not a closed verdict vocabulary a prompt teaches and a parser gates on',
  },
  PromiseBeacon: {
    false:
      'no live LLM prompt — generateStatusLine/classifyProgress hooks are unwired at the construction site; nothing parses a taught vocabulary (matches its bench-coverage exemption)',
  },
  InteractivePoolCanaryJudge: {
    false:
      'judges a FIXED known-answer canary probe — the expected output is a constant, so the canary is its own contract; a prompt↔parser contract test would re-test the same constant',
  },
  SessionSummarySentinel: {
    false:
      'extracts task/phase/files as open-set free-text FIELDS — there is no closed taught verdict vocabulary, so the B15 prompt↔parser drift cannot arise here',
  },
  AutoApprover: {
    false:
      'mechanical key injection + audit logging, no LLM prompt of its own; the upstream parsed decision is InputClassifier.classify(), contracted there',
  },
  IntegrationGate: {
    false:
      'no LLM prompt of its own — delegates to JobReflector.reflect(); zero LLM-provider callsites of its own that parse a taught vocabulary',
  },
  CoherenceGate: {
    false:
      'no callsite carries attribution CoherenceGate — all LLM calls flow through CoherenceReviewer.callApi(), contracted there',
  },
  JobReflector: {
    false:
      'reflection produces free-text content over a job — no closed taught verdict vocabulary a parser gates on (its own bench coverage is wave-3)',
  },
  crossModelReviewer: {
    false:
      'produces a free-text review of a SPEC document — no closed output vocabulary the prompt teaches and a parser must accept',
  },
  SelfKnowledgeTree: {
    false:
      'extracts self-knowledge tree fragments as content that is stored/merged — no closed verdict token gates a branch on a taught vocabulary',
  },
  TreeTriage: {
    false:
      'triages knowledge-tree fragments into content — no closed taught output vocabulary a parser must accept or reject',
  },
  TopicSummarizer: {
    false:
      'produces a free-text topic summary — the prose is the product; there is no closed vocabulary the prompt teaches and a parser gates on',
  },
  ContextualEvaluator: {
    false:
      'evaluates context relevance into content — no closed taught verdict vocabulary that a parser accepts a promised form of',
  },
  RelationshipManager: {
    false:
      'extracts relationship facts as open-set structured content — no closed taught vocabulary a prompt promises and a parser gates on',
  },
  StandardsConformanceReviewer: {
    false:
      'reviews artifact-vs-standard conformance as content — no closed output vocabulary the prompt teaches and a parser must accept',
  },
  DiscoveryEvaluator: {
    false:
      'evaluates serendipity discoveries into content — no closed taught verdict vocabulary a parser accepts a promised form of',
  },
  Usher: {
    false:
      'routes a turn to candidate TOPIC IDS — an OPEN, machine-supplied set, not a closed taught vocabulary the prompt fixes and a parser gates on',
  },
  TopicIntentExtractor: {
    false:
      'extracts a topic-intent description from a turn — free-text content, not a closed taught verdict vocabulary a parser accepts',
  },
  PreCompactionFlush: {
    false:
      'extracts durable facts before compaction as free-text content — no closed taught output vocabulary a parser gates on',
  },
  TreeSynthesis: {
    false:
      'synthesizes knowledge fragments into a free-text answer — the prose is the product, no closed taught verdict vocabulary a parser accepts',
  },
  LLMConflictResolver: {
    false:
      'resolves divergent multi-machine state into a merged value/content — no closed taught verdict vocabulary a prompt promises and a parser gates on',
  },
  openConversationBrief: {
    false:
      'generates a free-text A2A conversation brief — the prose is the product, no closed output vocabulary the prompt teaches and a parser must accept',
  },
  'a2a-checkin': {
    false:
      'summarizes A2A check-in threads into free-text content — no closed taught verdict vocabulary a parser accepts a promised form of',
  },
  'correction-learning': {
    false:
      'distills recurring corrections into a preference (content) — no closed taught output vocabulary a parser gates on',
  },
  'mentor-stage-b': {
    false:
      'classifies mentor signals over mentee output into differential content — no closed taught verdict vocabulary a parser gates on (its own bench coverage is wave-3)',
  },
  PipeSessionSpawner: {
    false:
      'spawns sessions from task descriptions — no LLM output parsed into a closed taught verdict vocabulary',
  },
  CartographerSweep: {
    false:
      'authors doc-tree summaries over code as free text — the prose is the product, no closed taught output vocabulary a parser gates on',
  },
  StandardsCoverageEnrichment: {
    false:
      'enriches standards-coverage rows with content — no closed taught verdict vocabulary a prompt promises and a parser accepts',
  },
};

/**
 * Routing nature/chain map — INSTAR-Bench v3 (2026-07-03) JOIN between bench
 * COVERAGE (does a component have a benchmark?) and bench-cited ROUTING (which
 * task-nature did the bench establish it is, and which production chain should
 * it ride?). This is the G1 join of Task-4 Piece 3: `LLM_BENCH_COVERAGE` says
 * "benched"; THIS map says "benched, and here is the winner-nature the v3 bench
 * established for it" — so routing (not just existence) is benchmark-cited.
 *
 * NATURE (task-nature taxonomy — docs/LLM-ROUTING-REGISTRY.md §taxonomy):
 *   A = simple bounded verdict   (classify / boolean gate / strict-JSON extract —
 *       one right answer, terse; speed + format-obedience; reasoning models CLIP)
 *   B = nuanced / critical judgment (safety gate, irreversible-action class,
 *       completion-stop judge — being RIGHT beats fast/cheap)
 *   D = high-volume background   (digests, batch classify, summaries, doc-tree)
 *   E = deep unbounded reasoning (rare; no output-budget pressure)
 * CHAIN (the four production default→fallback ladders — ELI16 §11):
 *   FAST  = latency-sensitive quick-sort (Flash-Lite → GPT-5.4 API → … )
 *   SORT  = background quick-sort         (GPT-5.4-mini codex → GPT-5.5 pi → …)
 *   JUDGE = careful judgment              (GPT-5.5 pi → … → Opus-4.8 API, NEVER CLI)
 *   WRITE = open-ended writing            (GPT-5.4-mini codex → … → Opus-4.8 CLI)
 *
 * SCOPE — deliberately advisory + NOT (yet) exhaustive over COMPONENT_CATEGORY.
 * This map covers the components whose task-nature the v3 bench established
 * UNAMBIGUOUSLY (a single nature letter in the registry's callsite inventory).
 * Genuinely multi-nature callsites (A/B, B/D) and the router-bypass callsites
 * are left for S4 (the nature-axis router), which ACTUATES this data into
 * IntelligenceRouter model selection and therefore touches critical-gate
 * routing — spec-converge + operator-review gated. Adding an entry HERE changes
 * NO routing today; it is read-only, bench-cited metadata those pieces consume.
 *
 * Ratchet — tests/unit/llm-routing-nature-ratchet.test.ts — enforces:
 *   - every key exists in COMPONENT_CATEGORY (no dangling routing claim),
 *   - every key present here is bench-COVERED in LLM_BENCH_COVERAGE (you may not
 *     cite a routing nature for an unbenched component — cite-the-bench),
 *   - nature ∈ {A,B,D,E}, chain ∈ {FAST,SORT,JUDGE,WRITE},
 *   - nature→chain coherence: A→FAST|SORT, B→JUDGE, D→SORT|WRITE, E→JUDGE.
 */
export type TaskNature = 'A' | 'B' | 'D' | 'E';
export type RoutingChain = 'FAST' | 'SORT' | 'JUDGE' | 'WRITE';
export interface RoutingNature {
  readonly nature: TaskNature;
  readonly chain: RoutingChain;
}

export const LLM_ROUTING_NATURE: Readonly<Record<string, RoutingNature>> = {
  // ── Nature A — bounded verdicts (background → SORT; latency-critical → FAST) ──
  // MessageSentinel = the emergency-stop classifier: latency-critical AND rule
  // R2 (never rides Opus-via-Claude-CLI — missed canonical STOPs at 73%).
  MessageSentinel: { nature: 'A', chain: 'FAST' },
  // Usher = per-turn topic routing: latency-sensitive quick-sort.
  Usher: { nature: 'A', chain: 'FAST' },
  CommitmentSentinel: { nature: 'A', chain: 'SORT' },
  TemporalCoherenceChecker: { nature: 'A', chain: 'SORT' },
  PresenceProxy: { nature: 'A', chain: 'SORT' },
  ResumeQueueDrainer: { nature: 'A', chain: 'SORT' },
  PromptGate: { nature: 'A', chain: 'SORT' },
  WarrantsReplyGate: { nature: 'A', chain: 'SORT' },
  InputClassifier: { nature: 'A', chain: 'SORT' },
  TelegramAdapter: { nature: 'A', chain: 'SORT' },
  SlackAdapter: { nature: 'A', chain: 'SORT' },
  OverrideDetector: { nature: 'A', chain: 'SORT' },
  TaskClassifier: { nature: 'A', chain: 'SORT' },
  ResumeValidator: { nature: 'A', chain: 'SORT' },
  TopicIntentExtractor: { nature: 'A', chain: 'SORT' },

  // ── Nature B — critical judgment gates (→ JUDGE; Opus only via API, never CLI) ──
  MessagingToneGate: { nature: 'B', chain: 'JUDGE' },
  CompletionEvaluator: { nature: 'B', chain: 'JUDGE' },
  ExternalOperationGate: { nature: 'B', chain: 'JUDGE' },
  LLMSanitizer: { nature: 'B', chain: 'JUDGE' },
  CoherenceReviewer: { nature: 'B', chain: 'JUDGE' },
  InputGuard: { nature: 'B', chain: 'JUDGE' },
  StallTriageNurse: { nature: 'B', chain: 'JUDGE' },
  ProjectDriftChecker: { nature: 'B', chain: 'JUDGE' },
  SessionWatchdog: { nature: 'B', chain: 'JUDGE' },
  UnjustifiedStopGate: { nature: 'B', chain: 'JUDGE' },

  // ── Nature D — background digests/summaries (→ SORT; R7 redaction on secret-bearing) ──
  SessionActivitySentinel: { nature: 'D', chain: 'SORT' },
  SessionSummarySentinel: { nature: 'D', chain: 'SORT' },
  'correction-learning': { nature: 'D', chain: 'SORT' },
};
