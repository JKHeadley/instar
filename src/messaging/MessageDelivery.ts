/**
 * MessageDelivery — safe tmux message injection.
 *
 * Checks injection safety (process whitelist, human input detection,
 * context budget) before delivering messages to Claude sessions via
 * tmux send-keys. Implements per-session delivery mutex for FIFO ordering.
 */

/** Actual in-process ownership, released after outcome persistence even on failure.
 * A durable typing marker alone never means that an attempt is still running.
 */
export interface DeliveryAttemptClaim { readonly messageId: string; readonly token: symbol; release(): void; }
const activeDeliveryAttempts = new Map<string, symbol>();
export function isDeliveryAttemptActive(messageId: string): boolean { return activeDeliveryAttempts.has(messageId); }
export function ownsDeliveryAttempt(claim: DeliveryAttemptClaim | undefined, messageId: string): boolean {
  return !!claim && claim.messageId === messageId && activeDeliveryAttempts.get(messageId) === claim.token;
}
export function beginDeliveryAttempt(messageId: string): DeliveryAttemptClaim | null {
  if (activeDeliveryAttempts.has(messageId)) return null;
  const token = Symbol(messageId); activeDeliveryAttempts.set(messageId, token);
  return { messageId, token, release: () => { if (activeDeliveryAttempts.get(messageId) === token) activeDeliveryAttempts.delete(messageId); } };
}

import { HOLDER_RETRY_WINDOW_MS } from './types.js';
import type {
  MessageEnvelope,
  AgentMessage,
  InjectionSafety,
  IMessageDelivery,
  DeliveryResult,
  MessageThread,
} from './types.js';
import { ALLOWED_INJECTION_PROCESSES } from './types.js';
import { MessageFormatter } from './MessageFormatter.js';
import { PEER_PLACE_SESSION_MARKER } from '../users/peerPlaceAdmission.js';

/** Interface for tmux operations — injectable for testing */
export interface TmuxOperations {
  getForegroundProcess(tmuxSession: string): string;
  isSessionAlive(tmuxSession: string): boolean;
  /** Synchronous incarnation check immediately before injection, after all awaits. */
  currentSessionGeneration?(tmuxSession: string): string | null;
  isSessionGeneration?(tmuxSession: string, sessionId: string): boolean;
  hasActiveHumanInput(tmuxSession: string): boolean;
  sendKeys(tmuxSession: string, text: string): boolean;
  getOutputLineCount(tmuxSession: string): number;
}

/** Context budget threshold — if output exceeds this many lines, use pointer delivery */
const CONTEXT_LINE_THRESHOLD = 10_000;

export class MessageDelivery implements IMessageDelivery {
  private readonly formatter: MessageFormatter;
  private readonly tmux: TmuxOperations;

  constructor(formatter: MessageFormatter, tmux: TmuxOperations) {
    this.formatter = formatter;
    this.tmux = tmux;
  }

  async checkInjectionSafety(tmuxSession: string): Promise<InjectionSafety> {
    const foregroundProcess = this.tmux.getForegroundProcess(tmuxSession);
    const isSafeProcess = (ALLOWED_INJECTION_PROCESSES as readonly string[]).includes(foregroundProcess);
    const hasHumanInput = this.tmux.hasActiveHumanInput(tmuxSession);
    const lineCount = this.tmux.getOutputLineCount(tmuxSession);
    const contextBudgetExceeded = lineCount > CONTEXT_LINE_THRESHOLD;

    return {
      foregroundProcess,
      isSafeProcess,
      hasHumanInput,
      contextBudgetExceeded,
    };
  }

  async deliverToSession(sessionId: string, envelope: MessageEnvelope): Promise<DeliveryResult> {
    // Step 1: Is the session alive?
    if (!this.tmux.isSessionAlive(sessionId)) {
      return {
        success: false,
        phase: 'queued',
        failureReason: 'Session not alive',
        shouldRetry: true,
      };
    }

    // Step 2: Check injection safety
    const safety = await this.checkInjectionSafety(sessionId);

    if (!safety.isSafeProcess) {
      return {
        success: false,
        phase: 'queued',
        failureReason: `Unsafe foreground process: ${safety.foregroundProcess}`,
        shouldRetry: true,
      };
    }

    if (safety.hasHumanInput) {
      return {
        success: false,
        phase: 'queued',
        failureReason: 'Human input detected',
        shouldRetry: true,
      };
    }

    // Step 3: Format the message
    let formatted: string;
    if (safety.contextBudgetExceeded && envelope.message.body.length > 1024) {
      formatted = this.formatter.formatPointer(envelope.message);
    } else {
      // A session in another agent's place has no Threadline tools (memory-privacy-agent-places §5).
      formatted = typeof sessionId === "string" && sessionId.includes(PEER_PLACE_SESSION_MARKER)
        ? this.formatter.formatInline(envelope.message, undefined, {
          replyHint: `.instar/scripts/threadline-reply.sh --thread ${envelope.message.threadId ?? '<thread id>'} "your reply" (one argument; no heredoc).`,
        })
        : this.formatter.formatInline(envelope.message);
    }

    // Generation is checked AFTER the safety await and directly before the
    // synchronous injection. A same-name respawn during pin persistence or the
    // safety check cannot receive a message pinned to its predecessor.
    const signedGeneration = envelope.message.to.sessionId;
    if ((envelope.message.to.sessionGenerationRequired && !signedGeneration)
      || (signedGeneration && envelope.delivery.resolvedSessionId && signedGeneration !== envelope.delivery.resolvedSessionId)) {
      return { success: false, phase: 'failed', failureReason: 'target-session-generation-unavailable', shouldRetry: false };
    }
    const expectedGeneration = signedGeneration ?? envelope.delivery.resolvedSessionId;
    if (expectedGeneration) {
      const current = this.tmux.currentSessionGeneration?.(sessionId);
      const matches = this.tmux.currentSessionGeneration ? current === expectedGeneration
        : this.tmux.isSessionGeneration ? this.tmux.isSessionGeneration(sessionId, expectedGeneration)
          : !signedGeneration && !envelope.message.to.sessionGenerationRequired;
      if (!matches) return { success: false, phase: 'failed',
        failureReason: signedGeneration ? (current ? 'target-session-generation-changed' : 'target-session-generation-unavailable') : 'resolved-session-ended', shouldRetry: false };
    }
    const expiresAt = envelope.delivery.expiresAt ?? Date.parse(envelope.message.createdAt) + envelope.message.ttlMinutes * 60_000;
    if (Date.now() > expiresAt) return { success: false, phase: 'failed', failureReason: 'TTL expired', shouldRetry: false };
    const retryBegan = envelope.delivery.holderRetryState?.firstAttemptAt;
    if (retryBegan !== undefined && Date.now() - retryBegan >= HOLDER_RETRY_WINDOW_MS)
      return { success: false, phase: 'failed', failureReason: 'holder retry work window ended before injection', shouldRetry: false };
    // Step 4: Inject via tmux send-keys
    let success = false;
    try { success = this.tmux.sendKeys(sessionId, formatted); }
    catch { /* @silent-fallback-ok: classify a physical injection error as uncertain, never retry it */ }
    if (!success) {
      // A chunk or Enter may have reached tmux before the error/timeout. False
      // cannot establish "nothing typed", so do not retry this physical attempt.
      return {
        success: false, phase: 'failed',
        failureReason: 'outcome unknown: tmux did not confirm the injection; the message may have arrived',
        shouldRetry: false, outcomeUnknown: true,
      };
    }

    return {
      success: true,
      phase: 'delivered',
      shouldRetry: false,
    };
  }

  formatInline(message: AgentMessage, threadContext?: MessageThread): string {
    return this.formatter.formatInline(message, threadContext);
  }

  formatPointer(message: AgentMessage): string {
    return this.formatter.formatPointer(message);
  }
}
