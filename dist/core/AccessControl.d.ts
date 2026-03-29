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
export type UserRole = 'admin' | 'maintainer' | 'contributor';
export type Permission = 'code:modify' | 'code:merge-to-main' | 'config:read' | 'config:modify' | 'agent-state:modify' | 'conflict:force-resolve' | 'branch:create' | 'branch:merge' | 'ledger:write-own' | 'ledger:write-any';
export interface AccessCheckResult {
    /** Whether the action is allowed. */
    allowed: boolean;
    /** The user's role. */
    role: UserRole;
    /** The permission that was checked. */
    permission: Permission;
    /** Reason for denial, if not allowed. */
    reason?: string;
    /** Suggested alternative action. */
    suggestion?: string;
}
export interface UserRoleEntry {
    /** User ID. */
    userId: string;
    /** Assigned role. */
    role: UserRole;
    /** When the role was assigned. */
    assignedAt: string;
    /** Who assigned the role (userId or 'system'). */
    assignedBy: string;
}
export interface AccessControlConfig {
    /** User role assignments. */
    roles: UserRoleEntry[];
    /** Default role for unknown users (default: 'contributor'). */
    defaultRole?: UserRole;
    /** Whether RBAC is enabled (false = all permissions granted). */
    enabled?: boolean;
}
export declare class AccessControl {
    private roles;
    private defaultRole;
    private enabled;
    constructor(config: AccessControlConfig);
    /**
     * Check if a user has a specific permission.
     */
    check(userId: string, permission: Permission): AccessCheckResult;
    /**
     * Check multiple permissions at once.
     * Returns true only if ALL permissions are granted.
     */
    checkAll(userId: string, permissions: Permission[]): {
        allowed: boolean;
        results: AccessCheckResult[];
    };
    /**
     * Check if a user has ANY of the given permissions.
     */
    checkAny(userId: string, permissions: Permission[]): {
        allowed: boolean;
        results: AccessCheckResult[];
    };
    /**
     * Get a user's role.
     */
    getUserRole(userId: string): UserRole;
    /**
     * Set a user's role (requires admin).
     */
    setUserRole(adminUserId: string, targetUserId: string, newRole: UserRole): {
        success: boolean;
        error?: string;
    };
    /**
     * List all role assignments.
     */
    listRoles(): UserRoleEntry[];
    /**
     * Get all permissions for a role.
     */
    getPermissionsForRole(role: UserRole): Permission[];
    /**
     * Check if RBAC is enabled.
     */
    isEnabled(): boolean;
}
//# sourceMappingURL=AccessControl.d.ts.map