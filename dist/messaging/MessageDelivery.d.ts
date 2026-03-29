/**
 * MessageDelivery — safe tmux message injection.
 *
 * Checks injection safety (process whitelist, human input detection,
 * context budget) before delivering messages to Claude sessions via
 * tmux send-keys. Implements per-session delivery mutex for FIFO ordering.
 */
import type { MessageEnvelope, AgentMessage, InjectionSafety, IMessageDelivery, DeliveryResult, MessageThread } from './types.js';
import { MessageFormatter } from './MessageFormatter.js';
/** Interface for tmux operations — injectable for testing */
export interface TmuxOperations {
    getForegroundProcess(tmuxSession: string): string;
    isSessionAlive(tmuxSession: string): boolean;
    hasActiveHumanInput(tmuxSession: string): boolean;
    sendKeys(tmuxSession: string, text: string): boolean;
    getOutputLineCount(tmuxSession: string): number;
}
export declare class MessageDelivery implements IMessageDelivery {
    private readonly formatter;
    private readonly tmux;
    constructor(formatter: MessageFormatter, tmux: TmuxOperations);
    checkInjectionSafety(tmuxSession: string): Promise<InjectionSafety>;
    deliverToSession(sessionId: string, envelope: MessageEnvelope): Promise<DeliveryResult>;
    formatInline(message: AgentMessage, threadContext?: MessageThread): string;
    formatPointer(message: AgentMessage): string;
}
//# sourceMappingURL=MessageDelivery.d.ts.map