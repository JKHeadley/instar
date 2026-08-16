/**
 * User Onboarding — handles new user registration and verification flows.
 *
 * Implements the Multi-User Setup Wizard spec (Rev 7):
 * - New user joining an existing agent
 * - Existing user on a new machine (verification)
 * - On-the-fly Telegram registration
 * - Consent collection before data collection
 * - Agent contextual assessment for join requests
 */
import type { UserProfile, AgentAutonomyConfig, ConsentRecord, DataCollectedManifest, VerificationCode, JoinRequest, OnboardingConfig } from '../core/types.js';
/**
 * Generate a random numeric verification code.
 */
export declare function generateVerificationCode(digits?: number): string;
/**
 * Generate a cryptographically random alphanumeric connect code
 * using unambiguous characters (no 0/O, 1/l/I).
 */
export declare function generateConnectCode(length?: number): string;
/**
 * Hash a verification code for storage (we never store plaintext codes).
 */
export declare function hashCode(code: string): string;
/**
 * Generate a recovery key (32 bytes, displayed as hex).
 */
export declare function generateRecoveryKey(): string;
/**
 * Hash a recovery key with bcrypt-compatible SHA-256 (for config storage).
 */
export declare function hashRecoveryKey(key: string): string;
/**
 * Build the consent disclosure text for a given agent name.
 * If onboardingConfig.consentDisclosure is provided, uses that instead.
 */
export declare function buildConsentDisclosure(agentName: string, onboardingConfig?: OnboardingConfig): string;
/**
 * Build a condensed consent disclosure for on-the-fly Telegram registration.
 */
export declare function buildCondensedConsentDisclosure(agentName: string): string;
/**
 * Create a consent record.
 */
export declare function createConsentRecord(version?: string): ConsentRecord;
/**
 * Create a default data collected manifest.
 */
export declare function createDataManifest(options?: Partial<DataCollectedManifest>): DataCollectedManifest;
/**
 * Manages verification codes with expiry and attempt limits.
 */
export declare class VerificationManager {
    private codes;
    private lockouts;
    /**
     * Create a new verification code for a target.
     * Returns the plaintext code (display to user) and stores the hash.
     */
    createCode(targetId: string, type: VerificationCode['type']): {
        code: string;
        expiresAt: Date;
    };
    /**
     * Verify a code attempt. Returns true if valid.
     * Handles attempt counting, expiry, and lockout.
     */
    verifyCode(targetId: string, attempt: string): {
        valid: boolean;
        error?: string;
    };
}
/**
 * Manages join requests for admin-only registration.
 */
export declare class JoinRequestManager {
    private requests;
    private requestsFile;
    constructor(stateDir: string);
    /**
     * Create a new join request.
     */
    createRequest(name: string, telegramUserId: number, agentAssessment: string | null): JoinRequest;
    /**
     * Resolve a join request (approve or deny).
     */
    resolveRequest(approvalCode: string, action: 'approved' | 'denied', resolvedBy: string): JoinRequest | null;
    /**
     * Get pending requests.
     */
    getPendingRequests(): JoinRequest[];
    /**
     * Get a request by Telegram user ID.
     */
    getRequestByTelegramUser(telegramUserId: number): JoinRequest | null;
    private loadRequests;
    private persistRequests;
}
/**
 * Build a new user profile from onboarding data.
 * Supports both minimal onboarding (name + consent) and rich onboarding
 * (bio, interests, timezone, relationship context, custom fields).
 */
export declare function buildUserProfile(opts: {
    name: string;
    userId?: string;
    telegramTopicId?: string;
    telegramUserId?: number;
    email?: string;
    permissions?: string[];
    style?: string;
    autonomyLevel?: 'full' | 'confirm-destructive' | 'confirm-all';
    consent?: ConsentRecord;
    bio?: string;
    interests?: string[];
    timezone?: string;
    relationshipContext?: string;
    customFields?: Record<string, string>;
}): UserProfile;
/**
 * Get the list of onboarding prompts for a given OnboardingConfig.
 * Returns an ordered list of questions the onboarding flow should ask.
 * Only includes questions for fields the agent has configured.
 */
export declare function getOnboardingPrompts(config: OnboardingConfig): Array<{
    fieldName: string;
    prompt: string;
    required: boolean;
    type: 'builtin' | 'custom';
}>;
/**
 * Parse a comma-separated interest string into an array.
 * Trims whitespace, removes empty entries.
 */
export declare function parseInterests(input: string): string[];
/**
 * Apply rich onboarding answers to an existing UserProfile.
 * Used when onboarding is collected in stages (e.g., Telegram multi-step flow).
 */
export declare function applyOnboardingAnswers(profile: UserProfile, answers: Record<string, string>, config: OnboardingConfig): UserProfile;
/**
 * Get the default autonomy config for a given level.
 */
export declare function getDefaultAutonomyConfig(level: AgentAutonomyConfig['level']): AgentAutonomyConfig;
//# sourceMappingURL=UserOnboarding.d.ts.map