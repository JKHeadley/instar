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
// ── Scope Validation ──────────────────────────────────────────────────
/**
 * Validate a privacy scope is well-formed.
 * Returns null if valid, or an error message if invalid.
 */
export function validatePrivacyScope(scope) {
    if (!isValidScopeType(scope.type)) {
        return `Invalid scope type: ${scope.type}. Must be 'private', 'shared-topic', or 'shared-project'.`;
    }
    if (scope.type === 'private' && !scope.ownerId) {
        return "Private scope requires 'ownerId'.";
    }
    if (scope.type === 'shared-topic' && scope.topicId == null) {
        return "Shared-topic scope requires 'topicId'.";
    }
    return null;
}
/**
 * Check if a scope type string is valid.
 */
export function isValidScopeType(type) {
    return type === 'private' || type === 'shared-topic' || type === 'shared-project';
}
// ── Visibility Checks ─────────────────────────────────────────────────
/**
 * Check if a user can see data with a given privacy scope.
 *
 * Rules:
 *   - shared-project: visible to everyone
 *   - shared-topic: visible if user is in the topic (checked by topicId)
 *   - private: visible only if userId === ownerId
 *   - null/undefined scope: treated as shared-project (backward compat for legacy data)
 */
export function isVisibleToUser(scopeType, ownerId, userId, userTopicIds, dataTopicId) {
    // Legacy data without scope is shared-project (backward compat)
    if (!scopeType || scopeType === 'shared-project') {
        return true;
    }
    if (scopeType === 'shared-topic') {
        if (dataTopicId == null)
            return true; // No topic constraint → visible
        if (!userTopicIds)
            return false; // User has no topics → not visible
        return userTopicIds.includes(dataTopicId);
    }
    if (scopeType === 'private') {
        if (!ownerId)
            return true; // No owner → legacy data, visible
        return ownerId === userId;
    }
    // Unknown scope type → fail closed (not visible)
    return false;
}
/**
 * Build a SQL WHERE clause fragment for privacy filtering.
 * Returns { clause, params } for composing into a larger query.
 *
 * The clause uses the column names from the table being queried:
 *   - ownerColumn: column containing the owner user ID (e.g., 'owner_id')
 *   - scopeColumn: column containing the privacy scope (e.g., 'privacy_scope')
 */
export function buildPrivacySqlFilter(userId, opts) {
    const ownerCol = opts?.ownerColumn ?? 'owner_id';
    const scopeCol = opts?.scopeColumn ?? 'privacy_scope';
    const topicIds = opts?.userTopicIds ?? [];
    // Legacy data (NULL scope) is visible to everyone
    // shared-project is visible to everyone
    // private is visible only to owner
    // shared-topic is visible if user is in the topic
    const conditions = [
        `${scopeCol} IS NULL`,
        `${scopeCol} = 'shared-project'`,
        `(${scopeCol} = 'private' AND ${ownerCol} = ?)`,
    ];
    const params = [userId];
    if (topicIds.length > 0) {
        const placeholders = topicIds.map(() => '?').join(',');
        conditions.push(`(${scopeCol} = 'shared-topic' AND topic_id IN (${placeholders}))`);
        params.push(...topicIds);
    }
    return {
        clause: `(${conditions.join(' OR ')})`,
        params,
    };
}
// ── Default Scopes ────────────────────────────────────────────────────
/**
 * Get the default privacy scope for new data based on context.
 *
 * - User conversations/memories: private (fail-closed)
 * - Agent observations about shared topics: shared-topic
 * - Agent knowledge (tool docs, project facts): shared-project
 */
export function defaultScope(source) {
    // Agent-generated knowledge defaults to shared
    if (source.startsWith('agent:') || source === 'observation' || source === 'migration') {
        return 'shared-project';
    }
    // User-sourced data defaults to private
    return 'private';
}
/**
 * Create a PrivacyScope for private user data.
 */
export function privateScope(ownerId) {
    return { type: 'private', ownerId };
}
/**
 * Create a PrivacyScope for data shared within a topic.
 */
export function sharedTopicScope(topicId, ownerId) {
    return { type: 'shared-topic', topicId, ownerId };
}
/**
 * Create a PrivacyScope for project-wide shared data.
 */
export function sharedProjectScope() {
    return { type: 'shared-project' };
}
// ── Onboarding State Machine ──────────────────────────────────────────
const VALID_ONBOARDING_TRANSITIONS = {
    'unknown': ['pending', 'authorized'], // New user starts onboarding, or admin pre-approves
    'pending': ['consented', 'rejected'], // User gives or withholds consent
    'consented': ['authorized'], // Consent recorded → authorization granted
    'rejected': ['pending'], // User can retry after rejecting
    'authorized': [], // Terminal state (cannot un-authorize)
};
/**
 * Check if an onboarding state transition is valid.
 */
export function isValidOnboardingTransition(from, to) {
    return VALID_ONBOARDING_TRANSITIONS[from]?.includes(to) ?? false;
}
/**
 * Create a new onboarding session.
 */
export function createOnboardingSession(telegramUserId, name, topicId) {
    const now = new Date().toISOString();
    return {
        telegramUserId,
        name,
        state: 'pending',
        startedAt: now,
        updatedAt: now,
        topicId,
        pendingMessageCount: 0,
    };
}
/**
 * Transition an onboarding session to a new state.
 * Returns the updated session, or null if the transition is invalid.
 */
export function transitionOnboarding(session, newState) {
    if (!isValidOnboardingTransition(session.state, newState)) {
        return null;
    }
    return {
        ...session,
        state: newState,
        updatedAt: new Date().toISOString(),
    };
}
// ── Constants ─────────────────────────────────────────────────────────
/** Maximum number of messages buffered while user is in 'pending' onboarding state */
export const MAX_PENDING_MESSAGES = 5;
/** Onboarding timeout in minutes — auto-reject if not completed */
export const ONBOARDING_TIMEOUT_MINUTES = 30;
//# sourceMappingURL=privacy.js.map