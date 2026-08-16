/**
 * UserPropagator — Cross-machine user synchronization via AgentBus.
 *
 * When a machine onboards a new user, the propagator broadcasts the
 * UserProfile via AgentBus so other machines recognize the user
 * immediately — no waiting for git sync.
 *
 * Receiving machines add the user to their local UserManager,
 * making them immediately authorized for interactions.
 *
 * Privacy: Propagation only occurs for users who have given consent
 * (checked via user.consent field). The broadcast is documented in
 * the onboarding consent disclosure per Phase 2.
 *
 * Part of Phase 4D (User-Agent Topology Spec — Gap 11).
 */
import { EventEmitter } from 'node:events';
// ── UserPropagator ──────────────────────────────────────────────────
export class UserPropagator extends EventEmitter {
    bus;
    userManager;
    machineId;
    requireConsent;
    constructor(config) {
        super();
        this.bus = config.bus;
        this.userManager = config.userManager;
        this.machineId = config.machineId;
        this.requireConsent = config.requireConsent ?? true;
        this.registerHandlers();
    }
    // ── Propagation (outbound) ──────────────────────────────────────
    /**
     * Broadcast a newly onboarded user to all machines.
     * Returns true if the broadcast was sent, false if skipped (consent missing).
     */
    async propagateUser(profile) {
        // Check consent requirement
        if (this.requireConsent && !this.hasConsent(profile)) {
            this.emit('consent-missing', profile.id);
            return false;
        }
        await this.bus.send({
            type: 'custom',
            to: '*',
            payload: {
                action: 'user-onboarded',
                profile,
                machineId: this.machineId,
                timestamp: new Date().toISOString(),
            },
        });
        return true;
    }
    /**
     * Broadcast a user profile update to all machines.
     */
    async propagateUpdate(profile) {
        if (this.requireConsent && !this.hasConsent(profile)) {
            this.emit('consent-missing', profile.id);
            return false;
        }
        await this.bus.send({
            type: 'custom',
            to: '*',
            payload: {
                action: 'user-updated',
                profile,
                machineId: this.machineId,
                timestamp: new Date().toISOString(),
            },
        });
        return true;
    }
    /**
     * Broadcast a user removal to all machines.
     */
    async propagateRemoval(userId) {
        await this.bus.send({
            type: 'custom',
            to: '*',
            payload: {
                action: 'user-removed',
                userId,
                machineId: this.machineId,
                timestamp: new Date().toISOString(),
            },
        });
    }
    // ── Reception (inbound) ─────────────────────────────────────────
    registerHandlers() {
        this.bus.onMessage('custom', (msg) => {
            const payload = msg.payload;
            // Only handle user propagation payloads
            if (!payload.action || !payload.action.startsWith('user-'))
                return;
            switch (payload.action) {
                case 'user-onboarded':
                case 'user-updated':
                    if (payload.profile) {
                        this.handleIncomingUser(payload.profile, msg.from);
                    }
                    break;
                case 'user-removed':
                    if (payload.userId) {
                        this.handleIncomingRemoval(payload.userId, msg.from);
                    }
                    break;
            }
        });
    }
    handleIncomingUser(profile, fromMachine) {
        try {
            // Check if user already exists locally
            const existing = this.userManager.getUser(profile.id);
            if (existing) {
                // Update if the incoming profile is newer
                if (profile.createdAt && existing.createdAt &&
                    new Date(profile.createdAt) <= new Date(existing.createdAt)) {
                    return; // Local version is newer or same — skip
                }
            }
            this.userManager.upsertUser(profile);
            this.emit('user-received', profile, fromMachine);
        }
        catch (err) {
            // Channel collision or validation error — log but don't crash
            console.error(`[UserPropagator] Failed to register propagated user ${profile.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    handleIncomingRemoval(userId, fromMachine) {
        try {
            this.userManager.removeUser(userId);
            this.emit('user-removed', userId, fromMachine);
        }
        catch (err) {
            console.error(`[UserPropagator] Failed to remove propagated user ${userId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ── Helpers ─────────────────────────────────────────────────────
    hasConsent(profile) {
        return !!profile.consent?.consentGiven;
    }
}
//# sourceMappingURL=UserPropagator.js.map