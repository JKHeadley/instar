/**
 * DigestCollector — Aggregates inter-agent message activity for periodic digest reports.
 *
 * Part of the Threadline Protocol Phase 2 (Autonomy-Gated Visibility).
 * In collaborative/autonomous modes, messages are delivered silently but tracked
 * here for periodic summary delivery to the user.
 *
 * Storage: {stateDir}/threadline/digest.json
 */
import type { MessageEnvelope } from '../messaging/types.js';
export interface DigestEntry {
    /** Message ID */
    messageId: string;
    /** Who sent it */
    fromAgent: string;
    /** Message subject */
    subject: string;
    /** First 200 chars of body */
    bodyPreview: string;
    /** Thread context */
    threadId?: string;
    /** When received */
    receivedAt: string;
    /** Message type */
    type: string;
}
export interface DigestState {
    /** Entries since last digest */
    entries: DigestEntry[];
    /** When the last digest was sent */
    lastDigestSentAt: string;
    /** How often to send digests (in minutes) */
    digestIntervalMinutes: number;
}
export declare class DigestCollector {
    private readonly filePath;
    constructor(stateDir: string);
    /**
     * Track a delivered message for inclusion in the next digest.
     */
    addEntry(envelope: MessageEnvelope): void;
    /**
     * Generate a human-readable digest summary of recent inter-agent activity.
     * Returns null if there are no entries to report.
     */
    generateDigest(): string | null;
    /**
     * Check if enough time has passed to send a digest.
     */
    shouldSendDigest(): boolean;
    /**
     * Mark digest as sent — clears accumulated entries and updates timestamp.
     */
    markDigestSent(): void;
    /**
     * Get the current digest interval in minutes.
     */
    getDigestInterval(): number;
    /**
     * Set the digest interval in minutes.
     */
    setDigestInterval(minutes: number): void;
    /**
     * Get the number of pending entries.
     */
    entryCount(): number;
    private load;
    private save;
}
//# sourceMappingURL=DigestCollector.d.ts.map