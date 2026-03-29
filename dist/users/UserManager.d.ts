/**
 * User Manager — multi-user identity resolution.
 *
 * Maps incoming messages to known users based on their channels.
 * Same agent, same repo, different relationship per user.
 */
import type { UserProfile, UserChannel, Message } from '../core/types.js';
export declare class UserManager {
    private users;
    private channelIndex;
    private usersFile;
    constructor(stateDir: string, initialUsers?: UserProfile[]);
    /**
     * Resolve a user from an incoming message.
     * Returns the user profile if the sender is recognized.
     */
    resolveFromMessage(message: Message): UserProfile | null;
    /**
     * Resolve a user from a channel identifier.
     */
    resolveFromChannel(channel: UserChannel): UserProfile | null;
    /**
     * Resolve a user by their Telegram numeric user ID.
     * Scans all profiles for matching telegramUserId field.
     *
     * This is the primary resolution path for incoming Telegram messages,
     * since telegramUserId is stored as a direct field on UserProfile
     * (not a channel — channels use topic IDs).
     */
    resolveFromTelegramUserId(telegramUserId: number): UserProfile | null;
    /**
     * Get a user by ID.
     */
    getUser(userId: string): UserProfile | null;
    /**
     * List all registered users.
     */
    listUsers(): UserProfile[];
    /**
     * Add or update a user.
     */
    upsertUser(profile: UserProfile): void;
    /**
     * Remove a user.
     */
    removeUser(userId: string): boolean;
    /**
     * Check if a user has a specific permission.
     */
    hasPermission(userId: string, permission: string): boolean;
    /**
     * Add a user interactively (with defaults applied).
     * Returns the full profile.
     */
    addUserInteractive(partialProfile: Partial<UserProfile> & {
        id: string;
        name: string;
    }): UserProfile;
    /**
     * List users formatted for wizard display.
     * Returns name + id pairs suitable for selection prompts.
     */
    listUsersForSelection(): Array<{
        name: string;
        value: string;
        description: string;
    }>;
    /**
     * Find admin users.
     */
    getAdmins(): UserProfile[];
    private validateProfile;
    private loadUsers;
    private persistUsers;
}
//# sourceMappingURL=UserManager.d.ts.map