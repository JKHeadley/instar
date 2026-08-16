/**
 * Platform-agnostic user authorization gate.
 *
 * Extracted from TelegramAdapter as part of Phase 1 shared infrastructure.
 * Handles user authorization checks and unknown user policies.
 * Platform adapters provide identity resolution and response delivery.
 */
export class AuthGate {
    authorizedUsers;
    allowAll;
    policy;
    rateLimitMap = new Map();
    static COOLDOWN_MS = 60_000; // 1 minute between responses
    constructor(config) {
        this.allowAll = config.authorizedUsers.some(u => u === '*');
        this.authorizedUsers = new Set(config.authorizedUsers.filter(u => u !== '*').map(u => u.toString()));
        this.policy = config.registrationPolicy ?? { policy: 'closed' };
    }
    /**
     * Check if a user is authorized.
     * Empty authorized list = deny all (safe default).
     * Use '*' in the authorized list to explicitly allow all users.
     */
    isAuthorized(userId) {
        if (this.allowAll)
            return true;
        if (this.authorizedUsers.size === 0)
            return false;
        return this.authorizedUsers.has(userId.toString());
    }
    /**
     * Check authorization and return a typed result.
     */
    check(userId, userInfo) {
        if (this.isAuthorized(userId)) {
            return { authorized: true };
        }
        return { authorized: false, reason: 'not-authorized', userInfo };
    }
    /**
     * Handle an unauthorized user according to the registration policy.
     * Rate-limited to prevent spam from the same user.
     *
     * Returns true if a response was sent, false if rate-limited.
     */
    async handleUnauthorized(userInfo, callbacks) {
        // Rate limit
        const lastResponse = this.rateLimitMap.get(userInfo.userId);
        if (lastResponse && (Date.now() - lastResponse) < AuthGate.COOLDOWN_MS) {
            return false;
        }
        this.rateLimitMap.set(userInfo.userId, Date.now());
        // Cleanup old entries periodically
        if (this.rateLimitMap.size > 100) {
            const cutoff = Date.now() - AuthGate.COOLDOWN_MS * 10;
            for (const [uid, ts] of this.rateLimitMap) {
                if (ts < cutoff)
                    this.rateLimitMap.delete(uid);
            }
        }
        const displayName = this.policy.agentName || 'This agent';
        try {
            switch (this.policy.policy) {
                case 'admin-only': {
                    let message = `Hi ${userInfo.displayName}! ${displayName} is not open for public registration. Access is managed by an administrator.`;
                    if (this.policy.contactHint) {
                        message += `\n\n${this.policy.contactHint}`;
                    }
                    message += `\n\nYour request has been noted and forwarded to the admin.`;
                    await callbacks.sendResponse(message);
                    if (callbacks.notifyAdmin) {
                        await callbacks.notifyAdmin(userInfo).catch(err => {
                            console.error(`[auth-gate] Failed to notify admin of join request: ${err}`);
                        });
                    }
                    return true;
                }
                case 'invite-only': {
                    const trimmedText = userInfo.messageText?.trim();
                    if (trimmedText && callbacks.validateInviteCode) {
                        const result = await callbacks.validateInviteCode(trimmedText, userInfo.userId);
                        if (result.valid) {
                            await callbacks.sendResponse(`Welcome, ${userInfo.displayName}! Your invite code has been accepted. Setting up your account...`);
                            if (callbacks.startOnboarding) {
                                await callbacks.startOnboarding(userInfo.userId, userInfo.displayName, userInfo.username).catch(err => {
                                    console.error(`[auth-gate] Failed to start onboarding after invite: ${err}`);
                                });
                            }
                            return true;
                        }
                        else if (result.error) {
                            await callbacks.sendResponse(result.error);
                            return true;
                        }
                    }
                    let message = `Hi ${userInfo.displayName}! ${displayName} requires an invite code to join. Please reply with your invite code.`;
                    if (this.policy.contactHint) {
                        message += `\n\n${this.policy.contactHint}`;
                    }
                    await callbacks.sendResponse(message);
                    return true;
                }
                case 'open': {
                    if (callbacks.startOnboarding) {
                        await callbacks.sendResponse(`Hi ${userInfo.displayName}! Welcome! Setting up your account...`);
                        await callbacks.startOnboarding(userInfo.userId, userInfo.displayName, userInfo.username).catch(err => {
                            console.error(`[auth-gate] Failed to start onboarding: ${err}`);
                            callbacks.sendResponse(`Sorry ${userInfo.displayName}, there was an issue setting up your account. Please try again later.`).catch(() => { });
                        });
                    }
                    else {
                        await callbacks.sendResponse(`Hi ${userInfo.displayName}! Registration is currently being set up. Please try again later.`);
                    }
                    return true;
                }
                case 'closed':
                default: {
                    await callbacks.sendResponse(`Hi ${userInfo.displayName}! ${displayName} is not currently accepting new users.`);
                    return true;
                }
            }
        }
        catch (err) {
            console.error(`[auth-gate] Error handling unauthorized user ${userInfo.userId}: ${err}`);
            return false;
        }
    }
    /**
     * Add a user to the authorized set at runtime (e.g., after successful registration).
     */
    authorize(userId) {
        this.authorizedUsers.add(userId.toString());
    }
    /**
     * Remove a user from the authorized set.
     */
    deauthorize(userId) {
        this.authorizedUsers.delete(userId.toString());
    }
    /**
     * Get the current registration policy.
     */
    getPolicy() {
        return { ...this.policy };
    }
    /**
     * Update the registration policy.
     */
    setPolicy(policy) {
        this.policy = { ...policy };
    }
    /**
     * Get count of authorized users.
     */
    get authorizedCount() {
        return this.authorizedUsers.size;
    }
}
//# sourceMappingURL=AuthGate.js.map