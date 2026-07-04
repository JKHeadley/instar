/**
 * Component → category registry for per-component framework routing
 * (docs/specs/per-component-framework-routing.md, D1/D2).
 *
 * Framework routing keys on a component's CATEGORY (so an operator can say "all
 * sentinels on Codex" in one line) with a per-component override. The component
 * NAME is the `attribution.component` string each LLM caller already passes at
 * the funnel; this module maps those names to a category so the router does NOT
 * need every call site to also pass a category (Structure > Willpower — one
 * central registry, not 38 edited call sites). A caller MAY still pass an
 * explicit `attribution.category` to override the registry for an ad-hoc label.
 *
 * IMPORTANT: this registry is the single source of truth for what counts as a
 * "sentinel" vs "gate" vs "reflector". When you add a new LLM-backed component,
 * add its `attribution.component` name here so framework routing can see it.
 * Anything not listed resolves to 'other' (and thus the `default` framework) —
 * which is the safe, behavior-preserving fallback.
 */

export type ComponentCategory = 'sentinel' | 'gate' | 'job' | 'reflector' | 'other';

export const COMPONENT_CATEGORIES: ReadonlyArray<ComponentCategory> = [
  'sentinel', 'gate', 'job', 'reflector', 'other',
];

export function isComponentCategory(v: unknown): v is ComponentCategory {
  return typeof v === 'string' && (COMPONENT_CATEGORIES as readonly string[]).includes(v);
}

/**
 * Known component-name → category map. Names match the `attribution.component`
 * label set at each LLM call site (the funnel reads `options.attribution.component`).
 * Some call sites suffix the label (e.g. "CompletionEvaluator/P13") — resolution
 * strips a trailing "/segment" before lookup (see categoryForComponent).
 */
export const COMPONENT_CATEGORY: Readonly<Record<string, ComponentCategory>> = {
  // ── Sentinels (background watchers that make small judgment calls) ──
  InputDetector: 'sentinel',
  InputGuard: 'sentinel',
  SessionActivitySentinel: 'sentinel',
  StallTriageNurse: 'sentinel',
  CommitmentSentinel: 'sentinel',
  PresenceProxy: 'sentinel',
  PromiseBeacon: 'sentinel',
  ExternalHogClassifier: 'sentinel',
  MessageSentinel: 'sentinel',
  ProjectDriftChecker: 'sentinel',
  TemporalCoherenceChecker: 'sentinel',
  CompletionEvaluator: 'sentinel',
  SessionWatchdog: 'sentinel',
  // Tier-1 observe-only resume sanity check (reap-notify spec P7) — runs on
  // the shared LlmQueue background lane before a queued mid-work resume.
  ResumeQueueDrainer: 'sentinel',
  TopicIntentArcCheck: 'sentinel',
  // Canary-completion judge inside the anthropic-interactive-pool adapter
  // (token-audit-completeness baseline-zero pass).
  InteractivePoolCanaryJudge: 'sentinel',
  // Slack stuck/quiet-session alert suppression judge (same pass).
  SlackAdapter: 'sentinel',

  // ── Gates (pre-action allow/deny advisories) ──
  PromptGate: 'gate',
  AutoApprover: 'gate',
  IntegrationGate: 'gate',
  ExternalOperationGate: 'gate',
  WarrantsReplyGate: 'gate',
  UnjustifiedStopGate: 'gate',
  CoherenceGate: 'gate',
  MessagingToneGate: 'gate',
  CoherenceReviewer: 'gate',
  // Move-intent recognizer — infers "move/run/pin this on <nickname>?" over the
  // message + recent conversation, replacing the keyword verb-list that hijacked
  // discussion (docs/specs/nickname-move-intent-llm-rebuild.md). It gates whether
  // the inbound message is a relocation command vs passed through to the agent.
  MoveIntentClassifier: 'gate',
  // Hub-intent recognizer — infers "open this"/"tie this to <topic>?" over the
  // message + recent conversation, replacing the anchored regexes that swallowed
  // the message before the agent saw it (docs/specs/keyword-intent-conversions-1-and-3.md,
  // Conversion #3). It gates whether an inbound hub message is a bind command vs
  // passed through to the agent.
  HubIntentClassifier: 'gate',
  // Profile-intent recognizer — infers "change this topic's framework/model/thinking?"
  // over the message + recent conversation, replacing the keyword regexes removed from
  // parseProfileTrigger (docs/specs/keyword-intent-conversions-1-and-3.md). It gates
  // whether the inbound message actuates a topic-profile write vs passing to the agent.
  ProfileIntentClassifier: 'gate',
  // Inbound-content sanitizer (token-audit-completeness baseline-zero pass).
  LLMSanitizer: 'gate',
  // uxConfirm pre-routing judgment calls (same pass).
  OverrideDetector: 'gate',
  TaskClassifier: 'gate',

  // ── Reflectors / reviewers (deeper after-the-fact analysis) ──
  JobReflector: 'reflector',
  crossModelReviewer: 'reflector',
  SelfKnowledgeTree: 'reflector',
  TreeTriage: 'reflector',
  TopicSummarizer: 'reflector',
  ContextualEvaluator: 'reflector',
  RelationshipManager: 'reflector',
  StandardsConformanceReviewer: 'reflector',
  DiscoveryEvaluator: 'reflector',

  // ── Jobs (scheduled work) ──
  PipeSessionSpawner: 'job',
  // The doc-freshness sweep author (spec #2). Category 'job' so an operator can
  // route it OFF Claude via sessions.componentFrameworks.categories.job — the
  // background summary authoring then never spends Anthropic quota. The runtime
  // routing probe (CartographerSweepEngine.probeRouting) enforces off-Claude;
  // this registration guards the categoryForComponent path so a missing entry
  // fails the wiring test rather than silently routing to the default framework.
  CartographerSweep: 'job',
  // The OPTIONAL dark LLM-enrichment path of the standards enforcement-coverage
  // audit (cartographer-conformance-audit spec #3). Category 'job' so an operator
  // can route it OFF Claude via sessions.componentFrameworks.categories.job — the
  // enrichment then never spends Anthropic quota. Only used by the dark
  // llmEnrichment path; the shipped deterministic auditor makes no LLM calls.
  StandardsCoverageEnrichment: 'job',

  // ── Previously-uncategorized LLM callsites (LLM Routing Registry audit,
  //    2026-07-01). Each calls an intelligence provider's .evaluate() but was
  //    absent from this map AND passes no explicit attribution.category, so it
  //    resolved to 'other' → the agent default framework (Claude) — silently
  //    spending Anthropic quota instead of routing off-Claude like its peers.
  //    Categorized by function (sentinel = background judgment call, gate =
  //    pre-action allow/deny, reflector = extraction/summarization/analysis).
  //    The drift-guard test (componentCategories-evaluate-coverage.test.ts)
  //    keeps this map exhaustive over .evaluate() callsites going forward. ──
  InputClassifier: 'sentinel',           // input auto-approve vs relay classification
  SessionSummarySentinel: 'sentinel',    // summarize tmux output → task/phase/files
  TelegramAdapter: 'sentinel',           // stall/idle alert-suppression judge (parity with SlackAdapter)
  ResumeValidator: 'gate',               // does a resume UUID match the topic? (pre-resume gate)
  Usher: 'reflector',                    // route a turn to candidate topics
  TopicIntentExtractor: 'reflector',     // extract topic intent from a turn
  PreCompactionFlush: 'reflector',       // extract durable facts before compaction
  TreeSynthesis: 'reflector',            // synthesize knowledge fragments → answer
  LLMConflictResolver: 'reflector',      // resolve divergent multi-machine state
  openConversationBrief: 'reflector',    // generate an A2A conversation brief
  'a2a-checkin': 'reflector',            // summarize A2A check-in threads (server:a2a-checkin)
  'correction-learning': 'reflector',    // distill recurring corrections → preference (server:correction-learning)
  'mentor-stage-b': 'reflector',         // classify mentor signals → forensic findings
};

/**
 * Resolve a component's category. Strips a trailing "/segment" call-site suffix
 * (e.g. "CompletionEvaluator/P13" → "CompletionEvaluator") and a leading
 * "server:" inline-closure prefix before lookup. Unknown → 'other'.
 */
export function categoryForComponent(component: string | undefined): ComponentCategory {
  if (!component) return 'other';
  const base = component.split('/')[0].replace(/^server:/, '').trim();
  return COMPONENT_CATEGORY[base] ?? 'other';
}

/** The known component names (registry keys) — drives the GET /intelligence/routing surface. */
export function knownComponents(): string[] {
  return Object.keys(COMPONENT_CATEGORY).sort();
}
