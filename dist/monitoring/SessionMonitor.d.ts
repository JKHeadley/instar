/**
 * SessionMonitor — Proactive session health monitoring.
 *
 * Unlike StallTriageNurse (reactive — triggers on unanswered messages) or
 * SessionWatchdog (reactive — triggers on stuck bash commands), the
 * SessionMonitor is PROACTIVE: it periodically checks all active sessions
 * and ensures users experience the responsiveness they'd expect.
 *
 * Responsibilities:
 * 1. Detect idle sessions (no tmux output changes for extended periods)
 * 2. Track session responsiveness (time between user message and agent reply)
 * 3. Send proactive health updates to users (not overbearing)
 * 4. Coordinate with StallTriageNurse for recovery when issues are found
 *
 * Design principle: Responsive and informative but not overbearing.
 * One update per issue per session — not a stream of "still checking" messages.
 */
import { EventEmitter } from 'events';
import type { SessionRecovery, RecoveryResult } from './SessionRecovery.js';
export interface SessionMonitorConfig {
    /** Enable the session monitor (default: true) */
    enabled?: boolean;
    /** How often to check sessions, in seconds (default: 60) */
    pollIntervalSec?: number;
    /** Minutes of inactivity before a session is flagged as idle (default: 15) */
    idleThresholdMinutes?: number;
    /** Minimum minutes between user notifications per topic (default: 30) */
    notificationCooldownMinutes?: number;
}
export interface SessionMonitorEvents {
    'monitor:idle-detected': {
        topicId: number;
        sessionName: string;
        idleMinutes: number;
    };
    'monitor:unresponsive': {
        topicId: number;
        sessionName: string;
        waitMinutes: number;
    };
    'monitor:recovery-triggered': {
        topicId: number;
        sessionName: string;
        reason: string;
    };
    'monitor:mechanical-recovery': {
        topicId: number;
        sessionName: string;
        result: RecoveryResult;
    };
    'monitor:user-notified': {
        topicId: number;
        message: string;
    };
}
export interface SessionMonitorDeps {
    /** Get all active topic-to-session mappings */
    getActiveTopicSessions: () => Map<number, string>;
    /** Capture tmux output for a session */
    captureSessionOutput: (sessionName: string, lines: number) => string | null;
    /** Check if a session is alive */
    isSessionAlive: (sessionName: string) => boolean;
    /** Get recent messages for a topic */
    getTopicHistory: (topicId: number, limit: number) => Array<{
        text: string;
        fromUser: boolean;
        timestamp: string;
    }>;
    /** Send a message to a topic */
    sendToTopic: (topicId: number, text: string) => Promise<any>;
    /** Trigger triage recovery for a session */
    triggerTriage?: (topicId: number, sessionName: string, reason: string) => Promise<{
        resolved: boolean;
    }>;
    /** Optional mechanical recovery layer — runs before LLM triage */
    sessionRecovery?: SessionRecovery;
}
export declare class SessionMonitor extends EventEmitter {
    private config;
    private deps;
    private snapshots;
    private interval;
    private running;
    constructor(deps: SessionMonitorDeps, config?: Partial<SessionMonitorConfig>);
    emit<K extends keyof SessionMonitorEvents>(event: K, data: SessionMonitorEvents[K]): boolean;
    on<K extends keyof SessionMonitorEvents>(event: K, listener: (data: SessionMonitorEvents[K]) => void): this;
    start(): void;
    stop(): void;
    getStatus(): {
        enabled: boolean;
        trackedSessions: number;
        sessionHealth: Array<{
            topicId: number;
            sessionName: string;
            status: string;
            idleMinutes: number;
        }>;
    };
    poll(): Promise<void>;
    private checkSession;
}
//# sourceMappingURL=SessionMonitor.d.ts.map