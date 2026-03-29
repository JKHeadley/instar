/**
 * RegistryStore — SQLite-backed persistent agent registry with FTS5 search.
 *
 * Implements the Threadline Agent Registry Specification v0.2.0.
 * Stores agent profiles keyed by Ed25519 public key with full-text search
 * across name, bio, interests, and capabilities.
 *
 * Part of Threadline Relay Phase 1.1.
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
// ── FTS5 Query Sanitization ─────────────────────────────────────────
export function sanitizeFTS5Query(q) {
    let sanitized = q
        .replace(/[*"^():{}\[\]\-]/g, ' ') // strip special chars (incl. hyphen — FTS5 interprets as column filter)
        .replace(/\b(NEAR|AND|OR|NOT)\b/gi, ' ') // strip operators
        .replace(/\s+/g, ' ') // collapse whitespace
        .trim();
    if (!sanitized)
        return '';
    // Quote each token to prevent FTS5 column-filter interpretation
    const tokens = sanitized.split(' ').filter(Boolean);
    return tokens.map(t => `"${t}"`).join(' ');
}
// ── Unicode Sanitization ─────────────────────────────────────────────
function sanitizeUnicode(text) {
    return text
        .normalize('NFC')
        // Strip zero-width characters
        .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
        // Strip RTL/LTR override characters
        .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
        .trim();
}
function validateName(name) {
    const sanitized = sanitizeUnicode(name);
    if (sanitized.length > 64)
        return sanitized.substring(0, 64);
    return sanitized;
}
function validateBio(bio) {
    const sanitized = sanitizeUnicode(bio);
    if (sanitized.length > 500)
        return sanitized.substring(0, 500);
    return sanitized;
}
function validateTag(tag) {
    return tag.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, 32);
}
function validateTags(tags, max = 20) {
    return tags.slice(0, max).map(validateTag).filter(t => t.length > 0);
}
function validateHomepage(url) {
    if (!url)
        return '';
    if (url.length > 256)
        return '';
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:')
            return '';
        return url;
    }
    catch {
        return '';
    }
}
function encodeCursor(data) {
    return Buffer.from(JSON.stringify(data)).toString('base64url');
}
function decodeCursor(cursor) {
    try {
        const data = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (!data.publicKey || !data.lastSeen)
            return null;
        // Cursor expires after 5 minutes
        if (data.createdAt && Date.now() - data.createdAt > 5 * 60 * 1000)
            return null;
        return data;
    }
    catch {
        return null;
    }
}
// ── RegistryStore ────────────────────────────────────────────────────
export class RegistryStore {
    db;
    relayId;
    statsCache = null;
    staleCronTimer = null;
    constructor(config) {
        this.relayId = config.relayId;
        // Ensure data directory exists
        const dbDir = config.dataDir;
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        const dbPath = path.join(dbDir, 'registry.db');
        this.db = new Database(dbPath);
        // Enable WAL mode
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('synchronous = NORMAL');
        this.initSchema();
        this.resetOnlineStatus();
        // Start stale cleanup cron (every 24 hours)
        this.staleCronTimer = setInterval(() => this.runStaleCron(), 24 * 60 * 60 * 1000);
    }
    initSchema() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        public_key TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        bio TEXT NOT NULL DEFAULT '',
        interests TEXT NOT NULL DEFAULT '[]',
        capabilities TEXT NOT NULL DEFAULT '[]',
        framework TEXT NOT NULL DEFAULT 'unknown',
        framework_visible INTEGER NOT NULL DEFAULT 0,
        homepage TEXT NOT NULL DEFAULT '',
        visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted')),
        relay_id TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        last_updated TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        stale INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        consent_method TEXT NOT NULL DEFAULT 'unknown',
        verified INTEGER NOT NULL DEFAULT 0,
        verified_domain TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_agents_agent_id ON agents(agent_id);
      CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);
      CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen);
      CREATE INDEX IF NOT EXISTS idx_agents_online ON agents(online) WHERE deleted = 0;
    `);
        // Create FTS5 table if it doesn't exist
        // Check if it exists first (FTS5 virtual tables can't use IF NOT EXISTS in all SQLite versions)
        const ftsExists = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents_fts'").get();
        if (!ftsExists) {
            this.db.exec(`
        CREATE VIRTUAL TABLE agents_fts USING fts5(
          name, bio, interests, capabilities,
          content='agents',
          content_rowid='rowid'
        );

        -- FTS5 sync triggers
        CREATE TRIGGER agents_ai AFTER INSERT ON agents BEGIN
          INSERT INTO agents_fts(rowid, name, bio, interests, capabilities)
          VALUES (new.rowid, new.name, new.bio, new.interests, new.capabilities);
        END;

        CREATE TRIGGER agents_ad AFTER DELETE ON agents BEGIN
          INSERT INTO agents_fts(agents_fts, rowid, name, bio, interests, capabilities)
          VALUES ('delete', old.rowid, old.name, old.bio, old.interests, old.capabilities);
        END;

        CREATE TRIGGER agents_au AFTER UPDATE ON agents BEGIN
          INSERT INTO agents_fts(agents_fts, rowid, name, bio, interests, capabilities)
          VALUES ('delete', old.rowid, old.name, old.bio, old.interests, old.capabilities);
          INSERT INTO agents_fts(rowid, name, bio, interests, capabilities)
          VALUES (new.rowid, new.name, new.bio, new.interests, new.capabilities);
        END;
      `);
        }
    }
    /**
     * Reset all online flags on startup (crash recovery).
     */
    resetOnlineStatus() {
        this.db.prepare('UPDATE agents SET online = 0 WHERE online = 1').run();
    }
    // ── Registration ─────────────────────────────────────────────────
    /**
     * Register or update an agent in the registry.
     */
    upsert(params) {
        const now = new Date().toISOString();
        const name = validateName(params.name);
        const bio = validateBio(params.bio);
        const interests = validateTags(params.interests);
        const capabilities = validateTags(params.capabilities);
        const framework = validateTag(params.framework) || 'unknown';
        const homepage = validateHomepage(params.homepage ?? '');
        const visibility = params.visibility ?? 'public';
        const frameworkVisible = params.frameworkVisible ? 1 : 0;
        const existing = this.db.prepare('SELECT public_key, registered_at, version FROM agents WHERE public_key = ?').get(params.publicKey);
        if (existing) {
            this.db.prepare(`
        UPDATE agents SET
          name = ?, bio = ?, interests = ?, capabilities = ?,
          framework = ?, framework_visible = ?, homepage = ?,
          visibility = ?, last_seen = ?, last_updated = ?,
          online = 1, stale = 0, deleted = 0,
          consent_method = ?, version = version + 1
        WHERE public_key = ?
      `).run(name, bio, JSON.stringify(interests), JSON.stringify(capabilities), framework, frameworkVisible, homepage, visibility, now, now, params.consentMethod, params.publicKey);
        }
        else {
            this.db.prepare(`
        INSERT INTO agents (
          public_key, agent_id, name, bio, interests, capabilities,
          framework, framework_visible, homepage, visibility,
          relay_id, registered_at, last_seen, last_updated,
          online, consent_method
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(params.publicKey, params.agentId, name, bio, JSON.stringify(interests), JSON.stringify(capabilities), framework, frameworkVisible, homepage, visibility, this.relayId, now, now, now, params.consentMethod);
        }
        return this.getByPublicKey(params.publicKey);
    }
    /**
     * Update specific fields of an agent's registry entry.
     */
    update(publicKey, fields) {
        const existing = this.getByPublicKey(publicKey);
        if (!existing)
            return null;
        const now = new Date().toISOString();
        const updates = [];
        const values = [];
        if (fields.name !== undefined) {
            updates.push('name = ?');
            values.push(validateName(fields.name));
        }
        if (fields.bio !== undefined) {
            updates.push('bio = ?');
            values.push(validateBio(fields.bio));
        }
        if (fields.interests !== undefined) {
            updates.push('interests = ?');
            values.push(JSON.stringify(validateTags(fields.interests)));
        }
        if (fields.capabilities !== undefined) {
            updates.push('capabilities = ?');
            values.push(JSON.stringify(validateTags(fields.capabilities)));
        }
        if (fields.homepage !== undefined) {
            updates.push('homepage = ?');
            values.push(validateHomepage(fields.homepage));
        }
        if (fields.visibility !== undefined) {
            updates.push('visibility = ?');
            values.push(fields.visibility);
        }
        if (fields.frameworkVisible !== undefined) {
            updates.push('framework_visible = ?');
            values.push(fields.frameworkVisible ? 1 : 0);
        }
        if (updates.length === 0)
            return existing;
        updates.push('last_updated = ?');
        values.push(now);
        updates.push('version = version + 1');
        values.push(publicKey);
        this.db.prepare(`UPDATE agents SET ${updates.join(', ')} WHERE public_key = ?`).run(...values);
        return this.getByPublicKey(publicKey);
    }
    // ── Lookups ──────────────────────────────────────────────────────
    getByPublicKey(publicKey) {
        const row = this.db.prepare('SELECT * FROM agents WHERE public_key = ? AND deleted = 0').get(publicKey);
        if (!row)
            return null;
        return this.rowToEntry(row);
    }
    getByAgentId(agentId) {
        const row = this.db.prepare('SELECT * FROM agents WHERE agent_id = ? AND deleted = 0 ORDER BY last_seen DESC LIMIT 1').get(agentId);
        if (!row)
            return null;
        return this.rowToEntry(row);
    }
    /**
     * Check if agentId is ambiguous (maps to multiple public keys).
     */
    isAgentIdAmbiguous(agentId) {
        const count = this.db.prepare('SELECT COUNT(*) as cnt FROM agents WHERE agent_id = ? AND deleted = 0').get(agentId);
        return count.cnt > 1;
    }
    // ── Search ───────────────────────────────────────────────────────
    search(params) {
        const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
        const hasQ = params.q && sanitizeFTS5Query(params.q);
        const conditions = ['a.deleted = 0', "a.visibility = 'public'"];
        const bindings = [];
        // Cursor-based pagination
        let cursorData = null;
        if (params.cursor) {
            cursorData = decodeCursor(params.cursor);
            if (!cursorData) {
                return { count: 0, total: 0, agents: [], pagination: { cursor: null, hasMore: false } };
            }
        }
        // Build filter conditions
        if (params.online !== undefined) {
            conditions.push('a.online = ?');
            bindings.push(params.online ? 1 : 0);
        }
        if (params.capability) {
            const caps = params.capability.split(',').map(c => c.trim().toLowerCase());
            const capConditions = caps.map(() => "a.capabilities LIKE ?");
            conditions.push(`(${capConditions.join(' OR ')})`);
            for (const cap of caps) {
                bindings.push(`%"${cap}"%`);
            }
        }
        if (params.interest) {
            const ints = params.interest.split(',').map(i => i.trim().toLowerCase());
            const intConditions = ints.map(() => "a.interests LIKE ?");
            conditions.push(`(${intConditions.join(' OR ')})`);
            for (const int of ints) {
                bindings.push(`%"${int}"%`);
            }
        }
        if (params.framework) {
            conditions.push('a.framework = ? AND a.framework_visible = 1');
            bindings.push(params.framework.toLowerCase());
        }
        let query;
        let countQuery;
        const where = conditions.join(' AND ');
        if (hasQ) {
            const sanitizedQ = sanitizeFTS5Query(params.q);
            // FTS5 search with ranking
            query = `
        SELECT a.*, rank FROM agents a
        JOIN agents_fts ON agents_fts.rowid = a.rowid
        WHERE agents_fts MATCH ? AND ${where}
      `;
            countQuery = `
        SELECT COUNT(*) as total FROM agents a
        JOIN agents_fts ON agents_fts.rowid = a.rowid
        WHERE agents_fts MATCH ? AND ${where}
      `;
            bindings.unshift(sanitizedQ);
            if (cursorData) {
                query += ' AND (a.last_seen < ? OR (a.last_seen = ? AND a.public_key > ?))';
                bindings.push(cursorData.lastSeen, cursorData.lastSeen, cursorData.publicKey);
            }
            const sort = params.sort === 'relevance' || !params.sort ? 'rank' : `a.${params.sort === 'lastSeen' ? 'last_seen' : params.sort === 'registeredAt' ? 'registered_at' : 'name'}`;
            if (sort === 'rank') {
                query += ' ORDER BY rank';
            }
            else {
                query += ` ORDER BY ${sort} DESC, a.public_key`;
            }
        }
        else {
            query = `SELECT a.* FROM agents a WHERE ${where}`;
            countQuery = `SELECT COUNT(*) as total FROM agents a WHERE ${where}`;
            if (cursorData) {
                query += ' AND (a.last_seen < ? OR (a.last_seen = ? AND a.public_key > ?))';
                bindings.push(cursorData.lastSeen, cursorData.lastSeen, cursorData.publicKey);
            }
            const sort = params.sort === 'lastSeen' || !params.sort ? 'a.last_seen' : params.sort === 'registeredAt' ? 'a.registered_at' : 'a.name';
            query += ` ORDER BY ${sort} DESC, a.public_key`;
        }
        query += ' LIMIT ?';
        const queryBindings = [...bindings, limit + 1]; // +1 to detect hasMore
        // Get total count (without cursor/limit)
        const countBindings = hasQ ? bindings.slice(0, bindings.length - (cursorData ? 3 : 0)) : bindings.slice(0, bindings.length - (cursorData ? 3 : 0));
        const totalRow = this.db.prepare(countQuery).get(...countBindings);
        const rows = this.db.prepare(query).all(...queryBindings);
        const hasMore = rows.length > limit;
        const agents = rows.slice(0, limit).map(r => this.rowToEntry(r));
        let nextCursor = null;
        if (hasMore && agents.length > 0) {
            const last = agents[agents.length - 1];
            nextCursor = encodeCursor({
                lastSeen: last.lastSeen,
                publicKey: last.publicKey,
                createdAt: Date.now(),
            });
        }
        return {
            count: agents.length,
            total: totalRow.total,
            agents,
            pagination: { cursor: nextCursor, hasMore },
        };
    }
    // ── Online Status ────────────────────────────────────────────────
    setOnline(publicKey) {
        this.db.prepare('UPDATE agents SET online = 1, last_seen = ?, stale = 0 WHERE public_key = ?').run(new Date().toISOString(), publicKey);
    }
    setOffline(publicKey) {
        this.db.prepare('UPDATE agents SET online = 0 WHERE public_key = ?').run(publicKey);
    }
    updateLastSeen(publicKey) {
        this.db.prepare('UPDATE agents SET last_seen = ?, stale = 0 WHERE public_key = ? AND deleted = 0').run(new Date().toISOString(), publicKey);
    }
    // ── Deletion ─────────────────────────────────────────────────────
    /**
     * Agent-initiated hard delete (GDPR compliant).
     * Immediately removes from search; fully purged from DB.
     */
    hardDelete(publicKey) {
        const result = this.db.prepare('DELETE FROM agents WHERE public_key = ?').run(publicKey);
        this.statsCache = null; // Invalidate stats cache
        return result.changes > 0;
    }
    // ── Stats ────────────────────────────────────────────────────────
    getStats() {
        const now = Date.now();
        if (this.statsCache && now - this.statsCache.cachedAt < 60_000) {
            return this.statsCache.data;
        }
        const totals = this.db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE deleted = 0) as total,
        COUNT(*) FILTER (WHERE deleted = 0 AND online = 1) as online_count
      FROM agents
    `).get();
        const frameworkStats = this.db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE framework_visible = 1) as disclosed,
        COUNT(*) FILTER (WHERE framework_visible = 0) as hidden
      FROM agents WHERE deleted = 0
    `).get();
        // Top capabilities — parse JSON arrays and aggregate
        const allAgents = this.db.prepare('SELECT capabilities FROM agents WHERE deleted = 0').all();
        const capCounts = new Map();
        for (const row of allAgents) {
            try {
                const caps = JSON.parse(row.capabilities);
                for (const cap of caps) {
                    capCounts.set(cap, (capCounts.get(cap) ?? 0) + 1);
                }
            }
            catch { /* skip malformed */ }
        }
        const topCapabilities = [...capCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([capability, count]) => ({ capability, count }));
        const recent = this.db.prepare(`
      SELECT
        COUNT(*) FILTER (WHERE registered_at > datetime('now', '-1 day')) as last24h,
        COUNT(*) FILTER (WHERE registered_at > datetime('now', '-7 days')) as last7d
      FROM agents WHERE deleted = 0
    `).get();
        const data = {
            totalAgents: totals.total,
            onlineAgents: totals.online_count,
            frameworkStats: { disclosed: frameworkStats.disclosed, hidden: frameworkStats.hidden },
            topCapabilities,
            registeredLast24h: recent.last24h,
            registeredLast7d: recent.last7d,
            cachedAt: new Date().toISOString(),
        };
        this.statsCache = { data, cachedAt: now };
        return data;
    }
    // ── Health ───────────────────────────────────────────────────────
    getHealth() {
        const stats = this.getStats();
        // Check FTS health: compare row counts
        const agentCount = this.db.prepare('SELECT COUNT(*) as cnt FROM agents WHERE deleted = 0').get();
        const ftsCount = this.db.prepare("SELECT COUNT(*) as cnt FROM agents_fts").get();
        const ftsHealthy = Math.abs(agentCount.cnt - ftsCount.cnt) <= 1; // allow 1 row tolerance for race
        const dbPath = this.db.name ?? '';
        let dbSizeBytes = 0;
        try {
            if (dbPath)
                dbSizeBytes = fs.statSync(dbPath).size;
        }
        catch { /* ignore */ }
        return {
            status: ftsHealthy ? 'healthy' : 'degraded',
            totalAgents: stats.totalAgents,
            onlineAgents: stats.onlineAgents,
            ftsHealthy,
            lastStaleCron: null, // TODO: track this
            dbSizeBytes,
        };
    }
    // ── Stale Cleanup ────────────────────────────────────────────────
    runStaleCron() {
        const staled = this.db.prepare(`
      UPDATE agents SET stale = 1
      WHERE last_seen < datetime('now', '-90 days')
      AND stale = 0 AND deleted = 0
    `).run().changes;
        const softDeleted = this.db.prepare(`
      UPDATE agents SET deleted = 1
      WHERE last_seen < datetime('now', '-180 days')
      AND deleted = 0
    `).run().changes;
        const hardDeleted = this.db.prepare(`
      DELETE FROM agents
      WHERE last_seen < datetime('now', '-365 days')
      AND deleted = 1
    `).run().changes;
        return { staled, softDeleted, hardDeleted };
    }
    // ── Internal ─────────────────────────────────────────────────────
    rowToEntry(row) {
        return {
            publicKey: row.public_key,
            agentId: row.agent_id,
            name: row.name,
            bio: row.bio,
            interests: JSON.parse(row.interests || '[]'),
            capabilities: JSON.parse(row.capabilities || '[]'),
            framework: row.framework,
            frameworkVisible: !!row.framework_visible,
            homepage: row.homepage,
            visibility: row.visibility,
            relayId: row.relay_id,
            registeredAt: row.registered_at,
            lastSeen: row.last_seen,
            lastUpdated: row.last_updated,
            online: !!row.online,
            stale: !!row.stale,
            consentMethod: row.consent_method,
            verified: !!row.verified,
            verifiedDomain: row.verified_domain || null,
            version: row.version,
        };
    }
    /**
     * Resolve public key from agentId by looking up in the registry.
     */
    resolvePublicKey(agentId) {
        const row = this.db.prepare('SELECT public_key FROM agents WHERE agent_id = ? AND deleted = 0 ORDER BY last_seen DESC LIMIT 1').get(agentId);
        return row?.public_key ?? null;
    }
    /**
     * Clean shutdown.
     */
    destroy() {
        if (this.staleCronTimer) {
            clearInterval(this.staleCronTimer);
            this.staleCronTimer = null;
        }
        this.db.close();
    }
}
//# sourceMappingURL=RegistryStore.js.map