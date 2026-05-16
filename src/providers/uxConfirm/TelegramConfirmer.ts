/**
 * TelegramConfirmer — the blocking suggest-and-confirm round-trip.
 *
 * Per `specs/provider-portability/10-suggest-and-confirm-ux.md`
 * §"Confirmation prompt shape" and §"Edge cases":
 *
 *   1. Send a structured prompt to the user's topic.
 *   2. Block on the next reply for up to `timeoutMs`.
 *   3. Parse the reply via shorthand (`ok` / `c` / `👍` / `no` / `once` /
 *      `/route reset`) then fall through to the `OverrideDetector` for
 *      free-text.
 *   4. On timeout, return `default-no-reply` so the UX layer auto-defaults
 *      to the catalog pick and emits the appropriate note.
 *
 * The confirmer abstracts over a thin `ConfirmationTransport` so it's
 * unit-testable without spinning up a real Telegram bot. Production
 * wiring composes a TelegramAdapter into a transport that delivers
 * `send` to a topic and resolves `awaitReply` from the inbound message
 * stream.
 */

import type { OverrideDetector, OverrideDetectResult } from './OverrideDetector.js';
import type { ConfidenceLevel } from './PreferenceStore.js';

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

export interface ConfirmationTransport {
  /** Send a single message to the user's channel topic. */
  send(opts: { topicId: string; text: string }): Promise<void>;
  /**
   * Wait for the next reply on the topic. Resolves with the reply text
   * or `null` if the timeout elapsed first. Implementations are
   * responsible for ignoring earlier-in-flight messages — the
   * confirmer's contract is "next message after we sent the prompt".
   */
  awaitReply(opts: { topicId: string; timeoutMs: number }): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export type ConfirmationReason =
  | 'new-pattern'
  | 'cost-shift'
  | 'low-confidence';

export interface ConfirmationPrompt {
  /** Topic to send to. */
  topicId: string;
  /** Short task description for the prompt header. */
  taskDescription: string;
  /** The taskPattern slug being keyed. */
  taskPattern: string;
  /** Proposed framework + model. */
  proposedFramework: string;
  proposedModel: string;
  /** Confidence the catalog reports for the proposed pick. */
  confidence: ConfidenceLevel;
  /** Why we're asking (drives the "Reason for asking" line). */
  reason: ConfirmationReason;
  /**
   * Optional human-readable detail amplifying the reason. For example,
   * the cost-shift trigger's underlying material-shift reason string.
   */
  reasonDetail?: string;
}

export type ConfirmationResult =
  | {
      kind: 'confirmed';
      /** Whether the pick should be cached (true) or used one-shot (false). */
      cache: boolean;
      /** The confirmed framework + model (same as proposed unless override applied). */
      framework: string;
      model: string;
    }
  | {
      kind: 'overridden';
      /** Override scope (this-task or this-pattern). */
      scope: 'this-task' | 'this-pattern';
      /** Override framework / model if the user named them. */
      framework?: string;
      model?: string;
    }
  | {
      kind: 'reset';
      /** User asked to clear the cached preference for this pattern. */
    }
  | {
      kind: 'default-no-reply';
      /** Reply timed out; UX layer auto-defaults to catalog pick. */
    };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TelegramConfirmerOptions {
  transport: ConfirmationTransport;
  overrideDetector: OverrideDetector;
  /** Reply timeout in ms. Default: 5 minutes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shorthand parsers (cheap, no LLM)
// ---------------------------------------------------------------------------

/**
 * Quick, deterministic checks for the documented shorthand replies. We
 * avoid the LLM for these because (a) they're unambiguous and (b) we
 * want zero-latency on the common case.
 *
 * These ARE string-matching, but they're authority-free: a missed
 * shorthand falls through to the LLM-backed override detector. Per
 * the signal-vs-authority rule, this is acceptable — the only thing
 * a missed shorthand costs is one LLM call.
 */
function isConfirmShorthand(reply: string): boolean {
  const cleaned = reply.trim().toLowerCase();
  if (cleaned === 'ok' || cleaned === 'c' || cleaned === 'yes' || cleaned === 'y' || cleaned === 'go') {
    return true;
  }
  // Thumbs-up emoji variants.
  if (/^👍|^\u{1F44D}/u.test(reply.trim())) return true;
  return false;
}

function isOneShotShorthand(reply: string): boolean {
  const cleaned = reply.trim().toLowerCase();
  return cleaned === 'one-shot' || cleaned === 'oneshot' || cleaned === 'once';
}

function isResetShorthand(reply: string): boolean {
  return /^\s*\/?route\s+reset\s*$/i.test(reply);
}

function isDeclineShorthand(reply: string): boolean {
  const cleaned = reply.trim().toLowerCase();
  return cleaned === 'no' || cleaned === 'n';
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

const REASON_TEXT: Record<ConfirmationReason, string> = {
  'new-pattern': 'new pattern, never seen this combination before',
  'cost-shift': 'cost / quota state changed materially since the cached pick',
  'low-confidence': 'catalog confidence is thin or recently downgraded for this pick',
};

export function formatConfirmationPrompt(prompt: ConfirmationPrompt): string {
  const reasonLine = prompt.reasonDetail
    ? `Reason for asking: ${REASON_TEXT[prompt.reason]} — ${prompt.reasonDetail}`
    : `Reason for asking: ${REASON_TEXT[prompt.reason]}`;

  return [
    `About to run this task with ${prompt.proposedFramework} + ${prompt.proposedModel}.`,
    '',
    `Task: ${prompt.taskDescription}`,
    `Pattern: ${prompt.taskPattern} (confidence: ${prompt.confidence})`,
    reasonLine,
    '',
    'Reply with:',
    '  ok / c / 👍       — go with this pick (cache for future)',
    '  no / try X        — pick X instead (free-text framework+model)',
    '  /route reset      — clear preferences for this pattern',
    '  one-shot / once   — use this pick but DON\'T cache',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class TelegramConfirmer {
  private readonly transport: ConfirmationTransport;
  private readonly overrideDetector: OverrideDetector;
  private readonly timeoutMs: number;

  constructor(options: TelegramConfirmerOptions) {
    this.transport = options.transport;
    this.overrideDetector = options.overrideDetector;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Send the confirmation prompt and block on the user's reply.
   */
  async confirm(prompt: ConfirmationPrompt): Promise<ConfirmationResult> {
    await this.transport.send({
      topicId: prompt.topicId,
      text: formatConfirmationPrompt(prompt),
    });

    const reply = await this.transport.awaitReply({
      topicId: prompt.topicId,
      timeoutMs: this.timeoutMs,
    });

    if (reply === null) {
      return { kind: 'default-no-reply' };
    }

    return this.parseReply(reply, prompt);
  }

  /**
   * Exposed for unit testing — parses a reply string given the prompt
   * context. Pure function; no transport interaction.
   */
  async parseReply(reply: string, prompt: ConfirmationPrompt): Promise<ConfirmationResult> {
    if (isConfirmShorthand(reply)) {
      return {
        kind: 'confirmed',
        cache: true,
        framework: prompt.proposedFramework,
        model: prompt.proposedModel,
      };
    }

    if (isOneShotShorthand(reply)) {
      return {
        kind: 'confirmed',
        cache: false,
        framework: prompt.proposedFramework,
        model: prompt.proposedModel,
      };
    }

    if (isResetShorthand(reply)) {
      return { kind: 'reset' };
    }

    // Decline ("no") with no override → treat as an ask-again signal but
    // there's nothing to ask. The UX layer can re-prompt with a hint, or
    // fall back to catalog default. We surface as overridden with no
    // named pick, scope this-task — the consumer decides.
    if (isDeclineShorthand(reply)) {
      return { kind: 'overridden', scope: 'this-task' };
    }

    // Free-text → LLM-backed override detector.
    const overrideResult: OverrideDetectResult = await this.overrideDetector.detect({
      message: reply,
    });
    if (!overrideResult.overrideRequested) {
      // Free-text that wasn't classified as an override is ambiguous.
      // Surface as overridden-scope-this-task with no named pick — same
      // as decline. The UX layer's job is to recover.
      return { kind: 'overridden', scope: 'this-task' };
    }

    const result: ConfirmationResult = {
      kind: 'overridden',
      scope: overrideResult.scope,
    };
    if (overrideResult.framework !== undefined) result.framework = overrideResult.framework;
    if (overrideResult.model !== undefined) result.model = overrideResult.model;
    return result;
  }
}
