/**
 * Privacy Utilities — validation, scope checking, and helpers for
 * the privacy scoping system (User-Agent Topology Spec, Phase 2).
 *
 * Core invariant: Data flows DOWN in scope (private → shared-topic → shared-project)
 * but never UP. A user can share their private data but cannot make shared data private.
 *
 * Visibility rules:
 *   - 'private': Only visible to ownerId
 *   - 'shared-topic': Visible to all users in the specified topic
 *   - 'shared-project': Visible to all users of the agent
 *
 * Default scope: 'private' (fail-closed — new data is private unless explicitly shared)
 */
import type { PrivacyScopeType, PrivacyScope, OnboardingState, OnboardingSession } from '../core/types.js';
/**
 * Validate a privacy scope is well-formed.
 * Returns null if valid, or an error message if invalid.
 */
export declare function validatePrivacyScope(scope: PrivacyScope): string | null;
/**
 * Check if a scope type string is valid.
 */
export declare function isValidScopeType(type: string): type is PrivacyScopeType;
/**
 * Check if a user can see data with a given privacy scope.
 *
 * Rules:
 *   - shared-project: visible to everyone
 *   - shared-topic: visible if user is in the topic (checked by topicId)
 *   - private: visible only if userId === ownerId
 *   - null/undefined scope: treated as shared-project (backward compat for legacy data)
 */
export declare function isVisibleToUser(scopeType: PrivacyScopeType | undefined | null, ownerId: string | undefined | null, userId: string, userTopicIds?: number[], dataTopicId?: number): boolean;
/**
 * Build a SQL WHERE clause fragment for privacy filtering.
 * Returns { clause, params } for composing into a larger query.
 *
 * The clause uses the column names from the table being queried:
 *   - ownerColumn: column containing the owner user ID (e.g., 'owner_id')
 *   - scopeColumn: column containing the privacy scope (e.g., 'privacy_scope')
 */
export declare function buildPrivacySqlFilter(userId: string, opts?: {
    ownerColumn?: string;
    scopeColumn?: string;
    userTopicIds?: number[];
}): {
    clause: string;
    params: (string | number)[];
};
/**
 * Get the default privacy scope for new data based on context.
 *
 * - User conversations/memories: private (fail-closed)
 * - Agent observations about shared topics: shared-topic
 * - Agent knowledge (tool docs, project facts): shared-project
 */
export declare function defaultScope(source: string): PrivacyScopeType;
/**
 * Create a PrivacyScope for private user data.
 */
export declare function privateScope(ownerId: string): PrivacyScope;
/**
 * Create a PrivacyScope for data shared within a topic.
 */
export declare function sharedTopicScope(topicId: number, ownerId?: string): PrivacyScope;
/**
 * Create a PrivacyScope for project-wide shared data.
 */
export declare function sharedProjectScope(): PrivacyScope;
/**
 * Check if an onboarding state transition is valid.
 */
export declare function isValidOnboardingTransition(from: OnboardingState, to: OnboardingState): boolean;
/**
 * Create a new onboarding session.
 */
export declare function createOnboardingSession(telegramUserId: number, name: string, topicId: number): OnboardingSession;
/**
 * Transition an onboarding session to a new state.
 * Returns the updated session, or null if the transition is invalid.
 */
export declare function transitionOnboarding(session: OnboardingSession, newState: OnboardingState): OnboardingSession | null;
/** Maximum number of messages buffered while user is in 'pending' onboarding state */
export declare const MAX_PENDING_MESSAGES = 5;
/** Onboarding timeout in minutes — auto-reject if not completed */
export declare const ONBOARDING_TIMEOUT_MINUTES = 30;
//# sourceMappingURL=privacy.d.ts.map