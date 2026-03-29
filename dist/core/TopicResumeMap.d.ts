/**
 * TopicResumeMap — Persistent mapping from Telegram topic IDs to Claude session UUIDs.
 *
 * Before killing an idle interactive session, the system persists the Claude
 * session UUID so it can be resumed when the next message arrives on that topic.
 * This avoids cold-starting sessions (rebuilding context from topic history)
 * and provides seamless conversational continuity.
 *
 * Storage: {stateDir}/topic-resume-map.json
 * Entries auto-prune after 24 hours.
 */
export declare class TopicResumeMap {
    private filePath;
    private projectDir;
    private tmuxPath;
    constructor(stateDir: string, projectDir: string, tmuxPath?: string);
    /**
     * Compute the Claude Code project directory name for this project.
     * Claude Code hashes the project path by replacing '/' with '-' and
     * stripping dots — e.g. /Users/foo/.bar/baz → -Users-foo--bar-baz
     */
    private claudeProjectDirName;
    /**
     * Get the full path to this project's Claude JSONL directory.
     */
    private claudeProjectJsonlDir;
    /**
     * Discover the Claude session UUID from the most recent JSONL file
     * in THIS project's .claude/projects/ directory.
     *
     * Scoped to the current project to avoid cross-project UUID contamination.
     */
    findClaudeSessionUuid(): string | null;
    /**
     * Find the Claude session UUID for a specific tmux session.
     *
     * Only uses the authoritative claudeSessionId from hook events.
     * The mtime-based heuristic was removed because it causes cross-topic
     * contamination when multiple sessions are active — it always picks
     * the most recent JSONL file regardless of which session it belongs to.
     */
    findUuidForSession(tmuxSession: string, claudeSessionId?: string): string | null;
    /**
     * Persist a resume mapping before killing an idle session.
     */
    save(topicId: number, uuid: string, sessionName: string): void;
    /**
     * Look up a resume UUID for a topic. Returns null if not found,
     * expired, or the JSONL file no longer exists.
     */
    get(topicId: number): string | null;
    /**
     * Remove an entry after successful resume (prevents stale reuse).
     */
    remove(topicId: number): void;
    /**
     * Proactive resume heartbeat: update the topic→UUID mapping for all active
     * topic-linked sessions. Called periodically (e.g., every 60s).
     *
     * Uses authoritative Claude session IDs from hook events when available.
     * Only falls back to mtime-based JSONL scanning when there's exactly one
     * active session (no cross-topic contamination risk).
     *
     * @param topicSessions - Map of topicId → { sessionName, claudeSessionId? }
     */
    refreshResumeMappings(topicSessions: Map<number, {
        sessionName: string;
        claudeSessionId?: string;
    }>): void;
    private load;
    /**
     * Check if a JSONL file exists for the given UUID in this project's directory.
     */
    private jsonlExists;
}
//# sourceMappingURL=TopicResumeMap.d.ts.map