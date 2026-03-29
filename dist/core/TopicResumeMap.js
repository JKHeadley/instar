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
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
/** Entries older than 24 hours are pruned */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export class TopicResumeMap {
    filePath;
    projectDir;
    tmuxPath;
    constructor(stateDir, projectDir, tmuxPath) {
        this.filePath = path.join(stateDir, 'topic-resume-map.json');
        this.projectDir = projectDir;
        this.tmuxPath = tmuxPath || 'tmux';
    }
    /**
     * Compute the Claude Code project directory name for this project.
     * Claude Code hashes the project path by replacing '/' with '-' and
     * stripping dots — e.g. /Users/foo/.bar/baz → -Users-foo--bar-baz
     */
    claudeProjectDirName() {
        return this.projectDir.replace(/[\/\.]/g, '-');
    }
    /**
     * Get the full path to this project's Claude JSONL directory.
     */
    claudeProjectJsonlDir() {
        return path.join(os.homedir(), '.claude', 'projects', this.claudeProjectDirName());
    }
    /**
     * Discover the Claude session UUID from the most recent JSONL file
     * in THIS project's .claude/projects/ directory.
     *
     * Scoped to the current project to avoid cross-project UUID contamination.
     */
    findClaudeSessionUuid() {
        const projectJsonlDir = this.claudeProjectJsonlDir();
        if (!fs.existsSync(projectJsonlDir))
            return null;
        try {
            let latestFile = null;
            const files = fs.readdirSync(projectJsonlDir);
            for (const file of files) {
                if (!file.endsWith('.jsonl'))
                    continue;
                const filePath = path.join(projectJsonlDir, file);
                try {
                    const fileStat = fs.statSync(filePath);
                    if (!latestFile || fileStat.mtimeMs > latestFile.mtime) {
                        latestFile = { name: file, mtime: fileStat.mtimeMs };
                    }
                }
                catch {
                    // Skip inaccessible files
                }
            }
            if (!latestFile)
                return null;
            // Extract UUID from filename (format: {uuid}.jsonl)
            const basename = path.basename(latestFile.name, '.jsonl');
            // Validate UUID format (8-4-4-4-12)
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(basename)) {
                return basename;
            }
        }
        catch {
            // Silent failure — can't read Claude projects dir
        }
        return null;
    }
    /**
     * Find the Claude session UUID for a specific tmux session.
     *
     * Only uses the authoritative claudeSessionId from hook events.
     * The mtime-based heuristic was removed because it causes cross-topic
     * contamination when multiple sessions are active — it always picks
     * the most recent JSONL file regardless of which session it belongs to.
     */
    findUuidForSession(tmuxSession, claudeSessionId) {
        if (claudeSessionId && this.jsonlExists(claudeSessionId)) {
            return claudeSessionId;
        }
        // No authoritative source — refuse to guess. Better to fall back
        // to thread history than resume the wrong conversation.
        return null;
    }
    /**
     * Persist a resume mapping before killing an idle session.
     */
    save(topicId, uuid, sessionName) {
        const map = this.load();
        map[String(topicId)] = {
            uuid,
            savedAt: new Date().toISOString(),
            sessionName,
        };
        // Prune old entries
        const now = Date.now();
        for (const key of Object.keys(map)) {
            const entry = map[key];
            if (now - new Date(entry.savedAt).getTime() > MAX_AGE_MS) {
                delete map[key];
            }
        }
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(map, null, 2));
        }
        catch (err) {
            console.error(`[TopicResumeMap] Failed to save: ${err}`);
        }
    }
    /**
     * Look up a resume UUID for a topic. Returns null if not found,
     * expired, or the JSONL file no longer exists.
     */
    get(topicId) {
        const map = this.load();
        const entry = map[String(topicId)];
        if (!entry)
            return null;
        // Check age
        if (Date.now() - new Date(entry.savedAt).getTime() > MAX_AGE_MS) {
            return null;
        }
        // Verify the JSONL file still exists
        if (!this.jsonlExists(entry.uuid)) {
            return null;
        }
        return entry.uuid;
    }
    /**
     * Remove an entry after successful resume (prevents stale reuse).
     */
    remove(topicId) {
        const map = this.load();
        delete map[String(topicId)];
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(map, null, 2));
        }
        catch {
            // Best effort
        }
    }
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
    refreshResumeMappings(topicSessions) {
        try {
            if (!topicSessions || topicSessions.size === 0)
                return;
            const map = this.load();
            let updated = 0;
            // Count how many sessions have known UUIDs vs unknown
            const activeSessions = [];
            for (const [topicId, info] of topicSessions) {
                // Verify the tmux session is actually alive
                const hasSession = spawnSync(this.tmuxPath, ['has-session', '-t', `=${info.sessionName}`]);
                if (hasSession.status !== 0)
                    continue;
                activeSessions.push({ topicId, sessionName: info.sessionName, claudeSessionId: info.claudeSessionId });
            }
            if (activeSessions.length === 0)
                return;
            for (const { topicId, sessionName, claudeSessionId } of activeSessions) {
                let uuid = null;
                if (claudeSessionId && this.jsonlExists(claudeSessionId)) {
                    // Authoritative: Claude Code reported its own session ID via hooks
                    uuid = claudeSessionId;
                }
                else if (activeSessions.length === 1) {
                    // Single session fallback: mtime-based is safe when there's no ambiguity
                    uuid = this.findClaudeSessionUuid();
                }
                // With multiple sessions and no authoritative UUID, skip — don't guess
                if (!uuid)
                    continue;
                const topicKey = String(topicId);
                const existingEntry = map[topicKey];
                // Update if UUID changed, entry doesn't exist, or entry is stale (>2 hours)
                const entryAge = existingEntry ? Date.now() - new Date(existingEntry.savedAt).getTime() : Infinity;
                if (!existingEntry || existingEntry.uuid !== uuid || entryAge > 2 * 60 * 60 * 1000) {
                    map[topicKey] = {
                        uuid,
                        savedAt: new Date().toISOString(),
                        sessionName,
                    };
                    updated++;
                }
            }
            if (updated > 0) {
                // Prune entries older than 24 hours that aren't active
                const activeTopicKeys = new Set(activeSessions.map(s => String(s.topicId)));
                for (const key of Object.keys(map)) {
                    if (!activeTopicKeys.has(key) && Date.now() - new Date(map[key].savedAt).getTime() > MAX_AGE_MS) {
                        delete map[key];
                    }
                }
                try {
                    fs.writeFileSync(this.filePath, JSON.stringify(map, null, 2));
                }
                catch (err) {
                    console.error(`[TopicResumeMap] Failed to save heartbeat: ${err}`);
                }
            }
        }
        catch (err) {
            console.error('[TopicResumeMap] Resume heartbeat error:', err);
        }
    }
    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            }
        }
        catch {
            // Corrupted file — start fresh
        }
        return {};
    }
    /**
     * Check if a JSONL file exists for the given UUID in this project's directory.
     */
    jsonlExists(uuid) {
        const jsonlPath = path.join(this.claudeProjectJsonlDir(), `${uuid}.jsonl`);
        try {
            return fs.existsSync(jsonlPath);
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=TopicResumeMap.js.map