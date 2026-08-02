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
 *   - status 'pending:<ref>'        — the retrofit backlog, format-validated +
 *     PINNED shrink-only in tests/unit/provenance-coverage-ratchet.test.ts
 *     (count can only go down; re-pointing an entry to a different tracker is a
 *     reviewed baseline change — shrink-only covers count, not identity). A ref
 *     is one of two KINDS: `ACT-<n>` (machine-local) or `backlog:<key>`
 *     (fleet-stable, resolved against BACKLOG_TRACKERS below). The
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
 * A BACKLOG TRACKER — a fleet-stable owner for a body of pending work.
 *
 * WHY THIS EXISTS (census-tracker-ref-kinds). A pending entry needs to name
 * something a reader can resolve to answer "is this still tracked?". Two
 * candidate anchors were rejected on evidence:
 *
 *  - An evolution-action id (`ACT-1193`) is a MACHINE-LOCAL handle. Written
 *    into this constant — which is byte-identical on every install — it can
 *    resolve on exactly one machine in the fleet.
 *  - A spec DOCUMENT path was the obvious next reach, and is wrong for a
 *    reason worth recording: `docs/` is excluded from the published package
 *    (`.npmignore`; absent from package.json `files[]`). An existence check
 *    against a doc path resolves FALSE on every fleet install, converting
 *    "unverifiable" into a fleet-wide false "deleted" — strictly worse than
 *    the status quo, and a re-run of the exact false alarm the 2026-07-23 fix
 *    removed. (External cross-model review, 2026-07-25, caught this.)
 *
 * A source constant is the anchor that survives both objections: `src/data/`
 * IS published, it compiles into `dist/`, and this record is therefore
 * byte-identical everywhere BY CONSTRUCTION — no filesystem, no packaging
 * assumption, no sub-document anchor that can silently drift.
 *
 * Removing a key while entries still point at it is a REAL deletion, and the
 * adjudicator reports it as `dead` on every machine at once. That is the
 * signal the debt check was built to raise.
 */
export interface BacklogTracker {
  /** Stable key. Charset-clamped by the ratchet: ^[a-z0-9][a-z0-9-]*$ */
  readonly key: string;
  /** Where the work is specified. Documentation for a reader — NEVER resolved. */
  readonly owner: string;
  /** What the backlog is, in one line. */
  readonly summary: string;
  /**
   * What must become TRUE for this backlog to be finished — the answer to
   * "when does this key get deleted?".
   *
   * WHY IT IS REQUIRED (external review, 2026-07-25): without it, `alive` decays
   * into "still listed". A key nobody ever retires makes the debt check pass
   * forever while the work rots — the same class of empty-green the whole change
   * exists to remove, just moved one level up. A closure condition makes the
   * key's own staleness reviewable by a human reading the registry.
   */
  readonly closureCondition: string;
}

/**
 * The backlog registry. Adding a key is a reviewed source change; removing one
 * while referenced surfaces as `dead` fleet-wide, which is the intended alarm.
 *
 * `owner` is prose for a human reader. It is deliberately NOT resolved at
 * runtime: resolving it would reintroduce the docs-do-not-ship defect above.
 */
export const BACKLOG_TRACKERS: Readonly<Record<string, BacklogTracker>> = {
  'decision-quality-enrolment': {
    key: 'decision-quality-enrolment',
    owner: 'docs/specs/llm-decision-quality-meter.md §5.6 (Census + enrolment backlog)',
    summary:
      'Decision points enumerated in the census but not yet wired to record ' +
      'provenance + outcomes. Each is retrofitted by enrolling its callsite ' +
      'through the annotate chokepoint; the census debt counters track the drain.',
    closureCondition:
      'Every census entry is `wired` or carries a closed-taxonomy exemption — ' +
      'i.e. NO entry carries this key. At that point the last reference is gone ' +
      'and this key is deleted from the registry in the same change.',
  },
};

/** Is this backlog key live? Pure lookup over a shipped constant. */
export function backlogTrackerExists(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(BACKLOG_TRACKERS, key);
}

/**
 * A decision point's provenance posture. A `pending:<ref>` ref is
 * format-validated and baseline-pinned by the ratchet, and carries one of two
 * KINDS: `ACT-<n>` (a machine-local work item — legitimately local, resolved
 * against the local queue with high-water adjudication) or
 * `backlog:<key>` (fleet-stable, resolved against BACKLOG_TRACKERS above).
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

/** Verified operator message → durable goal-priority classification. */
export const DP_GOAL_PRIORITY_EXTRACT = 'goal-priority-extract';

/** Durable goal digest + current run focus → dry-run alignment verdict. */
export const DP_ALIGNMENT_REVIEW = 'alignment-review';

/** The stop-justified authority (src/core/UnjustifiedStopGate.ts). */
export const DP_UNJUSTIFIED_STOP_GATE = 'unjustified-stop-gate';

/** Topic-intent extraction from a conversational turn (src/core/TopicIntentExtractor.ts). */
export const DP_TOPIC_INTENT_EXTRACT = 'topic-intent-extract';

/** Committed source/directory node → bounded Cartographer code-map summary. */
export const DP_CARTOGRAPHER_SUMMARY_AUTHOR = 'cartographer-summary-author';

/** Project spec + referenced committed files → drift signal. */
export const DP_PROJECT_DRIFT_CHECK = 'project-drift-check';

/** Untagged inbound message + topic history → coherence warning signal. */
export const DP_INPUT_GUARD = 'input-guard';

/** Ambiguous inbound user message → interrupt category. */
export const DP_MESSAGE_SENTINEL_CLASSIFY = 'message-sentinel-classify';

/** Inbound message + bounded conversation → machine relocation intent. */
export const DP_MOVE_INTENT_CLASSIFY = 'move-intent-classify';

/** Hub message + bounded conversation/topic enum → bind intent. */
export const DP_HUB_INTENT_CLASSIFY = 'hub-intent-classify';

/** Inbound message + bounded conversation/profile enums → topic profile intent. */
export const DP_PROFILE_INTENT_CLASSIFY = 'profile-intent-classify';

/** Ambiguous interactive terminal prompt → approve or relay. */
export const DP_INPUT_CLASSIFY = 'input-classify';

/** Bounded active-session terminal slice → structured routing summary. */
export const DP_SESSION_SUMMARY_EXTRACT = 'session-summary-extract';

/** Slack fallback stall/promise evidence → send or suppress alert. */
export const DP_SLACK_STALL_CONFIRM = 'slack-stall-confirm';

/** Telegram fallback stall/promise evidence → send or suppress alert. */
export const DP_TELEGRAM_STALL_CONFIRM = 'telegram-stall-confirm';

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
  {
    decisionPoint: DP_GOAL_PRIORITY_EXTRACT,
    component: 'GoalPriorityExtractor',
    status: 'wired',
    volumeClass: 'budget:250',
    contentClass: 'content-bearing',
    reason:
      'Verified operator messages are classified into a durable priority ledger; provenance stores only message identity, bounds, and content hashes.',
    gradingPosture: 'measurement-only',
    gradingReason:
      'Phase 1 records extraction decisions for soak analysis; authoritative outcome rules require later operator-confirmed longitudinal labels.',
  },
  {
    decisionPoint: DP_ALIGNMENT_REVIEW,
    component: 'AlignmentReviewer',
    status: 'wired',
    volumeClass: 'budget:250',
    contentClass: 'content-bearing',
    reason:
      'The dry-run reviewer compares a bounded priority digest with current run focus; provenance stores only evidence-packet identity and bounds.',
    gradingPosture: 'measurement-only',
    gradingReason:
      'Phase 1 is signal-only and has no actuation outcome; verdict quality is collected for later benchmark and operator-label calibration.',
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
    decisionPoint: DP_INPUT_GUARD,
    component: 'InputGuard',
    status: 'wired',
    volumeClass: 'budget:500',
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'The warn-only review has no correlation-preserving downstream label for whether an untagged message ' +
      'was genuinely coherent or suspicious. Identity-only rows are collected now so later authenticated ' +
      'review or recurrence evidence can grade real cases without archiving inbound text.',
    reason:
      'Input-coherence verdict over an inbound prompt and recent topic context; provenance stores only bounded identities and shape.',
  },
  {
    decisionPoint: 'session-activity-digest',
    component: 'SessionActivitySentinel',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Activity digest authored over session tmux output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'stall-triage-diagnosis',
    component: 'StallTriageNurse',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Stall-triage diagnosis over session output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'commitment-detect',
    component: 'CommitmentSentinel',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Commitment detection over conversation text; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'presence-stall-judge',
    component: 'PresenceProxy',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Tier-3 stall judgment over session output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: DP_MESSAGE_SENTINEL_CLASSIFY,
    component: 'MessageSentinel',
    status: 'wired',
    volumeClass: 'budget:500',
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'The sentinel can enact pause, redirect, or emergency-stop behavior, but those actions do not currently ' +
      'carry the router correlation needed to distinguish a correct interruption from a false positive. ' +
      'Identity-only rows are collected now for later authenticated review and outcome joining.',
    reason:
      'Latency-critical pause, emergency, redirect, or normal classification over an inbound user message; provenance retains message identity and shape only.',
  },
  {
    decisionPoint: DP_PROJECT_DRIFT_CHECK,
    component: 'ProjectDriftChecker',
    status: 'wired',
    volumeClass: 'budget:100',
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'The checker verifies citation shape and reports a bounded signal, but no registered outcome rule yet ' +
      'establishes whether the historical semantic drift verdict was correct. Recording identity-only cases ' +
      'now supports later independent or operator-reviewed grading without retaining source bodies.',
    reason:
      'Project-spec premise drift judgment over bounded repository files; provenance retains only project, path, digest, and input-shape identity.',
  },
  {
    decisionPoint: 'temporal-coherence-check',
    component: 'TemporalCoherenceChecker',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Temporal-coherence verdict over conversation content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'watchdog-stuck-judge',
    component: 'SessionWatchdog',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Stuck-session judgment over live session output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'resume-sanity-check',
    component: 'ResumeQueueDrainer',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Resume-sanity verdict before a queued mid-work revival; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'topic-intent-arc-check',
    component: 'TopicIntentArcCheck',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Arc-check classification of a topic intent over conversation; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: DP_SLACK_STALL_CONFIRM,
    component: 'SlackAdapter',
    status: 'wired',
    volumeClass: 'budget:100',
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'The response parser proves only that the model said yes or no; it does not independently establish ' +
      'whether sending or suppressing the alert was correct. Identity-only provenance permits later comparison ' +
      'with session recovery and operator feedback without inventing a label today.',
    reason:
      'Slack fallback alert confirmation over session state and agent-authored context; identity-only context stores digests and scalar facts, never message text.',
  },

  // — Gates —
  {
    decisionPoint: 'prompt-injection-detect',
    component: 'PromptGate',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Prompt-injection detection over inbound content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'external-operation-gate',
    component: 'ExternalOperationGate',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Operation mutability/reversibility classification incl. in-content approval claims; enrollment queued in the ACT-1193 retrofit backlog.',
  },
  {
    decisionPoint: 'warrants-reply-gate',
    component: 'WarrantsReplyGate',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Should-I-reply verdict over an inbound message; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: DP_UNJUSTIFIED_STOP_GATE,
    component: 'UnjustifiedStopGate',
    status: 'wired',
    // The highest-volume UNENROLLED decision point in the census: ~1343 calls
    // in the last 7 days (GET /metrics/features), second only to the tone gate
    // among gates. A per-UTC-day COUNT budget rather than `full`: this fires on
    // every stop attempt across every session, and an always-on gate must not
    // grow the provenance archive without a hard ceiling. The ~250-byte
    // decision_quality row is written for every settlement regardless, so the
    // COUNTS stay complete even when the archive is valved.
    volumeClass: 'budget:300',
    // Content-bearing: the gate judges a session's stop rationale. It enters the
    // row as IDENTITY ONLY — hashes, bounds, and code-derived features — never
    // the rationale text or any transcript slice.
    contentClass: 'content-bearing',
    // ── Grading posture ──────────────────────────────────────────────────
    // MEASUREMENT-ONLY, declared rather than left as a silent gap.
    gradingPosture: 'measurement-only',
    gradingReason:
      'No honest outcome rule exists YET. Grading "was this stop justified?" needs a ' +
      'downstream fact — did the run resume and do real work after the gate allowed a ' +
      'stop, or did the agent genuinely have nothing left after the gate held one? Those ' +
      'signals exist (the resume queue, the autonomous liveness reconciler) but joining ' +
      'them to a decision row is real plumbing, not a predicate. Enrolling the DECISION ' +
      'side first is deliberate and is what this posture is for: the rows accumulate now, ' +
      'so when the outcome join lands there is history to grade instead of a cold start. ' +
      'Recording without grading is stated here so the census shows it rather than ' +
      'implying this point is measured when only half of it is.',
    reason:
      'The stop-justified authority — the highest-volume unenrolled point in the census.',
  },
  {
    decisionPoint: 'coherence-review',
    component: 'CoherenceReviewer',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Outbound coherence review — THE measured high-volume point (3,641 of 4,098 llm calls/24h on the dev agent, spec §5.6); MUST declare sampled:<rate> or budget:<rows/day> at enrollment, never full.',
  },
  {
    decisionPoint: DP_MOVE_INTENT_CLASSIFY,
    component: 'MoveIntentClassifier',
    status: 'wired',
    volumeClass: 'budget:250',
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'A transfer or pin may succeed even when the classifier misunderstood the user, while pass-through has no ' +
      'independent correctness label. Until downstream command disposition and authenticated review carry this ' +
      'correlation, identity-only cases are recorded for later grading.',
    reason:
      'Move or pin command-versus-discussion intent over an inbound message and bounded conversation context; provenance stores identity and shape only.',
  },
  {
    decisionPoint: DP_HUB_INTENT_CLASSIFY,
    component: 'HubIntentClassifier',
    status: 'wired',
    volumeClass: 'budget:250',
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'A successful bind does not prove the message was correctly interpreted, and a pass-through produces no ' +
      'independent label. Until the consumed-message path preserves quality correlation and authenticated review, ' +
      'identity-only rows are collected for later grading.',
    reason:
      'Hub open or tie intent over an inbound message, bounded conversation, and bindable-topic enum; provenance stores identity and shape only.',
  },
  {
    decisionPoint: DP_PROFILE_INTENT_CLASSIFY,
    component: 'ProfileIntentClassifier',
    status: 'wired',
    volumeClass: 'budget:250',
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'A profile write applying successfully proves enum validity, not that the user intended the change, while ' +
      'pass-through has no independent label. Identity-only cases are collected until profile-write disposition ' +
      'and authenticated correction evidence carry this correlation.',
    reason:
      'Topic framework, model, or thinking-mode intent over an inbound message, bounded context, and allowed enums; provenance stores identity and shape only.',
  },
  {
    decisionPoint: 'llm-sanitize',
    component: 'LLMSanitizer',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Sanitize verdict over untrusted inbound content (definitionally injection-exposed); enrollment queued in the ACT-1193 retrofit backlog.',
  },
  {
    decisionPoint: 'override-detect',
    component: 'OverrideDetector',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Override-intent detection over a user turn (uxConfirm pre-routing); enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'task-classify',
    component: 'TaskClassifier',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Task-type classification over a user task description; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },

  // — Reflectors —
  {
    decisionPoint: 'job-reflect',
    component: 'JobReflector',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Job-outcome reflection over job output/transcript; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'cross-model-review',
    component: 'crossModelReviewer',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Cross-model spec-document review over file content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'self-knowledge-extract',
    component: 'SelfKnowledgeTree',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Self-knowledge extraction over transcripts; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'tree-triage',
    component: 'TreeTriage',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Knowledge-tree fragment triage over stored content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'topic-summarize',
    component: 'TopicSummarizer',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Topic summary authoring over conversation content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'contextual-evaluate',
    component: 'ContextualEvaluator',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Context-relevance evaluation over conversation/session content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'relationship-extract',
    component: 'RelationshipManager',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Relationship-fact extraction from conversation (PII-adjacent content); enrollment queued in the ACT-1193 retrofit backlog.',
  },
  {
    decisionPoint: 'standards-conformance-review',
    component: 'StandardsConformanceReviewer',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Artifact-vs-standard conformance review over file content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'discovery-evaluate',
    component: 'DiscoveryEvaluator',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Serendipity-discovery evaluation over subagent output; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'dashboard-insight',
    component: 'DashboardInsightEngine',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Awareness-only page-data insight authoring (degrades to a deterministic floor); enrollment queued in the ACT-1193 retrofit backlog.',
  },

  // — Jobs —
  {
    decisionPoint: 'pipe-session-spawn',
    component: 'PipeSessionSpawner',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Session authoring from (possibly user-authored) task descriptions; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: DP_CARTOGRAPHER_SUMMARY_AUTHOR,
    component: 'CartographerSweep',
    status: 'wired',
    volumeClass: 'budget:500',
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'The deterministic symbol-presence and output-shape checks measure whether a summary was safe to persist, ' +
      'but they do not establish semantic correctness. Provenance is collected now so later independent or ' +
      'operator-reviewed labels can grade real committed-source summaries without a cold start.',
    reason:
      'Doc-tree summary authoring over untrusted committed code; identity-only context records node and input shape, never source or child-summary bodies.',
  },
  {
    decisionPoint: 'standards-coverage-enrich',
    component: 'StandardsCoverageEnrichment',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Standards-coverage row enrichment over repo content (dark LLM path); enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },

  // — Previously-uncategorized callsites (LLM Routing Registry audit set) —
  {
    decisionPoint: DP_INPUT_CLASSIFY,
    component: 'InputClassifier',
    status: 'wired',
    volumeClass: 'budget:500',
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'The deterministic parser establishes whether the model emitted APPROVE or RELAY, but no independent ' +
      'safety label or downstream operator disposition is correlated yet. Identity-only provenance banks real ' +
      'ambiguous prompts for later grading without treating parser acceptance as correctness.',
    reason:
      'Auto-approve vs relay classification of ambiguous inbound terminal prompts; identity-only context stores prompt and constituent digests, never prompt text.',
  },
  {
    decisionPoint: DP_SESSION_SUMMARY_EXTRACT,
    component: 'SessionSummarySentinel',
    status: 'wired',
    volumeClass: 'budget:500',
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'JSON shape validation and routing use do not independently establish that the authored task, phase, ' +
      'files, topics, and blockers are semantically faithful. Provenance is collected now so later misroute or ' +
      'operator-reviewed labels can grade real summaries without a cold start.',
    reason:
      'Task/phase/files extraction over bounded tmux output; identity-only context stores exact visible-slice digests and bounds, never terminal text.',
  },
  {
    decisionPoint: DP_TELEGRAM_STALL_CONFIRM,
    component: 'TelegramAdapter',
    status: 'wired',
    volumeClass: 'budget:100',
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'The response parser proves only that the model said yes or no; it does not independently establish ' +
      'whether sending or suppressing the alert was correct. Identity-only provenance permits later comparison ' +
      'with session recovery and operator feedback without inventing a label today.',
    reason:
      'Telegram fallback alert confirmation over session state and agent-authored context; identity-only context stores digests and scalar facts, never message text.',
  },
  {
    decisionPoint: 'resume-uuid-validate',
    component: 'ResumeValidator',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Resume-UUID-vs-topic match verdict over session/resume state; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'usher-topic-route',
    component: 'Usher',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Per-turn topic routing over an inbound user turn; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: DP_TOPIC_INTENT_EXTRACT,
    component: 'TopicIntentExtractor',
    status: 'wired',
    // ~733 calls/7d (GET /metrics/features) — the highest-volume unenrolled
    // point remaining after the stop gate. It fires on conversational turns, so
    // a per-UTC-day COUNT budget rather than `full`: the decision_quality row is
    // written for every settlement regardless, so counts stay complete while the
    // provenance archive is capped.
    volumeClass: 'budget:200',
    // Content-bearing: the extractor reads a user TURN and a rolling
    // conversational summary — both untrusted, both quotable. Entered as
    // IDENTITY ONLY (hashes, counts, code-derived booleans); never the message
    // text, never the summary.
    contentClass: 'content-bearing',
    gradingPosture: 'measurement-only',
    gradingReason:
      'No outcome rule exists YET. Grading an extraction needs a downstream fact — ' +
      'was the proposed signal later affirmed, contradicted, or silently dropped by ' +
      'the arc it was attached to? Those transitions exist in the intent store but ' +
      'joining them to a decision row is real plumbing, not a predicate. Enrolling ' +
      'the DECISION side first is deliberate and is what this posture is for: rows ' +
      'accumulate now so the grader has history when it lands. Declared rather than ' +
      'left implicit so the census shows recorded-not-graded instead of implying ' +
      'this point is measured when only half of it is.',
    reason:
      'Topic-intent extraction from a conversational turn — the highest-volume unenrolled point after the stop gate.',
  },
  {
    decisionPoint: 'pre-compaction-flush',
    component: 'PreCompactionFlush',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Durable-fact extraction over a transcript before compaction; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'tree-synthesize',
    component: 'TreeSynthesis',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Knowledge-fragment synthesis into an answer; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'llm-conflict-resolve',
    component: 'LLMConflictResolver',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Divergent multi-machine state resolution over untrusted peer data; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'open-conversation-brief',
    component: 'openConversationBrief',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'A2A conversation-brief authoring over peer content; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'a2a-checkin-summarize',
    component: 'a2a-checkin',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'A2A check-in thread summarization over peer-authored threads; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'correction-distill',
    component: 'correction-learning',
    status: 'pending:backlog:decision-quality-enrolment',
    contentClass: 'content-bearing',
    reason:
      'Recurring-correction distillation into a durable preference; enrollment queued in the ACT-1193 uniform-provenance retrofit backlog.',
  },
  {
    decisionPoint: 'mentor-stage-b-classify',
    component: 'mentor-stage-b',
    status: 'pending:backlog:decision-quality-enrolment',
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
  // ── Tone-gate agent-reaction evidence (advisory migration, 2026-07-19) ────
  // The tone gate's FIRST real evidence source. Before the advisory migration a
  // BLOCK was terminal, so the agent's disagreement could not exist as data and
  // every tone decision could only ever grade `unknown` at window close. An
  // overridable nudge makes the reaction observable: the agent either delivers
  // unchanged (disputing the verdict) or revises (accepting it).
  //
  // Rung `self-report` ON PURPOSE (§5.4.3): the agent is an interested party
  // grading a judgment about its own message. Precedence guarantees this can
  // never outrank an independent grader, and the read surface segregates it from
  // proof-like evidence — so "the gate was wrong 40% of the time" is always
  // legible as *the agent said so*, not as measured truth.
  'tone-agent-override-v1': {
    ruleId: 'tone-agent-override-v1', decisionPoint: DP_MESSAGING_TONE_GATE,
    rung: 'self-report', evidenceStrength: 'self-report',
    owningComponent: 'ToneGateAdvisory',
  },
  'tone-agent-complied-v1': {
    ruleId: 'tone-agent-complied-v1', decisionPoint: DP_MESSAGING_TONE_GATE,
    rung: 'self-report', evidenceStrength: 'self-report',
    owningComponent: 'ToneGateAdvisory',
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
