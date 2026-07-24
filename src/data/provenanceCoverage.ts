/**
 * PROVENANCE_COVERAGE census — LLM-Decision Quality Meter ratchet (G5).
 *
 * Spec: docs/specs/llm-decision-quality-meter.md §5.6 (census) + §5.4.2 (rule
 * registry). Same declare-or-fail pattern as LLM_BENCH_COVERAGE
 * (src/data/llmBenchCoverage.ts precedent), tightened per review: a declaration
 * per DECISION POINT (a component may hold several distinct decision points
 * with different prompts/outcomes), each entry one of:
 *   - status 'wired'                — the callsite carries `options.provenance`
 *     enrollment (typed import of the decision-point id exported HERE; the
 *     settlement write additionally validates decisionPoint ∈ census at
 *     runtime and counts unknowns). Wired entries declare their volumeClass —
 *     the PROVENANCE store's volume valve (§5.6; the ~250-byte decision_quality
 *     row is written for every enrolled settlement regardless of class).
 *   - status 'pending:<ACT-ref>'    — the retrofit backlog, format-validated +
 *     PINNED shrink-only in tests/unit/provenance-coverage-ratchet.test.ts
 *     (count can only go down; re-pointing an entry to a different ACT is a
 *     reviewed baseline change — shrink-only covers count, not identity). The
 *     runtime half of the two-layer check (§5.6 pending-ref-dead) lives on
 *     GET /decision-quality, where the evolution queue exists.
 *   - status 'exempt:<taxonomy>'    — a CLOSED taxonomy (an exemption is a
 *     classification, not an essay): 'deterministic-only' (no LLM verdict at
 *     this point) | 'no-decision-content' (nothing reconstructable beyond what
 *     feature_metrics already records) | 'operator-ratified:<resolvable-ref>'.
 *     Free-text exemptions are refused by the ratchet; the exempt baseline is
 *     pinned shrink-only exactly like pending (ADV r5).
 *
 * ENROLLMENT KEY CONVENTION (§5.6, a census-test ASSERTION, not prose): each
 * decision point uses a 1:1 `attribution.component` key (the existing
 * `CompletionEvaluator` vs `CompletionEvaluator/P13` suffix pattern); the key
 * is UNIQUE across census entries REGARDLESS of status (ADV r7 — uniform
 * uniqueness closes the pending-absorbs-wired-activity and exempt-false-flags
 * carve-out attacks). Multi-call compositions get one unique suffixed key PER
 * point with linkage ONLY via the `composition` field (§5.1.1 — key sharing
 * would re-open the same-key blind spot).
 *
 * WHY (operator goal, 2026-07-10 topic 11960): a new LLM decision point that
 * skips provenance must fail CI — an unlogged decision-maker cannot be graded,
 * and "does this gate need a bigger model or a prompt change?" is unanswerable
 * without provenance + outcomes. Structure > Willpower.
 *
 * Companion chain: componentCategories keeps COMPONENT_CATEGORY exhaustive
 * over LLM callsites; LLM_BENCH_COVERAGE keeps bench coverage exhaustive over
 * COMPONENT_CATEGORY; THIS census keeps provenance posture exhaustive over
 * COMPONENT_CATEGORY, per decision point.
 */

// ───────────────────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────────────────

/** Closed exemption taxonomy (§5.6) — free text is refused by the ratchet. */
export type ExemptTaxonomyKey = 'deterministic-only' | 'no-decision-content';

export const EXEMPT_TAXONOMY_KEYS: ReadonlyArray<ExemptTaxonomyKey> = [
  'deterministic-only',
  'no-decision-content',
];

/**
 * A decision point's provenance posture. `pending:<ACT-ref>` refs are
 * format-validated (^ACT-\d+$) and baseline-pinned by the ratchet;
 * `exempt:operator-ratified:` carries a resolvable ref (PR / standards-registry
 * anchor), also ratchet-validated.
 */
export type ProvenanceStatus =
  | 'wired'
  | `pending:${string}`
  | `exempt:${ExemptTaxonomyKey}`
  | `exempt:operator-ratified:${string}`;

/**
 * The PROVENANCE store's volume valve (§5.6/FD4): `full` (always-write —
 * RESERVED for genuinely low-frequency high-stakes points; the arbiter-bypass
 * invariant applies only here) | `sampled:<rate>` (rides the existing FNV-1a
 * sampling) | `budget:<rows/day>` (per-point UTC-day cap, COUNT-enforced, loud
 * droppedByBudget counter). Valves the provenance JSONL row ONLY — the
 * decision_quality row is written for every enrolled settlement (§5.5).
 */
export type VolumeClass = 'full' | `sampled:${string}` | `budget:${string}`;

/** Content class (§5.2) — declared per decision point; selects the code-provided
 * envelope BUILDER (callsites do not hand-roll context shapes):
 *   - 'metadata'        — context is code-authored facts (ids, hashes, booleans,
 *     numbers, enums). The default.
 *   - 'content-bearing' — the decision judges user/peer/process-authored text;
 *     context enters as identity + bounded features (hashes/pointers, code-derived
 *     feature summaries, ≤300-char scrubbed head), NEVER full bodies. */
export type ContentClass = 'metadata' | 'content-bearing';

/** §5.1.1 boundary rule: one decision row per router.evaluate() invocation. A
 * component whose one human-visible judgment spans multiple evaluate() calls
 * declares `multi-call:<comma-linked decision-point ids>` — one census entry
 * per call, EACH with its OWN suffixed unique component key; linkage lives
 * ONLY here. */
export type Composition = 'single' | `multi-call:${string}`;

export interface ProvenanceCoverageEntry {
  /** Stable decision-point id (^[a-z0-9][a-z0-9-]{0,63}$). Wired points export
   * a `DP_<UPPER_SNAKE>` constant from this module; enrolling callsites IMPORT
   * that constant (typed registration — a string-literal-only decision point
   * at a callsite fails the ratchet). */
  readonly decisionPoint: string;
  /** The 1:1 `attribution.component` enrollment key — unique across ALL census
   * entries regardless of status (ADV r7). Suffix pattern for multi-point
   * components: 'CompletionEvaluator/P13'. */
  readonly component: string;
  readonly status: ProvenanceStatus;
  /** REQUIRED for wired entries (ratchet-enforced); a pending entry MAY
   * forward-declare its intended class (advisory until enrollment). */
  readonly volumeClass?: VolumeClass;
  readonly contentClass: ContentClass;
  /** Default 'single' when absent. */
  readonly composition?: Composition;
  /** REQUIRED (≥40 chars, ratchet-enforced) for pending/exempt entries — a real
   * argument, never a lazy "n/a". Optional color for wired entries. */
  readonly reason?: string;
  /** A wired point normally has at least one RULE_REGISTRY row. This explicit
   * posture is the only honest exception: measurement-only means provenance is
   * intentionally collected before an outcome rule exists; exempt means an
   * outcome is structurally unavailable. Both require gradingReason. */
  readonly gradingPosture?: 'measurement-only' | 'exempt';
  readonly gradingReason?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Wired decision-point id constants (typed registration, §5.6).
//
// NAMING CONVENTION (ratchet-enforced): a wired decision point 'a-b-c' exports
// `DP_A_B_C`. Enrolling callsites import the constant — never restate the
// string (the census is the single source of truth).
// ───────────────────────────────────────────────────────────────────────────

/** External-hog kill/leave decision point — the classifier verdict inside the
 * scan-tick decision loop (ExternalHogScanTick; spec §5.3 first customer). */
export const DP_EXTERNAL_HOG_KILL_LEAVE = 'external-hog-kill-leave';

/** Autonomous completion judge — CompletionEvaluator.evaluate() (spec §5.3). */
export const DP_COMPLETION_EVALUATE = 'completion-evaluate';

/** P13 stop-rationale judge — CompletionEvaluator.evaluateStopRationale()
 * (component 'CompletionEvaluator/P13'; spec §5.3). */
export const DP_COMPLETION_STOP_RATIONALE = 'completion-stop-rationale';

/** Outbound tone/leak verdict — MessagingToneGate.review() (component
 * 'MessagingToneGate'; spec §5.6). An ALWAYS-ON HIGH-VOLUME gate: it declares a
 * `budget:<rows/day>` volume valve (NEVER `full`) and stores content as IDENTITY
 * only (candidate hash + bounds + code-derived features), never the outbound
 * body or any plaintext slice of it. */
export const DP_MESSAGING_TONE_GATE = 'messaging-tone-gate';

/** Record-time standards/process review proposed for one correction. */
export const DP_CORRECTION_CLASS_REVIEW = 'correction-class-review';

/** Clause-level future-commitment vs completion-assertion arbitration. */
export const DP_COMPLETION_CLAIM_VERIFY = 'completion-claim-verify';

/** Feedback cluster evidence → owned-work readiness judgment. */
export const DP_FEEDBACK_READINESS = 'feedback-readiness';

// ───────────────────────────────────────────────────────────────────────────
// The census
// ───────────────────────────────────────────────────────────────────────────

export const PROVENANCE_COVERAGE: ReadonlyArray<ProvenanceCoverageEntry> = [
  // ── Wired first customers (§5.3 — genuinely low-frequency + high-stakes;
  //    volumeClass 'full' is RESERVED for this class) ──────────────────────
  {
    decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE,
    component: 'ExternalHogClassifier',
    status: 'wired',
    volumeClass: 'full',
    // §5.3: judges an attacker-controllable process name (argv is HASHED at the
    // envelope — the floor needs argv, the provenance row does not); context =
    // commandHash/ledgerKey/classId, floor booleans, CPU numbers, identity tuples.
    contentClass: 'content-bearing',
    reason:
      'First customer (spec §5.3): the kill/leave verdict is the highest-consequence LLM decision on the host; enacted disposition + evidence rules grade it.',
  },
  {
    decisionPoint: DP_COMPLETION_EVALUATE,
    component: 'CompletionEvaluator',
    status: 'wired',
    volumeClass: 'full',
    // §5.3: context carries transcript-slice IDENTITY (hash + bounds) + the
    // StopSignals corroboration block — never transcript text.
    contentClass: 'content-bearing',
    reason:
      'First customer (spec §5.3): the autonomous continue/stop judge gates whether a run keeps burning budget; realcheck gives it deterministic ground truth.',
  },
  {
    decisionPoint: DP_COMPLETION_STOP_RATIONALE,
    component: 'CompletionEvaluator/P13',
    status: 'wired',
    volumeClass: 'full',
    contentClass: 'content-bearing',
    reason:
      'First customer (spec §5.3): the P13 stop-rationale judge decides whether a stop-attempt is EARNED; same transcript-slice-identity envelope as evaluate().',
  },

  // ── Wired high-volume gate (§5.6 — NOT full-class; the third enrolled
  //    customer, which required the grading-pass per-point sub-budget FIRST —
  //    SUBBUDGET_IMPLEMENTED is now true) ─────────────────────────────────────
  {
    decisionPoint: DP_MESSAGING_TONE_GATE,
    component: 'MessagingToneGate',
    status: 'wired',
    // §5.6 volume valve: an ALWAYS-ON high-volume gate MUST NOT be `full`. A
    // per-UTC-day COUNT budget gives a hard, count-enforced ceiling on the
    // provenance JSONL archive (loud droppedByBudget counter when hit) — a
    // deterministic bound preferable to probabilistic sampling for a gate that
    // fires on every drafted outbound message. 500/day = a representative daily
    // sample without unbounded growth; the ~250-byte decision_quality row is
    // ALWAYS written regardless (counts stay complete).
    volumeClass: 'budget:500',
    // Content-bearing: the gate judges an agent-authored outbound message. It
    // enters the row as IDENTITY ONLY — a sha256 of the candidate + byte/char
    // bounds + code-derived features — never the full body or any plaintext
    // slice (the provenance store must not become an outbound-message archive;
    // mirrors the CompletionEvaluator content-bearing sibling, §5.3).
    contentClass: 'content-bearing',
    reason:
      'The outbound tone/leak authority (spec §5.6 named high-volume point). Enrolled at budget:500/day, identity-only content — never the message body.',
  },
  {
    decisionPoint: DP_CORRECTION_CLASS_REVIEW,
    component: 'correction-class-review',
    status: 'wired',
    volumeClass: 'budget:100',
    contentClass: 'content-bearing',
    reason:
      'Each durable correction receives one bounded standards/process proposal; identity-only context supports outcome grading without archiving correction text.',
  },
  {
    decisionPoint: DP_COMPLETION_CLAIM_VERIFY,
    component: 'completion-claim-verify',
    status: 'wired',
    volumeClass: 'budget:500',
    contentClass: 'content-bearing',
    reason:
      'Completion-language turns receive clause arbitration before optional suppression authority; identity-only context preserves auditability without transcript content.',
  },
  {
    decisionPoint: DP_FEEDBACK_READINESS,
    component: 'FeedbackReadinessArbiter',
    status: 'wired',
    volumeClass: 'budget:250',
    contentClass: 'content-bearing',
    reason:
      'A bounded frontier-model judgment authorizes cluster-to-work readiness; provenance stores packet identity and enumerated outcomes, never feedback text or model output.',
  },

  // ── Pending (the ACT-1193 uniform-provenance retrofit backlog — §5.6: "Not
  //    retrofitting all ~60+ decision points in one PR"; the census makes the
  //    backlog visible, ratcheted, and re-surfaced as census debt on
  //    GET /decision-quality). Each enrolls via the §5.1.4 per-callsite
  //    contract and declares its REAL volume class at enrollment.
  //    contentClass mirrors the reviewed LLM_UNTRUSTED_INPUT axis
  //    (src/data/llmBenchCoverage.ts): every point below judges user/model/
  //    tool-authored text → content-bearing. ─────────────────────────────────

  // — Sentinels —
  {
    decisionPoint: 'input-guard',
    component: 'InputGuard',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Input-coherence verdict over an inbound prompt; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'session-activity-digest',
    component: 'SessionActivitySentinel',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Activity digest authored over session tmux output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'stall-triage-diagnosis',
    component: 'StallTriageNurse',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Stall-triage diagnosis over session output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'commitment-detect',
    component: 'CommitmentSentinel',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Commitment detection over conversation text; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'presence-stall-judge',
    component: 'PresenceProxy',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Tier-3 stall judgment over session output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'message-sentinel-classify',
    component: 'MessageSentinel',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Pause/emergency/normal intent classification over an inbound user message (latency-critical); enrollment queued in the ACT-1193 retrofit backlog.',
  },
  {
    decisionPoint: 'project-drift-check',
    component: 'ProjectDriftChecker',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Is-work-on-project coherence verdict over session work + files; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'temporal-coherence-check',
    component: 'TemporalCoherenceChecker',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Temporal-coherence verdict over conversation content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'watchdog-stuck-judge',
    component: 'SessionWatchdog',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Stuck-session judgment over live session output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'resume-sanity-check',
    component: 'ResumeQueueDrainer',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Resume-sanity verdict before a queued mid-work revival; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'topic-intent-arc-check',
    component: 'TopicIntentArcCheck',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Arc-check classification of a topic intent over conversation; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'slack-stall-confirm',
    component: 'SlackAdapter',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Stall-confirm alert-suppression judgment over session output (Slack arm); enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },

  // — Gates —
  {
    decisionPoint: 'prompt-injection-detect',
    component: 'PromptGate',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Prompt-injection detection over inbound content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'external-operation-gate',
    component: 'ExternalOperationGate',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Operation mutability/reversibility classification incl. in-content approval claims; enrollment queued in the ACT-1193 retrofit backlog.',
  },
  {
    decisionPoint: 'warrants-reply-gate',
    component: 'WarrantsReplyGate',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Should-I-reply verdict over an inbound message; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'unjustified-stop-gate',
    component: 'UnjustifiedStopGate',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Stop-justified verdict over session state; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'coherence-review',
    component: 'CoherenceReviewer',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Outbound coherence review — THE measured high-volume point (3,641 of 4,098 llm calls/24h on the dev agent, spec §5.6); MUST declare sampled:<rate> or budget:<rows/day> at enrollment, never full.',
  },
  {
    decisionPoint: 'move-intent-classify',
    component: 'MoveIntentClassifier',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Move/pin command-vs-discussion intent over an inbound message + context; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'hub-intent-classify',
    component: 'HubIntentClassifier',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Hub open/tie bind-intent over an inbound hub message; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'profile-intent-classify',
    component: 'ProfileIntentClassifier',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Topic-profile change intent (framework/model/thinking) over an inbound message; enrollment queued in the ACT-1193 retrofit backlog.',
  },
  {
    decisionPoint: 'llm-sanitize',
    component: 'LLMSanitizer',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Sanitize verdict over untrusted inbound content (definitionally injection-exposed); enrollment queued in the ACT-1193 retrofit backlog.',
  },
  {
    decisionPoint: 'override-detect',
    component: 'OverrideDetector',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Override-intent detection over a user turn (uxConfirm pre-routing); enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'task-classify',
    component: 'TaskClassifier',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Task-type classification over a user task description; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },

  // — Reflectors —
  {
    decisionPoint: 'job-reflect',
    component: 'JobReflector',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Job-outcome reflection over job output/transcript; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'cross-model-review',
    component: 'crossModelReviewer',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Cross-model spec-document review over file content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'self-knowledge-extract',
    component: 'SelfKnowledgeTree',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Self-knowledge extraction over transcripts; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'tree-triage',
    component: 'TreeTriage',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Knowledge-tree fragment triage over stored content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'topic-summarize',
    component: 'TopicSummarizer',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Topic summary authoring over conversation content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'contextual-evaluate',
    component: 'ContextualEvaluator',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Context-relevance evaluation over conversation/session content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'relationship-extract',
    component: 'RelationshipManager',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Relationship-fact extraction from conversation (PII-adjacent content); enrollment queued in the ACT-1193 retrofit backlog.',
  },
  {
    decisionPoint: 'standards-conformance-review',
    component: 'StandardsConformanceReviewer',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Artifact-vs-standard conformance review over file content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'discovery-evaluate',
    component: 'DiscoveryEvaluator',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Serendipity-discovery evaluation over subagent output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'dashboard-insight',
    component: 'DashboardInsightEngine',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Awareness-only page-data insight authoring (degrades to a deterministic floor); enrollment queued in the ACT-1193 retrofit backlog.',
  },

  // — Jobs —
  {
    decisionPoint: 'pipe-session-spawn',
    component: 'PipeSessionSpawner',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Session authoring from (possibly user-authored) task descriptions; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'cartographer-summary-author',
    component: 'CartographerSweep',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Doc-tree summary authoring over untrusted code; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'standards-coverage-enrich',
    component: 'StandardsCoverageEnrichment',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Standards-coverage row enrichment over repo content (dark LLM path); enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },

  // — Previously-uncategorized callsites (LLM Routing Registry audit set) —
  {
    decisionPoint: 'input-classify',
    component: 'InputClassifier',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Auto-approve vs relay classification of inbound input; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'session-summary-extract',
    component: 'SessionSummarySentinel',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Task/phase/files extraction over tmux output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'telegram-stall-confirm',
    component: 'TelegramAdapter',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Stall-confirm alert-suppression judgment over session output (Telegram arm); enrollment queued in the ACT-1193 retrofit backlog.',
  },
  {
    decisionPoint: 'resume-uuid-validate',
    component: 'ResumeValidator',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Resume-UUID-vs-topic match verdict over session/resume state; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'usher-topic-route',
    component: 'Usher',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Per-turn topic routing over an inbound user turn; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'topic-intent-extract',
    component: 'TopicIntentExtractor',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Topic-intent extraction from a user turn; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'pre-compaction-flush',
    component: 'PreCompactionFlush',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Durable-fact extraction over a transcript before compaction; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'tree-synthesize',
    component: 'TreeSynthesis',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Knowledge-fragment synthesis into an answer; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'llm-conflict-resolve',
    component: 'LLMConflictResolver',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Divergent multi-machine state resolution over untrusted peer data; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'open-conversation-brief',
    component: 'openConversationBrief',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'A2A conversation-brief authoring over peer content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'a2a-checkin-summarize',
    component: 'a2a-checkin',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'A2A check-in thread summarization over peer-authored threads; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'correction-distill',
    component: 'correction-learning',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Recurring-correction distillation into a durable preference; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'mentor-stage-b-classify',
    component: 'mentor-stage-b',
    status: 'pending:ACT-1193',
    contentClass: 'content-bearing',
    reason:
      'Mentor-signal classification over mentee output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },

  // ── Argued exemptions (closed taxonomy; pinned shrink-only) ──────────────
  {
    decisionPoint: 'input-detector-alias',
    component: 'InputDetector',
    status: 'exempt:deterministic-only',
    contentClass: 'metadata',
    reason:
      'Attribution-manifest alias only (a legacy prompt-pattern matcher) — no LLM verdict at this point; the live matcher calls with attribution PromptGate, declared there.',
  },
  {
    decisionPoint: 'auto-approve-injection',
    component: 'AutoApprover',
    status: 'exempt:deterministic-only',
    contentClass: 'metadata',
    reason:
      'Mechanical key injection + audit logging — no LLM verdict at this point; the upstream judgment is InputClassifier.classify(), declared as input-classify.',
  },
  {
    decisionPoint: 'integration-gate-delegate',
    component: 'IntegrationGate',
    status: 'exempt:deterministic-only',
    contentClass: 'metadata',
    reason:
      'No LLM prompt of its own — delegates to JobReflector.reflect() (attribution JobReflector, declared as job-reflect); zero LLM-provider callsites of its own.',
  },
  {
    decisionPoint: 'coherence-gate-delegate',
    component: 'CoherenceGate',
    status: 'exempt:deterministic-only',
    contentClass: 'metadata',
    reason:
      'No callsite carries attribution CoherenceGate — all LLM calls flow through CoherenceReviewer.callApi(), declared as coherence-review.',
  },
  {
    decisionPoint: 'promise-beacon-status-line',
    component: 'PromiseBeacon',
    status: 'exempt:deterministic-only',
    contentClass: 'metadata',
    reason:
      'No live LLM prompt — generateStatusLine/classifyProgress hooks are unwired at the construction site; no LLM verdict exists at this point. Revisit if a generator is wired.',
  },
  {
    decisionPoint: 'interactive-pool-canary-judge',
    component: 'InteractivePoolCanaryJudge',
    status: 'exempt:no-decision-content',
    contentClass: 'metadata',
    reason:
      'Judges a FIXED known-answer canary probe — the input is a constant, so nothing is reconstructable beyond what feature_metrics already records (the canary is its own provenance). NOT deterministic-only: it legitimately emits llm-kind metric rows.',
  },
];

// ───────────────────────────────────────────────────────────────────────────
// Grading-pass fairness marker (§5.5 / LES r6).
//
// The grading endpoint's per-pass bound was GLOBAL, not per-point — safe for the
// two seeded low-frequency full-class customers, but a third ENROLLED customer
// could starve sibling points' evidence windows. The census ratchet asserts
// structurally that enrolling beyond the seeded first-customer set requires the
// per-point round-robin sub-budget FIRST: this is now true because
// `runDecisionGradingPass` divides its global budget round-robin across the
// grade-pass-driven points (src/core/decisionGradingPass.ts — the sub-budget
// helper `perPointSubBudget`), so no single point can consume a whole pass and
// starve a sibling's maturing evidence window. Flipped in the PR that
// implements that sub-budget (MessagingToneGate enrollment, the third customer).
// ───────────────────────────────────────────────────────────────────────────

export const SUBBUDGET_IMPLEMENTED = true;

// ───────────────────────────────────────────────────────────────────────────
// Evidence-rule registry (§5.4.2) — ruleId → rung + evidence-strength + OWNING
// component (+ registered window parameter). Co-located with the census by
// spec: imported by the annotate chokepoint and the grading endpoint; the
// ratchet pins the enums and the existing rule identities.
//
// Rung is DERIVED from this registry, never caller-supplied: an annotation
// claiming a ruleId whose registered rung disagrees, or an unregistered
// ruleId, is REJECTED and counted (§5.4.2). The chokepoint also rejects an
// annotation whose gradedBy.component is not the ruleId's registered owner
// (ADV r5 — a confused in-process annotator cannot inherit another rule's
// rung/precedence by claiming its id).
//
// Rules are precise predicates with IMMUTABLE, VERSIONED ids (§5.4.5): a
// predicate change — or a change to a registered parameter like windowMs —
// mints a new ruleId ('-v2'), never mutates '-v1' in place.
// ───────────────────────────────────────────────────────────────────────────

/** Grading-ladder rungs, in PRECEDENCE ORDER (§5.4.3): earlier beats later.
 * A self-reported outcome NEVER overrides an independent grader. */
export const EVIDENCE_RUNGS = [
  'deterministic-ground-truth',
  'recurrence',
  'llm-interpreter', // DORMANT this build (FD11) — no rule may register it until ACT-1198's preconditions land.
  'self-report',
] as const;
export type EvidenceRung = (typeof EVIDENCE_RUNGS)[number];

/** Evidence-strength classes (§5.4.2, codex r3): the read surface splits
 * proof-like from heuristic grades so aggregates cannot imply stronger
 * correctness than the evidence supports. */
export const EVIDENCE_STRENGTHS = [
  'deterministic-proof',
  'negative-evidence',
  'recurrence-proxy',
  'self-report',
] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

export interface EvidenceRule {
  readonly ruleId: string;
  /** Census decision point whose outcomes this rule grades. */
  readonly decisionPoint: string;
  readonly rung: EvidenceRung;
  readonly evidenceStrength: EvidenceStrength;
  /** The ONLY component whose gradedBy.component the annotate chokepoint
   * accepts for this rule (ADV r5). An annotator actor name — not necessarily
   * a COMPONENT_CATEGORY key. */
  readonly owningComponent: string;
  /** The rule's registered evidence-window parameter, where the predicate is
   * window-bounded (§5.4.5 — recorded per outcome row; a window change mints
   * a new ruleId version). */
  readonly windowMs?: number;
}

/** Default hog evidence window (§5.4.5 "bounded window (default 6h)"). */
const HOG_EVIDENCE_WINDOW_MS = 6 * 60 * 60 * 1000;
export const DECISION_POINT_EVIDENCE_WINDOW_MS = 6 * 60 * 60 * 1000;

export const RULE_REGISTRY: Readonly<Record<string, EvidenceRule>> = {
  // A kill graded `wrong` ONLY IF a same-commandHash candidate respawns in-window
  // AND the kill-time ordering test re-runs TRUE at evidence time (§5.4.5).
  // Positive-evidence grading runs in the sentinel's scan ticks + grade-on-supersede.
  'hog-respawn-wrong-v1': {
    ruleId: 'hog-respawn-wrong-v1',
    decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE,
    rung: 'deterministic-ground-truth',
    evidenceStrength: 'deterministic-proof',
    owningComponent: 'ExternalHogSentinel',
    windowMs: HOG_EVIDENCE_WINDOW_MS,
  },
  // A kill whose commandHash does NOT re-flag in-window (owner recorded dead at
  // kill time) grades `right` at window close — negative evidence, never proof
  // (quiet respawns are invisible to the sustained-CPU sensor; §5.4.5). Window-
  // close grading runs in the grading job reading the durable hog store.
  'hog-sustained-right-v1': {
    ruleId: 'hog-sustained-right-v1',
    decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE,
    rung: 'deterministic-ground-truth',
    evidenceStrength: 'negative-evidence',
    owningComponent: 'DecisionGrading',
    windowMs: HOG_EVIDENCE_WINDOW_MS,
  },
  // Applies ONLY to verdict==='leave' AND enacted==='alert-only-model-spared'
  // AND floorPermitted===true: the SAME PROCESS (targetTuple pid+start-time)
  // re-flagging in-window grades the leave `wrong`; a same-commandHash
  // DIFFERENT process grades `unknown` (§5.4.5). Re-flag detection runs in the
  // sentinel's scan ticks + grade-on-supersede.
  'hog-leave-recurrence-v1': {
    ruleId: 'hog-leave-recurrence-v1',
    decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE,
    rung: 'recurrence',
    evidenceStrength: 'recurrence-proxy',
    owningComponent: 'ExternalHogSentinel',
    windowMs: HOG_EVIDENCE_WINDOW_MS,
  },
  // met:true + realcheck pass → right; met:true + realcheck fail → wrong; no
  // realcheck configured → unknown, never guessed (§5.3/§5.4.5). The annotator
  // is the deterministic realcheck arm of the autonomous completion path (P8
  // wiring binds gradedBy.component to this owner).
  'completion-realcheck-v1': {
    ruleId: 'completion-realcheck-v1',
    decisionPoint: DP_COMPLETION_EVALUATE,
    rung: 'deterministic-ground-truth',
    evidenceStrength: 'deterministic-proof',
    owningComponent: 'AutonomousRealCheck',
  },
  // §5.3 enacted-disposition self-reports: the deterministic actor that applied
  // floors/breakers/governors records what was ACTUALLY enacted, immediately,
  // as a self-report-rung annotation (never overrides an independent grader).
  'hog-enacted-disposition-v1': {
    ruleId: 'hog-enacted-disposition-v1',
    decisionPoint: DP_EXTERNAL_HOG_KILL_LEAVE,
    rung: 'self-report',
    evidenceStrength: 'self-report',
    owningComponent: 'ExternalHogSentinel',
  },
  'completion-enacted-disposition-v1': {
    ruleId: 'completion-enacted-disposition-v1',
    decisionPoint: DP_COMPLETION_STOP_RATIONALE,
    rung: 'self-report',
    evidenceStrength: 'self-report',
    owningComponent: 'CompletionChokepoint',
  },
  // Phase B terminalizers. These rules do not manufacture a right/wrong
  // verdict from silence: once the bounded evidence window closes without an
  // independent outcome, they record the honest `unknown` grade so old rows
  // stop masquerading as an unprocessed grading backlog. The existing grade
  // pass owns all four rules and advances independent per-point cursors.
  'tone-window-unknown-v1': {
    ruleId: 'tone-window-unknown-v1', decisionPoint: DP_MESSAGING_TONE_GATE,
    rung: 'deterministic-ground-truth', evidenceStrength: 'negative-evidence',
    owningComponent: 'DecisionGrading', windowMs: DECISION_POINT_EVIDENCE_WINDOW_MS,
  },
  'correction-review-window-unknown-v1': {
    ruleId: 'correction-review-window-unknown-v1', decisionPoint: DP_CORRECTION_CLASS_REVIEW,
    rung: 'deterministic-ground-truth', evidenceStrength: 'negative-evidence',
    owningComponent: 'DecisionGrading', windowMs: DECISION_POINT_EVIDENCE_WINDOW_MS,
  },
  'completion-claim-window-unknown-v1': {
    ruleId: 'completion-claim-window-unknown-v1', decisionPoint: DP_COMPLETION_CLAIM_VERIFY,
    rung: 'deterministic-ground-truth', evidenceStrength: 'negative-evidence',
    owningComponent: 'DecisionGrading', windowMs: DECISION_POINT_EVIDENCE_WINDOW_MS,
  },
  'feedback-readiness-window-unknown-v1': {
    ruleId: 'feedback-readiness-window-unknown-v1', decisionPoint: DP_FEEDBACK_READINESS,
    rung: 'deterministic-ground-truth', evidenceStrength: 'negative-evidence',
    owningComponent: 'DecisionGrading', windowMs: DECISION_POINT_EVIDENCE_WINDOW_MS,
  },
};

/** Loud class contradiction: a wired provenance point that cannot produce an
 * outcome grade and has not explicitly declared measurement-only/exempt. */
export function findWiredWithoutGraders(
  coverage: ReadonlyArray<ProvenanceCoverageEntry> = PROVENANCE_COVERAGE,
  registry: Readonly<Record<string, EvidenceRule>> = RULE_REGISTRY,
): string[] {
  const graded = new Set(Object.values(registry).map((rule) => rule.decisionPoint));
  return coverage
    .filter((entry) => {
      if (entry.status !== 'wired' || graded.has(entry.decisionPoint)) return false;
      const explicit = entry.gradingPosture === 'measurement-only' || entry.gradingPosture === 'exempt';
      return !explicit || (entry.gradingReason ?? '').trim().length < 40;
    })
    .map((entry) => entry.decisionPoint)
    .sort();
}

/** Full declaration-consistency audit used by the developer-process ratchet.
 * Runtime reads surface the primary wired-but-no-grader subset; CI refuses all
 * mutually contradictory source shapes. */
export function findGradingContradictions(
  coverage: ReadonlyArray<ProvenanceCoverageEntry> = PROVENANCE_COVERAGE,
  registry: Readonly<Record<string, EvidenceRule>> = RULE_REGISTRY,
): string[] {
  const findings: string[] = [];
  const counts = new Map<string, number>();
  for (const entry of coverage) counts.set(entry.decisionPoint, (counts.get(entry.decisionPoint) ?? 0) + 1);
  for (const [decisionPoint, count] of counts) {
    if (count > 1) findings.push(`duplicate-census:${decisionPoint}`);
  }
  const byPoint = new Map(coverage.map((entry) => [entry.decisionPoint, entry]));
  const graded = new Set<string>();
  for (const rule of Object.values(registry)) {
    graded.add(rule.decisionPoint);
    const entry = byPoint.get(rule.decisionPoint);
    if (!entry || entry.status !== 'wired') findings.push(`rule-target-not-wired:${rule.ruleId}:${rule.decisionPoint}`);
  }
  for (const entry of coverage) {
    if (entry.status !== 'wired') continue;
    const hasRule = graded.has(entry.decisionPoint);
    const explicit = entry.gradingPosture === 'measurement-only' || entry.gradingPosture === 'exempt';
    const validReason = (entry.gradingReason ?? '').trim().length >= 40;
    if (hasRule && explicit) findings.push(`grader-and-${entry.gradingPosture}:${entry.decisionPoint}`);
    if (!hasRule && (!explicit || !validReason)) findings.push(`wired-but-no-grader:${entry.decisionPoint}`);
  }
  return [...new Set(findings)].sort();
}

// ───────────────────────────────────────────────────────────────────────────
// Lookup helpers (imported by the settlement seam, the annotate chokepoint,
// the grading endpoint, and the read surface).
// ───────────────────────────────────────────────────────────────────────────

const CENSUS_BY_POINT: ReadonlyMap<string, ProvenanceCoverageEntry> = new Map(
  PROVENANCE_COVERAGE.map((e) => [e.decisionPoint, e]),
);

const CENSUS_BY_COMPONENT: ReadonlyMap<string, ProvenanceCoverageEntry> = new Map(
  PROVENANCE_COVERAGE.map((e) => [e.component, e]),
);

/** The census entry for a decision point, or undefined (an unknown decision
 * point at the settlement write is counted, never thrown — §5.6). */
export function getCensusEntry(decisionPoint: string): ProvenanceCoverageEntry | undefined {
  return CENSUS_BY_POINT.get(decisionPoint);
}

/** The census entry keyed by the 1:1 `attribution.component` enrollment key
 * (the bridge the wired-but-silent / exempt-but-active runtime flags use). */
export function getCensusEntryByComponent(componentKey: string): ProvenanceCoverageEntry | undefined {
  return CENSUS_BY_COMPONENT.get(componentKey);
}

/** True iff the decision point is declared AND wired (enrolled). Pending and
 * exempt points are NOT enrolled — the seam writes nothing for them. */
export function isEnrolled(decisionPoint: string): boolean {
  return CENSUS_BY_POINT.get(decisionPoint)?.status === 'wired';
}

/** The volume class governing the provenance JSONL row for an ENROLLED point
 * (undefined for unknown/pending/exempt points — a forward-declared class on a
 * pending entry is advisory and must not valve anything before enrollment). */
export function getVolumeClass(decisionPoint: string): VolumeClass | undefined {
  const e = CENSUS_BY_POINT.get(decisionPoint);
  return e?.status === 'wired' ? e.volumeClass : undefined;
}

/** The registered evidence rule for a ruleId, or undefined (the annotate
 * chokepoint REJECTS and counts annotations claiming an unregistered id). */
export function getRule(ruleId: string): EvidenceRule | undefined {
  return RULE_REGISTRY[ruleId];
}
