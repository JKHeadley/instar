/**
 * MessageDelivery — safe tmux message injection.
 *
 * Checks injection safety (process whitelist, human input detection,
 * context budget) before delivering messages to Claude sessions via
 * tmux send-keys. Implements per-session delivery mutex for FIFO ordering.
 */
import { ALLOWED_INJECTION_PROCESSES } from './types.js';
/** Context budget threshold — if output exceeds this many lines, use pointer delivery */
const CONTEXT_LINE_THRESHOLD = 10_000;
export class MessageDelivery {
    formatter;
    tmux;
    constructor(formatter, tmux) {
        this.formatter = formatter;
        this.tmux = tmux;
    }
    async checkInjectionSafety(tmuxSession) {
        const foregroundProcess = this.tmux.getForegroundProcess(tmuxSession);
        const isSafeProcess = ALLOWED_INJECTION_PROCESSES.includes(foregroundProcess);
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
    async deliverToSession(sessionId, envelope) {
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
        let formatted;
        if (safety.contextBudgetExceeded && envelope.message.body.length > 1024) {
            formatted = this.formatter.formatPointer(envelope.message);
        }
        else {
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
    formatInline(message, threadContext) {
        return this.formatter.formatInline(message, threadContext);
    }
    formatPointer(message) {
        return this.formatter.formatPointer(message);
    }
}
//# sourceMappingURL=MessageDelivery.js.map