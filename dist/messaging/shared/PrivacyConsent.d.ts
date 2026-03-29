/**
 * PrivacyConsent — tracks first-contact consent for WhatsApp users.
 *
 * WhatsApp messaging involves processing personal data (phone numbers,
 * message content). This module handles:
 * - First-contact consent prompt
 * - Consent recording with timestamps
 * - Consent revocation
 * - Persistence to disk
 */
export interface ConsentRecord {
    /** E.164 phone number */
    userId: string;
    /** When consent was granted */
    consentedAt: string;
    /** Consent version (for future policy updates) */
    version: number;
}
export interface PrivacyConsentOptions {
    /** Path to store consent records */
    consentPath: string;
    /** Consent prompt message sent on first contact */
    consentMessage?: string;
    /** Whether consent is required before processing messages. Default: true */
    requireConsent?: boolean;
    /** Current consent version. Default: 1 */
    currentVersion?: number;
}
export declare class PrivacyConsent {
    private records;
    private consentPath;
    private consentMessage;
    private requireConsent;
    private currentVersion;
    private pendingConsent;
    constructor(options: PrivacyConsentOptions);
    /** Check if a user has given consent (current version). */
    hasConsent(userId: string): boolean;
    /** Check if a user has a pending consent prompt. */
    isPendingConsent(userId: string): boolean;
    /** Mark a user as having a pending consent prompt. */
    markPendingConsent(userId: string): void;
    /**
     * Handle a potential consent response.
     * Returns true if the message was a consent response (positive or negative).
     */
    handleConsentResponse(userId: string, text: string): 'granted' | 'denied' | null;
    /** Grant consent for a user. */
    grantConsent(userId: string): void;
    /** Revoke consent for a user (right to erasure). */
    revokeConsent(userId: string): boolean;
    /** Get the consent prompt message. */
    getConsentMessage(): string;
    /** Get all consent records. */
    getRecords(): ConsentRecord[];
    /** Get record count. */
    get size(): number;
    private loadRecords;
    private saveRecords;
}
//# sourceMappingURL=PrivacyConsent.d.ts.map