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
import type { AgentBus } from '../core/AgentBus.js';
import type { UserManager } from './UserManager.js';
import type { UserProfile } from '../core/types.js';
export interface UserPropagationPayload {
    /** The action being propagated. */
    action: 'user-onboarded' | 'user-updated' | 'user-removed';
    /** The user profile (present for onboarded/updated). */
    profile?: UserProfile;
    /** User ID (present for removed). */
    userId?: string;
    /** Originating machine ID. */
    machineId: string;
    /** Timestamp of the action. */
    timestamp: string;
}
export interface UserPropagatorConfig {
    /** The AgentBus for broadcasting user changes. */
    bus: AgentBus;
    /** The local UserManager to receive propagated users. */
    userManager: UserManager;
    /** This machine's ID. */
    machineId: string;
    /** Whether to require consent before propagating (default: true). */
    requireConsent?: boolean;
}
export interface UserPropagatorEvents {
    /** Emitted when a user is received from another machine. */
    'user-received': (profile: UserProfile, fromMachine: string) => void;
    /** Emitted when a user removal is received from another machine. */
    'user-removed': (userId: string, fromMachine: string) => void;
    /** Emitted when propagation is skipped due to missing consent. */
    'consent-missing': (userId: string) => void;
}
export declare class UserPropagator extends EventEmitter {
    private bus;
    private userManager;
    private machineId;
    private requireConsent;
    constructor(config: UserPropagatorConfig);
    /**
     * Broadcast a newly onboarded user to all machines.
     * Returns true if the broadcast was sent, false if skipped (consent missing).
     */
    propagateUser(profile: UserProfile): Promise<boolean>;
    /**
     * Broadcast a user profile update to all machines.
     */
    propagateUpdate(profile: UserProfile): Promise<boolean>;
    /**
     * Broadcast a user removal to all machines.
     */
    propagateRemoval(userId: string): Promise<void>;
    private registerHandlers;
    private handleIncomingUser;
    private handleIncomingRemoval;
    private hasConsent;
}
//# sourceMappingURL=UserPropagator.d.ts.map