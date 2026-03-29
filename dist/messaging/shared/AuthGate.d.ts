/**
 * Platform-agnostic user authorization gate.
 *
 * Extracted from TelegramAdapter as part of Phase 1 shared infrastructure.
 * Handles user authorization checks and unknown user policies.
 * Platform adapters provide identity resolution and response delivery.
 */
export interface AuthGateConfig {
    /**
     * Authorized user identifiers (platform-specific).
     * Empty = deny all (safe default). Use ['*'] to explicitly allow all users.
     */
    authorizedUsers: string[];
    /** Registration policy for unknown users */
    registrationPolicy?: RegistrationPolicy;
}
export interface RegistrationPolicy {
    /** How unknown users are handled */
    policy: 'admin-only' | 'invite-only' | 'open' | 'closed';
    /** Hint shown to users about how to get access */
    contactHint?: string;
    /** Agent's display name for greeting messages */
    agentName?: string;
}
export interface UnknownUserInfo {
    /** Platform-specific user identifier */
    userId: string;
    /** User's display name */
    displayName: string;
    /** Username (if available) */
    username?: string;
    /** The message text the unknown user sent (for invite code checking) */
    messageText?: string;
}
/** Result of an authorization check */
export type AuthResult = {
    authorized: true;
} | {
    authorized: false;
    reason: 'not-authorized';
    userInfo: UnknownUserInfo;
};
/** Callbacks for handling unknown users */
export interface AuthGateCallbacks {
    /** Send a message to the user (platform-specific delivery) */
    sendResponse: (message: string) => Promise<void>;
    /** Notify admin of a join request (admin-only policy) */
    notifyAdmin?: (request: UnknownUserInfo) => Promise<void>;
    /** Validate an invite code (invite-only policy) */
    validateInviteCode?: (code: string, userId: string) => Promise<{
        valid: boolean;
        error?: string;
    }>;
    /** Start onboarding for a new user (open policy) */
    startOnboarding?: (userId: string, displayName: string, username?: string) => Promise<void>;
}
export declare class AuthGate {
    private authorizedUsers;
    private allowAll;
    private policy;
    private rateLimitMap;
    private static readonly COOLDOWN_MS;
    constructor(config: AuthGateConfig);
    /**
     * Check if a user is authorized.
     * Empty authorized list = deny all (safe default).
     * Use '*' in the authorized list to explicitly allow all users.
     */
    isAuthorized(userId: string): boolean;
    /**
     * Check authorization and return a typed result.
     */
    check(userId: string, userInfo: UnknownUserInfo): AuthResult;
    /**
     * Handle an unauthorized user according to the registration policy.
     * Rate-limited to prevent spam from the same user.
     *
     * Returns true if a response was sent, false if rate-limited.
     */
    handleUnauthorized(userInfo: UnknownUserInfo, callbacks: AuthGateCallbacks): Promise<boolean>;
    /**
     * Add a user to the authorized set at runtime (e.g., after successful registration).
     */
    authorize(userId: string): void;
    /**
     * Remove a user from the authorized set.
     */
    deauthorize(userId: string): void;
    /**
     * Get the current registration policy.
     */
    getPolicy(): RegistrationPolicy;
    /**
     * Update the registration policy.
     */
    setPolicy(policy: RegistrationPolicy): void;
    /**
     * Get count of authorized users.
     */
    get authorizedCount(): number;
}
//# sourceMappingURL=AuthGate.d.ts.map