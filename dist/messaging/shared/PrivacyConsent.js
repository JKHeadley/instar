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
import fs from 'node:fs';
import path from 'node:path';
const DEFAULT_CONSENT_MESSAGE = [
    'Hi! Before we chat, I need to let you know:',
    '',
    'This agent processes your messages to provide responses. Your phone number and message content are stored locally for session continuity.',
    '',
    'Reply "I agree" or "yes" to continue, or "stop" to opt out.',
    'You can revoke consent anytime with /stop.',
].join('\n');
export class PrivacyConsent {
    records = new Map();
    consentPath;
    consentMessage;
    requireConsent;
    currentVersion;
    pendingConsent = new Set();
    constructor(options) {
        this.consentPath = options.consentPath;
        this.consentMessage = options.consentMessage ?? DEFAULT_CONSENT_MESSAGE;
        this.requireConsent = options.requireConsent ?? true;
        this.currentVersion = options.currentVersion ?? 1;
        this.loadRecords();
    }
    /** Check if a user has given consent (current version). */
    hasConsent(userId) {
        if (!this.requireConsent)
            return true;
        const record = this.records.get(userId);
        return record !== undefined && record.version >= this.currentVersion;
    }
    /** Check if a user has a pending consent prompt. */
    isPendingConsent(userId) {
        return this.pendingConsent.has(userId);
    }
    /** Mark a user as having a pending consent prompt. */
    markPendingConsent(userId) {
        this.pendingConsent.add(userId);
    }
    /**
     * Handle a potential consent response.
     * Returns true if the message was a consent response (positive or negative).
     */
    handleConsentResponse(userId, text) {
        if (!this.pendingConsent.has(userId))
            return null;
        const normalized = text.trim().toLowerCase();
        const positiveResponses = ['i agree', 'yes', 'agree', 'ok', 'okay', 'sure', 'accept', 'y'];
        const negativeResponses = ['no', 'stop', 'deny', 'refuse', 'decline', 'n'];
        if (positiveResponses.includes(normalized)) {
            this.grantConsent(userId);
            this.pendingConsent.delete(userId);
            return 'granted';
        }
        if (negativeResponses.includes(normalized)) {
            this.pendingConsent.delete(userId);
            return 'denied';
        }
        return null; // Not a consent response
    }
    /** Grant consent for a user. */
    grantConsent(userId) {
        this.records.set(userId, {
            userId,
            consentedAt: new Date().toISOString(),
            version: this.currentVersion,
        });
        this.saveRecords();
    }
    /** Revoke consent for a user (right to erasure). */
    revokeConsent(userId) {
        const had = this.records.delete(userId);
        this.pendingConsent.delete(userId);
        if (had)
            this.saveRecords();
        return had;
    }
    /** Get the consent prompt message. */
    getConsentMessage() {
        return this.consentMessage;
    }
    /** Get all consent records. */
    getRecords() {
        return [...this.records.values()];
    }
    /** Get record count. */
    get size() {
        return this.records.size;
    }
    loadRecords() {
        try {
            if (fs.existsSync(this.consentPath)) {
                const data = JSON.parse(fs.readFileSync(this.consentPath, 'utf-8'));
                if (Array.isArray(data)) {
                    for (const record of data) {
                        this.records.set(record.userId, record);
                    }
                }
            }
        }
        catch {
            // Start fresh on parse errors
        }
    }
    saveRecords() {
        const dir = path.dirname(this.consentPath);
        fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${this.consentPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        try {
            fs.writeFileSync(tmpPath, JSON.stringify([...this.records.values()], null, 2));
            fs.renameSync(tmpPath, this.consentPath);
        }
        catch (err) {
            try {
                fs.unlinkSync(tmpPath);
            }
            catch { /* ignore */ }
            throw err;
        }
    }
}
//# sourceMappingURL=PrivacyConsent.js.map