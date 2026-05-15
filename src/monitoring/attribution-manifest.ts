/**
 * Static attribution manifest for the burn-detection-and-self-heal system.
 *
 * Phase 2 of docs/specs/token-burn-detection-and-self-heal.md. Maps known
 * instar-internal LLM call patterns to stable component names so the
 * BurnDetector (Phase 3) can group calls of the same shape.
 *
 * Adding entries does not require a spec change — they are inference rules
 * for an observation system, not authority. The manifest is a hint store,
 * not a gate.
 *
 * Pattern semantics (per docs/specs/token-burn-detection-and-self-heal.md
 * §"Attribution key", §"Capture surface"):
 *   - `promptPatterns`: regex on the user prompt that prompted the
 *     assistant response. First-match wins. Order matters — list more
 *     specific patterns first.
 *   - `cwdPatterns`: optional regex on the `cwd` field of the JSONL line.
 *     Useful when a component is recognisable by its working directory
 *     but its prompt varies.
 *   - `modelHints`: optional list of model substrings; narrows the match
 *     when the same prompt could come from multiple components but only
 *     one of them uses a specific model.
 */

export interface AttributionPattern {
  /** Stable component name written into attribution_key. */
  component: string;
  /** Regex matched against the user prompt. */
  promptPatterns?: RegExp[];
  /** Regex matched against the cwd / projectPath field. */
  cwdPatterns?: RegExp[];
  /** Substrings narrowing the match to specific models. */
  modelHints?: string[];
}

/**
 * The manifest. Order is significant — first-match wins. Add more specific
 * entries before broader ones.
 */
export const ATTRIBUTION_MANIFEST: AttributionPattern[] = [
  // The 2026-05-15 bleed: the InputDetector's NO_PROMPT classifier asked
  // the LLM "is this stuck?" every 5s on every idle session, burning
  // ~3B tokens/day. This pattern catches that exact prompt shape.
  {
    component: 'InputDetector',
    promptPatterns: [/analyzing terminal output/i, /is this stuck/i, /stalled session detection/i],
  },
  // MessagingToneGate evaluates outbound user-facing messages for tone +
  // banned-content compliance (ELI16, no inline code, etc).
  {
    component: 'MessagingToneGate',
    promptPatterns: [/evaluate this outbound message/i, /tone gate/i, /eli16/i],
  },
  // CommitmentSentinel watches for commitments the agent made that lack
  // follow-through.
  {
    component: 'CommitmentSentinel',
    promptPatterns: [/commitment.*follow.through/i, /unfulfilled commitment/i],
  },
  // MessageSentinel classifies inbound messages (emergency stop, etc).
  {
    component: 'MessageSentinel',
    promptPatterns: [/classify.*inbound message/i, /emergency stop classifier/i],
  },
  // StallTriageNurse — the LLM-powered session-recovery classifier.
  {
    component: 'StallTriageNurse',
    promptPatterns: [/triage.*stalled session/i, /session.*stall.*classifier/i],
  },
  // CoherenceReviewer — the deeper "is this agent acting coherently"
  // check, invoked by the coherence-gate path.
  {
    component: 'CoherenceReviewer',
    promptPatterns: [/coherence review/i, /agent coherence/i],
  },
  // ProjectDriftChecker — round-start signal that the project context
  // has drifted from what was loaded.
  {
    component: 'ProjectDriftChecker',
    promptPatterns: [/project drift/i, /context drift detection/i],
  },
  // ResumeValidator — verifies a Claude Code resume payload before
  // letting a session pick back up.
  {
    component: 'ResumeValidator',
    promptPatterns: [/validate.*resume payload/i, /resume validation/i],
  },
  // TopicLinkageHandler — figures out which existing thread a new
  // Telegram message belongs to.
  {
    component: 'TopicLinkageHandler',
    promptPatterns: [/topic linkage/i, /thread linking/i],
  },
];
