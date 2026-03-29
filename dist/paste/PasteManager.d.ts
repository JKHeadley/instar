/**
 * PasteManager — Drop Zone paste storage and delivery.
 *
 * Manages the lifecycle of user-submitted paste content:
 * write → notify → acknowledge, with file-based storage,
 * rate limiting, size caps, and automatic cleanup.
 */
export type PasteStatus = 'written' | 'notified' | 'acknowledged';
export interface PasteMetadata {
    pasteId: string;
    label?: string;
    from: 'dashboard' | 'telegram-relay' | 'api' | 'cli';
    timestamp: string;
    status: PasteStatus;
    targetSession?: string;
    contentLength: number;
    expiresAt: string;
    contentHash: string;
}
export interface PasteFile extends PasteMetadata {
    filePath: string;
}
export interface PendingPastesIndex {
    version: 1;
    pending: PendingPasteEntry[];
}
export interface PendingPasteEntry {
    pasteId: string;
    filePath: string;
    label?: string;
    contentLength: number;
    createdAt: string;
    expiresAt: string;
}
export interface PasteConfig {
    /** Directory for paste files */
    pasteDir: string;
    /** State directory (for pending-pastes.json) */
    stateDir: string;
    /** Project root (for gitignore enforcement) */
    projectDir: string;
    /** Max paste size in bytes (default: 10MB) */
    maxSizeBytes?: number;
    /** Retention in days (default: 7) */
    retentionDays?: number;
    /** Max pending items (default: 10) */
    maxPending?: number;
    /** Max directory size in bytes (default: 500MB) */
    maxDirSizeBytes?: number;
}
export interface CreatePasteResult {
    ok: true;
    pasteId: string;
    status: PasteStatus;
    sessionName?: string;
    contentLength: number;
    expiresAt: string;
}
export declare class PasteManager {
    private pasteDir;
    private stateDir;
    private projectDir;
    private maxSizeBytes;
    private retentionDays;
    private maxPending;
    private maxDirSizeBytes;
    private cleanupTimer;
    constructor(config: PasteConfig);
    /**
     * Create a new paste from user-submitted content.
     */
    create(content: string, options?: {
        label?: string;
        from?: PasteMetadata['from'];
        targetSession?: string;
    }): CreatePasteResult;
    /**
     * Get paste metadata by ID (without content).
     */
    getMeta(pasteId: string): PasteFile | null;
    /**
     * Get paste content by ID.
     */
    getContent(pasteId: string): {
        meta: PasteFile;
        content: string;
    } | null;
    /**
     * List all pastes (metadata only, sorted newest first).
     */
    list(): PasteFile[];
    /**
     * Delete a paste by ID.
     */
    delete(pasteId: string): boolean;
    /**
     * Update paste status (written → notified → acknowledged).
     */
    updateStatus(pasteId: string, status: PasteStatus): boolean;
    /**
     * Add a paste to the pending queue (for offline delivery).
     */
    addPending(paste: PasteFile): void;
    /**
     * Get pending pastes. Uses directory scan as ground truth,
     * falling back to the JSON index as a performance cache.
     */
    getPending(): PasteFile[];
    /**
     * Get the notification text that should be injected into a session.
     */
    buildNotification(paste: PasteFile): string;
    /**
     * Clean up expired paste files.
     */
    cleanup(): void;
    /**
     * Get directory size in bytes.
     */
    getDirectorySize(): number;
    /**
     * Get stats for the paste system.
     */
    getStats(): {
        totalPastes: number;
        pendingPastes: number;
        dirSizeBytes: number;
        dirSizeMB: number;
        maxSizeMB: number;
        retentionDays: number;
    };
    /**
     * Shut down — clear timers.
     */
    shutdown(): void;
    private findFileByPasteId;
    private readPasteMeta;
    private readPasteFull;
    private parseFrontmatter;
    private parseFrontmatterAndContent;
    private buildFrontmatter;
    private readPendingIndex;
    private writePendingIndex;
    private removePendingEntry;
    private rebuildPendingIndex;
    private enforceGitignore;
    private logAudit;
}
export declare class PasteError extends Error {
    code: string;
    statusCode: number;
    constructor(code: string, message: string, statusCode: number);
}
//# sourceMappingURL=PasteManager.d.ts.map