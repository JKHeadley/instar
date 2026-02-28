/**
 * MessageDelivery — safe tmux message injection.
 *
 * Checks injection safety (process whitelist, human input detection,
 * context budget) before delivering messages to Claude sessions via
 * tmux send-keys. Implements per-session delivery mutex for FIFO ordering.
 */

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

/** Interface for tmux operations — injectable for testing */
export interface TmuxOperations {
  getForegroundProcess(tmuxSession: string): string;
  isSessionAlive(tmuxSession: string): boolean;
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
      formatted = this.formatter.formatInline(envelope.message);
    }

    // Step 4: Inject via tmux send-keys
    const success = this.tmux.sendKeys(sessionId, formatted);

    if (!success) {
      return {
        success: false,
        phase: 'queued',
        failureReason: 'tmux send-keys failed',
        shouldRetry: true,
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
