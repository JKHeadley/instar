/**
 * Platform-agnostic session-channel registry.
 *
 * Extracted from TelegramAdapter as part of Phase 1 shared infrastructure.
 * Maps channels (topics, chats, etc.) to sessions bidirectionally.
 * Persists to disk as JSON for crash recovery.
 */
import fs from 'node:fs';
import path from 'node:path';
export class SessionChannelRegistry {
    channelToSession = new Map();
    sessionToChannel = new Map();
    channelToName = new Map();
    channelToPurpose = new Map();
    registryPath;
    constructor(config) {
        this.registryPath = config.registryPath;
        // Ensure directory exists
        const dir = path.dirname(this.registryPath);
        fs.mkdirSync(dir, { recursive: true });
        this.load();
    }
    register(channelId, sessionName, channelName) {
        this.channelToSession.set(channelId, sessionName);
        this.sessionToChannel.set(sessionName, channelId);
        if (channelName) {
            this.channelToName.set(channelId, channelName);
        }
        this.save();
    }
    unregister(channelId) {
        const sessionName = this.channelToSession.get(channelId);
        this.channelToSession.delete(channelId);
        if (sessionName)
            this.sessionToChannel.delete(sessionName);
        this.save();
    }
    getSessionForChannel(channelId) {
        return this.channelToSession.get(channelId) ?? null;
    }
    getChannelForSession(sessionName) {
        return this.sessionToChannel.get(sessionName) ?? null;
    }
    getChannelName(channelId) {
        return this.channelToName.get(channelId) ?? null;
    }
    setChannelName(channelId, name) {
        this.channelToName.set(channelId, name);
        this.save();
    }
    getChannelPurpose(channelId) {
        return this.channelToPurpose.get(channelId) ?? null;
    }
    setChannelPurpose(channelId, purpose) {
        this.channelToPurpose.set(channelId, purpose.toLowerCase());
        this.save();
    }
    /**
     * Get all active channel-session mappings.
     */
    getAllMappings() {
        const result = [];
        for (const [channelId, sessionName] of this.channelToSession) {
            result.push({
                channelId,
                sessionName,
                channelName: this.channelToName.get(channelId) ?? null,
                channelPurpose: this.channelToPurpose.get(channelId) ?? null,
            });
        }
        return result;
    }
    /**
     * Get all channel-session pairs as a Map (used by heartbeat/monitoring).
     */
    getAllChannelSessions() {
        return new Map(this.channelToSession);
    }
    /**
     * Get count of registered mappings.
     */
    get size() {
        return this.channelToSession.size;
    }
    load() {
        try {
            if (!fs.existsSync(this.registryPath))
                return;
            const data = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8'));
            // Support both new format (channelToSession) and legacy (topicToSession)
            const sessionMap = data.channelToSession ?? data.topicToSession;
            if (sessionMap) {
                for (const [k, v] of Object.entries(sessionMap)) {
                    this.channelToSession.set(String(k), v);
                    this.sessionToChannel.set(v, String(k));
                }
            }
            const nameMap = data.channelToName ?? data.topicToName;
            if (nameMap) {
                for (const [k, v] of Object.entries(nameMap)) {
                    this.channelToName.set(String(k), v);
                }
            }
            const purposeMap = data.channelToPurpose ?? data.topicToPurpose;
            if (purposeMap) {
                for (const [k, v] of Object.entries(purposeMap)) {
                    this.channelToPurpose.set(String(k), v);
                }
            }
        }
        catch {
            // File doesn't exist yet — start fresh
        }
    }
    save() {
        try {
            const data = {
                channelToSession: Object.fromEntries(this.channelToSession),
                channelToName: Object.fromEntries(this.channelToName),
                channelToPurpose: Object.fromEntries(this.channelToPurpose),
                // Write legacy keys too for backward compatibility during migration
                topicToSession: Object.fromEntries(this.channelToSession),
                topicToName: Object.fromEntries(this.channelToName),
                topicToPurpose: Object.fromEntries(this.channelToPurpose),
            };
            const tmpPath = this.registryPath + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
            try {
                fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
                fs.renameSync(tmpPath, this.registryPath);
            }
            catch (writeErr) {
                try {
                    fs.unlinkSync(tmpPath);
                }
                catch { /* ignore */ }
                throw writeErr;
            }
        }
        catch (err) {
            console.error(`[session-channel-registry] Failed to save registry: ${err}`);
        }
    }
}
//# sourceMappingURL=SessionChannelRegistry.js.map