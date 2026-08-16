/**
 * GDPR Data Access Commands — /mydata and /forget
 *
 * Implements GDPR Article 15 (Right of Access) and Article 17 (Right to Erasure)
 * across all memory stores (TopicMemory + SemanticMemory).
 *
 * Usage:
 *   /mydata  — Export all data associated with a user
 *   /forget  — Delete all data associated with a user
 *
 * Design principles:
 *   - Fail-closed: if a memory store is unavailable, report it rather than silently skip
 *   - Audit trail: all operations are logged with timestamps
 *   - Idempotent: running /forget twice is safe
 *   - User-scoped: only affects data owned by the requesting user
 */
import type { UserDataExport, UserErasureResult, UserProfile } from '../core/types.js';
import type { TopicMemory } from '../memory/TopicMemory.js';
import type { SemanticMemory } from '../memory/SemanticMemory.js';
export interface GdprCommandDeps {
    topicMemory?: TopicMemory;
    semanticMemory?: SemanticMemory;
    /** User profile for the export (optional — included when available) */
    userProfile?: UserProfile;
}
/**
 * Export all data for a user across all memory stores.
 * Implements GDPR Article 15 (Right of Access).
 */
export declare function exportUserData(userId: string, deps: GdprCommandDeps): UserDataExport;
/**
 * Delete all data for a user across all memory stores.
 * Implements GDPR Article 17 (Right to Erasure).
 */
export declare function eraseUserData(userId: string, deps: GdprCommandDeps): UserErasureResult;
/**
 * Format a user data export for display (e.g., in a Telegram message).
 */
export declare function formatExportSummary(data: UserDataExport): string;
/**
 * Format an erasure result for display.
 */
export declare function formatErasureSummary(result: UserErasureResult): string;
//# sourceMappingURL=GdprCommands.d.ts.map