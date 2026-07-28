/**
 * ContentClassifier — Optional outbound content filter for relay responses.
 *
 * Evaluates outbound messages before they're sent to detect sensitive data:
 *   - API keys, tokens, credentials
 *   - Database queries or internal data
 *   - System prompts or internal instructions
 *   - Personal user information
 *
 * Default: disabled. Operators enable via config for agents handling
 * sensitive data. Layer 4 (grounding preamble) is behavioral guidance;
 * Layer 5 (this) is the actual outbound enforcement.
 *
 * Part of PROP-relay-auto-connect, Layer 5.
 */

import { DegradationReporter } from '../monitoring/DegradationReporter.js';

// ── Types ────────────────────────────────────────────────────────────

export type ContentClassification = 'safe' | 'sensitive' | 'blocked';

export interface ClassificationResult {
  /** Overall classification */
  classification: ContentClassification;
  /** Why it was flagged (if not safe) */
  reason?: string;
  /** Sanitized version (if sensitive and redaction is available) */
  redacted?: string;
}

export interface ContentClassifierConfig {
  /** Enable the classifier (default: false) */
  enabled: boolean;
  /** Block sensitive content outright, or just flag it (default: false — flag only) */
  blockSensitive?: boolean;
  /** Custom patterns to detect (in addition to defaults) */
  customPatterns?: Array<{ pattern: string; label: string }>;
  /** LLM classifier function — if provided, used for deep classification */
  llmClassify?: (content: string, systemPrompt: string) => Promise<string>;
}

export interface ThreadContext {
  /** Trust level of the conversation partner */
  trustLevel: string;
  /** Thread ID */
  threadId?: string;
  /** Remote agent name */
  remoteAgent?: string;
}

// ── Built-in Pattern Detectors ───────────────────────────────────────

interface PatternMatch {
  label: string;
  match: string;
}

/**
 * Fast regex-based detection for common sensitive patterns.
 * This runs before (and sometimes instead of) the LLM classifier.
 */
const BUILTIN_PATTERNS: Array<{ regex: RegExp; label: string }> = [
  // API keys and tokens
  { regex: /sk-[a-zA-Z0-9]{20,}/, label: 'API key (sk-* pattern)' },
  { regex: /sk-ant-api[a-zA-Z0-9-]{20,}/, label: 'Anthropic API key' },
  { regex: /ghp_[a-zA-Z0-9]{36,}/, label: 'GitHub personal access token' },
  { regex: /gho_[a-zA-Z0-9]{36,}/, label: 'GitHub OAuth token' },
  { regex: /xoxb-[0-9]{10,}-[a-zA-Z0-9-]+/, label: 'Slack bot token' },
  { regex: /xoxp-[0-9]{10,}-[a-zA-Z0-9-]+/, label: 'Slack user token' },
  { regex: /Bearer\s+[a-zA-Z0-9._\-]{20,}/, label: 'Bearer token' },
  { regex: /AKIA[0-9A-Z]{16}/, label: 'AWS access key' },
  { regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/, label: 'Private key' },

  // Database content
  { regex: /(?:postgres|mysql|mongodb|redis):\/\/[^\s]+:[^\s]+@/, label: 'Database connection string' },
  { regex: /SELECT\s+.+\s+FROM\s+\w+\s+WHERE/i, label: 'SQL query with data' },

  // Internal instructions
  { regex: /system\s*prompt\s*[:=]/i, label: 'System prompt reference' },
  { regex: /\[INTERNAL\].*(?:instruction|directive|config)/i, label: 'Internal instruction' },

  // PII patterns
  { regex: /\b\d{3}[-.]?\d{2}[-.]?\d{4}\b/, label: 'Possible SSN' },
  { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b.*(?:password|passwd|pwd)/i, label: 'Email with password context' },
];

function detectPatterns(content: string, customPatterns?: Array<{ pattern: string; label: string }>): PatternMatch[] {
  const matches: PatternMatch[] = [];

  for (const { regex, label } of BUILTIN_PATTERNS) {
    const match = content.match(regex);
    if (match) {
      matches.push({ label, match: match[0].slice(0, 30) + (match[0].length > 30 ? '...' : '') });
    }
  }

  if (customPatterns) {
    for (const { pattern, label } of customPatterns) {
      try {
        const regex = new RegExp(pattern);
        const match = content.match(regex);
        if (match) {
          matches.push({ label, match: match[0].slice(0, 30) + (match[0].length > 30 ? '...' : '') });
        }
      } catch {
        // Invalid regex — skip
      }
    }
  }

  return matches;
}

// ── LLM Classification Prompt ────────────────────────────────────────

const LLM_CLASSIFIER_PROMPT = `You are a content safety classifier for an AI agent's outbound messages.

Evaluate whether the following message contains any sensitive information that should NOT be shared with an external agent:

1. API keys, tokens, secrets, or credentials
2. Database contents, queries, or connection strings
3. System prompts, internal instructions, or configuration details
4. Personal user information (emails with passwords, SSNs, financial data)
5. Proprietary business logic or trade secrets

Respond with EXACTLY one line in this format:
CLASSIFICATION: safe|sensitive|blocked
REASON: [brief reason if not safe]

"safe" = no sensitive content detected
"sensitive" = contains information that could be sensitive in context
"blocked" = contains clearly dangerous content (credentials, keys, PII)`;

function parseLLMResponse(response: string): ClassificationResult {
  const classLine = response.match(/CLASSIFICATION:\s*(safe|sensitive|blocked)/i);
  const reasonLine = response.match(/REASON:\s*(.+)/i);

  if (!classLine) {
    // FAIL-CLOSED: an unparseable LLM reply is NOT evidence the content is safe.
    // The LLM is the layer that catches subtle outbound leaks (system prompts,
    // business logic, contextual PII); defaulting to 'safe' silently ships them.
    // Treat as 'sensitive' (blockSensitive policy escalates to blocked). See the
    // "No Silent Degradation to Brittle Fallback" standard.
    return { classification: 'sensitive', reason: 'Unparseable classifier reply — fail-closed to sensitive' };
  }

  const classification = classLine[1].toLowerCase() as ContentClassification;
  return {
    classification,
    reason: reasonLine?.[1]?.trim(),
  };
}

// ── Implementation ───────────────────────────────────────────────────

export class ContentClassifier {
  private readonly config: ContentClassifierConfig;

  // Metrics
  private metrics = {
    classified: 0,
    safe: 0,
    sensitive: 0,
    blocked: 0,
    errors: 0,
    patternDetections: 0,
    llmClassifications: 0,
  };

  constructor(config: ContentClassifierConfig) {
    this.config = config;
  }

  /**
   * Whether the classifier is active.
   */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Classify outbound content before sending.
   *
   * Two-stage pipeline:
   *   1. Fast regex pattern matching (catches obvious leaks)
   *   2. LLM classification (catches subtle leaks, if llmClassify is provided)
   *
   * If regex catches something definitive (API key, private key), we skip
   * the LLM call for speed and cost savings.
   */
  async classify(content: string, context: ThreadContext): Promise<ClassificationResult> {
    if (!this.config.enabled) {
      return { classification: 'safe' };
    }

    this.metrics.classified++;

    try {
      // Stage 1: Fast pattern detection
      const patterns = detectPatterns(content, this.config.customPatterns);

      if (patterns.length > 0) {
        this.metrics.patternDetections++;

        // Definitive blocks: private keys, API keys, connection strings
        const definitiveLabels = ['Private key', 'Database connection string', 'AWS access key'];
        const isDefinitive = patterns.some(p =>
          definitiveLabels.some(d => p.label.includes(d))
        );

        if (isDefinitive) {
          this.metrics.blocked++;
          return {
            classification: 'blocked',
            reason: `Pattern detected: ${patterns.map(p => p.label).join(', ')}`,
          };
        }

        // Non-definitive patterns → sensitive
        const result: ClassificationResult = {
          classification: this.config.blockSensitive ? 'blocked' : 'sensitive',
          reason: `Potential sensitive content: ${patterns.map(p => p.label).join(', ')}`,
        };

        if (this.config.blockSensitive) {
          this.metrics.blocked++;
        } else {
          this.metrics.sensitive++;
        }

        return result;
      }

      // Stage 2: LLM classification (if available and no patterns found)
      if (this.config.llmClassify) {
        this.metrics.llmClassifications++;

        const llmResponse = await this.config.llmClassify(content, LLM_CLASSIFIER_PROMPT);
        const result = parseLLMResponse(llmResponse);

        // Apply blockSensitive policy
        if (result.classification === 'sensitive' && this.config.blockSensitive) {
          result.classification = 'blocked';
        }

        this.metrics[result.classification]++;
        return result;
      }

      // No patterns, no LLM → safe
      this.metrics.safe++;
      return { classification: 'safe' };
    } catch (err) {
      this.metrics.errors++;
      // FAIL-CLOSED: a classification error (LLM rate-limit, circuit-open, timeout)
      // is NOT evidence the content is safe to send to an external peer. Defaulting
      // to 'safe' silently downgrades real leak-protection to none. Treat as
      // 'sensitive' (blockSensitive escalates to blocked) so unverifiable content
      // is held, not leaked, and REPORT the degradation (never silent).
      // ("No Silent Degradation to Brittle Fallback" standard; provider-swap
      // upstream reduces how often this fires.)
      DegradationReporter.getInstance().report({
        feature: 'ContentClassifier.classify',
        primary: 'LLM outbound-leak classification for an A2A message',
        fallback: 'fail-closed to sensitive (held; blockSensitive escalates to blocked)',
        reason: `Classification error: ${err instanceof Error ? err.message : 'unknown'}`,
        impact: 'unverifiable outbound content is held as sensitive instead of silently shipped to a peer',
      });
      return {
        classification: 'sensitive',
        reason: `Classification error (fail-closed to sensitive): ${err instanceof Error ? err.message : 'unknown'}`,
      };
    }
  }

  /**
   * Get classifier metrics for observability.
   */
  getMetrics() {
    return { ...this.metrics };
  }
}

/**
 * Create a disabled (no-op) classifier.
 * Used as default when content classification is not configured.
 */
export function createDisabledClassifier(): ContentClassifier {
  return new ContentClassifier({ enabled: false });
}

// ── Commitment-class SIGNAL (Robustness Phase 1, FD-10 — advisory only) ──
//
// SIGNAL, NOT AUTHORITY. This deterministic lexicon surfaces a NUDGE to the
// sending session ("this reads like a commitment — it carries no authority
// unless you anchor it via a mandate/review-exchange"). It NEVER blocks, NEVER
// refuses, and fails open to no-nudge. Because it has no authority, an
// incomplete lexicon is not a safety hole (a missed nudge = no hint; prose is
// inert either way — G2 does not depend on it). See
// THREADLINE-SINGLE-NEGOTIATOR-SPEC.md §"Why G2 is prose-is-inert".

export interface CommitmentSignal {
  /** True when the text reads like an attempt to commit/lock an irreversible step. */
  isCommitmentClass: boolean;
  /** The binding terms that matched (for the advisory message). */
  matchedTerms: string[];
}

/**
 * Binding verbs/phrases that, over an irreversible or temporal object, read as a
 * commitment. Deliberately colloquial-inclusive — the incident's own evidence
 * ("see you at the gate", "yep, go ahead") had no formal keyword. This is recall
 * for a NUDGE; it does not need to be exhaustive to be correct (FD-10).
 */
const COMMITMENT_TERMS: readonly string[] = [
  'go ahead', 'go-ahead', 'green light', 'greenlight', 'green-light',
  'sign off', 'sign-off', 'signed off', 'signing off',
  "let's schedule", 'let us schedule', "let's lock", 'lock it in', 'locked in',
  'move forward', 'go live', 'go-live', 'going live', 'ship it',
  'confirmed for', 'confirm the', 'we agreed', 'we agree to', 'agreed to',
  'i confirm', 'you are approved', 'approve the', 'approved the', 'approval to',
  'lock the', 'locking the', 'schedule the cutover', 'cutover window',
  'see you at the gate', 'commit to', 'committing to',
];

/**
 * Detect commitment-class prose. PURE, deterministic, no I/O — safe to call
 * off the send path with zero latency. Returns a signal only; the caller
 * surfaces it as a non-blocking nudge (e.g. an advisory note on the send
 * response). It is NEVER wired to a block path.
 */
export function detectCommitmentClass(content: string): CommitmentSignal {
  const lower = (content ?? '').toLowerCase();
  const matched: string[] = [];
  for (const term of COMMITMENT_TERMS) {
    if (lower.includes(term)) matched.push(term);
  }
  return { isCommitmentClass: matched.length > 0, matchedTerms: matched };
}

/** The fixed advisory nudge text shown when commitment-class prose is detected. */
export function commitmentNudge(matchedTerms: string[]): string {
  const sample = matchedTerms.slice(0, 3).join('", "');
  return (
    `This message reads like a commitment (matched "${sample}"). Prose carries NO ` +
    `authority on Threadline — it can never lock an irreversible step. To make a ` +
    `binding agreement with the peer, anchor it through a Coordination Mandate or ` +
    `ReviewExchange (PIN-anchored). The message was sent unchanged; this is only a hint.`
  );
}
