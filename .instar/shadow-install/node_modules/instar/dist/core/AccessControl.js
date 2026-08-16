/**
 * AccessControl — Role-Based Access Control for multi-user sync.
 *
 * Three roles with escalating permissions:
 *   - Contributor: code changes via branches only
 *   - Maintainer: code + limited config, direct branch merge
 *   - Admin: full control including force-resolve and config changes
 *
 * From INTELLIGENT_SYNC_SPEC Section 5.5 (Access Control).
 */
// ── Constants ────────────────────────────────────────────────────────
/**
 * Permission matrix per spec Section 5.5.
 */
const ROLE_PERMISSIONS = {
    admin: new Set([
        'code:modify',
        'code:merge-to-main',
        'config:read',
        'config:modify',
        'agent-state:modify',
        'conflict:force-resolve',
        'branch:create',
        'branch:merge',
        'ledger:write-own',
        'ledger:write-any',
    ]),
    maintainer: new Set([
        'code:modify',
        'code:merge-to-main',
        'config:read',
        'branch:create',
        'branch:merge',
        'ledger:write-own',
    ]),
    contributor: new Set([
        'code:modify',
        'config:read',
        'branch:create',
        'ledger:write-own',
    ]),
};
/**
 * Human-readable permission descriptions for error messages.
 */
const PERMISSION_DESCRIPTIONS = {
    'code:modify': 'Modify code files',
    'code:merge-to-main': 'Merge directly to main branch',
    'config:read': 'Read configuration',
    'config:modify': 'Modify configuration',
    'agent-state:modify': 'Modify agent state',
    'conflict:force-resolve': 'Force-resolve conflicts (skip LLM resolution)',
    'branch:create': 'Create task branches',
    'branch:merge': 'Merge task branches',
    'ledger:write-own': 'Write own ledger entries',
    'ledger:write-any': "Write any machine's ledger entries",
};
/**
 * Suggestions for denied permissions.
 */
const DENIAL_SUGGESTIONS = {
    'code:merge-to-main': {
        contributor: 'Use a task branch and submit through tiered resolution instead',
    },
    'config:modify': {
        contributor: 'Request an admin to make config changes',
        maintainer: 'Request an admin to make config changes',
    },
    'conflict:force-resolve': {
        contributor: 'Use the tiered resolution system (Tier 0 → Tier 2)',
        maintainer: 'Use the tiered resolution system (Tier 0 → Tier 2)',
    },
    'agent-state:modify': {
        contributor: 'Only admins can modify agent state',
        maintainer: 'Only admins can modify agent state',
    },
};
// ── AccessControl ────────────────────────────────────────────────────
export class AccessControl {
    roles;
    defaultRole;
    enabled;
    constructor(config) {
        this.roles = new Map();
        for (const entry of config.roles) {
            this.roles.set(entry.userId, entry);
        }
        this.defaultRole = config.defaultRole ?? 'contributor';
        this.enabled = config.enabled ?? true;
    }
    // ── Permission Checks ─────────────────────────────────────────────
    /**
     * Check if a user has a specific permission.
     */
    check(userId, permission) {
        // If RBAC is disabled, allow everything
        if (!this.enabled) {
            return {
                allowed: true,
                role: this.getUserRole(userId),
                permission,
            };
        }
        const role = this.getUserRole(userId);
        const allowed = ROLE_PERMISSIONS[role].has(permission);
        if (allowed) {
            return { allowed: true, role, permission };
        }
        const suggestion = DENIAL_SUGGESTIONS[permission]?.[role];
        return {
            allowed: false,
            role,
            permission,
            reason: `Role "${role}" does not have permission "${permission}" (${PERMISSION_DESCRIPTIONS[permission]})`,
            suggestion,
        };
    }
    /**
     * Check multiple permissions at once.
     * Returns true only if ALL permissions are granted.
     */
    checkAll(userId, permissions) {
        const results = permissions.map(p => this.check(userId, p));
        return {
            allowed: results.every(r => r.allowed),
            results,
        };
    }
    /**
     * Check if a user has ANY of the given permissions.
     */
    checkAny(userId, permissions) {
        const results = permissions.map(p => this.check(userId, p));
        return {
            allowed: results.some(r => r.allowed),
            results,
        };
    }
    // ── Role Management ───────────────────────────────────────────────
    /**
     * Get a user's role.
     */
    getUserRole(userId) {
        return this.roles.get(userId)?.role ?? this.defaultRole;
    }
    /**
     * Set a user's role (requires admin).
     */
    setUserRole(adminUserId, targetUserId, newRole) {
        // Verify admin has permission
        if (this.enabled) {
            const adminRole = this.getUserRole(adminUserId);
            if (adminRole !== 'admin') {
                return { success: false, error: 'Only admins can assign roles' };
            }
        }
        this.roles.set(targetUserId, {
            userId: targetUserId,
            role: newRole,
            assignedAt: new Date().toISOString(),
            assignedBy: adminUserId,
        });
        return { success: true };
    }
    /**
     * List all role assignments.
     */
    listRoles() {
        return [...this.roles.values()];
    }
    /**
     * Get all permissions for a role.
     */
    getPermissionsForRole(role) {
        return [...ROLE_PERMISSIONS[role]];
    }
    /**
     * Check if RBAC is enabled.
     */
    isEnabled() {
        return this.enabled;
    }
}
//# sourceMappingURL=AccessControl.js.map