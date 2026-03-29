/**
 * Platform-agnostic stall detection and promise tracking.
 *
 * Extracted from TelegramAdapter as part of Phase 1 shared infrastructure.
 * Monitors message injection timestamps and detects when sessions
 * fail to respond within configured timeouts.
 */
export interface PendingMessage {
    channelId: string;
    sessionName: string;
    messageText: string;
    injectedAt: number;
    alerted: boolean;
}
export interface PendingPromise {
    channelId: string;
    sessionName: string;
    promiseText: string;
    promisedAt: number;
    alerted: boolean;
}
export interface StallEvent {
    type: 'stall' | 'promise-expired';
    channelId: string;
    sessionName: string;
    messageText: string;
    injectedAt: number;
    minutesElapsed: number;
}
export interface StallDetectorConfig {
    /** Minutes before a message is considered stalled (0 to disable) */
    stallTimeoutMinutes?: number;
    /** Minutes before a promise is considered expired (0 to disable) */
    promiseTimeoutMinutes?: number;
    /** Interval in ms between stall checks (default: 30000) */
    checkIntervalMs?: number;
}
/** Callback to check if a session is still running */
export type IsSessionAliveCheck = (sessionName: string) => boolean;
/** Callback to check if a session is actively producing output */
export type IsSessionActiveCheck = (sessionName: string) => Promise<boolean>;
/** Called when a stall or expired promise is detected */
export type OnStallCallback = (event: StallEvent, sessionAlive: boolean) => Promise<void>;
export declare class StallDetector {
    private pendingMessages;
    private pendingPromises;
    private checkInterval;
    private stallTimeoutMs;
    private promiseTimeoutMs;
    private checkIntervalMs;
    private isSessionAlive;
    private isSessionActive;
    private onStall;
    constructor(config?: StallDetectorConfig);
    /** Set callback to check session liveness */
    setIsSessionAlive(check: IsSessionAliveCheck | null): void;
    /** Set callback to check session activity */
    setIsSessionActive(check: IsSessionActiveCheck | null): void;
    /** Set callback for stall events */
    setOnStall(callback: OnStallCallback | null): void;
    /** Start periodic stall checking */
    start(): void;
    /** Stop periodic stall checking */
    stop(): void;
    /** Track that a message was injected into a session */
    trackMessageInjection(channelId: string, sessionName: string, messageText: string): void;
    /** Clear stall tracking for a channel (agent responded) */
    clearStallForChannel(channelId: string): void;
    /** Clear promise tracking for a channel */
    clearPromiseForChannel(channelId: string): void;
    /** Track an outbound message for promise detection */
    trackOutboundMessage(channelId: string, sessionName: string, text: string): void;
    /** Get current stall/promise counts for health status */
    getStatus(): {
        pendingStalls: number;
        pendingPromises: number;
    };
    /** Detect "work-in-progress" messages that imply the agent will follow up */
    isPromiseMessage(text: string): boolean;
    /** Detect messages that indicate the agent delivered on its promise */
    isFollowThroughMessage(text: string): boolean;
    /** Run stall/promise checks (called periodically by interval) */
    check(): Promise<void>;
}
//# sourceMappingURL=StallDetector.d.ts.map